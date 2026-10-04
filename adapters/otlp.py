"""OTLP/HTTP trace export -> bench events (SPEC.md section 6b).

Input is the body of a POST to /v1/traces, in either OTLP encoding:
- JSON: {"resourceSpans": [{"resource": {"attributes": [...]}, "scopeSpans": [{"spans": [...]}]}]}
- protobuf (what the Python and most other SDK exporters send): `decode_protobuf()` turns it into
  the same dict, with ids as hex like OTLP/JSON (protobuf's JSON mapping would give base64).

GenAI attribute names follow open-telemetry/semantic-conventions-genai at e07f4eba (10-02-26),
all Development status, including the retrieval span (`gen_ai.operation.name = retrieval`).
Both cache-write spellings are read: `cache_write` (current) and `cache_creation` (before
upstream PR 440). OpenInference attributes (Arize Phoenix, LlamaIndex, many LangChain apps) are
aliased onto those names first; when a span carries both, the GenAI names win.

A run spans several POSTs: exporters send a span when it ends, so a run's root (which ends last)
usually arrives after its steps. `TraceState` keeps what that needs across requests: which traces
contain AI work (traces with none, e.g. health checks, are dropped), the trace's session and app,
whether any of its spans carried content, and each run's next `seq`.

Spans written by the `agentlab` library (SPEC.md section 8) are read by run, not by trace: a run is
the span with `agentlab.kind = run`, never the trace's root, and every span carrying `agentlab.run`
belongs to that run whatever its parent. Its map arrives on the `agentlab.manifest` span (first, as
it ends at run start); the bench re-hashes it and uses it only when the hash matches (R13).
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

V = "bench/0"
LLM_OPS = {"chat", "text_completion", "generate_content"}
RUN_OPS = {"invoke_agent", "invoke_workflow"}
# A span is AI work when one of its own attributes (not its resource's) is in these namespaces.
AI_PREFIXES = ("gen_ai.", "llm.", "openinference.", "traceloop.", "agentlab.")
# Attributes that carry prompt, output, tool or document text: their presence means content_mode "full".
CONTENT_KEYS = ("gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions",
                "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "gen_ai.retrieval.documents",
                "gen_ai.retrieval.query.text", "input.value", "output.value", "pydantic_ai.all_messages")
CONTENT_MODES = {"full", "redacted", "absent"}
MAX_TRACES = 2000          # traces remembered across requests (oldest forgotten first)
MAX_PENDING_SPANS = 500    # spans held per trace while waiting to learn whether it is AI work
MAX_RUNS = 2000            # Agent Lab runs remembered across requests (oldest forgotten first)
MAX_MAPS = 200             # verified manifests held in memory (the server also stores them on disk)
# Where a span's node id comes from when the span says so (SPEC.md 8.6, "Node identity without the
# library"), first present wins: Agent Lab's own stamp, then LangGraph's node as LangSmith and
# Langfuse record it, then as OpenInference (inside its `metadata` JSON) and OpenLLMetry record it.
NODE_ALIASES = ("agentlab.node", "langsmith.metadata.langgraph_node",
                "langfuse.observation.metadata.langgraph_node")
OPENLLMETRY_PROPS = "traceloop.association.properties."


def _value(v: dict[str, Any]) -> Any:
    if "stringValue" in v:
        return v["stringValue"]
    if "intValue" in v:
        return int(v["intValue"])  # 64-bit ints arrive as strings
    if "doubleValue" in v:
        return float(v["doubleValue"])
    if "boolValue" in v:
        return bool(v["boolValue"])
    if "arrayValue" in v:
        return [_value(x) for x in v["arrayValue"].get("values", [])]
    if "kvlistValue" in v:
        return {kv["key"]: _value(kv.get("value", {})) for kv in v["kvlistValue"].get("values", [])}
    return None


def _attrs(lst: list[dict] | None) -> dict[str, Any]:
    return {a["key"]: _value(a.get("value", {})) for a in (lst or [])}


def _secs(nano: Any) -> float:
    return int(nano) / 1e9


def _json(v: Any) -> Any:
    """Conventions carry structured values as JSON strings; parse when possible, else keep the string."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            pass
    return v


def _parts(msg: dict):
    """A semconv message's text: its `parts` of type text joined, else the parts as given."""
    parts = msg.get("parts")
    if isinstance(parts, list) and parts and all(isinstance(p, dict) and p.get("type") == "text" for p in parts):
        return "".join(p.get("content", "") for p in parts)
    return parts if parts is not None else msg.get("content")


def _first(attrs: dict, *keys: str) -> Any:
    for k in keys:
        if attrs.get(k) not in (None, ""):
            return attrs[k]
    return None


# ---- protobuf --------------------------------------------------------------------------------

_ID_KEYS = ("traceId", "spanId", "parentSpanId")


def decode_protobuf(raw: bytes) -> dict:
    """An ExportTraceServiceRequest in protobuf -> the OTLP/JSON-shaped dict `convert` reads."""
    from google.protobuf.json_format import MessageToDict
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

    req = ExportTraceServiceRequest()
    req.ParseFromString(raw)
    body = MessageToDict(req)
    for rs in body.get("resourceSpans", []):
        for ss in rs.get("scopeSpans", []):
            for span in ss.get("spans", []):
                for k in _ID_KEYS:
                    if span.get(k):
                        span[k] = base64.b64decode(span[k]).hex()
    return body


def encode_response(rejected: int = 0, message: str = "") -> bytes:
    """An ExportTraceServiceResponse in protobuf, with partial_success when spans were dropped."""
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceResponse

    res = ExportTraceServiceResponse()
    if rejected:
        res.partial_success.rejected_spans = rejected
        res.partial_success.error_message = message
    return res.SerializeToString()


# ---- OpenInference aliases ----------------------------------------------------------------------

# openinference.span.kind -> gen_ai.operation.name. CHAIN and the rest stay plain steps.
OI_KINDS = {"LLM": "chat", "TOOL": "execute_tool", "AGENT": "invoke_agent", "RETRIEVER": "retrieval",
            "GUARDRAIL": "check", "EVALUATOR": "check"}
OI_SCALARS = {"llm.model_name": "gen_ai.request.model", "llm.provider": "gen_ai.provider.name",
              "llm.system": "gen_ai.provider.name", "llm.finish_reason": "gen_ai.response.finish_reasons",
              "llm.token_count.prompt": "gen_ai.usage.input_tokens",
              "llm.token_count.completion": "gen_ai.usage.output_tokens",
              "llm.token_count.prompt_details.cache_read": "gen_ai.usage.cache_read.input_tokens",
              "llm.token_count.prompt_details.cache_write": "gen_ai.usage.cache_write.input_tokens",
              "tool.name": "gen_ai.tool.name", "agent.name": "gen_ai.agent.name"}
_OI_INDEXED = re.compile(r"^(llm\.input_messages|llm\.output_messages|retrieval\.documents)\.(\d+)\.(.+)$")


def _oi_messages(rows: dict[int, dict]) -> tuple[list[dict], str | None]:
    """Flattened `llm.*_messages.N.message.*` keys -> semconv messages, with system text split out."""
    msgs, system = [], []
    for _, row in sorted(rows.items()):
        role = row.get("message.role") or "?"
        text = row.get("message.content")
        if text is None:  # multi-part: message.contents.M.message_content.text
            texts = [v for k, v in sorted(row.items()) if k.startswith("message.contents.") and k.endswith(".text")]
            text = "".join(str(t) for t in texts) if texts else None
        if role == "system" and isinstance(text, str):
            system.append(text)
            continue
        m: dict[str, Any] = {"role": role, "parts": [{"type": "text", "content": text if text is not None else ""}]}
        calls = sorted({k.split(".")[2] for k in row if k.startswith("message.tool_calls.")})
        for i in calls:
            pre = f"message.tool_calls.{i}.tool_call."
            m["parts"].append({"type": "tool_call", "id": row.get(pre + "id"), "name": row.get(pre + "function.name"),
                               "arguments": _json(row.get(pre + "function.arguments"))})
        msgs.append(m)
    return msgs, ("\n".join(system) if system else None)


def normalize(attrs: dict[str, Any]) -> dict[str, Any]:
    """Adds GenAI semconv names for OpenInference attributes. Existing GenAI names are kept."""
    if not any(k.startswith(("openinference.", "llm.", "retrieval.documents.")) for k in attrs):
        return attrs
    a = dict(attrs)
    kind = str(a.get("openinference.span.kind") or "").upper()
    if kind in OI_KINDS:
        a.setdefault("gen_ai.operation.name", OI_KINDS[kind])
    for src, dst in OI_SCALARS.items():
        if a.get(src) is not None:
            a.setdefault(dst, a[src])
    groups: dict[str, dict[int, dict]] = {}
    for k, v in attrs.items():
        m = _OI_INDEXED.match(k)
        if m:
            groups.setdefault(m.group(1), {}).setdefault(int(m.group(2)), {})[m.group(3)] = v
    if "llm.input_messages" in groups:
        msgs, system = _oi_messages(groups["llm.input_messages"])
        a.setdefault("gen_ai.input.messages", json.dumps(msgs))
        if system:
            a.setdefault("gen_ai.system_instructions", json.dumps([{"type": "text", "content": system}]))
    if "llm.output_messages" in groups:
        a.setdefault("gen_ai.output.messages", json.dumps(_oi_messages(groups["llm.output_messages"])[0]))
    if "retrieval.documents" in groups:
        docs = [{"id": r.get("document.id"), "score": r.get("document.score"), "content": r.get("document.content")}
                for _, r in sorted(groups["retrieval.documents"].items())]
        a.setdefault("gen_ai.retrieval.documents", [{k: v for k, v in d.items() if v is not None} for d in docs])
    if kind == "TOOL":
        if a.get("input.value") is not None:
            a.setdefault("gen_ai.tool.call.arguments", a["input.value"])
        if a.get("output.value") is not None:
            a.setdefault("gen_ai.tool.call.result", a["output.value"])
    if kind == "RETRIEVER" and a.get("input.value") is not None:
        a.setdefault("gen_ai.retrieval.query.text", a["input.value"])
    return a


# ---- per-span conversion ------------------------------------------------------------------------

def is_ai(span: dict) -> bool:
    return any(a.get("key", "").startswith(AI_PREFIXES) for a in span.get("attributes") or [])


def _content_mode(a: dict) -> str:
    override = _first(a, "agentlab.content_mode", "bench.content_mode")
    if override in CONTENT_MODES:
        return override
    return "full" if any(a.get(k) not in (None, "", "[]") for k in CONTENT_KEYS) else "absent"


def node_from_ns(ns: Any) -> str | None:
    """LangGraph's checkpoint namespace -> the node id: segments split on `|`, each one's
    `:<task id>` dropped, joined with `/` (`sub:1f…|inner:9c…` -> `sub/inner`)."""
    if not isinstance(ns, str) or not ns:
        return None
    parts = [seg.split(":", 1)[0] for seg in ns.split("|") if seg]
    return "/".join(p for p in parts if p) or None


def langgraph_node(a: dict) -> str | None:
    """The node a span says it ran in, when it says so (SPEC.md 8.6). Where an instrumentor also
    records the checkpoint namespace, the node comes from it, so a subgraph's is `container/inner`."""
    named = _first(a, *NODE_ALIASES)
    if named is not None:
        return str(named)
    meta = _json(a.get("metadata"))   # OpenInference: the LangChain run metadata as one JSON string
    if isinstance(meta, dict):
        found = node_from_ns(meta.get("langgraph_checkpoint_ns")) or meta.get("langgraph_node")
        if found:
            return str(found)
    found = (node_from_ns(a.get(OPENLLMETRY_PROPS + "langgraph_checkpoint_ns"))
             or a.get(OPENLLMETRY_PROPS + "langgraph_node"))
    return str(found) if found else None


def node_id(span: dict, a: dict, node_from: dict | None = None) -> str:
    """The bench node for a span: operation plus the tool, agent or data source it acted on, never
    the model, so one step keeps one node when the model changes. A map's `node_from` overrides:
    `{"attribute": "<key>"}` reads that attribute; `{"span_name": true}` uses the span name."""
    if node_from:
        if "attribute" in node_from and a.get(node_from["attribute"]) is not None:
            return str(a[node_from["attribute"]])
        if node_from.get("span_name"):
            return span.get("name") or "span"
    named_node = langgraph_node(a)
    if named_node is not None:
        return named_node
    op = a.get("gen_ai.operation.name")
    named = {"execute_tool": "gen_ai.tool.name", "invoke_agent": "gen_ai.agent.name",
             "create_agent": "gen_ai.agent.name", "retrieval": "gen_ai.data_source.id"}
    if op in named:  # without the name (e.g. an OpenInference retriever has no source id), the span's own name
        return f"{op} {a[named[op]]}" if a.get(named[op]) else (span.get("name") or str(op))
    if op in LLM_OPS or op == "embeddings":
        return f"{op} {a['gen_ai.agent.name']}" if a.get("gen_ai.agent.name") else str(op)
    return span.get("name") or "span"


def _first_user_text(a: dict) -> str | None:
    for key in ("gen_ai.input.messages", "pydantic_ai.all_messages"):
        msgs = _json(a.get(key))
        if isinstance(msgs, list):
            for m in msgs:
                if isinstance(m, dict) and m.get("role") == "user":
                    t = _parts(m)
                    if isinstance(t, str) and t:
                        return t
    return a["input.value"] if isinstance(a.get("input.value"), str) else None


def _last_answer(a: dict) -> str | None:
    if isinstance(a.get("final_result"), str):
        return a["final_result"]
    msgs = _json(a.get("gen_ai.output.messages"))
    if isinstance(msgs, list):
        for m in reversed(msgs):
            if isinstance(m, dict) and isinstance(_parts(m), str):
                return _parts(m)
    return a["output.value"] if isinstance(a.get("output.value"), str) else None


def _hits(docs: Any, source: str | None) -> list[dict]:
    docs = _json(docs)
    out = []
    for i, d in enumerate(docs if isinstance(docs, list) else []):
        if not isinstance(d, dict):
            continue
        h: dict[str, Any] = {"id": str(d.get("id") if d.get("id") is not None else f"{source or 'doc'}#{i}")}
        if d.get("title") is not None:
            h["title"] = str(d["title"])
        if isinstance(d.get("score"), (int, float)) and not isinstance(d.get("score"), bool):
            h["score"] = float(d["score"])
        text = _first(d, "content", "text")
        if text is not None:
            h["text"] = text if isinstance(text, str) else json.dumps(text)
        out.append(h)
    return out


PASS_LABELS = {"pass", "passed", "correct", "relevant", "true", "yes", "ok", "grounded"}
FAIL_LABELS = {"fail", "failed", "incorrect", "not_relevant", "irrelevant", "false", "no", "ungrounded"}


def _content_events(span: dict, a: dict, node: str, t0: float, t1: float, failed: bool,
                    ev: Callable, price: Callable | None) -> list[dict]:
    """What a span carries beyond its own step: the model call, tool call, retrieval or check it
    is, GenAI evaluation results, and an error when it failed. `ev(node, type, ts, data)` builds
    one event with the caller's run, step and content mode."""
    op = a.get("gen_ai.operation.name")
    out: list[dict] = []
    if op in LLM_OPS:
        inp = _first(a, "gen_ai.usage.input_tokens") or 0
        cr = _first(a, "gen_ai.usage.cache_read.input_tokens") or 0
        cw = _first(a, "gen_ai.usage.cache_write.input_tokens", "gen_ai.usage.cache_creation.input_tokens") or 0
        outp = _first(a, "gen_ai.usage.output_tokens") or 0
        model = _first(a, "gen_ai.response.model", "gen_ai.request.model") or "unknown"
        llm: dict[str, Any] = {"model": str(model), "input_tokens": int(inp), "output_tokens": int(outp),
                               "cache_read_tokens": int(cr), "cache_write_tokens": int(cw),
                               "latency_ms": round((t1 - t0) * 1000, 1)}
        if a.get("gen_ai.provider.name"):
            llm["provider"] = a["gen_ai.provider.name"]
        fr = a.get("gen_ai.response.finish_reasons")
        if fr:
            llm["finish_reason"] = fr[0] if isinstance(fr, list) else fr
        ttfc = a.get("gen_ai.response.time_to_first_chunk")
        if ttfc is not None:
            llm["time_to_first_chunk_ms"] = round(float(ttfc) * 1000, 1)  # semconv unit: seconds
        if a.get("gen_ai.request.stream") is not None:
            llm["stream"] = bool(a["gen_ai.request.stream"])
        # Prompt and response (SPEC: llm_call system / messages / output).
        for src, dst in (("gen_ai.system_instructions", "system"), ("gen_ai.input.messages", "messages"),
                         ("gen_ai.output.messages", "output")):
            v = a.get(src)
            if v is None:
                continue
            v = _json(v)
            if dst == "system" and isinstance(v, list):
                v = "\n".join(str(p.get("content", "")) for p in v if isinstance(p, dict)) or json.dumps(v)
            if dst == "messages":
                if not isinstance(v, list):
                    v = [{"role": "user", "content": v}]
                v = [{"role": m.get("role", "?"), "content": _parts(m)} if isinstance(m, dict) else {"role": "?", "content": m} for m in v]
            if dst == "output" and isinstance(v, list):
                # Text parts as text; anything else (a tool call) as JSON, never a Python repr.
                v = "\n".join(p if isinstance(p := _parts(m), str) else json.dumps(p, ensure_ascii=False)
                              for m in v if isinstance(m, dict)) if all(isinstance(m, dict) for m in v) else v
            llm[dst] = v
        if a.get("agentlab.request.json_schema") is not None:
            llm["params"] = {"json_schema": _json(a["agentlab.request.json_schema"])}
        if a.get("gen_ai.usage.cost") is not None:
            llm.update(cost_usd=float(a["gen_ai.usage.cost"]), cost_source="actual",
                       cost_basis="span attribute gen_ai.usage.cost")
        elif isinstance(a.get("agentlab.cost.usd"), (int, float)) and not isinstance(a["agentlab.cost.usd"], bool):
            # The app's own estimate (its price function), never read as provider-reported.
            llm.update(cost_usd=float(a["agentlab.cost.usd"]), cost_source="estimated",
                       cost_basis=str(a.get("agentlab.cost.basis") or "the app's price function"))
        elif price is not None:
            est = price(model, int(inp) - int(cr) - int(cw), int(outp), int(cr), int(cw))
            if est is not None:
                llm.update(cost_usd=round(est, 6), cost_source="estimated", cost_basis="bench price table")
        out.append(ev(node, "llm_call", t1, llm))
    elif op == "execute_tool":
        tc = {"tool": str(a.get("gen_ai.tool.name") or node)}
        for src, dst in (("gen_ai.tool.call.arguments", "arguments"), ("gen_ai.tool.call.result", "result"),
                         ("gen_ai.tool.call.id", "call_id")):
            if a.get(src) is not None:
                tc[dst] = _json(a[src]) if dst != "call_id" else a[src]
        out.append(ev(node, "tool_call", t1, tc))
    elif op == "retrieval":
        source = _first(a, "gen_ai.data_source.id")
        rd: dict[str, Any] = {"hits": _hits(a.get("gen_ai.retrieval.documents"), source)}
        if source:
            rd["source"] = str(source)
        if a.get("gen_ai.retrieval.query.text") is not None:
            rd["query"] = a["gen_ai.retrieval.query.text"]
        out.append(ev(node, "retrieval", t1, rd))
    elif op == "check":  # OpenInference GUARDRAIL / EVALUATOR spans: no standard verdict, so the status decides
        ck = {"name": span.get("name") or "check", "passed": not failed,
              "kind": "guardrail" if str(a.get("openinference.span.kind")).upper() == "GUARDRAIL" else "evaluation"}
        if isinstance(a.get("output.value"), str):
            ck["detail"] = a["output.value"]
        out.append(ev(node, "check_result", t1, ck))

    # GenAI evaluation results arrive as span events (gen_ai.evaluation.result).
    for se in span.get("events") or []:
        if se.get("name") != "gen_ai.evaluation.result":
            continue
        ea = _attrs(se.get("attributes"))
        label = str(ea.get("gen_ai.evaluation.score.label") or "").lower()
        if label not in PASS_LABELS | FAIL_LABELS:
            continue  # a score with no pass/fail label can't be shown as a verdict
        ck = {"name": str(ea.get("gen_ai.evaluation.name") or "evaluation"), "passed": label in PASS_LABELS,
              "kind": "evaluation"}
        if ea.get("gen_ai.evaluation.explanation"):
            ck["detail"] = str(ea["gen_ai.evaluation.explanation"])
        if isinstance(ea.get("gen_ai.evaluation.score.value"), (int, float)):
            ck["score"] = float(ea["gen_ai.evaluation.score.value"])
        out.append(ev(node, "check_result", _secs(se.get("timeUnixNano") or span["startTimeUnixNano"]), ck))

    if failed:
        msg = (span.get("status") or {}).get("message") or a.get("error.type") or "span failed"
        out.append(ev(node, "error", t1, {"message": str(msg), **({"type": a["error.type"]} if a.get("error.type") else {})}))

    return out


def _span_events(span: dict, a: dict, ctx: dict, node_from: dict | None, price: Callable | None) -> list[dict]:
    """One span -> its bench events. `ctx` is the trace's resolved run_id, session, app and modes."""
    node = node_id(span, a, node_from)
    step_id, parent = span.get("spanId"), span.get("parentSpanId") or None
    t0, t1 = _secs(span["startTimeUnixNano"]), _secs(span.get("endTimeUnixNano") or span["startTimeUnixNano"])
    op = a.get("gen_ai.operation.name")
    failed = (span.get("status") or {}).get("code") in (2, "STATUS_CODE_ERROR")
    mode = _content_mode(a)

    def ev(n, et, ts, data, sid_=step_id, par=parent, cm=mode):
        e = {"v": V, "run_id": ctx["run_id"], "ts": ts, "node": n, "event_type": et, "content_mode": cm, "data": data}
        if ctx.get("session"):
            e["session_id"] = str(ctx["session"])
        if sid_:
            e["step_id"] = sid_
        if par:
            e["parent_step_id"] = par
        return e

    out: list[dict] = []
    is_root = not parent
    # A root agent/workflow span IS the run. Any other root (one model call, an HTTP handler) opens
    # the run and is also its own first step, so the run still has something to light.
    is_step = not (is_root and op in RUN_OPS)
    if is_root:
        rs = {"label": span.get("name", ""), "via": "otlp"}
        if ctx.get("app"):
            rs["app"] = ctx["app"]
        if _first_user_text(a):
            rs["input"] = _first_user_text(a)
        out.append(ev("_run", "run_started", t0, rs, None, None, ctx["run_mode"]))
    if is_step:
        out.append(ev(node, "step_started", t0, {}))

    out += _content_events(span, a, node, t0, t1, failed, ev, price)

    latency = round((t1 - t0) * 1000, 1)
    if is_step:
        out.append(ev(node, "step_finished", t1, {"status": "error" if failed else "ok", "latency_ms": latency}))
    if is_root:
        rf: dict[str, Any] = {"status": "error" if failed else "ok", "latency_ms": latency}
        if _last_answer(a):
            rf["outcome"] = _last_answer(a)
        out.append(ev("_run", "run_finished", t1, rf, None, None, ctx["run_mode"]))
    return out


# Same-ts ordering: a run opens before its steps, a step opens before its content, and closes after.
_ORDER = {"run_started": -2, "run_updated": -2, "step_started": -1, "step_finished": 2, "run_finished": 3}


# ---- ids ---------------------------------------------------------------------------------------

_HEX = re.compile(r"^[0-9a-f]+$")


def _norm_id(v: Any, nbytes: int) -> Any:
    """Span and trace ids as lowercase hex, however they arrived. OTLP/JSON is specified with hex,
    but protobuf's JSON mapping (what `MessageToDict` and `agentlab.testing.to_otlp_json` write)
    gives base64; both must give the same step ids. Anything that is neither stays as it is."""
    if not isinstance(v, str) or not v:
        return v
    if len(v) == nbytes * 2 and _HEX.match(v.lower()):
        return v.lower()
    try:
        raw = base64.b64decode(v, validate=True)
    except (binascii.Error, ValueError):
        return v
    return raw.hex() if len(raw) == nbytes else v


# ---- Agent Lab: the manifest ------------------------------------------------------------------

def canonical(obj: Any) -> bytes:
    """The canonical JSON every Agent Lab hash is taken over (SPEC.md 8.5)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_hex(obj: Any) -> str:
    return hashlib.sha256(canonical(obj)).hexdigest()


_TOPO_VALIDATOR = None


def _topo_validator():
    global _TOPO_VALIDATOR
    if _TOPO_VALIDATOR is None:
        from jsonschema import Draft202012Validator
        schema = Path(__file__).resolve().parents[1] / "schema" / "bench-topology.schema.json"
        _TOPO_VALIDATOR = Draft202012Validator(json.loads(schema.read_text()))
    return _TOPO_VALIDATOR


def verify_manifest(raw: Any, claimed: Any) -> tuple[dict | None, str | None, str | None]:
    """A manifest span's map -> (map, hash, None) when it is whole, else (None, None, why).

    The hash is recomputed over the parsed JSON, so a value cut short by an attribute length limit
    (OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT) or altered on the way is refused, never half-used (R13). A
    map that parses and matches but isn't a valid bench map is refused too."""
    if not isinstance(raw, str) or not raw:
        return None, None, "the run's map is missing from its manifest span"
    try:
        manifest = json.loads(raw)
    except ValueError:
        return None, None, (f"the run's map didn't parse ({len(raw)} characters arrived): "
                            "cut short by OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT?")
    if not isinstance(manifest, dict):
        return None, None, "the run's map is not a JSON object"
    actual = sha256_hex(manifest)
    if not isinstance(claimed, str) or actual != claimed:
        return None, None, (f"the run's map doesn't match its hash (sent {str(claimed)[:12]}…, "
                            f"content hashes to {actual[:12]}…)")
    errs = sorted(_topo_validator().iter_errors(manifest), key=lambda e: list(e.absolute_path))
    if errs:
        where = "/".join(str(x) for x in errs[0].absolute_path)
        return None, None, f"the run's map is not a valid bench map ({where + ': ' if where else ''}{errs[0].message})"
    return manifest, actual, None


# ---- Agent Lab: span events -> bench events -----------------------------------------------------

# Bench event types an app's `agentlab.event` may not use: the run and step boundaries are the bench's.
_RESERVED_TYPES = {"run_started", "run_updated", "run_finished", "step_started", "step_finished"}


def _agentlab_fact(name: str, ea: dict) -> tuple[str, dict] | None:
    """One `agentlab.*` span event -> (bench event type, data), per SPEC.md 8.6."""
    if name == "agentlab.decision":
        d: dict[str, Any] = {}
        for src, dst in (("agentlab.decision.reason", "rationale"), ("agentlab.decision.branch", "branch"),
                         ("agentlab.decision.confidence", "confidence")):
            if ea.get(src) is not None:
                d[dst] = ea[src]
        if ea.get("agentlab.decision.cited") is not None:
            d["cited"] = [str(x) for x in (ea["agentlab.decision.cited"] or [])]
        if "branch" in d:
            d["branch"] = str(d["branch"])
        return "decision", d
    if name == "agentlab.check":
        if not isinstance(ea.get("agentlab.check.passed"), bool):
            return None  # a check with no verdict can't be shown as one
        passed = ea["agentlab.check.passed"]
        d = {"name": str(ea.get("agentlab.check.name") or "check"), "passed": passed,
             "state": "passed" if passed else "failed"}
        for src, dst in (("agentlab.check.detail", "detail"), ("agentlab.check.kind", "kind")):
            if ea.get(src) is not None:
                d[dst] = ea[src]
        if ea.get("agentlab.check.evidence") is not None:
            d["evidence"] = [str(x) for x in (ea["agentlab.check.evidence"] or [])]
        words = _json(ea.get("agentlab.check.words"))
        if isinstance(words, dict):
            d["words"] = {k: str(v) for k, v in words.items() if k in ("passed", "failed") and v}
        return "check_result", d
    if name == "agentlab.gate.waiting":
        d = {}
        if ea.get("agentlab.gate.proposed") is not None:
            d["proposed"] = _json(ea["agentlab.gate.proposed"])
        if ea.get("agentlab.gate.reason") is not None:
            d["reason"] = ea["agentlab.gate.reason"]
        return "gate_waiting", d
    if name == "agentlab.gate.resolved":
        if not isinstance(ea.get("agentlab.gate.approved"), bool):
            return None
        d = {"approved": ea["agentlab.gate.approved"]}
        for src, dst in (("agentlab.gate.by", "by"), ("agentlab.gate.reason", "reason")):
            if ea.get(src) is not None:
                d[dst] = ea[src]
        return "gate_resolved", d
    if name == "agentlab.event":
        et = ea.get("agentlab.event.type")
        if not isinstance(et, str) or not et or et in _RESERVED_TYPES:
            return None
        data = _json(ea.get("agentlab.event.data"))
        return et, data if isinstance(data, dict) else ({} if data is None else {"value": data})
    return None


def _kind(a: dict) -> str | None:
    k = a.get("agentlab.kind")
    return k if isinstance(k, str) else None


class TraceState:
    """What OTLP ingest remembers between requests. One per bench (the server's Store owns it).

    Two kinds of run. A trace from any OpenTelemetry instrumentation is one run, its root span the
    run (`traces`). A run written by the `agentlab` library is keyed by `agentlab.run` (`runs`): it
    may span several traces (a pause and its resume) and its run span may have a parent the bench
    never sees."""

    def __init__(self) -> None:
        self.traces: OrderedDict[str, dict] = OrderedDict()
        self.runs: OrderedDict[str, dict] = OrderedDict()
        self.maps: OrderedDict[str, dict] = OrderedDict()   # map hash -> verified manifest
        self._aliases: dict[str, str] = {}                  # a resume's fresh run id -> the run it continues
        self._run_apps: dict[str, str] = {}  # run_id -> app, since the last take_run_apps()
        self._new_maps: list[tuple[str, dict]] = []

    def take_run_apps(self) -> dict[str, str]:
        """Which app each run converted since the last call belongs to (the server keeps it)."""
        out, self._run_apps = self._run_apps, {}
        return out

    def take_maps(self) -> list[tuple[str, dict]]:
        """(hash, manifest) for every map verified since the last call, in arrival order."""
        out, self._new_maps = self._new_maps, []
        return out

    def run_info(self, run_id: str) -> dict | None:
        """An Agent Lab run's state as the bench knows it: app, thread, status, map hash or error."""
        r = self.runs.get(self._aliases.get(run_id, run_id))
        if r is None:
            return None
        return {k: r[k] for k in ("id", "app", "thread", "session", "status", "map_hash", "map_error")}

    def _trace(self, tid: str) -> dict:
        t = self.traces.get(tid)
        if t is None:
            t = self.traces[tid] = {"ai": False, "pending": [], "session": None, "app": None, "content": False,
                                    "mode": None, "run_id": None, "seq": 0, "agentlab_run": None}
            while len(self.traces) > MAX_TRACES:
                self.traces.popitem(last=False)
        self.traces.move_to_end(tid)
        return t

    def ingest(self, body: dict, app: str | None = None, session_id: str | None = None,
               node_from: Callable[[str | None], dict | None] | dict | None = None,
               price: Callable | None = None) -> list[dict]:
        """One OTLP request body -> bench events, sorted by (run_id, ts). `app` and `session_id`
        are the request's overrides (query string, header); otherwise each trace takes them from its
        resource and spans. `node_from` is a map's setting, or a function app id -> setting.
        `price(model, in, out, cr, cw) -> usd | None` estimates cost when a span carries none."""
        by_trace: dict[str, list[tuple[dict, dict]]] = {}
        agentlab: list[tuple[dict, dict]] = []   # spans written for an Agent Lab run, with merged attrs
        for rs in body.get("resourceSpans", []):
            res = _attrs((rs.get("resource") or {}).get("attributes"))
            for ss in rs.get("scopeSpans", []):
                for span in ss.get("spans", []):
                    span = dict(span)
                    span["traceId"] = _norm_id(span.get("traceId"), 16)
                    for k in ("spanId", "parentSpanId"):
                        span[k] = _norm_id(span.get(k), 8)
                    own = _attrs(span.get("attributes"))
                    if own.get("agentlab.run"):
                        agentlab.append((span, normalize({**res, **own})))
                    else:
                        by_trace.setdefault(span.get("traceId") or "", []).append((span, res))

        events: list[dict] = []
        # Traces that hold an Agent Lab run: their other spans belong to that run, not to a trace run.
        holders: dict[str, str] = {}
        if agentlab:
            events += self._ingest_agentlab(agentlab, app, session_id, node_from, price, by_trace, holders)
        for tid, spans in by_trace.items():
            if tid in holders:
                continue  # taken by the Agent Lab path above
            held = self.traces[tid].get("agentlab_run") if tid in self.traces else None
            if held:
                # A trace already known to hold an Agent Lab run: its AI spans join that run.
                ai = [(s, normalize({**res, **_attrs(s.get("attributes"))})) for s, res in spans if is_ai(s)]
                if ai and held in self.runs:
                    r = self.runs[held]
                    nf = node_from(r["app"]) if callable(node_from) else node_from
                    events += self._run_events(r, ai, nf, price)
                continue
            events += self._ingest_trace(tid, spans, app, session_id, node_from, price)
        events.sort(key=lambda e: (e["run_id"], e["ts"], _ORDER.get(e["event_type"], 1)))
        return events

    # ---- traces from any instrumentation (SPEC.md 6b) -----------------------------------------

    def _ingest_trace(self, tid, spans, app, session_id, node_from, price) -> list[dict]:
        t = self._trace(tid)
        if not t["ai"] and any(is_ai(s) for s, _ in spans):
            t["ai"] = True
        if not t["ai"]:
            if any(not s.get("parentSpanId") for s, _ in spans):
                del self.traces[tid]  # the root came and nothing in the trace was AI work: drop it
            else:
                t["pending"] = (t["pending"] + spans)[-MAX_PENDING_SPANS:]
            return []
        spans, t["pending"] = t["pending"] + spans, []
        merged = [(s, normalize({**res, **_attrs(s.get("attributes"))})) for s, res in spans]
        for s, a in merged:
            t["run_id"] = t["run_id"] or _first(a, "bench.run_id")
            t["app"] = t["app"] or app or _first(a, "service.name")
            t["session"] = t["session"] or session_id or _first(
                a, "bench.session_id", "session.id", "gen_ai.conversation.id")
            t["content"] = t["content"] or _content_mode(a) == "full"
            if a.get("bench.content_mode") in CONTENT_MODES:
                t["mode"] = a["bench.content_mode"]
        ctx = {"run_id": str(t["run_id"] or tid), "session": t["session"], "app": t["app"],
               "run_mode": t["mode"] or ("full" if t["content"] else "absent")}
        if t["app"]:
            self._run_apps[ctx["run_id"]] = str(t["app"])
        nf = node_from(t["app"]) if callable(node_from) else node_from
        trace_events: list[dict] = []
        for s, a in merged:
            trace_events += _span_events(s, a, ctx, nf, price)
        trace_events.sort(key=lambda e: (e["ts"], _ORDER.get(e["event_type"], 1)))
        for e in trace_events:
            e["seq"] = t["seq"]
            t["seq"] += 1
        return trace_events

    # ---- Agent Lab runs (SPEC.md 8.6) ------------------------------------------------------------

    def _new_run(self, run_id: str) -> dict:
        r = {"id": run_id, "app": None, "thread": None, "session": None, "mode": None, "seq": 0,
             "started": False, "status": None, "map_hash": None, "map_error": None, "manifest": None,
             "input_sent": False, "t0": None, "node_spans": {}, "parents": {}, "step_alias": {},
             "paused_step": None, "step_work": {}, "content": False}
        self.runs[run_id] = r
        while len(self.runs) > MAX_RUNS:
            gone, _ = self.runs.popitem(last=False)
            self._aliases = {k: v for k, v in self._aliases.items() if v != gone}
        return r

    def _resolve(self, raw: str, facts: dict) -> str:
        """The run a span's `agentlab.run` belongs to. A resume in a process that never saw the
        pause has a fresh id: it joins the latest paused run of the same app and thread."""
        if raw in self._aliases:
            return self._aliases[raw]
        if raw in self.runs:
            return raw
        if facts.get("resume") and facts.get("thread"):
            for rid in reversed(self.runs):
                r = self.runs[rid]
                if r["status"] == "paused" and r["app"] == facts.get("app") and r["thread"] == facts["thread"]:
                    self._aliases[raw] = rid
                    return rid
        return raw

    def _ingest_agentlab(self, spans, app, session_id, node_from, price, by_trace, holders) -> list[dict]:
        # Facts about each run first, from every span of the batch (the run span, which carries most
        # of them, ends last; the manifest span ends first), so the order spans arrive in can't change
        # which run a span joins or what it is labelled.
        groups: dict[str, list[tuple[dict, dict]]] = {}
        facts: dict[str, dict] = {}
        for s, a in spans:
            raw = str(a["agentlab.run"])
            groups.setdefault(raw, []).append((s, a))
            f = facts.setdefault(raw, {})
            for key, attr in (("app", "agentlab.app"), ("thread", "agentlab.thread"), ("session", "session.id"),
                              ("mode", "agentlab.content_mode")):
                if f.get(key) is None and a.get(attr) not in (None, ""):
                    f[key] = str(a[attr])
            if a.get("agentlab.run.resume") is True:
                f["resume"] = True
        out: list[dict] = []
        order = sorted(groups, key=lambda raw: min(int(s["startTimeUnixNano"]) for s, _ in groups[raw]))
        for raw in order:
            rid = self._resolve(raw, facts[raw])
            r = self.runs.get(rid) or self._new_run(rid)
            self.runs.move_to_end(rid)
            f = facts[raw]
            r["app"] = r["app"] or app or f.get("app")
            r["thread"] = r["thread"] or f.get("thread")
            r["session"] = r["session"] or session_id or f.get("session")
            if f.get("mode") in CONTENT_MODES:
                r["mode"] = f["mode"]
            if r["app"]:
                self._run_apps[rid] = str(r["app"])
            group = groups[raw]
            for s, _ in group:
                holders[s.get("traceId") or ""] = rid
                self._trace(s.get("traceId") or "")["agentlab_run"] = rid
            # Another instrumentor's unstamped AI spans in the same trace (shared provider, outside
            # any node) join the run under their own node; unstamped non-AI spans (the app's HTTP
            # handler around the run) are not part of it and are dropped.
            # A trace's spans join one run only (the first of its runs here), never one per run.
            for tid in list(by_trace):
                if holders.get(tid) == rid:
                    for s, res in by_trace.pop(tid):
                        if is_ai(s):
                            group.append((s, normalize({**res, **_attrs(s.get("attributes"))})))
            nf = node_from(r["app"]) if callable(node_from) else node_from
            out += self._run_events(r, group, nf, price)
        return out

    def _run_events(self, r: dict, group: list[tuple[dict, dict]], node_from, price) -> list[dict]:
        group = sorted(group, key=lambda sa: (int(sa[0]["startTimeUnixNano"]), _kind(sa[1]) != "manifest"))
        evs: list[dict] = []
        t_first = min(_secs(s["startTimeUnixNano"]) for s, _ in group)
        r["t0"] = t_first if r["t0"] is None else min(r["t0"], t_first)

        def mode_of(a: dict) -> str:
            if r["mode"]:
                return r["mode"]
            m = _content_mode(a)
            r["content"] = r["content"] or m == "full"
            return m

        def mk(node, et, ts, data, step=None, cm=None):
            e = {"v": V, "run_id": r["id"], "ts": ts, "node": node, "event_type": et,
                 "content_mode": cm or r["mode"] or ("full" if r["content"] else "absent"), "data": data}
            if r["session"]:
                e["session_id"] = str(r["session"])
            if step:
                e["step_id"] = step
            return e

        # The map: verified, stored once per hash, named on run_started (or run_updated when it
        # arrives after the run was opened).
        map_news: dict[str, Any] = {}
        for s, a in group:
            if _kind(a) != "manifest" or r["map_hash"]:
                continue
            manifest, h, err = verify_manifest(a.get("agentlab.manifest"), a.get("agentlab.manifest.hash"))
            if manifest is not None:
                r["map_hash"], r["manifest"], r["map_error"] = h, manifest, None
                if h not in self.maps:
                    self._new_maps.append((h, manifest))
                self.maps[h] = manifest
                self.maps.move_to_end(h)
                while len(self.maps) > MAX_MAPS:
                    self.maps.popitem(last=False)
                map_news = {"map_hash": h}
            elif not r["map_error"]:
                r["map_error"] = "R13: " + str(err)
                map_news = {"map_error": r["map_error"]}

        for _, a in group:
            mode_of(a)
        run_span = next(((s, a) for s, a in group if _kind(a) == "run"), None)
        run_input = None
        if run_span is not None and run_span[1].get("agentlab.run.input") is not None and not r["input_sent"]:
            run_input = _json(run_span[1]["agentlab.run.input"])

        if not r["started"]:
            rs: dict[str, Any] = {"via": "agentlab"}
            if r["app"]:
                rs["app"] = r["app"]
            if r["thread"]:
                rs["thread"] = r["thread"]
            if r["map_hash"]:
                rs["map_hash"] = r["map_hash"]
            elif r["map_error"]:
                rs["map_error"] = r["map_error"]
            if run_input is not None:
                rs["input"] = run_input
                r["input_sent"] = True
            evs.append(mk("_run", "run_started", r["t0"], rs))
            r["started"] = True
        else:
            upd = dict(map_news)
            if run_input is not None:
                upd["input"] = run_input
                r["input_sent"] = True
            if upd:
                evs.append(mk("_run", "run_updated", t_first, upd))

        # Node spans first, in start order: they own the steps every other span's events go to. A
        # node that paused at a gate keeps its step open; the resume's re-run of that node continues
        # the same step, so a gate is one step holding both its waiting and its decision.
        for s, a in group:
            if s.get("parentSpanId"):
                r["parents"][s.get("spanId")] = s["parentSpanId"]
            if _kind(a) != "node":
                continue
            sid, node = s.get("spanId"), str(a.get("agentlab.node") or "")
            r["node_spans"][sid] = node
            ps = r["paused_step"]
            if ps and ps["node"] == node and ps["span"] != sid:
                r["step_alias"][sid] = ps["step"]
                r["paused_step"] = None
            failed = (s.get("status") or {}).get("code") in (2, "STATUS_CODE_ERROR")
            if not failed and any(se.get("name") == "agentlab.gate.waiting" for se in s.get("events") or []):
                step = r["step_alias"].get(sid, sid)
                r["paused_step"] = {"node": node, "step": step, "span": sid}
                r["step_work"][step] = r["step_work"].get(step, 0) + (
                    int(s.get("endTimeUnixNano") or s["startTimeUnixNano"]) - int(s["startTimeUnixNano"])) / 1e6

        def owner_step(s: dict, a: dict) -> str | None:
            pid, seen = s.get("parentSpanId"), set()
            while pid and pid not in seen:
                seen.add(pid)
                if pid in r["node_spans"]:
                    return r["step_alias"].get(pid, pid)
                pid = r["parents"].get(pid)
            if _kind(a) in ("chat", "retrieval") and s.get("parentSpanId"):
                # The library opens these under their node span by construction; it may arrive later.
                return r["step_alias"].get(s["parentSpanId"], s["parentSpanId"])
            return None

        for s, a in group:
            kind = _kind(a)
            if kind == "manifest":
                continue
            t0, t1 = _secs(s["startTimeUnixNano"]), _secs(s.get("endTimeUnixNano") or s["startTimeUnixNano"])
            failed = (s.get("status") or {}).get("code") in (2, "STATUS_CODE_ERROR")
            # Content events say whether their own span carried content; run and step events, which
            # carry none of their own, say what the run is known to carry.
            cm = mode_of(a) if kind not in ("run", "node") else None
            if kind == "run":
                evs += self._facts(s, "_run", None, cm, mk)
                status = a.get("agentlab.run.status")
                if status == "paused":
                    r["status"] = "paused"
                    continue
                rf: dict[str, Any] = {"status": "error" if failed or status == "error" else "ok",
                                      "latency_ms": round((t1 - r["t0"]) * 1000, 1)}
                if a.get("agentlab.run.outcome") is not None:
                    rf["outcome"] = str(a["agentlab.run.outcome"])
                if a.get("agentlab.run.output") is not None:
                    rf["output"] = _json(a["agentlab.run.output"])
                baseline = ((r["manifest"] or {}).get("app") or {}).get("baseline")
                if isinstance(baseline, str) and baseline:
                    rf["baseline"] = baseline
                r["status"] = rf["status"]
                r["paused_step"] = None
                evs.append(mk("_run", "run_finished", t1, rf, cm=cm))
                continue
            if kind == "node":
                node = str(a.get("agentlab.node") or node_id(s, a, node_from))
                sid = s.get("spanId")
                step = r["step_alias"].get(sid, sid)
                continued = step != sid
                waits = any(se.get("name") == "agentlab.gate.waiting" for se in s.get("events") or [])
                if not continued:
                    evs.append(mk(node, "step_started", t0, {}, step, cm))
                evs += self._facts(s, node, step, cm, mk)
                if failed:
                    msg = (s.get("status") or {}).get("message") or "step failed"
                    evs.append(mk(node, "error", t1, {"message": str(msg)}, step, cm))
                if waits and not failed:
                    continue  # paused at a gate: the step stays open until the resume re-runs this node
                # A continued step's time is its work before and after the pause, not the wait between.
                latency = round((t1 - t0) * 1000 + (r["step_work"].pop(step, 0) if continued else 0), 1)
                evs.append(mk(node, "step_finished", t1, {"status": "error" if failed else "ok", "latency_ms": latency},
                              step, cm))
                continue
            # A model call, a search, or another instrumentor's span stamped with the node: its
            # content belongs to the node's step; it is not a step of its own.
            node = str(a.get("agentlab.node") or node_id(s, a, node_from))
            step = owner_step(s, a)
            content = _content_events(s, a, node, t0, t1, failed,
                                      lambda n, et, ts, d: mk(n, et, ts, d, step, cm), price)
            for e in content:
                if e["event_type"] == "retrieval":
                    self._corpus_check(r, e["data"], a)
            evs += content
            evs += self._facts(s, node, step, cm, mk)

        evs.sort(key=lambda e: (e["ts"], _ORDER.get(e["event_type"], 1)))
        for e in evs:
            e["seq"] = r["seq"]
            r["seq"] += 1
        return evs

    @staticmethod
    def _facts(span: dict, node: str, step: str | None, cm: str, mk: Callable) -> list[dict]:
        out = []
        for se in span.get("events") or []:
            fact = _agentlab_fact(se.get("name") or "", _attrs(se.get("attributes")))
            if fact is None:
                continue
            ts = _secs(se.get("timeUnixNano") or span["startTimeUnixNano"])
            out.append(mk(node, fact[0], ts, fact[1], step, cm))
        return out

    @staticmethod
    def _corpus_check(r: dict, data: dict, a: dict) -> None:
        """R9's stale index: the retrieval says which version of its corpus it searched; the run's
        map says which version the app registered. A mismatch means the index was rebuilt
        elsewhere (another process) and the map's item list may not be what was searched."""
        h = a.get("agentlab.corpus.hash")
        if not isinstance(h, str):
            return
        data["corpus_hash"] = h
        src = next((x for x in ((r["manifest"] or {}).get("sources") or []) if x.get("id") == data.get("source")), None)
        if src is not None and sha256_hex(src) != h:
            data["stale_index"] = True


def convert(body: dict, node_from: dict | None = None, session_id: str | None = None,
            app: str | None = None, price: Any = None) -> list[dict]:
    """One self-contained OTLP body -> bench events (no memory across calls; see TraceState)."""
    return TraceState().ingest(body, app=app, session_id=session_id, node_from=node_from, price=price)

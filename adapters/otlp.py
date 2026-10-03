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
"""
from __future__ import annotations

import base64
import json
import re
from collections import OrderedDict
from typing import Any, Callable

V = "bench/0"
LLM_OPS = {"chat", "text_completion", "generate_content"}
RUN_OPS = {"invoke_agent", "invoke_workflow"}
# A span is AI work when one of its own attributes (not its resource's) is in these namespaces.
AI_PREFIXES = ("gen_ai.", "llm.", "openinference.", "traceloop.")
# Attributes that carry prompt, output, tool or document text: their presence means content_mode "full".
CONTENT_KEYS = ("gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions",
                "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "gen_ai.retrieval.documents",
                "gen_ai.retrieval.query.text", "input.value", "output.value", "pydantic_ai.all_messages")
CONTENT_MODES = {"full", "redacted", "absent"}
MAX_TRACES = 2000          # traces remembered across requests (oldest forgotten first)
MAX_PENDING_SPANS = 500    # spans held per trace while waiting to learn whether it is AI work


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
    override = a.get("bench.content_mode")
    if override in CONTENT_MODES:
        return override
    return "full" if any(a.get(k) not in (None, "", "[]") for k in CONTENT_KEYS) else "absent"


def node_id(span: dict, a: dict, node_from: dict | None = None) -> str:
    """The bench node for a span: operation plus the tool, agent or data source it acted on, never
    the model, so one step keeps one node when the model changes. A map's `node_from` overrides:
    `{"attribute": "<key>"}` reads that attribute; `{"span_name": true}` uses the span name."""
    if node_from:
        if "attribute" in node_from and a.get(node_from["attribute"]) is not None:
            return str(a[node_from["attribute"]])
        if node_from.get("span_name"):
            return span.get("name") or "span"
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
        if a.get("gen_ai.usage.cost") is not None:
            llm.update(cost_usd=float(a["gen_ai.usage.cost"]), cost_source="actual",
                       cost_basis="span attribute gen_ai.usage.cost")
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
_ORDER = {"run_started": -2, "step_started": -1, "step_finished": 2, "run_finished": 3}


class TraceState:
    """What OTLP ingest remembers between requests. One per bench (the server's Store owns it)."""

    def __init__(self) -> None:
        self.traces: OrderedDict[str, dict] = OrderedDict()
        self._run_apps: dict[str, str] = {}  # run_id -> app, since the last take_run_apps()

    def take_run_apps(self) -> dict[str, str]:
        """Which app each run converted since the last call belongs to (the server keeps it)."""
        out, self._run_apps = self._run_apps, {}
        return out

    def _trace(self, tid: str) -> dict:
        t = self.traces.get(tid)
        if t is None:
            t = self.traces[tid] = {"ai": False, "pending": [], "session": None, "app": None, "content": False,
                                    "mode": None, "run_id": None, "seq": 0}
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
        for rs in body.get("resourceSpans", []):
            res = _attrs((rs.get("resource") or {}).get("attributes"))
            for ss in rs.get("scopeSpans", []):
                for span in ss.get("spans", []):
                    by_trace.setdefault(span.get("traceId") or "", []).append((span, res))

        events: list[dict] = []
        for tid, spans in by_trace.items():
            t = self._trace(tid)
            if not t["ai"] and any(is_ai(s) for s, _ in spans):
                t["ai"] = True
            if not t["ai"]:
                if any(not s.get("parentSpanId") for s, _ in spans):
                    del self.traces[tid]  # the root came and nothing in the trace was AI work: drop it
                else:
                    t["pending"] = (t["pending"] + spans)[-MAX_PENDING_SPANS:]
                continue
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
            events += trace_events
        events.sort(key=lambda e: (e["run_id"], e["ts"], _ORDER.get(e["event_type"], 1)))
        return events


def convert(body: dict, node_from: dict | None = None, session_id: str | None = None,
            app: str | None = None, price: Any = None) -> list[dict]:
    """One self-contained OTLP body -> bench events (no memory across calls; see TraceState)."""
    return TraceState().ingest(body, app=app, session_id=session_id, node_from=node_from, price=price)

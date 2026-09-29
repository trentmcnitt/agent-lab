"""OTLP/HTTP JSON trace export -> bench events (SPEC.md section 5b).

Input is the body of a POST to /v1/traces in OTLP JSON encoding:
{"resourceSpans": [{"resource": {"attributes": [...]}, "scopeSpans": [{"spans": [...]}]}]}

GenAI attribute names follow open-telemetry/semantic-conventions-genai at e57c543b (09-24-26),
all Development status. Both cache-write spellings are read: `cache_write` (current) and
`cache_creation` (before upstream PR 440).
"""
from __future__ import annotations

import json
from typing import Any

V = "bench/0"
LLM_OPS = {"chat", "text_completion", "generate_content"}
RUN_OPS = {"invoke_agent", "invoke_workflow"}


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


def _parts(msg: dict):
    """A semconv message's text: its `parts` of type text joined, else the parts as given."""
    parts = msg.get("parts")
    if isinstance(parts, list) and parts and all(isinstance(p, dict) and p.get("type") == "text" for p in parts):
        return "".join(p.get("content", "") for p in parts)
    return parts if parts is not None else msg.get("content")


def _node(span: dict, attrs: dict, node_from: dict | None) -> str:
    if node_from and "attribute" in node_from and node_from["attribute"] in attrs:
        return str(attrs[node_from["attribute"]])
    return span.get("name") or "span"


def _first(attrs: dict, *keys: str) -> Any:
    for k in keys:
        if attrs.get(k) is not None:
            return attrs[k]
    return None


def convert(body: dict, node_from: dict | None = None, session_id: str | None = None,
            content_mode: str = "redacted", price: Any = None) -> list[dict]:
    """Returns bench events sorted by (run_id, ts). `price(model, in, out, cr, cw) -> usd | None`
    estimates cost when the span carries none."""
    events: list[dict] = []
    for rs in body.get("resourceSpans", []):
        res = _attrs((rs.get("resource") or {}).get("attributes"))
        for ss in rs.get("scopeSpans", []):
            for span in ss.get("spans", []):
                events += _span_events(span, res, node_from, session_id, content_mode, price)
    events.sort(key=lambda e: (e["run_id"], e["ts"], _ORDER.get(e["event_type"], 1)))
    seqs: dict[str, int] = {}
    for e in events:
        e["seq"] = seqs.get(e["run_id"], 0)
        seqs[e["run_id"]] = e["seq"] + 1
    return events


# Same-ts ordering: a run opens before its steps, a step opens before its content, and closes after.
_ORDER = {"run_started": -2, "step_started": -1, "step_finished": 2, "run_finished": 3}


def _span_events(span, res, node_from, session_id, content_mode, price) -> list[dict]:
    a = {**res, **_attrs(span.get("attributes"))}
    run_id = str(_first(a, "bench.run_id") or span["traceId"])
    sid = session_id or _first(a, "bench.session_id", "gen_ai.conversation.id", "session.id")
    node = _node(span, a, node_from)
    step_id, parent = span.get("spanId"), span.get("parentSpanId") or None
    t0, t1 = _secs(span["startTimeUnixNano"]), _secs(span.get("endTimeUnixNano") or span["startTimeUnixNano"])
    op = a.get("gen_ai.operation.name")
    failed = (span.get("status") or {}).get("code") in (2, "STATUS_CODE_ERROR")

    def ev(n, et, ts, data, sid_=step_id, par=parent):
        e = {"v": V, "run_id": run_id, "ts": ts, "node": n, "event_type": et,
             "content_mode": content_mode, "data": data}
        if sid:
            e["session_id"] = str(sid)
        if sid_:
            e["step_id"] = sid_
        if par:
            e["parent_step_id"] = par
        return e

    out: list[dict] = []
    is_run = op in RUN_OPS and not parent
    if is_run:
        out.append(ev("_run", "run_started", t0, {"label": span.get("name", "")}, None, None))
    else:
        out.append(ev(node, "step_started", t0, {}))

    if op in LLM_OPS:
        inp = _first(a, "gen_ai.usage.input_tokens") or 0
        cr = _first(a, "gen_ai.usage.cache_read.input_tokens") or 0
        cw = _first(a, "gen_ai.usage.cache_write.input_tokens", "gen_ai.usage.cache_creation.input_tokens") or 0
        outp = _first(a, "gen_ai.usage.output_tokens") or 0
        model = _first(a, "gen_ai.response.model", "gen_ai.request.model") or "unknown"
        llm: dict[str, Any] = {"model": model, "input_tokens": int(inp), "output_tokens": int(outp),
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
        # Prompt and response (SPEC: llm_call system / messages / output). The conventions carry
        # them as JSON strings; parse when possible, else keep the string.
        for src, dst in (("gen_ai.system_instructions", "system"), ("gen_ai.input.messages", "messages"),
                         ("gen_ai.output.messages", "output")):
            v = a.get(src)
            if v is None:
                continue
            if isinstance(v, str):
                try:
                    v = json.loads(v)
                except ValueError:
                    pass
            if dst == "system" and isinstance(v, list):
                v = "\n".join(str(p.get("content", "")) for p in v if isinstance(p, dict)) or json.dumps(v)
            if dst == "messages":
                if not isinstance(v, list):
                    v = [{"role": "user", "content": v}]
                v = [{"role": m.get("role", "?"), "content": _parts(m)} if isinstance(m, dict) else {"role": "?", "content": m} for m in v]
            if dst == "output" and isinstance(v, list):
                v = "\n".join(str(_parts(m)) for m in v if isinstance(m, dict)) if all(isinstance(m, dict) for m in v) else v
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
                tc[dst] = a[src]
        out.append(ev(node, "tool_call", t1, tc))

    if failed:
        msg = (span.get("status") or {}).get("message") or a.get("error.type") or "span failed"
        out.append(ev(node, "error", t1, {"message": str(msg), **({"type": a["error.type"]} if a.get("error.type") else {})}))

    latency = round((t1 - t0) * 1000, 1)
    if is_run:
        out.append(ev("_run", "run_finished", t1, {"status": "error" if failed else "ok", "latency_ms": latency}, None, None))
    else:
        out.append(ev(node, "step_finished", t1, {"status": "error" if failed else "ok", "latency_ms": latency}))
    return out

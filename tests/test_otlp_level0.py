"""Level 0: OTLP straight from an instrumented app, no map, no bench code in the app.

The fixtures in tests/fixtures/otlp/ are real exports, captured 10-03-26 from
examples/level0_pydantic_ai.py (pydantic-ai-slim 2.54.0, opentelemetry-sdk and
opentelemetry-exporter-otlp-proto-http 1.45.0) by a dummy receiver:
- pydantic_ai_batch.pb: one POST, BatchSpanProcessor, all five spans of one run.
- pydantic_ai_batch_gzip.pb.gz: the same, with OTEL_EXPORTER_OTLP_COMPRESSION=gzip.
- pydantic_ai_split_{0..4}.pb: the same agent run in-process under a SimpleSpanProcessor instead of
  the example's BatchSpanProcessor (a scratch variant, not shipped): one POST per span, the root last.
"""
import gzip
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from starlette.testclient import TestClient

import bench.server as srv
from adapters import otlp

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests/fixtures/otlp"
EVENT = Draft202012Validator(json.loads((ROOT / "schema/bench-event.schema.json").read_text()))
PB = {"content-type": "application/x-protobuf"}


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "LOG_DIR", tmp_path / "log")
    monkeypatch.setattr(srv, "APPS_DIR", tmp_path / "apps")
    srv.store.events.clear()
    srv.store.run_app.clear()
    srv.store.otlp = otlp.TraceState()
    srv.store.load_apps()
    return TestClient(srv.app)


def events(sid=None):
    return [e for e in srv.store.events if sid is None or e.get("session_id") == sid]


# ---- hand-built spans (the decoder and the rules) --------------------------------------------

def kv(k, v):
    if isinstance(v, bool):
        return {"key": k, "value": {"boolValue": v}}
    if isinstance(v, int):
        return {"key": k, "value": {"intValue": str(v)}}
    if isinstance(v, float):
        return {"key": k, "value": {"doubleValue": v}}
    return {"key": k, "value": {"stringValue": v}}


NS = 1_790_000_000_000_000_000


def span(name, sid, parent=None, trace="1" * 32, t=0, dur=10, attrs=None, status=1):
    s = {"traceId": trace, "spanId": sid, "name": name, "startTimeUnixNano": str(NS + t * 1_000_000),
         "endTimeUnixNano": str(NS + (t + dur) * 1_000_000), "status": {"code": status},
         "attributes": [kv(k, v) for k, v in (attrs or {}).items()]}
    if parent:
        s["parentSpanId"] = parent
    return s


def body(*spans, res=None):
    return {"resourceSpans": [{"resource": {"attributes": [kv(k, v) for k, v in (res or {}).items()]},
                               "scopeSpans": [{"spans": list(spans)}]}]}


def to_protobuf(b: dict) -> bytes:
    """A JSON-shaped body -> protobuf, the way an SDK exporter would send it (ids as raw bytes)."""
    from google.protobuf.json_format import ParseDict
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
    import base64
    b = json.loads(json.dumps(b))
    for rs in b["resourceSpans"]:
        for ss in rs["scopeSpans"]:
            for s in ss["spans"]:
                for k in ("traceId", "spanId", "parentSpanId"):
                    if k in s:
                        s[k] = base64.b64encode(bytes.fromhex(s[k])).decode()
    return ParseDict(b, ExportTraceServiceRequest()).SerializeToString()


CHAT = {"gen_ai.operation.name": "chat", "gen_ai.request.model": "m1", "gen_ai.agent.name": "bot",
        "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 2}


def test_protobuf_ids_arrive_as_hex(c):
    r = c.post("/v1/traces", content=to_protobuf(body(span("chat m1", "ab" * 8, attrs=CHAT))), headers=PB)
    assert r.status_code == 200 and r.headers["content-type"] == "application/x-protobuf"
    ev = events()
    assert {e["run_id"] for e in ev} == {"1" * 32}
    assert next(e for e in ev if e["event_type"] == "llm_call")["step_id"] == "ab" * 8


def test_gzip_body_and_bad_bodies(c):
    raw = to_protobuf(body(span("chat m1", "ab" * 8, attrs=CHAT)))
    assert c.post("/v1/traces", content=gzip.compress(raw), headers={**PB, "content-encoding": "gzip"}).status_code == 200
    assert any(e["event_type"] == "llm_call" for e in events())
    assert c.post("/v1/traces", content=b"not gzip", headers={**PB, "content-encoding": "gzip"}).status_code == 400
    assert c.post("/v1/traces", content=b"\xff\xff\xff", headers=PB).status_code == 400
    assert c.post("/v1/traces", content=b"x", headers={"content-type": "text/plain"}).status_code == 415
    bomb = gzip.compress(b"\0" * (srv.MAX_BODY + 10))
    assert c.post("/v1/traces", content=bomb, headers={**PB, "content-encoding": "gzip"}).status_code == 413


def test_app_and_session_routing(c):
    b = body(span("chat m1", "ab" * 8, attrs={**CHAT, "session.id": "from-span"}), res={"service.name": "svc"})
    c.post("/v1/traces", json=b, headers={"x-agent-lab-session": "from-header"})
    run = c.get("/runs").json()[0]
    assert run["app"] == "svc" and run["session_id"] == "from-header"
    # Query parameters override both.
    srv.store.events.clear()
    srv.store.run_app.clear()
    srv.store.otlp = otlp.TraceState()
    c.post("/v1/traces?app=other&session_id=from-query", json=b, headers={"x-agent-lab-session": "from-header"})
    run = c.get("/runs").json()[0]
    assert run["app"] == "other" and run["session_id"] == "from-query"
    # With neither, the span's session.id.
    srv.store.events.clear()
    srv.store.run_app.clear()
    srv.store.otlp = otlp.TraceState()
    c.post("/v1/traces", json=b)
    assert c.get("/runs").json()[0]["session_id"] == "from-span"


def test_registered_node_from_is_found_by_service_name(c):
    head = json.loads((ROOT / "examples/hello-answer.recording.jsonl").read_text().splitlines()[0])
    topo = {**head["topology"], "app": {**head["topology"]["app"], "id": "svc"}, "node_from": {"attribute": "my.node"}}
    assert c.put("/apps/svc", json={"topology": topo}).status_code == 200
    c.post("/v1/traces", json=body(span("chat m1", "ab" * 8, attrs={**CHAT, "my.node": "answer"}), res={"service.name": "svc"}))
    assert next(e for e in events() if e["event_type"] == "llm_call")["node"] == "answer"


def test_root_span_is_the_run_even_when_it_arrives_last(c):
    root, tool, chat = "a1" * 8, "b2" * 8, "c3" * 8
    tid = "2" * 32
    c.post("/v1/traces", json=body(span("chat m1", chat, root, tid, t=1, attrs=CHAT)))
    c.post("/v1/traces", json=body(span("execute_tool lookup", tool, root, tid, t=20,
                                        attrs={"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup"})))
    assert not any(e["event_type"] == "run_started" for e in events())
    c.post("/v1/traces", json=body(span("invoke_agent bot", root, None, tid, t=0, dur=40,
                                        attrs={"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "bot"})))
    ev = events()
    assert [e["event_type"] for e in ev if e["node"] == "_run"] == ["run_started", "run_finished"]
    assert {e["run_id"] for e in ev} == {tid}
    # The agent root is the run, not a step; its children point at it.
    assert not any(e.get("step_id") == root for e in ev)
    assert {e["parent_step_id"] for e in ev if e["node"] != "_run"} == {root}
    # seq keeps counting across requests, so no two events of a run share one.
    seqs = [e["seq"] for e in ev]
    assert len(set(seqs)) == len(seqs)
    assert c.get("/runs").json()[0]["status"] == "ok"


def test_a_root_that_is_a_model_call_is_also_a_step():
    ev = otlp.convert(body(span("chat m1", "ab" * 8, attrs=CHAT)))
    assert [e["event_type"] for e in ev] == ["run_started", "step_started", "llm_call", "step_finished", "run_finished"]
    assert ev[1]["node"] == "chat bot"  # operation + agent, not the model


def test_non_ai_traces_are_dropped_even_across_requests(c):
    http = {"http.request.method": "GET", "url.path": "/health"}
    c.post("/v1/traces", json=body(span("GET /health", "ab" * 8, attrs=http), res={"service.name": "svc"}))
    assert events() == [] and c.get("/runs").json() == []
    # A non-AI child arriving before any AI span of its trace waits, then rides along.
    tid, root = "3" * 32, "d4" * 8
    c.post("/v1/traces", json=body(span("db query", "e5" * 8, root, tid, t=1, attrs={"db.system": "sqlite"})))
    assert events() == []
    c.post("/v1/traces", json=body(span("chat m1", "f6" * 8, root, tid, t=5, attrs=CHAT)))
    assert {e["node"] for e in events()} == {"db query", "chat bot"}
    # A non-AI root closes the run; it is the run and also a step (the request handler).
    c.post("/v1/traces", json=body(span("POST /ask", root, None, tid, t=0, dur=30, attrs={"http.request.method": "POST"})))
    assert [e["event_type"] for e in events() if e["node"] == "_run"] == ["run_started", "run_finished"]
    # A non-AI trace whose children came first is dropped when its root arrives.
    c.post("/v1/traces", json=body(span("static", "a7" * 8, "b8" * 8, "4" * 32, attrs={"http.route": "/x"})))
    c.post("/v1/traces", json=body(span("GET /x", "b8" * 8, None, "4" * 32, attrs={"http.route": "/x"})))
    assert "4" * 32 not in {e["run_id"] for e in events()} and "4" * 32 not in srv.store.otlp.traces


def test_content_mode_inference():
    with_text = {**CHAT, "gen_ai.input.messages": json.dumps([{"role": "user", "parts": [{"type": "text", "content": "hi"}]}])}
    ev = otlp.convert(body(span("chat", "ab" * 8, attrs=with_text)))
    assert {e["content_mode"] for e in ev} == {"full"}
    ev = otlp.convert(body(span("chat", "ab" * 8, attrs=CHAT)))
    assert {e["content_mode"] for e in ev} == {"absent"}
    # The app can say what it sent: bench.content_mode on the span or the resource wins.
    ev = otlp.convert(body(span("chat", "ab" * 8, attrs=with_text), res={"bench.content_mode": "redacted"}))
    assert {e["content_mode"] for e in ev} == {"redacted"}
    # A run whose root carries no text, but whose steps did, is "full".
    root = span("invoke_agent bot", "a1" * 8, attrs={"gen_ai.operation.name": "invoke_agent"})
    ev = otlp.convert(body(root, span("chat", "ab" * 8, "a1" * 8, attrs=with_text)))
    assert {e["content_mode"] for e in ev if e["node"] == "_run"} == {"full"}


def test_retrieval_semconv():
    docs = [{"id": "vpn", "score": 0.9, "title": "VPN", "content": "Reset it in the portal."}, {"score": 0.1}]
    attrs = {"gen_ai.operation.name": "retrieval", "gen_ai.data_source.id": "handbook",
             "gen_ai.retrieval.query.text": "vpn?", "gen_ai.retrieval.documents": json.dumps(docs)}
    ev = otlp.convert(body(span("retrieval handbook", "ab" * 8, "cd" * 8, attrs=attrs)))
    r = next(e for e in ev if e["event_type"] == "retrieval")
    assert not list(EVENT.iter_errors(r))
    assert r["node"] == "retrieval handbook" and r["data"]["source"] == "handbook" and r["data"]["query"] == "vpn?"
    assert r["data"]["hits"] == [{"id": "vpn", "title": "VPN", "score": 0.9, "text": "Reset it in the portal."},
                                 {"id": "handbook#1", "score": 0.1}]
    # Structured (kvlist array) documents work too.
    structured = {"key": "gen_ai.retrieval.documents", "value": {"arrayValue": {"values": [
        {"kvlistValue": {"values": [kv("id", "a"), kv("score", 0.5)]}}]}}}
    s = span("retrieval", "ab" * 8, "cd" * 8, attrs={"gen_ai.operation.name": "retrieval"})
    s["attributes"].append(structured)
    r = next(e for e in otlp.convert(body(s)) if e["event_type"] == "retrieval")
    assert r["data"]["hits"] == [{"id": "a", "score": 0.5}]


def test_evaluation_span_event_becomes_a_check():
    s = span("chat", "ab" * 8, attrs=CHAT)
    s["events"] = [{"name": "gen_ai.evaluation.result", "timeUnixNano": str(NS + 5_000_000), "attributes": [
        kv("gen_ai.evaluation.name", "Groundedness"), kv("gen_ai.evaluation.score.label", "fail"),
        kv("gen_ai.evaluation.explanation", "cites nothing")]}]
    ck = next(e for e in otlp.convert(body(s)) if e["event_type"] == "check_result")
    assert ck["data"] == {"name": "Groundedness", "passed": False, "kind": "evaluation", "detail": "cites nothing"}


def test_openinference_aliases():
    a = {"openinference.span.kind": "LLM", "llm.model_name": "gpt-x", "llm.token_count.prompt": 12,
         "llm.token_count.completion": 3, "llm.input_messages.0.message.role": "system",
         "llm.input_messages.0.message.content": "Be brief.", "llm.input_messages.1.message.role": "user",
         "llm.input_messages.1.message.content": "Hi", "llm.output_messages.0.message.role": "assistant",
         "llm.output_messages.0.message.content": "Hello", "session.id": "s1"}
    ev = otlp.convert(body(span("ChatOpenAI", "ab" * 8, "cd" * 8, attrs=a)))
    llm = next(e for e in ev if e["event_type"] == "llm_call")
    assert llm["data"]["model"] == "gpt-x" and llm["data"]["input_tokens"] == 12 and llm["data"]["output_tokens"] == 3
    assert llm["data"]["system"] == "Be brief."
    assert llm["data"]["messages"] == [{"role": "user", "content": "Hi"}] and llm["data"]["output"] == "Hello"
    assert llm["node"] == "chat" and llm["session_id"] == "s1" and llm["content_mode"] == "full"
    r = {"openinference.span.kind": "RETRIEVER", "input.value": "vpn?",
         "retrieval.documents.0.document.id": "vpn", "retrieval.documents.0.document.score": 0.8,
         "retrieval.documents.0.document.content": "Use the portal."}
    hit = next(e for e in otlp.convert(body(span("retrieve", "ab" * 8, "cd" * 8, attrs=r))) if e["event_type"] == "retrieval")
    assert hit["data"] == {"hits": [{"id": "vpn", "score": 0.8, "text": "Use the portal."}], "query": "vpn?"}
    g = {"openinference.span.kind": "GUARDRAIL", "output.value": "blocked: PII"}
    ck = next(e for e in otlp.convert(body(span("pii-guard", "ab" * 8, "cd" * 8, attrs=g, status=2))) if e["event_type"] == "check_result")
    assert ck["data"]["passed"] is False and ck["data"]["kind"] == "guardrail" and ck["data"]["name"] == "pii-guard"
    # When a span carries both vocabularies, the GenAI names win.
    both = {**a, "gen_ai.operation.name": "chat", "gen_ai.request.model": "real-model"}
    llm = next(e for e in otlp.convert(body(span("x", "ab" * 8, "cd" * 8, attrs=both))) if e["event_type"] == "llm_call")
    assert llm["data"]["model"] == "real-model"


# ---- the real Pydantic AI export, end to end -----------------------------------------------

def check_pydantic_run(ev):
    for e in ev:
        assert not list(EVENT.iter_errors(e)), e
    tids = {e["run_id"] for e in ev}
    assert len(tids) == 1 and len(tids.pop()) == 32  # hex trace id, not base64
    rs = next(e for e in ev if e["event_type"] == "run_started")
    assert rs["data"]["app"] == "level0-pydantic-ai" and rs["data"]["via"] == "otlp"
    assert rs["data"]["input"] == "How do I reset my VPN password?"
    rf = next(e for e in ev if e["event_type"] == "run_finished")
    assert rf["data"]["status"] == "ok" and rf["data"]["outcome"].startswith("From the handbook")
    llm = [e for e in ev if e["event_type"] == "llm_call"]
    assert len(llm) == 2 and all(e["node"] == "chat helpdesk" for e in llm)
    assert llm[0]["data"]["messages"] == [{"role": "user", "content": "How do I reset my VPN password?"}]
    assert llm[0]["data"]["system"].startswith("Answer IT questions")
    assert "Reset password" in llm[1]["data"]["output"]
    tool = next(e for e in ev if e["event_type"] == "tool_call")
    assert tool["node"] == "execute_tool search_handbook" and tool["data"]["arguments"] == {"query": "How do I reset my VPN password?"}
    parents = {e["parent_step_id"] for e in llm} | {tool["parent_step_id"]}
    assert len(parents) == 1  # the model calls and the tool hang off the agent run
    ret = next(e for e in ev if e["event_type"] == "retrieval")
    assert ret["node"] == "retrieval handbook" and ret["data"]["source"] == "handbook"
    assert ret["data"]["hits"][0]["id"] == "vpn-reset" and "self-service portal" in ret["data"]["hits"][0]["text"]
    assert ret["parent_step_id"] == tool["step_id"]  # the search ran inside the tool
    assert {e["content_mode"] for e in ev} == {"full"}
    assert len({e["seq"] for e in ev}) == len(ev)


def test_real_pydantic_ai_export(c):
    r = c.post("/v1/traces", content=(FIX / "pydantic_ai_batch.pb").read_bytes(),
               headers={**PB, "x-agent-lab-session": "demo"})
    assert r.status_code == 200 and r.content == b""  # an empty ExportTraceServiceResponse: nothing rejected
    ev = events("demo")
    check_pydantic_run(ev)
    assert c.get("/runs?session_id=demo").json()[0]["app"] == "level0-pydantic-ai"


def test_real_pydantic_ai_export_gzip(c):
    r = c.post("/v1/traces", content=(FIX / "pydantic_ai_batch_gzip.pb.gz").read_bytes(),
               headers={**PB, "content-encoding": "gzip"})
    assert r.status_code == 200
    check_pydantic_run(events())


def test_real_pydantic_ai_split_export_root_last(c):
    for i in range(5):
        assert c.post("/v1/traces", content=(FIX / f"pydantic_ai_split_{i}.pb").read_bytes(), headers=PB).status_code == 200
        if i < 4:
            assert not any(e["event_type"] == "run_started" for e in events())
    ev = events()
    check_pydantic_run(ev)
    # The run opens last on the wire but first in time: viewers sort by ts.
    rs = next(e for e in ev if e["event_type"] == "run_started")
    assert rs["ts"] == min(e["ts"] for e in ev)
    # Pydantic AI's per-run conversation id is the session when nothing else names one.
    assert len({e["session_id"] for e in ev}) == 1


def test_real_openinference_export(c):
    """openinference_openai.pb: openinference-instrumentation-openai 0.1.63 (openai 3.24.0) against a
    fake local OpenAI endpoint (no key), plus a CHAIN root and a RETRIEVER span written with
    OpenInference's own names; captured 10-03-26. Recapture: uv run tests/fixtures/otlp/openinference_openai.capture.py"""
    r = c.post("/v1/traces", content=(FIX / "openinference_openai.pb").read_bytes(), headers=PB)
    assert r.status_code == 200 and r.content == b""
    ev = events()
    for e in ev:
        assert not list(EVENT.iter_errors(e)), e
    rs = next(e for e in ev if e["event_type"] == "run_started")
    assert rs["data"]["app"] == "level0-openinference" and rs["data"]["input"] == "How do I reset my VPN password?"
    llm = next(e for e in ev if e["event_type"] == "llm_call")["data"]
    assert llm["model"] == "gpt-4o-mini" and llm["provider"] == "openai" and llm["finish_reason"] == "stop"
    assert (llm["input_tokens"], llm["output_tokens"]) == (42, 12)
    assert llm["system"] == "Answer from the handbook only."
    assert llm["messages"] == [{"role": "user", "content": "How do I reset my VPN password?"}]
    assert llm["output"].startswith("Open the self-service portal")
    ret = next(e for e in ev if e["event_type"] == "retrieval")
    assert ret["node"] == "search handbook" and ret["data"]["hits"][0]["id"] == "vpn-reset"
    assert {e["node"] for e in ev} == {"_run", "answer", "search handbook", "chat"}


# ---- usability round 4 (engineer persona) ------------------------------------------------------
def test_app_filter_keeps_other_apps_runs_out_of_the_stream(c):
    """?app= on /stream: another service's runs never reach this app's page (or its inferred map),
    even before their root span (and run_started) arrives."""
    child = span("chat m1", "cd" * 8, parent="ef" * 8, trace="2" * 32, attrs=CHAT)
    c.post("/v1/traces", json=body(child, res={"service.name": "other-app"}))
    c.post("/v1/traces", json=body(span("chat m1", "ab" * 8, attrs=CHAT), res={"service.name": "mine"}))
    mine, other = srv.store.backlog(None, "mine"), srv.store.backlog(None, "other-app")
    assert mine and all(e["run_id"] == "1" * 32 for e in mine)
    assert other and all(e["run_id"] == "2" * 32 for e in other)
    # A native run that never names its app passes any app filter (the filter only keeps out known others).
    c.post("/ingest", json={"v": "bench/0", "run_id": "native", "ts": 1.0, "node": "n", "event_type": "step_started", "data": {}})
    assert any(e["run_id"] == "native" for e in srv.store.backlog(None, "mine"))
    # Unregistered apps that sent runs are listed, marked inferred; a missing map can be asked for as null.
    listed = {a["id"]: a for a in c.get("/topologies").json()}
    assert listed["mine"]["inferred"] and listed["other-app"]["inferred"]
    assert c.get("/topology/mine").status_code == 404
    r = c.get("/topology/mine?missing=null")
    assert r.status_code == 200 and r.json() is None


def test_tool_call_output_is_json_not_a_python_repr():
    out = json.dumps([{"role": "assistant", "parts": [{"type": "tool_call", "id": "t1", "name": "lookup_order", "arguments": {"order_id": "B200"}}]}])
    ev = [e for e in otlp.convert(body(span("chat m1", "ab" * 8, attrs={**CHAT, "gen_ai.output.messages": out})))
          if e["event_type"] == "llm_call"][0]
    assert json.loads(ev["data"]["output"])[0]["name"] == "lookup_order"
    assert "'" not in ev["data"]["output"]


def test_a_tool_call_carries_its_duration_and_a_model_call_the_tools_it_asked_for():
    out = json.dumps([{"role": "assistant", "parts": [
        {"type": "tool_call", "id": "t1", "name": "get_user", "arguments": {"handle": "g"}},
        {"type": "tool_call", "id": "t2", "name": "create_draft", "arguments": {"body": "Hi"}}]}])
    llm = [e for e in otlp.convert(body(span("chat m1", "ab" * 8, attrs={**CHAT, "gen_ai.output.messages": out})))
           if e["event_type"] == "llm_call"][0]
    assert llm["data"]["tool_calls"] == [{"id": "t1", "name": "get_user", "arguments": {"handle": "g"}},
                                         {"id": "t2", "name": "create_draft", "arguments": {"body": "Hi"}}]
    t = {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "get_user", "gen_ai.tool.call.id": "t1"}
    tool = next(e for e in otlp.convert(body(span("execute_tool get_user", "ab" * 8, attrs=t))) if e["event_type"] == "tool_call")
    assert tool["data"]["call_id"] == "t1" and isinstance(tool["data"]["latency_ms"], float)
    assert not list(EVENT.iter_errors(tool))


def test_level0_retrieval_keeps_the_file_and_page_the_loader_reported():
    """OpenInference sends each document's metadata as one JSON string; stock LangChain loaders put the
    file in `source`, plus `page` for PDFs (examples/messy_docs/REPORT). No document id is sent."""
    r = {"openinference.span.kind": "RETRIEVER", "input.value": "loaner?",
         "retrieval.documents.0.document.content": "LOANER UNIT PROGRAM. Effective immediately we can offer a loaner.",
         "retrieval.documents.0.document.metadata": json.dumps({"source": "scan_0042.pdf", "page": 1}),
         "retrieval.documents.1.document.content": "Ask a lead.",
         "retrieval.documents.1.document.metadata": json.dumps({"source": "faq.md"})}
    hits = next(e for e in otlp.convert(body(span("retrieve", "ab" * 8, "cd" * 8, attrs=r))) if e["event_type"] == "retrieval")["data"]["hits"]
    assert hits[0] == {"id": "scan_0042.pdf#0", "document": "scan_0042.pdf", "page": 1,
                       "text": "LOANER UNIT PROGRAM. Effective immediately we can offer a loaner."}
    assert hits[1]["document"] == "faq.md" and "page" not in hits[1] and hits[1]["id"] == "faq.md#1"

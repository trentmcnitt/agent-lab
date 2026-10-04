"""Runtime attribution: every span and fact lands under the node that produced it, with no ids passed.

Runs real LangGraph graphs with LangChain's fake chat models (no API calls) under
`agentlab.testing.capture()`.
"""
import asyncio
import json
import logging
import subprocess
import sys
import textwrap
import threading
from typing import Literal, TypedDict

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, RetryPolicy, interrupt
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic import BaseModel

import agentlab as lab
from agentlab import _runtime, _state, testing
from agentlab.langgraph import instrument
from conftest import attrs, by_kind, events

APP = lab.App(name="Runtime", id="runtime")


class S(TypedDict, total=False):
    q: str
    out: str
    route: str


def model(*replies, usage=None):
    msgs = [AIMessage(content=r, usage_metadata=usage, response_metadata={"model_name": "fake-1", "stop_reason": "end_turn"})
            if usage else AIMessage(content=r, response_metadata={"model_name": "fake-1"}) for r in replies]
    return GenericFakeChatModel(messages=iter(msgs))


def linear(*nodes, checkpointer=None, **kw):
    g = StateGraph(S)
    prev = START
    for name, fn in nodes:
        g.add_node(name, fn)
        g.add_edge(prev, name)
        prev = name
    g.add_edge(prev, END)
    return instrument(g.compile(checkpointer=checkpointer), app=APP, **kw)


def spans_named(spans, prefix):
    return [s for s in spans if s.name.startswith(prefix)]


def parent_of(span, spans):
    return next((p for p in spans if span.parent and p.context.span_id == span.parent.span_id), None)


def node_span(spans, node):
    found = [s for s in by_kind(spans, "node") if attrs(s)["agentlab.node"] == node]
    assert len(found) == 1, f"{len(found)} spans for node {node}"
    return found[0]


# ---- runs and nodes

def test_one_run_span_one_manifest_and_a_node_span_per_step():
    with testing.capture() as spans:
        out = linear(("first", lambda s: {"out": "1"}), ("second", lambda s: {"out": s["out"] + "2"})).invoke(
            {"q": "hi"}, {"configurable": {"thread_id": "t-1"}, "metadata": {"session_id": "sess"}})
    assert out["out"] == "12"
    (run,) = by_kind(spans, "run")
    (man,) = by_kind(spans, "manifest")
    ra = attrs(run)
    assert ra["agentlab.app"] == "runtime" and ra["agentlab.run"].startswith("t-1:")
    assert ra["agentlab.thread"] == "t-1" and ra["session.id"] == "sess"
    assert ra["agentlab.run.status"] == "ok" and ra["agentlab.run.resume"] is False
    assert json.loads(ra["agentlab.run.input"]) == {"q": "hi"}
    assert json.loads(ra["agentlab.run.output"]) == {"q": "hi", "out": "12"}
    assert parent_of(man, spans) is run and spans.index(man) == 0          # the map ships first
    assert json.loads(attrs(man)["agentlab.manifest"])["app"]["id"] == "runtime"
    nodes = by_kind(spans, "node")
    assert [attrs(n)["agentlab.node"] for n in nodes] == ["first", "second"]
    assert all(parent_of(n, spans) is run for n in nodes)
    assert [attrs(n)["agentlab.step"] for n in nodes] == [1, 2]
    assert all(attrs(n)["agentlab.run"] == ra["agentlab.run"] for n in nodes)


def test_no_thread_means_a_bare_hex_run_id():
    with testing.capture() as spans:
        linear(("only", lambda s: {})).invoke({"q": "x"})
    run_id = attrs(by_kind(spans, "run")[0])["agentlab.run"]
    assert len(run_id) == 8 and ":" not in run_id


def test_a_node_error_marks_the_node_and_the_run_and_reaches_the_app():
    def boom(s):
        raise ValueError("bad input")

    with testing.capture() as spans:
        with pytest.raises(ValueError, match="bad input"):
            linear(("ok", lambda s: {}), ("boom", boom)).invoke({"q": "x"})
    assert node_span(spans, "boom").status.status_code.name == "ERROR"
    assert node_span(spans, "ok").status.status_code.name == "UNSET"
    assert attrs(by_kind(spans, "run")[0])["agentlab.run.status"] == "error"


def test_a_retried_node_gets_a_span_per_attempt():
    tries = {"n": 0}

    def flaky(s):
        tries["n"] += 1
        if tries["n"] == 1:
            raise ConnectionError("blip")
        return {"out": "ok"}

    g = StateGraph(S)
    g.add_node("flaky", flaky, retry_policy=RetryPolicy(max_attempts=2, initial_interval=0.001, jitter=False))
    g.add_edge(START, "flaky")
    g.add_edge("flaky", END)
    with testing.capture() as spans:
        instrument(g.compile(), app=APP).invoke({"q": "x"})
    attempts = [s for s in by_kind(spans, "node") if attrs(s)["agentlab.node"] == "flaky"]
    assert [s.status.status_code.name for s in attempts] == ["ERROR", "UNSET"]


# ---- model calls

class Verdict(BaseModel):
    category: str
    rationale: str


def test_a_model_call_is_a_chat_span_under_its_node():
    usage = {"input_tokens": 120, "output_tokens": 7, "total_tokens": 127,
             "input_token_details": {"cache_read": 100, "cache_creation": 0, "ephemeral_5m_input_tokens": 15}}
    llm = model("hello there", usage=usage)

    def ask(s):
        reply = llm.invoke([SystemMessage("Be brief."), HumanMessage(s["q"])])
        return {"out": reply.content}

    price = lambda m, i, o, cr, cw: (i * 3 + o * 15) / 1e6
    with testing.capture(price=price, price_basis="test table") as spans:
        linear(("prep", lambda s: {}), ("ask", ask)).invoke({"q": "What is up?"})
    (chat,) = by_kind(spans, "chat")
    assert parent_of(chat, spans) is node_span(spans, "ask")
    a = attrs(chat)
    assert chat.name == "chat fake-1"
    assert a["agentlab.node"] == "ask" and a["agentlab.app"] == "runtime"
    assert a["gen_ai.operation.name"] == "chat" and a["gen_ai.response.model"] == "fake-1"
    assert a["gen_ai.usage.input_tokens"] == 120                       # LangChain's total, cache included
    assert a["gen_ai.usage.cache_read.input_tokens"] == 100
    assert a["gen_ai.usage.cache_write.input_tokens"] == 15            # per-TTL keys when the generic one is 0
    assert a["gen_ai.response.finish_reasons"] == ("end_turn",)
    assert json.loads(a["gen_ai.system_instructions"]) == [{"type": "text", "content": "Be brief."}]
    assert json.loads(a["gen_ai.input.messages"]) == [{"role": "user", "parts": [{"type": "text", "content": "What is up?"}]}]
    out = json.loads(a["gen_ai.output.messages"])
    assert out == [{"role": "assistant", "parts": [{"type": "text", "content": "hello there"}], "finish_reason": "end_turn"}]
    assert a["agentlab.cost.usd"] == pytest.approx((120 * 3 + 7 * 15) / 1e6) and a["agentlab.cost.basis"] == "test table"
    assert chat.start_time < chat.end_time


def test_structured_output_schema_is_recorded():
    """What `with_structured_output` binds (`ls_structured_output_format`) reaches the callback as
    `options` (A11 check 3), so the chat span carries the JSON schema."""
    llm = model('{"category": "a", "rationale": "b"}')

    def ask(s):
        llm.invoke("q", ls_structured_output_format={"schema": Verdict, "kwargs": {"method": "json_schema"}})
        return {}

    with testing.capture() as spans:
        linear(("ask", ask)).invoke({"q": "x"})
    schema = json.loads(attrs(by_kind(spans, "chat")[0])["agentlab.request.json_schema"])
    assert schema["title"] == "Verdict" and set(schema["properties"]) == {"category", "rationale"}


def test_a_model_call_inside_a_nested_runnable_still_belongs_to_the_node():
    llm = model("x")
    chain = RunnableLambda(lambda q: q) | llm

    def ask(s):
        chain.invoke("q")
        return {}

    with testing.capture() as spans:
        linear(("ask", ask)).invoke({"q": "x"})
    assert attrs(by_kind(spans, "chat")[0])["agentlab.node"] == "ask"


def test_llm_spans_off_keeps_nodes_and_drops_chat():
    llm = model("x")
    with testing.capture() as spans:
        linear(("ask", lambda s: {"out": llm.invoke("q").content}), llm_spans=False).invoke({"q": "x"})
    assert by_kind(spans, "chat") == [] and len(by_kind(spans, "node")) == 1


def test_capture_content_off_sends_no_content():
    llm = model("secret answer")
    with testing.capture(capture_content=False) as spans:
        linear(("ask", lambda s: {"out": llm.invoke("secret question").content})).invoke({"q": "secret"})
    for s in spans:
        assert "secret" not in json.dumps(dict(s.attributes or {}))
    assert attrs(by_kind(spans, "run")[0])["agentlab.content_mode"] == "absent"


# ---- tool calls

@tool
def lookup(term: str) -> str:
    """Look a term up."""
    return f"definition of {term}"


def test_a_tool_call_is_an_execute_tool_span_under_its_node():
    def act(s):
        return {"out": lookup.invoke({"term": "otel"})}

    with testing.capture() as spans:
        linear(("act", act)).invoke({"q": "x"})
    (t,) = by_kind(spans, "tool")
    a = attrs(t)
    assert t.name == "execute_tool lookup" and parent_of(t, spans) is node_span(spans, "act")
    assert a["gen_ai.operation.name"] == "execute_tool" and a["gen_ai.tool.name"] == "lookup"
    assert json.loads(a["gen_ai.tool.call.arguments"]) == {"term": "otel"}
    assert a["gen_ai.tool.call.result"] == "definition of otel"


def test_toolnode_tool_calls_land_on_the_tools_node():
    from langgraph.prebuilt import ToolNode

    class M(TypedDict):
        messages: list

    call = AIMessage(content="", tool_calls=[{"name": "lookup", "args": {"term": "x"}, "id": "call-1"}])
    g = StateGraph(M)
    g.add_node("tools", ToolNode([lookup]))
    g.add_edge(START, "tools")
    g.add_edge("tools", END)
    with testing.capture() as spans:
        instrument(g.compile(), app=APP).invoke({"messages": [call]})
    (t,) = by_kind(spans, "tool")
    assert attrs(t)["agentlab.node"] == "tools" and attrs(t)["gen_ai.tool.call.id"] == "call-1"


# ---- facts

def test_facts_land_on_the_node_that_made_them_with_no_ids():
    def decide(s):
        lab.decision("the handbook covers it", cited=["sec-2"])
        RunnableLambda(lambda _: lab.check("inner", True)).invoke(None)     # a nested runnable
        return {"route": "yes"}

    def route(s) -> Literal["yes", "no"]:
        lab.event("routed", {"to": s["route"]})        # routers run inside their node's task
        return s["route"]

    g = StateGraph(S)
    g.add_node("decide", decide)
    g.add_node("yes", lambda s: lab.outcome("done") or {})
    g.add_node("no", lambda s: {})
    g.add_edge(START, "decide")
    g.add_conditional_edges("decide", route)
    with testing.capture() as spans:
        instrument(g.compile(), app=APP).invoke({"q": "x"})
    decide_span = node_span(spans, "decide")
    assert events(decide_span, "agentlab.decision") == [
        {"agentlab.decision.reason": "the handbook covers it", "agentlab.decision.cited": ("sec-2",)}]
    assert [e["agentlab.check.name"] for e in events(decide_span, "agentlab.check")] == ["inner"]
    assert [e["agentlab.event.type"] for e in events(decide_span, "agentlab.event")] == ["routed"]
    assert attrs(by_kind(spans, "run")[0])["agentlab.run.outcome"] == "done"


def test_parallel_branches_keep_their_own_facts():
    barrier = threading.Barrier(2, timeout=5)

    def worker(name):
        def fn(s):
            barrier.wait()                     # both run at once, on different threads
            lab.check(name, True)
            return {}
        return fn

    g = StateGraph(S)
    g.add_node("start", lambda s: {})
    g.add_node("left", worker("left"))
    g.add_node("right", worker("right"))
    g.add_node("join", lambda s: {})
    g.add_edge(START, "start")
    g.add_edge("start", "left")
    g.add_edge("start", "right")
    g.add_edge(["left", "right"], "join")
    g.add_edge("join", END)
    with testing.capture() as spans:
        instrument(g.compile(), app=APP).invoke({"q": "x"})
    for name in ("left", "right"):
        assert [e["agentlab.check.name"] for e in events(node_span(spans, name), "agentlab.check")] == [name]


def test_concurrent_invokes_never_mix():
    graph = linear(("work", lambda s: lab.check(s["q"], True) or {}))
    with testing.capture() as spans:
        threads = [threading.Thread(target=graph.invoke, args=({"q": f"q{i}"}, {"configurable": {"thread_id": f"t{i}"}}))
                   for i in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
    runs = {attrs(r)["agentlab.thread"]: attrs(r)["agentlab.run"] for r in by_kind(spans, "run")}
    assert len(runs) == 8
    for n in by_kind(spans, "node"):
        (check,) = events(n, "agentlab.check")
        thread = "t" + check["agentlab.check.name"][1:]
        assert attrs(n)["agentlab.run"] == runs[thread]


def test_async_graph_end_to_end():
    llm = model("async reply")

    async def ask(s):
        lab.decision("async reason")
        reply = await llm.ainvoke("q")
        return {"out": reply.content}

    g = StateGraph(S)
    g.add_node("ask", ask)
    g.add_edge(START, "ask")
    g.add_edge("ask", END)
    with testing.capture() as spans:
        asyncio.run(instrument(g.compile(), app=APP).ainvoke({"q": "x"}))
    ask_span = node_span(spans, "ask")
    assert events(ask_span, "agentlab.decision")[0]["agentlab.decision.reason"] == "async reason"
    assert parent_of(by_kind(spans, "chat")[0], spans) is ask_span


def test_subgraph_nodes_are_nested_and_attributed():
    sub = StateGraph(S)
    sub.add_node("inner", lambda s: lab.check("inside", True) or {})
    sub.add_edge(START, "inner")
    sub.add_edge("inner", END)
    g = StateGraph(S)
    g.add_node("outer", sub.compile())
    g.add_edge(START, "outer")
    g.add_edge("outer", END)
    with testing.capture() as spans:
        instrument(g.compile(), app=APP).invoke({"q": "x"})
    inner = node_span(spans, "outer/inner")
    assert parent_of(inner, spans) is node_span(spans, "outer")
    assert events(inner, "agentlab.check")[0]["agentlab.check.name"] == "inside"


# ---- gates, pause and resume

def gate_graph(checkpointer):
    def propose(s):
        return {"out": "delete the repo"}

    def approve(s):
        answer = interrupt({"action": s["out"]})
        lab.gate_resolved(answer == "yes", by={"name": "Dana"})
        return {"route": answer}

    g = StateGraph(S)
    g.add_node("propose", propose)
    g.add_node("approve", approve)
    g.add_node("act", lambda s: {})
    g.add_edge(START, "propose")
    g.add_edge("propose", "approve")
    g.add_conditional_edges("approve", lambda s: "approved" if s["route"] == "yes" else "denied",
                            {"approved": "act", "denied": END})
    g.add_edge("act", END)
    return instrument(g.compile(checkpointer=checkpointer), app=APP)


def test_interrupt_pauses_the_run_and_resume_continues_it():
    graph = gate_graph(InMemorySaver())
    cfg = {"configurable": {"thread_id": "gate-1"}}
    with testing.capture() as spans:
        graph.invoke({"q": "x"}, cfg)
        first = list(spans)
        graph.invoke(Command(resume="yes"), cfg)
    (paused,) = by_kind(first, "run")
    assert attrs(paused)["agentlab.run.status"] == "paused"
    assert "agentlab.run.output" not in attrs(paused)
    gate = node_span(first, "approve")
    assert gate.status.status_code.name == "UNSET"
    assert [json.loads(e["agentlab.gate.proposed"]) for e in events(gate, "agentlab.gate.waiting")] == [
        {"action": "delete the repo"}]
    runs = by_kind(spans, "run")
    assert len(runs) == 2
    resumed = attrs(runs[1])
    assert resumed["agentlab.run"] == attrs(paused)["agentlab.run"] and resumed["agentlab.run.resume"] is True
    assert resumed["agentlab.run.status"] == "ok" and "agentlab.run.input" not in resumed
    second_gate = [s for s in by_kind(spans[len(first):], "node") if attrs(s)["agentlab.node"] == "approve"]
    assert events(second_gate[0], "agentlab.gate.resolved") == [{"agentlab.gate.approved": True, "agentlab.gate.by": "Dana"}]
    assert len(by_kind(spans, "manifest")) == 2                      # every invoke carries the map


def test_a_fresh_input_on_the_same_thread_is_a_new_run():
    graph = linear(("only", lambda s: {}), checkpointer=InMemorySaver())
    cfg = {"configurable": {"thread_id": "same"}}
    with testing.capture() as spans:
        graph.invoke({"q": "1"}, cfg)
        graph.invoke({"q": "2"}, cfg)
        graph.invoke(Command(update={"q": "3"}), cfg)       # an update alone is a fresh input
    ids = [attrs(r)["agentlab.run"] for r in by_kind(spans, "run")]
    assert len(set(ids)) == 3


def test_an_interrupt_inside_a_subgraph_is_reported_once():
    sub = StateGraph(S)
    sub.add_node("ask", lambda s: {"out": interrupt("ok?")})
    sub.add_edge(START, "ask")
    sub.add_edge("ask", END)
    g = StateGraph(S)
    g.add_node("outer", sub.compile())
    g.add_edge(START, "outer")
    g.add_edge("outer", END)
    with testing.capture() as spans:
        instrument(g.compile(checkpointer=InMemorySaver()), app=APP).invoke({"q": "x"}, {"configurable": {"thread_id": "s"}})
    waiting = [(attrs(s)["agentlab.node"], e) for s in spans for e in events(s, "agentlab.gate.waiting")]
    assert [node for node, _ in waiting] == ["outer/ask"]
    assert node_span(spans, "outer").status.status_code.name == "UNSET"
    assert attrs(by_kind(spans, "run")[0])["agentlab.run.status"] == "paused"


def test_a_static_breakpoint_pauses_and_none_resumes():
    g = StateGraph(S)
    g.add_node("a", lambda s: {})
    g.add_node("b", lambda s: {})
    g.add_edge(START, "a")
    g.add_edge("a", "b")
    g.add_edge("b", END)
    graph = instrument(g.compile(checkpointer=InMemorySaver(), interrupt_before=["b"]), app=APP)
    cfg = {"configurable": {"thread_id": "bp"}}
    with testing.capture() as spans:
        graph.invoke({"q": "x"}, cfg)
        graph.invoke(None, cfg)
    first, second = (attrs(r) for r in by_kind(spans, "run"))
    assert first["agentlab.run.status"] == "paused"
    assert second["agentlab.run.resume"] is True and second["agentlab.run"] == first["agentlab.run"]
    assert second["agentlab.run.status"] == "ok"


RESUME_SCRIPT = textwrap.dedent("""
    import json, sys
    from langgraph.checkpoint.sqlite import SqliteSaver
    from langgraph.types import Command
    from agentlab import testing
    sys.path.insert(0, {tests!r})
    from test_langgraph_runtime import gate_graph
    with SqliteSaver.from_conn_string({db!r}) as saver, testing.capture() as spans:
        graph = gate_graph(saver)
        cfg = {{"configurable": {{"thread_id": "durable"}}}}
        if sys.argv[1] == "start":
            graph.invoke({{"q": "x"}}, cfg)
        else:
            graph.invoke(Command(resume="yes"), cfg)
        run = [s for s in spans if (s.attributes or {{}}).get("agentlab.kind") == "run"][0]
        print(json.dumps(dict(run.attributes)))
""")


def test_a_resume_in_a_fresh_process_is_marked_for_the_bench_to_join(tmp_path):
    """Pause in one process, resume from SQLite in another (as the helpdesk's durable-resume test
    does): the new process can't know the old run id, so it mints one and marks it a resume (A3)."""
    from pathlib import Path
    script = tmp_path / "durable.py"
    script.write_text(RESUME_SCRIPT.format(tests=str(Path(__file__).parent), db=str(tmp_path / "cp.sqlite")))

    def run(arg):
        out = subprocess.run([sys.executable, str(script), arg], capture_output=True, text=True, timeout=120)
        assert out.returncode == 0, out.stderr
        return json.loads(out.stdout.strip().splitlines()[-1])

    first, second = run("start"), run("resume")
    assert first["agentlab.run.status"] == "paused" and first["agentlab.run.resume"] is False
    assert second["agentlab.run.resume"] is True and second["agentlab.run.status"] == "ok"
    assert second["agentlab.run"] != first["agentlab.run"]
    assert second["agentlab.run"].startswith("durable:") and second["agentlab.thread"] == "durable"


# ---- off, shared mode, robustness

def test_off_the_graph_runs_and_nothing_is_recorded():
    assert not _state.STATE.enabled
    graph = linear(("ask", lambda s: lab.check("c", True) or {"out": model("x").invoke("q").content}))
    assert graph.invoke({"q": "x"})["out"] == "x"
    handler = graph.config["callbacks"][0]
    assert handler._runs == {} and handler._calls == {}


def test_shared_provider_stamps_another_instrumentors_span_inside_a_node():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    lab.init("off", tracer_provider=provider)

    def fetch(s):
        provider.get_tracer("httpx").start_span("GET /status").end()
        return {}

    linear(("fetch", fetch)).invoke({"q": "x"})
    spans = {s.name: s for s in exporter.get_finished_spans()}
    stamped = attrs(spans["GET /status"])
    assert stamped["agentlab.node"] == "fetch" and stamped["agentlab.app"] == "runtime"
    assert stamped["agentlab.run"] == attrs(spans["agentlab.run runtime"])["agentlab.run"]


def test_a_failure_inside_agent_lab_never_reaches_the_app(monkeypatch, caplog):
    def broken(*a, **k):
        raise RuntimeError("agent lab bug")

    monkeypatch.setattr("agentlab.langgraph.record_chat", broken)
    monkeypatch.setattr(_runtime.Run, "open_node", broken)
    with testing.capture() as spans, caplog.at_level(logging.WARNING):
        out = linear(("ask", lambda s: {"out": model("fine").invoke("q").content})).invoke({"q": "x"})
    assert out["out"] == "fine"
    assert attrs(by_kind(spans, "run")[0])["agentlab.run.status"] == "ok"
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING and "agentlab" in r.name]


def test_the_handlers_bookkeeping_is_empty_after_runs():
    graph = gate_graph(InMemorySaver())
    handler = next(h for h in graph.config["callbacks"])
    with testing.capture():
        graph.invoke({"q": "x"}, {"configurable": {"thread_id": "k"}})
        graph.invoke(Command(resume="no"), {"configurable": {"thread_id": "k"}})
        with pytest.raises(ValueError):
            linear(("x", lambda s: (_ for _ in ()).throw(ValueError("x")))).invoke({"q": "x"})
    assert handler._runs == {} and handler._calls == {}


def test_spans_are_read_by_todays_bench_adapter():
    """Level 0 compatibility: the bench doesn't read agentlab.* yet, but every chat and tool span
    is standard GenAI, so today's reader already turns a run into valid events."""
    from test_testing import bench_adapter
    from jsonschema import Draft202012Validator
    from conftest import EVENT_SCHEMA

    llm = model("answer", usage={"input_tokens": 5, "output_tokens": 2, "total_tokens": 7})

    def ask(s):
        lookup.invoke({"term": "x"})
        return {"out": llm.invoke("q").content}

    with testing.capture() as spans:
        linear(("ask", ask)).invoke({"q": "x"})
    events_ = bench_adapter().convert(testing.to_otlp_json(spans))
    validator = Draft202012Validator(json.loads(EVENT_SCHEMA.read_text()))
    assert all(not list(validator.iter_errors(e)) for e in events_)
    kinds = {e["event_type"] for e in events_}
    assert {"llm_call", "tool_call"} <= kinds


def test_an_async_interrupt_pauses_and_resumes_the_same_run():
    async def approve(s):
        answer = interrupt("ok?")
        return {"out": answer}

    g = StateGraph(S)
    g.add_node("approve", approve)
    g.add_edge(START, "approve")
    g.add_edge("approve", END)
    graph = instrument(g.compile(checkpointer=InMemorySaver()), app=APP)
    cfg = {"configurable": {"thread_id": "async-gate"}}

    async def both():
        await graph.ainvoke({"q": "x"}, cfg)
        await graph.ainvoke(Command(resume="yes"), cfg)

    with testing.capture() as spans:
        asyncio.run(both())
    first, second = (attrs(r) for r in by_kind(spans, "run"))
    assert first["agentlab.run.status"] == "paused" and second["agentlab.run.status"] == "ok"
    assert second["agentlab.run"] == first["agentlab.run"]
    assert len([e for s in spans for e in events(s, "agentlab.gate.waiting")]) == 1


# ---- other callback handlers (A11 check 1, the generic half; the helpdesk half is its own step)

def test_another_handler_at_invoke_does_not_hide_model_calls():
    from langchain_core.callbacks import BaseCallbackHandler

    class Other(BaseCallbackHandler):          # e.g. Langfuse's LangChain handler
        def __init__(self):
            self.chats = 0

        def on_chat_model_start(self, *a, **k):
            self.chats += 1

    other = Other()
    llm = model("x")
    with testing.capture() as spans:
        linear(("ask", lambda s: {"out": llm.invoke("q").content})).invoke({"q": "x"}, {"callbacks": [other]})
    assert other.chats == 1 and attrs(by_kind(spans, "chat")[0])["agentlab.node"] == "ask"


def test_explicit_callbacks_inside_a_node_replace_the_runs_and_hide_that_call():
    """Pinned so the SPEC's warning stays true: LangChain's ensure_config replaces, not merges."""
    from langchain_core.callbacks import BaseCallbackHandler
    llm = model("x")
    with testing.capture() as spans:
        linear(("ask", lambda s: {"out": llm.invoke("q", config={"callbacks": [BaseCallbackHandler()]}).content})).invoke({"q": "x"})
    assert by_kind(spans, "chat") == [] and len(by_kind(spans, "node")) == 1


def test_a_stream_abandoned_midway_still_closes_its_spans():
    graph = linear(("one", lambda s: {"out": "1"}), ("two", lambda s: {"out": "2"}), ("three", lambda s: {"out": "3"}))
    handler = graph.config["callbacks"][0]
    with testing.capture() as spans:
        stream = graph.stream({"q": "x"}, stream_mode="updates")
        next(stream)
        stream.close()
    assert handler._runs == {} and handler._calls == {}
    assert len(by_kind(spans, "run")) == 1
    assert all(s.end_time for s in spans)


def test_streaming_a_graph_records_the_same_spans_as_invoke():
    graph = linear(("one", lambda s: lab.check("c", True) or {}), ("two", lambda s: {}))
    with testing.capture() as spans:
        list(graph.stream({"q": "x"}))
    assert [attrs(n)["agentlab.node"] for n in by_kind(spans, "node")] == ["one", "two"]
    assert attrs(by_kind(spans, "run")[0])["agentlab.run.status"] == "ok"

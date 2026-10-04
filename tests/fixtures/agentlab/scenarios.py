"""Agent Lab runs as the `agentlab` library writes them, for the bench's tests.

Run in the library's environment, not the bench's (the bench doesn't depend on the library):

    uv run --quiet --project sdk/python python tests/fixtures/agentlab/scenarios.py <out_dir>

Writes `<out_dir>/scenarios.json`: {name: {"batches": [<OTLP/JSON body>, ...], ...facts}} and the
story file one scenario names. The bench's tests generate this on every run instead of reading
checked-in captures, so the bench is always tested against what the library writes today: a
library change that the bench doesn't read fails here, not on someone's screen.

Runs are driven through the library's runtime by hand (start_run / open_node / facts), the seam the
LangGraph integration builds on, so these don't need LangGraph installed.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

import agentlab as lab
from agentlab import _corpora, _runtime, testing
from agentlab._context import activate
from agentlab.manifest import BranchSpec, Instrumentation, NodeSpec, Structure

HANDBOOK = [("sec-1", "1. Passwords"), ("sec-2", "2. Laptops"), ("sec-3", "3. Access requests")]
TEXT = {"sec-1": "Reset your password at the self-service portal; IT never asks for it.",
        "sec-2": "Laptops are replaced every three years by the hardware team.",
        "sec-3": "Access to a system needs the system owner's approval in the request form."}


@lab.step("Look up the handbook", actor="rule", kind="retrieval")
def retrieve(state):
    """Search the handbook."""


@lab.step("Decide what kind of request", actor="ai", moment=True,
          paths={"answerable": lab.path("it can answer"), "needs_write": "needs a change",
                 "out_of_scope": "not for IT"})
def classify(state):
    """Classify with the model."""


@lab.step("Check the answer", actor="rule", not_needed="Not needed this time.")
def grounding_check(state):
    """Every claim cites a section."""


def respond(state):
    pass


def handoff(state):
    pass


@lab.step("A person approves", actor="person")
def approval_gate(state):
    """Waits for a person."""


def execute_action(state):
    pass


def route(state):
    return state


def instrumentation(story: Path | None = None) -> Instrumentation:
    s = Structure(
        nodes=[NodeSpec("retrieve", retrieve), NodeSpec("classify", classify),
               NodeSpec("grounding_check", grounding_check), NodeSpec("respond", respond),
               NodeSpec("handoff", handoff), NodeSpec("approval_gate", approval_gate),
               NodeSpec("execute_action", execute_action)],
        edges=[("__start__", "retrieve"), ("retrieve", "classify"), ("respond", "__end__"),
               ("handoff", "__end__"), ("execute_action", "respond")],
        branches=[BranchSpec("classify", {"answerable": "grounding_check", "needs_write": "approval_gate",
                                          "out_of_scope": "handoff"}, route),
                  BranchSpec("grounding_check", {"grounded": "respond", "not_grounded": "handoff"}, route),
                  BranchSpec("approval_gate", {"approved": "execute_action", "denied": "handoff"}, route)],
        source="langgraph", framework="langgraph (scenario)")
    kw = {}
    if story is not None:
        kw["story"] = lab.Story(file=story, panels=[lab.Panel(id="classify", title="Classification",
                                                               event_types=["decision"], nodes=["classify"])])
    return Instrumentation(s, app=lab.App(name="Helpdesk (scenario)", id="helpdesk-scenario",
                                          baseline="~10 minutes"), **kw)


def register_handbook(items=HANDBOOK):
    lab.corpus("handbook", title="IT handbook", items=items, description="The only pages it reads.")


def answer_run(inst, *, run_id="t1:aaaa0001", thread="t1", parent=None, redacted=False,
               cited=("sec-1",), branch=None, stale=False):
    """retrieve -> classify -> grounding_check -> respond, finished."""
    run = _runtime.start_run(app_id=inst.app_id(), run_id=run_id, manifest=inst.manifest_doc(),
                             thread=thread, input={"text": "How do I reset my password?"},
                             session_id="sess-1", parent=parent)
    n = run.open_node("retrieve", step=1)
    with activate(run.target(n, "retrieve")):
        if stale:  # the index is rebuilt after the run's map was taken: the search ran on another version
            register_handbook(HANDBOOK + [("sec-4", "4. Printers")])
        lab.retrieved("handbook", [{"id": "sec-1", "title": "1. Passwords", "score": 0.9, "text": TEXT["sec-1"]},
                                   {"id": "sec-3", "title": "3. Access requests", "score": 0.4, "text": TEXT["sec-3"]}],
                      query="reset password")
    run.end_node(n)
    n = run.open_node("classify", step=2)
    t = run.target(n, "classify")
    with activate(t):
        _runtime.record_chat(t, model="claude-test", provider="anthropic", input_tokens=120, output_tokens=20,
                             cache_read=100, system="Answer from the handbook only.\n\n" + TEXT["sec-1"],
                             messages=[{"role": "user", "content": "How do I reset my password?"}],
                             output='{"category": "answerable"}',
                             json_schema={"type": "object", "properties": {"category": {"enum": ["answerable", "needs_write"]}}})
        lab.decision("The handbook covers password resets.", cited=list(cited), confidence=0.9,
                     **({"branch": branch} if branch else {}))
        lab.check("unsure", True, detail="confidence 0.90", words={"passed": "Sure enough", "failed": "Sent to a person"})
    run.end_node(n)
    n = run.open_node("grounding_check", step=3)
    with activate(run.target(n, "grounding_check")):
        lab.check("grounding", True, evidence=["sec-1"], kind="grounding")
    run.end_node(n)
    n = run.open_node("respond", step=4)
    with activate(run.target(n, "respond")):
        lab.outcome("answered")
    run.end_node(n)
    run.finish(output={"reply": "Use the self-service portal."})
    return run


def gate_pause(inst, run_id, thread):
    run = _runtime.start_run(app_id=inst.app_id(), run_id=run_id, manifest=inst.manifest_doc(),
                             thread=thread, input={"text": "Give me access to Compass"}, session_id="sess-2")
    n = run.open_node("classify", step=1)
    with activate(run.target(n, "classify")):
        lab.decision("Needs a new access grant.", cited=["sec-3"])
    run.end_node(n)
    n = run.open_node("approval_gate", step=2)
    run.gate_waiting(n, {"action_type": "create_ticket", "title": "Access to Compass"})
    run.end_node(n)
    run.finish()


def gate_resume(inst, run_id, thread):
    run = _runtime.start_run(app_id=inst.app_id(), run_id=run_id, manifest=inst.manifest_doc(),
                             thread=thread, resume=True, input={"approved": True}, session_id="sess-2")
    n = run.open_node("approval_gate", step=2)
    with activate(run.target(n, "approval_gate")):
        lab.gate_resolved(True, by={"name": "Dana (IT lead)"})
    run.end_node(n)
    n = run.open_node("execute_action", step=3)
    with activate(run.target(n, "execute_action")):
        lab.event("ticket_opened", {"ticket": "REQ-1"})
        lab.outcome("executed")
    run.end_node(n)
    run.finish(output={"reply": "Opened REQ-1."})


def body(spans):
    return testing.to_otlp_json(spans)


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    story = out / "helpdesk-scenario.story.js"
    story.write_text("BenchStory.register('helpdesk-scenario', {panels: {classify: function () { return 'story'; }}});\n")
    result: dict = {}
    register_handbook()

    with testing.capture(service_name="helpdesk-svc") as spans:
        inst = instrumentation(story)
        answer_run(inst)
    result["answer"] = {"batches": [body(spans)], "map_hash": inst.manifest_doc().hash,
                        "manifest": json.loads(inst.manifest_doc().json)}
    # The same run, one POST per span in the order spans end: the map first, the run span last.
    result["answer_split"] = {"batches": [body([s]) for s in spans]}

    with testing.capture() as spans:
        inst = instrumentation()
        # The run span's parent is the app's own span on another provider: it never reaches the bench.
        other = TracerProvider().get_tracer("app")
        with other.start_as_current_span("POST /slack/events") as http:
            answer_run(inst, parent=trace.set_span_in_context(http))
    result["foreign_parent"] = {"batches": [body(spans)]}

    with testing.capture(redact=lambda v: "[redacted]" if isinstance(v, str) else v) as spans:
        answer_run(instrumentation())
    result["redacted"] = {"batches": [body(spans)]}

    with testing.capture() as spans:
        answer_run(instrumentation(), cited=("sec-1", "sec-9"), branch="no_such_branch")
    result["bad_facts"] = {"batches": [body(spans)]}

    with testing.capture() as spans:
        answer_run(instrumentation(), stale=True)
    result["stale_index"] = {"batches": [body(spans)]}
    register_handbook()

    with testing.capture() as spans:
        inst = instrumentation()
        gate_pause(inst, "t2:bbbb0002", "t2")
        paused = len(spans)
        gate_resume(inst, "t2:bbbb0002", "t2")  # same process: the same run id
    result["gate"] = {"batches": [body(spans[:paused]), body(spans[paused:])]}

    with testing.capture() as spans:
        inst = instrumentation()
        gate_pause(inst, "t3:cccc0003", "t3")
        paused = len(spans)
        gate_resume(inst, "t3:dddd0004", "t3")  # a new process: a fresh id, marked as a resume
    result["gate_new_process"] = {"batches": [body(spans[:paused]), body(spans[paused:])]}

    with testing.capture() as spans:
        inst = instrumentation()
        run = _runtime.start_run(app_id=inst.app_id(), run_id="t5:eeee0005", manifest=inst.manifest_doc())
        n = run.open_node("classify")
        with activate(run.target(n, "classify")):
            # Another instrumentor's model call inside the node, stamped by Agent Lab's processor.
            tracer = testing._state.STATE.provider.get_tracer("openinference.instrumentation.langchain")
            with tracer.start_as_current_span("ChatAnthropic", attributes={
                    "gen_ai.operation.name": "chat", "gen_ai.request.model": "claude-x",
                    "gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 1}):
                pass
        run.end_node(n)
        run.finish()
    result["stamped"] = {"batches": [body(spans)]}

    result.update(langgraph_scenarios())
    (out / "scenarios.json").write_text(json.dumps(result))
    _corpora.clear()


# The real LangGraph integration, when installed. Module level: LangGraph reads these functions'
# type hints, which `from __future__ import annotations` leaves as names to look up here.
try:
    from typing import Literal, TypedDict

    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import END, START, StateGraph
    from langgraph.types import Command, interrupt

    from agentlab.langgraph import instrument
except ImportError:  # the bench's tests that need these skip
    instrument = None
else:
    class GateState(TypedDict, total=False):
        ok: bool

    @lab.step("Decide", actor="ai")
    def lg_decide(state: GateState) -> GateState:
        lab.decision("needs a person's approval")
        return {}

    @lab.step("A person approves", actor="person")
    def lg_gate(state: GateState) -> GateState:
        ok = interrupt({"action_type": "create_ticket", "title": "Access to Compass"})
        lab.gate_resolved(bool(ok), by="Dana (IT lead)")
        return {"ok": bool(ok)}

    def lg_route(state: GateState) -> Literal["approved", "denied"]:
        return "approved" if state.get("ok") else "denied"

    def lg_act(state: GateState) -> GateState:
        lab.outcome("executed")
        return {}

    def lg_stop(state: GateState) -> GateState:
        return {}


def langgraph_scenarios() -> dict:
    """The same, through the real LangGraph integration (`agentlab.langgraph.instrument`): the
    repo's quickstart app, and a graph that pauses at a real `interrupt()` and is resumed. Absent
    (and the bench's tests that need them skip) when LangGraph or the integration isn't installed."""
    if instrument is None:
        return {}
    out: dict = {}
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "examples" / "langgraph_quickstart"))
    try:
        from support_bot.graph import build_graph
    except ImportError:
        build_graph = None
    if build_graph is not None:
        with testing.capture() as spans:
            build_graph().invoke({"question": "How do I reset my password?"}, {"configurable": {"thread_id": "q1"}})
        out["lg_quickstart"] = {"batches": [body(spans)]}

    b = StateGraph(GateState)
    for name, fn in (("decide", lg_decide), ("gate", lg_gate), ("act", lg_act), ("stop", lg_stop)):
        b.add_node(name, fn)
    b.add_edge(START, "decide")
    b.add_edge("decide", "gate")
    b.add_conditional_edges("gate", lg_route, {"approved": "act", "denied": "stop"})
    b.add_edge("act", END)
    b.add_edge("stop", END)
    with testing.capture() as spans:
        graph = instrument(b.compile(checkpointer=InMemorySaver()), app=lab.App(name="Gate demo", id="gate-demo"))
        cfg = {"configurable": {"thread_id": "g1"}}
        graph.invoke({}, cfg)
        paused = len(spans)
        graph.invoke(Command(resume=True), cfg)
    out["lg_gate"] = {"batches": [body(spans[:paused]), body(spans[paused:])]}
    return out


if __name__ == "__main__":
    main(Path(sys.argv[1]))

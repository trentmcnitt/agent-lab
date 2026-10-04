"""Agent Lab off: every helper is a silent no-op, nothing raises, nothing is exported."""
import logging

import pytest
from opentelemetry import trace

import agentlab as lab
from agentlab import _state, testing

HELPERS = [
    lambda: lab.decision("because", cited=["a"], branch="x", confidence=0.5),
    lambda: lab.check("grounded", True, detail="ok", evidence=["a"], words={"passed": "fine"}),
    lambda: lab.gate_waiting({"do": "it"}, reason="needs a person"),
    lambda: lab.gate_resolved(True, by="ann"),
    lambda: lab.outcome("executed"),
    lambda: lab.event("permission_verdict", {"allowed": True}),
    lambda: lab.retrieved("handbook", [{"id": "s1", "text": "x"}], query="q"),
]


@pytest.mark.parametrize("call", HELPERS)
def test_helpers_are_noops_when_off(call):
    assert _state.STATE.enabled is False
    assert call() is None


GARBAGE = [
    lambda: lab.decision(object(), cited=12345, branch=object(), confidence="high"),
    lambda: lab.check(None, "yes"),
    lambda: lab.check("x", None, evidence=object(), words=["not", "a", "mapping"]),
    lambda: lab.gate_resolved("maybe", by=object()),
    lambda: lab.outcome(None),
    lambda: lab.event(None, None),
    lambda: lab.event("t", "not a mapping"),
    lambda: lab.retrieved(None, None),
    lambda: lab.retrieved("c", [None, 3, {"no": "id"}, {"id": object(), "score": float("nan")}]),
    lambda: lab.corpus(None, title=None, items=None),
    lambda: lab.corpus("c", title="t", items=[None, (1,), {"title": "no id"}]),
]


@pytest.mark.parametrize("call", GARBAGE)
def test_helpers_never_raise_on_garbage_when_on(call):
    with testing.capture():
        with trace.get_tracer("t").start_as_current_span("app"):
            assert call() is None


@pytest.mark.parametrize("call", GARBAGE)
def test_helpers_never_raise_on_garbage_when_off(call):
    assert call() is None


def test_outside_any_span_facts_are_dropped_with_one_debug_line(caplog):
    caplog.set_level(logging.DEBUG, logger="agentlab")
    with testing.capture() as spans:
        for _ in range(5):
            lab.decision("x")
    assert spans == []
    lines = [r for r in caplog.records if "decision" in r.getMessage()]
    assert len(lines) == 1


def test_fact_on_the_current_otel_span_outside_a_run():
    with testing.capture() as spans:
        tracer = _state.STATE.tracer
        with trace.use_span(tracer.start_span("app work"), end_on_exit=True):
            lab.check("format", False, detail="bad json")
    (span,) = spans
    assert [e.name for e in span.events] == ["agentlab.check"]


def test_step_returns_the_function_unchanged():
    def classify(state):
        """Reads the message."""
        return {"x": 1}

    decorated = lab.step("Decide", actor="ai")(classify)
    assert decorated is classify
    assert decorated({}) == {"x": 1}
    assert classify.__agentlab_step__.label == "Decide"


def test_step_on_something_that_cant_hold_attributes_never_raises():
    bound = (1).bit_length       # a builtin method: no __dict__
    assert lab.step("x")(bound) is bound


def test_step_with_bad_paths_never_raises():
    words = lab.step("x", paths=42)
    assert words.paths == {}


def test_init_off_by_env(monkeypatch):
    monkeypatch.setenv("AGENT_LAB_URL", "off")
    lab.init()
    assert _state.STATE.enabled is False
    lab.decision("x")


def test_corpus_records_even_before_init():
    """Indexes are often built before init(); their corpus must not be lost."""
    from agentlab import _corpora
    lab.corpus("handbook", title="Handbook", items=[("s1", "One")])
    assert _corpora.get("handbook").source["count"] == 1

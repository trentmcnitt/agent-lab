"""Content: redacted at emission, masked on the way out for other instrumentors, or absent."""
import json
import re

from opentelemetry import trace

import agentlab as lab
from agentlab import _runtime, _state, testing
from agentlab._context import activate
from conftest import attrs, by_kind, events

EMAIL = "jane.doe@example.com"


def redact(value):
    """Masks emails anywhere in a JSON-like value."""
    if isinstance(value, str):
        return re.sub(r"[\w.]+@[\w.]+", "<email>", value)
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def run_everything():
    lab.corpus("h", title="H", items=[("a", "A")])
    run = _runtime.start_run(app_id="a", run_id="r", input={"from": EMAIL})
    node = run.open_node("n")
    target = run.target(node, "n")
    with activate(target):
        lab.decision(f"asked by {EMAIL}")
        lab.check("c", True, detail=f"user {EMAIL}")
        lab.gate_waiting({"to": EMAIL}, reason=EMAIL)
        lab.gate_resolved(True, reason=EMAIL)
        lab.event("x", {"who": EMAIL})
        lab.retrieved("h", [{"id": "a", "text": f"mail {EMAIL}"}], query=EMAIL)
        _runtime.record_chat(target, model="m", system=f"sys {EMAIL}",
                             messages=[{"role": "user", "content": EMAIL}], output=EMAIL)
        # another instrumentor's span, as in shared mode
        other = trace.get_tracer("openinference").start_span(
            "llm", attributes={"input.value": json.dumps({"q": EMAIL}), "llm.input_messages.0.message.content": EMAIL,
                               "gen_ai.output.messages": EMAIL, "http.url": "https://x"})
        other.add_event("log", {"output.value": EMAIL})
        other.end()
    run.end_node(node)
    run.finish(output={"reply": EMAIL})


def everything(spans):
    out = []
    for s in spans:
        out += [str(v) for v in (s.attributes or {}).values()]
        for e in s.events:
            out += [str(v) for v in (e.attributes or {}).values()]
    return " ".join(out)


def test_no_unmasked_email_reaches_the_exporter():
    with testing.capture(redact=redact) as spans:
        tracer_provider = _state.STATE.provider
        trace_get = trace.get_tracer
        trace.get_tracer = lambda name, *a, **k: tracer_provider.get_tracer(name)   # shared-mode stand-in
        try:
            run_everything()
        finally:
            trace.get_tracer = trace_get
    text = everything(spans)
    assert EMAIL not in text
    assert text.count("<email>") >= 12
    run_span = by_kind(spans, "run")[0]
    assert attrs(run_span)["agentlab.content_mode"] == "redacted"
    other = next(s for s in spans if s.name == "llm")
    assert attrs(other)["http.url"] == "https://x"                     # non-content passes untouched
    assert json.loads(attrs(other)["input.value"]) == {"q": "<email>"}


def test_capture_content_false_emits_no_content():
    with testing.capture(capture_content=False) as spans:
        run_everything()
    text = everything([s for s in spans if s.instrumentation_scope.name == "agentlab"])
    assert EMAIL not in text
    assert attrs(by_kind(spans, "run")[0])["agentlab.content_mode"] == "absent"
    (chat,) = by_kind(spans, "chat")
    assert "gen_ai.input.messages" not in attrs(chat) and "gen_ai.system_instructions" not in attrs(chat)
    docs = json.loads(attrs(by_kind(spans, "retrieval")[0])["gen_ai.retrieval.documents"])
    assert docs == [{"id": "a"}]                                       # ids stay; text doesn't


def test_a_redact_that_raises_drops_the_value():
    def broken(value):
        raise RuntimeError("nope")

    with testing.capture(redact=broken) as spans:
        run_everything()
    assert EMAIL not in everything(spans)
    node = by_kind(spans, "node")[0]
    (ev,) = events(node, "agentlab.decision")
    assert "agentlab.decision.reason" not in ev

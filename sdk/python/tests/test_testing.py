"""testing.capture() restores state; to_otlp_json() is a body the bench reads today."""
import importlib.util
import json

from jsonschema import Draft202012Validator

import agentlab as lab
from agentlab import _runtime, _state, testing
from agentlab._context import activate
from conftest import BENCH, EVENT_SCHEMA


def test_capture_restores_the_previous_state():
    before = _state.STATE
    with testing.capture() as spans:
        assert _state.STATE is not before and _state.STATE.enabled
        _runtime.start_run(app_id="a", run_id="r").finish()
    assert _state.STATE is before
    assert len(spans) == 1


def bench_adapter():
    spec = importlib.util.spec_from_file_location("bench_otlp", BENCH / "adapters" / "otlp.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_otlp_json_is_read_by_the_bench_adapter():
    """The bench doesn't know agentlab.* yet (that is the bench step), but our spans are standard
    OTLP + GenAI: today's reader already turns them into valid bench events."""
    with testing.capture() as spans:
        run = _runtime.start_run(app_id="demo", run_id="r", input={"text": "hi"})
        node = run.open_node("classify")
        target = run.target(node, "classify")
        with activate(target):
            _runtime.record_chat(target, model="m", input_tokens=10, output_tokens=2,
                                 messages=[{"role": "user", "content": "hi"}], output="ok")
            lab.decision("because")
        run.end_node(node)
        run.finish()
    body = testing.to_otlp_json(spans)
    assert body["resourceSpans"][0]["scopeSpans"][0]["scope"]["name"] == "agentlab"
    json.dumps(body)                                             # plain JSON
    events = bench_adapter().convert(body)
    validator = Draft202012Validator(json.loads(EVENT_SCHEMA.read_text()))
    assert events and all(not list(validator.iter_errors(e)) for e in events)
    llm = [e for e in events if e["event_type"] == "llm_call"]
    assert llm and llm[0]["data"]["input_tokens"] == 10

"""The spans an integration makes through _runtime: names, parents, order, status, cost."""
import json

import pytest

from agentlab import _runtime, testing
from agentlab._context import activate
from agentlab._runtime import ManifestDoc, RunIds
from conftest import attrs, by_kind, events


def doc():
    body = json.dumps({"v": "bench-topology/0"}, sort_keys=True, separators=(",", ":"))
    return ManifestDoc(json=body, hash="h" * 64)


def test_run_manifest_node_spans_and_parents():
    with testing.capture() as spans:
        run = _runtime.start_run(app_id="helpdesk", run_id="t1:abcd1234", manifest=doc(), thread="t1",
                                 input={"text": "hi"}, session_id="s-1")
        node = run.open_node("classify", step=2, ns="classify:uuid")
        run.end_node(node)
        run.finish(output={"reply": "done"})
    names = [s.name for s in spans]
    assert names == ["agentlab.manifest", "node classify", "agentlab.run helpdesk"]
    manifest, node_span, run_span = spans
    # the manifest ends first, so it ships in the run's first export batch
    assert manifest.parent.span_id == run_span.context.span_id
    assert node_span.parent.span_id == run_span.context.span_id
    assert attrs(manifest)["agentlab.manifest"] == doc().json
    assert attrs(manifest)["agentlab.manifest.hash"] == doc().hash
    # the run-level facts the bench needs before the run span (exported last) arrives; no content
    m = attrs(manifest)
    assert m["agentlab.thread"] == "t1" and m["agentlab.run.resume"] is False and m["session.id"] == "s-1"
    assert m["agentlab.content_mode"] == "full" and "agentlab.run.input" not in m
    a = attrs(run_span)
    assert a["agentlab.manifest.hash"] == doc().hash and "agentlab.manifest" not in a
    assert a["agentlab.kind"] == "run" and a["agentlab.app"] == "helpdesk" and a["agentlab.run"] == "t1:abcd1234"
    assert a["agentlab.thread"] == "t1" and a["agentlab.run.resume"] is False and a["session.id"] == "s-1"
    assert a["agentlab.content_mode"] == "full" and a["agentlab.run.status"] == "ok"
    assert json.loads(a["agentlab.run.input"]) == {"text": "hi"}
    assert json.loads(a["agentlab.run.output"]) == {"reply": "done"}
    n = attrs(node_span)
    assert n["agentlab.node"] == "classify" and n["agentlab.step"] == 2 and n["agentlab.ns"] == "classify:uuid"
    assert n["agentlab.kind"] == "node"
    assert run_span.instrumentation_scope.name == "agentlab"


def test_paused_run_and_gate_waiting():
    with testing.capture() as spans:
        run = _runtime.start_run(app_id="a", run_id="r")
        node = run.open_node("approval_gate")
        run.gate_waiting(node, {"action": "create_ticket"})
        run.end_node(node)
        run.finish()
    node_span, run_span = spans
    assert attrs(run_span)["agentlab.run.status"] == "paused"
    (ev,) = events(node_span, "agentlab.gate.waiting")
    assert json.loads(ev["agentlab.gate.proposed"]) == {"action": "create_ticket"}
    assert node_span.status.status_code.name == "UNSET"


def test_error_run_and_node():
    with testing.capture() as spans:
        run = _runtime.start_run(app_id="a", run_id="r")
        node = run.open_node("n")
        run.end_node(node, error=ValueError("boom"))
        run.finish(error=ValueError("boom"))
    node_span, run_span = spans
    assert node_span.status.status_code.name == "ERROR"
    assert attrs(run_span)["agentlab.run.status"] == "error"


def test_subgraph_node_parent_is_its_container():
    with testing.capture() as spans:
        run = _runtime.start_run(app_id="a", run_id="r")
        outer = run.open_node("sub")
        inner = run.open_node("sub/inner", parent=outer)
        run.end_node(inner)
        run.end_node(outer)
        run.finish()
    inner_span, outer_span, _ = spans
    assert inner_span.parent.span_id == outer_span.context.span_id


def test_record_chat_attributes_and_estimated_cost():
    def price(model, inp, out, cr, cw):
        assert (model, inp, out, cr, cw) == ("claude-x", 1000, 100, 600, 0)
        return 0.0123

    with testing.capture(price=price, price_basis="test table 10-2026") as spans:
        run = _runtime.start_run(app_id="a", run_id="r")
        node = run.open_node("classify")
        _runtime.record_chat(run.target(node, "classify"), model="claude-x", provider="anthropic",
                             input_tokens=1000, output_tokens=100, cache_read=600, cache_write=0,
                             finish_reasons=["end_turn"], system="Be brief.",
                             messages=[{"role": "user", "content": "hi"}], output="hello",
                             json_schema={"type": "object"})
        run.end_node(node)
        run.finish()
    (chat,) = by_kind(spans, "chat")
    a = attrs(chat)
    assert chat.name == "chat claude-x"
    assert chat.parent.span_id == by_kind(spans, "node")[0].context.span_id
    assert a["gen_ai.operation.name"] == "chat" and a["gen_ai.provider.name"] == "anthropic"
    assert a["gen_ai.request.model"] == a["gen_ai.response.model"] == "claude-x"
    assert a["gen_ai.usage.input_tokens"] == 1000 and a["gen_ai.usage.output_tokens"] == 100
    assert a["gen_ai.usage.cache_read.input_tokens"] == 600 and a["gen_ai.usage.cache_write.input_tokens"] == 0
    assert list(a["gen_ai.response.finish_reasons"]) == ["end_turn"]
    assert a["gen_ai.system_instructions"] == "Be brief."
    assert json.loads(a["gen_ai.input.messages"]) == [{"role": "user", "content": "hi"}]
    assert a["gen_ai.output.messages"] == "hello"
    assert json.loads(a["agentlab.request.json_schema"]) == {"type": "object"}
    assert a["agentlab.cost.usd"] == pytest.approx(0.0123)
    assert a["agentlab.cost.basis"] == "test table 10-2026"
    assert "gen_ai.usage.cost" not in a        # that name means a provider-reported (actual) cost
    assert a["agentlab.node"] == "classify" and a["agentlab.run"] == "r"


@pytest.mark.parametrize("price", [lambda *a: None, lambda *a: 1 / 0, lambda *a: "cheap", lambda *a: True])
def test_price_that_says_nothing_or_breaks_gives_no_cost(price):
    with testing.capture(price=price) as spans:
        run = _runtime.start_run(app_id="a", run_id="r")
        _runtime.record_chat(run.target(), model="m", input_tokens=1, output_tokens=1)
        run.finish()
    (chat,) = by_kind(spans, "chat")
    assert "agentlab.cost.usd" not in attrs(chat)


def test_start_run_is_none_when_off():
    assert _runtime.start_run(app_id="a", run_id="r") is None


def test_run_ids_fresh_per_input_reused_on_resume():
    ids = RunIds()
    first = ids.begin("t1", resume=False)
    assert first.startswith("t1:") and len(first) == len("t1:") + 8
    assert ids.begin("t1", resume=True) == first
    second = ids.begin("t1", resume=False)
    assert second != first
    assert ids.begin("t1", resume=True) == second
    unknown = ids.begin("t9", resume=True)           # a resume in a fresh process: minted
    assert unknown.startswith("t9:")
    assert len(ids.begin(None, resume=False)) == 8


def test_run_ids_are_bounded():
    ids = RunIds(limit=2)
    a = ids.begin("a", resume=False)
    ids.begin("b", resume=False)
    ids.begin("c", resume=False)
    assert ids.begin("a", resume=True) != a          # forgotten: oldest first


def test_activate_targets_facts_at_the_node():
    import agentlab as lab
    with testing.capture() as spans:
        run = _runtime.start_run(app_id="a", run_id="r")
        node = run.open_node("classify")
        with activate(run.target(node, "classify")):
            lab.decision("it needs a ticket", cited=["sec-3"], confidence=0.8)
            lab.outcome("executed")
        run.end_node(node)
        run.finish()
    node_span, run_span = spans
    (ev,) = events(node_span, "agentlab.decision")
    assert ev["agentlab.decision.reason"] == "it needs a ticket"
    assert list(ev["agentlab.decision.cited"]) == ["sec-3"]
    assert attrs(run_span)["agentlab.run.outcome"] == "executed"


def test_run_span_under_an_app_span_on_another_provider_has_a_parent_the_bench_never_gets():
    """SPEC 8.6: the bench must find runs by agentlab.kind, not rootness."""
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    app_tracer = TracerProvider().get_tracer("app")
    with testing.capture() as spans:
        with app_tracer.start_as_current_span("POST /slack/events") as http:
            _runtime.start_run(app_id="a", run_id="r").finish()
    (run_span,) = spans
    assert run_span.parent is not None and run_span.parent.span_id == http.get_span_context().span_id
    assert run_span.context.trace_id == http.get_span_context().trace_id
    assert attrs(run_span)["agentlab.kind"] == "run"

"""Fact helpers emit exactly the names in SPEC.md 8.4, on the running node's span."""
import json

import pytest

import agentlab as lab
from agentlab import _runtime, testing
from agentlab._context import activate
from conftest import attrs, by_kind, events


@pytest.fixture
def in_node():
    """Run the body inside node 'n' of run 'r'; yields the finished spans afterwards."""
    out = {}

    class Ctx:
        def __enter__(self):
            self.cap = testing.capture()
            self.spans = self.cap.__enter__()
            self.run = _runtime.start_run(app_id="app", run_id="r")
            self.node = self.run.open_node("n")
            self.act = activate(self.run.target(self.node, "n"))
            self.act.__enter__()
            return self

        def __exit__(self, *exc):
            self.act.__exit__(*exc)
            self.run.end_node(self.node)
            self.run.finish()
            out["spans"] = list(self.spans)
            self.cap.__exit__(*exc)

    return Ctx


def node_events(spans, name):
    return events(by_kind(spans, "node")[0], name)


def test_decision(in_node):
    with in_node() as c:
        lab.decision("needs a change", cited=["sec-1", "sec-2"], branch="needs_write", confidence=0.91)
    (ev,) = node_events(c.spans, "agentlab.decision")
    assert ev == {"agentlab.decision.reason": "needs a change", "agentlab.decision.cited": ("sec-1", "sec-2"),
                  "agentlab.decision.branch": "needs_write", "agentlab.decision.confidence": 0.91}


def test_decision_omits_what_was_not_given(in_node):
    with in_node() as c:
        lab.decision()
    assert node_events(c.spans, "agentlab.decision") == [{}]


def test_check(in_node):
    with in_node() as c:
        lab.check("unsure", passed=False, detail="confidence 0.4", evidence=("sec-3",), kind="confidence",
                  words={"passed": "Didn't trigger", "failed": "Triggered: sent to a person", "not_on_path": "x"})
    (ev,) = node_events(c.spans, "agentlab.check")
    assert ev["agentlab.check.name"] == "unsure" and ev["agentlab.check.passed"] is False
    assert ev["agentlab.check.detail"] == "confidence 0.4" and list(ev["agentlab.check.evidence"]) == ["sec-3"]
    assert ev["agentlab.check.kind"] == "confidence"
    assert json.loads(ev["agentlab.check.words"]) == {"passed": "Didn't trigger", "failed": "Triggered: sent to a person"}


def test_check_rejects_a_non_bool_passed(in_node):
    with in_node() as c:
        lab.check("x", "yes")
    assert node_events(c.spans, "agentlab.check") == []


def test_gates(in_node):
    with in_node() as c:
        lab.gate_waiting({"type": "create_ticket"}, reason="writes need a person")
        lab.gate_resolved(True, by={"name": "the reviewer (recorded)"}, reason="looks right")
    (w,) = node_events(c.spans, "agentlab.gate.waiting")
    (r,) = node_events(c.spans, "agentlab.gate.resolved")
    assert json.loads(w["agentlab.gate.proposed"]) == {"type": "create_ticket"}
    assert w["agentlab.gate.reason"] == "writes need a person"
    assert r == {"agentlab.gate.approved": True, "agentlab.gate.by": "the reviewer (recorded)",
                 "agentlab.gate.reason": "looks right"}
    assert attrs(by_kind(c.spans, "run")[0])["agentlab.run.status"] == "paused"


def test_event_and_outcome(in_node):
    with in_node() as c:
        lab.event("permission_verdict", {"allowed": False, "rule": "mfa_reset"})
        lab.outcome("handed_off")
    (ev,) = node_events(c.spans, "agentlab.event")
    assert ev["agentlab.event.type"] == "permission_verdict"
    assert json.loads(ev["agentlab.event.data"]) == {"allowed": False, "rule": "mfa_reset"}
    assert attrs(by_kind(c.spans, "run")[0])["agentlab.run.outcome"] == "handed_off"


def test_retrieved_emits_a_genai_retrieval_span_with_the_corpus_hash(in_node):
    lab.corpus("handbook", title="Handbook", items=[("sec-1", "One"), ("sec-2", "Two")])
    from agentlab import _corpora
    with in_node() as c:
        lab.retrieved("handbook", [{"id": "sec-2", "title": "Two", "score": 0.8, "text": "body", "bm25": 3.5,
                                    "label": "ignored: not numeric"}], query="vpn")
    (span,) = by_kind(c.spans, "retrieval")
    a = attrs(span)
    assert span.name == "retrieval handbook"
    assert a["gen_ai.operation.name"] == "retrieval" and a["gen_ai.data_source.id"] == "handbook"
    assert a["gen_ai.retrieval.query.text"] == "vpn"
    assert json.loads(a["gen_ai.retrieval.documents"]) == [
        {"id": "sec-2", "title": "Two", "score": 0.8, "content": "body", "bm25": 3.5}]
    assert a["agentlab.corpus.hash"] == _corpora.get("handbook").hash
    assert a["agentlab.node"] == "n" and a["agentlab.kind"] == "retrieval"
    assert span.parent.span_id == by_kind(c.spans, "node")[0].context.span_id


def test_retrieved_from_an_unregistered_corpus_has_no_hash(in_node):
    with in_node() as c:
        lab.retrieved("elsewhere", [{"id": "a"}])
    assert "agentlab.corpus.hash" not in attrs(by_kind(c.spans, "retrieval")[0])


def test_corpus_replaces_by_id_and_hash_follows_items():
    from agentlab import _corpora
    lab.corpus("h", title="H", items=[("a", "A")])
    first = _corpora.get("h").hash
    lab.corpus("h", title="H", items=[{"id": "a", "title": "A"}])
    assert _corpora.get("h").hash == first             # same items, either shape
    lab.corpus("h", title="H", items=[("a", "A"), ("b", "B")])
    assert _corpora.get("h").hash != first
    assert _corpora.get("h").source["count"] == 2


def test_corpus_skips_bad_and_duplicate_items():
    from agentlab import _corpora
    lab.corpus("h", title="H", items=[("a", "A"), ("a", "again"), None, {"title": "no id"}])
    assert _corpora.get("h").source["items"] == [{"id": "a", "title": "A"}]

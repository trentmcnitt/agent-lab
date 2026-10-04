"""The quickstart app (examples/langgraph_quickstart): its map, its runs, and "nothing drifts".

The drift tests edit the example's *source* the way a developer would (rename a node, add a
branch, rename a branch, change a worded step's code), import the edited copy, and check that the
map follows on its own, and that every hand-written word that no longer matches is reported by
`verify()`, never shown silently wrong.
"""
import importlib
import json
import shutil
import sys
import uuid

import pytest

import agentlab as lab
from agentlab import testing
from agentlab.manifest import find
from conftest import BENCH, attrs, by_kind, events

EXAMPLE = BENCH / "examples" / "langgraph_quickstart"
PACKAGE = EXAMPLE / "support_bot"


@pytest.fixture
def load(tmp_path):
    """Import a copy of the example package with `edits` applied to graph.py / faq.py
    ([(file, old, new), ...]); every `old` must be present, so an example change can't make a
    drift test silently vacuous."""
    loaded = []

    def _load(edits=()):
        name = f"support_bot_{uuid.uuid4().hex[:8]}"
        target = tmp_path / name
        shutil.copytree(PACKAGE, target, ignore=shutil.ignore_patterns("__pycache__"))
        for file, old, new in edits:
            path = target / file
            src = path.read_text()
            assert old in src, f"{file} no longer contains {old!r}; update this test"
            path.write_text(src.replace(old, new))
        sys.path.insert(0, str(tmp_path))
        loaded.append(name)
        return importlib.import_module(name)

    yield _load
    if str(tmp_path) in sys.path:
        sys.path.remove(str(tmp_path))
    for name in loaded:
        for mod in [m for m in sys.modules if m == name or m.startswith(name + ".")]:
            del sys.modules[mod]


def manifest_of(graph):
    return find(graph).manifest()


def edge_set(m):
    return {(e["from"], e["to"], e.get("from_branch")) for e in m["edges"]}


def run(graph, question):
    with testing.capture() as spans:
        out = graph.invoke({"question": question})
    return out, spans


def node_order(spans):
    return [attrs(s)["agentlab.node"] for s in by_kind(spans, "node")]


# ---- the example as shipped

def test_the_shipped_example_map(load, topology_validator):
    m = manifest_of(load().build_graph())
    assert [n["id"] for n in m["nodes"]] == ["retrieve", "classify", "draft_answer", "check_grounding", "respond", "handoff"]
    assert edge_set(m) == {
        ("retrieve", "classify", None),
        ("classify", "draft_answer", "answer"), ("classify", "handoff", "escalate"),
        ("draft_answer", "check_grounding", None),
        ("check_grounding", "respond", "grounded"), ("check_grounding", "handoff", "not_grounded"),
    }
    by_id = {n["id"]: n for n in m["nodes"]}
    assert by_id["classify"]["plain_label"] == "Decide if the FAQ covers it" and by_id["classify"]["kind"] == "llm"
    assert by_id["check_grounding"]["x-not-needed"].startswith("Not needed this time")
    assert by_id["respond"]["kind"] == "step" and by_id["respond"]["doc"] == "Post the reply to the customer."
    assert m["sources"][0]["id"] == "faq" and m["sources"][0]["count"] == 5
    assert m["app"]["baseline"].startswith("~5 minutes")
    assert not list(topology_validator.iter_errors(m))


def test_the_shipped_words_are_verified_and_locked(load):
    report = lab.verify(load().build_graph(), strict=True)
    assert report.ok and set(report.fingerprints.values()) == {"confirmed"}
    assert not report.warnings


def test_an_answered_question(load):
    out, spans = run(load().build_graph(), "How do I reset my password?")
    assert out["answer"].endswith("[faq-password]")
    assert node_order(spans) == ["retrieve", "classify", "draft_answer", "check_grounding", "respond"]
    nodes = {attrs(s)["agentlab.node"]: s for s in by_kind(spans, "node")}
    (retrieval,) = by_kind(spans, "retrieval")
    assert attrs(retrieval)["agentlab.node"] == "retrieve" and attrs(retrieval)["gen_ai.data_source.id"] == "faq"
    assert [d["id"] for d in json.loads(attrs(retrieval)["gen_ai.retrieval.documents"])][0] == "faq-password"
    assert [attrs(c)["agentlab.node"] for c in by_kind(spans, "chat")] == ["classify", "draft_answer"]
    (decision,) = events(nodes["classify"], "agentlab.decision")
    assert decision["agentlab.decision.cited"] == ("faq-password",)
    (check,) = events(nodes["check_grounding"], "agentlab.check")
    assert check["agentlab.check.passed"] is True and check["agentlab.check.evidence"] == ("faq-password",)
    assert attrs(by_kind(spans, "run")[0])["agentlab.run.outcome"] == "answered"


def test_an_escalated_question(load):
    out, spans = run(load().build_graph(), "Can I get a refund for a hotel booking?")
    assert "answer" not in out
    assert node_order(spans) == ["retrieve", "classify", "handoff"]
    assert attrs(by_kind(spans, "run")[0])["agentlab.run.outcome"] == "handed_off"


# ---- nothing drifts: the map follows the code

RENAME = [("graph.py", '"draft_answer"', '"write_reply"')]


def test_renaming_a_node_moves_the_map_and_its_words(load):
    before = manifest_of(load().build_graph())
    mod = load(RENAME)
    graph = mod.build_graph()
    m = manifest_of(graph)
    ids = [n["id"] for n in m["nodes"]]
    assert "draft_answer" not in ids and "write_reply" in ids
    renamed = next(n for n in m["nodes"] if n["id"] == "write_reply")
    assert renamed["plain_label"] == "Write the answer"            # words travel with the function
    assert ("classify", "write_reply", "answer") in edge_set(m)
    assert ("write_reply", "check_grounding", None) in edge_set(m)
    assert m["derived"]["hashes"]["structure"] != before["derived"]["hashes"]["structure"]
    lab.verify(graph)
    _, spans = run(graph, "How do I reset my password?")
    assert "write_reply" in node_order(spans)
    assert [attrs(c)["agentlab.node"] for c in by_kind(spans, "chat")] == ["classify", "write_reply"]


ADD_BRANCH = [
    ("graph.py", 'def route_after_classify(state: State) -> Literal["answer", "escalate"]:\n'
                 '        return "answer" if state["category"] == "answer" else "escalate"',
                 'def route_after_classify(state: State) -> Literal["answer", "escalate", "unclear"]:\n'
                 '        if not state["question"].strip().endswith("?"):\n'
                 '            return "unclear"\n'
                 '        return "answer" if state["category"] == "answer" else "escalate"\n\n'
                 '    def ask_to_rephrase(state: State) -> State:\n'
                 '        return {"answer": "Could you put that as a question?"}'),
    ("graph.py", '{"answer": "draft_answer", "escalate": "handoff"}',
                 '{"answer": "draft_answer", "escalate": "handoff", "unclear": "ask_to_rephrase"}'),
    ("graph.py", '    builder.add_node("respond", respond)\n',
                 '    builder.add_node("respond", respond)\n    builder.add_node("ask_to_rephrase", ask_to_rephrase)\n'
                 '    builder.add_edge("ask_to_rephrase", END)\n'),
]


def test_adding_a_branch_appears_on_the_map_by_itself(load):
    graph = load(ADD_BRANCH).build_graph()
    m = manifest_of(graph)
    assert ("classify", "ask_to_rephrase", "unclear") in edge_set(m)
    new = next(n for n in m["nodes"] if n["id"] == "ask_to_rephrase")
    assert new["label"] == "ask to rephrase" and "plain_label" not in new
    notes = {(w["code"], w.get("node"), w.get("branch")) for w in m["derived"]["warnings"]}
    assert ("R12", "classify", "unclear") in notes                  # an unworded branch is noted, not an error
    assert ("R12", "ask_to_rephrase", None) in notes
    report = lab.verify(graph)                                       # nothing hand-written is wrong
    assert report.ok
    # the worded router changed, so its words are flagged for a person to re-read (R6)
    assert m["derived"]["fingerprints"]["paths:classify"] == "changed"
    with pytest.raises(lab.VerificationError, match="R6"):
        lab.verify(graph, strict=True)
    _, spans = run(graph, "password reset")
    assert node_order(spans) == ["retrieve", "classify", "ask_to_rephrase"]


def test_a_stale_path_word_fails_verify(load):
    """Rename the branch in the code but not in `@lab.step(paths=...)`: verify names it."""
    mod = load([("graph.py", '"escalate"', '"needs_person"'),
                ("graph.py", 'paths={"answer": lab.path("the FAQ covers it", says="It found an article that answers the question."),\n'
                             '                     "needs_person": lab.path(',
                             'paths={"answer": lab.path("the FAQ covers it", says="It found an article that answers the question."),\n'
                             '                     "escalate": lab.path(')])
    graph = mod.build_graph()
    assert ("classify", "handoff", "needs_person") in edge_set(manifest_of(graph))
    with pytest.raises(lab.VerificationError) as caught:
        lab.verify(graph)
    (error,) = caught.value.report.errors
    assert (error.code, error.node, error.branch) == ("R2", "classify", "escalate")
    assert "needs_person" in error.message                           # and says what the real branches are


def test_stale_steps_words_for_a_renamed_node_fail_verify(load):
    from agentlab.langgraph import instrument
    mod = load(RENAME)
    compiled = mod.make_builder().compile()
    graph = instrument(compiled, app=mod.APP, steps={"draft_answer": lab.step("Write the answer")})
    with pytest.raises(lab.VerificationError) as caught:
        lab.verify(graph)
    assert [(e.code, e.node) for e in caught.value.report.errors] == [("R1", "draft_answer")]


def test_changed_code_under_a_wording_asks_for_a_reread(load):
    mod = load([("graph.py", "ok = bool(cited) and set(cited) <= retrieved", "ok = set(cited) <= retrieved")])
    graph = mod.build_graph()
    report = lab.verify(graph)                                       # referential check still passes
    assert report.fingerprints["node:check_grounding"] == "changed"
    assert [(w.code, w.node) for w in report.warnings] == [("R6", "check_grounding")]
    with pytest.raises(lab.VerificationError):
        lab.verify(graph, strict=True)
    lab.lock(graph)                                                  # a person re-read it: confirm
    assert lab.verify(mod.build_graph(), strict=True).ok


def test_the_corpus_follows_the_index(load):
    mod = load([("faq.py", '    Entry("faq-seats",',
                 '    Entry("faq-sso", "Turn on single sign-on", "Owners turn on SSO under Security, then SSO."),\n'
                 '    Entry("faq-seats",')])
    m = manifest_of(mod.build_graph())
    (faq,) = m["sources"]
    assert faq["count"] == 6 and {"id": "faq-sso", "title": "Turn on single sign-on"} in faq["items"]


def test_cli_verify_on_the_example(load):
    import subprocess
    out = subprocess.run([sys.executable, "-m", "agentlab", "verify", "support_bot:build_graph", "--strict"],
                         cwd=EXAMPLE, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "no findings" in out.stdout

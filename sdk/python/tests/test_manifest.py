"""Manifest assembly from a framework-neutral Structure: shape, schema, hashes, rules R0-R6/R12."""
import copy
import importlib.util
import json
import subprocess
import sys
import textwrap

import pytest

import agentlab as lab
from agentlab import _corpora, _state, testing
from agentlab._util import canonical, hash_obj, sha256_hex
from agentlab.manifest import BranchSpec, Instrumentation, NodeSpec, Structure, find


# ---- a small helpdesk-shaped app, worded next to its "code"

@lab.step("Look up the handbook", actor="rule", kind="retrieval")
def retrieve(state):
    """Search the handbook index for the message."""


@lab.step("Decide what kind of request", says="The AI reads the message and decides.", actor="ai", moment=True,
          paths={"answerable": lab.path("it can answer", says="It decided the handbook answers this."),
                 "needs_write": "needs a change"})
def classify(state):
    """Classify the request with the model."""


def route(state):
    return state["kind"]


@lab.step("Check the answer", actor="rule", moment=True,
          not_needed="Not needed this time: the AI didn't write an answer.")
def grounding_check(state):
    """Every claim must cite a handbook section."""


def respond(state):
    pass


def propose_action(state):
    pass


def handoff(state):
    pass


FORBIDDEN = ["mfa_reset", "share_credentials"]
NEVER = lab.never(FORBIDDEN, words={"mfa_reset": "Reset two-factor sign-in",
                                    "share_credentials": "Share passwords or other credentials"})
APP = lab.App(name="Slack Helpdesk Agent", id="slack-helpdesk", description="Answers IT questions.",
              baseline="~10–15 minutes", never=NEVER,
              actions=[lab.Action("create_ticket", "Open an IT ticket", "Files a ticket.")])


def structure(**over):
    base = dict(
        nodes=[NodeSpec("retrieve", retrieve), NodeSpec("classify", classify), NodeSpec("grounding_check", grounding_check),
               NodeSpec("respond", respond), NodeSpec("propose_action", propose_action), NodeSpec("handoff", handoff)],
        edges=[("__start__", "retrieve"), ("retrieve", "classify"), ("respond", "__end__"), ("handoff", "__end__"),
               ("propose_action", "__end__")],
        branches=[BranchSpec("classify", {"answerable": "grounding_check", "needs_write": "propose_action",
                                          "out_of_scope": "handoff"}, route),
                  BranchSpec("grounding_check", {True: "respond", False: "handoff"}, route)],
        source="langgraph", framework="langgraph 1.2.12")
    base.update(over)
    return Structure(**base)


def build(**kw):
    s = kw.pop("structure", None) or structure()
    kw.setdefault("app", APP)
    return Instrumentation(s, **kw)


def node(m, nid):
    return next(n for n in m["nodes"] if n["id"] == nid)


def codes(inst, severity=None):
    return sorted(f.code for f in inst.findings() if severity is None or f.severity == severity)


# ---- shape


def test_manifest_validates_against_the_bench_schema(topology_validator, tmp_path):
    story = tmp_path / "story.js"
    story.write_text("BenchStory.register('slack-helpdesk', {panels: {}});\n")
    lab.corpus("handbook", title="IT/Ops handbook", items=[("sec-1", "VPN"), ("sec-2", "Laptops")])
    m = build(story=lab.Story(story, panels=[lab.Panel("classify", "Classification", ["decision"], nodes=["classify"],
                                                         plain_title="The path it picked")], reads=["handoff"])).manifest()
    assert [e.message for e in topology_validator.iter_errors(m)] == []


def test_nodes_words_docs_and_defaults():
    m = build().manifest()
    c = node(m, "classify")
    assert c == {"id": "classify", "label": "classify", "plain_label": "Decide what kind of request",
                 "description": "The AI reads the message and decides.", "moment": True,
                 "doc": "Classify the request with the model.", "kind": "llm", "actor": "ai"}
    g = node(m, "grounding_check")
    assert g["label"] == "grounding check" and g["kind"] == "check" and g["actor"] == "rule"
    assert g["x-not-needed"] == "Not needed this time: the AI didn't write an answer."
    assert node(m, "retrieve")["kind"] == "retrieval" and node(m, "retrieve")["actor"] == "rule"
    # unworded: humanized name, terminal when every exit is END, no plain_label
    assert node(m, "respond") == {"id": "respond", "label": "respond", "kind": "terminal"}
    assert "doc" not in node(m, "respond")       # no docstring of its own


def test_edges_branches_and_words():
    m = build().manifest()
    assert {"from": "retrieve", "to": "classify"} in m["edges"]
    assert not [e for e in m["edges"] if e["from"] == "__start__" or (e["to"] == "__end__" and "from_branch" not in e)]
    answerable = next(e for e in m["edges"] if e.get("from_branch") == "answerable")
    assert answerable == {"from": "classify", "to": "grounding_check", "from_branch": "answerable",
                          "plain_label": "it can answer", "description": "It decided the handbook answers this."}
    needs = next(e for e in m["edges"] if e.get("from_branch") == "needs_write")
    assert needs["plain_label"] == "needs a change" and "description" not in needs
    bools = sorted(e["from_branch"] for e in m["edges"] if e["from"] == "grounding_check")
    assert bools == ["False", "True"]


def test_conditional_end_synthesizes_an_end_node(topology_validator):
    s = structure(branches=[BranchSpec("classify", {"done": "__end__", "more": "retrieve"}, route)])
    m = build(structure=s).manifest()
    assert list(topology_validator.iter_errors(m)) == []
    assert node(m, "__end__") == {"id": "__end__", "label": "end", "kind": "terminal"}
    assert {"from": "classify", "to": "__end__", "from_branch": "done"} in m["edges"]


def test_app_actions_never_sources_and_generic_panels():
    lab.corpus("handbook", title="IT/Ops handbook", items=[("sec-1", "VPN")], description="The handbook.")
    lab.corpus("other-app", title="Not ours", items=[])
    m = build(corpora=["handbook"]).manifest()
    assert m["app"] == {"id": "slack-helpdesk", "name": "Slack Helpdesk Agent", "description": "Answers IT questions.",
                        "baseline": "~10–15 minutes"}
    assert m["actions"] == [{"id": "create_ticket", "title": "Open an IT ticket", "description": "Files a ticket."}]
    assert m["never"] == ["Reset two-factor sign-in", "Share passwords or other credentials"]
    assert m["sources"] == [{"id": "handbook", "title": "IT/Ops handbook", "kind": "documents",
                             "description": "The handbook.", "count": 1, "items": [{"id": "sec-1", "title": "VPN"}]}]
    assert [p["id"] for p in m["panels"]] == ["llm", "tools", "errors"]
    assert all(p["audience"] == "engineering" and p["mode"] == "append" for p in m["panels"])
    assert "story" not in m


def test_story_panels_first_override_generic_and_story_is_id_plus_hash(tmp_path):
    story = tmp_path / "story.js"
    story.write_bytes(b"// story\n")
    panels = [lab.Panel("classify", "Classification", ["decision"], nodes=["classify"]),
              lab.Panel("llm", "Model calls (custom)", ["llm_call"], mode="append", story=False,
                        fields=[{"key": "model"}, {"key": "cost_usd", "format": "usd"}])]
    m = build(story=lab.Story(story, panels=panels)).manifest()
    assert [p["id"] for p in m["panels"]] == ["classify", "llm", "tools", "errors"]
    assert m["panels"][1] == {"id": "llm", "title": "Model calls (custom)", "event_types": ["llm_call"],
                              "mode": "append", "audience": "both",
                              "fields": [{"key": "model"}, {"key": "cost_usd", "format": "usd"}]}
    assert m["story"] == {"id": "slack-helpdesk", "sha256": sha256_hex(b"// story\n")}


def test_derived_block():
    m = build().manifest()
    d = m["derived"]
    assert d["from"] == "langgraph" and d["library"] == f"agentlab {lab.__version__}"
    assert d["framework"] == "langgraph 1.2.12"
    assert set(d["hashes"]) == {"structure", "words", "corpora"}
    assert all(f["severity"] in ("error", "warning", "info") for f in d["warnings"])


# ---- app id


def test_app_id_defaults_to_service_name_then_name():
    no_id = lab.App(name="Slack Helpdesk Agent")
    assert build(app=no_id).app_id() == "slack-helpdesk-agent"
    with testing.capture(service_name="helpdesk-svc"):
        assert build(app=no_id).app_id() == "helpdesk-svc"


def test_bad_explicit_app_id_is_r0_and_slugged():
    inst = build(app=lab.App(name="x", id="Slack Helpdesk"))
    assert inst.app_id() == "slack-helpdesk"
    assert "R0" in codes(inst, "error")


# ---- hashes


def test_hashes_split_words_structure_corpora():
    base = build().manifest()["derived"]["hashes"]

    reworded = lab.step("Something else", actor="ai")
    m = build(steps={"respond": reworded}).manifest()["derived"]["hashes"]
    assert m["words"] != base["words"] and m["structure"] == base["structure"] and m["corpora"] == base["corpora"]

    s = structure(nodes=structure().nodes + [NodeSpec("extra", None)], edges=list(structure().edges) + [("handoff", "extra")])
    m = build(structure=s).manifest()["derived"]["hashes"]
    assert m["structure"] != base["structure"]

    lab.corpus("handbook", title="H", items=[("a", "A")])
    m = build().manifest()["derived"]["hashes"]
    assert m["corpora"] != base["corpora"] and m["words"] == base["words"] and m["structure"] == base["structure"]


def test_structure_hash_ignores_declaration_order():
    s = structure()
    flipped = Structure(nodes=list(reversed(s.nodes)), edges=list(reversed(s.edges)),
                        branches=list(reversed(s.branches)), source=s.source, framework=s.framework)
    assert build().manifest()["derived"]["hashes"]["structure"] == build(structure=flipped).manifest()["derived"]["hashes"]["structure"]


def test_manifest_doc_is_canonical_and_cached():
    inst = build()
    doc = inst.manifest_doc()
    assert doc.json.encode() == canonical(json.loads(doc.json))
    assert doc.hash == sha256_hex(doc.json) == hash_obj(json.loads(doc.json))
    assert inst.manifest_doc() is doc
    lab.corpus("handbook", title="H", items=[("a", "A")])
    again = inst.manifest_doc()
    assert again is not doc and again.hash != doc.hash and json.loads(again.json)["sources"][0]["id"] == "handbook"


# ---- rules


def test_clean_app_has_no_errors():
    assert codes(build(), "error") == []


def test_r0_bad_actor_kind_and_unreadable_story(tmp_path):
    inst = build(steps={"respond": lab.step("x", actor="robot", kind="guard")},
                 story=lab.Story(tmp_path / "missing.js"))
    assert codes(inst, "error") == ["R0", "R0", "R0"]
    assert node(inst.manifest(), "respond")["kind"] == "terminal"  # the bad value is not shipped


def test_r1_unknown_keys_and_double_wording(tmp_path):
    story = tmp_path / "s.js"
    story.write_text("x")
    inst = build(steps={"gone": lab.step("x"), "classify": lab.step("again")},
                 story=lab.Story(story, panels=[lab.Panel("p", "P", ["decision"], nodes=["renamed"])], reads=["old_node"]))
    msgs = [f.message for f in inst.findings() if f.code == "R1"]
    assert len(msgs) == 4
    assert any("gone" in m for m in msgs) and any("both" in m for m in msgs)
    assert any("renamed" in m for m in msgs) and any("old_node" in m for m in msgs)


def test_panels_and_reads_may_name_a_step_by_its_function(tmp_path):
    """A node named by its function can't go stale on a rename: it resolves to the node's id, and a
    function that is no step of the graph is an R1 error naming it."""
    story = tmp_path / "s.js"
    story.write_text("x")

    def not_a_step(state):
        pass

    inst = build(story=lab.Story(story, panels=[lab.Panel("p", "P", ["decision"], nodes=[classify, "retrieve"])],
                                 reads=[grounding_check]))
    assert [f for f in inst.findings() if f.code == "R1"] == []
    assert next(p for p in inst.manifest()["panels"] if p["id"] == "p")["nodes"] == ["classify", "retrieve"]
    bad = build(story=lab.Story(story, panels=[lab.Panel("p", "P", ["decision"], nodes=[not_a_step])]))
    (f,) = [f for f in bad.findings() if f.code == "R1"]
    assert "not_a_step" in f.message and f.severity == "error"


def test_r2_paths_key_not_a_branch():
    inst = build(steps={"respond": lab.step("x", paths={"nowhere": "y"})})
    (f,) = [f for f in inst.findings() if f.code == "R2"]
    assert f.node == "respond" and f.branch == "nowhere" and "none" in f.message


def test_r3_unknown_branches(topology_validator):
    s = structure(branches=list(structure().branches) + [BranchSpec("respond", None)])
    inst = build(structure=s)
    assert "R3" in codes(inst, "error")
    m = inst.manifest()
    assert node(m, "respond")["branches_unknown"] is True
    assert list(topology_validator.iter_errors(m)) == []


def inner(state):
    """The subgraph's one step."""


def test_subgraph_nodes_carry_parent_and_their_own_label(topology_validator):
    s = structure(nodes=list(structure().nodes) + [NodeSpec("sub", None), NodeSpec("sub/inner", inner, parent="sub")],
                  edges=list(structure().edges) + [("handoff", "sub")])
    inst = build(structure=s, steps={"sub/inner": lab.step("Do the inner thing")})
    m = inst.manifest()
    assert node(m, "sub/inner") == {"id": "sub/inner", "label": "inner", "plain_label": "Do the inner thing",
                                    "doc": "The subgraph's one step.", "kind": "step", "parent": "sub"}
    assert list(topology_validator.iter_errors(m)) == []
    flat = build(structure=structure(nodes=list(s.nodes[:-1]) + [NodeSpec("sub/inner", inner)], edges=s.edges))
    assert flat.manifest()["derived"]["hashes"]["structure"] != m["derived"]["hashes"]["structure"]


def test_r4_never_words_must_match_types():
    bad = lab.App(name="x", id="x", never=lab.never(["a", "b"], words={"a": "A", "c": "C"}))
    inst = build(app=bad)
    (f,) = [f for f in inst.findings() if f.code == "R4"]
    assert "'b'" in f.message and "'c'" in f.message
    assert inst.manifest()["never"] == ["A"]


def test_r5_many_to_one_is_info():
    s = structure(branches=[BranchSpec("classify", {"yes": "respond", "maybe": "respond", "no": "handoff"}, route)])
    inst = build(structure=s, steps=None)
    assert "R5" in codes(inst, "info")


def test_r12_unworded_nodes_and_branches_and_unconfirmed():
    inst = build()
    notes = [f for f in inst.findings() if f.code == "R12"]
    assert any(f.node == "respond" for f in notes)
    assert any(f.node == "classify" and f.branch == "out_of_scope" for f in notes)
    assert any("unconfirmed" in f.message for f in notes)


def test_verify_raises_with_every_error_and_passes_clean():
    lab.verify(build())
    with pytest.raises(lab.VerificationError) as e:
        lab.verify(build(steps={"gone": lab.step("x"), "respond": lab.step(paths={"nope": "x"})}))
    text = str(e.value)
    assert "R1" in text and "R2" in text and "2 error(s)" in text
    assert isinstance(e.value, AssertionError)


def test_verify_finds_the_instrumentation_through_config_callbacks():
    inst = build()

    class Handler:
        agentlab_instrumentation = inst

    class Manager:
        handlers = [object(), Handler()]

    class Graph:
        def __init__(self, callbacks):
            self.config = {"callbacks": callbacks}

    assert find(Graph([Handler()])) is inst
    assert find(Graph(Manager())) is inst
    assert lab.verify(Graph([Handler()])).ok
    with pytest.raises(TypeError, match="not instrumented"):
        lab.verify(object())


# ---- fingerprints and lock


V1 = '''
import agentlab as lab

@lab.step("Decide", paths={"yes": "go on"})
def decide(state):
    """Decide."""
    return {"ok": True}

def router(state):
    return "yes"
'''
V2 = V1.replace('return {"ok": True}', 'return {"ok": False}')


def load(tmp_path, name, src):
    path = tmp_path / f"{name}.py"
    path.write_text(textwrap.dedent(src))
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def tiny(mod, lock):
    s = Structure(nodes=[NodeSpec("decide", mod.decide), NodeSpec("next", None)],
                  branches=[BranchSpec("decide", {"yes": "next"}, mod.router)])
    return Instrumentation(s, app=lab.App(name="t", id="t", ), lock=lock)


def test_fingerprints_unconfirmed_confirmed_changed(tmp_path):
    lock = tmp_path / "agentlab.lock.json"
    v1 = load(tmp_path, "app_v1", V1)
    inst = tiny(v1, lock)
    assert inst.report().fingerprints == {"node:decide": "unconfirmed", "paths:decide": "unconfirmed"}

    assert lab.lock(inst) == lock
    data = json.loads(lock.read_text())
    assert data["v"] == "agentlab-lock/0" and set(data["fingerprints"]) == {"node:decide", "paths:decide"}
    assert inst.report().fingerprints == {"node:decide": "confirmed", "paths:decide": "confirmed"}
    assert lab.verify(inst, strict=True).ok

    v2 = load(tmp_path, "app_v2", V2)                       # the step's code changed, its words didn't
    changed = tiny(v2, lock)
    assert changed.report().fingerprints == {"node:decide": "changed", "paths:decide": "confirmed"}
    assert lab.verify(changed).ok                           # a warning, not an error
    with pytest.raises(lab.VerificationError, match="R6"):
        lab.verify(changed, strict=True)
    assert changed.manifest()["derived"]["fingerprints"]["node:decide"] == "changed"


def test_whitespace_only_changes_keep_the_fingerprint(tmp_path):
    lock = tmp_path / "lock.json"
    lab.lock(tiny(load(tmp_path, "w1", V1), lock))
    spaced = V1.replace('return {"ok": True}', 'return {"ok": True}    ')
    assert tiny(load(tmp_path, "w2", spaced), lock).report().fingerprints["node:decide"] == "confirmed"


def test_lock_without_a_path_raises():
    with pytest.raises(ValueError, match="lock="):
        lab.lock(build())


def test_cli_verify_and_lock(tmp_path):
    (tmp_path / "myapp.py").write_text(textwrap.dedent(V1) + textwrap.dedent('''
        from agentlab.manifest import BranchSpec, Instrumentation, NodeSpec, Structure

        def build():
            s = Structure(nodes=[NodeSpec("decide", decide), NodeSpec("next", None)],
                          branches=[BranchSpec("decide", {"yes": "next"}, router)])
            return Instrumentation(s, app=lab.App(name="t", id="t"), lock="agentlab.lock.json")

        def broken():
            s = Structure(nodes=[NodeSpec("decide", decide)], branches=[BranchSpec("decide", None)])
            return Instrumentation(s, app=lab.App(name="t", id="t"))
        '''))
    run = lambda *a: subprocess.run([sys.executable, "-m", "agentlab", *a], cwd=tmp_path, capture_output=True, text=True)
    r = run("lock", "myapp:build")
    assert r.returncode == 0 and (tmp_path / "agentlab.lock.json").exists()
    r = run("verify", "myapp:build", "--strict")
    assert r.returncode == 0, r.stderr
    r = run("verify", "myapp:broken")
    assert r.returncode == 1 and "R2" in r.stderr and "R3" in r.stderr

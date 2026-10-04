"""Open Agent Spec flows: the map read from the flow file (agentlab.agentspec, SPEC.md 8.5, R14).

Fixtures: two of Oracle's own example flows (tests/fixtures/agentspec, Apache-2.0, see NOTICE.md)
and the bench's example flow (examples/agentspec/helpdesk_triage.yaml). When the agent-spec
clone named by AGENTSPEC_CLONE (or the build scratchpad's copy) exists, every example flow in it is
read too; otherwise that sweep is skipped.
"""
import http.server
import json
import os
import threading
from pathlib import Path

import pytest

import agentlab as lab
from agentlab import agentspec
from agentlab.agentspec import AgentSpecError
from agentlab.manifest import BranchSpec, Instrumentation, NodeSpec, Structure
from conftest import BENCH

FIXTURES = Path(__file__).parent / "fixtures" / "agentspec"
BRANCHING = FIXTURES / "example_serialized_flow_with_branching_node.yaml"
NESTED = FIXTURES / "flow_with_multiple_levels_of_references.yaml"
EXAMPLE = BENCH / "examples" / "agentspec" / "helpdesk_triage.yaml"
CLONE = Path(os.environ.get("AGENTSPEC_CLONE", "/nonexistent/agent-spec"))


def nodes(m):
    return {n["id"]: n for n in m["nodes"]}


def edges(m):
    return {(e["from"], e["to"], e.get("from_branch")) for e in m["edges"]}


def errors(m, code="R14"):
    return [w for w in m["derived"]["warnings"] if w["code"] == code and w["severity"] == "error"]


# ---------------------------------------------------------------- Oracle's branching example


def test_branching_example_nodes_are_the_flows_nodes(topology_validator):
    m = agentspec.manifest_from(BRANCHING)
    topology_validator.validate(m)
    n = nodes(m)
    assert list(n) == ["lniwuebjsdvkc", "724oiquh3hrj", "0892u3jkjhdas", "724893yhrj", "123724893yhrj", "321724893yhrj"]
    assert n["724oiquh3hrj"]["label"] == "Branching Node"            # the component's name
    assert (n["724oiquh3hrj"]["kind"], n["724oiquh3hrj"]["actor"]) == ("step", "rule")
    assert (n["724893yhrj"]["kind"], n["724893yhrj"]["actor"]) == ("terminal", "app")
    assert (n["lniwuebjsdvkc"]["kind"], n["lniwuebjsdvkc"]["actor"]) == ("step", "app")
    assert "plain_label" not in n["724oiquh3hrj"]                    # Presentation words only from step()
    assert m["app"] == {"id": "example-branching-test-flow", "name": "Example branching test flow"}
    assert m["derived"]["from"] == "agentspec"
    assert m["derived"]["framework"] == "agentspec 25.4.1"


def test_branching_example_edges_keep_their_branch_names():
    m = agentspec.manifest_from(BRANCHING)
    assert edges(m) == {
        ("lniwuebjsdvkc", "724oiquh3hrj", None),                      # from_branch null on a one-way node
        ("724oiquh3hrj", "724893yhrj", "yes"), ("724oiquh3hrj", "321724893yhrj", "no"),
        ("724oiquh3hrj", "0892u3jkjhdas", "maybe"),
        ("0892u3jkjhdas", "123724893yhrj", "yes"), ("0892u3jkjhdas", "321724893yhrj", "no"),
    }


def test_branching_example_case_mismatch_is_reported_not_hidden():
    """The edges say 'yes'/'no'/'maybe'; the nodes declare 'Yes'/'No'/'Maybe' (and pyagentspec's
    LangGraph loader then fails at runtime with KeyError: 'Maybe'). Each edge is an R14 error,
    and each is still drawn."""
    m = agentspec.manifest_from(BRANCHING)
    found = {(w["node"], w["branch"]) for w in errors(m)}
    assert found == {("724oiquh3hrj", "yes"), ("724oiquh3hrj", "no"), ("724oiquh3hrj", "maybe"),
                     ("0892u3jkjhdas", "yes"), ("0892u3jkjhdas", "no")}
    assert "'Maybe', 'No', 'Yes', 'default'" in errors(m)[0]["message"]
    with pytest.raises(lab.VerificationError) as e:
        lab.verify(agentspec.instrumentation_from(BRANCHING))
    assert "R14" in str(e.value) and "'maybe'" in str(e.value)


# ---------------------------------------------------------------- nested FlowNode, scoped references


def test_flow_node_subflow_is_drawn_inside_it(topology_validator):
    m = agentspec.manifest_from(NESTED)
    topology_validator.validate(m)
    n = nodes(m)
    assert [i for i in n if n[i].get("parent") == "complex_flow_node"] == [
        "complex_flow_node/START_NODE", "complex_flow_node/promptnode2", "complex_flow_node/end_node"]
    assert n["complex_flow_node/promptnode2"]["kind"] == "llm"         # a root-level component, used inside
    assert n["promptnode2"]["kind"] == "llm" and "parent" not in n["promptnode2"]
    assert edges(m) == {
        ("top_level_start_node", "promptnode2", None), ("promptnode2", "complex_flow_node", None),
        ("complex_flow_node", "top_level_end_node", None),
        ("complex_flow_node/START_NODE", "complex_flow_node/promptnode2", None),
        ("complex_flow_node/promptnode2", "complex_flow_node/end_node", None),
    }
    assert not [w for w in m["derived"]["warnings"] if w["severity"] == "error"]


# ---------------------------------------------------------------- the bench's own example


def test_example_flow_is_clean_and_complete(topology_validator):
    inst = agentspec.instrumentation_from(EXAMPLE)
    report = lab.verify(inst)                                         # no errors
    assert not report.warnings
    m = inst.manifest()
    topology_validator.validate(m)
    n = nodes(m)
    assert m["app"]["name"] == "Helpdesk triage"
    assert m["app"]["description"].startswith("Answers questions and makes approved changes")
    assert n["classify"]["description"].startswith("The AI reads the message")
    assert (n["classify"]["kind"], n["classify"]["actor"]) == ("llm", "ai")
    assert (n["make_change"]["kind"], n["make_change"]["actor"]) == ("tool", "app")
    assert (n["approval/ask"]["kind"], n["approval/ask"]["actor"]) == ("gate", "person")
    assert n["approval/ask"]["parent"] == "approval"
    assert {("route", "draft_answer", "answer"), ("route", "approval", "needs_change"),
            ("route", "handed_off", "default"),
            ("approval", "make_change", "approved"), ("approval", "handed_off", "denied"),
            ("approval/decide", "approval/approved", "approved"), ("approval/decide", "approval/denied", "default"),
            ("classify", "route", None)} <= edges(m)


def test_json_dict_and_yaml_read_the_same(tmp_path):
    import yaml
    doc = yaml.safe_load(EXAMPLE.read_text())
    as_json = tmp_path / "flow.json"
    as_json.write_text(json.dumps(doc))
    assert agentspec.manifest_from(as_json) == agentspec.manifest_from(EXAMPLE) == agentspec.manifest_from(doc)


def test_yaml_yes_and_no_stay_branch_names(tmp_path):
    """YAML 1.1 reads an unquoted `yes` as a boolean; a branch named yes must stay 'yes'."""
    text = BRANCHING.read_text().replace("from_branch: 'yes'", "from_branch: yes").replace("- 'Yes'", "- yes")
    flow = tmp_path / "flow.yaml"
    flow.write_text(text)
    m = agentspec.manifest_from(flow)
    assert ("724oiquh3hrj", "724893yhrj", "yes") in edges(m)
    assert ("724oiquh3hrj", "yes") not in {(w["node"], w["branch"]) for w in errors(m)}   # now it matches


# ---------------------------------------------------------------- the file changes, the map follows


def _edit(tmp_path, old, new, count=1):
    text = EXAMPLE.read_text()
    assert text.count(old) >= count, f"anchor {old!r} not in the example"
    flow = tmp_path / "flow.yaml"
    flow.write_text(text.replace(old, new))
    return agentspec.manifest_from(flow)


def test_renaming_a_node_moves_its_label_and_the_words_hash_only(tmp_path):
    before = agentspec.manifest_from(EXAMPLE)
    after = _edit(tmp_path, "name: classify\n", "name: sort the request\n")
    assert nodes(after)["classify"]["label"] == "sort the request"
    assert after["derived"]["hashes"]["structure"] == before["derived"]["hashes"]["structure"]
    assert after["derived"]["hashes"]["words"] != before["derived"]["hashes"]["words"]


def test_rewiring_a_branch_moves_the_edge_and_the_structure_hash(tmp_path):
    before = agentspec.manifest_from(EXAMPLE)
    after = _edit(tmp_path, "from_branch: denied\n  to_node:\n    $component_ref: handed_off",
                  "from_branch: denied\n  to_node:\n    $component_ref: answered")
    assert ("approval", "answered", "denied") in edges(after)
    assert ("approval", "handed_off", "denied") not in edges(after)
    assert after["derived"]["hashes"]["structure"] != before["derived"]["hashes"]["structure"]


def test_an_edge_to_a_branch_nobody_declares_fails_verify(tmp_path):
    flow = tmp_path / "flow.yaml"
    flow.write_text(EXAMPLE.read_text().replace("from_branch: needs_change", "from_branch: needs_a_change"))
    with pytest.raises(lab.VerificationError, match="needs_a_change"):
        lab.verify(agentspec.instrumentation_from(flow))


# ---------------------------------------------------------------- what the file can get wrong


def _flow(nodes_, edges_, refs):
    return {"component_type": "Flow", "id": "f", "name": "F", "start_node": {"$component_ref": nodes_[0]},
            "nodes": [{"$component_ref": n} for n in nodes_],
            "control_flow_connections": edges_, "$referenced_components": refs}


def _node(id_, ctype="LlmNode", **extra):
    return {"component_type": ctype, "id": id_, "name": id_, **extra}


def _edge(a, b, branch=None, name="e"):
    return {"component_type": "ControlFlowEdge", "name": name, "from_node": {"$component_ref": a},
            "from_branch": branch, "to_node": {"$component_ref": b}}


def test_two_edges_from_one_branch_are_reported_and_both_drawn():
    refs = {i: _node(i) for i in ("a", "b", "c")}
    m = agentspec.manifest_from(_flow(["a", "b", "c"], [_edge("a", "b"), _edge("a", "c")], refs))
    assert {("a", "b", None), ("a", "c", None)} <= edges(m)
    [err] = errors(m)
    assert err["node"] == "a" and "second edge" in err["message"]


def test_an_edge_to_a_node_the_flow_does_not_list_is_reported():
    refs = {i: _node(i) for i in ("a", "b", "ghost")}
    m = agentspec.manifest_from(_flow(["a", "b"], [_edge("a", "b"), _edge("b", "ghost", name="to the ghost")], refs))
    assert "ghost" not in nodes(m)
    assert any("'to the ghost'" in w["message"] and "'ghost'" in w["message"] for w in errors(m))


def test_a_node_listed_twice_is_one_node():
    refs = {i: _node(i) for i in ("a", "b")}
    flow = _flow(["a", "b"], [_edge("a", "b")], refs)
    flow["nodes"].append({"$component_ref": "b"})
    assert list(nodes(agentspec.manifest_from(flow))) == ["a", "b"]


def test_branches_are_inferred_when_not_written():
    refs = {"s": _node("s", "StartNode"),
            "br": _node("br", "BranchingNode", mapping={"x": "X", "y": "X"}),
            "e1": _node("e1", "EndNode"), "e2": _node("e2", "EndNode")}
    m = agentspec.manifest_from(_flow(["s", "br", "e1", "e2"],
                                      [_edge("s", "br"), _edge("br", "e1", "X"), _edge("br", "e2", "default")], refs))
    assert not errors(m)
    assert {("br", "e1", "X"), ("br", "e2", "default")} <= edges(m)


@pytest.mark.parametrize("doc, message", [
    ({"component_type": "Agent", "id": "a", "name": "solo"}, "is a Agent, not a Flow"),
    ({"component_type": "Flow", "nodes": [{"$component_ref": "nope"}]}, "'nope' has no entry"),
    ([1, 2], "does not hold"),
])
def test_unreadable_files_raise_a_clear_error(tmp_path, doc, message):
    target = doc if isinstance(doc, dict) else tmp_path / "x.json"
    if not isinstance(doc, dict):
        target.write_text(json.dumps(doc))
    with pytest.raises(AgentSpecError, match=message):
        agentspec.manifest_from(target)


def test_missing_file_and_bad_yaml_raise_agentspec_error(tmp_path):
    with pytest.raises(AgentSpecError, match="can't read"):
        agentspec.structure_from(tmp_path / "missing.yaml")
    bad = tmp_path / "bad.yaml"
    bad.write_text("component_type: [unclosed\n")
    with pytest.raises(AgentSpecError, match="not valid YAML"):
        agentspec.structure_from(bad)


# ---------------------------------------------------------------- words on top of the file


def test_step_words_add_presentation_words_and_are_verified():
    words = {"route": lab.step("Pick the path", paths={"needs_change": lab.path("needs a change")}),
             "classify": lab.step(actor="person")}
    m = agentspec.manifest_from(EXAMPLE, steps=words)
    n = nodes(m)
    assert n["route"]["plain_label"] == "Pick the path" and n["route"]["label"] == "route"
    assert (n["classify"]["kind"], n["classify"]["actor"]) == ("gate", "person")   # words override the type
    assert [e for e in m["edges"] if e.get("from_branch") == "needs_change" and e["from"] == "route"][0]["plain_label"] == "needs a change"
    with pytest.raises(lab.VerificationError, match="R2"):
        lab.verify(agentspec.instrumentation_from(EXAMPLE, steps={"route": lab.step(paths={"nope": "x"})}))
    with pytest.raises(lab.VerificationError, match="R1"):
        lab.verify(agentspec.instrumentation_from(EXAMPLE, steps={"not_a_node": lab.step("x")}))


def test_app_can_be_given():
    m = agentspec.manifest_from(EXAMPLE, app=lab.App(name="Triage", id="triage-demo", baseline="~5 minutes"))
    assert m["app"] == {"id": "triage-demo", "name": "Triage", "baseline": "~5 minutes"}


# ---------------------------------------------------------------- the core seam this uses


def test_node_facts_are_defaults_that_words_override():
    s = Structure(nodes=[NodeSpec("a", label="Alpha", description="first", kind="llm", actor="ai"),
                         NodeSpec("b", kind="not-a-kind")],
                  edges=[("a", "b")])
    m = Instrumentation(s, app=lab.App(name="x")).manifest()
    a, b = nodes(m)["a"], nodes(m)["b"]
    assert (a["label"], a["description"], a["kind"], a["actor"]) == ("Alpha", "first", "llm", "ai")
    assert (b["label"], b["kind"], b["actor"]) == ("b", "step", "app")      # an unknown kind is ignored
    worded = Instrumentation(s, app=lab.App(name="x"), steps={"a": lab.step(says="said", kind="tool")}).manifest()
    assert (nodes(worded)["a"]["description"], nodes(worded)["a"]["kind"], nodes(worded)["a"]["actor"]) == ("said", "tool", "app")


def test_code_first_structures_hash_as_before():
    """A structure with no node facts has no `node_facts` in its words hash (LangGraph manifests
    don't move); a reader's findings land in the report."""
    from agentlab._util import hash_obj
    from agentlab.manifest import Finding
    plain = Instrumentation(Structure(nodes=[NodeSpec("a")]), app=lab.App(name="x"))
    expected = hash_obj({"app": {"name": "x", "description": None, "privacy_note": None, "track_record": None, "baseline": None},
                         "steps": {}, "docs": {}, "actions": [], "never": [], "panels": [], "story": None})
    assert plain.manifest()["derived"]["hashes"]["words"] == expected
    found = Instrumentation(Structure(nodes=[NodeSpec("a")], findings=(Finding("R14", "error", "bad edge", node="a"),)),
                            app=lab.App(name="x"))
    assert [f.code for f in found.report().errors] == ["R14"]


# ---------------------------------------------------------------- the CLI


def test_cli_writes_and_verifies(tmp_path, capsys):
    out = tmp_path / "map.json"
    assert agentspec.main([str(EXAMPLE), "--out", str(out), "--verify"]) == 0
    assert json.loads(out.read_text()) == agentspec.manifest_from(EXAMPLE)
    assert agentspec.main([str(BRANCHING), "--verify"]) == 1
    assert "R14" in capsys.readouterr().err
    assert agentspec.main([str(tmp_path / "missing.yaml")]) == 2


def test_cli_registers_with_a_bench():
    received = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_PUT(self):  # noqa: N802
            received["path"] = self.path
            received["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)       # an OS-assigned free port
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    try:
        assert agentspec.main([str(EXAMPLE), "--register", f"http://127.0.0.1:{server.server_port}"]) == 0
    finally:
        thread.join(5)
        server.server_close()
    assert received["path"] == "/apps/helpdesk-triage"
    assert received["body"] == {"topology": agentspec.manifest_from(EXAMPLE), "story": None}


def test_cli_app_id_sets_the_maps_app_id(tmp_path):
    out = tmp_path / "map.json"
    assert agentspec.main([str(EXAMPLE), "--app-id", "triage-svc", "--out", str(out)]) == 0
    app = json.loads(out.read_text())["app"]
    assert (app["id"], app["name"]) == ("triage-svc", "Helpdesk triage")


# ---------------------------------------------------------------- every example flow in the clone


def _clone_flows():
    root = CLONE / "pyagentspec" / "tests" / "agentspec_configs"
    if not root.is_dir():
        return []
    return sorted([*root.glob("example_serialized_flow*.yaml"), *root.glob("flow_with_*.yaml"),
                   *root.glob("example_flow_*.yaml"), *root.glob("serialized_flow_*.yaml")])


@pytest.mark.skipif(not _clone_flows(), reason="no agent-spec clone (set AGENTSPEC_CLONE)")
@pytest.mark.parametrize("flow", _clone_flows(), ids=lambda p: p.name)
def test_every_example_flow_in_the_clone_reads(flow, topology_validator):
    m = agentspec.manifest_from(flow)
    topology_validator.validate(m)
    ids = {n["id"] for n in m["nodes"]}
    assert all(e["from"] in ids and e["to"] in ids for e in m["edges"])

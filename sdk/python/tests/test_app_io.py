"""What a person reads from a run (`App(request=, reply=, requester=)`) and `instrument(structure=)`.

The request/reply fields are names of the graph's own state, so they are checked against it (R15)
like every other word: rename the state field and `verify` fails, instead of the screen quietly
showing the wrong field.
"""
from typing import Literal, TypedDict

import pytest
from langgraph.graph import END, START, StateGraph

import agentlab as lab
from agentlab import testing
from agentlab.langgraph import instrument, structure_from
from agentlab.manifest import BranchSpec, NodeSpec, Structure


class In(TypedDict, total=False):
    message: str
    requester_name: str
    requester_role: str


class Out(TypedDict, total=False):
    final_response: str


class State(In, Out, total=False):
    pass


def answer(s):
    return {"final_response": "ok"}


def build(state=State, inp=None, out=None):
    kwargs = {}
    if inp is not None:
        kwargs["input_schema"] = inp
    if out is not None:
        kwargs["output_schema"] = out
    g = StateGraph(state, **kwargs)
    g.add_node("answer", answer)
    g.add_edge(START, "answer")
    g.add_edge("answer", END)
    return g.compile()


def app(**io):
    return lab.App(name="IO", id="io-app", **io)


def test_the_graph_s_own_fields_are_read():
    s = structure_from(build())
    assert s.inputs == ["final_response", "message", "requester_name", "requester_role"]
    s = structure_from(build(inp=In, out=Out))
    assert s.inputs == ["message", "requester_name", "requester_role"] and s.outputs == ["final_response"]


def test_declared_fields_go_into_the_map():
    g = instrument(build(inp=In, out=Out), app=app(request="message", reply="final_response",
                                                   requester=("requester_name", "requester_role")))
    report = lab.verify(g)
    assert not [f for f in report.findings if f.code == "R15"]
    m = lab.manifest.find(g).manifest()
    assert m["app"]["io"] == {"request": "message", "reply": "final_response",
                              "requester": ["requester_name", "requester_role"]}


def test_a_field_the_graph_does_not_have_fails_verify():
    # the reply is an output field; naming an input-only field, or a renamed one, is R15
    g = instrument(build(inp=In, out=Out), app=app(request="text", reply="message"))
    with pytest.raises(lab.VerificationError) as e:
        lab.verify(g)
    r15 = [f for f in e.value.report.findings if f.code == "R15"]
    assert len(r15) == 2
    assert "App.request names 'text'" in r15[0].message and "message, requester_name" in r15[0].message
    assert "App.reply names 'message'" in r15[1].message and "output" in r15[1].message
    # what failed is left out of the map rather than shown wrong
    assert "io" not in lab.manifest.find(g).manifest()["app"]


def test_no_declaration_leaves_the_map_and_its_hash_as_before():
    plain = lab.manifest.find(instrument(build(), app=app())).manifest()
    assert "io" not in plain["app"]
    declared = lab.manifest.find(instrument(build(), app=app(request="message"))).manifest()
    assert plain["derived"]["hashes"]["structure"] == declared["derived"]["hashes"]["structure"]
    assert plain["derived"]["hashes"]["words"] != declared["derived"]["hashes"]["words"]


def test_a_given_structure_replaces_the_one_read_from_the_graph():
    # e.g. agentspec.structure_from(flow) for a graph pyagentspec's loader made from that flow
    given = Structure(nodes=[NodeSpec("answer", label="Answer the question", kind="llm", actor="ai"),
                             NodeSpec("done", kind="terminal")],
                      branches=[BranchSpec("answer", {"next": "done"})], source="agentspec")
    g = instrument(build(), app=app(), structure=given)
    m = lab.manifest.find(g).manifest()
    assert m["derived"]["from"] == "agentspec"
    assert [n["id"] for n in m["nodes"]] == ["answer", "done"]
    assert m["nodes"][0]["label"] == "Answer the question"
    assert m["edges"] == [{"from": "answer", "to": "done", "from_branch": "next"}]
    # and the run still records against those ids
    with testing.capture() as spans:
        g.invoke({"message": "hi"})
    assert any(s.attributes.get("agentlab.node") == "answer" for s in spans)


def test_without_a_structure_the_graph_is_read():
    g = instrument(build(), app=app())
    assert lab.manifest.find(g).manifest()["derived"]["from"] == "langgraph"

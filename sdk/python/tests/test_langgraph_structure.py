"""The map from a compiled LangGraph graph: every routing style, read with nothing typed by hand.

The matrix pins how `compiled.get_graph()` and `compiled.builder` are read (A5). Those are partly
undocumented LangGraph internals, so a LangGraph upgrade that moves them fails here first.
"""
import asyncio
import logging
import textwrap
from typing import Literal, TypedDict

import pytest
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, Send

import agentlab as lab
from agentlab.langgraph import AgentLabHandler, instrument, node_id_from_ns, structure_from
from agentlab.manifest import find

APP = lab.App(name="Matrix", id="matrix")


class S(TypedDict, total=False):
    x: int
    route: str


def a(s):
    return {}


def b(s):
    return {}


def c(s):
    return {}


def to_b_or_c(s) -> Literal["b", "c"]:
    return "b"


def goto(s) -> Command[Literal["b", "c"]]:
    return Command(goto="b")


def fan(s):
    return [Send("b", {}), Send("c", {})]


def graph(*, router=None, path_map=None, first=("a", a)):
    g = StateGraph(S)
    g.add_node(*first)
    g.add_node("b", b)
    g.add_node("c", c)
    g.add_edge(START, first[0])
    if router is not None:
        g.add_conditional_edges(first[0], router, path_map)
    g.add_edge("b", END)
    g.add_edge("c", END)
    return g.compile()


def manifest(compiled, **kw):
    return find(instrument(compiled, app=APP, **kw)).manifest()


def edges(m):
    return sorted((e["from"], e["to"], e.get("from_branch")) for e in m["edges"])


def codes(m, severity="error"):
    return sorted(w["code"] for w in m["derived"]["warnings"] if w["severity"] == severity)


def test_path_map_dict_keeps_the_branch_names():
    m = manifest(graph(router=lambda s: s["route"], path_map={"yes": "b", "no": "c"}))
    assert edges(m) == [("a", "b", "yes"), ("a", "c", "no")]
    assert codes(m) == []


def test_path_map_list_names_branches_by_target():
    m = manifest(graph(router=lambda s: s["route"], path_map=["b", "c"]))
    assert edges(m) == [("a", "b", "b"), ("a", "c", "c")]


def test_literal_return_annotation_is_a_path_map():
    m = manifest(graph(router=to_b_or_c))
    assert edges(m) == [("a", "b", "b"), ("a", "c", "c")]


@pytest.mark.parametrize("router", [lambda s: "b", fan], ids=["untyped-lambda", "send-fanout"])
def test_unknown_branches_are_an_error_not_a_guess(router):
    m = manifest(graph(router=router))
    node = next(n for n in m["nodes"] if n["id"] == "a")
    assert node["branches_unknown"] is True
    assert [e for e in m["edges"] if e["from"] == "a"] == []
    assert codes(m) == ["R3"]
    with pytest.raises(lab.VerificationError, match="branches unknown"):
        lab.verify(instrument(graph(router=router), app=APP))


def test_send_with_a_path_map_is_known():
    m = manifest(graph(router=fan, path_map=["b", "c"]))
    assert edges(m) == [("a", "b", "b"), ("a", "c", "c")]
    assert codes(m) == []


def test_command_destinations_from_the_annotation_and_from_destinations():
    m = manifest(graph(first=("d", goto)))
    assert edges(m) == [("d", "b", "b"), ("d", "c", "c")]
    g = StateGraph(S)
    g.add_node("d", lambda s: Command(goto="b"), destinations={"b": "to b", "c": "to c"})
    g.add_node("b", b)
    g.add_node("c", c)
    g.add_edge(START, "d")
    m = manifest(g.compile())
    assert edges(m) == [("d", "b", "b"), ("d", "c", "c")]      # branch id = the target the code names


def goto_unannotated(s):
    if s.get("x"):
        return Command(goto="c", update={"x": 0})
    return Command(goto="b")


def goto_bare_annotation(s) -> Command:
    return handoff("b")


def handoff(target):
    return Command(goto=target)


def only_updates(s) -> Command:
    return Command(update={"x": 1})


@lab.step("Hand off", actor="ai")
def goto_worded(s):
    return Command(goto="b")


@pytest.mark.parametrize("node", [goto_unannotated, goto_bare_annotation, goto_worded,
                                  lambda s: Command(goto="b")],
                         ids=["unannotated", "bare-Command-annotation", "under-lab.step", "lambda"])
def test_unannotated_command_routing_is_r3_not_a_dead_end(node):
    """A node that moves on with Command(goto=...) and nothing LangGraph can read about where:
    SPEC 8.7's R3, never a step drawn with no exits that passes verify."""
    m = manifest(graph(first=("d", node)))
    d = next(n for n in m["nodes"] if n["id"] == "d")
    assert d["branches_unknown"] is True
    assert [e for e in m["edges"] if e["from"] == "d"] == []
    assert codes(m) == ["R3"]
    r3 = next(w for w in m["derived"]["warnings"] if w["code"] == "R3")
    assert r3["node"] == "d" and 'Command[Literal["a", "b"]]' in r3["message"] and "destinations=" in r3["message"]
    with pytest.raises(lab.VerificationError, match="branches unknown"):
        lab.verify(instrument(graph(first=("d", node)), app=APP))


def test_command_routing_without_source_is_read_from_the_bytecode():
    """A node defined where there's no source to read (a REPL, `python -`, exec'd code)."""
    ns = {"Command": Command}
    exec(compile("def routes(s):\n    return Command(goto='b')\n"
                 "def updates(s):\n    return Command(update={'x': 1})\n", "<no source>", "exec"), ns)
    m = manifest(graph(first=("d", ns["routes"])))
    assert codes(m) == ["R3"]
    g = StateGraph(S)
    g.add_node("d", ns["updates"])
    g.add_node("b", b)
    g.add_edge(START, "d")
    g.add_edge("d", "b")
    assert codes(manifest(g.compile())) == []


def test_annotated_command_routing_is_clean_and_drawn():
    compiled = graph(first=("d", goto))
    m = manifest(compiled)
    assert edges(m) == [("d", "b", "b"), ("d", "c", "c")]
    assert codes(m) == []
    lab.verify(instrument(graph(first=("d", goto)), app=APP))      # raises on any error


def test_a_command_that_only_updates_or_a_nested_helper_is_not_routing():
    def with_inner_helper(s):
        def later():
            return Command(goto="c")       # a nested def is not this node's return
        return {}

    for node in (only_updates, with_inner_helper):
        g = StateGraph(S)
        g.add_node("d", node)
        g.add_node("b", b)
        g.add_edge(START, "d")
        g.add_edge("d", "b")
        m = manifest(g.compile())
        assert codes(m) == [], node.__name__
        assert ("d", "b", None) in edges(m)
        assert "branches_unknown" not in next(n for n in m["nodes"] if n["id"] == "d")


def test_many_to_one_and_end_branches():
    m = manifest(graph(router=lambda s: s["route"], path_map={"yes": "b", "maybe": "b", "no": "c", "stop": END}))
    assert edges(m) == [("a", "__end__", "stop"), ("a", "b", "maybe"), ("a", "b", "yes"), ("a", "c", "no")]
    end = next(n for n in m["nodes"] if n["id"] == "__end__")
    assert end["kind"] == "terminal" and end["label"] == "end"
    assert "R5" in codes(m, "info")


def test_bool_branch_labels():
    m = manifest(graph(router=lambda s: bool(s.get("x")), path_map={True: "b", False: "c"}))
    assert edges(m) == [("a", "b", "True"), ("a", "c", "False")]


def test_fan_in_waiting_edges_are_plain_edges():
    g = StateGraph(S)
    for name, fn in (("a", a), ("b", b), ("c", c)):
        g.add_node(name, fn)
    g.add_edge(START, "a")
    g.add_edge(START, "b")
    g.add_edge(["a", "b"], "c")
    g.add_edge("c", END)
    assert edges(manifest(g.compile())) == [("a", "c", None), ("b", "c", None)]


def test_subgraph_nodes_are_container_slash_inner():
    sub = StateGraph(S)
    sub.add_node("inner", b)
    sub.add_node("more", c)
    sub.add_edge(START, "inner")
    sub.add_conditional_edges("inner", lambda s: s["route"], {"again": "more", "done": END})
    sub.add_edge("more", END)
    g = StateGraph(S)
    g.add_node("a", a)
    g.add_node("sub", sub.compile())
    g.add_edge(START, "a")
    g.add_edge("a", "sub")
    g.add_edge("sub", END)
    m = manifest(g.compile())
    by_id = {n["id"]: n for n in m["nodes"]}
    assert list(by_id) == ["a", "sub", "sub/inner", "sub/more"]
    assert by_id["sub/inner"]["parent"] == "sub" and by_id["sub/inner"]["label"] == "inner"
    # inside a subgraph, its END is the way back out to the container
    assert edges(m) == [("a", "sub", None), ("sub/inner", "sub", "done"), ("sub/inner", "sub/more", "again")]


def test_words_and_docstring_are_read_off_the_function_langgraph_wraps():
    @lab.step("Do the thing", actor="ai", paths={"yes": lab.path("agreed")})
    def worded(s):
        """Engineering text."""
        return {}

    async def async_node(s):
        """An async node's docstring."""
        return {}

    g = StateGraph(S)
    g.add_node("worded", worded)
    g.add_node("b", lab.step("Async step")(async_node))
    g.add_node("c", c)
    g.add_edge(START, "worded")
    g.add_conditional_edges("worded", lambda s: s["route"], {"yes": "b", "no": "c"})
    m = manifest(g.compile())
    by_id = {n["id"]: n for n in m["nodes"]}
    assert by_id["worded"]["plain_label"] == "Do the thing" and by_id["worded"]["doc"] == "Engineering text."
    assert by_id["worded"]["kind"] == "llm" and by_id["worded"]["actor"] == "ai"
    assert by_id["b"]["plain_label"] == "Async step" and by_id["b"]["doc"] == "An async node's docstring."
    yes = next(e for e in m["edges"] if e.get("from_branch") == "yes")
    assert yes["plain_label"] == "agreed"


def test_the_manifest_is_a_valid_bench_map(topology_validator):
    m = manifest(graph(router=lambda s: s["route"], path_map={"yes": "b", "no": "c", "stop": END}))
    assert m["derived"]["from"] == "langgraph"
    assert m["derived"]["framework"].startswith("langgraph 1.")
    assert not list(topology_validator.iter_errors(m))


def test_instrument_returns_the_same_graph_with_one_handler():
    compiled = graph(router=to_b_or_c)
    out = instrument(compiled, app=APP)
    assert out.builder is compiled.builder
    assert out.invoke({"x": 1}) == {"x": 1}
    again = instrument(out, app=lab.App(name="Second", id="second"))
    handlers = [h for h in again.config["callbacks"] if isinstance(h, AgentLabHandler)]
    assert len(handlers) == 1 and find(again).app.id == "second"


def test_instrument_keeps_the_apps_own_callbacks():
    from langchain_core.callbacks import BaseCallbackHandler

    class Mine(BaseCallbackHandler):
        pass

    mine = Mine()
    out = instrument(graph(router=to_b_or_c).with_config(callbacks=[mine]), app=APP)
    assert mine in out.config["callbacks"]
    out2 = instrument(out, app=APP)
    assert mine in out2.config["callbacks"]


def test_instrument_never_raises_and_verify_then_fails_loudly(caplog):
    builder = StateGraph(S)          # not compiled: a likely mistake
    with caplog.at_level(logging.WARNING, logger="agentlab"):
        out = instrument(builder, app=APP)
    assert out is builder
    assert any("runs without Agent Lab" in r.getMessage() for r in caplog.records)
    with pytest.raises(TypeError, match="not instrumented"):
        lab.verify(out)


def test_structure_from_rejects_a_non_graph():
    with pytest.raises(TypeError, match="compiled StateGraph"):
        structure_from(object())


def test_relative_lock_and_story_resolve_against_the_calling_file(tmp_path):
    (tmp_path / "story.js").write_text("export default {}")
    module = tmp_path / "myapp.py"
    module.write_text(textwrap.dedent("""
        from typing import TypedDict
        from langgraph.graph import StateGraph, START, END
        import agentlab as lab
        from agentlab.langgraph import instrument

        class S(TypedDict, total=False):
            x: int

        @lab.step("A")
        def a(s):
            return {}

        def build():
            g = StateGraph(S)
            g.add_node("a", a)
            g.add_edge(START, "a")
            g.add_edge("a", END)
            return instrument(g.compile(), app=lab.App(name="m"), lock="agentlab.lock.json",
                              story=lab.Story(file="story.js"))
    """))
    import importlib.util
    spec = importlib.util.spec_from_file_location("myapp_lockdir", module)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    g = mod.build()
    assert find(g).lock_path == tmp_path / "agentlab.lock.json"
    assert "story" in find(g).manifest()
    assert lab.lock(g) == tmp_path / "agentlab.lock.json"
    assert find(mod.build()).report().fingerprints == {"node:a": "confirmed"}


def test_node_ids_from_checkpoint_namespaces():
    assert node_id_from_ns("classify:1b2c-3d") == "classify"
    assert node_id_from_ns("sub:aa|inner:bb") == "sub/inner"
    assert node_id_from_ns("a:1|b:2|c:3") == "a/b/c"


def test_async_graphs_are_read_the_same():
    async def n(s):
        return {}

    g = StateGraph(S)
    g.add_node("n", n)
    g.add_edge(START, "n")
    g.add_edge("n", END)
    out = instrument(g.compile(), app=APP)
    assert asyncio.run(out.ainvoke({"x": 1})) == {"x": 1}
    assert [n["id"] for n in find(out).manifest()["nodes"]] == ["n"]

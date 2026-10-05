"""LangGraph integration: the map from the compiled graph, every span attributed by LangGraph itself.

    import agentlab as lab
    from agentlab.langgraph import instrument

    graph = instrument(builder.compile(checkpointer=...), app=lab.App(name="Support assistant"))

What `instrument` derives, with nothing typed by hand (SPEC.md 8.5):
- **Structure** from the graph: nodes from `compiled.get_graph()`, plain edges from it, branches from
  `compiled.builder.branches` (every path-map label, many-to-one included), `Command` destinations
  from `builder.nodes[n].ends` (a node that routes with `Command(goto=...)` and no readable
  destinations is R3), a subgraph's nodes from its own builder as `container/inner`.
- **Words** from `@lab.step(...)` on each node function (and its docstring), read off the function
  LangGraph holds, so renaming a node carries its words along.
- **Attribution** at runtime from LangGraph's own callback metadata (`langgraph_node`,
  `langgraph_checkpoint_ns`): a run span per invoke, a node span per node execution, and every
  model call, tool call and fact (`lab.decision`, `lab.check`, ...) under the node that made it.
  No node id is ever passed by the app.

It returns `compiled.with_config(callbacks=[handler])`: the same compiled graph (builder intact),
so `lab.verify(graph)` and `python -m agentlab verify` find the words to check.
"""
from __future__ import annotations

import ast
import dataclasses
import inspect
import os
import re
import sys
import textwrap
import threading
import time
import types
import typing
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version as _dist_version
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from uuid import UUID

try:
    from langchain_core.callbacks import BaseCallbackManager
    from langgraph.callbacks import GraphCallbackHandler
    from langgraph.config import get_config
    from langgraph.errors import GraphBubbleUp, GraphInterrupt
    from langgraph.graph import StateGraph
    from langgraph.pregel import Pregel
    from langgraph.types import Command
except ImportError as e:  # pragma: no cover - exercised only without the extra installed
    raise ImportError("agentlab.langgraph needs LangGraph: install agentlab[langgraph]") from e

from . import _context
from . import _state
from ._runtime import MISSING, Run, RunIds, record_chat, record_tool, start_run
from ._context import Target
from ._util import log, log_once, to_jsonable
from .manifest import END, START, BranchSpec, Instrumentation, NodeSpec, Structure, find
from .words import App, StepWords, Story

__all__ = ["instrument", "structure_from", "AgentLabHandler"]


# ---------------------------------------------------------------- structure


def _framework() -> str:
    try:
        return f"langgraph {_dist_version('langgraph')}"
    except PackageNotFoundError:  # pragma: no cover
        return "langgraph"


def _user_func(runnable: Any) -> Any:
    """The function the app wrote, from what LangGraph wraps it in (RunnableCallable/RunnableLambda);
    any other runnable is its own "function" (words can still be attached to it)."""
    return getattr(runnable, "func", None) or getattr(runnable, "afunc", None) or runnable


def _subgraph(runnable: Any) -> Pregel | None:
    """A node that is itself a compiled StateGraph (a subgraph added as a node)."""
    if isinstance(runnable, Pregel) and isinstance(getattr(runnable, "builder", None), StateGraph):
        return runnable
    return None


COMMAND_HINT = ('it routes with Command(goto=...) and its destinations can\'t be read: annotate it '
                '-> Command[Literal["a", "b"]] or pass add_node(..., destinations=("a", "b"))')


def _returns_command(func: Any) -> bool | None:
    """Whether the return annotation is a `Command` (bare, `Command[...]`, or in a Union); None if
    there is none. A `Command[Literal[...]]` LangGraph could read never gets here (its ends are set)."""
    try:
        hints = typing.get_type_hints(func)
        rtn = hints.get("return", inspect.Signature.empty)
    except Exception:  # noqa: BLE001 - an unresolvable annotation (a forward ref, a string) is read raw
        rtn = getattr(func, "__annotations__", {}).get("return", inspect.Signature.empty)
    if rtn is inspect.Signature.empty or rtn is None:
        return None
    if isinstance(rtn, str):
        return bool(re.search(r"\bCommand\b", rtn))
    candidates = typing.get_args(rtn) if typing.get_origin(rtn) in (typing.Union, types.UnionType) else (rtn,)
    return any(c is Command or typing.get_origin(c) is Command for c in candidates)


def _command_calls(func: Any) -> list[bool] | None:
    """For each `Command(...)` built in the function's own body (not in a nested def or lambda),
    whether it can route: it passes `goto=` (or `**kwargs`, which can't be read). None when the
    source can't be read or parsed."""
    try:
        src = textwrap.dedent(inspect.getsource(func))
    except Exception:  # noqa: BLE001 - a REPL, `python -`, exec'd code: read the bytecode instead
        return _command_calls_in_code(func)
    try:
        tree = ast.parse(src)
    except SyntaxError:
        tree = _lambda_tree(src) if func.__name__ == "<lambda>" else None
        if tree is None:
            return _command_calls_in_code(func)
    root = next((n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))), None)
    if root is None:
        return None
    scope = dict(getattr(func, "__globals__", {}) or {})
    try:
        scope.update(inspect.getclosurevars(func).nonlocals)
    except Exception:  # noqa: BLE001
        pass

    def is_command(callee: ast.expr) -> bool:
        parts: list[str] = []
        while isinstance(callee, ast.Attribute):
            parts.insert(0, callee.attr)
            callee = callee.value
        if not isinstance(callee, ast.Name):
            return False
        parts.insert(0, callee.id)
        obj: Any = scope.get(parts[0], _UNRESOLVED)
        for part in parts[1:]:
            obj = getattr(obj, part, _UNRESOLVED) if obj is not _UNRESOLVED else obj
        if obj is not _UNRESOLVED:
            return obj is Command
        return parts[-1] == "Command"

    found: list[bool] = []
    stack = list(ast.iter_child_nodes(root))
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue   # a nested helper's Command is not this node's return
        if isinstance(n, ast.Call) and is_command(n.func):
            found.append(any(k.arg in ("goto", None) for k in n.keywords))
        stack.extend(ast.iter_child_nodes(n))
    return found


_UNRESOLVED = object()


def _command_calls_in_code(func: Any) -> list[bool] | None:
    """The same question from the compiled code when there is no source: does the function's own
    code (nested functions are separate code objects, so not theirs) name `Command`, and does it
    make a call with a `goto=` keyword (the keyword names are a constant tuple)? One entry, or []
    when it never names `Command`."""
    code = getattr(func, "__code__", None)
    if code is None:
        return None
    scope = getattr(func, "__globals__", {}) or {}
    cells = dict(zip(code.co_freevars, getattr(func, "__closure__", None) or ()))

    def resolves(name: str) -> bool:
        if name in cells:
            try:
                return cells[name].cell_contents is Command
            except ValueError:
                return False
        obj = scope.get(name, _UNRESOLVED)
        return obj is Command or (obj is _UNRESOLVED and name == "Command")

    names = list(code.co_names) + list(code.co_freevars)
    if not any(resolves(n) or n == "Command" for n in names):
        return []
    goto = any(isinstance(c, tuple) and "goto" in c for c in code.co_consts)
    return [goto]


def _lambda_tree(src: str) -> ast.AST | None:
    """A lambda's source is the lines it sits on, often a fragment of a larger call
    (`g.add_node("d", lambda s: ...)` split over lines): the first `lambda ...` in it that parses
    as an expression on its own."""
    start = src.find("lambda")
    while start >= 0:
        text = src[start:start + 2000]
        for end in range(len(text), 0, -1):
            try:
                return ast.parse(text[:end].strip(), mode="eval")
            except SyntaxError:
                continue
        start = src.find("lambda", start + 1)
    return None


def _routes_by_command(func: Any) -> bool:
    """A node that moves on with `Command(goto=...)` and has no readable destinations (SPEC 8.7, R3):
    its body builds a `Command` with `goto=`, or it is annotated `-> Command` and its body builds no
    `Command` itself (it returns one made elsewhere). A body whose every `Command` only updates or
    resumes doesn't route. Anything that can't be read (a subgraph, a runnable, no source) is no
    claim: never a false error."""
    if not (inspect.isfunction(func) or inspect.ismethod(func)):
        return False
    calls = _command_calls(func)
    annotated = _returns_command(func)
    if calls is None:
        return bool(annotated)
    return any(calls) or (bool(annotated) and not calls)


def structure_from(compiled: Any) -> Structure:
    """Read a compiled StateGraph into a framework-neutral `Structure` (no words, nothing typed).

    Raises on anything that isn't a compiled StateGraph; `instrument` catches that."""
    if not isinstance(getattr(compiled, "builder", None), StateGraph):
        raise TypeError(f"expected a compiled StateGraph (what StateGraph.compile() returns), "
                        f"got {type(compiled).__name__}")
    nodes: list[NodeSpec] = []
    edges: list[tuple[str, str]] = []
    branches: list[BranchSpec] = []
    _read(compiled, "", None, nodes, edges, branches)
    return Structure(nodes=nodes, edges=edges, branches=branches, source="langgraph", framework=_framework(),
                     inputs=_fields(compiled.get_input_jsonschema), outputs=_fields(compiled.get_output_jsonschema))


def _fields(schema_of: Callable[[], Mapping[str, Any]]) -> list[str] | None:
    """The top-level field names of the graph's input or output state, None when its schema
    can't be read or names none (then App.request/reply/requester are not checked)."""
    try:
        props = schema_of().get("properties")
    except Exception:  # noqa: BLE001 - an exotic state schema only means "not checked"
        return None
    return sorted(props) if isinstance(props, Mapping) and props else None


def _read(compiled: Any, prefix: str, container: str | None, nodes: list[NodeSpec],
          edges: list[tuple[str, str]], branches: list[BranchSpec]) -> None:
    """One graph level. At the top level START/END pass through raw (the manifest drops them and
    synthesizes `__end__`); inside a subgraph, START edges and END edges are dropped and a branch
    to END leads back to the container (control leaves the subgraph there)."""
    builder: StateGraph = compiled.builder
    drawn = compiled.get_graph()

    def nid(name: str) -> str:
        if name == START:
            return START
        if name == END:
            return END if container is None else container
        return f"{prefix}{name}"

    for name in drawn.nodes:
        if name in (START, END):
            continue
        spec = builder.nodes.get(name)
        runnable = spec.runnable if spec is not None else drawn.nodes[name].data
        nodes.append(NodeSpec(id=nid(name), func=_user_func(runnable), parent=container))
        sub = _subgraph(runnable)
        if sub is not None:
            _read(sub, f"{nid(name)}/", nid(name), nodes, edges, branches)

    for edge in drawn.edges:
        if edge.conditional:
            continue
        if container is not None and (edge.source == START or edge.target == END):
            continue
        edges.append((nid(edge.source), nid(edge.target)))

    for source, by_name in builder.branches.items():
        for spec in by_name.values():
            ends = None if spec.ends is None else {label: nid(target) for label, target in spec.ends.items()}
            branches.append(BranchSpec(source=nid(source), ends=ends, router=_user_func(spec.path)))

    for name, spec in builder.nodes.items():
        if spec.ends:   # Command destinations: from `Command[Literal[...]]` or add_node(destinations=)
            branches.append(BranchSpec(source=nid(name), ends={t: nid(t) for t in spec.ends}, router=None))
        elif _routes_by_command(_user_func(spec.runnable)):
            # It moves on with `Command(goto=...)` and nothing says where: R3, never a guess.
            branches.append(BranchSpec(source=nid(name), ends=None, router=None, hint=COMMAND_HINT))


# ---------------------------------------------------------------- runtime: the callback handler


def node_id_from_ns(ns: str) -> str:
    """`a:<task>` -> `a`; `sub:<task>|inner:<task>` -> `sub/inner` (SPEC.md 8.2)."""
    return "/".join(seg.partition(":")[0] for seg in ns.split("|") if seg)


@dataclass
class _Node:
    id: str
    ns: str
    span: Any
    target: Target


@dataclass
class _Run:
    run: Run
    root: UUID
    members: set = field(default_factory=set)            # every LangChain run id inside this run
    nodes: dict = field(default_factory=dict)            # raw checkpoint ns -> _Node (open)
    opened_by: dict = field(default_factory=dict)        # LangChain run id that opened a node -> _Node
    interrupts: set = field(default_factory=set)         # Interrupt ids already reported

    def target(self, metadata: Mapping[str, Any] | None) -> Target:
        """The open node a callback (or a fact) with this metadata belongs to, else the run."""
        ns = (metadata or {}).get("langgraph_checkpoint_ns")
        if ns:
            node = self.nodes.get(ns)
            if node is not None:
                return node.target
            return self.run.target(None, node_id_from_ns(ns))
        return self.run.target()


@dataclass
class _Call:
    """A model or tool call in flight: what its span needs at the end."""
    target: Target
    start: int
    data: dict


def _is_resume(inputs: Any) -> bool:
    """A resume continues a paused thread: `Command(resume=...)`, or `None` (continue from the
    checkpoint, e.g. after a static breakpoint). `Command(update=...)` alone is a fresh input."""
    if inputs is None:
        return True
    return isinstance(inputs, Command) and inputs.resume is not None


def _interrupts(error: BaseException) -> list[Any]:
    found = error.args[0] if error.args else ()
    return list(found) if isinstance(found, (list, tuple)) else []


class AgentLabHandler(GraphCallbackHandler):
    """Turns LangGraph's callbacks into Agent Lab's spans. Made by `instrument`; one per graph.

    Runs inline (span start and end happen on the run's own thread, at the callback's moment).
    Holds state per run, keyed by LangChain run ids, so concurrent invokes never mix. With Agent
    Lab off every callback returns after one flag check. Never raises."""

    run_inline = True
    raise_error = False

    def __init__(self, instrumentation: Instrumentation, *, graph_name: str, llm_spans: bool = True):
        super().__init__()
        self.agentlab_instrumentation = instrumentation
        self._graph_name = graph_name
        self._llm_spans = llm_spans
        self._ids = RunIds()
        self._lock = threading.Lock()
        self._runs: dict[UUID, _Run] = {}         # LangChain run id (any member) -> its run
        self._calls: dict[UUID, _Call] = {}

    # -- lookups used by the facts resolver

    def target_for(self, parent_run_id: UUID | None, metadata: Mapping[str, Any] | None) -> Target | None:
        if parent_run_id is None:
            return None
        with self._lock:
            rec = self._runs.get(parent_run_id)
            return rec.target(metadata) if rec is not None else None

    # -- chains: the run and its nodes

    def on_chain_start(self, serialized: Any, inputs: Any, *, run_id: UUID, parent_run_id: UUID | None = None,
                       tags: Any = None, metadata: dict | None = None, **kwargs: Any) -> None:
        if not _state.STATE.enabled:
            return
        try:
            name = kwargs.get("name")
            md = metadata or {}
            with self._lock:
                rec = self._runs.get(parent_run_id) if parent_run_id is not None else None
            if rec is None:
                if parent_run_id is None or name == self._graph_name:
                    self._start_run(inputs, run_id, md)
                return
            with self._lock:
                rec.members.add(run_id)
                self._runs[run_id] = rec
                node = md.get("langgraph_node")
                ns = md.get("langgraph_checkpoint_ns")
                if not node or not ns or name != node or ns in rec.nodes:
                    return        # a runnable inside a node (or the subgraph's own chain): not a node
                parent_ns = ns.rpartition("|")[0]
                parent = rec.nodes.get(parent_ns) if parent_ns else None
            node_id = node_id_from_ns(ns)
            step = md.get("langgraph_step")
            span = rec.run.open_node(node_id, parent=parent.span if parent else None,
                                     step=step if isinstance(step, int) else None, ns=ns)
            entry = _Node(id=node_id, ns=ns, span=span, target=rec.run.target(span, node_id))
            with self._lock:
                rec.nodes[ns] = entry
                rec.opened_by[run_id] = entry
        except Exception as e:  # noqa: BLE001
            log_once("langgraph", f"on_chain_start: {type(e).__name__}: {e}")

    def _start_run(self, inputs: Any, run_id: UUID, md: Mapping[str, Any]) -> None:
        inst = self.agentlab_instrumentation
        thread = md.get("thread_id")
        thread = None if thread is None else str(thread)
        resume = _is_resume(inputs)
        session = md.get("session_id")
        run = start_run(app_id=inst.app_id(), run_id=self._ids.begin(thread, resume=resume),
                        manifest=inst.manifest_doc(), thread=thread, resume=resume,
                        input=MISSING if resume else inputs,
                        session_id=None if session is None else str(session))
        if run is None:
            return
        rec = _Run(run=run, root=run_id, members={run_id})
        with self._lock:
            self._runs[run_id] = rec

    def on_chain_end(self, outputs: Any, *, run_id: UUID, **kwargs: Any) -> None:
        if not self._runs:
            return
        try:
            self._end(run_id, output=outputs)
        except Exception as e:  # noqa: BLE001
            log_once("langgraph", f"on_chain_end: {type(e).__name__}: {e}")

    def on_chain_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        if not self._runs:
            return
        try:
            self._end(run_id, error=error)
        except Exception as e:  # noqa: BLE001
            log_once("langgraph", f"on_chain_error: {type(e).__name__}: {e}")

    def _end(self, run_id: UUID, *, output: Any = MISSING, error: BaseException | None = None) -> None:
        with self._lock:
            rec = self._runs.get(run_id)
            if rec is None:
                return
            node = rec.opened_by.pop(run_id, None)
            if node is not None:
                rec.nodes.pop(node.ns, None)
            leftover: list[_Node] = []
            if run_id == rec.root:
                for member in rec.members:
                    self._runs.pop(member, None)
                leftover = list(rec.opened_by.values())     # nodes whose end never came (a stream
                rec.opened_by.clear()                       # the caller stopped reading)
                rec.nodes.clear()
                for key in [k for k, c in self._calls.items() if c.target.run is rec.run]:
                    self._calls.pop(key, None)
            else:
                rec.members.discard(run_id)
                self._runs.pop(run_id, None)
        if node is not None:
            self._end_node(rec, node, error)
        for orphan in leftover:
            rec.run.end_node(orphan.span)
        if run_id == rec.root:
            if isinstance(error, GraphInterrupt):
                self._gate(rec, rec.run.span, error)
            if isinstance(error, GraphBubbleUp):
                error = None
            paused = rec.run.paused
            rec.run.finish(output=MISSING if paused or error is not None else output, error=error)

    def _end_node(self, rec: _Run, node: _Node, error: BaseException | None) -> None:
        if isinstance(error, GraphInterrupt):
            self._gate(rec, node.span, error)
        if isinstance(error, GraphBubbleUp):     # an interrupt or a jump to the parent graph: not a failure
            error = None
        rec.run.end_node(node.span, error=error)

    def _gate(self, rec: _Run, span: Any, error: GraphInterrupt) -> None:
        """One `agentlab.gate.waiting` per interrupt, on the innermost node that raised it (the
        same interrupt bubbles through every container node and the run)."""
        found = _interrupts(error)
        ids = {str(getattr(i, "id", id(i))) for i in found}
        with self._lock:
            fresh = not ids or not ids <= rec.interrupts
            rec.interrupts |= ids
        if fresh:
            rec.run.gate_waiting(span, getattr(found[0], "value", None) if found else None)
        else:
            rec.run.mark_paused()

    def on_interrupt(self, event: Any) -> None:
        """LangGraph's lifecycle event: also covers static breakpoints (`interrupt_before`), which
        pause the run without any node raising."""
        if not self._runs:
            return
        try:
            with self._lock:
                rec = self._runs.get(event.run_id) if event.run_id is not None else None
            if rec is not None:
                rec.run.mark_paused()
        except Exception as e:  # noqa: BLE001
            log_once("langgraph", f"on_interrupt: {type(e).__name__}: {e}")

    # -- model calls

    def on_chat_model_start(self, serialized: Any, messages: Any, *, run_id: UUID,
                            parent_run_id: UUID | None = None, metadata: dict | None = None,
                            **kwargs: Any) -> None:
        if not self._llm_spans or not _state.STATE.enabled:
            return
        try:
            target = self.target_for(parent_run_id, metadata)
            if target is None:
                return
            batch = messages[0] if messages else []
            options = kwargs.get("options") or {}
            fmt = options.get("ls_structured_output_format") if isinstance(options, Mapping) else None
            self._calls[run_id] = _Call(target, time.time_ns(), {
                "messages": batch, "metadata": dict(metadata or {}),
                "params": dict(kwargs.get("invocation_params") or {}),
                "json_schema": fmt.get("schema") if isinstance(fmt, Mapping) else None})
        except Exception as e:  # noqa: BLE001
            log_once("langgraph", f"on_chat_model_start: {type(e).__name__}: {e}")

    def on_llm_start(self, serialized: Any, prompts: list[str], *, run_id: UUID,
                     parent_run_id: UUID | None = None, metadata: dict | None = None, **kwargs: Any) -> None:
        """A completion-style LLM (not a chat model): its prompts are recorded as user messages."""
        if not self._llm_spans or not _state.STATE.enabled:
            return
        try:
            target = self.target_for(parent_run_id, metadata)
            if target is None:
                return
            self._calls[run_id] = _Call(target, time.time_ns(), {
                "prompts": list(prompts or ()), "metadata": dict(metadata or {}),
                "params": dict(kwargs.get("invocation_params") or {}), "json_schema": None})
        except Exception as e:  # noqa: BLE001
            log_once("langgraph", f"on_llm_start: {type(e).__name__}: {e}")

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        call = self._calls.pop(run_id, None) if self._calls else None
        if call is not None:
            try:
                self._chat_span(call, response=response)
            except Exception as e:  # noqa: BLE001
                log_once("langgraph", f"on_llm_end: {type(e).__name__}: {e}")

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        call = self._calls.pop(run_id, None) if self._calls else None
        if call is not None:
            try:
                self._chat_span(call, error=error)
            except Exception as e:  # noqa: BLE001
                log_once("langgraph", f"on_llm_error: {type(e).__name__}: {e}")

    def _chat_span(self, call: _Call, *, response: Any = None, error: BaseException | None = None) -> None:
        d, md, params = call.data, call.data["metadata"], call.data["params"]
        if "prompts" in d:
            system, messages = None, [{"role": "user", "parts": [{"type": "text", "content": p}]} for p in d["prompts"]]
        else:
            system, messages = _messages(d["messages"])
        message, info, llm_output = _generation(response)
        meta = dict(getattr(message, "response_metadata", None) or {})
        request_model = md.get("ls_model_name") or params.get("model") or params.get("model_name")
        model = meta.get("model_name") or meta.get("model") or (llm_output or {}).get("model_name") or request_model
        finish = meta.get("stop_reason") or meta.get("finish_reason") or (info or {}).get("finish_reason")
        usage = _usage(message, llm_output)
        output = None
        if message is not None:
            output = [_message(message, finish)]
        elif response is not None and info is not None:
            output = [{"role": "assistant", "parts": [{"type": "text", "content": info.get("text", "")}]}]
        record_chat(call.target, model=None if model is None else str(model),
                    provider=None if md.get("ls_provider") is None else str(md["ls_provider"]),
                    request_model=None if request_model is None else str(request_model),
                    input_tokens=usage.get("input"), output_tokens=usage.get("output"),
                    cache_read=usage.get("cache_read"), cache_write=usage.get("cache_write"),
                    finish_reasons=[str(finish)] if finish else None, system=system,
                    messages=messages or None, output=output, json_schema=d.get("json_schema"),
                    start_time=call.start, end_time=time.time_ns(), error=error)

    # -- tool calls

    def on_tool_start(self, serialized: Any, input_str: str, *, run_id: UUID, parent_run_id: UUID | None = None,
                      metadata: dict | None = None, inputs: dict | None = None, **kwargs: Any) -> None:
        if not _state.STATE.enabled:
            return
        try:
            with self._lock:
                rec = self._runs.get(parent_run_id) if parent_run_id is not None else None
                if rec is None:
                    return
                target = rec.target(metadata)
                rec.members.add(run_id)          # a tool may call a model or a chain of its own
                self._runs[run_id] = rec
            name = kwargs.get("name") or (serialized or {}).get("name") or "tool"
            self._calls[run_id] = _Call(target, time.time_ns(), {
                "name": str(name), "call_id": kwargs.get("tool_call_id"),
                "arguments": inputs if inputs is not None else input_str})
        except Exception as e:  # noqa: BLE001
            log_once("langgraph", f"on_tool_start: {type(e).__name__}: {e}")

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._tool_done(run_id, result=output)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._tool_done(run_id, error=error)

    def _tool_done(self, run_id: UUID, *, result: Any = MISSING, error: BaseException | None = None) -> None:
        if not self._calls:
            return
        try:
            call = self._calls.pop(run_id, None)
            with self._lock:
                rec = self._runs.pop(run_id, None)
                if rec is not None:
                    rec.members.discard(run_id)
            if call is None:
                return
            if result is not MISSING:
                result = getattr(result, "content", result)      # a ToolMessage: its content
            record_tool(call.target, name=call.data["name"], call_id=call.data["call_id"],
                        arguments=call.data["arguments"], result=result, start_time=call.start,
                        end_time=time.time_ns(), error=error)
        except Exception as e:  # noqa: BLE001
            log_once("langgraph", f"on_tool_end: {type(e).__name__}: {e}")


# ---------------------------------------------------------------- LangChain messages -> GenAI semconv


_ROLES = {"human": "user", "ai": "assistant", "system": "system", "tool": "tool", "function": "tool"}


def _parts(content: Any) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "text", "content": content}] if content else []
    parts = []
    for block in content or ():
        if isinstance(block, str):
            parts.append({"type": "text", "content": block})
        elif isinstance(block, Mapping) and block.get("type") == "text":
            parts.append({"type": "text", "content": str(block.get("text", ""))})
        else:
            parts.append(to_jsonable(block))
    return parts


def _message(msg: Any, finish: Any = None) -> dict:
    role = _ROLES.get(getattr(msg, "type", ""), getattr(msg, "type", None) or "user")
    if role == "tool":
        parts = [{"type": "tool_call_response", "id": getattr(msg, "tool_call_id", None),
                  "response": to_jsonable(getattr(msg, "content", None))}]
    else:
        parts = _parts(getattr(msg, "content", None))
        for call in getattr(msg, "tool_calls", None) or ():
            parts.append({"type": "tool_call", "id": call.get("id"), "name": call.get("name"),
                          "arguments": to_jsonable(call.get("args"))})
    out: dict[str, Any] = {"role": role, "parts": parts}
    if finish:
        out["finish_reason"] = str(finish)
    return out


def _messages(batch: Sequence[Any]) -> tuple[list[dict] | None, list[dict]]:
    """(system instructions as parts, the other messages), in GenAI semconv shape."""
    system: list[dict] = []
    messages: list[dict] = []
    for msg in batch or ():
        if getattr(msg, "type", None) == "system":
            system.extend(_parts(getattr(msg, "content", None)))
        else:
            messages.append(_message(msg))
    return (system or None), messages


def _generation(response: Any) -> tuple[Any, dict | None, dict | None]:
    """(the output message, its generation_info, the response's llm_output), each maybe None."""
    if response is None:
        return None, None, None
    llm_output = getattr(response, "llm_output", None)
    gens = getattr(response, "generations", None) or []
    first = gens[0][0] if gens and gens[0] else None
    if first is None:
        return None, None, llm_output
    info = dict(getattr(first, "generation_info", None) or {})
    info.setdefault("text", getattr(first, "text", ""))
    return getattr(first, "message", None), info, llm_output


def _usage(message: Any, llm_output: Mapping | None) -> dict:
    """Token counts. LangChain's `usage_metadata.input_tokens` is already the TOTAL input, cache
    included (langchain-anthropic adds cache reads and writes back in; checked 10-03-26), which is
    the GenAI convention, so it is used as is. Cache writes are `cache_creation`, or the sum of
    the per-TTL `ephemeral_*` keys (langchain-anthropic zeroes the generic key when it has them)."""
    um = getattr(message, "usage_metadata", None)
    if um:
        details = um.get("input_token_details") or {}
        write = details.get("cache_creation") or sum(
            v for k, v in details.items() if k.startswith("ephemeral_") and isinstance(v, int)) or None
        return {"input": um.get("input_tokens"), "output": um.get("output_tokens"),
                "cache_read": details.get("cache_read"), "cache_write": write}
    usage = (llm_output or {}).get("token_usage") or (llm_output or {}).get("usage") or {}
    if isinstance(usage, Mapping):
        return {"input": usage.get("prompt_tokens") or usage.get("input_tokens"),
                "output": usage.get("completion_tokens") or usage.get("output_tokens")}
    return {}


# ---------------------------------------------------------------- facts: which node is running


def _resolve() -> Target | None:
    """The node running here, from LangGraph's runnable context: the Agent Lab handler in the
    current config's callbacks, and the config's checkpoint namespace."""
    try:
        config = get_config()
    except RuntimeError:          # not inside a LangGraph run
        return None
    callbacks = config.get("callbacks")
    if not isinstance(callbacks, BaseCallbackManager):
        return None
    for handler in callbacks.handlers:
        if isinstance(handler, AgentLabHandler):
            found = handler.target_for(callbacks.parent_run_id, config.get("metadata"))
            if found is not None:
                return found
    return None


_context.register_resolver(_resolve)


# ---------------------------------------------------------------- instrument


def _caller_dir(depth: int = 2) -> Path:
    """The directory of the file that called `instrument` (cwd from a REPL or `python -c`)."""
    try:
        file = sys._getframe(depth).f_globals.get("__file__")
    except ValueError:  # pragma: no cover
        file = None
    return Path(file).resolve().parent if file else Path.cwd()


def _relative_to(base: Path, path: str | os.PathLike | None) -> Path | None:
    if path is None:
        return None
    p = Path(path)
    return p if p.is_absolute() else base / p


def _without_agentlab(compiled: Any) -> Any:
    """`compiled` with any earlier Agent Lab handler removed (instrumenting twice replaces)."""
    config = dict(getattr(compiled, "config", None) or {})
    callbacks = config.get("callbacks")
    if isinstance(callbacks, BaseCallbackManager):
        kept = callbacks.copy()
        for handler in list(kept.handlers):
            if isinstance(handler, AgentLabHandler):
                kept.remove_handler(handler)
    elif callbacks:
        kept = [h for h in callbacks if not isinstance(h, AgentLabHandler)]
    else:
        return compiled
    config["callbacks"] = kept
    return compiled.copy({"config": config})


def instrument(compiled: Any, *, app: App, story: Story | None = None,
               steps: Mapping[str, StepWords] | None = None, corpora: Sequence[str] | None = None,
               lock: str | os.PathLike | None = None, llm_spans: bool = True,
               structure: Structure | None = None) -> Any:
    """Attach Agent Lab to a compiled LangGraph graph; returns the graph to invoke instead.

    - `app`: `lab.App(name=..., ...)`, the app-level facts.
    - `story`: `lab.Story(file=..., panels=..., reads=...)` for a custom panel script.
    - `steps`: words for nodes with no function of their own (a subgraph, a prebuilt node),
      `{node_id: lab.step(...)}`. A node worded both here and with `@lab.step` fails `verify` (R1).
    - `corpora`: which registered corpora this app shows, when one process hosts several apps.
    - `lock`: the lock file (`agentlab.lock.json`); a relative path is resolved against the file
      that calls `instrument` (the working directory from a REPL). None: wording fingerprints
      are reported "unconfirmed".
    - `llm_spans`: False when the app already traces its LangChain model calls elsewhere.
    - `structure`: the map's structure when the graph was built from a definition that knows more
      than the compiled graph does, e.g. `agentlab.agentspec.structure_from(flow_file)` for a graph
      pyagentspec's loader made from that file (its node ids are the file's). Default: read from
      `compiled`.

    The map is built here, once, from `compiled.get_graph()` and `compiled.builder`; it is not
    stored anywhere and travels with each run. Never raises: if the graph can't be read it logs a
    warning and returns `compiled` unchanged, and `verify(graph)` then fails in the app's tests.
    Instrumenting an already instrumented graph replaces the earlier instrumentation."""
    try:
        base = _caller_dir()
        structure = structure if structure is not None else structure_from(compiled)
        if story is not None:
            story = dataclasses.replace(story, file=_relative_to(base, story.file))
        inst = Instrumentation(structure, app=app, story=story, steps=steps, corpora=corpora,
                               lock=_relative_to(base, lock))
        handler = AgentLabHandler(inst, graph_name=compiled.get_name(), llm_spans=llm_spans)
        if find(compiled) is not None:
            compiled = _without_agentlab(compiled)
        return compiled.with_config(callbacks=[handler])
    except Exception as e:  # noqa: BLE001 - instrumenting must never break app startup
        log.warning("agentlab.langgraph.instrument: %s: %s; the graph runs without Agent Lab",
                    type(e).__name__, e)
        return compiled

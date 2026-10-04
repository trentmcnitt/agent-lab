"""The spans Agent Lab makes: run, manifest, node, chat, retrieval (SPEC.md 8.2-8.3).

This is the interface a framework integration builds on (`agentlab.langgraph` is the first). An
integration decides *when* a run or node starts and ends; this module decides *what* goes on the
wire, so attribute names, redaction, content mode and cost are written in exactly one place.

Every function here returns quietly when Agent Lab is off (`start_run` returns None).
"""
from __future__ import annotations

import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.trace import Status, StatusCode

from . import _semconv as sc
from . import _state
from ._context import Target
from ._util import dumps, log_once, to_jsonable

MISSING: Any = object()


@dataclass(frozen=True)
class ManifestDoc:
    """A run's manifest, encoded once: the canonical JSON and its sha256."""
    json: str
    hash: str


class RunIds:
    """Run identity (SPEC.md 8.2): a fresh id per new input, reused when the same thread resumes.

    `{thread}:{8 hex}` (just the hex with no thread). A resume whose thread this process has
    never seen (a restart between pause and resume) gets a fresh id marked as a resume; the bench
    joins it to the paused run of the same app and thread. Bounded: the oldest threads are
    forgotten first."""

    def __init__(self, limit: int = 10_000):
        self._by_thread: OrderedDict[str, str] = OrderedDict()
        self._limit = limit
        self._lock = threading.Lock()

    def begin(self, thread: str | None, *, resume: bool) -> str:
        with self._lock:
            if resume and thread is not None and thread in self._by_thread:
                self._by_thread.move_to_end(thread)
                return self._by_thread[thread]
            hex8 = uuid.uuid4().hex[:8]
            run_id = f"{thread}:{hex8}" if thread else hex8
            if thread is not None:
                self._by_thread[thread] = run_id
                self._by_thread.move_to_end(thread)
                while len(self._by_thread) > self._limit:
                    self._by_thread.popitem(last=False)
            return run_id


def _tracer() -> trace.Tracer | None:
    state = _state.STATE
    return state.tracer if state.enabled else None


def _set(attrs: dict, key: str, value: Any) -> None:
    if value is not None:
        attrs[key] = value


def common(app_id: str | None, run_id: str | None, node: str | None, kind: str | None) -> dict:
    attrs: dict = {}
    _set(attrs, sc.APP, app_id)
    _set(attrs, sc.RUN, run_id)
    _set(attrs, sc.NODE, node)
    _set(attrs, sc.KIND, kind)
    return attrs


class Run:
    """One run's spans. Made by `start_run`; ended by `finish`."""

    def __init__(self, span: trace.Span, app_id: str, run_id: str):
        self.span = span
        self.app_id = app_id
        self.run_id = run_id
        self.paused = False
        self._lock = threading.Lock()

    def target(self, span: trace.Span | None = None, node: str | None = None) -> Target:
        return Target(span=span or self.span, run=self, node=node)

    def open_node(self, node: str, *, parent: trace.Span | None = None, step: int | None = None,
                  ns: str | None = None, start_time: int | None = None) -> trace.Span:
        tracer = _tracer()
        if tracer is None:
            return trace.INVALID_SPAN
        attrs = common(self.app_id, self.run_id, node, sc.KIND_NODE)
        _set(attrs, sc.STEP, step)
        _set(attrs, sc.NS, ns)
        ctx = trace.set_span_in_context(parent or self.span)
        return tracer.start_span(f"node {node}", context=ctx, attributes=attrs, start_time=start_time)

    def end_node(self, span: trace.Span, *, error: BaseException | None = None) -> None:
        if error is not None:
            span.set_status(Status(StatusCode.ERROR, f"{type(error).__name__}: {error}"))
            span.record_exception(error)
        span.end()

    def gate_waiting(self, span: trace.Span, proposed: Any = None, *, reason: str | None = None) -> None:
        """The run paused at a gate on `span`'s node: the event, and the run is marked paused."""
        add_event(span, sc.EV_GATE_WAITING, {sc.GATE_PROPOSED: _state.content(proposed),
                                             sc.GATE_REASON: _state.content(reason)})
        self.mark_paused()

    def mark_paused(self) -> None:
        """The run stopped to wait (a gate, or a framework breakpoint with no gate node)."""
        with self._lock:
            self.paused = True
        self.span.set_attribute(sc.RUN_STATUS, "paused")

    def set_outcome(self, label: str) -> None:
        self.span.set_attribute(sc.RUN_OUTCOME, str(label))

    def finish(self, *, output: Any = MISSING, error: BaseException | None = None) -> None:
        if self.paused:
            status = "paused"
        elif error is not None:
            status = "error"
            self.span.set_status(Status(StatusCode.ERROR, f"{type(error).__name__}: {error}"))
        else:
            status = "ok"
        self.span.set_attribute(sc.RUN_STATUS, status)
        if output is not MISSING:
            value = _state.content(output)
            if value is not None:
                self.span.set_attribute(sc.RUN_OUTPUT, value)
        self.span.end()


def start_run(*, app_id: str, run_id: str, manifest: ManifestDoc | None = None,
              thread: str | None = None, resume: bool = False, input: Any = MISSING,
              session_id: str | None = None, parent: Context | None = None) -> Run | None:
    """Open a run span (child of `parent`, default the current span if any) and, when given, its
    manifest span: started and ended at once, so the map ships in the run's first export batch."""
    tracer = _tracer()
    if tracer is None:
        return None
    state = _state.STATE
    attrs = common(app_id, run_id, None, sc.KIND_RUN)
    attrs[sc.CONTENT_MODE] = state.content_mode
    attrs[sc.RUN_RESUME] = bool(resume)
    _set(attrs, sc.THREAD, thread)
    _set(attrs, sc.SESSION_ID, session_id)
    if manifest is not None:
        attrs[sc.MANIFEST_HASH] = manifest.hash
    if input is not MISSING:
        _set(attrs, sc.RUN_INPUT, _state.content(input))
    span = tracer.start_span(f"agentlab.run {app_id}", context=parent, attributes=attrs)
    if manifest is not None:
        # The manifest span is exported first and the run span last, so the run-level facts the
        # bench needs from the first moment (none of them content) ride on both: the thread and
        # resume flag (a new-process resume joins its paused run at first sight), the content mode
        # (no early event is mislabelled) and the session (a session-filtered stream sees step 1).
        m_attrs = common(app_id, run_id, None, sc.KIND_MANIFEST)
        m_attrs[sc.MANIFEST] = manifest.json
        m_attrs[sc.MANIFEST_HASH] = manifest.hash
        m_attrs[sc.CONTENT_MODE] = state.content_mode
        m_attrs[sc.RUN_RESUME] = bool(resume)
        _set(m_attrs, sc.THREAD, thread)
        _set(m_attrs, sc.SESSION_ID, session_id)
        tracer.start_span("agentlab.manifest", context=trace.set_span_in_context(span),
                          attributes=m_attrs).end()
    return Run(span, app_id, run_id)


def add_event(span: trace.Span, name: str, attrs: Mapping[str, Any]) -> None:
    span.add_event(name, {k: v for k, v in attrs.items() if v is not None})


def _child(target: Target, name: str, kind: str, attrs: dict, start_time: int | None = None) -> trace.Span | None:
    tracer = _tracer()
    if tracer is None:
        return None
    full = common(target.app_id, target.run_id, target.node, kind)
    full.update({k: v for k, v in attrs.items() if v is not None})
    return tracer.start_span(name, context=trace.set_span_in_context(target.span), attributes=full,
                             start_time=start_time)


def _messages(messages: Any) -> str | None:
    return _state.content(messages) if messages else None


def record_chat(target: Target, *, model: str | None, provider: str | None = None,
                request_model: str | None = None, input_tokens: int | None = None,
                output_tokens: int | None = None, cache_read: int | None = None,
                cache_write: int | None = None, finish_reasons: Sequence[str] | None = None,
                system: Any = None, messages: Any = None, output: Any = None,
                json_schema: Any = None, start_time: int | None = None, end_time: int | None = None,
                error: BaseException | None = None) -> None:
    """One model call as a GenAI `chat` span under `target`'s node.

    `input_tokens` is the TOTAL input, cache reads and writes included (the GenAI convention); an
    integration whose provider reports the uncached part must add the cache buckets back first.
    `messages` is `[{role, content}]`; `output` the raw output. Content is redacted or omitted per
    `init`. When `init(price=...)` returns a number it goes in `agentlab.cost.usd` (estimated)."""
    state = _state.STATE
    attrs: dict = {sc.GEN_AI_OPERATION: "chat"}
    _set(attrs, sc.GEN_AI_PROVIDER, provider)
    _set(attrs, sc.GEN_AI_REQUEST_MODEL, request_model or model)
    _set(attrs, sc.GEN_AI_RESPONSE_MODEL, model)
    for key, value in ((sc.GEN_AI_INPUT_TOKENS, input_tokens), (sc.GEN_AI_OUTPUT_TOKENS, output_tokens),
                       (sc.GEN_AI_CACHE_READ, cache_read), (sc.GEN_AI_CACHE_WRITE, cache_write)):
        if value is not None:
            attrs[key] = int(value)
    if finish_reasons:
        attrs[sc.GEN_AI_FINISH_REASONS] = [str(r) for r in finish_reasons]
    if system:
        _set(attrs, sc.GEN_AI_SYSTEM, _state.content(system))
    _set(attrs, sc.GEN_AI_INPUT_MESSAGES, _messages(messages))
    if output is not None:
        _set(attrs, sc.GEN_AI_OUTPUT_MESSAGES, _state.content(output))
    if json_schema is not None:
        attrs[sc.REQUEST_JSON_SCHEMA] = dumps(to_jsonable(json_schema))
    if state.price is not None and model:
        try:
            cost = state.price(model, int(input_tokens or 0), int(output_tokens or 0),
                               int(cache_read or 0), int(cache_write or 0))
        except Exception as e:  # noqa: BLE001
            log_once("price", f"price({model!r}, ...) raised {type(e).__name__}; no cost recorded")
            cost = None
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            attrs[sc.COST_USD] = float(cost)
            attrs[sc.COST_BASIS] = state.price_basis or "estimated by the app's price function"
    span = _child(target, f"chat {model or ''}".strip(), sc.KIND_CHAT, attrs, start_time)
    if span is None:
        return
    if error is not None:
        span.set_status(Status(StatusCode.ERROR, f"{type(error).__name__}: {error}"))
        span.record_exception(error)
    span.end(end_time=end_time)


def record_retrieval(target: Target, corpus: str, documents: list[dict], *, query: str | None = None,
                     corpus_hash: str | None = None) -> None:
    """One search as a GenAI `retrieval` span under `target`'s node. `documents` are
    `{id, title?, score?, content?}` plus any numeric extras; `content` is content."""
    docs = []
    for doc in documents:
        d = {k: v for k, v in doc.items() if k != "content"}
        if "content" in doc and doc["content"] is not None:
            text = _state.content(doc["content"])
            if text is not None:
                d["content"] = text
        docs.append(d)
    attrs = {sc.GEN_AI_OPERATION: "retrieval", sc.GEN_AI_DATA_SOURCE: corpus,
             sc.GEN_AI_RETRIEVAL_QUERY: _state.content(query) if query else None,
             sc.GEN_AI_RETRIEVAL_DOCUMENTS: dumps(docs), sc.CORPUS_HASH: corpus_hash}
    span = _child(target, f"retrieval {corpus}", sc.KIND_RETRIEVAL, attrs)
    if span is not None:
        span.end()


def record_tool(target: Target, *, name: str, call_id: str | None = None, arguments: Any = None,
                result: Any = MISSING, start_time: int | None = None, end_time: int | None = None,
                error: BaseException | None = None) -> None:
    """One tool call as a GenAI `execute_tool` span under `target`'s node. `arguments` and
    `result` are content (redacted or omitted per `init`)."""
    attrs: dict = {sc.GEN_AI_OPERATION: "execute_tool", sc.GEN_AI_TOOL_NAME: str(name)}
    _set(attrs, sc.GEN_AI_TOOL_CALL_ID, None if call_id is None else str(call_id))
    if arguments is not None:
        _set(attrs, sc.GEN_AI_TOOL_CALL_ARGUMENTS, _state.content(arguments))
    if result is not MISSING and result is not None:
        _set(attrs, sc.GEN_AI_TOOL_CALL_RESULT, _state.content(result))
    span = _child(target, f"execute_tool {name}", sc.KIND_TOOL, attrs, start_time)
    if span is None:
        return
    if error is not None:
        span.set_status(Status(StatusCode.ERROR, f"{type(error).__name__}: {error}"))
        span.record_exception(error)
    span.end(end_time=end_time)

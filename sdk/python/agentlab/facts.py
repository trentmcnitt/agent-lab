"""Facts: one line where the fact is produced, passing live variables.

Each helper attaches to the node running now (see `_context`), never takes a node name, and never
raises: bad input is dropped with one debug line. With Agent Lab off each returns after one flag
check, except `corpus`, which always records (indexes are often built before `init()`).
"""
from __future__ import annotations

import math
from typing import Any, Iterable, Mapping, Sequence

from . import _corpora
from . import _semconv as sc
from . import _state
from ._context import current_target
from ._runtime import add_event, record_retrieval
from ._util import dumps, log_once, never_raises, to_jsonable

CHECK_WORD_KEYS = ("passed", "failed")


def _target(function: str):
    target = current_target()
    if target is None:
        log_once(function, "called outside a run and with no recording span; ignored")
    return target


def _ids(values: Iterable[Any] | None) -> list[str]:
    if values is None or isinstance(values, (str, bytes)):
        return [] if values is None else [str(values)]
    return [str(v) for v in values if v is not None]


def _bool(value: Any, function: str, name: str) -> bool | None:
    if isinstance(value, bool):
        return value
    if type(value).__name__ == "bool_":           # numpy.bool_
        return bool(value)
    log_once(function, f"{name} must be a bool, got {type(value).__name__}; the fact was dropped")
    return None


@never_raises
def corpus(id: str, *, title: str, items: Iterable[tuple[str, str] | Mapping[str, str]],
           description: str = "", kind: str = "documents") -> None:
    """Report a corpus where its index is built, from the index's own data::

        lab.corpus("handbook", title="IT/Ops handbook", items=[(c.id, c.title) for c in chunks])

    Process-level by id; registering an id again replaces it. Each run's manifest lists the
    corpora as they are when the run starts."""
    if not id or not isinstance(id, str):
        log_once("corpus", "id must be a non-empty string; ignored")
        return
    _corpora.register(id, title=title, items=items, description=description, kind=kind)


@never_raises
def retrieved(corpus: str, hits: Iterable[Mapping[str, Any]], *, query: str | None = None) -> None:
    """Report what a search returned, when the retriever isn't instrumented. Emits a GenAI
    retrieval span. Hit keys: `id` (required), `title`, `score`, `text`; other numeric keys kept."""
    if not _state.STATE.enabled:
        return
    target = _target("retrieved")
    if target is None:
        return
    docs = []
    for hit in hits:
        if not isinstance(hit, Mapping) or hit.get("id") is None:
            log_once("retrieved", "a hit without an id was skipped")
            continue
        doc: dict[str, Any] = {"id": str(hit["id"])}
        if hit.get("title") is not None:
            doc["title"] = str(hit["title"])
        score = hit.get("score")
        if isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score):
            doc["score"] = float(score)
        if hit.get("text") is not None:
            doc["content"] = str(hit["text"])
        for key, value in hit.items():
            if key in ("id", "title", "score", "text"):
                continue
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                doc[str(key)] = value
        docs.append(doc)
    found = _corpora.get(str(corpus))
    record_retrieval(target, str(corpus), docs, query=query, corpus_hash=found.hash if found else None)


@never_raises
def decision(reason: str | None = None, *, cited: Sequence[str] = (), branch: str | None = None,
             confidence: float | None = None) -> None:
    """The node's decision, where it is made: `reason` is the app's own rationale variable,
    `cited` the corpus item ids it rests on. The branch taken is derived from what ran next;
    pass `branch=` only where it can't be (a many-to-one path map, R5)."""
    if not _state.STATE.enabled:
        return
    target = _target("decision")
    if target is None:
        return
    attrs: dict[str, Any] = {sc.DECISION_REASON: _state.content(reason) if reason is not None else None}
    ids = _ids(cited)
    if ids:
        attrs[sc.DECISION_CITED] = ids
    if branch is not None:
        attrs[sc.DECISION_BRANCH] = str(branch)
    if confidence is not None:
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and math.isfinite(confidence):
            attrs[sc.DECISION_CONFIDENCE] = float(confidence)
        else:
            log_once("decision", "confidence must be a finite number; it was left out")
    add_event(target.span, sc.EV_DECISION, attrs)


@never_raises
def check(name: str, passed: bool, *, detail: str | None = None, evidence: Sequence[str] = (),
          kind: str | None = None, words: Mapping[str, str] | None = None) -> None:
    """One check's result, at the check site. `evidence`: corpus item ids it relied on.
    `words`: this check's own words for its states, `{"passed": ..., "failed": ...}`."""
    if not _state.STATE.enabled:
        return
    ok = _bool(passed, "check", "passed")
    if ok is None or not name:
        if not name:
            log_once("check", "name is required; the fact was dropped")
        return
    target = _target("check")
    if target is None:
        return
    attrs: dict[str, Any] = {sc.CHECK_NAME: str(name), sc.CHECK_PASSED: ok, sc.CHECK_KIND: kind,
                             sc.CHECK_DETAIL: _state.content(detail) if detail is not None else None}
    ids = _ids(evidence)
    if ids:
        attrs[sc.CHECK_EVIDENCE] = ids
    if words:
        kept = {k: str(v) for k, v in words.items() if k in CHECK_WORD_KEYS and v is not None}
        if len(kept) != len(words):
            log_once("check", "words takes only 'passed' and 'failed' (the not-needed line is "
                              "step(not_needed=...)); other keys were left out")
        if kept:
            attrs[sc.CHECK_WORDS] = dumps(kept)
    add_event(target.span, sc.EV_CHECK, attrs)


@never_raises
def gate_waiting(proposed: Any = None, *, reason: str | None = None) -> None:
    """A run paused for a person's decision. LangGraph derives this from `interrupt()`; call it
    only outside LangGraph."""
    if not _state.STATE.enabled:
        return
    target = _target("gate_waiting")
    if target is None:
        return
    if target.run is not None:
        target.run.gate_waiting(target.span, proposed, reason=reason)
    else:
        add_event(target.span, sc.EV_GATE_WAITING, {sc.GATE_PROPOSED: _state.content(proposed),
                                                    sc.GATE_REASON: _state.content(reason)})


def _approver(by: Any) -> str | None:
    if by is None or isinstance(by, str):
        return by
    if isinstance(by, Mapping) and isinstance(by.get("name"), str):
        return by["name"]
    return dumps(to_jsonable(by))


@never_raises
def gate_resolved(approved: bool, *, by: str | None = None, reason: str | None = None) -> None:
    """A person decided at a gate: call it after `interrupt()` returns, and on an auto-approve
    path. `by` names the approver as the app knows them."""
    if not _state.STATE.enabled:
        return
    ok = _bool(approved, "gate_resolved", "approved")
    if ok is None:
        return
    target = _target("gate_resolved")
    if target is None:
        return
    add_event(target.span, sc.EV_GATE_RESOLVED, {sc.GATE_APPROVED: ok, sc.GATE_BY: _approver(by),
                                                 sc.GATE_REASON: _state.content(reason)})


@never_raises
def outcome(label: str) -> None:
    """The run's app-specific result (e.g. "executed", "handed_off"), set on the run."""
    if not _state.STATE.enabled:
        return
    target = _target("outcome")
    if target is None:
        return
    if target.run is None:
        log_once("outcome", "called outside a run; ignored")
        return
    target.run.set_outcome(label)


@never_raises
def event(event_type: str, data: Mapping[str, Any]) -> None:
    """A bespoke fact for the app's story to render: becomes a bench event of `event_type` on the
    current node, with `data` (content: redacted with the rest)."""
    if not _state.STATE.enabled:
        return
    if not isinstance(event_type, str) or not event_type:
        log_once("event", "event_type must be a non-empty string; ignored")
        return
    target = _target("event")
    if target is None:
        return
    add_event(target.span, sc.EV_EVENT, {sc.EVENT_TYPE: event_type,
                                         sc.EVENT_DATA: _state.content(dict(data or {}))})

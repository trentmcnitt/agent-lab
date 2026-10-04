"""Words and app facts: plain, frozen data written next to the code they describe.

Nothing here has a side effect or a registry. `@step(...)` stores its words on the node function
itself; `App`, `Story` and `Panel` are handed to `instrument(...)`. Verification (`verify`) checks
every key against the structure derived from the code, so a word that names a step or branch the
code no longer has fails a test instead of showing something wrong.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Literal, Mapping, Sequence, TypeVar

from ._util import log_once

Actor = Literal["ai", "rule", "person", "app"]
Kind = Literal["step", "llm", "tool", "retrieval", "gate", "check", "terminal"]
ACTORS = ("ai", "rule", "person", "app")
KINDS = ("step", "llm", "tool", "retrieval", "gate", "check", "terminal")

F = TypeVar("F", bound=Callable[..., Any])

ATTR = "__agentlab_step__"


@dataclass(frozen=True)
class PathWords:
    """A branch in Presentation's words: the edge's `plain_label` and `description`."""
    label: str
    says: str | None = None


def path(label: str, *, says: str | None = None) -> PathWords:
    """Words for one branch, for `step(paths={branch_id: path(...)})`."""
    return PathWords(label=label, says=says)


@dataclass(frozen=True)
class StepWords:
    """What `step(...)` builds. Use it as a decorator on the node function, or pass it in
    `instrument(steps={node_id: step(...)})` for a node with no function of its own."""
    label: str | None = None
    says: str | None = None
    actor: Actor | None = None
    kind: Kind | None = None
    moment: bool | None = None
    not_needed: str | None = None
    paths: Mapping[str, PathWords] = field(default_factory=dict)

    def __call__(self, fn: F) -> F:
        try:
            setattr(fn, ATTR, self)
        except (AttributeError, TypeError):
            log_once("step", f"can't attach words to {fn!r}; pass them as instrument(steps={{...}})")
        return fn


def step(label: str | None = None, *,
         says: str | None = None,
         actor: Actor | None = None,
         kind: Kind | None = None,
         moment: bool | None = None,
         not_needed: str | None = None,
         paths: Mapping[str, "str | PathWords"] | None = None) -> StepWords:
    """Words for one step, as a decorator on its node function::

        @lab.step("Decide what kind of request", actor="ai", moment=True,
                  paths={"needs_write": lab.path("needs a change", says="It decided ...")})
        def classify(state): ...

    - `label`: the step's Presentation name; `says`: its plain description. The function's
      docstring is the Engineering description; it is read from the code, not repeated here.
    - `not_needed`: the line shown when a check or gate step was not on this run's path.
    - `paths`: words for the branches out of this step, keyed by the real branch ids (the path
      map's keys). A key that isn't one fails `verify` (R2).
    Returns the function unchanged."""
    words: dict[str, PathWords] = {}
    try:
        for key, value in (paths or {}).items():
            words[str(key)] = value if isinstance(value, PathWords) else PathWords(label=str(value))
    except Exception as e:  # noqa: BLE001 - step() runs at import time; it must never raise
        log_once("step", f"paths must be a mapping of branch id to words ({type(e).__name__})")
    return StepWords(label=label, says=says, actor=actor, kind=kind, moment=moment,
                     not_needed=not_needed, paths=words)


def words_of(fn: Any) -> StepWords | None:
    """The words `@step` attached to a node function, if any."""
    found = getattr(fn, ATTR, None)
    return found if isinstance(found, StepWords) else None


@dataclass(frozen=True)
class Action:
    """Something the app can do in the world; defined next to the tool's own code."""
    id: str
    title: str
    description: str


@dataclass(frozen=True)
class Never:
    types: tuple[str, ...]
    words: Mapping[str, str]


def never(types: Iterable[str], *, words: Mapping[str, str]) -> Never:
    """What the app can never do, called beside the forbidden list itself::

        NEVER = lab.never(FORBIDDEN_ACTION_TYPES, words={"mfa_reset": "Reset two-factor sign-in", ...})

    `types` is the code's own list; `words` must have exactly one entry per type (R4)."""
    return Never(types=tuple(str(t) for t in types), words=dict(words))


@dataclass(frozen=True)
class App:
    name: str
    id: str | None = None                  # default: the resource's service.name, else from name
    description: str | None = None
    privacy_note: str | None = None
    track_record: str | None = None        # computed by the app from its eval output where it can
    baseline: str | None = None            # what the job takes a person, e.g. config.MANUAL_ESTIMATE
    never: Never | None = None
    actions: Sequence[Action] = ()


@dataclass(frozen=True)
class Panel:
    id: str
    title: str
    event_types: Sequence[str]
    nodes: Sequence[str] = ()
    plain_title: str | None = None
    audience: Literal["both", "presentation", "engineering"] = "both"
    mode: Literal["latest", "append"] = "latest"
    story: bool = True                     # False + fields = a declared panel
    fields: Sequence[Mapping[str, str]] | None = None


@dataclass(frozen=True)
class Story:
    file: str | os.PathLike                # the story JS; hashed, never sent over telemetry
    panels: Sequence[Panel] = ()
    reads: Sequence[str] = ()              # every node id the JS refers to outside its panels' nodes


__all__ = ["StepWords", "PathWords", "step", "path", "words_of", "Action", "Never", "never", "App",
           "Panel", "Story", "ACTORS", "KINDS"]

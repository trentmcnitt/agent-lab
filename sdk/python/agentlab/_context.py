"""Where a fact lands: the span of the node that is running now.

Fact helpers (`decision`, `check`, ...) never take a node argument; they ask `current_target()`.
A framework integration registers a resolver that reads its own runtime context (LangGraph:
`get_config()` and the Agent Lab handler in its callbacks). Code that runs a step by hand activates
a target with `activate()`. Outside both, a fact attaches to OpenTelemetry's current span if it is
recording, else it is dropped with one debug line.

The resolver list is a hook for integrations, not a registry of facts: it holds no node, step or
word, so nothing in it can drift from the code.
"""
from __future__ import annotations

import contextlib
import contextvars
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Iterator

from opentelemetry import trace

if TYPE_CHECKING:
    from ._runtime import Run


@dataclass(frozen=True)
class Target:
    """The span a fact attaches to, and the run and node it belongs to (either may be unknown)."""
    span: trace.Span
    run: "Run | None" = None
    node: str | None = None

    @property
    def app_id(self) -> str | None:
        return self.run.app_id if self.run else None

    @property
    def run_id(self) -> str | None:
        return self.run.run_id if self.run else None


Resolver = Callable[[], "Target | None"]
_resolvers: list[Resolver] = []
_active: contextvars.ContextVar[Target | None] = contextvars.ContextVar("agentlab_target", default=None)


def register_resolver(resolver: Resolver) -> None:
    """Called once by a framework integration at import. Idempotent."""
    if resolver not in _resolvers:
        _resolvers.append(resolver)


@contextlib.contextmanager
def activate(target: Target) -> Iterator[Target]:
    """Make `target` the place facts land for the code inside the block (this context only)."""
    token = _active.set(target)
    try:
        yield target
    finally:
        _active.reset(token)


def run_target() -> Target | None:
    """The node or run Agent Lab knows is running here (integration or activate()), else None."""
    for resolve in _resolvers:
        try:
            found = resolve()
        except Exception:  # noqa: BLE001 - a resolver outside its framework's context just misses
            found = None
        if found is not None:
            return found
    return _active.get()


def current_target() -> Target | None:
    """`run_target()`, else OpenTelemetry's current span if it is recording, else None."""
    found = run_target()
    if found is not None:
        return found
    span = trace.get_current_span()
    if span.is_recording():
        return Target(span=span)
    return None

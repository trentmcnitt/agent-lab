"""`verify` and `lock`: the two functions that raise, for tests and CI (SPEC.md 8.7)."""
from __future__ import annotations

import pathlib
from typing import Any

from .manifest import Instrumentation, VerificationError, VerifyReport, find


def _instrumentation(graph: Any) -> Instrumentation:
    inst = find(graph)
    if inst is None:
        raise TypeError(f"{type(graph).__name__} is not instrumented: pass what "
                        "agentlab.langgraph.instrument(...) returned")
    return inst


def verify(graph: Any, *, strict: bool = False) -> VerifyReport:
    """Check every hand-written word against the structure derived from the code.

    Raises `VerificationError` (an AssertionError) listing every error: a word, path, panel or
    story reference naming something the code doesn't have (R0-R4). With `strict=True` it also
    raises when worded code changed since `lock` last confirmed it (R6). Returns the report
    (warnings and notes included) when it passes::

        def test_agent_lab_words_match_code():
            lab.verify(build_graph())
    """
    report = _instrumentation(graph).report()
    if report.errors or (strict and any(f.code == "R6" for f in report.warnings)):
        raise VerificationError(report)
    return report


def lock(graph: Any) -> pathlib.Path:
    """Confirm the current wording against the current code: rewrite the lock file named in
    `instrument(lock=...)`. Run it after re-reading the words of a step whose code changed."""
    return _instrumentation(graph).write_lock()

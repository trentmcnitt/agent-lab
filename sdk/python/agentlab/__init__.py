"""Agent Lab: show an AI app's flow, prompts, documents, checks and cost beside the running app.

    import agentlab as lab

    lab.init()                                   # once at startup; a silent no-op with no bench
    @lab.step("Decide what kind of request", actor="ai")
    def classify(state): ...
        lab.decision(parsed.rationale, cited=parsed.cited)

Structure comes from the framework (`agentlab.langgraph.instrument`), facts from one line where
each is produced, words from `@lab.step` next to the code; `lab.verify(graph)` in a test fails
when a word no longer matches the code. Every helper except `verify` and `lock` never raises.
The wire is OpenTelemetry; SPEC.md section 8 names every attribute.
"""
from ._state import init
from .facts import check, corpus, decision, event, gate_resolved, gate_waiting, outcome, retrieved
from .manifest import VerificationError, VerifyReport
from ._tooling import lock, verify
from .version import __version__
from .words import Action, App, Never, Panel, PathWords, StepWords, Story, never, path, step

__all__ = [
    "init",
    "step", "path", "StepWords", "PathWords", "Action", "Never", "never", "App", "Panel", "Story",
    "corpus", "retrieved", "decision", "check", "gate_waiting", "gate_resolved", "outcome", "event",
    "verify", "lock", "VerifyReport", "VerificationError",
    "__version__",
]

"""The FAQ the assistant answers from, and the small keyword index over it.

`FaqIndex` reports its corpus to Agent Lab where the index is built, from the index's own
entries (`lab.corpus`): add, remove or retitle an entry and the bench's sources follow.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import agentlab as lab

CORPUS_ID = "faq"


@dataclass(frozen=True)
class Entry:
    id: str
    title: str
    text: str


ENTRIES = (
    Entry("faq-password", "Reset your password",
          "Open Settings, choose Security, then Reset password. A reset link arrives by email within five minutes."),
    Entry("faq-invoice", "Download an invoice",
          "Invoices are under Billing, then History. Each month has a PDF download button."),
    Entry("faq-plan", "Change your plan",
          "Owners can change the plan under Billing, then Plan. Changes apply at the next billing date."),
    Entry("faq-export", "Export your data",
          "Settings, then Data, then Export creates a ZIP of every project. Large exports are emailed."),
    Entry("faq-seats", "Add a teammate",
          "Owners invite teammates under Team, then Invite. Each teammate uses one seat on the plan."),
)

_WORD = re.compile(r"[a-z]+")
_STOP = {"a", "an", "the", "to", "do", "i", "my", "how", "can", "you", "is", "of", "and", "or", "on", "in", "for", "your"}


def _words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP}


class FaqIndex:
    """A keyword-overlap index: small enough to read, real enough to retrieve the wrong thing."""

    def __init__(self, entries: tuple[Entry, ...] = ENTRIES):
        self.entries = entries
        self._terms = {e.id: _words(f"{e.title} {e.text}") for e in entries}
        lab.corpus(CORPUS_ID, title="Product FAQ", description="The help-center articles the assistant may quote.",
                   items=[(e.id, e.title) for e in entries])

    def search(self, query: str, k: int = 2) -> list[tuple[Entry, float]]:
        """The `k` best entries with at least one word in common with the query, best first."""
        q = _words(query)
        scored = [(e, len(q & self._terms[e.id]) / (len(q) or 1)) for e in self.entries]
        hits = [(e, round(s, 3)) for e, s in sorted(scored, key=lambda p: -p[1]) if s > 0]
        return hits[:k]

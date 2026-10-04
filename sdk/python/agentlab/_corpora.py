"""Corpora: what an app can read, reported by the code that builds each index.

The one process-level store in the library, because an index is a process resource: it is built
once (often before `init()`), and every run that searches it reads the same one. Re-registering an
id replaces it, so a rebuilt index replaces its corpus. Each run's manifest takes the corpora as
they are at that run's start (SPEC.md 8.5).
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from ._util import hash_obj, log_once


@dataclass(frozen=True)
class Corpus:
    id: str
    source: dict          # the manifest's `sources[]` entry
    hash: str             # sha256 of its canonical JSON; travels on retrieval spans

    @property
    def item_ids(self) -> frozenset[str]:
        return frozenset(i["id"] for i in self.source["items"])


_lock = threading.Lock()
_corpora: dict[str, Corpus] = {}
_version = 0


def _item(raw: Any) -> tuple[str, str] | None:
    if isinstance(raw, Mapping):
        item_id, title = raw.get("id"), raw.get("title", raw.get("id"))
    else:
        item_id, title = raw
    if item_id is None or str(item_id) == "":
        return None
    return str(item_id), "" if title is None else str(title)


def register(id: str, *, title: str, items: Iterable[Any], description: str = "",
             kind: str = "documents") -> Corpus | None:
    seen: dict[str, str] = {}
    for raw in items:
        try:
            item = _item(raw)
        except (TypeError, ValueError):
            item = None
        if item is None:
            log_once("corpus", f"corpus {id!r}: an item is not (id, title) or {{id, title}}; skipped")
            continue
        if item[0] in seen:
            log_once("corpus", f"corpus {id!r}: duplicate item id {item[0]!r}; the first is kept")
            continue
        seen[item[0]] = item[1]
    source = {"id": str(id), "title": str(title), "kind": str(kind or "documents"),
              "description": str(description or ""), "count": len(seen),
              "items": [{"id": k, "title": v} for k, v in seen.items()]}
    corpus = Corpus(id=str(id), source=source, hash=hash_obj(source))
    global _version
    with _lock:
        _corpora[corpus.id] = corpus
        _version += 1
    return corpus


def get(id: str) -> Corpus | None:
    return _corpora.get(id)


def snapshot() -> tuple[int, list[Corpus]]:
    """(version, corpora in registration order); the version changes on every registration."""
    with _lock:
        return _version, list(_corpora.values())


def clear() -> None:
    """For tests only."""
    global _version
    with _lock:
        _corpora.clear()
        _version += 1

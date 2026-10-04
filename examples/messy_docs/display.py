"""The documents display model: what Presentation shows for a search step, computed only from what
the bench receives (a run's map + its events). It knows nothing about any one app: the same
function builds the helpdesk's numbered handbook and a messy shared folder. No model is called;
every field is derived by a fixed rule, so the same run always gives the same model.

    python display.py <recording.jsonl> [--node retrieve]      # prints the model as JSON

The rules (REPORT.md has them in plain words):
  Documents  an item id "<document>#<n>" belongs to <document>; a source whose item ids have no
             '#' is one document (the source itself) and its items are its parts.
  Titles     a document's title is its items' title (the app's side chooses it: explicit metadata
             title > first heading > cleaned file name); a one-document source uses its own title.
             The file name is always carried beside the title: titles collide in real folders.
  Location   "page p" when the hit says (numeric `page`), then "passage n of m" from the id's n and
             the document's item count; a one-passage document is "whole file"; a part of a
             one-document source is located by its own title.
  States     found = in a search's hits; given = the hit's text appears in a later model prompt
             (verified, as the viewer does); relied = cited by a decision or a check's evidence
             (a decision whose step's check failed doesn't count).
  Layout     "sections" (a numbered grid) only for a one-document source whose parts mostly carry
             an explicit ordinal ("5. ..."), never a year or a date; otherwise "documents" (a list
             grouped by file, ordered by best rank).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

SNIPPET_MAX = 200
PER_DOC_CAP = 3
_ORDINAL = re.compile(r"^\s*(\d{1,3})[.)]\s")
_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset("a an the and or to of in on at for is are do does what how can i we you it my our with be "
                  "that this from as by not".split())


def _ev_text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "\n".join(b.get("text", _ev_text(b.get("content"))) if isinstance(b, dict) else str(b) for b in v)
    return json.dumps(v, indent=2)


def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", t or "").strip().lower()


def _words(t: str) -> set[str]:
    return {w for w in _WORD.findall((t or "").lower()) if w not in _STOP}


def snippet(text: str, query: str | None) -> str:
    """The sentence (or line) sharing the most words with the query; ties go to the earlier one.
    Trimmed to SNIPPET_MAX characters on a word boundary. No overlap: the passage's opening."""
    body = "\n".join(l for l in (text or "").split("\n") if not re.match(r"\s*#{1,6}\s", l))
    flat = re.sub(r"[ \t]+", " ", body if body.strip() else (text or "")).strip()
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+|\n+", flat) if p.strip()]
    # A Markdown heading line (dropped above) is the passage's title, not what it says; a list number
    # split off as a "sentence" says nothing: neither is the snippet when the passage has prose.
    prose = [p for p in parts if re.search(r"[^\W\d_]{2,}", p)]
    parts = prose or parts
    qw = _words(query or "")
    best, best_score = (parts[0] if parts else ""), 0
    for p in parts:
        s = len(qw & _words(p))
        if s > best_score:
            best, best_score = p, s
    best = re.sub(r"\s+", " ", best)
    if len(best) > SNIPPET_MAX:
        best = best[:SNIPPET_MAX].rsplit(" ", 1)[0] + "…"
    return best


def _doc_of(item_id: str) -> tuple[str | None, int | None]:
    head, sep, tail = item_id.rpartition("#")
    if not sep or not head:
        return None, None
    return head, int(tail) if tail.isdigit() else None


def _prompts(events: list[dict]) -> list[tuple[float, str]]:
    out = []
    for e in events:
        if e["event_type"] != "llm_call":
            continue
        d = e.get("data") or {}
        out.append((e["ts"], "\n".join([_ev_text(d.get("system"))] + [_ev_text((m or {}).get("content")) for m in d.get("messages") or []])))
    return out


def _relied(events: list[dict]) -> set[str]:
    failed = {e.get("step_id") for e in events if e["event_type"] == "check_result" and (e.get("data") or {}).get("state") == "failed"}
    out: set[str] = set()
    for e in events:
        d = e.get("data") or {}
        if e["event_type"] == "check_result":
            out.update(d.get("evidence") or [])
        if e["event_type"] == "decision" and e.get("step_id") not in failed:
            out.update(d.get("cited") or [])
    return out


def _face(title: str, idx: int, numbered: bool) -> str:
    m = _ORDINAL.match(title)
    if m:
        return m.group(1)
    if numbered:
        w = re.search(r"[^\W_][\w'’-]*", title)
        if w:
            return w.group(0) if len(w.group(0)) <= 8 else w.group(0)[:7] + "…"
    return str(idx + 1)


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def documents_step(topology: dict, events: list[dict], node: str | None = None) -> list[dict]:
    """One display model per source the step searched, in the order it searched them."""
    retrievals = [e for e in events if e["event_type"] == "retrieval" and (node is None or e["node"] == node)]
    sources = {s["id"]: s for s in topology.get("sources") or []}
    doc_sources = [s for s in sources.values() if s.get("kind") == "documents"]
    order: list[str] = []
    for e in retrievals:
        sid = (e.get("data") or {}).get("source") or (doc_sources[0]["id"] if len(doc_sources) == 1 else "_search")
        if sid not in order:
            order.append(sid)
    prompts, relied = _prompts(events), _relied(events)
    return [_source_model(sources.get(sid) or {"id": sid, "title": sid, "items": []},
                          [e for e in retrievals if ((e.get("data") or {}).get("source") or sid) == sid], prompts, relied)
            for sid in order]


def _source_model(src: dict, retrievals: list[dict], prompts: list[tuple[float, str]], relied: set[str]) -> dict:
    items = src.get("items") or []
    keyed = [(it, *_doc_of(it["id"])) for it in items]
    single = not any(doc for _, doc, _ in keyed)                # no '#' anywhere: the source is one document
    doc_items: dict[str, list[dict]] = {}
    for it, doc, _ in keyed:
        doc_items.setdefault(doc if doc else (src["id"] if single else it["id"]), []).append(it)
    n_docs = len(doc_items) if items else None
    n_items = src.get("count", len(items))
    numbered = single and items and sum(bool(_ORDINAL.match(it.get("title") or "")) for it in items) * 2 > len(items)
    unit = ("section", "sections") if numbered else ("passage", "passages")

    # Hits, first sighting wins (rank = position in its search, 1 = best).
    hits: dict[str, dict] = {}
    for e in retrievals:
        d = e.get("data") or {}
        for i, h in enumerate(d.get("hits") or []):
            if h["id"] in hits:
                continue
            text = h.get("text") or ""
            t = text.strip()
            given = len(re.sub(r"\s+", "", t)) >= 12 and any(ts >= e["ts"] and t in p for ts, p in prompts)
            hits[h["id"]] = {"hit": h, "rank": i + 1, "query": d.get("query"), "given": given}
    asked = bool(prompts)
    given_known = not hits or any(v["given"] for v in hits.values()) or (asked and any((v["hit"].get("text") or "").strip() for v in hits.values()))

    # Same text in more than one hit (exact, whitespace- and case-insensitive).
    by_text: dict[str, list[str]] = {}
    for hid, v in hits.items():
        if (v["hit"].get("text") or "").strip():
            by_text.setdefault(_norm(v["hit"]["text"]), []).append(hid)

    title_of = {it["id"]: it.get("title") or it["id"] for it in items}

    def passage_view(hid: str) -> dict:
        v, h = hits[hid], hits[hid]["hit"]
        doc, n = _doc_of(hid)
        siblings = doc_items.get(doc or "", []) if doc else []
        m = len(siblings) or (h.get("passages") if isinstance(h.get("passages"), int) else None)
        n = n or (h.get("passage") if isinstance(h.get("passage"), int) else None)
        page = h.get("page") if isinstance(h.get("page"), (int, float)) else None
        if single:
            loc = title_of.get(hid, h.get("title") or hid)
        elif m == 1:
            loc = "whole file"
        else:
            loc = " · ".join(x for x in [f"page {int(page)}" if page else None,
                                         f"passage {n} of {m}" if n and m else (f"passage {n}" if n else None)] if x)
        state = "given" if v["given"] else "found"
        same = [x for x in by_text.get(_norm(h.get("text") or ""), []) if x != hid]
        return {"id": hid, "rank": v["rank"], "state": state, "relied": hid in relied, "location": loc or None,
                "page": int(page) if page else None, "n": n, "of": m, "score": h.get("score"),
                "snippet": snippet(h.get("text") or "", v["query"]) or None,
                "same_text_as": same}

    found_ids = sorted(hits, key=lambda x: hits[x]["rank"])
    n_given = sum(1 for v in hits.values() if v["given"])
    n_relied = sum(1 for x in hits if x in relied)
    model: dict[str, Any] = {
        "source": {"id": src["id"], "title": src.get("title") or src["id"], "kind": src.get("kind"),
                   "description": src.get("description") or ""},
        "layout": "sections" if numbered else "documents",
        "counts": {"documents": n_docs, "items": n_items, "unit": unit[1], "found": len(hits),
                   "given": n_given if given_known else None, "relied": n_relied,
                   "documents_matched": len({_doc_of(x)[0] or src["id"] for x in hits}) if not single else (1 if hits else 0)},
    }
    c = model["counts"]
    searched = (f"Searched {model['source']['title']}" if single else
                f"Searched {_plural(n_docs, 'document')}" if n_docs is not None else "Searched")
    model["line"] = " · ".join([searched, _plural(n_items, unit[0], unit[1]) if n_items is not None else "",
                                f"{c['given']} given to the AI" if c["given"] is not None else f"{c['found']} found · given to the AI: not known",
                                f"{c['relied']} relied on"]).replace(" ·  · ", " · ")
    if numbered:
        model["sections"] = [{"id": it["id"], "face": _face(it.get("title") or "", i, True), "title": it.get("title") or it["id"],
                              "state": ("given" if hits[it["id"]]["given"] else "found") if it["id"] in hits else "could",
                              "rank": hits[it["id"]]["rank"] if it["id"] in hits else None, "relied": it["id"] in relied}
                             for i, it in enumerate(items)]
        model["passages"] = [passage_view(x) | {"title": title_of.get(x, x)} for x in found_ids]
        return model
    if single:
        model["document"] = {"title": model["source"]["title"], "parts": len(items)}
        model["passages"] = [passage_view(x) | {"title": title_of.get(x, x)} for x in found_ids]
        return model
    docs: dict[str, dict] = {}
    for hid in found_ids:
        doc = _doc_of(hid)[0] or hid
        if doc not in docs:
            its = doc_items.get(doc, [])
            docs[doc] = {"file": doc, "title": (its[0].get("title") if its else hits[hid]["hit"].get("title")) or doc,
                         "passages_total": len(its) or None, "best_rank": hits[hid]["rank"], "relied": False,
                         "passages": [], "more": 0}
        pv = passage_view(hid)
        docs[doc]["relied"] |= pv["relied"]
        if len(docs[doc]["passages"]) < PER_DOC_CAP:
            docs[doc]["passages"].append(pv)
        else:
            docs[doc]["more"] += 1
    shown = list(docs.values())
    titles = [d["title"] for d in shown]
    for d in shown:
        d["title_shared"] = titles.count(d["title"]) > 1        # the file line is what tells them apart
        d["same_text_in"] = sorted({_doc_of(o)[0] or o for p in d["passages"] for o in p["same_text_as"]} - {d["file"]})
    model["documents"] = shown
    model["not_matched"] = (n_docs - len(shown)) if n_docs is not None else None
    return model


def from_recording(path: str | Path, node: str | None = None) -> list[dict]:
    lines = [json.loads(x) for x in Path(path).read_text().splitlines() if x.strip()]
    return documents_step(lines[0]["topology"], lines[1:], node)


if __name__ == "__main__":
    args = sys.argv[1:]
    node = args[args.index("--node") + 1] if "--node" in args else None
    print(json.dumps(from_recording(args[0], node), indent=1, ensure_ascii=False))

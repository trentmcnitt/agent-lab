"""Writes display-data.json: the display models for the helpdesk handbook step and each messy query.

    uv run python make_display_data.py [out.json]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import display
from run_queries import QUERIES

HERE = Path(__file__).resolve().parent
HELPDESK = Path.home() / "working_dir/agent-lab/request-queue/demo/bench-recordings/req-011-approved.recording.jsonl"


def level0(slug: str) -> dict:
    d = json.loads((HERE / "recordings" / f"level0-{slug}.events.json").read_text())
    ev = d["bench_retrieval_events"][0]
    return {"note": "No agentlab library: OpenInference's LangChain instrumentor only. No map, so no source, "
                    "no document grouping, no counts; ids are positional.",
            "hits": [{"id": h["id"], "snippet": display.snippet(h.get("text") or "", d["question"])}
                     for h in ev["data"]["hits"]]}


def main(out: Path) -> None:
    data = {"v": "documents-display/0",
            "about": "Built by examples/messy_docs/display.py from bench recordings (map + events). Same code for every case.",
            "helpdesk": {"recording": "request-queue/demo/bench-recordings/req-011-approved.recording.jsonl",
                         "question": None, "step": display.from_recording(HELPDESK, node="retrieve")[0]},
            "messy": []}
    first = json.loads(HELPDESK.read_text().splitlines()[1])
    data["helpdesk"]["question"] = (first.get("data") or {}).get("input")
    for slug, q in QUERIES:
        data["messy"].append({"slug": slug, "question": q,
                              "recording": f"examples/messy_docs/recordings/{slug}.recording.jsonl",
                              "step": display.from_recording(HERE / "recordings" / f"{slug}.recording.jsonl", node="retrieve")[0],
                              "level0": level0(slug)})
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    print(out)


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "recordings" / "display-data.json")

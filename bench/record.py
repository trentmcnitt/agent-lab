"""OTLP/JSON spans from an `agentlab` app -> self-contained recordings (SPEC.md section 3, 8.6).

The one normalizer for files: it runs the same reader the live bench runs (`adapters/otlp.py`), so
a recording and a live run of the same spans can't disagree. Each run becomes one
`<name>.recording.jsonl` whose header carries the map the run itself carried (verified against
its hash) and, when that map names a story, the trusted story file it names (checked by sha256).

    uv run python -m bench.record --otlp spans.json --out demo/bench-recordings --name req-011-approved \
        [--title "Asks for access"] [--group "It opens a ticket (a person approves)"] \
        [--stories slack-helpdesk=app/bench/story.js] [--t0 1790696431.28] [--regen-id 3f9c…]

Stable files, so a regenerated recording diffs only where the app's behaviour changed: run ids are
the file's name, step ids `<run_id>:<node>:<n>`, the session `recording`, and with `--t0` the
first event is moved to that time (the gaps between events are kept). Exits non-zero, writing
nothing, when a run has no usable map, a story file is missing or differs, or an event doesn't
validate.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from adapters import otlp
from bench.stories import read_story, trusted_stories

ROOT = Path(__file__).resolve().parents[1]
RECORDING_V = "bench-recording/0"


class RecordError(Exception):
    pass


def _runs(body: dict) -> tuple[otlp.TraceState, list[tuple[str, list[dict]]]]:
    state = otlp.TraceState()
    events = state.ingest(body)
    runs: dict[str, list[dict]] = {}
    for e in events:
        runs.setdefault(e["run_id"], []).append(e)
    order = sorted(runs, key=lambda rid: min(e["ts"] for e in runs[rid]))
    return state, [(rid, runs[rid]) for rid in order]


def _fold_updates(events: list[dict]) -> list[dict]:
    """A file holds the whole run, so what arrived late (`run_updated`: the input, the map) goes
    into its one `run_started`."""
    started = next((e for e in events if e["event_type"] == "run_started"), None)
    out = []
    for e in events:
        if e["event_type"] == "run_updated":
            if started is not None:
                started["data"] = {**started["data"], **e["data"]}
            continue
        out.append(e)
    return out


def normalize(events: list[dict], run_id: str, t0: float | None) -> list[dict]:
    """Stable ids and times (see the module docstring); event order is kept."""
    events = sorted(_fold_updates([json.loads(json.dumps(e)) for e in events]),
                    key=lambda e: (e["ts"], e.get("seq", 0)))
    shift = (t0 - events[0]["ts"]) if (t0 is not None and events) else 0.0
    steps: dict[str, str] = {}
    per_node: dict[str, int] = {}
    for e in events:
        sid = e.get("step_id")
        if sid and sid not in steps:
            per_node[e["node"]] = per_node.get(e["node"], 0) + 1
            steps[sid] = f"{run_id}:{e['node']}:{per_node[e['node']]}"
    for i, e in enumerate(events):
        e["run_id"] = run_id
        e["seq"] = i
        e["session_id"] = "recording"
        e["ts"] = round(e["ts"] + shift, 6)
        for k in ("step_id", "parent_step_id"):
            if e.get(k):
                if e[k] in steps:
                    e[k] = steps[e[k]]
                else:
                    e.pop(k)  # a parent the file never opened as a step (a run span): not a step
    return events


def _story(manifest: dict, stories: dict[str, Path]) -> str | None:
    st = manifest.get("story")
    if not isinstance(st, dict):
        return None
    app_id = manifest["app"]["id"]
    src, why = read_story(stories.get(app_id) or stories.get(st.get("id", "")), app_id, st["sha256"])
    if src is None:
        raise RecordError(f"the map names a story (sha256 {st['sha256'][:12]}…): {why}; pass --stories {app_id}=<path>")
    return src


def record(body: dict, *, name: str, title: str | None = None, group: str | None = None,
           stories: dict[str, Path] | None = None, t0: float | None = None,
           regen_id: str | None = None) -> list[tuple[str, list[dict]]]:
    """An OTLP/JSON body -> [(file stem, [header, *events])], one per run. Raises RecordError."""
    state, runs = _runs(body)
    if not runs:
        raise RecordError("no run in the spans (no span carries agentlab.run, and no trace is AI work)")
    validator = Draft202012Validator(json.loads((ROOT / "schema/bench-event.schema.json").read_text()))
    out = []
    for i, (rid, events) in enumerate(runs):
        info = state.run_info(rid)
        manifest = state.maps.get(info["map_hash"]) if info and info["map_hash"] else None
        if manifest is None:
            why = (info or {}).get("map_error") or "it carried no map (not written by the agentlab library?)"
            raise RecordError(f"run {rid}: no usable map: {why}")
        stem = name if len(runs) == 1 else f"{name}-{i + 1}"
        evs = normalize(events, stem, t0)
        for e in evs:
            errs = sorted(validator.iter_errors(e), key=lambda x: list(x.absolute_path))
            if errs:
                raise RecordError(f"run {rid}: event {e['seq']} ({e['event_type']}) is invalid: {errs[0].message}")
        header: dict[str, Any] = {"v": RECORDING_V, "topology": manifest, "story": _story(manifest, stories or {})}
        if title:
            header["title"] = title
        if group:
            header["group"] = group
        if regen_id:
            header["regen_id"] = regen_id
        out.append((stem, [header, *evs]))
    return out


def _stories(specs: list[str]) -> dict[str, Path]:
    return trusted_stories(";".join(specs)) if specs else trusted_stories()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m bench.record", description=__doc__.split("\n\n")[0])
    ap.add_argument("--otlp", required=True, help="an OTLP/JSON ExportTraceServiceRequest (agentlab.testing.to_otlp_json)")
    ap.add_argument("--out", required=True, help="directory the recordings are written to")
    ap.add_argument("--name", required=True, help="file stem; several runs get -1, -2, …")
    ap.add_argument("--title")
    ap.add_argument("--group")
    ap.add_argument("--stories", action="append", default=[], metavar="APP_ID=PATH",
                    help="a trusted story file (repeatable); default: AGENT_LAB_STORIES")
    ap.add_argument("--t0", type=float, help="unix seconds the first event is moved to")
    ap.add_argument("--regen-id", help="ties this recording to the regeneration pass that wrote it")
    a = ap.parse_args(argv)
    try:
        body = json.loads(Path(a.otlp).read_text())
        files = record(body, name=a.name, title=a.title, group=a.group, stories=_stories(a.stories),
                       t0=a.t0, regen_id=a.regen_id)
    except (OSError, ValueError, RecordError) as exc:
        print(f"bench.record: {exc}", file=sys.stderr)
        return 1
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for stem, lines in files:
        path = out / f"{stem}.recording.jsonl"
        path.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in lines))
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())

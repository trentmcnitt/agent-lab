"""Plays a recording into a running receiver as if the app were live: the same gaps between
events (capped), under a new run id and session. For testing the live path and demos.

uv run python -m bench.send examples/hello-answer.recording.jsonl --session live1
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
import uuid


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("recording")
    ap.add_argument("--url", default="http://127.0.0.1:8790/ingest")
    ap.add_argument("--session", default="live")
    ap.add_argument("--max-gap", type=float, default=1.5)
    ap.add_argument("--speed", type=float, default=1.0)
    a = ap.parse_args()
    events = [json.loads(l) for l in open(a.recording) if l.strip()]
    if events and events[0].get("v") == "bench-recording/0":
        events = events[1:]  # the header: the app registers its map and story itself
    run_id = f"live-{uuid.uuid4().hex[:8]}"
    now, prev = time.time(), events[0]["ts"]
    for ev in events:
        gap = min(a.max_gap, max(0.0, ev["ts"] - prev)) / a.speed
        prev = ev["ts"]
        time.sleep(gap)
        now += gap
        ev = {**ev, "run_id": run_id, "session_id": a.session, "ts": time.time()}
        if ev.get("step_id"):
            ev["step_id"] = ev["step_id"].replace(events[0]["run_id"], run_id)
        req = urllib.request.Request(a.url, data=json.dumps(ev).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as r:
            res = json.loads(r.read())
            if res["rejected"]:
                print("rejected:", res["rejected"])
    print(f"sent {len(events)} events as {run_id} in session {a.session}")


if __name__ == "__main__":
    main()

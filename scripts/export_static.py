"""Static export: the bench as plain files, replay only, no receiver. Any static host serves
it, from any subpath. Recordings carry their own map and story, so nothing else is needed.

uv run python scripts/export_static.py                          -> dist/bench/ with the examples
uv run python scripts/export_static.py --recordings <dir> ...    -> also every *.recording.jsonl there
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bench.server import recording_entry  # noqa: E402  (shared with the live picker)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist/bench"))
    ap.add_argument("--recordings", action="append", default=[], help="a directory of *.recording.jsonl (repeatable)")
    ap.add_argument("--no-examples", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    (out / "viewer").mkdir(parents=True)
    shutil.copy(ROOT / "viewer/index.html", out / "index.html")
    for f in ("layout.js", "logic.js", "bench.js", "sources.js"):
        shutil.copy(ROOT / "viewer" / f, out / "viewer" / f)
    shutil.copytree(ROOT / "shell", out / "shell")
    listing = []
    dirs = ([] if a.no_examples else [("examples", ROOT / "examples")]) + [("recordings", Path(d)) for d in a.recordings]
    for prefix, d in dirs:
        for p in sorted(d.glob("*.recording.jsonl")):
            (out / prefix).mkdir(exist_ok=True)
            shutil.copy(p, out / prefix / p.name)
            entry = recording_entry(prefix, p)
            if entry is not None:
                listing.append(entry)
    (out / "recordings.json").write_text(json.dumps(listing, indent=1))
    print(f"wrote {out}: {len(listing)} recordings")


if __name__ == "__main__":
    main()

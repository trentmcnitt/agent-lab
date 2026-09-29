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
    for f in ("bench.js", "sources.js"):
        shutil.copy(ROOT / "viewer" / f, out / "viewer" / f)
    shutil.copytree(ROOT / "shell", out / "shell")
    listing = []
    dirs = ([] if a.no_examples else [("examples", ROOT / "examples")]) + [("recordings", Path(d)) for d in a.recordings]
    for prefix, d in dirs:
        for p in sorted(d.glob("*.recording.jsonl")):
            (out / prefix).mkdir(exist_ok=True)
            shutil.copy(p, out / prefix / p.name)
            head = json.loads(p.read_text().split("\n", 1)[0])
            app = ((head.get("topology") or {}).get("app") or {}).get("name", "") if head.get("v") == "bench-recording/0" else ""
            listing.append({"path": f"{prefix}/{p.name}", "title": (app + " · " if app else "") + p.name.removesuffix(".recording.jsonl")})
    (out / "recordings.json").write_text(json.dumps(listing, indent=1))
    print(f"wrote {out}: {len(listing)} recordings")


if __name__ == "__main__":
    main()

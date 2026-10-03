"""The story harness (tests/story_harness.js) and the viewer-logic suite (tests/js/), run from
pytest. Both need Node 22+ and nothing else.

Reuse from another repo (e.g. the helpdesk):

    node <bench>/tests/story_harness.js --story app/bench/story.js demo/bench-recordings/*.recording.jsonl

or import `run_story_harness` from this file."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "tests/story_harness.js"
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node not installed")


def run_story_harness(recordings: list[Path | str], story: Path | str | None = None,
                      topology: Path | str | None = None) -> tuple[int, dict]:
    """Renders every story panel at every event of every recording, in both modes. Returns
    (exit code, summary); summary["failures"] lists what broke."""
    cmd = ["node", str(HARNESS)]
    if story:
        cmd += ["--story", str(story)]
    if topology:
        cmd += ["--topology", str(topology)]
    r = subprocess.run(cmd + [str(p) for p in recordings], capture_output=True, text=True, timeout=120)
    try:
        return r.returncode, json.loads(r.stdout)
    except json.JSONDecodeError:
        return r.returncode, {"failures": [r.stderr or r.stdout], "failure_count": 1}


def test_hello_agent_story_renders_everywhere():
    code, out = run_story_harness(sorted((ROOT / "examples").glob("hello-*.recording.jsonl")))
    assert code == 0, out["failures"]
    assert out["recordings"] == 2 and out["calls"] > 0


def test_the_standalone_story_file_matches(tmp_path):
    code, out = run_story_harness([ROOT / "examples/hello-answer.recording.jsonl"], story=ROOT / "examples/hello-agent.story.js")
    assert code == 0, out["failures"]


def test_harness_catches_a_broken_story(tmp_path):
    bad = tmp_path / "bad.js"
    bad.write_text("BenchStory.register('hello-agent', {panels: {triage: function (ev, ctx) {"
                   " if (ctx.mode === 'engineering') throw new Error('boom');"
                   " return 'Sent to ' + ev[0].data.missing; }}});")
    code, out = run_story_harness([ROOT / "examples/hello-answer.recording.jsonl"], story=bad)
    assert code == 1
    text = "\n".join(out["failures"])
    assert "threw boom" in text and 'contains "undefined"' in text


def test_harness_catches_a_story_that_never_registers(tmp_path):
    bad = tmp_path / "none.js"
    bad.write_text("BenchStory.register('some-other-app', {});")
    code, out = run_story_harness([ROOT / "examples/hello-answer.recording.jsonl"], story=bad)
    assert code == 1 and "never called BenchStory.register('hello-agent')" in out["failures"][0]


def test_viewer_logic_node_suite():
    files = sorted(str(p) for p in (ROOT / "tests/js").glob("*.test.js"))
    r = subprocess.run(["node", "--test", *files], capture_output=True, text=True, timeout=120, cwd=ROOT)
    assert r.returncode == 0, r.stdout[-3000:] + r.stderr[-2000:]


HELPDESK = ROOT.parent / "agent-lab/request-queue"


@pytest.mark.skipif(not (HELPDESK / "app/bench/story.js").exists(), reason="helpdesk checkout not beside the bench")
def test_helpdesk_story_renders_everywhere():
    """The helpdesk is the bench's main real consumer: its current story.js over every
    committed recording, in both modes."""
    recs = sorted((HELPDESK / "demo/bench-recordings").glob("*.recording.jsonl"))
    code, out = run_story_harness(recs, story=HELPDESK / "app/bench/story.js")
    assert code == 0, out["failures"]
    assert out["recordings"] == len(recs) >= 8 and out["calls"] > 0

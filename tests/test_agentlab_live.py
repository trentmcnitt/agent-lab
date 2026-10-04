"""Live, end to end: an app using the `agentlab` library, a real bench on its own port (8841).

The app runs in the library's environment with `agentlab.init(endpoint=...)`: real OTLP/HTTP
protobuf through the library's own exporter, into a real uvicorn bench, read back over HTTP and
the SSE stream. Two runs: one answered, one that pauses at a gate and is resumed.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PORT = 8841
BASE = f"http://127.0.0.1:{PORT}"
APP = "helpdesk-scenario"

SENDER = r"""
import sys
sys.path.insert(0, sys.argv[2])
import agentlab as lab
from agentlab import _state
import scenarios as sc
lab.init(sys.argv[1], service_name="helpdesk-svc")
story = __import__("pathlib").Path(sys.argv[3])
sc.register_handbook()
inst = sc.instrumentation(story)
sc.answer_run(inst, run_id="live:aaaa0001", thread="live")
sc.gate_pause(inst, "live2:bbbb0002", "live2")
_state.STATE.provider.force_flush()
sc.gate_resume(inst, "live2:bbbb0002", "live2")
_state.STATE.provider.force_flush()
print(inst.manifest_doc().hash)
"""


def _free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return r.status, r.headers, r.read()


@pytest.fixture
def bench(tmp_path):
    if not _free(PORT):
        pytest.skip(f"port {PORT} is in use")
    story = tmp_path / "story.js"
    env = {**os.environ, "BENCH_LOG_DIR": str(tmp_path / "log"), "BENCH_APPS_DIR": str(tmp_path / "apps"),
           "BENCH_MAPS_DIR": str(tmp_path / "maps"), "BENCH_RECORDINGS_DIR": str(tmp_path / "rec"),
           "AGENT_LAB_STORIES": f"{APP}={story}"}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "bench.server:app", "--host", "127.0.0.1",
                             "--port", str(PORT), "--log-level", "warning"], cwd=ROOT, env=env)
    try:
        end = time.time() + 20
        while _free(PORT):
            if proc.poll() is not None or time.time() > end:
                raise RuntimeError("the bench didn't start")
            time.sleep(0.1)
        yield tmp_path, story
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def test_a_library_app_shows_up_live(bench):
    tmp, story = bench
    # The scenario writes its story file where the bench was told to trust it.
    from_dir = tmp / "lib"
    r = subprocess.run(["uv", "run", "--quiet", "--project", str(ROOT / "sdk/python"), "python",
                        str(ROOT / "tests/fixtures/agentlab/scenarios.py"), str(from_dir)],
                       capture_output=True, text=True, timeout=300, cwd=ROOT)
    assert r.returncode == 0, r.stderr[-2000:]
    story.write_text((from_dir / f"{APP}.story.js").read_text())
    r = subprocess.run(["uv", "run", "--quiet", "--project", str(ROOT / "sdk/python"), "python", "-c", SENDER,
                        BASE, str(ROOT / "tests/fixtures/agentlab"), str(story)],
                       capture_output=True, text=True, timeout=120, cwd=ROOT)
    assert r.returncode == 0, r.stderr[-3000:]
    map_hash = r.stdout.strip().splitlines()[-1]

    end, runs = time.time() + 10, []
    while time.time() < end:
        runs = json.loads(_get("/runs")[2])
        if len(runs) == 2 and all(x.get("status") == "ok" for x in runs):
            break
        time.sleep(0.2)
    assert {x["run_id"] for x in runs} == {"live:aaaa0001", "live2:bbbb0002"}, runs
    assert all(x["status"] == "ok" and x["map_hash"] == map_hash and x["app"] == APP for x in runs)

    status, _, body = _get(f"/maps/{map_hash}")
    manifest = json.loads(body)
    assert status == 200 and manifest["app"]["id"] == APP and (tmp / "maps" / f"{map_hash}.json").exists()
    assert json.loads(_get(f"/topology/{APP}")[2]) == manifest
    status, _, js = _get(f"/apps/{APP}/story.js")
    assert status == 200 and b"BenchStory.register" in js

    # The stream a viewer reads: the gate run, in order, one step for the gate.
    with urllib.request.urlopen(BASE + "/stream?session_id=sess-2&app=" + APP, timeout=5) as resp:
        evs = []
        while not any(e["event_type"] == "run_finished" for e in evs):
            line = resp.readline().decode()
            if line.startswith("data: "):
                evs.append(json.loads(line[6:]))
    assert {e["run_id"] for e in evs} == {"live2:bbbb0002"}
    gate = [e["event_type"] for e in evs if e["node"] == "approval_gate"]
    assert gate == ["step_started", "gate_waiting", "gate_resolved", "step_finished"]
    assert [e["event_type"] for e in evs].count("run_started") == 1


def test_the_quickstart_langgraph_app_shows_up_live(bench):
    """The real LangGraph integration over a real socket: the example app, unchanged, run as its
    README says, with only AGENT_LAB_URL pointing at this bench's port."""
    example = ROOT / "examples/langgraph_quickstart"
    env = {**os.environ, "AGENT_LAB_URL": BASE}
    env.pop("VIRTUAL_ENV", None)
    r = subprocess.run(["uv", "run", "--quiet", "--project", str(example), "python", "-m", "support_bot",
                        "How do I reset my password?"], capture_output=True, text=True, timeout=300,
                       cwd=example, env=env)
    assert r.returncode == 0, r.stderr[-3000:]

    end, runs = time.time() + 10, []
    while time.time() < end:
        runs = json.loads(_get("/runs")[2])
        if runs and runs[0].get("status") == "ok":
            break
        time.sleep(0.2)
    assert len(runs) == 1 and runs[0]["app"] == "support-assistant" and runs[0]["status"] == "ok", runs
    manifest = json.loads(_get(f"/maps/{runs[0]['map_hash']}")[2])
    assert manifest["derived"]["from"] == "langgraph" and manifest["app"]["io"] == {"request": "question", "reply": "answer"}
    assert not [w for w in manifest["derived"]["warnings"] if w["severity"] == "error"]

    with urllib.request.urlopen(BASE + "/stream?app=support-assistant", timeout=5) as resp:
        evs = []
        while not any(e["event_type"] == "run_finished" for e in evs):
            line = resp.readline().decode()
            if line.startswith("data: "):
                evs.append(json.loads(line[6:]))
    nodes = []
    for e in evs:
        if e["event_type"] == "step_started":
            nodes.append(e["node"])
    assert nodes == ["retrieve", "classify", "draft_answer", "check_grounding", "respond"]
    on = {(e["node"], e["event_type"]) for e in evs}
    assert {("retrieve", "retrieval"), ("classify", "llm_call"), ("classify", "decision"),
            ("draft_answer", "llm_call"), ("check_grounding", "check_result")} <= on
    started = next(e for e in evs if e["event_type"] == "run_started")
    assert started["data"]["map_hash"] == runs[0]["map_hash"]

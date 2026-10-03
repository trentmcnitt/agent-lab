import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import bench.server as srv
from adapters import otlp

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "LOG_DIR", tmp_path / "log")
    monkeypatch.setattr(srv, "APPS_DIR", tmp_path / "apps")
    srv.store.events.clear()
    srv.store.otlp = otlp.TraceState()
    srv.store.load_apps()
    return TestClient(srv.app)


def example():
    rows = [json.loads(l) for l in (ROOT / "examples/hello-answer.recording.jsonl").read_text().splitlines()]
    return rows[0], rows[1:]


def test_bench_starts_knowing_no_apps(c):
    assert c.get("/topologies").json() == []
    assert c.get("/topology/hello-agent").status_code == 404


def test_register_app_with_story_persists(c, tmp_path):
    head, _ = example()
    r = c.put("/apps/hello-agent", json={"topology": head["topology"], "story": head["story"]})
    assert r.json() == {"ok": True, "app": "hello-agent", "story": True}
    assert c.get("/topologies").json() == [{"id": "hello-agent", "name": head["topology"]["app"]["name"], "story": True}]
    assert "BenchStory.register" in c.get("/apps/hello-agent/story.js").text
    # A restarted bench still knows the app.
    srv.store.load_apps()
    assert "hello-agent" in srv.store.topologies and "hello-agent" in srv.store.stories
    # Re-registering without a story removes it.
    c.put("/apps/hello-agent", json={"topology": head["topology"], "story": None})
    assert c.get("/apps/hello-agent/story.js").status_code == 404


def test_register_rejects_bad_maps(c):
    head, _ = example()
    assert c.put("/apps/other", json={"topology": head["topology"]}).status_code == 400
    bad = {**head["topology"], "edges": [{"from": "a", "to": "b", "when": "x"}]}
    assert "when" in c.put("/apps/hello-agent", json={"topology": bad}).json()["error"]


def test_ingest_validates_each_event(c):
    _, events = example()
    bad = {"v": "bench/0", "run_id": "x", "node": "n", "event_type": "llm_call", "ts": 1, "data": {"model": "m"}}
    r = c.post("/ingest", json=events + [bad]).json()
    assert r["accepted"] == len(events)
    assert r["rejected"][0]["index"] == len(events) and "input_tokens" in r["rejected"][0]["error"]
    runs = c.get("/runs").json()
    assert len(runs) == 1 and runs[0]["status"] == "ok"
    assert c.get("/runs?session_id=nope").json() == []
    assert c.post("/ingest", content=b"nope").status_code == 400


def test_otlp_endpoint(c):
    ns = 10**18
    body = {"resourceSpans": [{"scopeSpans": [{"spans": [{
        "traceId": "a" * 32, "spanId": "b" * 16, "name": "chat m", "startTimeUnixNano": str(ns),
        "endTimeUnixNano": str(ns + 5_000_000), "status": {"code": 1},
        "attributes": [{"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
                       {"key": "gen_ai.request.model", "value": {"stringValue": "m"}},
                       {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "10"}},
                       {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "2"}}]}]}]}]}
    assert c.post("/v1/traces?session_id=o1", json=body).json() == {}
    assert c.get("/runs?session_id=o1").json()[0]["events"] == 5  # a root model call is the run and its step
    assert c.post("/v1/traces", content=b"x", headers={"content-type": "text/plain"}).status_code == 415


def test_pages_and_recordings(c):
    for path in ("/", "/viewer/bench.js", "/shell/", "/shell/chip.js", "/examples/hello-answer.recording.jsonl"):
        assert c.get(path).status_code == 200, path
    titles = [r["title"] for r in c.get("/recordings.json").json()]
    assert "Hello agent (synthetic example) · hello-answer" in titles

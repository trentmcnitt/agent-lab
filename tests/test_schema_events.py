"""The event schema's 10-03 additions (check_result and its check alias, content_mode absent,
retrieval source, decision cited, llm_call context_items, run_finished baseline), and the
receiver's handling of them: the alias is normalized on ingest, and a stored map that fails
validation is logged rather than silently dropped."""
import asyncio
import json
import logging
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from starlette.testclient import TestClient

import bench.server as srv

ROOT = Path(__file__).resolve().parents[1]
EVENT = Draft202012Validator(json.loads((ROOT / "schema/bench-event.schema.json").read_text()))


def ev(event_type, data=None, **kw):
    e = {"v": "bench/0", "run_id": "r1", "node": kw.pop("node", "n"), "event_type": event_type, "ts": 1.0, **kw}
    if data is not None:
        e["data"] = data
    return e


def ok(e):
    return not list(EVENT.iter_errors(e))


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "LOG_DIR", tmp_path / "log")
    monkeypatch.setattr(srv, "APPS_DIR", tmp_path / "apps")
    srv.store.events.clear()
    srv.store.load_apps()
    return TestClient(srv.app)


# --- schema ---

@pytest.mark.parametrize("et", ["check_result", "check"])
def test_check_result_shape(et):
    assert ok(ev(et, {"name": "grounding", "passed": True}))
    assert ok(ev(et, {"name": "grounding", "passed": False, "state": "failed", "detail": "no overlap",
                      "evidence": ["h-01"], "kind": "grounding", "app_specific": 0.4}))
    assert ok(ev(et, {"name": "permission", "passed": True, "state": "not_on_path"}))
    assert not ok(ev(et, {"name": "grounding"}))
    assert not ok(ev(et, {"passed": True}))
    assert not ok(ev(et, {"name": "g", "passed": "yes"}))
    assert not ok(ev(et, {"name": "g", "passed": True, "state": "skipped"}))
    assert not ok(ev(et, {"name": "g", "passed": True, "evidence": "h-01"}))
    assert not ok(ev(et))


def test_bespoke_check_result_shape():
    # What Bespoke's playground already emits.
    assert ok(ev("check_result", {"name": "non-empty", "passed": True, "detail": "completion has content"}))


def test_content_mode_absent():
    assert ok(ev("step_started", {}, content_mode="absent"))
    assert ok(ev("step_started", {}, content_mode="full"))
    assert not ok(ev("step_started", {}, content_mode="masked"))


def test_retrieval_source_and_decision_cited():
    assert ok(ev("retrieval", {"source": "handbook", "hits": [{"id": "h-01", "score": 0.9}]}))
    assert not ok(ev("retrieval", {"source": 3, "hits": []}))
    assert ok(ev("decision", {"branch": "grounded", "cited": ["h-01", "h-02"]}))
    assert not ok(ev("decision", {"cited": "h-01"}))


def test_llm_call_context_items():
    base = {"model": "m", "input_tokens": 1, "output_tokens": 1}
    assert ok(ev("llm_call", {**base, "context_items": ["h-01"]}))
    assert not ok(ev("llm_call", {**base, "context_items": [1]}))


def test_run_finished_baseline():
    assert ok(ev("run_finished", {"status": "ok", "baseline": "~10-15 minutes"}, node="_run"))
    assert not ok(ev("run_finished", {"status": "ok", "baseline": 600}, node="_run"))


# --- receiver ---

def test_check_alias_normalized_on_ingest(c, tmp_path):
    good = ev("check", {"name": "grounding", "passed": True}, session_id="s1")
    bad = ev("check", {"name": "grounding"}, session_id="s1")
    r = c.post("/ingest", json=[good, bad]).json()
    assert r["accepted"] == 1 and r["rejected"][0]["index"] == 1 and "passed" in r["rejected"][0]["error"]
    stored = srv.store.backlog("s1")
    assert [e["event_type"] for e in stored] == ["check_result"]
    assert stored[0]["data"] == {"name": "grounding", "passed": True}
    logged = [json.loads(l) for f in (tmp_path / "log").glob("*.jsonl") for l in f.read_text().splitlines()]
    assert [e["event_type"] for e in logged] == ["check_result"]


def test_check_alias_reaches_live_subscribers_as_check_result(c):
    # /stream fans out from store.subscribers; a subscriber sees what was stored.
    q = asyncio.Queue()
    srv.store.subscribers.add((q, "s2"))
    try:
        c.post("/ingest", json=ev("check", {"name": "g", "passed": False}, session_id="s2"))
    finally:
        srv.store.subscribers.discard((q, "s2"))
    assert q.get_nowait()["event_type"] == "check_result"


def test_check_result_passes_through_unchanged(c):
    e = ev("check_result", {"name": "g", "passed": True}, session_id="s3")
    assert c.post("/ingest", json=e).json()["accepted"] == 1
    assert srv.store.backlog("s3") == [e]


def test_register_accepts_a_map_with_every_field(c):
    t = json.loads((ROOT / "tests/fixtures/maps/every-field.json").read_text())
    assert c.put("/apps/every-field", json={"topology": t}).status_code == 200
    bad = {**t, "note": "x"}
    r = c.put("/apps/every-field", json={"topology": bad})
    assert r.status_code == 400 and "note" in r.json()["error"]


def test_load_apps_logs_invalid_stored_maps(c, tmp_path, caplog):
    head = json.loads((ROOT / "tests/fixtures/maps/hello-agent.v0.json").read_text())
    (tmp_path / "apps/good").mkdir(parents=True)
    (tmp_path / "apps/good/topology.json").write_text(json.dumps(head))
    (tmp_path / "apps/stale").mkdir()
    (tmp_path / "apps/stale/topology.json").write_text(json.dumps({**head, "app": {"id": "stale", "name": "S"}, "when": 1}))
    (tmp_path / "apps/broken").mkdir()
    (tmp_path / "apps/broken/topology.json").write_text("{not json")
    with caplog.at_level(logging.WARNING, logger="bench.server"):
        srv.store.load_apps()
    assert set(srv.store.topologies) == {"hello-agent"}
    msgs = [r.getMessage() for r in caplog.records if r.name == "bench.server"]
    assert any("stale" in m and "when" in m for m in msgs)
    assert any("broken" in m and "unreadable" in m for m in msgs)
    assert not any("good" in m for m in msgs)

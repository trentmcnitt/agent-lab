"""The v0 format: the example recordings and map validate, and an OTLP export shaped like
a real exporter's converts. App-specific conversions are tested in each app's own repo."""
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from adapters import otlp

ROOT = Path(__file__).resolve().parents[1]
EVENT = Draft202012Validator(json.loads((ROOT / "schema/bench-event.schema.json").read_text()))
TOPO = Draft202012Validator(json.loads((ROOT / "schema/bench-topology.schema.json").read_text()))
RECORDINGS = sorted((ROOT / "examples").glob("*.recording.jsonl"))


def load(p):
    rows = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    assert rows[0]["v"] == "bench-recording/0"
    return rows[0], rows[1:]


def check_run(events, topo):
    for e in events:
        errs = list(EVENT.iter_errors(e))
        assert not errs, f"{e['event_type']}@{e['node']}: {errs[0].message}"
    assert [e["seq"] for e in events] == list(range(len(events)))
    assert [e["ts"] for e in events] == sorted(e["ts"] for e in events)
    assert events[0]["event_type"] == "run_started" and events[-1]["event_type"] == "run_finished"
    opened = {e["step_id"] for e in events if e["event_type"] == "step_started"}
    assert opened == {e["step_id"] for e in events if e["event_type"] == "step_finished"}
    known = {n["id"] for n in topo["nodes"]} | {"_run"}
    assert {e["node"] for e in events} <= known
    branches = {(ed["from"], ed.get("from_branch")) for ed in topo["edges"]}
    for e in events:
        if e["event_type"] == "decision" and "branch" in e["data"]:
            assert (e["node"], e["data"]["branch"]) in branches, "a reported branch must exist in the map"


@pytest.mark.parametrize("path", RECORDINGS, ids=lambda p: p.stem)
def test_example_recordings(path):
    head, events = load(path)
    assert not list(TOPO.iter_errors(head["topology"]))
    ids = {n["id"] for n in head["topology"]["nodes"]}
    assert all(e["from"] in ids and e["to"] in ids for e in head["topology"]["edges"])
    if head["topology"]["app"]["id"] == "hello-agent":       # the hand-written example ships a story
        assert "BenchStory.register('hello-agent'" in head["story"]
    check_run(events, head["topology"])


def test_example_files_match_the_recordings():
    head, _ = load(ROOT / "examples/hello-answer.recording.jsonl")
    assert json.loads((ROOT / "examples/hello-agent.topology.json").read_text()) == head["topology"]


def _kv(k, v):
    if isinstance(v, bool):
        return {"key": k, "value": {"boolValue": v}}
    if isinstance(v, int):
        return {"key": k, "value": {"intValue": str(v)}}
    if isinstance(v, float):
        return {"key": k, "value": {"doubleValue": v}}
    if isinstance(v, list):
        return {"key": k, "value": {"arrayValue": {"values": [{"stringValue": x} for x in v]}}}
    return {"key": k, "value": {"stringValue": v}}


def test_otlp_exporter_shaped_span():
    ns = 1790567453_000_000_000
    body = {"resourceSpans": [{"resource": {"attributes": [_kv("service.name", "some-app")]},
        "scopeSpans": [{"spans": [{
            "traceId": "0af7651916cd43dd8448eb211c80319c", "spanId": "b7ad6b7169203331",
            "name": "text_completion claude-haiku-4-5", "kind": 3,
            "startTimeUnixNano": str(ns), "endTimeUnixNano": str(ns + 840_000_000), "status": {"code": 1},
            "attributes": [_kv(k, v) for k, v in {
                "gen_ai.operation.name": "text_completion", "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": "claude-haiku-4-5", "gen_ai.usage.input_tokens": 1200,
                "gen_ai.usage.cache_read.input_tokens": 1000, "gen_ai.usage.cache_write.input_tokens": 0,
                "gen_ai.usage.output_tokens": 30, "gen_ai.usage.cost": 0.0004,
                "gen_ai.response.finish_reasons": ["end_turn"],
                "gen_ai.system_instructions": json.dumps([{"type": "text", "content": "Complete the text."}]),
                "gen_ai.input.messages": json.dumps([{"role": "user", "parts": [{"type": "text", "content": "Hello wor"}]}]),
                "gen_ai.output.messages": json.dumps([{"role": "assistant", "parts": [{"type": "text", "content": "ld"}]}])}.items()]}]}]}]}
    out = otlp.convert(body, session_id="play-1")
    for e in out:
        assert not list(EVENT.iter_errors(e)), e
    llm = next(e for e in out if e["event_type"] == "llm_call")["data"]
    assert llm["input_tokens"] == 1200 and llm["cache_read_tokens"] == 1000
    assert llm["cost_source"] == "actual" and llm["finish_reason"] == "end_turn"
    assert llm["system"] == "Complete the text."
    assert llm["messages"] == [{"role": "user", "content": "Hello wor"}] and llm["output"] == "ld"
    assert next(e for e in out if e["event_type"] == "step_finished")["data"]["latency_ms"] == 840.0


def test_otlp_error_span_and_old_cache_name():
    ns = 10**18
    body = {"resourceSpans": [{"scopeSpans": [{"spans": [{
        "traceId": "a" * 32, "spanId": "b" * 16, "name": "chat m", "startTimeUnixNano": str(ns),
        "endTimeUnixNano": str(ns + 5_000_000), "status": {"code": 2, "message": "429"},
        "attributes": [_kv("gen_ai.operation.name", "chat"), _kv("gen_ai.request.model", "m"),
                       _kv("gen_ai.usage.input_tokens", 10), _kv("gen_ai.usage.cache_creation.input_tokens", 4),
                       _kv("gen_ai.usage.output_tokens", 0)]}]}]}]}
    out = otlp.convert(body, price=lambda *a: 0.001)
    for e in out:
        assert not list(EVENT.iter_errors(e)), e
    llm = next(e for e in out if e["event_type"] == "llm_call")["data"]
    assert llm["cache_write_tokens"] == 4 and llm["cost_source"] == "estimated"
    assert any(e["event_type"] == "error" and e["data"]["message"] == "429" for e in out)

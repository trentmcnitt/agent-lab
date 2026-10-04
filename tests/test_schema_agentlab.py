"""The schema additions for maps the agentlab library builds (SPEC.md 8.5): app.baseline,
nodes[].doc/parent/branches_unknown, story as {id, sha256}, top-level derived; and on events,
run_started.data.map_hash and check_result.data.words. All optional: v0 maps and events still
validate (test_schema_map.py and test_schema_events.py keep checking that)."""
import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
TOPO = Draft202012Validator(json.loads((ROOT / "schema/bench-topology.schema.json").read_text()))
EVENT = Draft202012Validator(json.loads((ROOT / "schema/bench-event.schema.json").read_text()))
BUILT = json.loads((ROOT / "tests/fixtures/maps/library-built.json").read_text())


def errors(t):
    return [e.message for e in TOPO.iter_errors(t)]


def at(t, path):
    obj = t
    for k in path[:-1]:
        obj = obj[k]
    return obj, path[-1]


def test_library_built_map_validates():
    assert errors(BUILT) == []


def test_story_true_still_validates():
    t = copy.deepcopy(BUILT)
    t["story"] = True
    assert errors(t) == []


@pytest.mark.parametrize("path,value", [
    (("app", "baseline"), 15),
    (("nodes", 0, "doc"), ["not", "a", "string"]),
    (("nodes", 3, "parent"), ""),
    (("nodes", 4, "branches_unknown"), "yes"),
    (("story",), {"id": "x"}),
    (("story",), {"id": "x", "sha256": "not-hex"}),
    (("story",), {"id": "x", "sha256": "0" * 64, "file": "story.js"}),
    (("story",), "story.js"),
    (("derived", "hashes", "structure"), "short"),
    (("derived", "hashes", "other"), "0" * 64),
    (("derived", "warnings", 0, "severity"), "fatal"),
    (("derived", "warnings", 0, "code"), "E3"),
    (("derived", "fingerprints", "node:classify"), "ok"),
    (("derived", "note"), "not a field"),
])
def test_bad_values_rejected(path, value):
    t = copy.deepcopy(BUILT)
    obj, key = at(t, path)
    obj[key] = value
    assert errors(t)


def test_warning_requires_code_severity_message():
    for key in ("code", "severity", "message"):
        t = copy.deepcopy(BUILT)
        del t["derived"]["warnings"][0][key]
        assert any(key in m for m in errors(t))


def test_derived_takes_x_keys():
    t = copy.deepcopy(BUILT)
    t["derived"]["x-anything"] = 1
    assert errors(t) == []


def ev(event_type, data):
    return {"v": "bench/0", "run_id": "r", "node": "_run" if event_type == "run_started" else "n",
            "event_type": event_type, "ts": 1.0, "data": data}


def test_run_started_map_hash():
    assert not list(EVENT.iter_errors(ev("run_started", {"map_hash": "a" * 64})))
    assert list(EVENT.iter_errors(ev("run_started", {"map_hash": "not a hash"})))
    assert not list(EVENT.iter_errors(ev("run_started", {})))


def test_check_result_words():
    good = ev("check_result", {"name": "unsure", "passed": False,
                               "words": {"passed": "Didn't trigger", "failed": "Sent to a person"}})
    assert not list(EVENT.iter_errors(good))
    bad = ev("check_result", {"name": "unsure", "passed": False, "words": {"maybe": "x"}})
    assert list(EVENT.iter_errors(bad))

"""The map schema (bench-topology/0, opened 10-03): maps written before the new fields still
validate, a map using every new field validates, x- keys pass at every level, and any other
unknown key is still rejected. The old maps are snapshots taken before 10-03 (the live files
in each app move on)."""
import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
MAPS = ROOT / "tests/fixtures/maps"
TOPO = Draft202012Validator(json.loads((ROOT / "schema/bench-topology.schema.json").read_text()))
OLD = sorted(MAPS.glob("*.v0.json"))


def errors(t):
    return [e.message for e in TOPO.iter_errors(t)]


def full():
    return json.loads((MAPS / "every-field.json").read_text())


@pytest.mark.parametrize("path", OLD, ids=lambda p: p.stem)
def test_old_maps_still_validate(path):
    assert errors(json.loads(path.read_text())) == []


def test_old_snapshots_present():
    assert {p.stem for p in OLD} == {"hello-agent.v0", "helpdesk.v0", "bespoke-playground.v0"}


def test_the_shipped_example_map_validates():
    assert errors(json.loads((ROOT / "examples/hello-agent.topology.json").read_text())) == []


def test_every_new_field_validates():
    assert errors(full()) == []


# Where in the map each object lives, so x- and unknown keys can be tried at every level.
LEVELS = {
    "top": lambda t: t,
    "app": lambda t: t["app"],
    "node": lambda t: t["nodes"][0],
    "edge": lambda t: t["edges"][0],
    "panel": lambda t: t["panels"][0],
    "source": lambda t: t["sources"][0],
    "source item": lambda t: t["sources"][0]["items"][0],
    "action": lambda t: t["actions"][0],
}


@pytest.mark.parametrize("level", LEVELS)
def test_x_keys_accepted(level):
    t = full()
    LEVELS[level](t)["x-anything"] = {"nested": [1, 2]}
    assert errors(t) == []


@pytest.mark.parametrize("level", LEVELS)
def test_unknown_plain_keys_rejected(level):
    t = full()
    LEVELS[level](t)["note"] = "not a field"
    assert any("note" in m for m in errors(t))


def test_x_prefix_is_exact():
    t = full()
    t["X-upper"] = 1
    t["nodes"][0]["xfoo"] = 1
    assert len(errors(t)) == 2


@pytest.mark.parametrize("path,value", [
    (("nodes", 0, "actor"), "robot"),
    (("nodes", 0, "kind"), "guard"),
    (("nodes", 0, "moment"), "yes"),
    (("panels", 0, "audience"), "everyone"),
    (("sources", 0, "count"), -1),
    (("never",), "one string, not a list"),
    (("app", "privacy_note"), 3),
])
def test_bad_values_rejected(path, value):
    t = full()
    obj = t
    for k in path[:-1]:
        obj = obj[k]
    obj[path[-1]] = value
    assert errors(t)


def test_kind_check_and_actor_values():
    t = full()
    for actor in ("ai", "rule", "person", "app"):
        t["nodes"][2]["actor"] = actor
        assert errors(t) == []
    assert t["nodes"][2]["kind"] == "check"


def test_source_items_carry_no_text():
    t = full()
    t["sources"][0]["items"][0]["text"] = "Item text comes only from retrieval hits."
    assert any("text" in m for m in errors(t))


@pytest.mark.parametrize("key", ["id", "title", "kind", "description"])
def test_source_required_fields(key):
    t = full()
    del t["sources"][0][key]
    assert any(key in m for m in errors(t))


@pytest.mark.parametrize("key", ["id", "title", "description"])
def test_action_required_fields(key):
    t = full()
    del t["actions"][0][key]
    assert any(key in m for m in errors(t))


def test_new_sections_are_optional():
    t = full()
    for k in ("sources", "actions", "never"):
        del t[k]
    for k in ("privacy_note", "track_record"):
        del t["app"][k]
    assert errors(t) == []


def test_old_maps_gain_new_fields_without_breaking():
    # Adding the new optional fields to an old map is all an app has to do.
    t = json.loads((MAPS / "hello-agent.v0.json").read_text())
    t2 = copy.deepcopy(t)
    for n in t2["nodes"]:
        n["plain_label"] = n.get("label", n["id"]).title()
    t2["edges"][0]["description"] = "Answerable from the docs."
    t2["sources"] = [{"id": "docs", "title": "Docs", "kind": "documents", "description": "The product docs."}]
    assert errors(t2) == []

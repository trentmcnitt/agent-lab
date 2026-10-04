import json
from pathlib import Path

import pytest

from agentlab import _corpora, _state
from agentlab._util import reset_log_once

BENCH = Path(__file__).resolve().parents[3]
TOPOLOGY_SCHEMA = BENCH / "schema" / "bench-topology.schema.json"
EVENT_SCHEMA = BENCH / "schema" / "bench-event.schema.json"


@pytest.fixture(autouse=True)
def fresh_process():
    """Each test starts as a fresh process would: Agent Lab off, no corpora, no logged reasons."""
    old = _state.swap(_state.State())
    _corpora.clear()
    reset_log_once()
    yield
    current = _state.swap(old)
    if current.provider is not None and not current.shared:
        current.provider.shutdown()
    _corpora.clear()


@pytest.fixture
def topology_validator():
    from jsonschema import Draft202012Validator
    return Draft202012Validator(json.loads(TOPOLOGY_SCHEMA.read_text()))


def attrs(span):
    return dict(span.attributes or {})


def by_kind(spans, kind):
    return [s for s in spans if (s.attributes or {}).get("agentlab.kind") == kind]


def events(span, name):
    return [dict(e.attributes or {}) for e in span.events if e.name == name]

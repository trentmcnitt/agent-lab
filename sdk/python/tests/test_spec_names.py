"""SPEC.md section 8 and `_semconv` name the same wire: a name added, renamed or dropped on one
side without the other fails here."""
import re

from agentlab import _semconv as sc
from conftest import BENCH

# `agentlab.`-prefixed tokens in the SPEC that are Python API or file names, not wire names.
API = {"agentlab.lock.json", "agentlab.init", "agentlab.verify", "agentlab.lock", "agentlab.langgraph.instrument"}


def section_8():
    spec = (BENCH / "SPEC.md").read_text()
    return spec[spec.index("## 8. Agent Lab on OpenTelemetry"):]


def test_every_wire_name_is_in_the_spec_and_back():
    spec_names = set(re.findall(r"`(agentlab\.[a-z_.]+[a-z_])", section_8())) - API
    code_names = {v for k, v in vars(sc).items() if k.isupper() and isinstance(v, str) and v.startswith("agentlab.")}
    assert sorted(spec_names - code_names) == [], "named in SPEC.md 8 but not in _semconv"
    assert sorted(code_names - spec_names) == [], "in _semconv but not documented in SPEC.md 8"

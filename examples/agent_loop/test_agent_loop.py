"""The agent loop lands on its one step, every call in it, in the order the calls started."""
import os

os.environ.setdefault("AGENT_LOOP_TIME_SCALE", "0.05")  # the test runs fast; record.py runs at full time

from agentlab.testing import capture  # noqa: E402

from vpn_agent import build_graph  # noqa: E402

Q = "my vpn keeps dropping every 20 min since yesterday, can someone reset it? i'm on the office wifi (from gtalvert)"


def test_every_call_is_on_the_research_step_and_two_tools_overlap():
    with capture() as spans:
        out = build_graph().invoke({"question": Q})
    assert "KB-114" in out["reply"]
    node = {s.context.span_id: s.attributes.get("agentlab.node") for s in spans if s.attributes.get("agentlab.kind") == "node"}
    research = next(k for k, v in node.items() if v == "research")
    calls = [s for s in spans if s.attributes.get("agentlab.kind") in ("chat", "tool")]
    assert [s.attributes.get("agentlab.node") for s in calls] == ["research"] * 6
    assert all(s.parent.span_id == research for s in calls)
    by = {s.attributes.get("gen_ai.tool.name"): s for s in calls if s.attributes.get("gen_ai.tool.name")}
    a, b = by["get_user"], by["create_draft"]
    assert a.start_time < b.end_time and b.start_time < a.end_time, "the two tools the AI asked for together ran at once"

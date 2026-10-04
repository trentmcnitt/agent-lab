"""What an app's own CI runs: the words written for Agent Lab still match the code."""
import agentlab as lab
from agentlab.testing import capture

from support_bot import build_graph


def test_agent_lab_words_match_code():
    lab.verify(build_graph(), strict=True)     # strict: also fail when worded code changed since `lock`


def test_a_run_is_attributed_to_its_steps():
    with capture() as spans:
        build_graph().invoke({"question": "How do I reset my password?"})
    nodes = [s.attributes["agentlab.node"] for s in spans if s.attributes.get("agentlab.kind") == "node"]
    assert nodes == ["retrieve", "classify", "draft_answer", "check_grounding", "respond"]

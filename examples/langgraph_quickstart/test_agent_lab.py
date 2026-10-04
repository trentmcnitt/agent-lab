"""What an app's own CI runs: the words written for Agent Lab still match the code."""
import agentlab as lab
from agentlab.testing import capture

from support_bot import build_graph


def test_agent_lab_words_match_code():
    lab.verify(build_graph(), strict=True)     # strict: also fail when worded code changed since `lock`


def test_a_run_is_attributed_to_its_steps():
    """Every span lands on a step the graph has. No step names are typed here, so renaming a node
    or adding a branch doesn't break this test (verify above is what checks the words)."""
    graph = build_graph()
    steps = {n["id"] for n in lab.manifest.find(graph).manifest()["nodes"]}
    with capture() as spans:
        graph.invoke({"question": "How do I reset my password?"})
    ran = [s.attributes["agentlab.node"] for s in spans if s.attributes.get("agentlab.kind") == "node"]
    assert ran and set(ran) <= steps
    chats = [s.attributes.get("agentlab.node") for s in spans if s.attributes.get("agentlab.kind") == "chat"]
    assert chats and set(chats) <= steps     # each model call on the step that made it

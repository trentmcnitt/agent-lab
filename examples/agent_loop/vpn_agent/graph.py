"""One step that runs an agent loop, shown on Agent Lab.

    research ─▶ check_draft ─(cites the KB)──▶ post_reply
                            └(cites nothing)─▶ handoff

`research` is a whole tool-using agent inside one LangGraph node: the model picks its own next move
each turn (a tool, two tools at once, or the final answer). Agent Lab shows the node once on the map
and, inside it, every model and tool call in the order they started. Nothing here is typed for the
bench beyond the step words and one check.
"""
from __future__ import annotations

import re
from typing import Literal, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

import agentlab as lab
from agentlab.langgraph import instrument

from .model import ChatScriptedAgent
from .tools import TOOLS

APP = lab.App(
    name="VPN helpdesk agent",
    id="vpn-agent",
    description="Answers VPN trouble in the helpdesk channel: an agent that searches the knowledge base, looks up the person and drafts a reply.",
    baseline="~10 minutes for someone on the IT desk",
    request="question",
    reply="reply",
)

KB_ID = re.compile(r"\bKB-\d+\b")


class State(TypedDict, total=False):
    question: str
    reply: str
    cites: list[str]


def make_builder(model: ChatScriptedAgent | None = None) -> StateGraph:
    model = model or ChatScriptedAgent()
    tools = ToolNode(TOOLS)

    @lab.step("Research the request", actor="ai",
              says="The AI works the request on its own: each answer asks for a tool or finishes.")
    def research(state: State) -> State:
        """A tool-calling loop: search_kb, get_user, create_draft; at most five model turns."""
        messages = [SystemMessage("You are the IT helpdesk agent. Use the tools, then reply to the person."),
                    HumanMessage(state["question"])]
        for _ in range(5):
            answer = model.invoke(messages)
            messages.append(answer)
            if not answer.tool_calls:
                break
            messages.extend(tools.invoke({"messages": messages})["messages"])
        return {"reply": str(messages[-1].content)}

    @lab.step("Check the reply", actor="rule", moment=True,
              says="The reply must point to a knowledge-base article.",
              paths={"cites": lab.path("cites the KB"), "no_cite": lab.path("cites nothing", says="No article backs it, so a person checks it.")})
    def check_draft(state: State) -> State:
        """Pass when the reply names at least one KB article."""
        cites = KB_ID.findall(state.get("reply") or "")
        lab.check("cites_kb", bool(cites), evidence=cites, detail=f"cites {', '.join(cites) or 'nothing'}",
                  words={"passed": "It points to a KB article.", "failed": "It points to nothing."})
        return {"cites": cites}

    def route(state: State) -> Literal["cites", "no_cite"]:
        return "cites" if state.get("cites") else "no_cite"

    @lab.step("Post the reply", actor="app")
    def post_reply(state: State) -> State:
        """Post the reply in the thread."""
        lab.outcome("answered")
        return {}

    @lab.step("Hand to a person", actor="app", says="Someone on the IT desk gets the request and the draft.")
    def handoff(state: State) -> State:
        """Queue for a person."""
        lab.outcome("handed_off")
        return {}

    b = StateGraph(State)
    for name, fn in (("research", research), ("check_draft", check_draft), ("post_reply", post_reply), ("handoff", handoff)):
        b.add_node(name, fn)
    b.add_edge(START, "research")
    b.add_edge("research", "check_draft")
    b.add_conditional_edges("check_draft", route, {"cites": "post_reply", "no_cite": "handoff"})
    b.add_edge("post_reply", END)
    b.add_edge("handoff", END)
    return b


def build_graph(**parts):
    return instrument(make_builder(**parts).compile(), app=APP)

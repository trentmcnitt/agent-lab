"""A support assistant over the messy folder, as a LangGraph graph.

    retrieve -> answer -> check_sources -(grounded)-> respond
                                        \\-(not_grounded)-> handoff

The model is scripted (`model.py`): a real LangChain chat model whose answer is computed from the
prompt, so this runs with no API key. It cites passages the way real prompts usually ask a model
to, by their number in the prompt ([1], [2]); the app maps the numbers back to passage ids.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Literal, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

import agentlab as lab
from agentlab.langgraph import instrument

from .ingest import CORPUS_ID, Index, build_index
from .model import ChatScripted

DOCS = Path(__file__).resolve().parents[1] / "docs"

APP = lab.App(
    name="Support assistant (shared drive)",
    id="messy-support",
    description="Answers agents' questions from the team's shared folder of policies, notes and PDFs.",
    request="question",
    reply="answer",
)

NUMBER = re.compile(r"\[(\d+)\]")


class State(TypedDict, total=False):
    question: str
    hits: list[dict]
    answer: str
    cited: list[str]
    grounded: bool


def make_builder(index: Index | None = None, model: ChatScripted | None = None) -> StateGraph:
    index = index or build_index(DOCS)
    model = model or ChatScripted()

    @lab.step("Search the shared drive", says="A keyword search picks the passages that best match the question.",
              actor="app", kind="retrieval")
    def retrieve(state: State) -> State:
        """BM25 over every passage of every file; the top 4 go to the model."""
        docs = index.retriever.invoke(state["question"])
        hits = [{"id": d.id, "title": d.metadata["title"], "text": d.page_content, "score": d.metadata["score"],
                 "passage": d.metadata["passage"], "passages": d.metadata["passages"],
                 **({"page": d.metadata["page"]} if "page" in d.metadata else {})} for d in docs]
        lab.retrieved(CORPUS_ID, hits, query=state["question"])
        return {"hits": hits}

    @lab.step("Write the answer", says="The AI answers from the passages it was given and cites them.", actor="ai")
    def answer(state: State) -> State:
        """Numbered passages in the prompt; the reply cites them as [n]."""
        numbered = "\n\n".join(f"[{i}] {h['text']}" for i, h in enumerate(state["hits"], start=1))
        reply = model.invoke([
            SystemMessage("Answer the agent's question using only the numbered passages. Cite each as [n]."),
            HumanMessage(f"Question: {state['question']}\n\nPassages:\n{numbered}"),
        ])
        nums = [int(n) for n in NUMBER.findall(reply.content)]
        cited = [state["hits"][n - 1]["id"] for n in nums if 1 <= n <= len(state["hits"])]
        lab.decision(f"Answered from {len(cited)} passage{'s' if len(cited) != 1 else ''}.", cited=cited)
        return {"answer": reply.content, "cited": cited}

    @lab.step("Check the sources", says="The answer must cite at least one passage the search returned.",
              actor="rule", moment=True,
              paths={"grounded": lab.path("cites what it was given"),
                     "not_grounded": lab.path("cites nothing it was given")})
    def check_sources(state: State) -> State:
        """Pass when the reply cites at least one retrieved passage and nothing else."""
        retrieved = {h["id"] for h in state["hits"]}
        ok = bool(state["cited"]) and set(state["cited"]) <= retrieved
        lab.check("grounded", ok, evidence=state["cited"],
                  words={"passed": "The answer cites a passage it was given.",
                         "failed": "The answer cites nothing it was given."})
        return {"grounded": ok}

    def route(state: State) -> Literal["grounded", "not_grounded"]:
        return "grounded" if state["grounded"] else "not_grounded"

    @lab.step("Send the answer", actor="app")
    def respond(state: State) -> State:
        """Reply to the agent."""
        lab.outcome("answered")
        return {}

    @lab.step("Hand off to a lead", actor="app")
    def handoff(state: State) -> State:
        """Post the question to the leads channel."""
        lab.outcome("handed_off")
        return {}

    b = StateGraph(State)
    for name, fn in (("retrieve", retrieve), ("answer", answer), ("check_sources", check_sources),
                     ("respond", respond), ("handoff", handoff)):
        b.add_node(name, fn)
    b.add_edge(START, "retrieve")
    b.add_edge("retrieve", "answer")
    b.add_edge("answer", "check_sources")
    b.add_conditional_edges("check_sources", route, {"grounded": "respond", "not_grounded": "handoff"})
    b.add_edge("respond", END)
    b.add_edge("handoff", END)
    return b


def build_graph(**parts):
    return instrument(make_builder(**parts).compile(), app=APP)

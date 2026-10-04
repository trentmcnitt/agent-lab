"""A support assistant as a LangGraph graph, shown on Agent Lab with nothing typed twice.

    retrieve -> classify -(answer)-> draft_answer -> check_grounding -(grounded)-> respond
                         \\-(escalate)-> handoff        \\-(not_grounded)-> handoff

What the app writes for Agent Lab, and nothing more:
- `@lab.step(...)` on each node function: the plain words, next to the code they describe. The
  docstring is the Engineering description. Words for a branch sit on the step it leaves, keyed
  by the branch's real name.
- One line per fact, where the fact is produced: `lab.retrieved` (what the search returned),
  `lab.decision` (the model's own rationale), `lab.check` (the grounding rule's verdict),
  `lab.outcome`.
- `instrument(...)` on the compiled graph. The steps, branches and their names come from the
  graph itself; which node each model call and fact belongs to comes from LangGraph's runtime.
"""
from __future__ import annotations

import json
import re
from typing import Literal, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

import agentlab as lab
from agentlab.langgraph import instrument

from .faq import CORPUS_ID, FaqIndex
from .model import ChatScripted

APP = lab.App(
    name="Support assistant",
    id="support-assistant",
    description="Answers product questions from the help-center FAQ, or hands them to a person.",
    baseline="~5 minutes for a support agent to look up and write",
)

CITATION = re.compile(r"\[([\w-]+)\]")


class State(TypedDict, total=False):
    question: str
    hits: list[dict]
    category: str
    rationale: str
    cited: list[str]
    answer: str
    grounded: bool


def _snippets(hits: list[dict]) -> str:
    return "\n".join(f"[{h['id']}] {h['title']}: {h['text']}" for h in hits)


def make_builder(index: FaqIndex | None = None, model: ChatScripted | None = None) -> StateGraph:
    index = index or FaqIndex()
    model = model or ChatScripted()

    @lab.step("Search the FAQ", says="It looks up the help-center articles that share words with the question.",
              actor="app", kind="retrieval")
    def retrieve(state: State) -> State:
        """Keyword search over the FAQ index; the top two entries go to the model."""
        found = index.search(state["question"])
        hits = [{"id": e.id, "title": e.title, "text": e.text, "score": score} for e, score in found]
        lab.retrieved(CORPUS_ID, hits, query=state["question"])
        return {"hits": hits}

    @lab.step("Decide if the FAQ covers it", says="The AI reads the question and the articles found, and decides.",
              actor="ai", moment=True,
              paths={"answer": lab.path("the FAQ covers it", says="It found an article that answers the question."),
                     "escalate": lab.path("needs a person", says="Nothing in the FAQ answers it.")})
    def classify(state: State) -> State:
        """Ask the model for {category, rationale, cited} as JSON."""
        reply = model.invoke([
            SystemMessage("Classify the question as 'answer' (the FAQ covers it) or 'escalate'. "
                          "Reply as JSON with category, rationale and cited (FAQ ids)."),
            HumanMessage(f"Question: {state['question']}\n\nFAQ:\n{_snippets(state['hits'])}"),
        ])
        parsed = json.loads(reply.content)
        lab.decision(parsed["rationale"], cited=parsed["cited"])
        return {"category": parsed["category"], "rationale": parsed["rationale"], "cited": parsed["cited"]}

    def route_after_classify(state: State) -> Literal["answer", "escalate"]:
        return "answer" if state["category"] == "answer" else "escalate"

    @lab.step("Write the answer", says="The AI writes a reply from the article it picked.", actor="ai")
    def draft_answer(state: State) -> State:
        """Draft a reply quoting the cited FAQ entries, with [id] citations."""
        cited = [h for h in state["hits"] if h["id"] in state["cited"]]
        reply = model.invoke([
            SystemMessage("Answer the customer using only these FAQ entries; cite each as [id]."),
            HumanMessage(f"Question: {state['question']}\n\nFAQ:\n{_snippets(cited)}"),
        ])
        return {"answer": reply.content}

    @lab.step("Check the answer", says="Every claim must cite an article the search actually returned.",
              actor="rule", moment=True,
              not_needed="Not needed this time: the AI didn't write an answer.",
              paths={"grounded": lab.path("cites the FAQ"),
                     "not_grounded": lab.path("unsupported", says="The reply cites nothing it was given.")})
    def check_grounding(state: State) -> State:
        """Pass when the reply cites at least one FAQ id and only ids that were retrieved."""
        cited = CITATION.findall(state["answer"])
        retrieved = {h["id"] for h in state["hits"]}
        ok = bool(cited) and set(cited) <= retrieved
        lab.check("grounded", ok, evidence=cited,
                  detail=f"cites {', '.join(cited) or 'nothing'}; retrieved {', '.join(sorted(retrieved)) or 'nothing'}",
                  words={"passed": "Every claim cites an article it was given.",
                         "failed": "The reply cites something it wasn't given."})
        return {"cited": cited, "grounded": ok}

    def route_after_check(state: State) -> Literal["grounded", "not_grounded"]:
        return "grounded" if state["grounded"] else "not_grounded"

    @lab.step("Send the answer", actor="app")
    def respond(state: State) -> State:
        """Post the reply to the customer."""
        lab.outcome("answered")
        return {}

    @lab.step("Hand off to a person", says="A support agent gets the question and what the AI found.", actor="app")
    def handoff(state: State) -> State:
        """Queue the question for a human with the AI's notes attached."""
        lab.outcome("handed_off")
        return {}

    builder = StateGraph(State)
    builder.add_node("retrieve", retrieve)
    builder.add_node("classify", classify)
    builder.add_node("draft_answer", draft_answer)
    builder.add_node("check_grounding", check_grounding)
    builder.add_node("respond", respond)
    builder.add_node("handoff", handoff)
    builder.add_edge(START, "retrieve")
    builder.add_edge("retrieve", "classify")
    builder.add_conditional_edges("classify", route_after_classify, {"answer": "draft_answer", "escalate": "handoff"})
    builder.add_edge("draft_answer", "check_grounding")
    builder.add_conditional_edges("check_grounding", route_after_check, {"grounded": "respond", "not_grounded": "handoff"})
    builder.add_edge("respond", END)
    builder.add_edge("handoff", END)
    return builder


def build_graph(*, checkpointer=None, **parts):
    """The instrumented graph the app invokes (and what `python -m agentlab verify` loads)."""
    return instrument(make_builder(**parts).compile(checkpointer=checkpointer), app=APP, lock="agentlab.lock.json")

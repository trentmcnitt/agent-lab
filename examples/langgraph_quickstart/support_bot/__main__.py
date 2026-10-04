"""Ask the support assistant a question; with the bench running, watch the run on it.

    uv run python -m support_bot "How do I reset my password?"

`lab.init()` needs no settings when the bench runs on this machine (http://127.0.0.1:8790), and is
a silent no-op when it isn't running. Set AGENT_LAB_URL when the bench is elsewhere.
"""
from __future__ import annotations

import sys
import uuid

import agentlab as lab

from .graph import build_graph


def main(argv: list[str]) -> int:
    question = " ".join(argv) or "How do I reset my password?"
    lab.init(service_name="support-assistant")
    graph = build_graph()
    result = graph.invoke({"question": question}, {"configurable": {"thread_id": uuid.uuid4().hex[:8]}})
    print(result.get("answer") or "(handed off to a person)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

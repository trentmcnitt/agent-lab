# LangGraph quickstart

A small support assistant (retrieve → classify → draft → check → respond, or hand off) wired to Agent Lab with the `agentlab` library. The model is a scripted LangChain chat model (`support_bot/model.py`), so it runs with no API key; swap in `ChatAnthropic`/`ChatOpenAI` and nothing else changes.

```sh
cd examples/langgraph_quickstart
uv run python -m support_bot "How do I reset my password?"     # with the bench running locally, the run appears on it
uv run pytest -q                                               # what the app's CI runs
```

What the app writes for Agent Lab is all in `support_bot/graph.py`:
- `@lab.step(...)` on each node function (words, next to the code; the docstring is the Engineering text), with branch words keyed by the branch's real name;
- one line per fact where it happens: `lab.retrieved`, `lab.decision`, `lab.check`, `lab.outcome` (and `lab.corpus` in `faq.py`, where the index is built);
- `instrument(...)` on the compiled graph.

The steps, branches and their names come from the graph. Rename a node, add a branch, or rename a branch, and the map follows; a word that no longer matches fails `test_agent_lab_words_match_code`. `support_bot/agentlab.lock.json` records the code each wording was last confirmed against: after changing a worded step, re-read its words and run `uv run python -m agentlab lock support_bot:build_graph`.

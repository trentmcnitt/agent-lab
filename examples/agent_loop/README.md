# Agent loop

One LangGraph step that is a whole tool-using agent: the model picks its next move each turn (search the knowledge base; then look up the person and save a draft, both at once; then write the reply). Agent Lab draws the step once on the map and, inside it, every model and tool call in the order they started: in Presentation a numbered list with a small timeline bar each, in Engineering a waterfall whose rows open to show each call's arguments, result and tokens.

The model is scripted (`vpn_agent/model.py`), so it runs with no API key; swap in `ChatAnthropic(...).bind_tools(TOOLS)` and nothing else changes.

```sh
cd examples/agent_loop
uv run python record.py      # re-records ../agent-loop.recording.jsonl through the bench's own recorder
uv run pytest -q
```

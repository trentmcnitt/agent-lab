# agentlab (Python)

The library an app uses to show up on the Agent Lab bench with nothing typed twice. Status: 0.1.0, pre-alpha, not published; apps depend on it by path:

```toml
# the app's pyproject.toml
[tool.uv.sources]
agentlab = { path = "../agent-lab-bench/sdk/python", editable = true }
```

## Three kinds of information, each with one home

| | where it comes from | you write |
|---|---|---|
| **Structure** (steps, branches) | the framework's own graph | nothing (`agentlab.langgraph.instrument(graph, app=...)`) |
| **Facts** (decisions, checks, gates, documents) | one line where each is produced, passing live variables | `lab.decision(parsed.rationale, cited=parsed.cited)`, `lab.check("grounded", ok, evidence=ids)`, `lab.corpus("handbook", title=..., items=[(c.id, c.title) for c in chunks])` |
| **Words** (plain labels, descriptions) | next to the code they describe | `@lab.step("Decide what kind of request", actor="ai", paths={"needs_write": lab.path("needs a change")})` |

```python
import agentlab as lab

lab.init()      # once at startup. No env needed when the bench runs on this machine;
                # AGENT_LAB_URL=http://host:8790 when it doesn't, AGENT_LAB_URL=off to disable.
                # With no bench listening it is a silent no-op.
```

## LangGraph

```python
from agentlab.langgraph import instrument

graph = instrument(builder.compile(checkpointer=saver), app=lab.App(name="Support assistant"),
                   lock="agentlab.lock.json")     # relative to this file
graph.invoke({"question": q}, {"configurable": {"thread_id": tid}})
```

`instrument` reads the map from the compiled graph: nodes and plain edges from `get_graph()`, every branch label from the path maps (or a `Literal` return type), `Command` destinations, subgraph nodes as `container/inner`. At runtime it uses LangGraph's own callback metadata to put a run span around each invoke, a node span around each node, and every model call, tool call and fact (`lab.decision`, `lab.check`, ...) under the node that made it. The app never passes a node id. Interrupts become gates; a resume continues the same run. A router with no path map and no `Literal` return type can't be read, and `verify` says so (R3) rather than guessing.

Say which fields of the graph's state a person reads, and the screen shows the request, who asked and the reply instead of the whole state: `lab.App(name=..., request="message", reply="final_response", requester=("requester_name", "requester_role"))`. They're the state's own field names, so `verify` checks them against the graph's input and output schema (R15). A graph built from a definition that knows more than the compiled graph (an Agent Spec flow, below) passes that structure: `instrument(graph, app=..., structure=agentspec.structure_from("flow.yaml"))`.

Install with the extra: `agentlab[langgraph]`. A complete, runnable app is in [`examples/langgraph_quickstart`](../../examples/langgraph_quickstart) (a scripted model, so no API key).

## Open Agent Spec

```python
from agentlab import agentspec

manifest = agentspec.manifest_from("flow.yaml")                 # the map, read from the flow file
lab.verify(agentspec.instrumentation_from("flow.yaml"))         # in a test: fails on a file error (R14)
```

For an app defined as an [Open Agent Spec](https://github.com/oracle/agent-spec) flow, the file is the structure: nodes (ids = component ids, a `FlowNode`'s subflow as `container/inner`), names, descriptions and types, and control-flow edges with their `from_branch`. Plain parsing, no pyagentspec; install with the extra `agentlab[agentspec]` (PyYAML). `python -m agentlab.agentspec flow.yaml [--verify] [--out map.json] [--register http://127.0.0.1:8790] [--app-id ID]`. What runs today, what's left, and what pyagentspec's LangGraph exporter does and doesn't carry: [`examples/agentspec`](../../examples/agentspec).

## Words can't silently go stale

```python
def test_agent_lab_words_match_code():
    lab.verify(build_graph())          # fails on any word naming a step or branch the code lacks
```

`python -m agentlab verify app.graph:build_graph [--strict]` does the same in CI. `python -m agentlab lock app.graph:build_graph` records the code each wording describes in `agentlab.lock.json`; when that code later changes, Engineering mode shows the wording as needing a re-read (`--strict` fails on it).

## Guarantees

- Nothing but `verify` and `lock` ever raises into app code; bad input is dropped with one debug line on the `agentlab` logger.
- Off (no `init`, or `AGENT_LAB_URL=off`): every helper returns after one flag check.
- Never sets the global TracerProvider unless asked (`init(tracer_provider="global")` shares the app's).
- Content is redacted where it is emitted (`init(redact=fn)`), or not emitted at all (`capture_content=False`).

The wire format, every attribute name and the verification rules are in [SPEC.md section 8](../../SPEC.md).

## Tests

```sh
cd sdk/python && uv run --quiet pytest -q
```

`agentlab.testing.capture()` gives an app's own tests the spans in memory; `agentlab.testing.to_otlp_json(spans)` writes them as an OTLP/JSON body.

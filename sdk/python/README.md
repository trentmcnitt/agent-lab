# agentlab (Python)

The library an app uses to show up on the Agent Lab bench with nothing typed twice. Status: 0.1.0, pre-alpha, not published; apps depend on it by path:

```toml
# the app's pyproject.toml
[tool.uv.sources]
agentlab = { path = "../agent-lab/sdk/python", editable = true }   # a clone of trentmcnitt/agent-lab beside your app
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

That and `instrument(builder.compile(), app=lab.App(name=...))` are all a LangGraph app needs to show its whole flow. Facts and words are additions, made where they pay off.

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

`python -m agentlab verify app.graph:build_graph [--strict]` does the same in CI. `python -m agentlab lock app.graph:build_graph` records the code each wording describes in `agentlab.lock.json`; when that code later changes, Engineering mode shows the wording as needing a re-read (`--strict` fails on it). Treat it like a snapshot test: after changing a worded step, re-read its words, then run `lock` again.

What the fingerprint covers, exactly: the node function's own source (its decorator included, so editing only its words also asks for a re-lock) and, for a branching node, its router's source and its path map. Code the node calls in another function or module (a retriever, a helper) is not fingerprinted: a change there changes what the step does without flagging its words. Verification checks that every word names something real and flags words whose step changed; it never claims the words are right. Two things it can't see: a `@lab.step` on a function that is no longer added to the graph (its words never reach the map, so nothing wrong is shown), and a lock entry for a step that no longer exists (harmless; the next `lock` drops it).

Don't hard-code step names in your own tests either: the quickstart's test checks that every span lands on a step the graph has, so a rename only fails `verify`, with a message that says what to fix.

## Stories (custom panels)

```python
story = lab.Story("story.js", panels=[
    lab.Panel("why", "Where the answer came from", ["check_result"], nodes=[check_grounding],
              plain_title="Where the answer came from", audience="both"),
])
graph = instrument(compiled, app=APP, story=story)
```

`lab.Panel(id, title, event_types, nodes=(), plain_title=None, audience="both", mode="latest", story=True, fields=None)`:

- `event_types`: which events the panel gets (`decision`, `check_result`, `retrieval`, `llm_call`, your own `lab.event` types ...).
- `nodes`: the steps it shows on, as node ids or, better, the node functions themselves (`nodes=[check_grounding]`): a function can't go stale when the node is renamed, and one that is no step of the graph is a `verify` error (R1). `Story(reads=[...])` takes the same, for steps the JS reads outside its panels.
- `plain_title`: its heading in Presentation; `audience`: `both`, `presentation` or `engineering`; `mode`: `latest` (the newest event) or `append` (all of them).
- `story=False` with `fields=[{"key": ..., "label": ..., "format": ...}]` is a declared panel: no JS, the bench formats the fields.

The file's JavaScript registers the panels (`BenchStory.register('<app id>', {panels: {why: (events, ctx) => html}})`); each gets `ctx.mode`, so one panel can speak plainly to a room and show detail to engineers ([SPEC.md section 5](../../SPEC.md)). A fact's text shows in Presentation as you wrote it: `lab.check(..., detail=...)` and `lab.decision(reason)` are read by the room, so write them for it.

The bench serves a story only from a file you trust (`AGENT_LAB_STORIES="<app id>=<path>"`, set when the bench starts) and only when its sha256 is the one the run was built with. While writing one, start the bench with `AGENT_LAB_STORIES_DEV=1` as well: it then serves the file as it is now, so an edit shows on a reload of the viewer without re-running the app (Engineering notes that the file changed). Recordings always enforce the hash.

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

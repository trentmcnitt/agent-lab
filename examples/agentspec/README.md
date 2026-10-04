# Agent Lab and Open Agent Spec

[Open Agent Spec](https://github.com/oracle/agent-spec) is Oracle's framework-neutral file format for agents and flows (JSON or YAML). When an app is defined as an Agent Spec **flow** and a runtime executes that file, the file *is* the app's structure. Agent Lab reads the map straight from it, so the map and what runs can't disagree.

`helpdesk_triage.yaml` here is a small flow: an AI classifies a message, a `BranchingNode` routes it, a question gets an AI-written answer, a change needs a person's approval (a `FlowNode` whose subflow asks with an `InputMessageNode`) before a tool makes it, and anything unclear is handed to a person. It was written with pyagentspec's serializer and loads back cleanly. Nothing in this folder calls a model.

## The map, from the file

```bash
cd sdk/python
uv run python -m agentlab.agentspec ../../examples/agentspec/helpdesk_triage.yaml            # print the map
uv run python -m agentlab.agentspec ../../examples/agentspec/helpdesk_triage.yaml --verify   # exit 1 on a file error
```

```python
import agentlab as lab
from agentlab import agentspec

manifest = agentspec.manifest_from("helpdesk_triage.yaml")      # a bench-topology/0 map

def test_flow_is_consistent():                                  # in the app's own tests
    lab.verify(agentspec.instrumentation_from("helpdesk_triage.yaml"))
```

What you get without writing anything (SPEC.md 8.5):

| in the map | from the flow file |
|---|---|
| node ids | each node's component `id`; a `FlowNode`'s subflow nodes as `container/inner` (here `approval/ask`, `approval/decide`, ...) |
| `label`, `description` | the component's `name` and `description` |
| `kind`, `actor` | `component_type`: `LlmNode`/`AgentNode` are AI steps, `ToolNode`/`ApiNode` tools, `BranchingNode` a rule, `InputMessageNode` a person, `EndNode` the end |
| edges | the control-flow edges; `from_branch` kept as the branch name (`answer`, `needs_change`, `default`, `approved`, ...), `null` meaning the node's `next` branch |
| app name and description | the flow's `name` and `description` (or pass `app=lab.App(...)`) |

**Words on top, for Presentation** (for adding color or detail the file doesn't carry): `steps={"route": lab.step("Pick the path", paths={"needs_change": lab.path("needs a change")})}` on `manifest_from`/`instrumentation_from`. Keys are component ids; `verify` fails on a key that isn't a node (R1) or a path that isn't one of that node's branches (R2), exactly as for LangGraph.

**What the file can get wrong, caught by `verify` (R14):** an edge leaving from a branch its node doesn't declare, two edges leaving one branch, an edge naming a node its flow doesn't list. pyagentspec's validators don't check the first two. They matter at runtime: Oracle's own `example_serialized_flow_with_branching_node.yaml` (vendored in `sdk/python/tests/fixtures/agentspec/`) has edges `yes`/`no`/`maybe` against branches `Yes`/`No`/`Maybe`, and running it through pyagentspec's LangGraph loader fails with `KeyError: 'Maybe'` (checked 10-03-26). The edge is still drawn, with the error beside it.

The reader is plain parsing (the `agentlab[agentspec]` extra is just PyYAML), never pyagentspec, which pins a large dependency set. One deliberate difference: in YAML, unquoted `yes`/`no`/`on`/`off` stay strings (only `true`/`false` are booleans), because branch names are often exactly those words.

## Getting runs onto the bench (what works today, and what's left)

1. **Declared map, with node ids that line up.** `python -m agentlab.agentspec flow.yaml --register http://127.0.0.1:8790` registers the map with a bench (`PUT /apps/<app_id>`, the declared-map tier). The bench uses it for that app's runs that don't carry a map of their own; a run from other OpenTelemetry instrumentation is that app's when its `service.name` equals the map's `app.id` (`adapters/otlp.py`), so pass `--app-id <service.name>` when the flow's name doesn't slug to it. Node ids are Agent Spec component ids, and pyagentspec's LangGraph loader names each LangGraph node with that same id (`_langgraphconverter.py:447`, `add_node(node_id, runnable)` where `node_id` is `node.id`). So any runtime telemetry keyed by LangGraph node lands on the right node.

2. **Live runs through pyagentspec's LangGraph loader + `agentlab.langgraph.instrument`.** Every span is attributed:

   ```python
   from pyagentspec.adapters.langgraph import AgentSpecLoader
   from agentlab.langgraph import instrument

   graph = AgentSpecLoader(tool_registry={"open_ticket": open_ticket}).load_yaml(Path("flow.yaml").read_text())
   graph = instrument(graph, app=lab.App(name="Helpdesk triage"))
   graph.invoke({"inputs": {"message": "..."}})
   ```

   Checked 10-03-26 (pyagentspec 26.4.0.dev0, LangGraph 1.2.12, a flow with no model nodes so nothing was called). Node spans carry the Agent Spec ids, and a `FlowNode`'s inner nodes come out as `container/inner` (`ask/inner_start`, `ask/inner_branch`, ...), the same ids this reader puts in the map. **But the map those runs carry is read from the loader's LangGraph graph, not from the flow file.** That means component ids as labels instead of names, every transition as a branch called `next` (the loader makes every edge conditional, `_langgraphconverter.py:367-379`), no descriptions or types, and no `FlowNode` inner nodes (the loader runs a subflow inside one node function, so the graph doesn't show them; their spans then arrive as R7 "node not in the map").

3. **The flow file's map on live runs:** pass the file's structure to `instrument`, and the runs carry the flow file's map (names, descriptions, types, `FlowNode` inner nodes), whose ids match the spans (point 2):

   ```python
   from agentlab import agentspec
   graph = instrument(graph, app=lab.App(name="Helpdesk triage"), structure=agentspec.structure_from("flow.yaml"))
   ```

   `instrument(structure=)` is tested in the library suite (`tests/test_app_io.py`) with a hand-built structure; a run through pyagentspec's loader with it was not re-run here (pyagentspec is in no dependency group).

**Agent Spec Tracing is not read.** It is an in-process span API (`pyagentspec.tracing`: `SpanProcessor`, with span types such as `NodeExecutionSpan`, `LlmGenerationSpan`, `ToolExecutionSpan`, `AgentExecutionSpan`, `FlowExecutionSpan`), not OpenTelemetry. Mapping it is on the roadmap (architecture A10). `NodeExecutionSpan` carries the `Node` itself, so its component id is available to match the map's ids.

## A LangGraph app exporting to Agent Spec

pyagentspec ships a LangGraph → Agent Spec converter: `pip install "pyagentspec[langgraph]"`, then `AgentSpecExporter().to_yaml(compiled_graph)` (`pyagentspec.adapters.langgraph`). **A LangGraph app doesn't need it for Agent Lab:** `agentlab.langgraph.instrument` reads the compiled graph directly, with the words and facts next to the code. Exporting is useful only if you want an Agent Spec file for other reasons. Here is what the export holds, checked against the source (commit `585b7516`, `adapters/langgraph/_agentspec_converter_flow.py`) and by exporting this repo's `examples/langgraph_quickstart` graph on 10-03-26:

- **Every node becomes an opaque `ToolNode`** wrapping a `ServerTool` named `<node>_tool`, with no description (`:329-362`). The node's code, prompts, docstring and `@lab.step` words are not in the file; a runtime needs a `tool_registry` that supplies the functions again.
- **Each conditional edge becomes two extra nodes:** a `ToolNode` named after the router function and a `<router>_branching_node` `BranchingNode`, plus a `default` edge to the end (`:125-235`).
- **Its branch names don't match its edges when a path map's labels differ from the target names.** `BranchingNode(mapping={label: target})` declares the *targets* as its branches (`branchingnode.py:127-128`), while the edges leave from the *labels* (`:208`). On the quickstart graph (`answer → draft_answer`, `escalate → handoff`, ...) that gives four R14 errors: the `route_after_classify` branching node declares `default`, `draft_answer`, `handoff`, while its edges leave from `answer` and `escalate`. A router whose labels equal its targets (a `Literal` return type with no path map) exports consistently (checked on a three-node graph). These were read from the exported files; no exported flow was run.
- **Not supported:** two conditional edges from one node (`ValueError`, `:39-47`); a router with no path map or `Literal` return type (`TypeError`, `:139`). `Command` destinations aren't read (only `graph.edges` and `graph.branches`, `:82-99`), so such a node gets an automatic edge to the end (`:101-113`). A subgraph becomes a `FlowNode`.
- **Ids are new on every export** (two exports of the same graph share no ids), so an exported file is a snapshot, not a source of truth. Re-exporting changes every node id.
- The `[langgraph]` extra pins `langgraph>=1.2.4,<1.3`, `langchain-openai`, `langchain-ollama`, `langgraph-swarm`, `langsmith` and more (`setup.py:28-44`, the `LANGGRAPH_DEPS` list).

In short: Agent Spec → Agent Lab is a first-class path (the file is the structure). LangGraph → Agent Spec → Agent Lab yields a structural skeleton without the app's words or facts, and with the branch-name mismatch above. Use `agentlab.langgraph` for LangGraph apps.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/agentlab-mark.svg">
    <img src="docs/images/agentlab-mark-light.svg" alt="Agent Lab" width="112">
  </picture>
</p>

<h1 align="center">Agent Lab</h1>

<p align="center">
  <strong>See inside any AI app while you use it.</strong><br>
  The flow it takes, the exact prompt the model got, what came back, and what it cost, live beside the app.
</p>

<p align="center">
  <a href="https://agentlab.trentmcnitt.com"><img src="https://img.shields.io/badge/Live_Lab-agentlab.trentmcnitt.com-5eead4" alt="Live lab"></a>
  <img src="https://img.shields.io/badge/status-0.1_pre--alpha-f59e0b" alt="Status: 0.1 pre-alpha">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-FSL--1.1--ALv2-a78bfa" alt="License: FSL-1.1-ALv2"></a>
  <img src="https://img.shields.io/badge/python-3.11%2B-blue" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/works_with-OpenTelemetry-f5a800" alt="Works with OpenTelemetry">
</p>

<p align="center">
  <a href="https://agentlab.trentmcnitt.com">Try the lab</a> · <a href="#-quickstart">Quickstart</a> · <a href="SPEC.md">Spec</a> · <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <img src="docs/images/side-by-side.png" alt="Agent Lab: a Slack helpdesk agent on the left, the bench on the right showing its flow, timeline and costs" width="820">
</p>

> [!NOTE]
> **0.1 pre-alpha.** This is days-old software: the format and APIs will change. Issues and ideas are welcome.

Agent Lab is a bench you set beside an AI app. The app reports what it does as it runs; the bench draws the app's whole flowchart, lights up the path each run takes, and shows every step's prompt, output, time and cost. It's built for showing an AI system to people as much as for debugging it: a flowchart anyone can follow, with every engineering detail one click away.

It sits on top of the tracing you already have. It doesn't replace your observability tools, and it never changes the app: approvals and every other decision stay in the app.

## ✨ Features

- **🗺️ The whole flow, not just the trace.** The map of every step and branch an app *could* take is read from its own code (a LangGraph graph, or an [Open Agent Spec](https://github.com/oracle/agent-spec) flow file), so the paths a run didn't take show up too, and the map can't drift from the code.
- **👀 Presentation and Engineering.** Presentation is for a room: plain step names, what the app looked at, how it was checked, who signed off, and time and cost in words, stepped through at the presenter's pace. Engineering shows every field, every id and the raw event log.
- **📚 What it could see, and what it used.** An app reports its sources where it builds them (a handbook's sections, from the index itself). Each run shows which items were given to the AI, verified by matching their text in the prompt, and which ones its answer rests on.
- **✅ Checks and sign-offs.** Every check that guards the app, whether it passed this run, and whether a person approved.
- **⟨⟩ The exact prompt.** Model I/O shows what the model was told, word for word, and exactly what it returned, per call. In Presentation, "What the AI was given" shows the same thing as readable blocks.
- **⏱️ Time and cost.** Per-step latency, with AI time split from time spent waiting for a person; tokens and cost per call. A call with no price shows its cost as unknown, never as $0.
- **🧩 Stories.** An app can ship its own panels that explain its runs, the way comments explain code. Custom panels never hide data: every one has a raw toggle.
- **🪟 Side by side.** A shell puts the real app on the left and the bench on the right, live or from a recording. On a phone it becomes two tabs.
- **🔌 Plugs into OpenTelemetry.** Point an OTLP exporter at the bench and it draws a map from your spans, with no code. The `agentlab` library adds the real map, plain words and checked facts, on the same wire.
- **📼 Replay anywhere.** Recordings carry their own map and story, so a static site can replay them with no server.

## 🚀 Quickstart

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/). There's no package yet; run it from a checkout.

```bash
git clone https://github.com/trentmcnitt/agent-lab.git
cd agent-lab
uv run uvicorn bench.server:app --port 8790
```

Open <http://127.0.0.1:8790/> and pick a **hello-agent** recording to see a run on the bench.

## 🔌 Plug it in

There are three ways in. Each is optional, and each adds to the one before it:

1. **Zero setup.** Any app that already emits OpenTelemetry shows up, with a map inferred from its spans.
2. **The `agentlab` library** (Python, LangGraph). Two lines give the app's whole flow, read from its graph. One-line facts and optional wording next to the code make it read well, and `lab.verify` in CI keeps that wording honest.
3. **Open Agent Spec.** An app defined as an [Agent Spec](https://github.com/oracle/agent-spec) flow gets its map from the flow file.

### What comes from where

Nothing on the screen is typed twice. Each kind of information has one home:

| | where it comes from | what you write | how drift is caught |
|---|---|---|---|
| **Structure**: steps, branches, branch names, subgraphs | **derived** from the compiled LangGraph graph, or from the Agent Spec file | nothing | It can't drift: every run carries the map of the code that produced it, and the bench draws each run with its own map. A router whose branches can't be read is a `verify` error (R3), never a guess. |
| **Runtime facts**: model calls, prompts, outputs, tokens, tool calls, timing, approval pauses | **derived** from LangGraph's callbacks, as OpenTelemetry spans | nothing | It can't drift: these are what happened, attributed to the step that ran them. |
| **App facts**: documents, searches, decisions, checks, sign-offs, outcomes | **reported** by one line where each fact is produced, passing live variables: `lab.corpus`, `lab.retrieved`, `lab.decision`, `lab.check`, `lab.gate_resolved`, `lab.outcome`, `lab.event` | one line each | A document list comes from the index itself, so a renumbered handbook follows. At runtime the bench flags a fact naming a step, branch or document the map doesn't have (R7 to R9), in Engineering. |
| **Words**: plain step names, descriptions, branch words, check words, which state fields are the request and the reply | **authored**, on the code they describe: `@lab.step(...)` on the node function, `paths=` on the step a branch leaves, `words=` on `lab.check`. The docstring is Engineering's description. | as much or as little as you like | `lab.verify` (in your tests, or `python -m agentlab verify` in CI) fails on a word naming a step, branch or state field the code doesn't have (R1, R2, R15). After `python -m agentlab lock`, it also flags wording whose step's code changed since someone last re-read it (R6). |
| **Custom panels** (stories) | **authored** JavaScript, shipped with the app | optional | `verify` fails on a panel naming a step that no longer exists (R1). The bench serves a story only when its hash matches the one the run was built with. The story harness tests it against real recordings. |

The limits, stated plainly:
- The lock fingerprints the node function (its decorator included) and, for a branching step, its router and path map. Code the node calls elsewhere (a retriever, a helper) isn't fingerprinted, so a change there doesn't flag the step's words.
- Verification checks that every word names something real, and flags words whose code changed. It never claims the words are right.
- A `@lab.step` on a function that is no longer added to the graph isn't reported. Its words never reach the map, so nothing wrong is shown.

### 1. Zero setup (Level 0): point your OpenTelemetry at it

If your app already emits OpenTelemetry with the GenAI conventions, set these and run it:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8790     # the bench's base URL; the exporter adds /v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf             # see the note below
OTEL_SERVICE_NAME=my-app                              # becomes the bench's app id
OTEL_EXPORTER_OTLP_HEADERS=x-agent-lab-session=demo-1 # optional: group runs into one session
OTEL_BSP_SCHEDULE_DELAY=200                           # optional: send every 200 ms instead of 5 s
OTEL_EXPORTER_OTLP_COMPRESSION=gzip                   # optional: works
```

Then open `http://127.0.0.1:8790/?app=my-app` (the front page lists every app it has seen). The bench infers a map from your spans, labelled "map inferred from the trace", and shows the path, Model I/O, tool calls and retrievals. An inferred map shows only the steps a run took; the branches it didn't take need the library, a flow file or a declared map.

A LangGraph app traced by OpenInference or OpenLLMetry has its spans grouped by graph node. Both instrumentors' node keys were read from their real output on 10-03-26 (SPEC section 8.6).

> [!IMPORTANT]
> **Python defaults to gRPC.** With `OTEL_EXPORTER_OTLP_PROTOCOL` unset, Python's auto-configuration (`opentelemetry-instrument`) picks the gRPC exporter, which the bench doesn't accept. Set `http/protobuf`. An app that builds `OTLPSpanExporter` from `opentelemetry.exporter.otlp.proto.http` in code is already HTTP/protobuf.

The bench accepts OTLP/HTTP as protobuf or JSON, gzipped or not. The recipe above was checked on the wire on 10-03-26 with [`examples/level0_pydantic_ai.py`](examples/level0_pydantic_ai.py), a real Pydantic AI agent with a scripted model, so it needs no API key:

```bash
uv run examples/level0_pydantic_ai.py "How do I reset my VPN password?"
```

**Prompts and outputs only show up if your framework captures them.** Whether it does by default varies:

| Framework | Captures content by default? | Status |
|---|---|---|
| Pydantic AI (pydantic-ai-slim 2.54) | Yes. Turn off with `InstrumentationSettings(include_content=False)`. | **Verified 10-03-26**, end to end: source and on the wire |
| OpenInference, OpenAI instrumentor (0.1.63) | Yes. OpenInference's `TraceConfig` reportedly hides inputs and outputs (not checked). | **Verified 10-03-26**, end to end: on the wire |
| OTel-contrib GenAI instrumentations | Reportedly no: opt in with `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only` | Not verified |
| Vercel AI SDK, OpenLLMetry | Reportedly yes | Not verified. OpenLLMetry's `traceloop.*` spans arrive as steps without model I/O, and the older Vercel `ai.*` spans aren't mapped yet |

A run with no content says "not captured", never "masked". [SPEC](SPEC.md) section 6b has the full span mapping.

### 2. The `agentlab` library (Python, LangGraph)

The library sends, with every run, the map of everything the app *could* do, read from the compiled graph, plus the facts a trace can't know. Everything travels as OpenTelemetry span attributes ([SPEC](SPEC.md) section 8). There's no package yet, so depend on the library by path from a checkout of this repo:

```toml
# your app's pyproject.toml
dependencies = ["agentlab[langgraph]"]

[tool.uv.sources]
agentlab = { path = "../agent-lab/sdk/python", editable = true }   # a clone of trentmcnitt/agent-lab beside your app
```

**The quickstart.** This is all an existing LangGraph app needs to show its whole flow:

```python
import agentlab as lab
from agentlab.langgraph import instrument

lab.init()                                       # once at startup
graph = instrument(builder.compile(), app=lab.App(name="HR policy bot"))
graph.invoke({"question": "How much PTO do I accrue?"})
```

Start the bench (`uv run uvicorn bench.server:app --port 8790`), run the app, and open `http://127.0.0.1:8790/?app=hr-policy-bot` (the app id is the name, slugged). You get:
- every step and every branch, including the ones this run didn't take, with the path it took lit up;
- each model call's prompt, output, tokens and time, on the step that made it;
- a step that called the model shown as the AI's.

Steps show by their code names, and `verify` lists what has no words yet as information, not errors. These are the lines a test engineer used to hook up a fresh LangGraph app from this README on 10-03-26, against a bench on another port (set with `AGENT_LAB_URL`), with no other setup. Spans were sent when the process exited, with no shutdown call.

`lab.init()` with no arguments sends to `http://127.0.0.1:8790`, and it is a silent no-op while nothing listens there, so the same code runs in production with no bench. Set `AGENT_LAB_URL=http://host:port` only when the bench runs on another machine or port; `AGENT_LAB_URL=off` turns it off.

**Make it read well, where it pays off.** Add facts and words next to the code they describe:

```python
@lab.step("Is it a policy question?", says="The AI decides whether the handbook covers this.", actor="ai",
          paths={"policy": lab.path("a policy question"), "smalltalk": lab.path("just chatting")})
def triage(state):
    """Model returns {route, why} as JSON."""                    # Engineering's description
    parsed = json.loads(model.invoke(prompt(state)).content)
    lab.decision(parsed["why"])                                   # the AI's own reason, one line
    return {"route": parsed["route"]}

lab.corpus("handbook", title="Employee handbook", items=[(d.id, d.title) for d in HANDBOOK])   # where the index is built
lab.check("cites_handbook", ok, evidence=cited, words={"passed": "The answer names a policy it was given."})   # at the check

graph = instrument(builder.compile(), lock="agentlab.lock.json",
                   app=lab.App(name="HR policy bot", request="question", reply="answer"))
```

- `paths=` keys are the router's real branch names. `request=` and `reply=` are the state's own field names, so the screen shows the question and the answer instead of the whole state.
- Branch lighting is derived from which step ran next, so it's right even when your code overrides the model's pick.
- The text you pass to a fact (`lab.decision`'s reason, `lab.check`'s `detail`) is read by the room in Presentation, so write it for them.

**Keep it honest in CI:**

```python
def test_agent_lab_words_match_code():
    lab.verify(build_graph(), strict=True)       # strict: also fail on worded code changed since `lock`
```

```bash
uv run python -m agentlab verify my_app.graph:build_graph --strict   # the same check from the command line
uv run python -m agentlab lock my_app.graph:build_graph              # after re-reading words whose code changed
```

`lock` works like updating a snapshot. Editing only a step's words also asks for a re-lock, because the decorator is part of what's fingerprinted.

In the same usability run, the engineer renamed a node, split one document index into two and added a branch, with nothing else touched. The renamed step, the new branch and both document sets appeared on the next run, and earlier runs kept their own map. `verify --strict` failed with R1 (a panel still naming the old step) and R6 (worded code changed since `lock`); a separate branch rename failed with R2 (a branch word naming a branch the code no longer has, with the real ones listed). It passed again once the words were fixed and re-locked.

[`examples/langgraph_quickstart`](examples/langgraph_quickstart) is a complete app with every kind of line, a scripted model (no API key) and its own CI test. [`examples/agent_loop`](examples/agent_loop) is one step that runs a whole tool-using agent (the bench shows its model and tool calls in the order they started, two of them at once). [`sdk/python`](sdk/python) is the library's guide: redaction, cost, sharing your app's OpenTelemetry provider, gates and every rule.

### 3. Open Agent Spec

When an app is defined as an Agent Spec **flow** and its runtime executes that file, the file *is* the structure, so Agent Lab reads the map from it and the two can't disagree:

```bash
cd sdk/python
uv run python -m agentlab.agentspec ../../examples/agentspec/helpdesk_triage.yaml --verify    # the map; exit 1 on a file error
```

- **From the file (tested against Oracle's example flows):** node names, descriptions and types, each branch by its own name, and a `FlowNode`'s subflow drawn inside it. Words can go on top with `steps=`, checked like LangGraph's.
- **`verify` catches what the file gets wrong (R14):** an edge leaving from a branch its node doesn't declare, two edges leaving one branch, an edge to a node the flow doesn't list. pyagentspec's validators don't check the first two. Oracle's own branching example has a case mismatch (`yes` against `Yes`) that `verify` reports, and pyagentspec's loader fails on that file with `KeyError: 'Maybe'`.
- **Live runs:** run the flow with pyagentspec's LangGraph loader, then `instrument(graph, app=..., structure=agentspec.structure_from("flow.yaml"))`, so each run carries the file's map. The loader names each node by its Agent Spec id, which is the id this map uses (checked by running a flow with no model nodes). The `structure=` hook is tested with a hand-built structure. A run through pyagentspec's loader with it hasn't been run yet.
- **No runtime yet:** `--register http://127.0.0.1:8790` registers the file's map as a declared map.

**Exporting a LangGraph app to Agent Spec isn't needed for Agent Lab, and isn't recommended.** pyagentspec's exporter ran on the quickstart graph, but every node becomes an opaque tool with no words. Wherever a path map's labels differ from its targets, the file's branch names don't match its own edges: four R14 errors on the quickstart. A LangGraph app should use `agentlab.langgraph`. Details: [`examples/agentspec`](examples/agentspec).

### No library for your language yet?

Declare the map as JSON. Open `?app=my-app&mode=engineering` on a zero-setup run and click **⤓ map as topology.json**: it has the node ids your spans actually produce. Fill in the plain words, then register it:

```bash
curl -X PUT http://127.0.0.1:8790/apps/my-app \
  -H 'Content-Type: application/json' \
  -d @my-app.registration.json          # {"topology": {...}, "story": null}
```

Registration validates the map against [`schema/bench-topology.schema.json`](schema/bench-topology.schema.json); keys starting with `x-` are yours. [`examples/hello-agent.topology.json`](examples/hello-agent.topology.json) uses every field. **A declared map is typed by hand, so it can drift from the code**; nothing checks it against the code, which is why it's the fallback and not the way in. A run that carries its own map always wins over it.

Not using OpenTelemetry? Send bench events instead, one at a time or in batches (the low-level path; the library doesn't use it):

```bash
curl -X POST http://127.0.0.1:8790/ingest -H 'Content-Type: application/json' -d '{
  "v": "bench/0", "run_id": "r1", "node": "classify", "event_type": "llm_call", "ts": 1790000000.0,
  "data": {"model": "claude-sonnet-5", "input_tokens": 820, "output_tokens": 40,
           "system": "...", "messages": [{"role": "user", "content": "..."}], "output": "..."}
}'
```

### Custom panels (stories)

The generic views cover every app the same way. A story is for the two things they can't do: a situation too bespoke for any universal view, and the color or detail someone wants to add, the way some people write extra comments in their code. It's JavaScript panels that draw the app's own runs (`BenchStory.register('<app id>', {panels, renderers})`), added beside the generic views, never replacing them:

```python
story = lab.Story("story.js", panels=[
    lab.Panel("why", "Where the answer came from", ["check_result"], nodes=[check_grounding]),
])
graph = instrument(compiled, app=APP, story=story)
```

- Name a panel's steps by their functions (`nodes=[check_grounding]`), so a rename can't strand it. A panel naming a step the graph doesn't have fails `verify` (R1).
- Each run names the story file by its hash. The bench serves it only from a file you trust (`AGENT_LAB_STORIES="<app id>=<path>"`, set when the bench starts) and only when the hash matches. While writing a story, add `AGENT_LAB_STORIES_DEV=1`: the bench serves the file as it is now, so an edit shows on a viewer reload.
- Each panel gets `ctx.mode` (`"presentation"` or `"engineering"`), so one panel can speak plainly to a room and show every score to an engineer. A panel's `audience` (`both`, `presentation` or `engineering`) says which mode shows it.
- The `Panel` fields are in [`sdk/python`](sdk/python#stories-custom-panels). A declared map sends its story as the `story` string at registration.

Test a story before anyone sees it. The story harness renders every panel at every event of your recordings, in both modes, and fails on a throw, an empty panel, `undefined`, `NaN` or `[object Object]`:

```bash
node tests/story_harness.js --story path/to/story.js [--topology path/to/map.json] path/to/*.recording.jsonl
```

[SPEC](SPEC.md) section 5 has the story API.

## 🎬 Two modes

| | **Presentation** | **Engineering** |
|---|---|---|
| For | a meeting, a demo, a handoff: anyone can drive it | building and debugging the app |
| Shows | the map with one callout on the current step: plain step names, what it looked at, how it was checked, who signed off, time and cost in words, "What the AI was given" | everything: tokens, scores, ids, Model I/O, raw JSON, the event log, and "Checks on this map" (every verify and runtime finding) |
| Pace | recordings: open paused on the first step and go at the presenter's pace (clicker keys), or Play pauses at the key moments; live and beside an app it follows the run, then offers "▶ Step through it" | follows the run |

A recording opens paused on its first step, so the presenter can talk first: → / Space / PageDown (what a clicker sends) go forward a step, ← / PageUp back, Home to the first step, End to the end, R the recap, M the map alone, `?` lists the keys. `&play=1` plays it instead; `&at=<step>` opens it at a step, `&at=end&recap=1` on the recap.

Pick one with `?mode=presentation` or `?mode=engineering`, or the toggle in the header. The URL wins, then the viewer's remembered choice, then the default: Presentation for recordings and the side-by-side shell, Engineering on a live bench.

**Watch** at `http://127.0.0.1:8790/?app=my-app`, or side by side with your app at `http://127.0.0.1:8790/shell/?app=<your app's url>&appid=my-app`. If your app refuses to be framed (`X-Frame-Options` or a strict CSP), open the bench in its own window beside it instead.

## 🚫 What it isn't

Agent Lab isn't a trace store. It keeps runs in a local log, with no auth, retention, search, evals or dashboards: that's what Langfuse, Phoenix and Logfire are for. It's the picture on top, and it's meant to sit beside them.

To send the same spans to both, put an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) in front and point your app's exporter at the Collector (`http://127.0.0.1:4318`). The bench then never sits on the path to your real tracing:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318

exporters:
  otlphttp/langfuse:
    endpoint: https://cloud.langfuse.com/api/public/otel   # your Langfuse region or host
    headers:
      Authorization: "Basic ${env:LANGFUSE_AUTH}"         # base64 of "pk-lf-...:sk-lf-..."
      x-langfuse-ingestion-version: "4"
  otlphttp/bench:
    endpoint: http://127.0.0.1:8790                       # the exporter adds /v1/traces

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/langfuse, otlphttp/bench]
```

The Langfuse settings follow [Langfuse's OpenTelemetry docs](https://langfuse.com/integrations/native/opentelemetry) as of 10-03-26. This config hasn't been run against the bench yet. A Collector doesn't pass your request headers through, so set the session as a resource attribute instead (`OTEL_RESOURCE_ATTRIBUTES=bench.session_id=demo-1`; the bench reads it from the resource).

## 🧪 See it in action

<a href="https://agentlab.trentmcnitt.com"><img src="docs/images/front-door.png" alt="The Agent Lab front door" width="820"></a>

**[agentlab.trentmcnitt.com](https://agentlab.trentmcnitt.com)** runs real apps on the bench, from recordings of real model calls:

- **[Slack Helpdesk Agent](https://github.com/trentmcnitt/agent-lab-helpdesk)**: an example agent that answers IT requests, looks things up in a handbook, and asks a person before it changes anything.
- **[Bespoke](https://github.com/trentmcnitt/bespoke-ai-vscode-ext)**: AI autocomplete for VS Code, across five models.
- **[OpenTask](https://github.com/trentmcnitt/opentask)**: coming soon.

## 🔧 How it works

| Piece | What it is |
|---|---|
| **Events** | `bench/0`: run and step boundaries, model calls with tokens, cost and I/O, decisions, retrievals, checks, tool calls, human gates. Unknown event types are fine; they render generically. |
| **Map** | Every step (`nodes`) and possible branch (`edges`, with `from_branch`), with its words, plus the sources it can read, the checks that guard it and the panels to show. Library apps send it with every run, derived from their code; the bench keeps each by hash and draws every run with its own. |
| **Library** | `sdk/python` (`agentlab`): derives the map from a LangGraph graph or an Agent Spec flow, sends it and the app's facts over OpenTelemetry, and verifies the words. |
| **Story** | Optional JavaScript that draws an app's own panels, named by hash in the map each run carries. |
| **Receiver** | `bench/server.py`: OTLP (`adapters/otlp.py`), per-run maps (`/maps/<hash>`), declared maps, native ingest, a live stream per session or app. `python -m bench.record` turns OTLP/JSON into recordings with the same reader. |
| **Viewer** | `viewer/`: Presentation and Engineering over the flow, sources, checks, timeline, Model I/O and panels. Its pure logic is `viewer/logic.js`. `shell/` is the side-by-side page. |

## 🗺️ Roadmap

Deploying the new lab, before-and-after comparisons of two architectures, and more scenarios. A TypeScript library, more framework integrations, forwarding and a browser extension are on the Later list, with the reasons. See [ROADMAP.md](ROADMAP.md).

## 🧑‍💻 Development

```bash
uv run pytest -q                                # format, OTLP adapter, receiver, story harness, browser e2e
(cd sdk/python && uv run pytest -q)             # the agentlab library, incl. LangGraph and Agent Spec
node --test tests/js/*.test.js                  # viewer logic (viewer/logic.js)
uv run pytest tests/e2e -q                      # just the browser tests (Playwright; skip if no Chromium)
node tests/story_harness.js examples/*.recording.jsonl   # the story harness on hello-agent
uv run python scripts/export_static.py          # static, replay-only build -> dist/bench/
```

The bench keeps what it receives (the event log, maps, registered apps) under `data/` in this checkout; `BENCH_DATA_DIR=<dir>` keeps a project's runs apart from everyone else's.

## 📄 License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE) (FSL-1.1-ALv2). Use, modify and share it for anything except a competing commercial product or service; each version becomes Apache 2.0 two years after its release.

Built by [Trent McNitt](https://trentmcnitt.com).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/agentlab-mark.svg">
    <img src="docs/images/agentlab-mark-light.svg" alt="Agent Lab" width="112">
  </picture>
</p>

<h1 align="center">Agent Lab</h1>

<p align="center">
  <em>Debugging and presentation for AI apps</em><br>
  <strong>Watch an AI app work, step by step, right beside it.</strong>
</p>

<p align="center">
  <a href="https://agentlab.trentmcnitt.com"><img src="https://img.shields.io/badge/Lab-agentlab.trentmcnitt.com-5eead4" alt="The lab"></a>
  <img src="https://img.shields.io/badge/status-0.1_pre--alpha-f59e0b" alt="Status: 0.1 pre-alpha">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-FSL--1.1--ALv2-a78bfa" alt="License: FSL-1.1-ALv2"></a>
  <img src="https://img.shields.io/badge/python-3.11%2B-blue" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/reads-OpenTelemetry-f5a800" alt="Reads OpenTelemetry">
</p>

<p align="center">
  <a href="https://agentlab.trentmcnitt.com">Try the lab</a> · <a href="#-quickstart">Quickstart</a> · <a href="SPEC.md">Spec</a> · <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <img src="docs/images/side-by-side.png" alt="Agent Lab: a Slack helpdesk agent on the left; on the right, its flowchart with the path this run took lit up, and the step-by-step detail" width="820">
</p>

**What it is.** A viewer that sits beside a running AI app. It draws the app's flowchart, lights up the path each run takes, and shows what the model was given and what came back at every model call.

**Who it's for.** The engineer building or debugging the app (**Engineering** mode: every field, every prompt, the raw events), and the room it's shown to: a client handoff, a demo, a manager or a support team who don't read traces (**Presentation** mode: plain words, stepped through at the presenter's pace).

**Why it's different.** Trace tools show what a run did, inside their own workspace. Agent Lab shows the paths the app *could* take, read from its own code (LangGraph or Open Agent Spec today), with this run's path lit, next to the real app, in a mode built to be put on a screen in a meeting. It reads the OpenTelemetry your app already emits, and sits beside Langfuse or Phoenix rather than replacing them ([what it isn't](#-what-it-isnt)).

> [!NOTE]
> **0.1 pre-alpha.** The format and APIs will change. Issues and ideas are welcome.

## ✨ Features

- **🪟 Side by side.** The real app on the left, its flowchart on the right, moving together: live on your machine, or replayed from a recording. On a phone it becomes two tabs.
- **🗺️ The paths it could take, and the one it took.** For LangGraph and [Open Agent Spec](https://github.com/oracle/agent-spec) apps, the map is read from the code, so the branches a run didn't take show too, and the steps and branches can't drift from the code. The plain words you add are checked against the code in CI.
- **📽️ Presentation and Engineering.** Presentation is for a room: plain step names, what the app looked at, how it was checked, who signed off, stepped through with a clicker. Engineering shows every field, every id and the raw event log.
- **📚 What it could see, and what it used.** An app reports its sources where it builds them (a handbook's sections, from the index itself). Each run shows which items were given to the AI, verified by matching their text in the prompt, and which ones the app says its answer rests on.
- **✅ Checks and sign-offs.** Every check the app reports, whether it passed this run, and whether a person approved.
- **💬 The exact prompt.** What the model was told, word for word, and exactly what it returned, per call, whenever the app's tracing captures content.
- **⏱️ Time, tokens and cost.** Per-step latency, with AI time split from time spent waiting for a person, and tokens per call. Cost shows when the app or its tracing reports a price (`lab.init(price=...)`); otherwise it says unknown, never $0.
- **🧩 Stories.** An app can ship its own panels that explain its runs, the way comments explain code. They add to the generic views, never replace them.
- **🔌 OpenTelemetry in.** Point an OTLP/HTTP exporter at it and it draws the steps each run took, with no code. The `agentlab` library adds the branches a run didn't take, plain words and checked facts, on the same wire.
- **📼 Replay anywhere.** Recordings of library and Agent Spec apps carry their own map and story, so a static site can replay them with no server.

## 🚀 Quickstart

**No install:** [agentlab.trentmcnitt.com](https://agentlab.trentmcnitt.com) replays real runs of two apps, side by side.

**On your machine** (Python 3.11+ and [uv](https://docs.astral.sh/uv/); there's no package yet, so run it from a checkout):

```bash
git clone https://github.com/trentmcnitt/agent-lab.git
cd agent-lab
uv run uvicorn bench.server:app --port 8790
```

That starts the bench, Agent Lab's receiver and viewer. Open <http://127.0.0.1:8790/> and pick a **hello-agent** recording. Then bring your own app: [already on OpenTelemetry](#1-zero-setup-point-your-opentelemetry-at-it) (environment variables only), or [on LangGraph](#2-the-agentlab-library-python-langgraph) (three lines).

## 🔌 Plug it in

Three ways in. Each is optional, and each adds to the one before it.

### 1. Zero setup: point your OpenTelemetry at it

An app that emits OpenTelemetry GenAI spans over OTLP/HTTP shows up with a map of the steps it took. Set these and run it:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8790     # the exporter adds /v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf             # Python defaults to gRPC, which the bench doesn't accept
OTEL_SERVICE_NAME=my-app                              # becomes the app id
```

Open `http://127.0.0.1:8790/?app=my-app`. You get the path, Model I/O, tool calls, and retrievals when the app emits GenAI retrieval spans. A map inferred from a trace shows only the steps a run took; the branches it didn't take need the library, a flow file or a declared map. [`examples/level0_pydantic_ai.py`](examples/level0_pydantic_ai.py) is a real Pydantic AI agent with a scripted model, so it needs no API key: `uv run examples/level0_pydantic_ai.py "How do I reset my VPN password?"`

<details>
<summary><strong>More on zero setup</strong>: optional settings, which frameworks capture prompts, gRPC</summary>

```bash
OTEL_EXPORTER_OTLP_HEADERS=x-agent-lab-session=demo-1 # group runs into one session
OTEL_BSP_SCHEDULE_DELAY=200                           # send every 200 ms instead of 5 s
OTEL_EXPORTER_OTLP_COMPRESSION=gzip                   # works
```

The bench accepts OTLP/HTTP as protobuf or JSON, gzipped or not. It drops traces that aren't AI work. With `OTEL_EXPORTER_OTLP_PROTOCOL` unset, Python's auto-configuration (`opentelemetry-instrument`) picks the gRPC exporter, so set `http/protobuf`. An app that builds `OTLPSpanExporter` from `opentelemetry.exporter.otlp.proto.http` in code is already HTTP/protobuf.

**Prompts and outputs only show up if your framework captures them:**

| Framework | Captures content by default? | Status |
|---|---|---|
| Pydantic AI (pydantic-ai-slim 2.54) | Yes. Turn off with `InstrumentationSettings(include_content=False)`. | Verified end to end: source and on the wire |
| OpenInference, OpenAI instrumentor (0.1.63) | Yes. OpenInference's `TraceConfig` reportedly hides inputs and outputs (not checked). | Verified end to end, on the wire |
| OTel-contrib GenAI instrumentations | Reportedly no: opt in with `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only` | Not verified |
| Vercel AI SDK, OpenLLMetry | Reportedly yes | Not verified. OpenLLMetry's `traceloop.*` spans arrive as steps without model I/O, and the older Vercel `ai.*` spans aren't mapped yet |

A run with no content says "not captured", never "masked". A LangGraph app traced by OpenInference or OpenLLMetry has its spans grouped by graph node (the versions it was seen with are in [SPEC](SPEC.md) section 8.6). Section 6b has the full span mapping.

</details>

### 2. The `agentlab` library (Python, LangGraph)

The library sends, with every run, the map of everything the app *could* do, read from the compiled graph, plus the facts a trace can't know, all as OpenTelemetry span attributes. Depend on it by path from a checkout:

```toml
# your app's pyproject.toml
dependencies = ["agentlab[langgraph]"]

[tool.uv.sources]
agentlab = { path = "../agent-lab/sdk/python", editable = true }   # a clone of this repo beside your app
```

This is all an existing LangGraph app needs to show its whole flow:

```python
import agentlab as lab
from agentlab.langgraph import instrument

lab.init()                                       # once at startup
graph = instrument(builder.compile(), app=lab.App(name="HR policy bot"))
graph.invoke({"question": "How much PTO do I accrue?"})
```

Start the bench, run the app, and open `http://127.0.0.1:8790/?app=hr-policy-bot` (the app id is the name, slugged, unless `OTEL_SERVICE_NAME` is set). You get every step and branch, including the ones this run didn't take, with its path lit; each model call's prompt, output, tokens and time on the step that made it; and steps that called the model marked as the AI's.

With no bench listening, `lab.init()` stays silent and drops what it would send. Set `AGENT_LAB_URL=off` in production to turn it off entirely, or `AGENT_LAB_URL=http://host:port` when the bench runs elsewhere.

**Make it read well, where it pays off.** Words and facts go next to the code they describe:

```python
@lab.step("Is it a policy question?", says="The AI decides whether the handbook covers this.", actor="ai",
          paths={"policy": lab.path("a policy question"), "smalltalk": lab.path("just chatting")})
def triage(state):
    """Model returns {route, why} as JSON."""                    # Engineering's description
    parsed = json.loads(model.invoke(prompt(state)).content)
    lab.decision(parsed["why"])                                   # the AI's own reason, one line
    return {"route": parsed["route"]}

lab.corpus("handbook", title="Employee handbook", items=[(d.id, d.title) for d in HANDBOOK])
lab.check("cites_handbook", ok, evidence=cited, words={"passed": "The answer names a policy it was given."})
```

**Keep it honest in CI.** `verify` fails on any word that names a step, branch or state field the code doesn't have; after `lock`, `--strict` also fails on wording whose code changed since someone last re-read it:

```bash
uv run python -m agentlab verify my_app.graph:build_graph --strict
uv run python -m agentlab lock my_app.graph:build_graph              # after re-reading words whose code changed
```

In a usability pass on 2026-10-03, a fresh LangGraph app was hooked up using only the quickstart above. Renaming a node, splitting a document index in two and adding a branch all showed on the next run, while earlier runs kept their own map; `verify --strict` failed on the stale words until they were fixed and re-locked.

<details>
<summary><strong>What comes from where</strong>, and how drift is caught</summary>

Nothing on the screen is typed twice. Each kind of information has one home:

| | where it comes from | what you write | how drift is caught |
|---|---|---|---|
| **Structure**: steps, branches, branch names, subgraphs | **derived** from the compiled LangGraph graph, or from the Agent Spec file | nothing | Every run carries the map of the code that produced it, and the bench draws each run with its own map. A router with no path map and no `Literal` return type is a `verify` error (R3). |
| **Runtime facts**: model calls, prompts, outputs, tokens, tool calls, timing, approval pauses | **derived** from LangGraph's callbacks, as OpenTelemetry spans | nothing | These are what happened, attributed to the step that ran them. |
| **App facts**: documents, searches, decisions, checks, sign-offs, outcomes | **reported** by one line where each fact is produced: `lab.corpus`, `lab.retrieved`, `lab.decision`, `lab.check`, `lab.gate_resolved`, `lab.outcome`, `lab.event` | one line each | A document list comes from the index itself, so a renumbered handbook follows. The bench flags a fact naming a step, branch or document the map doesn't have (R7 to R9), in Engineering. |
| **Words**: plain step names, descriptions, branch words, check words, the request and reply fields | **authored** on the code they describe: `@lab.step(...)`, `paths=`, `words=` on `lab.check`. The docstring is Engineering's description. | as much or as little as you like | `verify` fails on a word naming a step, branch or state field the code doesn't have (R1, R2, R15). After `lock`, it flags wording whose step's code changed (R6). |
| **Custom panels** (stories) | **authored** JavaScript, shipped with the app | optional | `verify` fails on a panel naming a step that no longer exists (R1). The bench serves a story only when its hash matches the one the run was built with. |

The limits, stated plainly:
- The lock fingerprints the node function (its decorator included) and, for a branching step, its router and path map. Code the node calls elsewhere (a retriever, a helper) isn't fingerprinted, so a change there doesn't flag the step's words.
- Verification checks that every word names something real, and flags words whose code changed. It never claims the words are right.
- A `@lab.step` on a function that is no longer added to the graph isn't reported. Its words never reach the map, so nothing wrong is shown.
- A node that routes by returning `Command(goto=...)` without a `Command[Literal[...]]` return annotation isn't detected yet: it passes `verify` and is drawn with no exits. Annotate it.
- Branch lighting is derived from which step ran next, so it's right even when your code overrides the model's pick. For a path map where several branches lead to one step, pass `lab.decision(branch=...)`.

The full rule list is in [SPEC](SPEC.md) section 8.7; the library's guide (redaction, cost, sharing your app's OpenTelemetry provider, gates) is [`sdk/python`](sdk/python).

</details>

[`examples/langgraph_quickstart`](examples/langgraph_quickstart) is a complete app with words on every step and one line per fact (documents, searches, decisions, checks, outcomes), a scripted model (no API key) and its own CI test. [`examples/agent_loop`](examples/agent_loop) is one step that runs a whole tool-using agent; the bench shows its model and tool calls in the order they started, two of them at once.

### 3. Open Agent Spec

When an app is defined as an Agent Spec **flow** and its runtime executes that file, the file *is* the structure, so Agent Lab reads the map from it:

```bash
cd sdk/python
uv run python -m agentlab.agentspec ../../examples/agentspec/helpdesk_triage.yaml --verify    # exit 1 on a file error
```

Node names, descriptions, types, each branch by its own name, and subflows come from the file (tested against Oracle's example flows). `verify` also catches what the file gets wrong (R14): an edge from a branch its node doesn't declare, two edges from one branch, an edge to a node the flow doesn't list. It reports a case mismatch (`yes` against `Yes`) in Oracle's own branching example. Live runs and what's still untested: [`examples/agentspec`](examples/agentspec).

<details>
<summary><strong>No library for your language yet?</strong> Declare the map, or send events directly</summary>

Declare the map as JSON. Open `?app=my-app&mode=engineering` on a zero-setup run and click **⤓ map as topology.json**: it has the node ids your spans actually produce. Fill in the plain words, then register it:

```bash
curl -X PUT http://127.0.0.1:8790/apps/my-app \
  -H 'Content-Type: application/json' \
  -d @my-app.registration.json          # {"topology": {...}, "story": null}
```

Registration validates the map against [`schema/bench-topology.schema.json`](schema/bench-topology.schema.json); keys starting with `x-` are yours. [`examples/hello-agent.topology.json`](examples/hello-agent.topology.json) is a worked example of most of the fields. **A declared map is typed by hand, so it can drift from the code**; nothing checks it against the code, which is why it's the fallback and not the way in. A run that carries its own map always wins over it.

Not using OpenTelemetry? Send bench events, one at a time or in batches (the low-level path; the library doesn't use it):

```bash
curl -X POST http://127.0.0.1:8790/ingest -H 'Content-Type: application/json' -d '{
  "v": "bench/0", "run_id": "r1", "node": "classify", "event_type": "llm_call", "ts": 1790000000.0,
  "data": {"model": "claude-sonnet-5", "input_tokens": 820, "output_tokens": 40,
           "system": "...", "messages": [{"role": "user", "content": "..."}], "output": "..."}
}'
```

</details>

### Custom panels (stories)

The generic views cover every app the same way. A story is JavaScript panels that draw an app's own runs, for what no universal view can show, added beside the generic views. Panels name their steps by function (`nodes=[check_grounding]`), so a rename fails `verify` instead of stranding them; the bench serves a story only from a file you trust and only when its hash matches the run. Test one before anyone sees it: the story harness renders every panel at every event of your recordings, in both modes, and fails on a throw, an empty panel, `undefined`, `NaN` or `[object Object]`:

```bash
node tests/story_harness.js --story path/to/story.js [--topology path/to/map.json] path/to/*.recording.jsonl
```

The `Panel` fields are in [`sdk/python`](sdk/python#stories-custom-panels); the story API is [SPEC](SPEC.md) section 5.

## 📽️ Two modes

| | **Presentation** | **Engineering** |
|---|---|---|
| For | a meeting, a demo, a handoff: anyone can drive it | building and debugging the app |
| Shows | the map with one callout on the current step: plain step names, what it looked at, how it was checked, who signed off, time and cost in words, "What the AI was given" | everything: tokens, scores, ids, Model I/O, raw JSON, the event log, and "Checks on this map" (every verify and runtime finding) |
| Pace | recordings open paused on the first step and go at the presenter's pace, or Play pauses at the key moments; live, it follows the run, then offers "▶ Step through it" | follows the run |

Clicker keys: → / Space / PageDown forward a step, ← / PageUp back, Home and End, R the recap, M the map alone, `?` lists them. `&play=1` plays a recording, `&at=<step>` opens it at a step, `&at=end&recap=1` on the recap. Pick a mode with `?mode=presentation` or `?mode=engineering`, or the toggle in the header; the URL wins, then the viewer's remembered choice, then the default (Presentation for recordings and the side-by-side shell, Engineering on a live bench).

**Side by side** with your own app: `http://127.0.0.1:8790/shell/?app=<your app's url>&appid=my-app`. An app that refuses to be framed (`X-Frame-Options` or a strict CSP) can't sit in the shell; open the bench in its own window beside it instead.

## 🚫 What it isn't

Not a trace store. It keeps runs in a local log, with no auth, retention, search, evals or dashboards: that's what Langfuse, Phoenix and Logfire are for. It's the picture on top, meant to sit beside them. And it never changes the app: approvals and every other decision stay in the app.

<details>
<summary><strong>Send the same spans to Langfuse and to the bench</strong> (an OpenTelemetry Collector fan-out)</summary>

Point your app's exporter at the Collector (`http://127.0.0.1:4318`), so the bench never sits on the path to your real tracing:

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

The Langfuse settings follow [Langfuse's OpenTelemetry docs](https://langfuse.com/integrations/native/opentelemetry) as of 2026-10-03. This config hasn't been run against the bench yet. A Collector doesn't pass your request headers through, so set the session as a resource attribute instead (`OTEL_RESOURCE_ATTRIBUTES=bench.session_id=demo-1`).

</details>

## 🧪 See it in action

<a href="https://agentlab.trentmcnitt.com"><img src="docs/images/front-door.png" alt="The Agent Lab front door" width="820"></a>

**[agentlab.trentmcnitt.com](https://agentlab.trentmcnitt.com)** replays recordings of real model calls, side by side with the app. Run the bench locally to watch your own app live.

- **[Slack Helpdesk Agent](https://github.com/trentmcnitt/agent-lab-helpdesk)**: an example agent that answers IT requests, looks things up in a handbook, and asks a person before it changes anything.
- **[Bespoke](https://github.com/trentmcnitt/bespoke-ai-vscode-ext)**: AI autocomplete for VS Code, across five models. It's a TypeScript app, so its map is declared by hand until a TypeScript library exists.

## 🔧 How it works

A Python receiver, a JavaScript viewer, and a Python library for LangGraph and Agent Spec apps, tested down to browser end-to-end runs.

| Piece | What it is |
|---|---|
| **Events** | `bench/0`: run and step boundaries, model calls with tokens and I/O (and cost, when priced), decisions, retrievals, checks, tool calls, human gates. Unknown event types render generically. |
| **Map** | Every step and possible branch, with its words, plus the sources it can read, the checks that guard it and the panels to show. Library apps send it with every run, derived from their code; the bench keeps each by hash and draws every run with its own. |
| **Library** | `sdk/python` (`agentlab`): derives the map from a LangGraph graph or an Agent Spec flow, sends it and the app's facts over OpenTelemetry, and verifies the words. |
| **Story** | Optional JavaScript that draws an app's own panels, named by hash in the map each run carries. |
| **Receiver** | `bench/server.py`: OTLP (`adapters/otlp.py`), per-run maps, declared maps, native ingest, a live stream per session or app. `python -m bench.record` turns a library or Agent Spec app's OTLP/JSON into recordings. |
| **Viewer** | `viewer/`: Presentation and Engineering over the flow, sources, checks, timeline, Model I/O and panels. `shell/` is the side-by-side page. |

## 🗺️ Roadmap

Before-and-after comparisons of two architectures, and more scenarios. A TypeScript library, more framework integrations, a dated price table, forwarding and a browser extension are on the Later list, with the reasons. See [ROADMAP.md](ROADMAP.md).

## 🧑‍💻 Development

```bash
uv run pytest -q                                # format, OTLP adapter, receiver, story harness, browser e2e
(cd sdk/python && uv run pytest -q)             # the agentlab library, incl. LangGraph and Agent Spec
node --test tests/js/*.test.js                  # viewer logic (viewer/logic.js)
uv run pytest tests/e2e -q                      # just the browser tests (Playwright; skip if no Chromium)
node tests/story_harness.js examples/hello-*.recording.jsonl   # the story harness on hello-agent
uv run python scripts/export_static.py          # static, replay-only build -> dist/bench/
```

The bench keeps what it receives (the event log, maps, registered apps) under `data/` in this checkout; `BENCH_DATA_DIR=<dir>` keeps a project's runs apart.

## 📄 License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE) (FSL-1.1-ALv2). Use, modify and share it for anything except a competing commercial product or service; each version becomes Apache 2.0 two years after its release.

Built by [Trent McNitt](https://trentmcnitt.com).

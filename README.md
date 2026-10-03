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
  <a href="https://agentlab.trentmcnitt.com">Try the lab</a> · <a href="#quickstart">Quickstart</a> · <a href="SPEC.md">Spec</a> · <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <img src="docs/images/side-by-side.png" alt="Agent Lab: a Slack helpdesk agent on the left, the bench on the right showing its flow, timeline and costs" width="820">
</p>

> [!NOTE]
> **0.1 pre-alpha.** This is day-three software: the format and APIs will change. Issues and ideas are welcome.

Agent Lab is a bench you set beside an AI app. The app reports what it does as it runs; the bench draws the app's whole flowchart, lights up the path each run takes, and shows every step's prompt, output, time and cost. It's built for showing an AI system to people as much as for debugging it: a flowchart anyone can follow, with every engineering detail one click away.

It sits on top of the tracing you already have. It doesn't replace your observability tools, and it never changes the app: approvals and every other decision stay in the app.

## ✨ Features

- **🗺️ The whole flow, not just the trace.** Apps declare every step and branch they *could* take, so the paths a run didn't take show up too. Branch names follow [Open Agent Spec](https://github.com/oracle/agent-spec).
- **⟨⟩ The exact prompt.** Model I/O shows what the model was told, word for word, and exactly what it returned, per call.
- **⏱️ Timeline and cost.** Per-step latency, including time spent waiting for a human; tokens and cost per call, actual or estimated.
- **👀 Overview and Detailed.** Overview is readable by anyone. Detailed shows every field, every id and the raw event log.
- **🧩 Stories.** An app can register its own panels that explain its runs, the way comments explain code. Custom panels never hide data: every one has a raw toggle.
- **🪟 Side by side.** A shell puts the real app on the left and the bench on the right, live or from a recording. On a phone it becomes two tabs.
- **🔌 Framework-neutral.** Send bench events from any language, or point an OpenTelemetry exporter (GenAI conventions) at the bench.
- **📼 Replay anywhere.** Recordings carry their own map and story, so a static site can replay them with no server.

## 🚀 Quickstart

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/trentmcnitt/agent-lab.git
cd agent-lab
uv run uvicorn bench.server:app --port 8790
```

Open <http://127.0.0.1:8790/> and pick the **hello-agent** recording to see a run on the bench.

### Put your own app on the bench

1. **Register** your app's map (every step and possible branch), and optionally a story:

   ```bash
   curl -X PUT http://127.0.0.1:8790/apps/my-app \
     -H 'Content-Type: application/json' \
     -d @my-app.registration.json          # {"topology": {...}, "story": null}
   ```

2. **Send events** as your app runs, one at a time or in batches:

   ```bash
   curl -X POST http://127.0.0.1:8790/ingest -H 'Content-Type: application/json' -d '{
     "v": "bench/0", "run_id": "r1", "node": "classify", "event_type": "llm_call", "ts": 1790000000.0,
     "data": {"model": "claude-sonnet-5", "input_tokens": 820, "output_tokens": 40,
              "system": "...", "messages": [{"role": "user", "content": "..."}], "output": "..."}
   }'
   ```

   Already emitting OpenTelemetry? Skip the events and point your exporter at the bench; it draws a map from the spans it sees (verified with Pydantic AI and OpenInference's OpenAI instrumentor, 10-03-26; see [`examples/level0_pydantic_ai.py`](examples/level0_pydantic_ai.py)):

   ```bash
   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8790
   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf   # Python's auto-configuration otherwise defaults to gRPC
   OTEL_SERVICE_NAME=my-app                    # the bench's app id
   OTEL_BSP_SCHEDULE_DELAY=200                 # optional: send every 200 ms instead of 5 s
   ```

   **From an inferred map to your own (Level 0 → Level 1).** With no map registered, the bench lists your app on its front page and draws a map from your spans. To give it plain words, open `?app=my-app&mode=engineering` and click **⤓ map as topology.json**: you get that map as a file, with the node ids your spans actually produce (the same ids the event log shows, e.g. `chat my_agent` and `execute_tool lookup_order`; see SPEC section 6b). Fill in each node's `plain_label` and `description`, add `from_branch`/`description` on edges and any `sources`, then register it as in step 1 (`{"topology": <the file>, "story": null}`). A model call with no price shows its cost as unknown, never as $0.

3. **Watch** at `http://127.0.0.1:8790/?app=my-app`, or side by side with your app: `http://127.0.0.1:8790/shell/?app=<your app's url>&appid=my-app`.

[`examples/make_hello.py`](examples/make_hello.py) builds a complete map, story and recording; [`SPEC.md`](SPEC.md) has the full format.

## 🧪 See it in action

<a href="https://agentlab.trentmcnitt.com"><img src="docs/images/front-door.png" alt="The Agent Lab front door" width="820"></a>

**[agentlab.trentmcnitt.com](https://agentlab.trentmcnitt.com)** runs real apps on the bench, from recordings of real model calls:

- **Slack Helpdesk Agent**: an example agent that answers IT requests, looks things up in a handbook, and asks a person before it changes anything.
- **[Bespoke](https://github.com/trentmcnitt/bespoke-ai-vscode-ext)**: AI autocomplete for VS Code, across five models.
- **[OpenTask](https://github.com/trentmcnitt/opentask)**: coming soon.

## 🔧 How it works

| Piece | What it is |
|---|---|
| **Events** | `bench/0`: run and step boundaries, model calls with tokens, cost and I/O, decisions, retrievals, tool calls, human gates. Unknown event types are fine; they render generically. |
| **Map** | Every step (`nodes`) and possible branch (`edges`, with `from_branch`), plus the panels to show. |
| **Story** | Optional JavaScript that draws an app's own panels, registered with its map. |
| **Receiver** | `bench/server.py`: register, ingest, OTLP, a live stream per session, recordings. |
| **Viewer** | `viewer/`: the flow, timeline, Model I/O and panels. `shell/` is the side-by-side page. |

## 🗺️ Roadmap

A small client library (Python and TypeScript), forwarding runs to Langfuse, Logfire and Phoenix, before-and-after comparisons of two architectures, and more scenarios. See [ROADMAP.md](ROADMAP.md).

## 🧑‍💻 Development

```bash
uv run pytest -q                                # format, OTLP adapter, receiver, story harness, browser e2e
node --test tests/js/*.test.js                  # viewer logic (viewer/logic.js)
uv run pytest tests/e2e -q                      # just the browser tests (Playwright; skip if no Chromium)
uv run python scripts/export_static.py          # static, replay-only build -> dist/bench/
```

## 📄 License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE) (FSL-1.1-ALv2). Use, modify and share it for anything except a competing commercial product or service; each version becomes Apache 2.0 two years after its release.

Built by [Trent McNitt](https://trentmcnitt.com).

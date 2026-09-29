# The bench, v0: events, maps and stories

Status: **draft v0** (09-28-26). Name of the project is a placeholder.

The bench is a read-only observability harness for agent apps. It is framework-neutral: any app that reports to it can be shown on it, whatever it is built with. An app sends **bench events** (directly, or as OpenTelemetry spans the bench converts), and **registers itself**: its **map** (every step and possible branch) and, optionally, its **story** (custom panels that explain the app). The bench renders the events against the map, live or from a recording. It holds nothing app-specific in its own code, and it never calls back into an app: approvals, retries and anything else interactive stay in the app's own UI.

Two machine-readable files define v0:

- `schema/bench-event.schema.json`: one event (JSON Schema 2020-12).
- `schema/bench-topology.schema.json`: one app's map (the topology manifest).

The map's edge vocabulary follows **Open Agent Spec** (Oracle, Apache-2.0, 26.3.1): an edge is a *potential* transition out of a named branch of a node (`from_branch`), and a node reports the branch it took (`decision.data.branch`, Agent Spec's `branch_selected`).

Where this document and a schema disagree, the schema wins and this document is the bug.

## 1. The envelope

Every event is one JSON object:

```json
{
  "v": "bench/0",
  "session_id": "s-7f3a",
  "run_id": "run-req-012-88d30d",
  "seq": 4,
  "ts": 1790567453.343,
  "node": "classify",
  "event_type": "llm_call",
  "step_id": "run-req-012-88d30d:classify:1",
  "parent_step_id": null,
  "content_mode": "redacted",
  "data": { "model": "claude-sonnet-5", "input_tokens": 3096, "output_tokens": 107, "cost_usd": 0.007262, "cost_source": "estimated" }
}
```

| field | required | meaning |
|---|---|---|
| `v` | yes | Always `"bench/0"` in this version. |
| `run_id` | yes | One run of the app: one request, one completion, one agent invocation. |
| `node` | yes | The topology node this event belongs to. `"_run"` for run-level events that belong to no node. |
| `event_type` | yes | See section 2. **Open set**: any string is valid. |
| `ts` | yes | Unix seconds, float, when the event happened (not when it was sent). Replay timing is derived from it. |
| `session_id` | no | Groups runs across process boundaries: one playground session, one Slack workspace sandbox, one user visit. The same id must be carried by every process that touches the run. The bench filters live streams by it. Absent means the run is its own session. |
| `seq` | no | Monotonic integer per `run_id`, starting at 0. Breaks ties when two events share a `ts`, and lets the bench notice gaps. |
| `step_id` | no | One execution of one node inside a run. A node that runs twice (a retry, a loop) gets two step ids. If absent, the bench derives `<run_id>:<node>:<n>`. |
| `parent_step_id` | no | The step this one ran inside (a tool call inside an agent step, a sub-agent). `null` or absent means top level. |
| `content_mode` | no | `"full"` or `"redacted"`. Says whether prompt, document and output text in `data` is the real text or was masked before sending. Default `"redacted"`. The bench shows it on every run so a viewer knows what they are looking at. |
| `data` | no | The payload, shaped by `event_type`. Defaults to `{}`. |

Senders redact **before** sending. The bench stores what it receives and has no redaction of its own.

## 2. Event types

The bench understands the types below. **Any other `event_type` is valid** and renders as a generic key/value entry on its node and in any panel that lists it (section 4). A sender is never blocked on the bench adding a type.

### Run lifecycle

| type | node | data |
|---|---|---|
| `run_started` | `_run` | Optional: `label` (short human title), `input` (the request, subject to `content_mode`), `origin` (e.g. `"slack"`, `"web"`, `"suite"`). |
| `run_finished` | `_run` | `status`: `ok` \| `error` \| `aborted`. Optional: `output`, `latency_ms`, `outcome` (an app-specific result label, e.g. `executed`, `handed_off`, `cache_hit`). |

### Steps

| type | data |
|---|---|
| `step_started` | Optional: `input`. |
| `step_finished` | `status`: `ok` \| `error` \| `skipped` \| `aborted`. Optional: `latency_ms`, `timings` (object of named sub-stage durations in ms, e.g. `{"debounce": 150, "wait": 12, "model": 840}`), `output`, `error`. |

A step is open from `step_started` to `step_finished`. Any event whose `node` has no open step implicitly opens one. The bench then closes the previous top-level step **at that step's own last event**, and starts the new one at the same moment. Many apps publish only when work finishes (a model-call event arrives after the model returns), so the silence before a node's first event is that node's work, not the previous node's. Such latencies are marked *inferred*. Senders that can emit both boundaries should.

### Model calls

`llm_call`, one per model request:

| data field | meaning |
|---|---|
| `model` | Model id as reported by the response (fall back to the request). |
| `provider` | Optional. OTel `gen_ai.provider.name` values (`anthropic`, `openai`, `gcp.gemini`, ...). |
| `input_tokens` | **Total** input tokens, *including* cache reads and cache writes (the OTel GenAI convention). |
| `cache_read_tokens` | Input tokens served from the provider's cache. Included in `input_tokens`. |
| `cache_write_tokens` | Input tokens written to the provider's cache. Included in `input_tokens`. |
| `output_tokens` | Output tokens, reasoning included. |
| `cost_usd` | Cost of this one call. |
| `cost_source` | `actual` (the provider or backend reported it) or `estimated` (computed from a price table). |
| `cost_basis` | Optional, short: where the number came from, e.g. `"anthropic price table 09-2026"`, `"claude-code sdk total_cost_usd"`. |
| `latency_ms`, `time_to_first_chunk_ms` | Optional. |
| `finish_reason` | Optional. |
| `stream` | Optional boolean. |
| `system` | Optional. The system instructions exactly as sent (OTel `gen_ai.system_instructions`). |
| `messages` | Optional. The input messages exactly as sent, in order: `[{role, content}]`, where `content` is a string or the provider's content blocks (OTel `gen_ai.input.messages`). |
| `output` | Optional. The raw output exactly as returned: text, or the tool call / structured object (OTel `gen_ai.output.messages`). |
| `params` | Optional. Request parameters that shaped the output: `max_tokens`, `temperature`, tools offered, and so on. |

**Prompt and response are the point of the bench.** Send `system`, `messages` and `output` whenever you can. With `content_mode: "redacted"`, send them masked rather than omitting them, so the structure still shows. The bench shows them in its built-in Model I/O panel: exactly what the model was given and what it returned.

**The token rule is the one most likely to go wrong.** Anthropic's raw API and several SDKs report `input_tokens` as the *uncached* part only. Senders using that convention must add the cache buckets back in before sending: `input_tokens = uncached + cache_read + cache_write`. The bench computes uncached input as `input_tokens - cache_read_tokens - cache_write_tokens` and flags an event where that comes out negative.

### Content and decisions

| type | data |
|---|---|
| `chunk` | `text` (a streamed delta), `index` (0-based position in the stream). Optional; non-streaming apps never send it. |
| `decision` | A branch choice or classification. `branch`: the branch taken out of this node, matching an edge's `from_branch` in the map (Agent Spec `branch_selected`); when present it names the taken edge exactly. Recommended: `rationale`, `confidence`. App-specific keys are fine. |
| `retrieval` | `hits`: array of `{id, title, score, text?}` plus any app-specific score fields. Optional `query`. |
| `tool_call` | `tool` (name). Optional: `arguments`, `result`, `status`, `transport`. |
| `error` | `message`. Optional: `type`, `retryable`. The step it belongs to should also finish with `status: "error"`. |

### Gates (human-in-the-loop)

| type | data |
|---|---|
| `gate_waiting` | The run is paused at this node for a decision made **elsewhere** (in the app). Optional: `proposed` (what would execute), `digest`, `reason`. |
| `gate_resolved` | `approved`: boolean. Optional: `by`, `via` (e.g. `"slack"`, `"web"`), `digest_match`, `reason`. |

The bench shows the gate's state and what is proposed. It has no approve or deny control.

## 3. Transport

- **Register** (the app, at its startup): `PUT /apps/<app_id>` with `{"topology": <map>, "story": "<js source>" | null}`. The bench validates the map, keeps it (under `data/apps/`, so a restart doesn't forget it) and serves the story at `/apps/<app_id>/story.js`. Re-registering replaces both; `"story": null` removes the story. This is the only way app-specific material reaches the bench.
- **Ingest:** `POST /ingest` with one event or a JSON array of events, `Content-Type: application/json`. The receiver validates each against the schema and answers `{"accepted": n, "rejected": [{"index": i, "error": "..."}]}`. One bad event does not reject the batch.
- **OTLP ingest:** `POST /v1/traces?session_id=<id>[&app=<app_id>]`: OTLP/HTTP **JSON** (protobuf is not accepted in v0). Point an OTLP exporter's endpoint at the bench's base URL. `app` selects the map whose `node_from` maps spans to nodes. The response is an OTLP `ExportTraceServiceResponse`, with `partialSuccess` when spans were rejected.
- **Live stream out:** `GET /stream?session_id=<id>` (SSE). Each message's `data:` is one event. Without `session_id` the stream carries everything (local use only).
- **Recording:** a JSONL file, `*.recording.jsonl`. Its first line is a header, `{"v": "bench-recording/0", "topology": <map>, "story": "<js>" | null}`, and every later line is one event, in `seq`/`ts` order. The header makes a recording self-contained: it replays with no receiver and no registration, which is what a static export needs. Replay plays events with their original spacing from `ts`, capped so long idle gaps don't stall the demo. The bench lists its own `examples/` and whatever an app drops in `data/recordings/`.

v0 is local only: no auth, bound to 127.0.0.1. The bench is not meant to be public; a static export of recordings is the public form.

### 3a. Embedded sync (no server): postMessage through the shell

For a static site, where there is no receiver: the app's own replay of its UI sends bench events to the bench as the visitor clicks, so the two panes stay in step. Everything goes through the shell (`shell/index.html`), which holds both iframes.

- **App → shell** (`window.parent.postMessage(msg, targetOrigin)`), only when the app is inside the shell (`window.self !== window.top`). `targetOrigin` is the shell's origin, which the shell passes to the app as `?bench_origin=`; never `"*"`. Stamp events with the `?bench_session=` id the shell also passes. Other types (e.g. `bench:replay_done`) are ignored.
  - `{"type": "bench:register", "topology": <map>, "story": "<js>" | null}`: once, before any events. The same body as `PUT /apps/<id>`.
  - `{"type": "bench:events", "events": [<bench event>, ...]}`, or one at a time as `{"type": "bench:event", "event": <bench event>}`: as the app's replay produces them, with `ts` rewritten to now, so the bench's timings read like a live run.
  - `{"type": "bench:reset"}`: optional; clears the bench (the visitor started over).
- **Shell → bench:** the shell relays exactly those messages, from its app iframe only (checked by window, not by origin), to its bench iframe at its own origin, and buffers them until the bench posts `bench:ready`.
- **Bench:** opened as `?source=parent`, it accepts messages only from its parent window, draws the registered map and story, and treats events like a live stream.

The shell accepts no other messages from the app; any other `type` is ignored. The shell has one layout, always side by side.

## 4. The map (topology manifest)

One per app, owned by the app and registered by it. It lets the bench draw the whole graph before anything runs, so a branch that is never taken still shows as a box that stayed dark. The bench's own example is `examples/hello-agent.topology.json`:

```json
{
  "v": "bench-topology/0",
  "app": { "id": "hello-agent", "name": "Hello agent (synthetic example)" },
  "nodes": [
    { "id": "triage", "label": "triage", "kind": "llm" },
    { "id": "escalate", "label": "escalate", "kind": "gate" }
  ],
  "edges": [
    { "from": "triage", "to": "lookup", "from_branch": "answerable" },
    { "from": "triage", "to": "escalate", "from_branch": "needs_human" }
  ],
  "panels": [
    { "id": "triage", "title": "Triage", "event_types": ["decision"], "nodes": ["triage"], "story": true },
    { "id": "docs", "title": "Docs found", "event_types": ["retrieval"], "fields": ["query", {"key": "hits", "format": "json"}] },
    { "id": "llm", "title": "Model calls", "event_types": ["llm_call"], "mode": "append" }
  ],
  "story": true
}
```

- `nodes[].kind`: `step` (default), `llm`, `tool`, `retrieval`, `gate`, `terminal`. It picks the icon and which details the node box shows.
- `edges[].from_branch`: the branch of `from` that selects this edge; drawn as the edge's label. An edge is *taken* when a `decision` on `from` reports that `branch`, or, when no branch is reported, when its two nodes ran one after the other.
- `panels`: the instrument panels beside the graph. Each collects the listed event types (optionally only from the listed nodes), newest only (`mode: "latest"`, the default) or all (`"append"`). Three ways to draw one, in order of preference:
  1. `"story": true`: the app's story draws it (section 5).
  2. `fields`: a **declared panel**: only these data keys, in order, each with an optional `label` and `format` (`number:2`, `usd`, `ms`, `tokens`, `percent`, `json`, `quote`, ...). No code.
  3. Neither: the bench's generic view of each event type.

  A panel drawn by 1 or 2 has a **raw** toggle that shows the generic view of every field, so a story never hides data.
- `node_from` (OTLP apps only): how to get a bench `node` from a span: `{"attribute": "<span attribute>"}` or `{"span_name": true}` (the default).
- Events whose `node` is not in the map still render, in an "unmapped" row, so a stale map never hides data.

## 5. Stories

A story is the app's own script, registered with its map, that explains the app on top of the generic bench: the same split as Manim's engine and its scenes. It adds views; the raw layer (every event, every field, the event log) is always one click away.

```js
BenchStory.register('<app_id>', {
  panels: {
    // For a map panel with "story": true. events: the panel's events (newest only, or all
    // for mode "append"). ctx.run: the whole run so far. ctx.h: helpers (esc, kv, fmtMs,
    // fmtUsd, fmtTok, short, fields, generic). Return HTML.
    '<panel id>': function (events, ctx) { return '...'; }
  },
  renderers: {
    // Optional: this app's view of one event type, used wherever the generic view would be.
    '<event_type>': function (ev, ctx) { return '...'; }
  }
});
```

A story that throws is shown as an error in its panel, and the bench falls back to the generic view. Stories run in the viewer's page with its full privileges, which is fine for a local bench whose apps are your own; don't register a story you haven't read.

## 6. Adapters

An adapter turns a source's output into bench events. **App-specific adapters live in the app's own repo** and send native events; the bench carries only adapters for open standards.

### 6a. Native

The app (or its own adapter) emits bench events directly.

### 6b. OTLP/HTTP JSON spans → bench events (`adapters/otlp.py`)

Against the OTel GenAI semantic conventions, which are **Development** status and moved in 2026 to their own repo, `open-telemetry/semantic-conventions-genai`. Verified at commit `e57c543b` (main, 09-24-26); that repo had no tagged release when checked. The names used here:
| OTLP | bench |
|---|---|
| `traceId` | `run_id` (unless a run attribute overrides it) |
| `gen_ai.conversation.id`, else resource/span attribute `session.id` | `session_id` |
| `spanId` / `parentSpanId` | `step_id` / `parent_step_id` |
| span `startTimeUnixNano` / `endTimeUnixNano` | `step_started` / `step_finished` `ts`, and `latency_ms` |
| span `status.code` 2 (ERROR) | `step_finished.status = "error"` plus an `error` event |
| `gen_ai.operation.name` in `chat`, `text_completion`, `generate_content` | also an `llm_call` at span end |
| `gen_ai.operation.name = execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.arguments` / `.result` | `tool_call` |
| `gen_ai.operation.name` in `invoke_agent`, `invoke_workflow` on a root span | `run_started` / `run_finished` |
| `gen_ai.response.model`, else `gen_ai.request.model` | `llm_call.model` |
| `gen_ai.provider.name` | `llm_call.provider` |
| `gen_ai.usage.input_tokens` | `input_tokens` (already total by the convention) |
| `gen_ai.usage.cache_read.input_tokens` | `cache_read_tokens` |
| `gen_ai.usage.cache_write.input_tokens` (formerly `cache_creation`; renamed upstream in PR 440, both accepted) | `cache_write_tokens` |
| `gen_ai.usage.output_tokens` | `output_tokens` |
| `gen_ai.response.finish_reasons[0]` | `finish_reason` |
| `gen_ai.response.time_to_first_chunk` | `time_to_first_chunk_ms` |

The conventions define **no cost attribute**. If the span carries `gen_ai.usage.cost` (the attribute Langfuse reads; exporters typically set it only when the backend reported a cost), the adapter uses it as `cost_source: "actual"`. Otherwise it estimates from a dated price table and says so in `cost_basis`. OTLP/JSON quirks the adapter handles: 64-bit ints and nanosecond timestamps arrive as strings, attributes are `{key, value: {stringValue | intValue | doubleValue | boolValue | arrayValue}}`, and ids are hex strings.

## 7. What v0 leaves out

- Auth, multi-user, retention: local only.
- Metrics and aggregation across runs (cost per day, p95 latency). The bench shows runs; evals stay in each app.
- Writing back to the app. Read-only by design.
- Forwarding to other backends (Langfuse, Logfire, Phoenix...): planned next, so one run can be seen in several tools at once.
- Reading Agent Spec flow files directly as maps: the vocabulary is aligned, the importer isn't written.
- Streaming chunk rendering beyond appending text; no app sends `chunk` yet.

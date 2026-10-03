# The bench, v0: events, maps and stories

Status: **draft v0** (09-28-26; opened and extended 10-03-26: every addition is optional, so v0 maps and events still validate). Name of the project is a placeholder.

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
| `content_mode` | no | `"full"`, `"redacted"` or `"absent"`. Says whether prompt, document and output text in `data` is the real text, was masked before it was sent to the bench (the record is masked; what the model saw is the app's business), or was not captured at all (e.g. an OTLP span with content capture off). Default `"redacted"`. The bench shows it on every run so a viewer knows what they are looking at; `absent` reads as "not captured", never as "masked". |
| `data` | no | The payload, shaped by `event_type`. Defaults to `{}`. |

Senders redact **before** sending. The bench stores what it receives and has no redaction of its own.

## 2. Event types

The bench understands the types below. **Any other `event_type` is valid** and renders as a generic key/value entry on its node and in any panel that lists it (section 4). A sender is never blocked on the bench adding a type.

### Run lifecycle

| type | node | data |
|---|---|---|
| `run_started` | `_run` | Optional: `label` (short human title), `input` (the request, subject to `content_mode`), `origin` (e.g. `"slack"`, `"web"`, `"suite"`). |
| `run_finished` | `_run` | `status`: `ok` \| `error` \| `aborted`. Optional: `output`, `latency_ms`, `outcome` (an app-specific result label, e.g. `executed`, `handed_off`, `cache_hit`), `baseline` (string: what this job takes a person, as the app states it, e.g. `"~10–15 minutes"`; shown attributed to the app, and the bench does no arithmetic with it). |

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
| `context_items` | Optional. Source item ids (as in `retrieval` hits) the app says went into this prompt. A hint only, for redacted prompts: when the prompt text is there, the bench checks hits against it instead. |

**Prompt and response are the point of the bench.** Send `system`, `messages` and `output` whenever you can. With `content_mode: "redacted"`, send them masked rather than omitting them, so the structure still shows. The bench shows them in its built-in Model I/O panel: exactly what the model was given and what it returned.

**The token rule is the one most likely to go wrong.** Anthropic's raw API and several SDKs report `input_tokens` as the *uncached* part only. Senders using that convention must add the cache buckets back in before sending: `input_tokens = uncached + cache_read + cache_write`. The bench computes uncached input as `input_tokens - cache_read_tokens - cache_write_tokens` and flags an event where that comes out negative.

### Content and decisions

| type | data |
|---|---|
| `chunk` | `text` (a streamed delta), `index` (0-based position in the stream). Optional; non-streaming apps never send it. |
| `decision` | A branch choice or classification. `branch`: the branch taken out of this node, matching an edge's `from_branch` in the map (Agent Spec `branch_selected`); when present it names the taken edge exactly. Recommended: `rationale`, `confidence`. Optional `cited`: source item ids the decision rests on. App-specific keys are fine. |
| `retrieval` | `hits`: array of `{id, title, score, text?}` plus any app-specific score fields. Optional `query`, and `source`: the map's `sources[].id` it searched. A hit's `text` is the only place item text reaches the bench. |
| `check_result` | One check that guards the app. `name`, `passed` (boolean). Optional: `state` (`passed` \| `failed` \| `not_on_path`), `detail`, `evidence` (source item ids it relied on), `kind` (open set: `grounding`, `policy`, `permission`, `format`, ...). App-specific keys are fine. `check` is accepted on ingest as an alias and stored as `check_result`. Emit it *alongside* a node's `decision`, never instead: `decision.branch` is what lights edges. |
| `tool_call` | `tool` (name). Optional: `arguments`, `result`, `status`, `transport`. |
| `error` | `message`. Optional: `type`, `retryable`. The step it belongs to should also finish with `status: "error"`. |

### Gates (human-in-the-loop)

| type | data |
|---|---|
| `gate_waiting` | The run is paused at this node for a decision made **elsewhere** (in the app). Optional: `proposed` (what would execute), `digest`, `reason`. |
| `gate_resolved` | `approved`: boolean. Optional: `by`, `via` (e.g. `"slack"`, `"web"`), `digest_match`, `reason`. |

The bench shows the gate's state and what is proposed. It has no approve or deny control.

## 3. Transport

- **Register** (the app, at its startup): `PUT /apps/<app_id>` with `{"topology": <map>, "story": "<js source>" | null}`. The bench validates the map, keeps it (under `data/apps/`, so a restart doesn't forget it) and serves the story at `/apps/<app_id>/story.js`. Re-registering replaces both; `"story": null` removes the story. This is the only way app-specific material reaches the bench. At startup the bench reloads every stored map; one that no longer validates (e.g. after a schema change) is skipped with a warning on stderr naming the map and its first error.
- **Ingest:** `POST /ingest` with one event or a JSON array of events, `Content-Type: application/json`. The receiver validates each against the schema and answers `{"accepted": n, "rejected": [{"index": i, "error": "..."}]}`. One bad event does not reject the batch. An aliased `event_type` (`check`) is renamed to its standard name (`check_result`) before validation, so the log and `/stream` carry only the standard name. Recordings and postMessage events don't pass through the receiver; they should use `check_result`, and the viewer accepts the alias there too.
- **OTLP ingest:** `POST /v1/traces[?session_id=<id>][&app=<app_id>]`: OTLP/HTTP, **protobuf** (`application/x-protobuf`, the exporters' default) or **JSON**, either one optionally `Content-Encoding: gzip` (the 5 MB limit applies after decompression). Ids may be hex or base64. Point an OTLP exporter's endpoint at the bench's base URL (`OTEL_EXPORTER_OTLP_ENDPOINT`; with `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, since Python's auto-configuration otherwise defaults to gRPC). App = `?app=` > resource `service.name`; it selects the map whose `node_from` maps spans to nodes. Session = `?session_id=` > header `x-agent-lab-session` > `bench.session_id` > `session.id` > `gen_ai.conversation.id`, resolved once per trace. A root span is a run; traces with no AI span are dropped. The response is an OTLP `ExportTraceServiceResponse` in the request's encoding, with `partialSuccess` when spans were rejected. Section 6b has the span mapping.
- **Live stream out:** `GET /stream?session_id=<id>` (SSE). Each message's `data:` is one event. Without `session_id` the stream carries everything (local use only).
- **Recording:** a JSONL file, `*.recording.jsonl`. Its first line is a header, `{"v": "bench-recording/0", "topology": <map>, "story": "<js>" | null}`, optionally with `title` (the run in plain words, e.g. "Asks for a license") and `group` (what kind of run it is, e.g. "It opens a ticket (a person approves)") for the plain run picker. Every later line is one event, in `seq`/`ts` order. The header makes a recording self-contained: it replays with no receiver and no registration, which is what a static export needs. Replay plays events with their original spacing from `ts`, capped so long idle gaps don't stall the demo. The bench lists its own `examples/` and whatever an app drops in `data/recordings/`.

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

Beyond `v`, `app.id`, `app.name`, `nodes[].id`, `edges[].from`/`to` and a panel's `id`/`title`/`event_types`, every field and section is optional, so a map written before any of them still validates. An optional section's own required fields are listed below.

**App**

| field | meaning |
|---|---|
| `id`, `name` | Required. `id` is lowercase (`^[a-z0-9][a-z0-9_.-]*$`). |
| `url`, `description` | Optional. |
| `privacy_note` | What the app hides **on this screen**, in plain words. Presentation shows it in place of its generic line ("Some details are hidden on this screen."). It must not claim more than the app does: if the model saw the original text, say so. |
| `track_record` | The app's own claim about how it has performed. Shown attributed to the app, never as the bench's finding. |

**Nodes**

| field | meaning |
|---|---|
| `id` | Required. Not `_run`. |
| `label` | The technical name. In Presentation it shows small, beneath `plain_label`. |
| `plain_label` | The Presentation name, in plain words. Falls back to `label`, then `id`. |
| `kind` | `step` (default), `llm`, `tool`, `retrieval`, `gate`, `check`, `terminal`. Picks the icon and which details the node box shows. A `check` node guards the app; it gets a row in the Checks list, and one the run never entered shows as not needed this time. |
| `actor` | Who does the step: `ai`, `rule`, `person`, `app`. Default from `kind`: `llm`→`ai`, `gate`→`person`, `check`→`rule`, anything else→`app`. |
| `description` | What the step does, in plain words: the node's note. |
| `moment` | Boolean. Replay's Play pauses here. With no `moment` declared anywhere, it pauses at decision nodes with branches, check nodes, gates and the outcome. |

**Edges**

| field | meaning |
|---|---|
| `from`, `to` | Required. |
| `from_branch` | The branch of `from` that selects this edge; drawn as the edge's label. An edge is *taken* when a `decision` on `from` reports that `branch`, or, when no branch is reported, when its two nodes ran one after the other. |
| `description` | What taking this branch means, in plain words. On an edge the run didn't take, it is the "why not taken" line. |

**Sources, actions, never** (what the app can see and do; every entry is the app's own statement and is shown attributed)

| field | meaning |
|---|---|
| `sources[]` | What the app can read: `{id, title, kind, description, count?, items?}`, the first four required. `kind` is open (`documents`, `database`, `api`, `inbox`, `message`, ...). `description` is the app's note, including what it can't see. `count` is how many items it holds. `items[]` is `{id, title}` only: **no item text in the map**; text reaches the bench only in `retrieval` hits. |
| `actions[]` | What the app can do in the world: `{id, title, description}`, all required. |
| `never` | `[string]`: what the app can never do, in plain words ("What it can never do (the app says)"). |

A source has three states in a run, each computed by the viewer from events, never declared: **could look at** (in the map); **given to the AI** (a `retrieval` hit from that source whose `text` appears in a later `llm_call`'s `system` or `messages` in the same run, by substring; when the prompt is redacted or has no text, the viewer falls back to "found by the search", and may use `llm_call.context_items` as a labelled hint); **relied on** (an item id in a `check_result.evidence` or a `decision.cited`). Item ids are matched against `retrieval` hits' `id`.

**Panels**

The instrument panels beside the graph. Each collects the listed event types (optionally only from the listed `nodes`), newest only (`mode: "latest"`, the default) or all (`"append"`). Three ways to draw one, in order of preference:
1. `"story": true`: the app's story draws it (section 5).
2. `fields`: a **declared panel**: only these data keys, in order, each with an optional `label` and `format` (`number:2`, `usd`, `ms`, `tokens`, `percent`, `json`, `quote`, ...). No code.
3. Neither: the bench's generic view of each event type.

A panel drawn by 1 or 2 has a **raw** toggle that shows the generic view of every field, so a story never hides data. `audience` says which view mode shows the panel: `both` (default), `presentation` or `engineering` (section 4a). A panel's `mode` (latest/append) is unrelated to the view mode.

**Other**
- `node_from` (OTLP apps only): how to get a bench `node` from a span: `{"attribute": "<span attribute>"}` or `{"span_name": true}` (the default).
- `story`: the app registers a story with its map (section 5).
- **Extensions:** any key starting with `x-` is accepted, and ignored by the bench, at the top level and on `app`, nodes, edges, panels, sources (and their items) and actions. Any other unknown key is rejected, so a typo still fails loudly.
- Events whose `node` is not in the map still render, in an "unmapped" row, so a stale map never hides data.

### 4a. Presentation vs Engineering

The viewer has two modes over the same map and events. **Presentation** is for a room of non-engineers: plain labels and notes, what the app looked at, how it was checked, who signed off, and time, cost and baseline in words. It hides tokens, scores, ids, raw JSON, the event log, model ids, the run-id picker, redaction badges and the model's self-reported confidence, and shows only `both` and `presentation` panels. **Engineering** shows everything, every panel, raw toggles and the event log.

The mode is chosen in this order: the `?mode=presentation|engineering` URL parameter, then the viewer's remembered choice (localStorage), then the source's default: **Presentation** for a recording replay and for a parent (shell) source, **Engineering** for a live stream. A remembered value from the old view switch migrates: `overview`→`presentation`, `detailed`→`engineering`.

Details the viewer relies on:
- **Panels in Presentation** appear inside the NOW card, for the node they belong to (`nodes` if set, else any node whose events match the panel's types). Story and `fields` panels follow `audience` (default `both`); generic panels show only when explicitly `audience: "presentation"`.
- **Check copy.** A `kind: "check"` node may carry its own per-state line as `x-states: {"passed": "…", "failed": "… {detail}", "not_on_path": "…"}` (`{detail}` is filled from the event), or just its "not needed" line as `x-not-needed: "…"`. A `check_result` on a non-check node is shown by `data.label`, else `data.name`. A decision's `cited` ids don't count as "relied on" when a check in the same step failed.
- **Pacing (replays).** Play pauses on its own at `moment: true` nodes (default: decisions with branches, checks, gates and the outcome); ◂ / ▸ step a node at a time. `?pause=0` turns the auto-pause off, `?speed=N` speeds up, `?mode=` forces a mode.
- **The run picker** ("Try another request") reads `recordings.json` entries `{path, title, app?, plain_title?, group?}`; `plain_title` and `group` come from the recording header's `title` and `group`. Groups appear in the order of the first recording in each.

## 5. Stories

A story is the app's own script, registered with its map, that explains the app on top of the generic bench: the same split as Manim's engine and its scenes. It adds views; the raw layer (every event, every field, the event log) is always one click away.

```js
BenchStory.register('<app_id>', {
  panels: {
    // For a map panel with "story": true. events: the panel's events (newest only, or all
    // for mode "append"). ctx.run: the whole run so far. ctx.h: helpers (esc, kv, fmtMs,
    // fmtUsd, fmtTok, short, fields, generic). ctx.mode: "presentation" | "engineering"
    // (section 4a), so one panel can render two ways. Return HTML.
    '<panel id>': function (events, ctx) { return '...'; }
  },
  renderers: {
    // Optional: this app's view of one event type, used wherever the generic view would be.
    // Receives the same ctx, ctx.mode included.
    '<event_type>': function (ev, ctx) { return '...'; }
  }
});
```

A story that throws is shown as an error in its panel, and the bench falls back to the generic view. Stories run in the viewer's page with its full privileges, which is fine for a local bench whose apps are your own; don't register a story you haven't read.

## 6. Adapters

An adapter turns a source's output into bench events. **App-specific adapters live in the app's own repo** and send native events; the bench carries only adapters for open standards.

### 6a. Native

The app (or its own adapter) emits bench events directly.

### 6b. OTLP/HTTP spans (protobuf or JSON) → bench events (`adapters/otlp.py`)

Against the OTel GenAI semantic conventions, which are **Development** status and moved in 2026 to their own repo, `open-telemetry/semantic-conventions-genai`. Verified at commit `e57c543b` (main, 09-24-26); that repo had no tagged release when checked. The names used here:
| OTLP | bench |
|---|---|
| `traceId` | `run_id` (unless a run attribute overrides it) |
| `?session_id=`, else header `x-agent-lab-session`, else `bench.session_id`, `session.id`, `gen_ai.conversation.id` (resolved once per trace) | `session_id` |
| `?app=`, else resource `service.name` | `run_started.data.app` (and the map used for `node_from`) |
| `spanId` / `parentSpanId` | `step_id` / `parent_step_id` |
| span `startTimeUnixNano` / `endTimeUnixNano` | `step_started` / `step_finished` `ts`, and `latency_ms` |
| span `status.code` 2 (ERROR) | `step_finished.status = "error"` plus an `error` event |
| `gen_ai.operation.name` in `chat`, `text_completion`, `generate_content` | also an `llm_call` at span end |
| `gen_ai.operation.name = execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.arguments` / `.result` | `tool_call` |
| any root span (no parent) | `run_started` (`data`: `label`, `via: "otlp"`, `app`, `input`) / `run_finished` (`outcome`). An `invoke_agent`/`invoke_workflow` root is only the run; any other root is the run and its first step. `run_started` usually arrives last: the viewer sorts by `ts`, then `seq`. |
| a trace with no span carrying `gen_ai.*`, `llm.*`, `openinference.*` or `traceloop.*` attributes | dropped (not AI work) |
| node id (default) | `execute_tool {gen_ai.tool.name}`, `invoke_agent {gen_ai.agent.name}`, `retrieval {gen_ai.data_source.id}`, LLM ops `{op} {gen_ai.agent.name}` or `{op}`; never the model. A map's `node_from` wins; `{"span_name": true}` restores span names. |
| content attributes present (`gen_ai.input/output.messages`, `system_instructions`, tool args/results, `retrieval.documents`/`query.text`, `input.value`/`output.value`, `pydantic_ai.all_messages`) | `content_mode: "full"`; none at all: `"absent"`; a `bench.content_mode` span/resource attribute overrides. Never inferred as `redacted`. |
| `gen_ai.operation.name = retrieval`, `gen_ai.data_source.id`, `gen_ai.retrieval.query.text`, `gen_ai.retrieval.documents` (JSON string or structured) | `retrieval` with `source`, `query`, `hits[]` (`id`, `title`, `score`, `text` from `content`/`text`) |
| `gen_ai.evaluation.result` span events; OpenInference GUARDRAIL/EVALUATOR spans | `check_result` (unverified against a real emitter, 10-03-26) |
| OpenInference names (`openinference.span.kind`, `llm.input_messages.N.*`, `llm.token_count.*`, `retrieval.documents.N.document.*`, …) | aliased onto the GenAI names above; GenAI wins when both are present |
| `gen_ai.response.model`, else `gen_ai.request.model` | `llm_call.model` |
| `gen_ai.provider.name` | `llm_call.provider` |
| `gen_ai.usage.input_tokens` | `input_tokens` (already total by the convention) |
| `gen_ai.usage.cache_read.input_tokens` | `cache_read_tokens` |
| `gen_ai.usage.cache_write.input_tokens` (formerly `cache_creation`; renamed upstream in PR 440, both accepted) | `cache_write_tokens` |
| `gen_ai.usage.output_tokens` | `output_tokens` |
| `gen_ai.response.finish_reasons[0]` | `finish_reason` |
| `gen_ai.response.time_to_first_chunk` | `time_to_first_chunk_ms` |

The conventions define **no cost attribute**. If the span carries `gen_ai.usage.cost` (the attribute Langfuse reads; exporters typically set it only when the backend reported a cost), the adapter uses it as `cost_source: "actual"`. Otherwise it estimates from a dated price table and says so in `cost_basis`. OTLP/JSON quirks the adapter handles: 64-bit ints and nanosecond timestamps arrive as strings, attributes are `{key, value: {stringValue | intValue | doubleValue | boolValue | arrayValue}}`, and ids are hex strings (protobuf ids are decoded to hex too).

## 7. What v0 leaves out

- Auth, multi-user, retention: local only.
- Metrics and aggregation across runs (cost per day, p95 latency). The bench shows runs; evals stay in each app.
- Writing back to the app. Read-only by design.
- Forwarding to other backends (Langfuse, Logfire, Phoenix...): planned next, so one run can be seen in several tools at once.
- Reading Agent Spec flow files directly as maps: the vocabulary is aligned, the importer isn't written.
- Streaming chunk rendering beyond appending text; no app sends `chunk` yet.

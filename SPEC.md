# The bench, v0: events, maps and stories

Status: **draft v0** (09-28-26; opened and extended 10-03-26: every addition is optional, so v0 maps and events still validate).

The bench is a read-only observability harness for agent apps. It is framework-neutral: any app that reports to it can be shown on it, whatever it is built with. An app sends **bench events** (directly, or as OpenTelemetry spans the bench converts), and **registers itself**: its **map** (every step and possible branch) and, optionally, its **story** (custom panels that explain the app). The bench renders the events against the map, live or from a recording. It holds nothing app-specific in its own code, and it never calls back into an app: approvals, retries and anything else interactive stay in the app's own UI.

Two machine-readable files define v0:

- `schema/bench-event.schema.json`: one event (JSON Schema 2020-12).
- `schema/bench-topology.schema.json`: one app's map (the topology manifest).

Section 8 defines how an app built with the `agentlab` library reports all of this over OpenTelemetry, with its map derived from its code and attached to every run.

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

- **Register** (the app, at its startup): `PUT /apps/<app_id>` with `{"topology": <map>, "story": "<js source>" | null}`. The bench validates the map, keeps it (under `data/apps/`, so a restart doesn't forget it) and serves the story at `/apps/<app_id>/story.js`. Re-registering replaces both; `"story": null` removes the story. This is the only way app-specific material reaches the bench. At startup the bench reloads every stored map; one that no longer validates (e.g. after a schema change) is skipped with a warning on stderr naming the map and its first error. This is the **declared-map tier**, for apps with no Agent Lab library (today, TypeScript apps): supported and not deprecated. An app using the library never registers; each run carries its own map (section 8.5).
- **Ingest:** `POST /ingest` with one event or a JSON array of events, `Content-Type: application/json`. The receiver validates each against the schema and answers `{"accepted": n, "rejected": [{"index": i, "error": "..."}]}`. One bad event does not reject the batch. An aliased `event_type` (`check`) is renamed to its standard name (`check_result`) before validation, so the log and `/stream` carry only the standard name. Recordings and postMessage events don't pass through the receiver; they should use `check_result`, and the viewer accepts the alias there too.
- **OTLP ingest:** `POST /v1/traces[?session_id=<id>][&app=<app_id>]`: OTLP/HTTP, **protobuf** (`application/x-protobuf`, the exporters' default) or **JSON**, either one optionally `Content-Encoding: gzip` (the 5 MB limit applies after decompression). Ids may be hex or base64. Point an OTLP exporter's endpoint at the bench's base URL (`OTEL_EXPORTER_OTLP_ENDPOINT`; with `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, since Python's auto-configuration otherwise defaults to gRPC). App = `?app=` > resource `service.name`; it selects the map whose `node_from` maps spans to nodes. Session = `?session_id=` > header `x-agent-lab-session` > `bench.session_id` > `session.id` > `gen_ai.conversation.id`, resolved once per trace. A root span is a run; traces with no AI span are dropped. The response is an OTLP `ExportTraceServiceResponse` in the request's encoding, with `partialSuccess` when spans were rejected. Section 6b has the span mapping.
- **Live stream out:** `GET /stream?session_id=<id>&app=<app_id>` (SSE), both filters optional. Each message's `data:` is one event. After the backlog (what the receiver already had), one named event `caught_up` marks where live begins; the viewer shows what came before it at once instead of pacing it out as if it were running. `app` keeps out runs known to belong to another app (an OTLP run's app is its `service.name`; a native run's is `run_started.data.app`, if sent); a run whose app is unknown passes. Without filters the stream carries everything (local use only).
- **Maps:** `GET /topology/<app_id>`: for an app whose runs carry their own map (section 8), the map its latest run carried; else the registered one (404 for neither; with `?missing=null`, a 200 `null`, which the viewer uses at Level 0). `GET /maps/<hash>`: the map a run carried, by `run_started.data.map_hash`. `GET /topologies` lists apps whose runs carry maps (with `map_hash`), then registered apps, then apps that have sent runs with neither, marked `"inferred": true`. `GET /runs` gives each run's `map_hash` when it has one.
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

One per app, owned by the app and registered by it. It lets the bench draw the whole graph before anything runs, so a branch that is never taken still shows as a box that stayed dark. The bench's own example is `examples/hello-agent.topology.json`; trimmed:

```json
{
  "v": "bench-topology/0",
  "app": { "id": "hello-agent", "name": "Hello agent (synthetic example)",
           "track_record": "A made-up example: it has never been tested on real requests." },
  "nodes": [
    { "id": "triage", "label": "triage", "plain_label": "Decide who handles it", "kind": "llm",
      "description": "The AI reads the message and decides: answer it from the help docs, or hand it to a person.",
      "moment": true },
    { "id": "lookup", "label": "look up docs", "plain_label": "Look up the help docs", "kind": "retrieval",
      "actor": "rule", "description": "A search, not the AI, picks the help-doc pages that best match the message." },
    { "id": "answer_check", "label": "answer check", "plain_label": "Check the answer", "kind": "check",
      "description": "Code, not the AI, checks that the answer only uses steps from the pages it was given.",
      "moment": true },
    { "id": "escalate", "label": "escalate", "plain_label": "A person takes over", "kind": "gate" }
  ],
  "edges": [
    { "from": "triage", "to": "lookup", "from_branch": "answerable",
      "description": "It decided the help docs already answer this." },
    { "from": "triage", "to": "escalate", "from_branch": "needs_human",
      "description": "It decided a person must handle this. The AI won't act on it." }
  ],
  "sources": [
    { "id": "docs", "title": "Help docs", "kind": "documents", "count": 12,
      "description": "The only pages it can look things up in. It can't see your account, your billing or your messages.",
      "items": [{ "id": "doc-1", "title": "Signing in" }, { "id": "doc-3", "title": "Resetting your password" }] }
  ],
  "never": ["Change a password or email itself"],
  "panels": [
    { "id": "triage", "title": "Triage (story panel)", "event_types": ["decision"], "nodes": ["triage"], "story": true },
    { "id": "llm", "title": "Model calls", "event_types": ["llm_call"], "mode": "append", "audience": "engineering" }
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
| `actor` | Who does the step: `ai`, `rule`, `person`, `app`. Default from `kind`: `llm`→`ai`, `gate`→`person`, `check`→`rule`; anything else: `ai` if the run shows the step called the model, else `app`. |
| `description` | What the step does, in plain words: the node's note. |
| `moment` | Boolean. Replay's Play pauses here. With no `moment` declared anywhere, it pauses at decision nodes with branches, check nodes, gates and the outcome. |

**Edges**

| field | meaning |
|---|---|
| `from`, `to` | Required. |
| `from_branch` | The branch of `from` that selects this edge; drawn as the edge's label. An edge is *taken* when a `decision` on `from` reports that `branch`, or, when no branch is reported, when its two nodes ran one after the other. |
| `description` | What taking this branch means, in plain words. On an edge the run didn't take, it is the "why not taken" line. |
| `plain_label` | Optional. The branch in Presentation's words (e.g. `"needs a change"` for `needs_write`): the edge's label and the source box's "→" line. Without it, Presentation names the node the branch leads to. |

**Sources, actions, never** (what the app can see and do; every entry is the app's own statement and is shown attributed)

| field | meaning |
|---|---|
| `sources[]` | What the app can read: `{id, title, kind, description, count?, items?}`, the first four required. `kind` is open (`documents`, `database`, `api`, `inbox`, `message`, ...). `description` is the app's note, including what it can't see. `count` is how many items it holds. `items[]` is `{id, title}` only: **no item text in the map**; text reaches the bench only in `retrieval` hits. |
| `actions[]` | What the app can do in the world: `{id, title, description}`, all required. |
| `never` | `[string]`: what the app can never do, in plain words ("What it can never do (the app says)"). |

A source has three states in a run, each computed by the viewer from events, never declared: **could look at** (in the map); **given to the AI** (a `retrieval` hit from that source whose `text` appears in a later `llm_call`'s `system` or `messages` in the same run, by substring; when the prompt is redacted or has no text, the viewer falls back to "found by the search", and may use `llm_call.context_items` as a labelled hint; a hit whose text is masked whole, under 12 characters once placeholders are taken out, is never matched, and with nothing to check against the "given" count is shown as not known, never as 0); **relied on** (an item id in a `check_result.evidence` or a `decision.cited`). Item ids are matched against `retrieval` hits' `id`.

**Panels**

The instrument panels beside the graph. Each collects the listed event types (optionally only from the listed `nodes`), newest only (`mode: "latest"`, the default) or all (`"append"`). Three ways to draw one, in order of preference:
1. `"story": true`: the app's story draws it (section 5).
2. `fields`: a **declared panel**: only these data keys, in order, each with an optional `label` and `format` (`number:2`, `usd`, `ms`, `tokens`, `percent`, `json`, `quote`, ...). No code.
3. Neither: the bench's generic view of each event type.

A panel's `title` is Engineering's name for it. An optional `plain_title` is its heading in Presentation, in plain words, where it appears in the callout (section 4a); a panel without one shows there with no heading.

A panel drawn by 1 or 2 has a **raw** toggle that shows the generic view of every field, so a story never hides data. `audience` says which view mode shows the panel: `both` (default), `presentation` or `engineering` (section 4a). A panel's `mode` (latest/append) is unrelated to the view mode.

**Other**
- `node_from` (OTLP apps only): how to get a bench `node` from a span: `{"attribute": "<span attribute>"}` or `{"span_name": true}`. Without it, the node id is the operation plus the tool, agent or data-source name (section 6b).
- `story`: `true` when the app registers a story with its map (section 5); in a map built by the `agentlab` library, `{id, sha256}` naming the story file the run was built with (section 8.6).
- `app.baseline`, `app.io`, `nodes[].doc`, `nodes[].parent`, `nodes[].branches_unknown`, `derived`: written by the `agentlab` library (section 8.5).
- `app.io` (optional): which fields of the run's input and output a person reads: `{"request": "<input field>", "reply": "<output field>", "requester": ["<input field>", …]}`. The viewer shows that field of `run_started.data.input` as the request, of `run_finished.data.output` as the reply, and the requester fields joined with " · " as who asked. Without it (Level 0, an app with no library) the viewer guesses from field names (`message`, `text`, `reply`, `answer`, …); the guess is a fallback, never the way a library app is read.
- `check_words` (optional): a check's own words for its states, keyed by the check's `name` (as in `check_result`) or a `kind: "check"` node's id: `{"unsure": {"passed": "Didn't trigger", "failed": "Triggered: sent to a person"}}`, with any of `passed`, `failed`, `not_on_path`. The viewer uses them wherever that check's state shows (the callout, the recap, the node box), after the state's symbol; an event's `detail` follows as its own sentence. A state left out falls back to Passed / Didn't pass / Not needed this time. A node's `x-states` (a whole line per state) still wins for that node.
- **Extensions:** any key starting with `x-` is accepted, and ignored by the bench, at the top level and on `app`, nodes, edges, panels, sources (and their items) and actions. Any other unknown key is rejected, so a typo still fails loudly.
- Events whose `node` is not in the map still render, in an "unmapped" row, so a stale map never hides data.

### 4a. Presentation vs Engineering

The viewer has two modes over the same map and events. **Presentation** is for a room of non-engineers: plain labels and notes, what the app looked at, how it was checked, who signed off, and time, cost and baseline in words. It hides tokens, scores, ids, raw JSON, the event log, model ids, the run-id picker, redaction badges and the model's self-reported confidence, and shows only `both` and `presentation` panels. **Engineering** shows everything, every panel, raw toggles and the event log.

The mode is chosen in this order: the `?mode=presentation|engineering` URL parameter, then the viewer's remembered choice (localStorage), then the source's default: **Presentation** for a recording replay and for a parent (shell) source, **Engineering** for a live stream. A remembered value from the old view switch migrates: `overview`→`presentation`, `detailed`→`engineering`.

**Presentation's stage.** The map fills the left column and one callout explains one step at a time, with a wedge to the step it explains. The map is drawn by `viewer/layout.js` at `BenchLayout.STAGE_GEOM` (or `PANE_GEOM` at ≤1100 px; one column under 640 px) and fitted to its column; a geometry may set `lane` and `clear` (channel spacing and clearance). Steps carry their run-order number; a past step keeps one badge (the path a branching step took, a check's verdict, what a search found, or "– not needed"). The callout is a view model built only from the map's words and the run's events (`logic.callout`): the headline sentence, the paths out of a branching step as cards with the taken one lit, the reason and the cited items by title, the universal sources view on a search, the exact proposal at a gate, the checks in their own words, and on the last step the reply. **R** (or the step after the last) opens the recap (`logic.recap`): what it did, what it looked at, how it was checked, whether a person signed off, then the never list and the app's track record.

Details the viewer relies on:
- **Story panels in Presentation** are additive sections in the callout, under their `plain_title`, for the step they belong to (`nodes` if set, else any node whose events match the panel's types), below the generic evidence; they never replace it. Story and `fields` panels follow `audience` (default `both`); generic panels show only when explicitly `audience: "presentation"`.
- **The request and the reply.** The header shows who asked and the request; the last step's callout shows "What the person was told". A map that declares `app.io` (section 4) is read exactly: that field of the run's input, of its output, and the requester fields. A map that declares nothing falls back to field names (`message`, `text`, `query` …; `reply`, `response`, `answer` …), else the longest string; that guess exists only for Level 0.
- **Keys** (Presentation; the shell focuses the bench so a clicker works at once): → / Space / PageDown next step (from the last step, the recap); ← / PageUp back (out of the recap first); **Home** the first step; **End** the end; **M** the map alone (grown to the stage); **R** the recap; **?** the keys; Esc closes the overlay, the keys, the recap or the selection. Space is "next", not play/pause; ▶ plays. A step forward puts that step's events in at once and the stage's pacing draws them, so every press counts (two quick presses are two steps). In an open recap taller than the screen, the forward and back keys (and ↓ ↑) scroll it before they leave it.
- **Opening a recording** (replays): paused on its first step, with the key hint in the status; `&play=1` plays it. Deep links: `?at=<node id>` opens paused where that step stops (a gate at "waiting"), `?at=end` at the end; add `&recap=1` to open the recap. Picking another recording ("Try another") opens it at its own first step.
- **Who does a step:** the map's `actor`, else its `kind`'s default (section 4); a node with neither (an unworded library step) is the AI's when the run shows it called the model, else the app's. R11 applies only where the map says who does the step.
- **A search step** counts what all of its searches found, over every source it searched ("found 1 of 5 in 2 sources"), on its badge and in its callout.
- **The step cursor on a branching step** stops one event later than the step's own end, at the next step's `step_started`: the branch is derived from what ran next (section 8.6, A7), so the moment at a decision can show which path it took. The callout stays on the branching step; the next one is drawn "starting".
- **Parallel branches** (two branches from one step to the same next step, a many-to-one path map) are drawn as one line with both branches' words joined (`BenchLayout.edgeText`); the run's `decision.branch` says which one it took.
- **Maps per run (live).** On a live stream the viewer draws the current run with the map it carried (`run_started`/`run_updated` `data.map_hash`, fetched once per hash from `GET /maps/<hash>`), so two code versions can be live at once and a run that carries a map replaces an inferred one. A map that names its story by hash loads it from `GET /apps/<id>/story.js?sha256=…`; when the bench won't serve it, Engineering's "Checks on this map" shows the bench's reason (`X-Agent-Lab-Story`) and the generic views render. A recording's header carries its run's map and story.
- **Checks on this map** (Engineering): section 8.6.
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
    // (section 4a), so one panel can render two ways. ctx.topo: the run's map, so words the
    // map already has (an edge's plain_label, a source item's title) are read, not retyped.
    // Return HTML. In Presentation a panel adds to the generic callout: return "" when it has
    // nothing to add for this step.
    '<panel id>': function (events, ctx) { return '...'; }
  },
  renderers: {
    // Optional: this app's view of one event type, used wherever the generic view would be.
    // Receives the same ctx, ctx.mode and ctx.topo included.
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
| any root span (no parent) | `run_started` (`data`: `label`, `via: "otlp"`, `app`, `input`) / `run_finished` (`outcome`). An `invoke_agent`/`invoke_workflow` root is only the run; any other root is the run and its first step. Its children still name it as `parent_step_id`; since it isn't a step, they are top-level steps (a `parent_step_id` nests a step only when it names another step of the run). `run_started` usually arrives last: the viewer sorts by `ts`, then `seq`. |
| a trace with no span carrying `gen_ai.*`, `llm.*`, `openinference.*` or `traceloop.*` attributes | dropped (not AI work) |
| node id (default) | `execute_tool {gen_ai.tool.name}`, `invoke_agent {gen_ai.agent.name}`, `retrieval {gen_ai.data_source.id}`, LLM ops `{op} {gen_ai.agent.name}` or `{op}`; never the model. A map's `node_from` wins; `{"span_name": true}` restores span names. These are the ids a Level 1 map must use: the event log shows them, and an inferred map uses them unchanged (it folds only a model name after an LLM op, as in a span named `chat gpt-4o`). Engineering's "⤓ map as topology.json" downloads the inferred map as a starting file. In Presentation an inferred node is named from its operation (`execute_tool search_handbook` → "Tool: search handbook", `retrieval handbook` → "Search: handbook", `chat` → "AI: chat", `invoke_agent x` → "Agent: x"), with the raw id as its small technical label. |
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
| `agentlab.*` attributes, events and the manifest span (the `agentlab` library) | section 8.6: such spans are read by run (`agentlab.run`), not by trace |

The conventions define **no cost attribute**. If the span carries `gen_ai.usage.cost` (the attribute Langfuse reads; exporters typically set it only when the backend reported a cost), the adapter uses it as `cost_source: "actual"`. Otherwise the call carries no cost: the bench ships no price table (prices change faster than a checked-in table), so the viewer shows such a call's cost as **unknown**, never as zero. The adapter can price calls when given a `price(model, in, out, cache_read, cache_write)` function, and then says so in `cost_basis`; the receiver doesn't pass one today. OTLP/JSON quirks the adapter handles: 64-bit ints and nanosecond timestamps arrive as strings, attributes are `{key, value: {stringValue | intValue | doubleValue | boolValue | arrayValue}}`, and ids are hex strings (protobuf ids are decoded to hex too).

## 7. What v0 leaves out

- Auth, multi-user, retention: local only.
- Metrics and aggregation across runs (cost per day, p95 latency). The bench shows runs; evals stay in each app.
- Writing back to the app. Read-only by design.
- Forwarding to other backends (Langfuse, Logfire, Phoenix...): an OpenTelemetry Collector in front of both does this (README, "What it isn't"), so the bench never sits on the path to a team's real tracing. On the roadmap's Later list.
- Reading Agent Spec flow files directly as maps: the vocabulary is aligned, the importer isn't written.
- Streaming chunk rendering beyond appending text; no app sends `chunk` yet.

## 8. Agent Lab on OpenTelemetry (the `agentlab` library)

Status: **draft, 10-03-26.** The Python library (`sdk/python`, import name `agentlab`, 0.1.0) writes everything in this section. The bench reads all of it (8.6): the live receiver and `bench.record` run the same reader, `adapters/otlp.py`.

The library is how an app shows up on the bench without typing anything twice: its **structure** (steps, branches) is derived from the framework's own graph, its **facts** (decisions, checks, gates, documents) are reported by one line where each is produced, and its **words** (plain labels, descriptions, check wording) sit next to the code and are **verified** against the structure. Everything travels as ordinary OpenTelemetry spans, so it also reaches any other OTel backend the app uses. The names below are the contract between the library and the bench; `sdk/python/agentlab/_semconv.py` is the one place the library spells them.

### 8.1 Setup and transport

- `agentlab.init(endpoint=None, *, service_name=None, tracer_provider=None, redact=None, price=None, price_basis=None, capture_content=True)`, once at startup. Never raises; a second call with equal arguments does nothing, with different ones it logs a warning and is ignored.
- **Endpoint:** the argument, else env `AGENT_LAB_URL`, else the local bench `http://127.0.0.1:8790`. `AGENT_LAB_URL=off` (or empty, `0`, `false`, `no`, `none`) turns export off. A developer running the app and the bench on one machine sets nothing; the variable is needed only when they run on different machines.
- **Export:** OTLP/HTTP protobuf to `{endpoint}/v1/traces`, batched with a 200 ms delay. While nothing is listening on the endpoint's port, batches are dropped (checked from the export thread, rechecked every 5 s), so a closed bench never slows the app or fills its logs. For the default local bench that is silent (one debug line): not running it is normal. For a configured endpoint (the argument or `AGENT_LAB_URL`) it logs one warning, because spans someone asked for are being lost.
- **Provider:** by default a private `TracerProvider` that is **never** set as the global one: Agent Lab's spans go only to the bench, and nothing is added to the app's own pipeline. `tracer_provider=<SDK provider>` or `"global"` (the current global SDK provider; anything else falls back to private with a warning) shares the app's provider instead: the bench exporter and the stamping processor (8.3) are added to it, so Agent Lab's spans also reach the app's other backends and the app's other spans reach the bench. `service_name` sets the private provider's resource `service.name` only when `OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES` don't.
- **Off:** with no `init`, or `init` with export off and no shared provider, every helper returns after one flag check. `corpus()` is the exception: it always records (an index is often built before `init`), costing one pass over its items.
- **Never raises:** every public function except `verify` and `lock` catches everything, logs once per (function, reason) at debug level on the `agentlab` logger, and returns `None`.

### 8.2 Spans

Instrumentation scope `agentlab`, version = the library version. **Common attributes** on every Agent Lab span: `agentlab.app`, `agentlab.run`, `agentlab.node` (absent on run and manifest spans), `agentlab.kind`.

| span name | `agentlab.kind` | parent | attributes (beyond the common ones) |
|---|---|---|---|
| `agentlab.run {app_id}` | `run` | the app's current span, else none | `agentlab.content_mode` (`full` \| `redacted` \| `absent`), `agentlab.manifest.hash`, `agentlab.thread`, `agentlab.run.resume` (bool), `agentlab.run.status` (`ok` \| `error` \| `paused`), `agentlab.run.outcome`, `agentlab.run.input` (JSON, content), `agentlab.run.output` (JSON, content), `session.id` |
| `agentlab.manifest` | `manifest` | the run span | `agentlab.manifest` (the map, canonical JSON, 8.5), `agentlab.manifest.hash`, and the run's non-content facts again (`agentlab.content_mode`, `agentlab.thread`, `agentlab.run.resume`, `session.id`) so the bench knows them from the first batch. Started and ended at run start, on every invoke including resumes, so the map ships in the run's first export batch; the run span (exported last) carries only the hash. |
| `node {node_id}` | `node` | the run span, or the containing node's span (subgraphs) | `agentlab.step` (int, the framework's superstep), `agentlab.ns` (the framework's raw namespace). Status ERROR on an exception, except a gate's interrupt. |
| `chat {model}` | `chat` | its node span | GenAI: `gen_ai.operation.name = "chat"`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens` (**total**, cache included), `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.response.finish_reasons`; content: `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`. Plus `agentlab.request.json_schema` (the structured-output schema, JSON) when the framework exposes it, and `agentlab.cost.usd` (double) + `agentlab.cost.basis` when `init(price=…)` returned a number. |
| `retrieval {corpus}` | `retrieval` | its node span | `gen_ai.operation.name = "retrieval"`, `gen_ai.data_source.id`, `gen_ai.retrieval.query.text` (content), `gen_ai.retrieval.documents` (JSON `[{id, title?, score?, content?, …numeric extras}]`; `content` is content), `agentlab.corpus.hash` (the registered corpus's hash, when registered) |
| `execute_tool {tool}` | `tool` | its node span | GenAI: `gen_ai.operation.name = "execute_tool"`, `gen_ai.tool.name`, `gen_ai.tool.call.id`; content: `gen_ai.tool.call.arguments` (JSON), `gen_ai.tool.call.result`. Made by a framework integration from the framework's own tool callbacks (LangGraph: LangChain's `on_tool_start`/`on_tool_end`, e.g. every tool a `ToolNode` runs). |

`agentlab.content_mode` is a span attribute, not a resource attribute, because in shared mode the resource is the app's. The bench reads it as it reads `bench.content_mode`.

Estimated cost goes in `agentlab.cost.usd`, never in `gen_ai.usage.cost`, which the bench reads as a provider-reported (`actual`) cost (6b).

**Run identity.** A run is one fresh input to the app. Its id, `agentlab.run`, is `{thread_id}:{8 hex}` (just the hex with no thread), minted per fresh input and reused when the same thread resumes after a gate (`agentlab.run.resume = true` on the resume's run span). A resume whose thread this process never saw (a restart between pause and resume) gets a fresh id, still marked as a resume; the bench joins it (8.6).

**Node identity.** `agentlab.node` is the framework's node id; a subgraph's node is `container/inner`. With LangGraph: `langgraph_checkpoint_ns` split on `|`, each segment's `:<task id>` suffix dropped, joined with `/`.

**With LangGraph** (`agentlab.langgraph.instrument`, checked against LangGraph 1.2.12 and langchain-core 1.6.6 on 10-03-26):
- A **run** starts at the graph's own top-level `on_chain_start`. It is a resume when the input is `Command(resume=…)` or `None` (continue the thread, e.g. after an `interrupt_before` breakpoint); any other input, `Command(update=…)` alone included, is fresh. `agentlab.thread` and `session.id` come from the callback metadata's `thread_id` and `session_id`. LangGraph copies `configurable.thread_id` into that metadata but not `configurable.session_id`, so an app passes a session as `config["metadata"]["session_id"]`.
- A **node span** opens at the first `on_chain_start` whose run name equals `metadata["langgraph_node"]`, for a checkpoint namespace not already open in that run; a retried node gets one span per attempt. Model calls, tool calls and facts find their node by the namespace in their own metadata (facts: `langgraph.config.get_config()`), within their own run, so concurrent invokes and parallel branches never mix.
- **Pauses:** `GraphInterrupt` in a node's `on_chain_error` (sync and async) adds `agentlab.gate.waiting` once per interrupt id, on the innermost node; the container nodes and the run end with status UNSET. A static breakpoint (LangGraph's `on_interrupt` lifecycle callback, no node raising) sets `agentlab.run.status = "paused"` with no gate event. Any other `GraphBubbleUp` (e.g. a `Command` to the parent graph) is not an error.
- **Model calls:** `gen_ai.usage.input_tokens` is LangChain's `usage_metadata.input_tokens` as is: LangChain defines it as the total, and langchain-anthropic adds cache reads and writes back in. Cache reads are `input_token_details.cache_read`; cache writes are `cache_creation`, else the sum of the `ephemeral_*` keys (langchain-anthropic zeroes the generic key when it reports per-TTL ones). `agentlab.request.json_schema` comes from the `ls_structured_output_format` that `with_structured_output` binds, which LangChain passes to `on_chat_model_start` as `options`.
- An explicit `callbacks=[…]` passed to a model call inside a node replaces the run's callbacks for that call (LangChain's `ensure_config`), so Agent Lab can't see it; pass such handlers at graph invoke instead.

**Gates.** A run that pauses for a person gets `agentlab.gate.waiting` on the gate's node span (LangGraph: derived from the interrupt; elsewhere `gate_waiting()`), and `agentlab.run.status = "paused"`. The app reports the decision with `gate_resolved(approved, by=…)` after the resume.

**Stamping.** Any span that starts on Agent Lab's provider while a node is running, and lacks them, gets `agentlab.app`, `agentlab.run` and `agentlab.node`, so another instrumentor's spans (an HTTP client, a vector store) group under the right node. Outside a run nothing is stamped. Attributes stamped onto other instrumentors' spans pass through to every backend untouched.

### 8.3 Span events

On the running node's span (outside any run: OpenTelemetry's current span, if recording; else dropped). Each attribute is present only when given.

| event | attributes | written by |
|---|---|---|
| `agentlab.decision` | `agentlab.decision.reason` (content), `agentlab.decision.cited` (str[]: corpus item ids), `agentlab.decision.branch`, `agentlab.decision.confidence` (double) | `decision(reason, cited=, branch=, confidence=)` |
| `agentlab.check` | `agentlab.check.name`, `agentlab.check.passed` (bool), `agentlab.check.detail` (content), `agentlab.check.evidence` (str[]), `agentlab.check.kind`, `agentlab.check.words` (JSON `{passed?, failed?}`) | `check(name, passed, detail=, evidence=, kind=, words=)` |
| `agentlab.gate.waiting` | `agentlab.gate.proposed` (JSON, content), `agentlab.gate.reason` (content) | the integration, or `gate_waiting(proposed, reason=)` |
| `agentlab.gate.resolved` | `agentlab.gate.approved` (bool), `agentlab.gate.by`, `agentlab.gate.reason` (content) | `gate_resolved(approved, by=, reason=)` |
| `agentlab.event` | `agentlab.event.type`, `agentlab.event.data` (JSON, content) | `event(type, data)`: a bespoke fact a story renders |

`outcome(label)` sets `agentlab.run.outcome` on the run span; it is not an event. `retrieved(corpus, hits, query=)` makes a retrieval span (8.2), and `corpus(id, title=, items=, description=, kind=)` registers a corpus for the manifest (8.5).

**Which branch was taken.** `decision.branch` is optional: the bench derives the branch from what ran next (section 4's succession rule), which is unambiguous whenever each target of a node is reached by one branch. A node with a many-to-one path map must pass `branch=` (R5, R10).

### 8.4 Content and redaction

Content is anything derived from the user's input or the model's words: `agentlab.run.input`/`.output`, the chat span's system, input and output messages, the retrieval query and document text, `decision.reason`, `check.detail`, `gate.proposed`, `gate.reason` and `event.data`.
- `redact` (a function of one JSON-like value) is applied to each content value as Agent Lab emits it; `agentlab.content_mode = "redacted"`. If it raises, the value is dropped, never sent unmasked.
- The bench exporter also applies `redact` to other instrumentors' content attributes (the GenAI and OpenInference message, tool and document attributes, `input.value`/`output.value`) before they leave the process. A SpanProcessor can't do this: the SDK freezes a span's attributes before any processor sees its end. Masking another backend's copy is that backend's job (Langfuse `mask=`, OpenInference `TraceConfig`).
- `capture_content=False` emits no content at all; `agentlab.content_mode = "absent"`. Ids, titles, scores, counts and words still go.

### 8.5 The manifest (the map each run carries)

The manifest **is a `bench-topology/0` map** (section 4), built by the library from the framework's graph, the words, the app facts and the corpora; nothing in it is typed outside the app's code. The additive fields are in `schema/bench-topology.schema.json`: `app.baseline`, `app.io`; `nodes[].doc`, `nodes[].parent`, `nodes[].branches_unknown`; `story` as `{id, sha256}`; and top-level `derived`:

```json
"derived": {
  "from": "langgraph", "library": "agentlab 0.1.0", "framework": "langgraph 1.2.12",
  "hashes": { "structure": "…", "words": "…", "corpora": "…" },
  "warnings": [ { "code": "R3", "severity": "error", "node": "router_x", "message": "branches unknown: add a path_map or a Literal return type" } ],
  "fingerprints": { "node:classify": "confirmed", "paths:classify": "changed" }
}
```

**Derivation.**
- **Nodes:** the framework's nodes, minus its start and end markers (an Agent Spec flow keeps its `StartNode`/`EndNode`s: they run; see the Agent Spec bullet below). `label` = the id's last segment with `_` as spaces, unless the framework's definition names its nodes (Agent Spec: the component's `name`). `plain_label`, `moment` and `x-not-needed` come only from the step's words (`@step(label, says=, moment=, not_needed=)`); `description` comes from the words' `says`, else from the definition's own node description (Agent Spec). `doc` = the node function's own docstring (Engineering's description; Presentation never shows it). `kind` = the words' `kind`, else from their `actor` (`ai`→`llm`, `person`→`gate`, `rule`→`check`, else `step`), else `terminal` when every exit goes to the end, else `step`. `actor` = the words' `actor`, else the definition's, else what the `kind` implies (`llm`→`ai`, `gate`→`person`, `check`→`rule`); otherwise it is left out and the viewer reads it from the run (section 4a), so a zero-word hookup never says "the app" did a step that called the model. A subgraph's node has id `container/inner` and `parent`.
- **Edges:** the framework's plain edges, minus edges from the start and edges to the end; then every branch of every conditional edge (`from_branch` = the branch label as a string, `True`/`False` for booleans; every label kept, many-to-one included) and every `Command` destination (`from_branch` = the target id). A branch to the end goes to a synthesized node `__end__` (`label: "end"`, `kind: terminal`). A node whose branches the framework can't list gets `branches_unknown: true` and no branch edges (R3). An edge's `plain_label`/`description` come from `@step(paths={branch: path(label, says=)})` on its source.
- **Sources:** one per registered corpus (filtered by `instrument(corpora=)`), `count` = its items, items `{id, title}` only. Taken as the corpora are when each run starts.
- **App, actions, never:** from `App(...)`; `never` = `Never.words[t]` for each `t` in `Never.types`, in order. `app.id` = `App.id`, else the resource's `service.name`, else from `App.name` (lowercased, other characters as `-`). `app.io` = `App(request=, reply=, requester=)`, field names of the graph's own input and output state (LangGraph: `get_input_jsonschema()` / `get_output_jsonschema()`), each checked by R15; written only when declared.
- **Panels:** the story's panels in order, then the generic `llm` (`llm_call`), `tools` (`tool_call`) and `errors` (`error`) panels (`mode: append`, `audience: engineering`) unless a story panel has the same id.
- **Story:** `{id: app.id, sha256: <the story file's sha256>}`. The story's JS never travels over telemetry (8.6).
- **From an Open Agent Spec flow** (`agentspec.manifest_from(path)` in the library, `derived.from: "agentspec"`, `framework: "agentspec <agentspec_version>"`): the flow file is the structure. Nodes are the flow's nodes, with id = the component `id` (the node name pyagentspec's LangGraph loader gives each node at runtime) and a `FlowNode`'s subflow as `container/inner`. `label`, `description`, `kind` and `actor` come from the component's `name`, `description` and `component_type` (`LlmNode`/`AgentNode` → `llm`/`ai`; `ToolNode`/`ApiNode` → `tool`/`app`; `BranchingNode` → `step`/`rule`; `InputMessageNode` → `gate`/`person`; `EndNode` → `terminal`; anything else `step`/`app`); step words given with `steps=` override them. Control-flow edges keep their `from_branch` (null = the node's `next` branch); a node whose only branch is `next` gets plain edges. A file error is R14. Agent Spec Tracing is not read: it is an in-process span API, not OpenTelemetry (roadmap).

**Hashes.** sha256, hex, over the canonical JSON encoding: `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")`.
- `structure`: `{"nodes": [{id, parent?, branches_unknown?}], "edges": [{from, to, from_branch?}]}`, each list sorted by its items' canonical encoding (declaration order doesn't move it).
- `words`: the authored inputs: `{"app": {name, description, privacy_note, track_record, baseline}, "io": app.io (only when declared), "steps": {node_id: the step's words with its paths}, "docs": {node_id: docstring}, "actions", "never", "panels": the story's panels, "story": the story file's sha256}`, plus `"node_facts": {node_id: {label?, description?, kind?, actor?}}` only when the framework's definition names and types its nodes (Agent Spec), so a LangGraph map's hash is unaffected.
- `corpora`: the manifest's `sources` list.
- `agentlab.manifest.hash`: the whole manifest (`derived` included), so a receiver recomputes it over the parsed JSON. The manifest JSON on the wire is that same canonical encoding.

The full manifest is sent on every invoke; there is no send-once-per-hash optimization, because a restarted bench can't ask for a map it lost.

### 8.6 How the bench reads it

| span / event | bench event |
|---|---|
| the run's first span to arrive (normally the manifest span) | `run_started` (`node: "_run"`; `data`: `via: "agentlab"`, `app`, `thread`, `map_hash` or `map_error`, and `input` when the run span is already there) |
| run span | `run_updated` (`node: "_run"`) with what `run_started` lacked (`input`; a `map_hash` that came late), then, unless `paused`, `run_finished` (`status`, `outcome`, `output`, `latency_ms`, `baseline` from the manifest's `app.baseline`) |
| node span | `step_started` / `step_finished` with `node` = `agentlab.node`; an error status adds an `error` event |
| `agentlab.decision` | `decision` (`rationale`, `cited`, `branch`, `confidence`) |
| `agentlab.check` | `check_result` (`name`, `passed`, `state`, `detail`, `evidence`, `kind`, `words`) |
| `agentlab.gate.waiting` / `.resolved` | `gate_waiting` (`proposed`, `reason`) / `gate_resolved` (`approved`, `by`, `reason`) |
| `agentlab.event` | an event of type `agentlab.event.type` with `agentlab.event.data` as its data |
| chat span | `llm_call` (6b), plus `params.json_schema` from `agentlab.request.json_schema`, and `cost_usd` + `cost_source: "estimated"` + `cost_basis` from `agentlab.cost.usd` and `agentlab.cost.basis` |
| retrieval span | `retrieval` (6b), plus `corpus_hash` (`agentlab.corpus.hash`) and `stale_index: true` when it differs from the sha256 of that source's entry in the run's map |
| any other span carrying `agentlab.node` (another instrumentor's, stamped) | its content events (6b: `llm_call`, `tool_call`, `retrieval`, `check_result`, `error`) on that node's step; never a step of its own |

`run_updated` exists because a run's input travels on its run span, which ends last, while the map ships first so a live screen can draw it at once. The viewer merges it into `run_started`; `bench.record` folds it in, so recordings never contain it. A model call or search is content of its node's step (`step_id` = the node span's), not a nested step.

- **The run is the `agentlab.kind = run` span, not the trace's root.** With the default private provider the run span's parent is often the app's own span (an HTTP request), which goes to the app's provider and never reaches the bench, so the run span arrives with a `parentSpanId` the bench will never see. The bench identifies runs by `agentlab.kind`/`agentlab.run`, never by rootness.
- **Grouping:** any span carrying `agentlab.node` belongs to that node, whatever its parent. A span belongs to run `agentlab.run` when present, else to its trace. `seq` and run state are kept per run id. A second run span for a known run id is a continuation: no second `run_started`. A run span with `agentlab.run.resume = true` whose run id is unknown joins the most recent `paused` run of the same `agentlab.app` and `agentlab.thread`; with none, it is its own run. Run-level facts (`agentlab.app`, `agentlab.thread`, `agentlab.run.resume`, `agentlab.content_mode`, `session.id`) are read from any span of the run, first seen wins, across the whole request before any event is made, so the order spans arrive in within a request changes nothing. `agentlab.content_mode` overrides content detection exactly as `bench.content_mode` does. `agentlab.` counts as AI work (6b), so a trace holding only Agent Lab spans is kept.
- **A trace that holds an Agent Lab run** (shared provider: the app's own spans reach the bench too): its other AI spans join that run under their own node (6b's node rules); its spans that are not AI work (the app's HTTP handler around the run) are dropped, never a second run.
- **A gate is one step.** A node span carrying `agentlab.gate.waiting` gets no `step_finished` (the step is open while it waits); the resume's re-run of that node continues the same step (no second `step_started`, the same `step_id`), and its `step_finished.latency_ms` is the work before and after the pause, not the wait.
- **Maps per run:** on a manifest span the bench recomputes the hash over the parsed JSON. A match is stored once per hash and served at `GET /maps/<hash>`; `run_started.data.map_hash` names it, and the viewer draws each run with its own map (two code versions can be live at once). A mismatch or unparseable manifest (e.g. cut by `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`), or one that isn't a valid map, is R13: `run_started.data.map_error` says why and the run uses the trace-inferred map, never a half-parsed one. Stored maps (`data/maps/<hash>.json`; `BENCH_DATA_DIR` moves all of `data/`, `BENCH_MAPS_DIR` just the maps) are re-checked against their name when read back.
- **Stories:** never read from telemetry. `AGENT_LAB_STORIES="<app_id>=<path>[;…]"` names trusted story files; `GET /apps/<app_id>/story.js[?sha256=<the run's story.sha256>]` serves one only when its sha256 equals the run manifest's `story.sha256` (without `?sha256=`, the app's latest run's), else a 404 whose `X-Agent-Lab-Story` header says why ("story file differs from the one this run was built with", or that no file is trusted), and the generic views render. With `AGENT_LAB_STORIES_DEV=1` (writing a story) a trusted file that differs is served anyway, with the header saying so (Engineering shows it as info); `bench.record` always enforces the hash.
- **Files:** `uv run python -m bench.record --otlp <file.json> --out <dir> --name <stem> [--title …] [--group …] [--stories <app_id>=<path>] [--t0 <unix seconds>] [--regen-id …]` turns an OTLP/JSON request (what the library's `testing.to_otlp_json` writes) into one recording per run (`<stem>`, or `<stem>-1`, `-2`, … for several) through the same reader. Header: the run's own verified map, the trusted story it names (sha256-checked), `title`, `group`, `regen_id`. Stable for diffs: `run_id` = the stem, `step_id` = `<run_id>:<node>:<n>`, `session_id` = `"recording"`, `ts` moved so the first event is `--t0`. It writes nothing and exits 1 when a run has no usable map, a named story is missing or differs, or an event doesn't validate.
- **Ids:** span and trace ids are read as hex whether they arrive as hex (OTLP/JSON) or base64 (protobuf's JSON mapping), so both encodings give the same `step_id`s.
- **The declared-map tier stays.** `PUT /apps` with a hand-written map (section 3) remains supported, documented and not deprecated, for apps with no library (today: TypeScript apps). A run that carries its own map is drawn with it, not with a registered one; the bench logs one line when an app does both. `POST /ingest` remains the documented low-level path for native senders and tests. The library uses neither.
- **Checks on this map** (Engineering): the viewer's `mapChecks(map, events)` (`viewer/logic.js`) lists the map's `derived.warnings` (R0–R6, R12, from the app's own `verify`), then R7–R11 computed from the run's events and R13 from `map_error`; errors first. R7–R11 need a map the app stands behind, so a trace-inferred map gets none.

**Node identity without the library (Level 0).** For spans from other instrumentors, the node is the first present of: `agentlab.node`; `langsmith.metadata.langgraph_node`; `langfuse.observation.metadata.langgraph_node`; OpenInference's `metadata` attribute (a JSON string) and its `langgraph_node` key; OpenLLMetry's `traceloop.association.properties.langgraph_node`. The last two were seen on 10-03-26 (openinference-instrumentation-langchain 0.1.78, opentelemetry-instrumentation-langchain 0.62.4, LangGraph 1.2.12: a two-node graph with a fake chat model): each puts the key on both the node's span and the model call's span. Both also carry `langgraph_checkpoint_ns` (OpenInference inside `metadata`, OpenLLMetry as `traceloop.association.properties.langgraph_checkpoint_ns`); where it is present, the node is derived from it by the rule above, so a subgraph's node is `container/inner`, not the bare inner name.

### 8.7 Verification

`agentlab.verify(graph, strict=False)` runs in an app's tests (`python -m agentlab verify MODULE:FACTORY [--strict]` in CI). It raises `VerificationError` (an `AssertionError`) listing every **error**; with `strict=True` it also raises on R6. Every finding also goes into the manifest's `derived.warnings`, and the bench adds the runtime rules per run. Engineering shows them all in one list: errors red, warnings amber, info plain.

| rule | severity | where | what |
|---|---|---|---|
| R0 | error | verify | A worded value the map can't hold: an `actor` or `kind` outside its set (the value is left out), an `App.id` that isn't a valid app id (it is slugged), a story file that can't be read. |
| R1 | error | verify | A `steps=` key, `Story.reads` id or `Panel.nodes` id that is not a node id; or one node worded in both `@step` and `steps=`. |
| R2 | error | verify | A `paths` key that is not a branch id of that node. |
| R3 | error | verify | A node whose branches are unknown (an untyped router, `Send`, an unannotated `Command`): "branches unknown: add a path_map or a Literal return type". |
| R4 | error | verify | `never(types, words=)`: words missing for a type, or words for a type the list doesn't have. |
| R5 | info | verify | A many-to-one path map: that node must pass `decision(branch=…)`. |
| R6 | warning | verify | A fingerprint is `changed`: the code a wording describes changed since `lock` last confirmed it. |
| R7 | warning | bench | An event or stamped span names a node not in the manifest (also the "unmapped" row). |
| R8 | error | bench | `decision.branch` is not a branch of its node. |
| R9 | warning | bench | `decision.cited` / `check.evidence` ids in no corpus; a retrieval's corpus not in `sources`; `agentlab.corpus.hash` ≠ that source's hash in the manifest ("stale index": the index was rebuilt elsewhere). |
| R10 | warning | bench | A run took a many-to-one branch with no `decision.branch` (edge not lit; shown as ambiguous). |
| R11 | warning | bench | A node the map says is done by a rule or the app (its `actor`, or a `kind` that implies it) made a model call. A node the map says nothing about isn't flagged. |
| R12 | info | verify | A node or branch with no words; fingerprints `unconfirmed`. |
| R13 | error | bench | The manifest's hash doesn't match its content (8.6). |
| R14 | error | verify | The framework's own definition is wrong (Agent Spec today): a control-flow edge leaves from a branch its node doesn't declare, two edges leave one branch, or an edge names a node its flow doesn't list. The edge is still drawn (or, when its node is missing, left out). |
| R15 | error | verify | `App.request`, `App.reply` or an `App.requester` field is not a field of the graph's input (request, requester) or output (reply) state. Not checked when the framework can't list its state's fields. |

**Fingerprints.** Verification is referential: it proves every word names something the code has. It can't prove a word still describes what the code does, so it flags change for a person to re-confirm. The lock file (`agentlab.lock.json`, checked in, named by `instrument(lock=)`) is `{"v": "agentlab-lock/0", "fingerprints": {key: sha256}}` with, for each worded node, `node:<id>` = sha256 of the node function's source (dedented, trailing whitespace stripped), and for each node with worded paths, `paths:<id>` = sha256 of its routers' sources plus its canonical branch map. At `instrument` time each is `confirmed` (matches), `changed` (differs: R6) or `unconfirmed` (no lock, no entry, or no source available, e.g. a deploy without `.py` files). `agentlab.lock(graph)` / `python -m agentlab lock MODULE:FACTORY` rewrites the file: a deliberate act, like updating a snapshot, needed only after worded code changed.

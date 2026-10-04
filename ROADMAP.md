# Roadmap

Agent Lab: see inside any AI app while you use it. The bench sits beside an app and shows the flow it takes, the exact prompt the model got, what came back, and what it cost, on top of whatever tracing the app already uses.

Status: 0.1 pre-alpha. Items move as we learn; nothing here is a promise.

**v0.1** is a scenario that works (the Slack Helpdesk Agent), Bespoke, and the two modes, behind a front door that makes people want to play.

The idea it grows from: the bench is to an AI app what comments are to code. Comments explain code to whoever reads it next. An app's **notes** and **story** explain its runs to whoever watches them: plain notes on its steps and branches, and custom panels where plain data isn't enough.

## Now (the first public cut)

- [x] Rename to **Agent Lab** (singular); the repo is Agent Lab Bench (`agent-lab-bench`).
- [x] Front door: a dashboard of scenarios in the bench's own look, with live flows replaying real runs. The Slack Helpdesk Agent is featured, Bespoke sits beside it, and OpenTask is "coming soon". Each opens side by side. (In the lab site, not this repo.)
- [x] The Slack Helpdesk Agent, side by side on a static site: the app's replay drives the bench (postMessage sync).
- [x] Plain-language labels that keep the engineering look: each step's `plain_label` with the technical name small beneath it, a labelled final output ("What the person was told"), no ids on recordings in Presentation.
- [x] Node detail: clicking a step shows its note, what it did this run, and (in Engineering) its time, tokens, cost, input and output.
- [ ] Deploy at agentlab.trentmcnitt.com.
- [x] License: FSL-1.1-ALv2 (Functional Source License; each version becomes Apache 2.0 after two years).

## Next

- [x] Two modes: **Presentation** (plain words, what it looked at, how it was checked, who signed off, step-through with auto-pauses; anyone can drive it) and **Engineering** (every field, ids, the event log). `?mode=` picks one.
- [x] Notes: a plain-language `description` on each step and branch, declared in the map (the comment equivalent), including why a branch wasn't taken.
- [x] Sources and checks: what the app could look at, what it was given and relied on, and which checks ran and passed.
- [x] Level 0: OTLP protobuf and gzip, a map inferred from the spans, verified with Pydantic AI and OpenInference (10-03-26).
- [ ] Edge routing in the flowchart: back edges (an agent loop) and long edges currently cut through boxes.
- [ ] A "rules say no" helpdesk recording: the permission check refusing a write. Needs one live run (a few cents).
- [x] The requester (name and role) on helpdesk runs, for the Presentation header: `App(requester=...)`, checked against the graph's state.
- [ ] Technical sub-labels under each step in Presentation: both non-technical testers wanted them hidden; the spec keeps them. Trent's call.
- [ ] Per-model cost breakdown when a run mixes models.
- [ ] Bespoke live mode on the site: replay by default, "try it yourself", a small model picker, per-visitor limits and a daily cap.
- [ ] OpenTask as a scenario.

## Later

- [ ] Scenario 2: an MCP server on the bench.
- [ ] Before and after: two architectures for the same job side by side (the common failure mode, then the fix), with the flow and the numbers changing between them.
- [ ] Forwarding to Langfuse, Logfire and Phoenix from the bench: an OpenTelemetry Collector fan-out does this today (README, "What it isn't"), and the bench should never sit on the path to a team's real tracing.
- [ ] A TypeScript library with the Python one's names, and a PyPI package for the Python one: Python apps depend on `sdk/python` by path for now; other languages use Level 0 or a declared map.
- [ ] Browser extension that puts the bench in the browser's side panel beside any web app tab, for live demos: it removes the iframe limit (apps that send `X-Frame-Options` or a strict CSP refuse the shell), and it can tag that tab's requests so the right person's runs reach the right screen automatically (today the app must carry the session id itself). Later, not now: it's a separate channel (store review, permissions), and recorded runs already cover most meetings.
- [ ] Live approve/deny at the gate during a replay: a recording can't change its ending, so today the paired recording ("See what happens if they deny ▸") shows the other outcome.
- [ ] Reading Agent Spec Tracing spans directly: Agent Spec runtimes reach the bench through their OTel export meanwhile.
- [ ] Vercel `ai.*` span aliases (OpenLLMetry's and OpenInference's LangGraph node keys are read since 10-03-26).
- [ ] A dated price table, so OTLP calls without a reported cost get an estimate instead of "unknown".
- [ ] Streaming (`chunk`) rendering.

## Done

- [x] Nothing hand-written can drift (10-03-26): the `agentlab` Python library sends each run's map, read from the app's own LangGraph graph, over OpenTelemetry; words sit next to the code and `lab.verify` checks them; facts come from one line where each is produced. The bench keeps every map by hash and draws each run with its own. An Open Agent Spec flow file is read as a map too.
- [x] Event format, map and schemas (v0), aligned with Open Agent Spec's edge vocabulary; opened 10-03-26 with `x-` extension keys, plain labels, actors, moments, sources, actions, `check_result` and baselines, all optional.
- [x] Receiver: register, ingest, OTLP/HTTP (protobuf or JSON, gzip, hex or base64 ids), live stream by session or app.
- [x] Viewer: flow with the path taken lit and paced, waterfall, Model I/O, stories, declared panels, raw toggles, event log.
- [x] Presentation mode: the map with one callout per step, the recap, "What the AI was given", time split, cost in words, step-through with auto-pauses, clicker keys and deep links.
- [x] Side-by-side shell, the "Open in Agent Lab" chip, postMessage sync for static sites, and "Step through it" after a live run.
- [x] Replay with original timing; self-contained recordings; static export.
- [x] The Slack Helpdesk Agent and the Bespoke playground registered, live and recorded, with prompts.
- [x] Tests: schema, receiver, OTLP, viewer logic (`node --test`), the story harness, and browser e2e (Playwright).

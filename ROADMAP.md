# Roadmap

Agent Lab: see inside any AI app while you use it. The bench sits beside an app and shows the flow it takes, the exact prompt the model got, what came back, and what it cost, on top of whatever tracing the app already uses.

Status: pre-alpha. Items move as we learn; nothing here is a promise.

**v0.1** is a scenario that works (the Slack Helpdesk Agent), Bespoke, and the two views, behind a front door that makes people want to play.

The idea it grows from: the bench is to an AI app what comments are to code. Comments explain code to whoever reads it next. An app's **notes** and **story** explain its runs to whoever watches them: plain notes on its steps and branches, and custom panels where plain data isn't enough.

## Now (the first public cut)

- [x] Rename to **Agent Lab** (singular); the repo is Agent Lab Bench (`agent-lab-bench`).
- [x] Front door: a dashboard of scenarios in the bench's own look, with live flows replaying real runs. The Slack Helpdesk Agent is featured, Bespoke sits beside it, and OpenTask is "coming soon". Each opens side by side. (In the lab site, not this repo.)
- [x] The Slack Helpdesk Agent, side by side on a static site: the app's replay drives the bench (postMessage sync).
- [ ] Plain-language labels that keep the engineering look: tokens called tokens, "Recording · finished", a labelled final output, no session name on recordings.
- [ ] Node detail: clicking a node opens its header (full name, time, tokens, cost, what it produced), then its input and output. Long labels wrap.
- [ ] Deploy at agentlab.trentmcnitt.com.
- [x] License: Apache 2.0.

## Next

- [ ] Two views: **Overview**, the presentation (flow, timeline, clicking a step for its explanation, time and cost, story panels, Model I/O; readable by anyone, impressive to engineers), and **Detailed**, the debugging tool (every field, ids, the event log, links into the backend's own trace in Langfuse and the others).
- [ ] Notes: a plain-language explanation on each step and branch, declared in the map (the comment equivalent), shown in Overview.
- [ ] Per-model cost breakdown when a run mixes models.
- [ ] Bespoke live mode on the site: replay by default, "try it yourself", a small model picker, per-visitor limits and a daily cap.
- [ ] A small client library (Python and TypeScript): register the map and story, send events, or configure OpenTelemetry. This is what makes plugging in nearly free.
- [ ] Forwarding: the same run sent on to Langfuse, Logfire, Phoenix, ..., so one run can be compared across backends.
- [ ] OpenTask as a scenario.

## Later

- [ ] Scenario 2: an MCP server on the bench.
- [ ] Before and after: two architectures for the same job side by side (the common failure mode, then the fix), with the flow and the numbers changing between them.
- [ ] Read Open Agent Spec flow files directly as maps.
- [ ] Streaming (`chunk`) rendering.
- [ ] Guided walkthroughs as part of a story: narrated steps through a run.

## Done

- [x] Event format, map and schemas (v0), aligned with Open Agent Spec's edge vocabulary.
- [x] Receiver: register, ingest, OTLP/HTTP JSON, live stream by session.
- [x] Viewer: flow with the path taken lit and paced, waterfall, Model I/O, stories, declared panels, raw toggles, event log.
- [x] Side-by-side shell, the "Open in Agent Lab" chip, postMessage sync for static sites.
- [x] Replay with original timing; self-contained recordings; static export.
- [x] The Slack Helpdesk Agent and the Bespoke playground registered, live and recorded, with prompts.

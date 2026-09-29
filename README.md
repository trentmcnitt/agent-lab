# Agent Lab Bench

Agent Lab Bench: see inside any AI app while you use it. A read-only, framework-neutral observability bench for agent apps. Any app that reports to it can be shown on it, whatever it's built with. The app registers its **map** (every step and possible branch) and, optionally, its **story** (custom panels that explain it). It then sends events. The bench draws the whole graph, lights the path each run takes, and fills the instrument panels, live or from a recording. Beside the app, in the side-by-side shell, you watch the app and what the AI inside it is doing at the same time.

The bench holds nothing app-specific: each app's adapter, map and story live in the app's own repo.

Status: v0, local only.

## Run it

- `uv run uvicorn bench.server:app --port 8790`, then open http://127.0.0.1:8790/. It lists the apps that have registered, plus recordings.
- Side by side: `http://127.0.0.1:8790/shell/?app=<app url>&appid=<app id>`. The shell passes `?bench_session=<id>` to the app, and the app stamps its events with it.
- An app hooks in by:
  1. `PUT /apps/<id>` with its map and story;
  2. `POST /ingest` with events, or pointing its OpenTelemetry exporter at the bench (`/v1/traces`).
- Static: `uv run python scripts/export_static.py [--recordings <dir>]` writes `dist/bench/`, replay only, servable from any subpath.
- The example: `examples/` holds a synthetic "hello agent" (map, story, two recordings); `examples/make_hello.py` rebuilds it.

## What's here

- `SPEC.md`: the event format, transport, maps, stories and adapters.
- `schema/`: JSON Schemas for one event and one map. The map's edges follow Open Agent Spec (`from_branch`).
- `bench/server.py`: the receiver (register, ingest, OTLP, SSE, recordings). `bench/send.py` replays a recording as live traffic.
- `viewer/`: the bench page. `shell/`: the side-by-side shell and the "Open in Agent Lab" chip (`shell/chip.js`).
- `adapters/otlp.py`: OTLP/HTTP JSON spans to bench events. App-specific adapters live in their apps.

`uv run pytest -q` validates the example and the OTLP adapter, and exercises every receiver endpoint.

## License

Functional Source License 1.1 with an Apache 2.0 future license (FSL-1.1-ALv2); see `LICENSE`. Free to use, modify and share for any purpose except a competing commercial product or service; each version becomes Apache 2.0 two years after its release.

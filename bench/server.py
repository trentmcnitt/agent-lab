"""The receiver: HTTP ingest in, SSE out, filtered by session_id (SPEC.md section 3).

Local only, no auth. Events are validated against the schema, kept in memory for late
viewers, appended to a JSONL log per day, and fanned out to every stream whose session
filter matches. The bench never calls back into an app, and holds nothing app-specific:
each app registers its own map and story (PUT /apps/<id>), kept under data/apps/ so a
bench restart doesn't forget them.

Run: uv run uvicorn bench.server:app --port 8790
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import zlib
from collections import defaultdict
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from adapters import otlp as otlp_adapter

ROOT = Path(__file__).resolve().parents[1]
EVENT_SCHEMA = Draft202012Validator(json.loads((ROOT / "schema/bench-event.schema.json").read_text()))
TOPO_SCHEMA = Draft202012Validator(json.loads((ROOT / "schema/bench-topology.schema.json").read_text()))
LOG_DIR = Path(os.environ.get("BENCH_LOG_DIR", ROOT / "data/log"))
APPS_DIR = Path(os.environ.get("BENCH_APPS_DIR", ROOT / "data/apps"))
# Recordings an app hands over (e.g. its demo runs) go here; the bench's own examples ship in examples/.
REC_DIR = Path(os.environ.get("BENCH_RECORDINGS_DIR", ROOT / "data/recordings"))
MAX_STORY = 512 * 1024
MAX_EVENTS = int(os.environ.get("BENCH_MAX_EVENTS", "50000"))
MAX_BODY = 5 * 1024 * 1024
# Accepted on ingest and stored under the standard name (SPEC.md section 2).
EVENT_ALIASES = {"check": "check_result"}
log = logging.getLogger("bench.server")


def _topo_error(topo: Any) -> str | None:
    """The first schema error in a map, with where it is, or None."""
    errs = sorted(TOPO_SCHEMA.iter_errors(topo), key=lambda e: list(e.absolute_path))
    if not errs:
        return None
    where = "/".join(str(p) for p in errs[0].absolute_path)
    return f"{where + ': ' if where else ''}{errs[0].message}"


class Store:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.topologies: dict[str, dict] = {}
        self.stories: dict[str, str] = {}
        self.subscribers: set[tuple[asyncio.Queue, str | None]] = set()
        self.otlp = otlp_adapter.TraceState()  # OTLP runs arrive over several requests
        self.load_apps()

    def load_apps(self) -> None:
        self.topologies.clear()
        self.stories.clear()
        for d in sorted(APPS_DIR.glob("*/")) if APPS_DIR.exists() else []:
            try:
                t = json.loads((d / "topology.json").read_text())
            except (OSError, ValueError) as exc:
                log.warning("skipping stored map %s: unreadable (%s)", d, exc)
                continue
            err = _topo_error(t)
            if err:
                log.warning("skipping stored map %s: %s", d, err)
                continue
            self.topologies[t["app"]["id"]] = t
            if (d / "story.js").exists():
                self.stories[t["app"]["id"]] = (d / "story.js").read_text()

    def register(self, topo: dict, story: str | None) -> None:
        app_id = topo["app"]["id"]
        d = APPS_DIR / app_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "topology.json").write_text(json.dumps(topo, indent=2))
        self.topologies[app_id] = topo
        if story is None:
            (d / "story.js").unlink(missing_ok=True)
            self.stories.pop(app_id, None)
        else:
            (d / "story.js").write_text(story)
            self.stories[app_id] = story

    def add(self, ev: dict) -> None:
        self.events.append(ev)
        if len(self.events) > MAX_EVENTS:
            del self.events[: len(self.events) - MAX_EVENTS]
        if LOG_DIR:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with open(LOG_DIR / f"{time.strftime('%Y-%m-%d')}.jsonl", "a") as fh:
                fh.write(json.dumps(ev) + "\n")
        for q, sid in list(self.subscribers):
            if sid is None or ev.get("session_id") == sid:
                q.put_nowait(ev)

    def backlog(self, sid: str | None) -> list[dict]:
        return [e for e in self.events if sid is None or e.get("session_id") == sid]


store = Store()


def _first_error(ev: Any) -> str | None:
    if not isinstance(ev, dict):
        return "event must be a JSON object"
    errs = sorted(EVENT_SCHEMA.iter_errors(ev), key=lambda e: list(e.absolute_path))
    if not errs:
        return None
    e = errs[0]
    where = "/".join(str(p) for p in e.absolute_path)
    return f"{where + ': ' if where else ''}{e.message}"


async def ingest(request: Request) -> Response:
    body = await request.body()
    if len(body) > MAX_BODY:
        return JSONResponse({"error": "body too large"}, status_code=413)
    try:
        payload = json.loads(body)
    except ValueError:
        return JSONResponse({"error": "body is not JSON"}, status_code=400)
    return JSONResponse(_accept(payload if isinstance(payload, list) else [payload]))


def _accept(events: list[dict]) -> dict:
    accepted, rejected = 0, []
    for i, ev in enumerate(events):
        if isinstance(ev, dict) and ev.get("event_type") in EVENT_ALIASES:
            ev = {**ev, "event_type": EVENT_ALIASES[ev["event_type"]]}
        err = _first_error(ev)
        if err:
            rejected.append({"index": i, "error": err})
        else:
            store.add(ev)
            accepted += 1
    return {"accepted": accepted, "rejected": rejected}


async def ingest_otlp(request: Request) -> Response:
    """OTLP/HTTP traces (POST /v1/traces): protobuf or JSON, optionally gzip-compressed.

    The app is `?app=`, else the resource's `service.name` (OTEL_SERVICE_NAME). The session is
    `?session_id=`, else the `x-agent-lab-session` header (OTEL_EXPORTER_OTLP_HEADERS), else the
    spans' `session.id`. A standard exporter can't add a query string to its endpoint, so the
    header and resource attributes are the zero-code path; the query parameters are overrides."""
    ctype = request.headers.get("content-type", "")
    proto = "protobuf" in ctype
    if not proto and "json" not in ctype:
        return JSONResponse({"error": "OTLP/HTTP protobuf or JSON only (Content-Type: application/x-protobuf or application/json)"},
                            status_code=415)
    raw = await request.body()
    if len(raw) > MAX_BODY:
        return JSONResponse({"error": "body too large"}, status_code=413)
    if request.headers.get("content-encoding", "").lower() == "gzip":
        d = zlib.decompressobj(wbits=31)
        try:
            raw = d.decompress(raw, MAX_BODY + 1)
        except zlib.error:
            return JSONResponse({"error": "body is not valid gzip"}, status_code=400)
        if len(raw) > MAX_BODY or d.unconsumed_tail:
            return JSONResponse({"error": "body too large"}, status_code=413)
    try:
        body = otlp_adapter.decode_protobuf(raw) if proto else json.loads(raw)
    except Exception:  # DecodeError from protobuf, ValueError from json
        return JSONResponse({"error": f"body is not OTLP {'protobuf' if proto else 'JSON'}"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "body is not an OTLP export request"}, status_code=400)
    events = store.otlp.ingest(
        body, app=request.query_params.get("app") or None,
        session_id=request.query_params.get("session_id") or request.headers.get("x-agent-lab-session") or None,
        node_from=lambda app_id: (store.topologies.get(app_id) or {}).get("node_from"))
    res = _accept(events)
    # OTLP exporters expect an ExportTraceServiceResponse, in their own encoding; partialSuccess reports drops.
    n, msg = len(res["rejected"]), (res["rejected"][0]["error"] if res["rejected"] else "")
    if proto:
        return Response(otlp_adapter.encode_response(n, msg), media_type="application/x-protobuf")
    out: dict = {}
    if n:
        out["partialSuccess"] = {"rejectedSpans": str(n), "errorMessage": msg}
    return JSONResponse(out)


async def stream(request: Request) -> Response:
    sid = request.query_params.get("session_id") or None
    backlog = request.query_params.get("backlog", "1") != "0"
    q: asyncio.Queue = asyncio.Queue()
    entry = (q, sid)

    async def gen():
        store.subscribers.add(entry)
        try:
            yield "retry: 2000\n\n"
            if backlog:
                for ev in store.backlog(sid):
                    yield f"data: {json.dumps(ev)}\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                if await request.is_disconnected():
                    break
        finally:
            store.subscribers.discard(entry)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def register_app(request: Request) -> Response:
    """PUT /apps/<id>  {"topology": {...}, "story": "<js source>" | null}. The app's own
    registration: its map, and optionally the story script that draws its custom panels."""
    app_id = request.path_params["app_id"]
    try:
        body = json.loads(await request.body())
    except ValueError:
        return JSONResponse({"error": "body is not JSON"}, status_code=400)
    topo, story = body.get("topology"), body.get("story")
    if not isinstance(topo, dict):
        return JSONResponse({"error": "topology is required"}, status_code=400)
    err = _topo_error(topo)
    if err:
        return JSONResponse({"error": f"topology {err}"}, status_code=400)
    if topo["app"]["id"] != app_id:
        return JSONResponse({"error": "app.id does not match the URL"}, status_code=400)
    if story is not None and (not isinstance(story, str) or len(story) > MAX_STORY):
        return JSONResponse({"error": "story must be a string under 512 KB"}, status_code=400)
    store.register(topo, story)
    return JSONResponse({"ok": True, "app": app_id, "story": story is not None})


async def get_story(request: Request) -> Response:
    s = store.stories.get(request.path_params["app_id"])
    if s is None:
        return Response("/* no story registered */", media_type="text/javascript", status_code=404)
    return Response(s, media_type="text/javascript", headers={"Cache-Control": "no-store"})


async def get_topology(request: Request) -> Response:
    t = store.topologies.get(request.path_params["app_id"])
    return JSONResponse(t) if t else JSONResponse({"error": "unknown app"}, status_code=404)


async def list_topologies(request: Request) -> Response:
    return JSONResponse([{"id": k, "name": v["app"]["name"], "story": k in store.stories}
                         for k, v in store.topologies.items()])


async def list_runs(request: Request) -> Response:
    sid = request.query_params.get("session_id") or None
    runs: dict[str, dict] = defaultdict(lambda: {"events": 0})
    for e in store.backlog(sid):
        r = runs[e["run_id"]]
        r["run_id"], r["session_id"] = e["run_id"], e.get("session_id")
        r["first_ts"] = min(r.get("first_ts", e["ts"]), e["ts"])
        r["last_ts"] = max(r.get("last_ts", e["ts"]), e["ts"])
        r["events"] += 1
        if e["event_type"] == "run_started" and e.get("data", {}).get("app"):
            r["app"] = e["data"]["app"]  # OTLP runs: which app sent them (service.name)
        if e["event_type"] == "run_finished":
            r["status"] = e["data"].get("status")
    return JSONResponse(sorted(runs.values(), key=lambda r: r["first_ts"]))


def recording_entry(prefix: str, p: Path) -> dict | None:
    """One picker entry: title from the header's app name plus the file name; the plain run
    picker (Presentation's "Try another request") also reads `app`, `plain_title` and `group`."""
    try:
        with open(p) as fh:
            head = json.loads(fh.readline())
    except (OSError, ValueError):
        return None
    is_head = head.get("v") == "bench-recording/0"
    app = ((head.get("topology") or {}).get("app") or {}) if is_head else {}
    name = app.get("name", "")
    entry = {"path": f"{prefix}/{p.name}", "title": (name + " · " if name else "") + p.name.removesuffix(".recording.jsonl")}
    if app.get("id"):
        entry["app"] = app["id"]
    if is_head and head.get("title"):
        entry["plain_title"] = head["title"]
    if is_head and head.get("group"):
        entry["group"] = head["group"]
    return entry


def recording_list() -> list[dict]:
    """Recordings the picker offers."""
    out = []
    for prefix, d in (("examples", ROOT / "examples"), ("recordings", REC_DIR)):
        for p in sorted(d.glob("*.recording.jsonl")) if d.exists() else []:
            if (entry := recording_entry(prefix, p)) is not None:
                out.append(entry)
    return out


async def recordings(request: Request) -> Response:
    return JSONResponse(recording_list())


async def index(request: Request) -> Response:
    return FileResponse(ROOT / "viewer/index.html")


app = Starlette(routes=[
    Route("/", index),
    Route("/ingest", ingest, methods=["POST"]),
    Route("/v1/traces", ingest_otlp, methods=["POST"]),
    Route("/stream", stream),
    Route("/runs", list_runs),
    Route("/topologies", list_topologies),
    Route("/topology/{app_id}", get_topology, methods=["GET"]),
    Route("/apps/{app_id}", register_app, methods=["PUT"]),
    Route("/apps/{app_id}/story.js", get_story),
    Mount("/viewer", StaticFiles(directory=ROOT / "viewer"), name="viewer"),
    Mount("/shell", StaticFiles(directory=ROOT / "shell", html=True), name="shell"),
    Route("/recordings.json", recordings),
    Mount("/examples", StaticFiles(directory=ROOT / "examples"), name="examples"),
    Mount("/recordings", StaticFiles(directory=REC_DIR, check_dir=False), name="recordings"),
])

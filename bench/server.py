"""The receiver: HTTP ingest in, SSE out, filtered by session_id (SPEC.md section 3).

Local only, no auth. Events are validated against the schema, kept in memory for late
viewers, appended to a JSONL log per day, and fanned out to every stream whose session
filter matches. The bench never calls back into an app, and holds nothing app-specific.
An app built with the `agentlab` library sends its map with every run (SPEC.md 8.6): the
bench verifies it, keeps it once per hash under data/maps/ and serves it at /maps/<hash>.
An app without the library registers a hand-written map and story (PUT /apps/<id>, the
declared-map tier), kept under data/apps/ so a bench restart doesn't forget them. Stories
for library apps never travel over telemetry: AGENT_LAB_STORIES names trusted files.

Run: uv run uvicorn bench.server:app --port 8790
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
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
from bench.stories import dev_mode, read_story, trusted_stories

ROOT = Path(__file__).resolve().parents[1]
EVENT_SCHEMA = Draft202012Validator(json.loads((ROOT / "schema/bench-event.schema.json").read_text()))
TOPO_SCHEMA = Draft202012Validator(json.loads((ROOT / "schema/bench-topology.schema.json").read_text()))
# Everything the bench keeps goes under one directory: BENCH_DATA_DIR (default: data/ in this
# checkout), so a separate project's runs can be kept apart. Each part can still be moved on its own.
DATA_DIR = Path(os.environ.get("BENCH_DATA_DIR", ROOT / "data")).expanduser()
LOG_DIR = Path(os.environ.get("BENCH_LOG_DIR", DATA_DIR / "log"))
APPS_DIR = Path(os.environ.get("BENCH_APPS_DIR", DATA_DIR / "apps"))
# Recordings an app hands over (e.g. its demo runs) go here; the bench's own examples ship in examples/.
REC_DIR = Path(os.environ.get("BENCH_RECORDINGS_DIR", DATA_DIR / "recordings"))
# Maps library apps sent with their runs, one file per hash (deduplicated across runs).
MAPS_DIR = Path(os.environ.get("BENCH_MAPS_DIR", DATA_DIR / "maps"))
MAX_STORY = 512 * 1024
MAX_EVENTS = int(os.environ.get("BENCH_MAX_EVENTS", "50000"))
MAX_BODY = 5 * 1024 * 1024
# Accepted on ingest and stored under the standard name (SPEC.md section 2).
EVENT_ALIASES = {"check": "check_result"}
log = logging.getLogger("bench.server")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")


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
        self.subscribers: set[tuple[asyncio.Queue, str | None, str | None]] = set()
        self.run_app: dict[str, str] = {}  # run_id -> app id, when known (OTLP: service.name; native: run_started.data.app)
        self.otlp = otlp_adapter.TraceState()  # OTLP runs arrive over several requests
        self.maps: dict[str, dict] = {}        # map hash -> a library app's map (also on disk)
        self.app_map: dict[str, str] = {}      # app id -> the map hash of its latest run
        self.run_map: dict[str, str] = {}      # run id -> its map hash
        self.story_files = trusted_stories()
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

    def app_of(self, ev: dict) -> str | None:
        if ev.get("event_type") == "run_started" and isinstance(ev.get("data"), dict) and ev["data"].get("app"):
            self.run_app.setdefault(ev["run_id"], str(ev["data"]["app"]))
        if ev.get("event_type") in ("run_started", "run_updated") and isinstance(ev.get("data"), dict):
            h = ev["data"].get("map_hash")
            if isinstance(h, str) and HASH_RE.match(h):
                self.run_map[ev["run_id"]] = h
                app = self.run_app.get(ev["run_id"])
                if app:
                    if app in self.topologies and app not in self.app_map:
                        log.info("app %s: its runs carry their own maps (agentlab), which the bench uses "
                                 "for those runs instead of the map it registered with PUT /apps", app)
                    self.app_map[app] = h
        return self.run_app.get(ev["run_id"])

    def add_map(self, h: str, manifest: dict) -> None:
        """A map a run carried, already verified against its hash by the adapter: kept once."""
        self.maps[h] = manifest
        try:
            MAPS_DIR.mkdir(parents=True, exist_ok=True)
            f = MAPS_DIR / f"{h}.json"
            if not f.exists():
                tmp = f.with_suffix(".tmp")
                tmp.write_text(json.dumps(manifest, ensure_ascii=False))
                tmp.replace(f)
        except OSError as exc:  # the map is still served from memory
            log.warning("couldn't store map %s: %s", h[:12], exc)

    def get_map(self, h: str) -> dict | None:
        if not HASH_RE.match(h or ""):
            return None
        if h in self.maps:
            return self.maps[h]
        try:
            m = json.loads((MAPS_DIR / f"{h}.json").read_text())
        except (OSError, ValueError):
            return None
        # A stored file is checked again: a map is used only when its content matches its name.
        if not isinstance(m, dict) or otlp_adapter.sha256_hex(m) != h:
            log.warning("stored map %s doesn't match its hash; not served", h[:12])
            return None
        self.maps[h] = m
        return m

    def story_for(self, app_id: str, want: str | None) -> tuple[str | None, str]:
        """A library app's story: the trusted file named for it in AGENT_LAB_STORIES, served only
        when its sha256 is the one the run's map was built with (`want`, else the app's latest
        map). Returns (source, why) — `why` says what went wrong when source is None."""
        path = self.story_files.get(app_id)
        if want is None:
            m = self.get_map(self.app_map.get(app_id, "")) or {}
            st = m.get("story")
            want = st.get("sha256") if isinstance(st, dict) else None
        if want is None:
            return None, "no story: this app's map names none"
        return read_story(path, app_id, want, dev=dev_mode())

    @staticmethod
    def matches(ev: dict, app_of: str | None, sid: str | None, app: str | None) -> bool:
        """A stream's filters. A run whose app isn't known (a native app that never names it)
        passes an app filter: the filter only keeps out runs known to be another app's."""
        return (sid is None or ev.get("session_id") == sid) and (app is None or app_of is None or app_of == app)

    def add(self, ev: dict) -> None:
        app_of = self.app_of(ev)
        self.events.append(ev)
        if len(self.events) > MAX_EVENTS:
            del self.events[: len(self.events) - MAX_EVENTS]
        if LOG_DIR:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with open(LOG_DIR / f"{time.strftime('%Y-%m-%d')}.jsonl", "a") as fh:
                fh.write(json.dumps(ev) + "\n")
        for q, sid, app in list(self.subscribers):
            if self.matches(ev, app_of, sid, app):
                q.put_nowait(ev)

    def backlog(self, sid: str | None, app: str | None = None) -> list[dict]:
        return [e for e in self.events if self.matches(e, self.run_app.get(e["run_id"]), sid, app)]

    def seen_apps(self) -> list[str]:
        """App ids that sent runs, registered or not (Level 0 apps never register)."""
        return sorted(set(self.run_app.values()))


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
    # Every event of an OTLP run knows its app now, though its run_started (the root span) comes last.
    store.run_app.update(store.otlp.take_run_apps())
    # Maps are kept before their runs' events go out, so a viewer that sees a map_hash can fetch it.
    for h, manifest in store.otlp.take_maps():
        store.add_map(h, manifest)
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
    app_id = request.query_params.get("app") or None
    backlog = request.query_params.get("backlog", "1") != "0"
    q: asyncio.Queue = asyncio.Queue()
    entry = (q, sid, app_id)

    async def gen():
        store.subscribers.add(entry)
        try:
            yield "retry: 2000\n\n"
            if backlog:
                for ev in store.backlog(sid, app_id):
                    yield f"data: {json.dumps(ev)}\n\n"
                # What came before this line already happened: the viewer shows it at once rather
                # than replaying it at the live pace (a named event, so older viewers ignore it).
                yield "event: caught_up\ndata: {}\n\n"
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
    if app_id in store.app_map:
        # Still accepted (the declared-map tier, SPEC.md section 3), but runs that carry a map use it.
        log.info("PUT /apps/%s: this app's runs carry their own maps (agentlab); the registered map is "
                 "used only for runs that don't", app_id)
    store.register(topo, story)
    return JSONResponse({"ok": True, "app": app_id, "story": story is not None})


async def get_story(request: Request) -> Response:
    """An app's story. A registered one (PUT /apps) as registered; a library app's from its
    trusted file, only when it is the file the run's map names (`?sha256=` picks the run;
    without it, the app's latest run)."""
    app_id = request.path_params["app_id"]
    want = request.query_params.get("sha256") or None
    if want is None and app_id not in store.app_map:
        s = store.stories.get(app_id)
        if s is None:
            return Response("/* no story registered */", media_type="text/javascript", status_code=404)
        return Response(s, media_type="text/javascript", headers={"Cache-Control": "no-store"})
    src, why = store.story_for(app_id, want)
    if src is None:
        return Response(f"/* {why} */", media_type="text/javascript", status_code=404,
                        headers={"X-Agent-Lab-Story": why})
    headers = {"Cache-Control": "no-store"}
    if why != "ok":                       # served anyway (dev mode): Engineering says so
        headers["X-Agent-Lab-Story"] = why
    return Response(src, media_type="text/javascript", headers=headers)


async def get_map(request: Request) -> Response:
    """A map a run carried, by its hash (run_started.data.map_hash)."""
    m = store.get_map(request.path_params["map_hash"])
    if m is None:
        return JSONResponse({"error": "unknown map"}, status_code=404)
    return JSONResponse(m, headers={"Cache-Control": "public, max-age=31536000, immutable"})


async def get_topology(request: Request) -> Response:
    """An app's map: the one its latest run carried (library apps), else the one it registered.
    `?missing=null` answers an unknown app with 200 null instead of 404, so a Level 0 viewer
    (which then infers the map) doesn't log a failed request."""
    app_id = request.path_params["app_id"]
    t = store.get_map(store.app_map.get(app_id, "")) or store.topologies.get(app_id)
    if t:
        return JSONResponse(t)
    if request.query_params.get("missing") == "null":
        return JSONResponse(None)
    return JSONResponse({"error": "unknown app"}, status_code=404)


async def list_topologies(request: Request) -> Response:
    """Registered apps, then apps that have sent runs without registering (`inferred: true`)."""
    out = []
    for a, h in store.app_map.items():
        m = store.get_map(h)
        if m is not None:
            out.append({"id": a, "name": m["app"]["name"], "story": store.story_for(a, None)[0] is not None,
                        "map_hash": h})
    listed = {e["id"] for e in out}
    out += [{"id": k, "name": v["app"]["name"], "story": k in store.stories} for k, v in store.topologies.items()
            if k not in listed]
    listed |= set(store.topologies)
    out += [{"id": a, "name": a, "story": False, "inferred": True} for a in store.seen_apps() if a not in listed]
    return JSONResponse(out)


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
        if e["event_type"] in ("run_started", "run_updated") and e.get("data", {}).get("map_hash"):
            r["map_hash"] = e["data"]["map_hash"]  # library runs: the map this run carried
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
    Route("/maps/{map_hash}", get_map, methods=["GET"]),
    Route("/apps/{app_id}", register_app, methods=["PUT"]),
    Route("/apps/{app_id}/story.js", get_story),
    Mount("/viewer", StaticFiles(directory=ROOT / "viewer"), name="viewer"),
    Mount("/shell", StaticFiles(directory=ROOT / "shell", html=True), name="shell"),
    Route("/recordings.json", recordings),
    Mount("/examples", StaticFiles(directory=ROOT / "examples"), name="examples"),
    Mount("/recordings", StaticFiles(directory=REC_DIR, check_dir=False), name="recordings"),
])

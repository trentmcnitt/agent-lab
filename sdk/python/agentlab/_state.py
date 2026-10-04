"""`init()`, the process's Agent Lab state, and the processors and exporters Agent Lab owns.

Default: a private TracerProvider that is never set as the global one, exporting OTLP/HTTP
protobuf to the bench. Opt-in shared mode (`tracer_provider=<provider>` or `"global"`) adds the
bench exporter and the stamping processor to the app's own provider instead.
"""
from __future__ import annotations

import json
import os
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Sequence
from urllib.parse import urlsplit

from opentelemetry import trace
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import Event, ReadableSpan, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult

from . import _semconv as sc
from ._context import run_target
from ._util import dumps, log, log_once, to_jsonable
from .version import __version__

DEFAULT_ENDPOINT = "http://127.0.0.1:8790"
ENV_URL = "AGENT_LAB_URL"
OFF_VALUES = {"", "0", "off", "false", "no", "none"}
BATCH_DELAY_MS = 200
EXPORT_TIMEOUT_S = 5.0
RECHECK_DOWN_S = 5.0     # how long a bench that refused a connection is left alone
TESTING_KEY = ("testing",)
LOOPBACK = {"127.0.0.1", "localhost", "::1"}

Price = Callable[[str, int, int, int, int], "float | None"]
Redact = Callable[[Any], Any]


@dataclass
class State:
    enabled: bool = False
    tracer: trace.Tracer | None = None
    provider: TracerProvider | None = None
    shared: bool = False                 # True: the app's provider; False: Agent Lab's private one
    endpoint: str | None = None
    redact: Redact | None = None
    price: Price | None = None
    price_basis: str | None = None
    capture_content: bool = True
    init_key: tuple | None = None
    extra: dict = field(default_factory=dict)

    @property
    def content_mode(self) -> str:
        if not self.capture_content:
            return "absent"
        return "redacted" if self.redact is not None else "full"

    @property
    def service_name(self) -> str | None:
        if self.provider is None:
            return None
        name = self.provider.resource.attributes.get(SERVICE_NAME)
        if not isinstance(name, str) or name.startswith("unknown_service"):
            return None
        return name


STATE = State()
_init_lock = threading.Lock()


def swap(new: State) -> State:
    """Replace the process state, returning the old one (for `agentlab.testing.capture`)."""
    global STATE
    old, STATE = STATE, new
    return old


def init(endpoint: str | None = None, *,
         service_name: str | None = None,
         tracer_provider: "TracerProvider | Literal['global'] | None" = None,
         redact: Redact | None = None,
         price: Price | None = None,
         price_basis: str | None = None,
         capture_content: bool = True) -> None:
    """Turn Agent Lab on for this process. Never raises; safe to call more than once.

    - `endpoint`: the bench's base URL. Default: env `AGENT_LAB_URL`, else the local bench at
      http://127.0.0.1:8790. `AGENT_LAB_URL=off` (or empty) turns export off. Spans go to
      `{endpoint}/v1/traces`; while nothing is listening there they are dropped silently.
    - `tracer_provider`: None (default) = a private provider, never set as the global one.
      A provider, or "global" (the current global SDK provider) = share the app's provider: the
      bench exporter and the stamping processor are added to it.
    - `redact`: applied to every content value Agent Lab emits, and by the bench exporter to other
      instrumentors' content attributes. `capture_content=False` emits no content at all.
    - `price(model, input, output, cache_read, cache_write) -> USD | None` and `price_basis`:
      an estimated cost on each model call (`agentlab.cost.usd`), labelled as estimated.
    """
    try:
        with _init_lock:
            _init(endpoint, service_name, tracer_provider, redact, price, price_basis, capture_content)
    except Exception as e:  # noqa: BLE001 - init must never break app startup
        log_once("init", f"{type(e).__name__}: {e}", level=30)


def _resolve_endpoint(endpoint: str | None) -> tuple[str | None, bool]:
    """(url or None when off, whether it was configured rather than the local default)."""
    explicit = endpoint is not None or ENV_URL in os.environ
    if endpoint is None:
        endpoint = os.environ.get(ENV_URL, DEFAULT_ENDPOINT)
    endpoint = endpoint.strip()
    if endpoint.lower() in OFF_VALUES:
        return None, explicit
    return endpoint.rstrip("/"), explicit


def _init(endpoint, service_name, tracer_provider, redact, price, price_basis, capture_content) -> None:
    url, explicit = _resolve_endpoint(endpoint)
    provider_key = tracer_provider if isinstance(tracer_provider, str) or tracer_provider is None else id(tracer_provider)
    key = (url, service_name, provider_key, redact, price, price_basis, bool(capture_content))
    if STATE.init_key == TESTING_KEY:   # inside agentlab.testing.capture(): the test's state wins
        return
    if STATE.init_key is not None:
        if key != STATE.init_key:
            log.warning("agentlab.init was already called with different arguments; this call is ignored")
        return

    provider: TracerProvider | None = None
    shared = False
    if tracer_provider == "global":
        current = trace.get_tracer_provider()
        if isinstance(current, TracerProvider):
            provider, shared = current, True
        else:
            log.warning("agentlab.init(tracer_provider='global'): the global provider is not an SDK "
                        "TracerProvider (%s); using a private one", type(current).__name__)
    elif tracer_provider is not None:
        if isinstance(tracer_provider, TracerProvider):
            provider, shared = tracer_provider, True
        else:
            log.warning("agentlab.init: tracer_provider must be an SDK TracerProvider or 'global'; "
                        "using a private one")

    new = State(endpoint=url, redact=redact, price=price, price_basis=price_basis,
                capture_content=bool(capture_content), init_key=key)
    if provider is None:
        if url is None:            # private and nowhere to send: Agent Lab stays off
            STATE.init_key = key
            return
        provider = TracerProvider(resource=_resource(service_name))
    elif service_name:
        log_once("init", "service_name is ignored with a shared provider (the resource is the app's)")

    provider.add_span_processor(StampingProcessor())
    if url is not None:
        exporter: SpanExporter = BenchExporter(url, explicit=explicit)
        if redact is not None:
            exporter = MaskingExporter(exporter, redact)
        provider.add_span_processor(BatchSpanProcessor(exporter, schedule_delay_millis=BATCH_DELAY_MS))

    new.provider, new.shared = provider, shared
    new.tracer = provider.get_tracer(sc.SCOPE, __version__)
    new.enabled = True
    swap(new)


def _resource(service_name: str | None) -> Resource:
    base = Resource.create()       # reads OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES
    current = base.attributes.get(SERVICE_NAME)
    if service_name and (not isinstance(current, str) or current.startswith("unknown_service")):
        return base.merge(Resource({SERVICE_NAME: service_name}))
    return base


# ---------------------------------------------------------------- content


def content(value: Any) -> str | None:
    """A content value as Agent Lab emits it: redacted, JSON-encoded unless it is a string, or
    None when content capture is off or redaction failed (fail closed: never the unmasked value)."""
    state = STATE
    if not state.capture_content or value is None:
        return None
    if state.redact is not None:
        try:
            value = state.redact(value if isinstance(value, str) else to_jsonable(value))
        except Exception as e:  # noqa: BLE001
            log_once("redact", f"redact raised {type(e).__name__}; the value was dropped")
            return None
    return value if isinstance(value, str) else dumps(value)


# ---------------------------------------------------------------- processors and exporters


class StampingProcessor(SpanProcessor):
    """Stamps `agentlab.app`, `agentlab.run` and `agentlab.node` on any span that starts while a
    node is running and lacks them, so another instrumentor's spans group under the right node.
    Outside a run it does nothing."""

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        try:
            target = run_target()
            if target is None or target.run is None:
                return
            attrs = span.attributes or {}
            for key, value in ((sc.APP, target.app_id), (sc.RUN, target.run_id), (sc.NODE, target.node)):
                if value is not None and key not in attrs:
                    span.set_attribute(key, value)
        except Exception as e:  # noqa: BLE001
            log_once("stamp", f"{type(e).__name__}: {e}")

    def on_end(self, span: ReadableSpan) -> None:
        pass

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


class BenchExporter(SpanExporter):
    """OTLP/HTTP protobuf to the bench, silent while the bench isn't running.

    The upstream exporter retries a refused connection with backoff and logs every attempt, which
    would fill an app's logs whenever the bench is closed. This wrapper checks the port first (in
    the export thread, never the app's) and drops the batch when nothing is listening, rechecking
    every few seconds. For the default local bench that is silent (a debug line): not running it
    is normal. For a configured endpoint (argument or AGENT_LAB_URL) it warns once, since spans
    someone asked for are being lost."""

    def __init__(self, endpoint: str, inner: SpanExporter | None = None, *, explicit: bool = False):
        if inner is None:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            inner = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces", timeout=EXPORT_TIMEOUT_S)
        self._inner = inner
        parts = urlsplit(endpoint)
        self._addr = (parts.hostname or "127.0.0.1", parts.port or (443 if parts.scheme == "https" else 80))
        self._probe_timeout = 0.25 if self._addr[0] in LOOPBACK else 1.0
        self._level = 30 if explicit else 10        # WARNING for a configured endpoint, else DEBUG
        self._down_until = 0.0

    def _reachable(self) -> bool:
        now = time.monotonic()
        if now < self._down_until:
            return False
        try:
            with socket.create_connection(self._addr, timeout=self._probe_timeout):
                return True
        except OSError:
            self._down_until = now + RECHECK_DOWN_S
            log_once("export", f"nothing is listening at {self._addr[0]}:{self._addr[1]}; "
                               "spans are dropped until it is", level=self._level)
            return False

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if not self._reachable():
            return SpanExportResult.FAILURE
        return self._inner.export(spans)

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


class MaskingExporter(SpanExporter):
    """Applies `redact` to other instrumentors' content attributes before they leave for the bench.

    Agent Lab's own spans are redacted where they are made (`content()`), so they pass through.
    A SpanProcessor can't do this: the SDK freezes a span's attributes before `on_end` runs."""

    def __init__(self, inner: SpanExporter, redact: Redact):
        self._inner = inner
        self._redact = redact

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._inner.export([self._mask(s) for s in spans])

    def _mask_attrs(self, attrs: Any) -> dict:
        out = {}
        for key, value in (attrs or {}).items():
            if not sc.is_content(key):
                out[key] = value
                continue
            masked = self._mask_value(value)
            if masked is not None:
                out[key] = masked
        return out

    def _mask_value(self, value: Any) -> Any:
        try:
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except ValueError:
                    return str(self._redact(value))
                return dumps(self._redact(parsed)) if not isinstance(parsed, str) else str(self._redact(parsed))
            if isinstance(value, (list, tuple)):
                return tuple(str(self._redact(v)) if isinstance(v, str) else v for v in value)
            return value
        except Exception as e:  # noqa: BLE001 - fail closed: drop, never send unmasked
            log_once("mask", f"redact raised {type(e).__name__}; the attribute was dropped")
            return None

    def _mask(self, span: ReadableSpan) -> ReadableSpan:
        scope = span.instrumentation_scope
        if scope is not None and scope.name == sc.SCOPE:
            return span
        if not any(sc.is_content(k) for k in (span.attributes or {})) and not any(
                sc.is_content(k) for e in span.events for k in (e.attributes or {})):
            return span
        events = [Event(e.name, self._mask_attrs(e.attributes), e.timestamp) for e in span.events]
        return ReadableSpan(
            name=span.name, context=span.context, parent=span.parent, resource=span.resource,
            attributes=self._mask_attrs(span.attributes), events=events, links=span.links,
            kind=span.kind, status=span.status, start_time=span.start_time, end_time=span.end_time,
            instrumentation_scope=scope,
        )

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


__all__ = ["init", "STATE", "State", "swap", "content", "StampingProcessor", "BenchExporter",
           "MaskingExporter"]

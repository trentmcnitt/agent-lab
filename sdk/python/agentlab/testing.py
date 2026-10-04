"""Test helpers: capture Agent Lab's spans in memory, and write them as OTLP/JSON."""
from __future__ import annotations

import contextlib
from typing import Any, Iterator, Sequence

from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult

from . import _semconv as sc
from . import _state
from ._util import reset_log_once
from .version import __version__


class ListExporter(SpanExporter):
    """Appends every finished span to a list the caller holds."""

    def __init__(self, sink: list[ReadableSpan]):
        self.sink = sink

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.sink.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass


@contextlib.contextmanager
def capture(*, redact: _state.Redact | None = None, price: _state.Price | None = None,
            price_basis: str | None = None, capture_content: bool = True,
            service_name: str | None = None) -> Iterator[list[ReadableSpan]]:
    """Turn Agent Lab on for the block with a fresh private provider and an in-memory exporter;
    yields the list finished spans are appended to. Restores the previous state (including a
    real `init`) on exit. The keyword arguments are `init`'s, for testing redaction and pricing;
    with `redact`, spans pass through the same masking exporter the bench exporter uses."""
    spans: list[ReadableSpan] = []
    provider = TracerProvider(resource=_state._resource(service_name))
    provider.add_span_processor(_state.StampingProcessor())
    exporter: SpanExporter = ListExporter(spans)
    if redact is not None:
        exporter = _state.MaskingExporter(exporter, redact)
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    state = _state.State(enabled=True, provider=provider, tracer=provider.get_tracer(sc.SCOPE, __version__),
                         redact=redact, price=price, price_basis=price_basis,
                         capture_content=capture_content, init_key=_state.TESTING_KEY)
    old = _state.swap(state)
    try:
        yield spans
    finally:
        _state.swap(old)
        provider.shutdown()
        reset_log_once()


def to_otlp_json(spans: Sequence[ReadableSpan]) -> dict[str, Any]:
    """An OTLP/JSON ExportTraceServiceRequest for `spans`, the body `bench.record --otlp` and
    `POST /v1/traces` read. Protobuf's JSON mapping: ids are base64 and 64-bit ints are strings
    (SPEC.md section 3 accepts both)."""
    from google.protobuf.json_format import MessageToDict
    from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
    return MessageToDict(encode_spans(spans))

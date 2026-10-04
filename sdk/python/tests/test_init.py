"""init(): private by default, shared on request, idempotent, silent with no bench listening."""
import logging
import socket
import time

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import agentlab as lab
from agentlab import _runtime, _state


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_default_endpoint_is_the_local_bench(monkeypatch):
    monkeypatch.delenv("AGENT_LAB_URL", raising=False)
    lab.init()
    assert _state.STATE.enabled
    assert _state.STATE.endpoint == "http://127.0.0.1:8790"


def test_env_url_and_trailing_slash(monkeypatch):
    monkeypatch.setenv("AGENT_LAB_URL", "http://bench.internal:9000/")
    lab.init()
    assert _state.STATE.endpoint == "http://bench.internal:9000"


def test_private_provider_is_never_set_global():
    before = trace.get_tracer_provider()
    lab.init(f"http://127.0.0.1:{free_port()}")
    assert trace.get_tracer_provider() is before
    assert _state.STATE.provider is not before
    assert _state.STATE.shared is False


def test_service_name_sets_the_resource_only_if_unset(monkeypatch):
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    lab.init(f"http://127.0.0.1:{free_port()}", service_name="helpdesk")
    assert _state.STATE.service_name == "helpdesk"


def test_service_name_from_env_wins(monkeypatch):
    monkeypatch.setenv("OTEL_SERVICE_NAME", "from-env")
    lab.init(f"http://127.0.0.1:{free_port()}", service_name="helpdesk")
    assert _state.STATE.service_name == "from-env"


def test_idempotent_equal_args_and_warns_on_different(caplog):
    url = f"http://127.0.0.1:{free_port()}"
    lab.init(url)
    first = _state.STATE
    lab.init(url)
    assert _state.STATE is first
    with caplog.at_level(logging.WARNING, logger="agentlab"):
        lab.init(url, capture_content=False)
    assert _state.STATE is first and first.capture_content is True
    assert any("different arguments" in r.getMessage() for r in caplog.records)


def test_shared_provider_gets_agent_lab_spans_and_stamps_the_apps_spans():
    exporter = InMemorySpanExporter()
    app_provider = TracerProvider()
    app_provider.add_span_processor(SimpleSpanProcessor(exporter))
    lab.init(f"http://127.0.0.1:{free_port()}", tracer_provider=app_provider)
    assert _state.STATE.shared and _state.STATE.provider is app_provider

    run = _runtime.start_run(app_id="demo", run_id="r1")
    node = run.open_node("classify")
    from agentlab._context import activate
    with activate(run.target(node, "classify")):
        other = app_provider.get_tracer("someone.else").start_span("http call")
        other.end()
    run.end_node(node)
    run.finish()
    spans = {s.name: s for s in exporter.get_finished_spans()}
    assert spans["http call"].attributes["agentlab.node"] == "classify"
    assert spans["http call"].attributes["agentlab.run"] == "r1"
    assert spans["http call"].attributes["agentlab.app"] == "demo"
    assert "agentlab.kind" not in spans["http call"].attributes   # only Agent Lab's own spans
    assert {"agentlab.run demo", "node classify"} <= set(spans)


def test_global_proxy_falls_back_to_private(caplog, monkeypatch):
    monkeypatch.setattr(trace, "get_tracer_provider", lambda: trace.ProxyTracerProvider())
    with caplog.at_level(logging.WARNING, logger="agentlab"):
        lab.init(f"http://127.0.0.1:{free_port()}", tracer_provider="global")
    assert _state.STATE.enabled and not _state.STATE.shared
    assert any("not an SDK" in r.getMessage() for r in caplog.records)


def test_global_sdk_provider_is_shared(monkeypatch):
    provider = TracerProvider()
    monkeypatch.setattr(trace, "get_tracer_provider", lambda: provider)
    lab.init(f"http://127.0.0.1:{free_port()}", tracer_provider="global")
    assert _state.STATE.shared and _state.STATE.provider is provider


def test_nothing_listening_is_silent_and_fast(caplog, monkeypatch):
    """With no local bench running, export drops batches without the upstream retry/backoff noise."""
    monkeypatch.delenv("AGENT_LAB_URL", raising=False)
    monkeypatch.setattr(_state, "DEFAULT_ENDPOINT", f"http://127.0.0.1:{free_port()}")
    lab.init()
    caplog.set_level(logging.INFO)          # everything at INFO and above, every logger
    run = _runtime.start_run(app_id="demo", run_id="r1")
    run.finish()
    start = time.monotonic()
    assert _state.STATE.provider.force_flush(5000)
    assert time.monotonic() - start < 2.0
    assert [r for r in caplog.records if r.levelno >= logging.INFO] == []


def test_bench_exporter_rechecks_after_a_refusal(monkeypatch):
    calls = []

    class Inner:
        def export(self, spans):
            calls.append(len(spans))
            return _state.SpanExportResult.SUCCESS

        def shutdown(self):
            pass

        def force_flush(self, timeout_millis=0):
            return True

    port = free_port()
    exp = _state.BenchExporter(f"http://127.0.0.1:{port}", inner=Inner())
    assert exp.export([object()]) == _state.SpanExportResult.FAILURE      # nothing listening
    with socket.socket() as server:
        server.bind(("127.0.0.1", port))
        server.listen()
        assert exp.export([object()]) == _state.SpanExportResult.FAILURE  # still inside the wait
        monkeypatch.setattr(_state, "RECHECK_DOWN_S", 0.0)
        exp._down_until = 0.0
        assert exp.export([object()]) == _state.SpanExportResult.SUCCESS
    assert calls == [1]


def test_end_to_end_protobuf_reaches_a_listening_receiver():
    """The real OTLP/HTTP exporter posts protobuf to {endpoint}/v1/traces."""
    import http.server
    import threading

    got = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            got.append((self.path, self.headers["Content-Type"], body))
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        lab.init(f"http://127.0.0.1:{server.server_port}")
        _runtime.start_run(app_id="demo", run_id="r1").finish()
        assert _state.STATE.provider.force_flush(5000)
    finally:
        server.shutdown()
    assert got and got[0][0] == "/v1/traces" and got[0][1] == "application/x-protobuf"
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
    req = ExportTraceServiceRequest.FromString(got[0][2])
    names = {s.name for rs in req.resource_spans for ss in rs.scope_spans for s in ss.spans}
    assert "agentlab.run demo" in names


def test_init_inside_capture_is_silent_and_keeps_the_test_state(caplog):
    """An app whose startup calls init() runs inside testing.capture() (tests, the regenerator)."""
    from agentlab import testing
    with testing.capture():
        state = _state.STATE
        with caplog.at_level(logging.DEBUG, logger="agentlab"):
            lab.init(capture_content=False)
        assert _state.STATE is state and state.capture_content is True
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_a_configured_endpoint_that_is_down_warns_once(caplog):
    url = f"http://127.0.0.1:{free_port()}"
    exp = _state.BenchExporter(url, inner=object(), explicit=True)
    with caplog.at_level(logging.DEBUG, logger="agentlab"):
        exp.export([])
        exp._down_until = 0.0
        exp.export([])
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "nothing is listening" in warnings[0].getMessage()


def test_the_default_local_endpoint_down_is_debug_only(caplog):
    exp = _state.BenchExporter(f"http://127.0.0.1:{free_port()}", inner=object())
    with caplog.at_level(logging.DEBUG, logger="agentlab"):
        exp.export([])
    assert [r.levelno for r in caplog.records] == [logging.DEBUG]


def test_explicit_comes_from_argument_or_env(monkeypatch):
    monkeypatch.delenv("AGENT_LAB_URL", raising=False)
    assert _state._resolve_endpoint(None) == ("http://127.0.0.1:8790", False)
    assert _state._resolve_endpoint("http://h:1/") == ("http://h:1", True)
    monkeypatch.setenv("AGENT_LAB_URL", "http://127.0.0.1:8790")
    assert _state._resolve_endpoint(None) == ("http://127.0.0.1:8790", True)
    monkeypatch.setenv("AGENT_LAB_URL", "off")
    assert _state._resolve_endpoint(None) == (None, True)

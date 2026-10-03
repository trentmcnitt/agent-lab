# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "openai>=3.24",
#     "openinference-instrumentation-openai>=0.1.63",
#     "opentelemetry-sdk>=1.45",
#     "opentelemetry-exporter-otlp-proto-http>=1.45",
# ]
# ///
"""Recaptures openinference_openai.pb: a pure OpenInference trace, with no API key and no paid call.

One local server plays both ends: a fake OpenAI /v1/chat/completions, and the OTLP receiver that
writes the exported protobuf body to the fixture file. The app side is the real OpenInference
OpenAI instrumentor, plus a CHAIN root and a RETRIEVER span written with OpenInference's own names.

    uv run tests/fixtures/otlp/openinference_openai.capture.py [port]     # default port 4319
"""
import http.server
import json
import os
import sys
import threading
import time
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4319
OUT = Path(__file__).with_name("openinference_openai.pb")


class Fake(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path.endswith("/v1/traces"):
            OUT.write_bytes(body)
            self.send_response(200)
            self.send_header("content-type", "application/x-protobuf")
            self.end_headers()
            return
        req = json.loads(body)
        b = json.dumps({"id": "chatcmpl-fake", "object": "chat.completion", "created": int(time.time()), "model": req["model"],
                        "choices": [{"index": 0, "finish_reason": "stop", "message": {
                            "role": "assistant", "content": "Open the self-service portal, choose VPN, then Reset password."}}],
                        "usage": {"prompt_tokens": 42, "completion_tokens": 12, "total_tokens": 54}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


server = http.server.HTTPServer(("127.0.0.1", PORT), Fake)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"http://127.0.0.1:{PORT}"
os.environ.setdefault("OTEL_SERVICE_NAME", "level0-openinference")

import openai  # noqa: E402
from openinference.instrumentation.openai import OpenAIInstrumentor  # noqa: E402
from openinference.semconv.trace import DocumentAttributes as DA  # noqa: E402
from openinference.semconv.trace import OpenInferenceSpanKindValues as K  # noqa: E402
from openinference.semconv.trace import SpanAttributes as SA  # noqa: E402
from opentelemetry import trace  # noqa: E402
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter  # noqa: E402
from opentelemetry.sdk.resources import Resource  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: E402

p = TracerProvider(resource=Resource.create())
p.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(p)
OpenAIInstrumentor().instrument(tracer_provider=p)
tr = trace.get_tracer("oi-example")
client = openai.OpenAI(base_url=f"http://127.0.0.1:{PORT}/v1", api_key="not-a-key")
q = "How do I reset my VPN password?"
with tr.start_as_current_span("answer") as root:
    root.set_attribute(SA.OPENINFERENCE_SPAN_KIND, K.CHAIN.value)
    root.set_attribute(SA.INPUT_VALUE, q)
    with tr.start_as_current_span("search handbook") as r:
        r.set_attribute(SA.OPENINFERENCE_SPAN_KIND, K.RETRIEVER.value)
        r.set_attribute(SA.INPUT_VALUE, q)
        pre = f"{SA.RETRIEVAL_DOCUMENTS}.0."
        r.set_attribute(pre + DA.DOCUMENT_ID, "vpn-reset")
        r.set_attribute(pre + DA.DOCUMENT_SCORE, 2.0)
        r.set_attribute(pre + DA.DOCUMENT_CONTENT, "Open the self-service portal, choose VPN, then Reset password.")
    out = client.chat.completions.create(model="gpt-4o-mini", messages=[
        {"role": "system", "content": "Answer from the handbook only."}, {"role": "user", "content": q}])
    root.set_attribute(SA.OUTPUT_VALUE, out.choices[0].message.content)
p.shutdown()
server.shutdown()
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")

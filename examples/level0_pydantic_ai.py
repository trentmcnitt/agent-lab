# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pydantic-ai-slim>=2.54",
#     "opentelemetry-sdk>=1.45",
#     "opentelemetry-exporter-otlp-proto-http>=1.45",
# ]
# ///
"""Level 0: a real Pydantic AI agent, its built-in OpenTelemetry, and no bench code at all.

The app below knows nothing about Agent Lab. It does what any OTel-instrumented app does:
set up a tracer provider with the standard OTLP/HTTP exporter, then turn on Pydantic AI's
instrumentation. Pointing the standard OTEL_* variables at the bench is the whole hookup.

    uv run uvicorn bench.server:app --port 8790       # the bench, from its checkout
    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8790 \\
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\
    OTEL_SERVICE_NAME=level0-pydantic-ai \\
    OTEL_BSP_SCHEDULE_DELAY=200 \\
    uv run examples/level0_pydantic_ai.py "How do I reset my VPN password?"

No API key: the model is Pydantic AI's FunctionModel, a scripted stand-in that calls the
handbook tool, then answers from what it returned. Everything else (the agent run, the model
calls, the tool call, the messages) is Pydantic AI's own instrumentation, unchanged. The one
hand-made span is the handbook search, because Pydantic AI has no retrieval span: it uses the
OTel GenAI retrieval convention (gen_ai.operation.name = retrieval, gen_ai.data_source.id,
gen_ai.retrieval.documents), which is what a RAG library emitting that convention would send.
"""
from __future__ import annotations

import json
import os
import sys

# Defaults so the script works with no environment set; any OTEL_* variable you set wins.
os.environ.setdefault("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:8790")
os.environ.setdefault("OTEL_SERVICE_NAME", "level0-pydantic-ai")
os.environ.setdefault("OTEL_BSP_SCHEDULE_DELAY", "200")

from opentelemetry import trace  # noqa: E402
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter  # noqa: E402
from opentelemetry.sdk.resources import Resource  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: E402
from pydantic_ai import Agent  # noqa: E402
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart  # noqa: E402
from pydantic_ai.models.function import AgentInfo, FunctionModel  # noqa: E402

HANDBOOK = {
    "vpn-reset": ("Resetting your VPN password", "Open the self-service portal, choose VPN, then Reset password. The new password works within 5 minutes."),
    "laptop-request": ("Requesting a laptop", "Laptops are requested through a ticket; a manager approves it."),
    "mfa-lost": ("Lost your MFA device", "Call the service desk; they verify you and issue a temporary code."),
}


def search(query: str, k: int = 2) -> list[dict]:
    """A toy keyword search over the handbook: score = shared words."""
    words = set(query.lower().split())
    scored = [(len(words & set((t + " " + body).lower().split())), sid) for sid, (t, body) in HANDBOOK.items()]
    return [{"id": sid, "score": float(s), "title": HANDBOOK[sid][0], "content": HANDBOOK[sid][1]}
            for s, sid in sorted(scored, reverse=True)[:k] if s]


def scripted_model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    """First turn: search the handbook. Second turn: answer from the best hit."""
    returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
    if not returns:
        prompt = next(p.content for m in messages for p in getattr(m, "parts", []) if p.part_kind == "user-prompt")
        return ModelResponse(parts=[ToolCallPart("search_handbook", {"query": prompt})])
    hits = returns[-1].content
    if not hits:
        return ModelResponse(parts=[TextPart("I couldn't find that in the handbook; I'll pass it to a person.")])
    return ModelResponse(parts=[TextPart(f"From the handbook ({hits[0]['title']}): {hits[0]['content']}")])


agent = Agent(FunctionModel(scripted_model, model_name="scripted-helpdesk"), name="helpdesk",
              instructions="Answer IT questions from the handbook only. Search it first.")


@agent.tool_plain
def search_handbook(query: str) -> list[dict]:
    """Search the IT handbook."""
    with trace.get_tracer("level0-example").start_as_current_span("retrieval handbook") as span:
        hits = search(query)
        span.set_attributes({
            "gen_ai.operation.name": "retrieval",
            "gen_ai.data_source.id": "handbook",
            "gen_ai.retrieval.query.text": query,
            # The convention allows a JSON string on spans when structured values aren't supported.
            "gen_ai.retrieval.documents": json.dumps(hits),
        })
    return hits


def main() -> None:
    provider = TracerProvider(resource=Resource.create())  # reads OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))  # reads OTEL_EXPORTER_OTLP_*
    trace.set_tracer_provider(provider)
    Agent.instrument_all()  # Pydantic AI's built-in OTel; include_content defaults to True
    for prompt in sys.argv[1:] or ["How do I reset my VPN password?"]:
        print(agent.run_sync(prompt).output)
    provider.shutdown()  # flush before exit


if __name__ == "__main__":
    main()

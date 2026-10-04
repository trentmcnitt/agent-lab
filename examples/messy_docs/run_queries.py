"""Runs the five questions and writes what the bench gets from them, two ways.

    uv run python run_queries.py

1. With the agentlab library (Level 1+): each run's spans -> OTLP/JSON -> the bench's own
   recorder (`python -m bench.record`, run from the bench's root with the bench's environment)
   -> recordings/<slug>.recording.jsonl.
2. Level 0 (no agentlab at all): the same graph, uninstrumented, traced only by OpenInference's
   standard LangChain instrumentor. Its spans go through the bench's own OTLP reader
   (adapters/otlp.py) and the resulting events are written to recordings/level0-<slug>.events.json.
   (bench.record refuses a run with no map, so Level 0 can't be a recording; this is what a live
   bench would receive.)
"""
from __future__ import annotations

import json
import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", category=DeprecationWarning)

HERE = Path(__file__).resolve().parent
BENCH = HERE.parents[1]
OUT = HERE / "recordings"

QUERIES = [
    ("refund-window", "How long does a customer have to return an item for a refund?"),
    ("error-e4", "The blender shows error E4, what does that mean?"),
    ("warranty-year-two", "What does the warranty cover after the first year?"),
    ("loaner", "Can we give a customer a loaner blender while theirs is being repaired?"),
    ("jargon", "Should agents say SKU or RMA to customers?"),           # lands in the 24-page handbook
]


def record_library_runs() -> list[Path]:
    from agentlab.testing import capture, to_otlp_json
    from messy_support.graph import build_graph

    OUT.mkdir(exist_ok=True)
    written = []
    for i, (slug, q) in enumerate(QUERIES):
        with capture(service_name="messy-support") as spans:
            graph = build_graph()
            graph.invoke({"question": q})
        otlp = OUT / f"{slug}.otlp.json"
        otlp.write_text(json.dumps(to_otlp_json(spans)))
        res = subprocess.run(["uv", "run", "--quiet", "python", "-m", "bench.record", "--otlp", str(otlp),
                              "--out", str(OUT), "--name", slug, "--title", q, "--t0", str(1790700000 + 600 * i)],
                             cwd=BENCH, capture_output=True, text=True)
        if res.returncode:
            raise SystemExit(f"bench.record failed for {slug}: {res.stderr}")
        otlp.unlink()
        written.append(OUT / f"{slug}.recording.jsonl")
    return written


def level0_runs() -> list[Path]:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from openinference.instrumentation.langchain import LangChainInstrumentor

    from agentlab.testing import to_otlp_json
    from messy_support.graph import make_builder

    sys.path.insert(0, str(BENCH))
    from adapters import otlp as bench_otlp

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    inst = LangChainInstrumentor()
    inst.instrument(tracer_provider=provider)
    written = []
    try:
        graph = make_builder().compile()           # no agentlab.instrument, no lab.init: Level 0
        for slug, q in QUERIES:
            exporter.clear()
            graph.invoke({"question": q})
            body = to_otlp_json(exporter.get_finished_spans())
            events = bench_otlp.TraceState().ingest(body, app="messy-support", session_id="level0")
            # The raw OpenInference retriever attributes, beside what the bench kept of them.
            raw = []
            for s in exporter.get_finished_spans():
                a = dict(s.attributes or {})
                if a.get("openinference.span.kind") == "RETRIEVER":
                    raw.append({k: v for k, v in sorted(a.items()) if k.startswith("retrieval.documents.0.")})
            path = OUT / f"level0-{slug}.events.json"
            path.write_text(json.dumps({"question": q, "openinference_retriever_doc0_attributes": raw,
                                        "bench_retrieval_events": [e for e in events if e["event_type"] == "retrieval"],
                                        "bench_event_types": sorted({e["event_type"] for e in events})},
                                       indent=1, ensure_ascii=False, default=str) + "\n")
            written.append(path)
    finally:
        inst.uninstrument()
    return written


if __name__ == "__main__":
    for p in record_library_runs() + level0_runs():
        print(p.relative_to(HERE))

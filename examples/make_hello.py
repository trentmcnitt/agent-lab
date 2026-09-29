"""Builds the bench's own example: a synthetic "hello agent" with a map, a story and two
recordings (one per branch). Synthetic on purpose: it exercises every part of the format
without belonging to any real app. Run: uv run python examples/make_hello.py"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

TOPOLOGY = {
    "v": "bench-topology/0",
    "app": {"id": "hello-agent", "name": "Hello agent (synthetic example)",
            "description": "A made-up support triage agent that ships with the bench as its example."},
    "nodes": [
        {"id": "receive", "label": "receive", "kind": "step"},
        {"id": "triage", "label": "triage", "kind": "llm"},
        {"id": "lookup", "label": "look up docs", "kind": "retrieval"},
        {"id": "answer", "label": "draft answer", "kind": "llm"},
        {"id": "escalate", "label": "escalate", "kind": "gate"},
        {"id": "reply", "label": "reply", "kind": "terminal"},
    ],
    "edges": [
        {"from": "receive", "to": "triage"},
        {"from": "triage", "to": "lookup", "from_branch": "answerable"},
        {"from": "triage", "to": "escalate", "from_branch": "needs_human"},
        {"from": "lookup", "to": "answer"},
        {"from": "answer", "to": "reply"},
        {"from": "escalate", "to": "reply"},
    ],
    "panels": [
        {"id": "triage", "title": "Triage (story panel)", "event_types": ["decision"], "nodes": ["triage"], "story": True},
        {"id": "docs", "title": "Docs found (declared fields)", "event_types": ["retrieval"],
         "fields": [{"key": "query", "label": "query"}, {"key": "hits", "label": "hits", "format": "json"}]},
        {"id": "gate", "title": "Escalation", "event_types": ["gate_waiting", "gate_resolved"], "mode": "append"},
        {"id": "llm", "title": "Model calls", "event_types": ["llm_call"], "mode": "append"},
    ],
    "story": True,
}

STORY = r"""
BenchStory.register('hello-agent', {
  panels: {
    // A story panel: the app decides how its own decision reads.
    triage: function (events, ctx) {
      var d = events[events.length - 1].data, h = ctx.h;
      var pct = Math.round((d.confidence || 0) * 100);
      return '<div style="font-size:13px;margin-bottom:6px">Sent to <b style="color:var(--accent)">' +
        h.esc(d.branch.replace('_', ' ')) + '</b></div>' +
        '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--accent-2),var(--accent))"></div></div>' +
        '<div class="note">' + pct + '% confident · ' + h.esc(d.rationale) + '</div>';
    }
  }
});
"""


def run(run_id: str, t0: float, branch: str) -> list[dict]:
    ev, t = [], t0

    def e(node, et, data=None, dt=0.0):
        nonlocal t
        t += dt
        ev.append({"v": "bench/0", "session_id": "example", "run_id": run_id, "seq": len(ev), "ts": round(t, 3),
                   "node": node, "event_type": et, "content_mode": "full", "data": data or {},
                   **({"step_id": f"{run_id}:{node}"} if node != "_run" else {})})

    q = "How do I reset my password?" if branch == "answerable" else "Someone is logged into my account and it isn't me."
    e("_run", "run_started", {"input": q, "origin": "example"})
    e("receive", "step_started")
    e("receive", "step_finished", {"status": "ok", "latency_ms": 4}, 0.004)
    e("triage", "step_started")
    conf, why = (0.93, "A how-to question the docs cover.") if branch == "answerable" else (0.97, "Possible account takeover: a person must handle it.")
    e("triage", "llm_call", {"model": "example-model", "provider": "example", "input_tokens": 820, "cache_read_tokens": 600,
                             "output_tokens": 40, "cost_usd": 0.0011, "cost_source": "estimated",
                             "cost_basis": "made-up prices for the example", "latency_ms": 640,
                             "system": "You triage support messages. Reply with JSON: {\"branch\": \"answerable\" | \"needs_human\", \"confidence\": 0-1, \"rationale\": str}. Anything about account security goes to a human.",
                             "messages": [{"role": "user", "content": q}],
                             "output": {"branch": branch, "confidence": conf, "rationale": why},
                             "params": {"max_tokens": 200, "temperature": 0}}, 0.64)
    e("triage", "decision", {"branch": branch, "confidence": conf, "rationale": why})
    e("triage", "step_finished", {"status": "ok", "latency_ms": 645}, 0.005)
    if branch == "answerable":
        e("lookup", "step_started")
        e("lookup", "retrieval", {"query": "reset password", "hits": [{"id": "doc-3", "title": "Resetting your password", "score": 0.82},
                                                                    {"id": "doc-9", "title": "Two-factor setup", "score": 0.41}]}, 0.03)
        e("lookup", "step_finished", {"status": "ok", "latency_ms": 31}, 0.001)
        e("answer", "step_started")
        e("answer", "llm_call", {"model": "example-model", "provider": "example", "input_tokens": 1400, "output_tokens": 120,
                                 "cost_usd": 0.0024, "cost_source": "estimated", "cost_basis": "made-up prices for the example",
                                 "latency_ms": 1180,
                                 "system": "Answer using only the docs below. Be brief.\n\n[doc-3] Resetting your password: Settings → Security → Reset password. A link is emailed within a minute.",
                                 "messages": [{"role": "user", "content": q}],
                                 "output": "Go to Settings → Security → Reset password; a link arrives by email within a minute."}, 1.18)
        e("answer", "step_finished", {"status": "ok", "latency_ms": 1181, "timings": {"prompt": 6, "model": 1175}}, 0.001)
        out = "Go to Settings → Security → Reset password; a link arrives by email within a minute."
    else:
        e("escalate", "step_started")
        e("escalate", "gate_waiting", {"reason": "security incident", "proposed": {"route_to": "security on-call"}}, 0.01)
        e("escalate", "gate_resolved", {"approved": True, "by": "on-call (example)", "via": "the app"}, 2.4)
        e("escalate", "step_finished", {"status": "ok", "latency_ms": 2410}, 0.001)
        out = "A person from security is taking this now."
    e("reply", "step_started")
    e("reply", "step_finished", {"status": "ok", "latency_ms": 2}, 0.002)
    e("_run", "run_finished", {"status": "ok", "output": out, "outcome": branch})
    return ev


def main() -> None:
    header = {"v": "bench-recording/0", "topology": TOPOLOGY, "story": STORY.strip()}
    for name, branch, t0 in (("hello-answer", "answerable", 1790600000.0), ("hello-escalate", "needs_human", 1790600100.0)):
        rows = [header] + run(f"{name}-1", t0, branch)
        (HERE / f"{name}.recording.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (HERE / "hello-agent.topology.json").write_text(json.dumps(TOPOLOGY, indent=2) + "\n")
    (HERE / "hello-agent.story.js").write_text(STORY.strip() + "\n")
    print("wrote examples/hello-*.recording.jsonl, hello-agent.topology.json, hello-agent.story.js")


if __name__ == "__main__":
    main()

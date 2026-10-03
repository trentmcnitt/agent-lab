"""Builds the bench's own example: a synthetic "hello agent" with a map, a story and two
recordings (one per branch). Synthetic on purpose: it exercises every part of the format
without belonging to any real app. Run: uv run python examples/make_hello.py"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

DOCS = [("doc-%d" % (i + 1), t) for i, t in enumerate([
    "Signing in", "Changing your email", "Resetting your password", "Billing and invoices", "Cancelling a plan",
    "Exporting your data", "Notifications", "Team members", "Two-factor setup", "API keys", "Mobile app", "Contacting support"])]
DOC_TEXT = {
    "doc-3": "Resetting your password: Settings → Security → Reset password. A link is emailed within a minute.",
    "doc-9": "Two-factor setup: Settings → Security → Two-factor. Scan the code with an authenticator app.",
}

TOPOLOGY = {
    "v": "bench-topology/0",
    "app": {"id": "hello-agent", "name": "Hello agent (synthetic example)",
            "description": "A made-up support triage agent that ships with the bench as its example.",
            "privacy_note": "Email addresses are hidden on this screen. (A made-up example: the AI saw the original message.)",
            "track_record": "A made-up example: it has never been tested on real requests."},
    "nodes": [
        {"id": "receive", "label": "receive", "plain_label": "Message arrives", "kind": "step", "actor": "app",
         "description": "A support message comes in."},
        {"id": "triage", "label": "triage", "plain_label": "Decide who handles it", "kind": "llm",
         "description": "The AI reads the message and decides: answer it from the help docs, or hand it to a person.", "moment": True},
        {"id": "lookup", "label": "look up docs", "plain_label": "Look up the help docs", "kind": "retrieval", "actor": "rule",
         "description": "A search, not the AI, picks the help-doc pages that best match the message."},
        {"id": "answer", "label": "draft answer", "plain_label": "Write the answer", "kind": "llm",
         "description": "The AI writes a reply using only the pages it was given."},
        {"id": "answer_check", "label": "answer check", "plain_label": "Check the answer", "kind": "check",
         "description": "Code, not the AI, checks that the answer only uses steps from the pages it was given. It can't tell whether a correctly quoted step is the wrong advice.", "moment": True,
         "x-states": {"passed": "✓ Passed: {detail}", "failed": "✕ Didn't pass: {detail}", "not_on_path": "– Not needed: the AI didn't write an answer this time."}},
        {"id": "escalate", "label": "escalate", "plain_label": "A person takes over", "kind": "gate",
         "description": "A person from the security team confirms they're taking it before anything is sent.", "moment": True},
        {"id": "reply", "label": "reply", "plain_label": "Reply", "kind": "terminal", "description": "The person who asked gets the reply."},
    ],
    "edges": [
        {"from": "receive", "to": "triage"},
        {"from": "triage", "to": "lookup", "from_branch": "answerable", "description": "It decided the help docs already answer this."},
        {"from": "triage", "to": "escalate", "from_branch": "needs_human", "description": "It decided a person must handle this. The AI won't act on it."},
        {"from": "lookup", "to": "answer"},
        {"from": "answer", "to": "answer_check"},
        {"from": "answer_check", "to": "reply", "from_branch": "passed", "description": "The answer held up, so it's sent."},
        {"from": "escalate", "to": "reply"},
    ],
    "sources": [
        {"id": "docs", "title": "Help docs", "kind": "documents", "count": len(DOCS),
         "description": "The only pages it can look things up in. It can't see your account, your billing or your messages.",
         "items": [{"id": i, "title": t} for i, t in DOCS]},
        {"id": "message", "title": "The message", "kind": "message", "description": "Only the message itself, not earlier conversations."},
    ],
    "actions": [{"id": "route_to_security", "title": "Hand it to security on-call", "description": "Only after a person confirms."}],
    "never": ["Change a password or email itself", "Read anything beyond the message and the help docs"],
    "panels": [
        {"id": "triage", "title": "Triage (story panel)", "plain_title": "Who it went to", "event_types": ["decision"], "nodes": ["triage"], "story": True},
        {"id": "docs", "title": "Docs found (declared fields)", "event_types": ["retrieval"], "audience": "engineering",
         "fields": [{"key": "query", "label": "query"}, {"key": "hits", "label": "hits", "format": "json"}]},
        {"id": "gate", "title": "Escalation", "event_types": ["gate_waiting", "gate_resolved"], "mode": "append", "audience": "engineering"},
        {"id": "llm", "title": "Model calls", "event_types": ["llm_call"], "mode": "append", "audience": "engineering"},
    ],
    "story": True,
}

STORY = r"""
BenchStory.register('hello-agent', {
  panels: {
    // A story panel: the app decides how its own decision reads. ctx.mode lets one panel read
    // two ways: Presentation drops the model's self-reported confidence (it isn't accuracy).
    triage: function (events, ctx) {
      var d = events[events.length - 1].data, h = ctx.h;
      var where = '<div style="font-size:13px;margin-bottom:6px">Sent to <b style="color:var(--accent)">' +
        h.esc(String(d.branch).replace('_', ' ')) + '</b></div>';
      if (ctx.mode === 'presentation') return where;
      var pct = Math.round((d.confidence || 0) * 100);
      return where +
        '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--accent-2),var(--accent))"></div></div>' +
        '<div class="note">' + pct + '% confident (the model’s own estimate, not measured accuracy) · ' + h.esc(d.rationale) + '</div>';
    }
  }
});
"""


def run(run_id: str, t0: float, branch: str) -> list[dict]:
    ev, t = [], t0
    mode = "full" if branch == "answerable" else "redacted"

    def e(node, et, data=None, dt=0.0):
        nonlocal t
        t += dt
        ev.append({"v": "bench/0", "session_id": "example", "run_id": run_id, "seq": len(ev), "ts": round(t, 3),
                   "node": node, "event_type": et, "content_mode": mode, "data": data or {},
                   **({"step_id": f"{run_id}:{node}"} if node != "_run" else {})})

    q = "How do I reset my password?" if branch == "answerable" else "Someone is logged into my account ([email]) and it isn't me."
    e("_run", "run_started", {"input": q, "origin": "example", "requester": {"name": "Sam (example)", "role": "customer"}})
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
        e("lookup", "retrieval", {"source": "docs", "query": "reset password", "hits": [
            {"id": "doc-3", "title": "Resetting your password", "score": 0.82, "text": DOC_TEXT["doc-3"]},
            {"id": "doc-9", "title": "Two-factor setup", "score": 0.41, "text": DOC_TEXT["doc-9"]}]}, 0.03)
        e("lookup", "step_finished", {"status": "ok", "latency_ms": 31}, 0.001)
        e("answer", "step_started")
        out = "Go to Settings → Security → Reset password; a link arrives by email within a minute."
        # Only doc-3 goes into the prompt: doc-9 was found by the search but never given to the AI.
        e("answer", "llm_call", {"model": "example-model", "provider": "example", "input_tokens": 1400, "output_tokens": 120,
                                 "cost_usd": 0.0024, "cost_source": "estimated", "cost_basis": "made-up prices for the example",
                                 "latency_ms": 1180,
                                 "system": "Answer using only the docs below. Be brief.\n\n[doc-3] " + DOC_TEXT["doc-3"],
                                 "messages": [{"role": "user", "content": q}],
                                 "output": out}, 1.18)
        e("answer", "decision", {"cited": ["doc-3"], "rationale": "The reset steps are in the password page."})
        e("answer", "step_finished", {"status": "ok", "latency_ms": 1181, "timings": {"prompt": 6, "model": 1175}}, 0.001)
        e("answer_check", "step_started")
        e("answer_check", "check_result", {"name": "answer_check", "passed": True, "state": "passed", "kind": "grounding",
                                           "detail": "every step in the answer appears in the password page.", "evidence": ["doc-3"]}, 0.002)
        e("answer_check", "decision", {"branch": "passed"})
        e("answer_check", "step_finished", {"status": "ok", "latency_ms": 2}, 0.001)
        outcome = "answered"
    else:
        e("escalate", "step_started")
        e("escalate", "gate_waiting", {"reason": "security incident", "proposed": {"title": "Hand to security on-call", "route_to": "security on-call"}}, 0.01)
        e("escalate", "gate_resolved", {"approved": True, "by": "on-call (example)", "via": "the app"}, 2.4)
        e("escalate", "step_finished", {"status": "ok", "latency_ms": 2410}, 0.001)
        out = "A person from security is taking this now."
        outcome = "handed_off"
    e("reply", "step_started")
    e("reply", "step_finished", {"status": "ok", "latency_ms": 2}, 0.002)
    e("_run", "run_finished", {"status": "ok", "output": out, "outcome": outcome,
                               "baseline": "~5 min" if branch == "answerable" else "~15 min"})
    return ev


def main() -> None:
    for name, branch, t0, title, group in (
            ("hello-answer", "answerable", 1790600000.0, "How do I reset my password?", "It answers"),
            ("hello-escalate", "needs_human", 1790600100.0, "Someone is logged into my account", "It hands it to a person")):
        header = {"v": "bench-recording/0", "topology": TOPOLOGY, "story": STORY.strip(), "title": title, "group": group}
        rows = [header] + run(f"{name}-1", t0, branch)
        (HERE / f"{name}.recording.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (HERE / "hello-agent.topology.json").write_text(json.dumps(TOPOLOGY, indent=2) + "\n")
    (HERE / "hello-agent.story.js").write_text(STORY.strip() + "\n")
    print("wrote examples/hello-*.recording.jsonl, hello-agent.topology.json, hello-agent.story.js")


if __name__ == "__main__":
    main()

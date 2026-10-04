// Viewer logic tests: node --test tests/js/*.test.js  (Node 22+, no dependencies)
// Fixtures: the bench's own hello-agent recordings, and the helpdesk's real recordings
// (read-only; they may be in the old shape or the 10-03 shape, and both must work).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../../viewer/logic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const HELPDESK = path.resolve(ROOT, '../agent-lab/request-queue/demo/bench-recordings');

function load(p) {
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const header = rows[0] && rows[0].v === 'bench-recording/0' ? rows.shift() : null;
  return { header, topo: header && header.topology, events: L.sortEvents(rows.map(L.normalizeEvent)) };
}
const hello = (n) => load(path.join(ROOT, 'examples', n + '.recording.jsonl'));
const desk = (n) => load(path.join(HELPDESK, n + '.recording.jsonl'));
const haveDesk = fs.existsSync(HELPDESK);
function runOf(events) { const r = L.newRun('r'); events.forEach((e) => L.reduce(r, e, 0)); return r; }

// ---- modes ----------------------------------------------------------------------------------
test('mode precedence: ?mode= beats stored beats the source default', () => {
  assert.equal(L.resolveMode({ param: 'engineering', stored: 'presentation', source: 'replay' }).mode, 'engineering');
  assert.equal(L.resolveMode({ param: 'bogus', stored: 'engineering', source: 'replay' }).mode, 'engineering');
  assert.equal(L.resolveMode({ stored: 'presentation', source: 'live' }).mode, 'presentation');
});
test('mode defaults by source: replay and parent present, live engineers', () => {
  assert.equal(L.resolveMode({ source: 'replay' }).mode, 'presentation');
  assert.equal(L.resolveMode({ source: 'parent' }).mode, 'presentation');
  assert.equal(L.resolveMode({ source: 'live' }).mode, 'engineering');
});
test('old bench.view values migrate', () => {
  assert.deepEqual(L.resolveMode({ legacy: 'overview', source: 'live' }), { mode: 'presentation', from: 'legacy', migrate: 'presentation' });
  assert.equal(L.resolveMode({ legacy: 'detailed', source: 'replay' }).mode, 'engineering');
  assert.equal(L.resolveMode({ legacy: 'detailed', stored: 'presentation' }).mode, 'presentation');
  assert.equal(L.resolveMode({ legacy: 'junk', source: 'replay' }).migrate, null);
});

// ---- events ---------------------------------------------------------------------------------
test('check is an alias of check_result in the viewer too', () => {
  const ev = { event_type: 'check', node: 'x', data: { name: 'a', passed: true } };
  assert.equal(L.normalizeEvent(ev).event_type, 'check_result');
  assert.equal(ev.event_type, 'check');   // the input isn't mutated
});
test('sorting: ts, then seq, then run before step before content', () => {
  const evs = [
    { ts: 2, seq: 1, event_type: 'step_finished' }, { ts: 2, seq: 0, event_type: 'step_started' },
    { ts: 1, event_type: 'llm_call' }, { ts: 1, event_type: 'run_started' }];
  assert.deepEqual(L.sortEvents(evs).map((e) => e.event_type), ['run_started', 'llm_call', 'step_started', 'step_finished']);
});

// ---- reduce, Level 0 ordering ---------------------------------------------------------------
test('explicit step boundaries skip implicit inference', () => {
  const evs = [
    { run_id: 'r', ts: 1, node: 'a', event_type: 'step_started', step_id: 'a1' },
    { run_id: 'r', ts: 2, node: 'b', event_type: 'step_started', step_id: 'b1' },
    { run_id: 'r', ts: 3, node: 'b', event_type: 'step_finished', step_id: 'b1', data: { status: 'ok' } },
    { run_id: 'r', ts: 4, node: 'a', event_type: 'step_finished', step_id: 'a1', data: { status: 'ok' } }];
  const r = runOf(evs);
  assert.equal(r.steps.a1.end, 4);   // not closed early when b arrived
  assert.equal(r.steps.a1.inferred, false);
});
test('implicit boundaries still apply to runs without step_started', () => {
  const r = runOf([
    { run_id: 'r', ts: 1, node: 'a', event_type: 'llm_call', data: {} },
    { run_id: 'r', ts: 3, node: 'b', event_type: 'decision', data: {} }]);
  const a = r.steps[r.nodeSteps.a[0]];
  assert.equal(a.end, 1); assert.equal(a.inferred, true);
});
test('a late run_started or an earlier event triggers a re-sort', () => {
  const r = runOf([{ run_id: 'r', ts: 5, node: 'a', event_type: 'step_started', step_id: 'a1' }]);
  const late = { run_id: 'r', ts: 1, node: '_run', event_type: 'run_started', data: { input: 'hi' } };
  assert.equal(L.needsResort(r, late), true);
  const fresh = L.rebuildRun(r, late, 0);
  assert.equal(fresh.events[0].event_type, 'run_started');
  assert.equal(fresh.input, 'hi');
  assert.equal(L.needsResort(fresh, { ts: 9, event_type: 'step_finished' }), false);
});

// ---- the cursor -----------------------------------------------------------------------------
test('visits are node visits, children folded in', () => {
  const { events } = hello('hello-answer');
  assert.deepEqual(L.visits(events).map((v) => v.node), ['receive', 'triage', 'lookup', 'answer', 'answer_check', 'reply']);
});
test('cursor stops: every visit for stepping; moments for auto-pause; the end always', () => {
  const { events, topo } = hello('hello-answer');
  const s = L.cursorStops(events, topo);
  const vs = L.visits(events);
  // A branching node's stop takes in the next visit's step_started, so the path it took is known
  // (the branch is derived from what ran next); every other visit stops at its own last event.
  const branching = (v) => L.hasBranches(topo, v.node);
  const want = vs.map((v, i) => (branching(v) && vs[i + 1] && events[vs[i + 1].first].event_type === 'step_started') ? vs[i + 1].first : v.last);
  assert.deepEqual(s.steps, want.concat([events.length - 1]).filter((x, i, a) => a.indexOf(x) === i));
  const momentNodes = s.moments.slice(0, -1).map((i) => events[i].node);
  // a decision with branches (its stop is the next step's start), a check (likewise: it branches)
  assert.deepEqual(momentNodes, ['lookup', 'reply']);
  assert.deepEqual(s.moments.slice(0, -1).map((i) => events[i].event_type), ['step_started', 'step_started']);
  assert.equal(s.moments.at(-1), events.length - 1);
  assert.equal(L.nextStop(s.steps, -1), s.steps[0]);
  assert.equal(L.prevStop(s.steps, s.steps[0]), -1);
});
test('declared moments win, and a gate pauses at "waiting" too', () => {
  const { events, topo } = hello('hello-escalate');
  const s = L.cursorStops(events, topo);
  const at = s.moments.map((i) => events[i].event_type + '@' + events[i].node);
  assert.ok(at.includes('gate_waiting@escalate'), at.join());
  assert.ok(!at.some((x) => x.endsWith('@receive')), 'receive is not a moment');
  const declared = L.momentNodes({ nodes: [{ id: 'a', kind: 'check' }, { id: 'b', moment: true }], edges: [] });
  assert.deepEqual(Object.keys(declared), ['b']);   // declared moments replace the defaults
});

// ---- narration ------------------------------------------------------------------------------
test('preview (extracted from bench.js) keeps the engineering line and plain presentation line', () => {
  const r = runOf(hello('hello-answer').events);
  const steps = (n) => r.nodeSteps[n].map((id) => r.steps[id]);
  assert.equal(L.preview(steps('triage'), 'engineering'), '→ answerable');
  assert.match(L.preview(steps('answer'), 'engineering'), /^“Go to Settings/);
  assert.equal(L.preview(steps('answer'), 'presentation'), '');
  assert.equal(L.preview(steps('lookup'), 'presentation', 12), '2 of 12');
  assert.equal(L.preview(steps('answer_check'), 'presentation', null, true), '✓ passed');
  assert.equal(L.preview(steps('answer_check'), 'presentation'), '→ passed');   // not a check node: the branch wins
});
test('NOW card: note, then the taken edge, then the reason; no confidence', () => {
  const { events, topo } = hello('hello-escalate');
  const n = L.narrate(topo, events, 'triage', { finished: true });
  assert.deepEqual(n.lines.map((l) => l.kind), ['note', 'edge', 'why']);
  assert.match(n.lines[1].text, /a person must handle this/);
  assert.equal(n.actor, 'ai');
  assert.ok(!JSON.stringify(n).match(/0\.97|97%|confiden/));
});
test('NOW card: a check node not on the path says "not needed"', () => {
  const { events, topo } = hello('hello-escalate');
  const n = L.narrate(topo, events, 'answer_check', { finished: true });
  assert.match(n.lines.at(-1).text, /Not needed/);
  assert.equal(L.narrate(topo, events, 'lookup', { finished: true }).lines.at(-1).text, 'This step didn’t run this time.');
  assert.equal(L.narrate(topo, events, 'lookup', { finished: false }).lines.at(-1).text, 'Not reached yet.');
});
test('NOW card fallback lines only for unmapped (Level 0) steps', () => {
  const events = [
    { node: 'x', event_type: 'decision', ts: 1, data: { branch: 'go_left', rationale: 'because' } },
    { node: 'x', event_type: 'gate_waiting', ts: 2, data: { proposed: { title: 'Do it' } } },
    { node: 'x', event_type: 'error', ts: 3, data: { message: 'boom' } },
    { node: 'x', event_type: 'retrieval', ts: 4, data: { hits: [{ id: 'a', title: 'A' }] } }];
  const txt = L.narrate(null, events, 'x').lines.map((l) => l.text);
  assert.deepEqual(txt, ['Chose: go left.', 'because', '⏸ Waiting for a person to approve: Do it', 'Something went wrong: boom', 'Found 1: A']);
  assert.equal(L.narrate(null, events, 'x').actor, 'app');
});
test('actor defaults from kind', () => {
  assert.equal(L.actorOf({ kind: 'llm' }), 'ai'); assert.equal(L.actorOf({ kind: 'gate' }), 'person');
  assert.equal(L.actorOf({ kind: 'check' }), 'rule'); assert.equal(L.actorOf({ kind: 'tool' }), 'app');
  assert.equal(L.actorOf({ kind: 'llm', actor: 'rule' }), 'rule');
});

// ---- sources --------------------------------------------------------------------------------
test('sources: given is verified by substring, found-only stays found, relied from evidence', () => {
  const { events, topo } = hello('hello-answer');
  const docs = L.sourceStates(topo, events).find((s) => s.id === 'docs');
  const st = Object.fromEntries(docs.items.map((i) => [i.id, i.state + (i.relied ? '+relied' : '')]));
  assert.equal(st['doc-3'], 'given+relied');
  assert.equal(st['doc-9'], 'found');          // found by the search, never in a prompt
  assert.equal(st['doc-1'], 'could');
  assert.equal(docs.line, 'Given 1 of 12 · its answer rests on 1');
});
test('sources: no prompt text means "search found", context_items is only a hint', () => {
  const topo = { sources: [{ id: 's', title: 'S', kind: 'documents', description: '', items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }] };
  const events = [
    { node: 'r', event_type: 'retrieval', ts: 1, data: { source: 's', hits: [{ id: 'a', title: 'A', text: 'alpha text here' }] } },
    { node: 'm', event_type: 'llm_call', ts: 2, content_mode: 'redacted', data: { context_items: ['a'] } }];
  const s = L.sourceStates(topo, events)[0];
  assert.equal(s.items[0].state, 'found'); assert.equal(s.items[0].hinted, true);
  assert.equal(s.line, 'Search found 1 of 2');
});
test('sources: a hit no declared source owns lands in "What the search found"', () => {
  const s = L.sourceStates(null, [{ node: 'r', event_type: 'retrieval', ts: 1, data: { hits: [{ id: 'z', title: 'Z' }] } }]);
  assert.equal(s[0].id, '_search'); assert.equal(s[0].found, 1);
  assert.equal(L.sourcesLine([]), 'The app doesn’t say what it can see.');
});

// ---- checks ---------------------------------------------------------------------------------
test('checks: passed, not on the path, and the app copy', () => {
  const a = hello('hello-answer'), e = hello('hello-escalate');
  assert.equal(L.checkStates(a.topo, a.events, true)[0].line, '✓ Passed: every step in the answer appears in the password page.');
  const off = L.checkStates(e.topo, e.events, true)[0];
  assert.equal(off.state, 'not_on_path'); assert.match(off.line, /^– Not needed/);
  assert.equal(L.checkStates(e.topo, e.events, false)[0].state, 'pending');
});
test('checks: trust passed over state; not_on_path from state; named checks on other nodes', () => {
  const topo = { nodes: [{ id: 'c', kind: 'check', plain_label: 'Rules' }, { id: 'k', kind: 'llm' }] };
  const ev = (node, data) => ({ node, event_type: 'check_result', ts: 1, data });
  const rows = L.checkStates(topo, [ev('c', { name: 'rules', passed: false, state: 'passed', detail: 'nope' }), ev('k', { name: 'unsure', label: 'Unsure-check', passed: true })], true);
  assert.equal(rows[0].state, 'failed'); assert.equal(rows[0].line, '✕ Didn’t pass. nope');
  assert.equal(rows[1].label, 'Unsure-check'); assert.equal(rows[1].state, 'passed');
  assert.equal(L.checkStates(topo, [ev('c', { name: 'r', passed: true, state: 'not_on_path' })], true)[0].state, 'not_on_path');
});
test('a check node entered without a check_result reads as ran, or checking', () => {
  const topo = { nodes: [{ id: 'c', kind: 'check' }] };
  assert.equal(L.checkStates(topo, [{ node: 'c', event_type: 'step_started', ts: 1 }], false)[0].state, 'running');
  assert.equal(L.checkStates(topo, [{ node: 'c', event_type: 'step_finished', ts: 1, data: {} }], false)[0].state, 'ran');
});

test('checks: the helpdesk\'s x-not-needed line is the "not needed" copy', () => {
  const topo = { nodes: [{ id: 'g', kind: 'check', 'x-not-needed': 'Not needed this time: no answer written.' }] };
  assert.equal(L.checkStates(topo, [], true)[0].line, 'Not needed this time: no answer written.');
});
test('sources: a decision\'s citations don\'t count as relied on when a check in its step failed', () => {
  const topo = { sources: [{ id: 's', title: 'S', kind: 'documents', description: '', items: [{ id: 'a', title: 'A' }] }] };
  const base = [{ node: 'r', event_type: 'retrieval', ts: 1, data: { source: 's', hits: [{ id: 'a', title: 'A' }] } }];
  const dec = { node: 'g', step_id: 'x:g:1', event_type: 'decision', ts: 2, data: { branch: 'fail', cited: ['a'] } };
  const chk = (passed) => ({ node: 'g', step_id: 'x:g:1', event_type: 'check_result', ts: 2, data: { name: 'grounding', passed } });
  assert.ok(!L.sourceStates(topo, base.concat([dec, chk(false)]))[0].items[0].relied);
  assert.ok(L.sourceStates(topo, base.concat([dec, chk(true)]))[0].items[0].relied);
});

// ---- who signed off, time, cost -------------------------------------------------------------
test('gate states', () => {
  const e = hello('hello-escalate'), a = hello('hello-answer');
  assert.match(L.gateState(e.topo, e.events, true).line, /^✓ Approved by on-call \(example\), \d+:\d\d (AM|PM): Hand to security on-call$/);
  assert.equal(L.gateState(a.topo, a.events, true).state, 'not_needed');
  assert.equal(L.gateState({ nodes: [] }, [], true).line, 'The app declares no sign-off step.');
  const w = e.events.filter((x) => x.event_type !== 'gate_resolved');
  assert.match(L.gateState(e.topo, w, false).line, /^⏸ Waiting for a person to approve/);
});
test('time split separates AI work from waiting for a person', () => {
  const e = hello('hello-escalate');
  const s = L.timeSplit(e.events);
  assert.equal(s.gated, true);
  assert.ok(Math.abs(s.waiting - 2.4) < 0.01, String(s.waiting));
  assert.ok(Math.abs(s.work + s.waiting - s.total) < 1e-9);
  assert.match(L.timeLine(s), /^AI work: .* · waiting for a person: 2\.4 s$/);
  assert.match(L.timeLine(L.timeSplit(hello('hello-answer').events)), /^Took 1\.9 s$/);
  const open = e.events.filter((x) => x.event_type !== 'gate_resolved' && x.event_type !== 'run_finished' && x.node !== 'reply' && !(x.node === 'escalate' && x.event_type === 'step_finished'));
  const t1 = Math.max(...open.map((x) => x.ts));
  assert.ok(Math.abs(L.timeSplit(open, t1 + 30).waiting - (t1 + 30 - open.find((x) => x.event_type === 'gate_waiting').ts)) < 1e-6);
});
test('cost in words', () => {
  assert.equal(L.costWords(0), 'no AI cost');
  assert.equal(L.costWords(0.0035), 'less than a cent');
  assert.equal(L.costWords(0.011), 'about 1¢');
  assert.equal(L.costWords(0.07), 'about 7¢');
  assert.equal(L.costWords(1.234), 'about $1.23');
  assert.equal(L.baselineOf([{ event_type: 'run_finished', data: { baseline: 'manual: ~3–5 min' } }]), '~3–5 min');
});
test('outcome in audit words, with a Why when a person ends up with it', () => {
  const a = hello('hello-answer'), e = hello('hello-escalate');
  assert.deepEqual(L.outcome(a.topo, a.events), { done: true, text: 'Answered', why: null });
  const o = L.outcome(e.topo, e.events);
  assert.equal(o.text, 'Handed to a person'); assert.match(o.why, /account takeover/);
  assert.equal(L.outcome(a.topo, a.events.filter((x) => x.event_type !== 'run_finished')).text, 'Working…');
});

// ---- privacy --------------------------------------------------------------------------------
test('the privacy line never claims what the AI saw unless the app says so', () => {
  const masked = [{ event_type: 'llm_call', data: { messages: [{ role: 'user', content: 'mail me at [email]' }] } }];
  const line = L.privacyLine({ app: {} }, masked);
  assert.ok(line && !/before the AI/i.test(line) && !/the AI (saw|sees)/i.test(line), line);
  assert.equal(L.privacyLine({ app: { privacy_note: 'X' } }, masked), 'X');
  assert.equal(L.privacyLine({ app: {} }, [{ event_type: 'llm_call', data: { messages: [{ role: 'user', content: 'plain' }] } }]), null);
  for (const n of ['hello-answer', 'hello-escalate']) {
    const { topo, events } = hello(n);
    const l = L.privacyLine({ app: {} }, events);
    assert.ok(l == null || !/before the AI/i.test(l));
  }
  assert.equal(L.contentModeWords({ absent: true }), 'prompts: not captured');
});

// ---- the overlay ----------------------------------------------------------------------------
test('highlight segments find retrieved text in the raw prompt and never drift on escaping', () => {
  const segs = L.highlightSegments('a <b> & HELLO WORLD TEXT tail', [{ id: 'h', text: 'HELLO WORLD TEXT', title: 'H' }]);
  assert.deepEqual(segs.map((s) => [s.text, !!s.hit]), [['a <b> & ', false], ['HELLO WORLD TEXT', true], [' tail', false]]);
  const { topo, events } = hello('hello-answer');
  const calls = L.givenBlocks(topo, events);
  assert.deepEqual(calls[1].blocks.map((b) => b.label), ['Its instructions', 'What the app sent it', 'What it answered']);
  const hit = calls[1].blocks[0].segments.find((s) => s.hit);
  assert.equal(hit.hit.id, 'doc-3'); assert.equal(hit.hit.source, 'Help docs');
});

// ---- helpers (a story's ctx.h) --------------------------------------------------------------
test('presentation helpers drop tokens, scores, model ids and confidence', () => {
  const h = L.helpersFor('presentation');
  const llm = h.generic({ node: 'n', event_type: 'llm_call', data: { model: 'm-1', input_tokens: 10, output_tokens: 2, cost_usd: 0.1 } });
  assert.ok(!/m-1|10 in|\$/.test(llm), llm);
  const dec = h.generic({ node: 'n', event_type: 'decision', data: { branch: 'x', confidence: 0.9, score: 3 } });
  assert.ok(!/0\.9|confidence|score/.test(dec), dec);
  assert.match(L.helpersFor('engineering').generic({ node: 'n', event_type: 'decision', data: { confidence: 0.9 } }), /own estimate, not measured accuracy/);
});

// ---- Level 0: the inferred map --------------------------------------------------------------
test('inferMap: nodes by first start, edges by sibling order, LLM spans keyed by operation', () => {
  const ev = (node, ts, sid, parent, et = 'step_started', data = {}) => ({ run_id: 'r', node, ts, step_id: sid, parent_step_id: parent, event_type: et, data });
  const events = [
    ev('_run', 0, null, null, 'run_started'),
    ev('chat gpt-4o', 1, 's1', null), ev('chat gpt-4o', 1.5, 's1', null, 'llm_call'),
    ev('execute_tool search', 2, 's2', null), ev('retrieve', 2.1, 's3', 's2', 'retrieval', { hits: [] }),
    ev('chat gpt-4o-mini', 3, 's4', null), ev('chat gpt-4o-mini', 3.1, 's4', null, 'llm_call')];
  const m = L.inferMap(events, 'toy', 'Toy');
  assert.equal(m.inferred, true); assert.equal(m.app.description, 'map inferred from the trace');
  assert.deepEqual(m.nodes.map((n) => n.id + ':' + n.kind), ['chat:llm', 'execute_tool search:step', 'retrieve:retrieval']);
  assert.deepEqual(m.edges.map((e) => e.from + '>' + e.to).sort(), ['chat>execute_tool search', 'execute_tool search>chat', 'execute_tool search>retrieve'].sort());
  assert.equal(L.canonicalNode('chat claude-x'), 'chat'); assert.equal(L.canonicalNode('execute_tool x'), 'execute_tool x');
});

// ---- the helpdesk's real recordings, either shape ------------------------------------------
test('helpdesk recordings: every derived view works on every recording', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const files = fs.readdirSync(HELPDESK).filter((f) => f.endsWith('.recording.jsonl'));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const { topo, events } = load(path.join(HELPDESK, f));
    const blob = JSON.stringify([
      L.sourceStates(topo, events).map((s) => s.line), L.checkStates(topo, events, true), L.gateState(topo, events, true),
      L.outcome(topo, events), L.timeLine(L.timeSplit(events)), L.costWords(L.runCost(events)),
      topo.nodes.map((n) => L.narrate(topo, events, n.id, { finished: true })), L.givenBlocks(topo, events).length]);
    assert.ok(!/undefined|NaN|\[object Object\]/.test(blob), f + ': ' + blob.match(/.{40}(undefined|NaN|\[object Object\]).{40}/));
    const s = L.cursorStops(events, topo);
    assert.equal(s.moments.at(-1), events.length - 1, f);
    const hb = L.sourceStates(topo, events).find((x) => x.found);
    assert.ok(hb && hb.found === 4, f + ': four handbook sections found');
    if (events.some((e) => e.event_type === 'llm_call' && e.data.messages)) assert.ok(hb.given > 0, f + ': hits verified in the prompt');
  }
});
test('helpdesk: outcomes read right for each kind of run', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const t = (n) => { const r = desk(n); return L.outcome(r.topo, r.events).text; };
  assert.equal(t('req-005'), 'Answered');
  assert.match(t('req-012-approved'), /^Done.*approved by a person$/);
  assert.match(t('req-012-denied'), /a person said no/);
  assert.equal(t('req-019'), 'Handed to a person');
  const r = desk('req-019');
  assert.ok(L.outcome(r.topo, r.events).why, 'escalations carry a Why');
  const a = desk('req-012-approved');
  assert.equal(L.outcome(a.topo, a.events).why, null, 'an approved ticket needs no Why');
  const d = desk('req-012-denied');
  assert.equal(L.gateState(d.topo, d.events, true).state, 'denied');
});

// ---- 10-03 fixes (usability round 4) ---------------------------------------------------------
// An OTLP run: the root agent span is the run, not a step, and every step names it as parent.
function otlpRun() {
  const e = (node, et, ts, sid, data) => ({ v: 'bench/0', run_id: 'o', ts, node, event_type: et, step_id: sid, parent_step_id: sid ? 'root' : undefined, data: data || {} });
  return [
    e('chat a', 'step_started', 1, 's1'), e('chat a', 'llm_call', 1.2, 's1', { model: 'fake', input_tokens: 5, output_tokens: 2 }), e('chat a', 'step_finished', 1.2, 's1', { status: 'ok' }),
    e('execute_tool t', 'step_started', 1.3, 's2'), e('execute_tool t', 'tool_call', 1.4, 's2', { tool: 't' }), e('execute_tool t', 'step_finished', 1.4, 's2', { status: 'ok' }),
    { v: 'bench/0', run_id: 'o', ts: 1, node: '_run', event_type: 'run_started', data: { via: 'otlp', input: 'q' } },
    { v: 'bench/0', run_id: 'o', ts: 1.5, node: '_run', event_type: 'run_finished', data: { status: 'ok', outcome: 'inside the 30-day window' } }];
}
test('OTLP: children of the root agent span are top-level steps (they light, and NOW follows them)', () => {
  const events = L.sortEvents(otlpRun());
  const run = runOf(events);
  const top = run.stepOrder.map((sid) => run.steps[sid]).filter((s) => !s.parent).map((s) => s.node);
  assert.deepEqual(top, ['chat a', 'execute_tool t']);
  assert.deepEqual(L.visits(events).map((v) => v.node), ['chat a', 'execute_tool t']);
  assert.ok(L.takenEdges({ edges: [] }, events)['chat a>execute_tool t']);
  assert.equal(L.narrate({ nodes: [] }, events, 'chat a', { finished: true }).ran, true);
  assert.notEqual(L.narrate({ nodes: [] }, events, 'chat a', { finished: true }).lines[0].text, 'This step didn’t run this time.');
  // A real parent step still nests its child.
  const n = [{ run_id: 'n', ts: 1, node: 'p', event_type: 'step_started', step_id: 'p1', data: {} },
             { run_id: 'n', ts: 2, node: 'c', event_type: 'step_started', step_id: 'c1', parent_step_id: 'p1', data: {} }];
  assert.equal(runOf(n).steps.c1.parent, 'p1');
});
test('outcome: free text passes through verbatim; outcome words become plain', () => {
  assert.equal(L.outcome({ nodes: [] }, otlpRun()).text, 'inside the 30-day window');
  const fin = (o) => [{ run_id: 'x', ts: 1, node: '_run', event_type: 'run_finished', data: { status: 'ok', outcome: o } }];
  assert.equal(L.outcome({ nodes: [] }, fin('handed_off')).text, 'Handed to a person');
  assert.equal(L.outcome({ nodes: [] }, fin('self-service')).text, 'Self service');
});
test('cost: calls with tokens and no price are unknown, never free', () => {
  const c = (cost, model) => ({ event_type: 'llm_call', data: Object.assign({ model: model || 'm', input_tokens: 10 }, cost == null ? {} : { cost_usd: cost }) });
  assert.equal(L.costLine(L.costInfo([c(null, 'fake-gpt')])), 'AI cost not known');
  assert.deepEqual(L.costInfo([c(null, 'fake-gpt')]).unpriced, ['fake-gpt']);
  assert.equal(L.costLine(L.costInfo([c(0.01)])), 'about 1¢ of AI');
  assert.match(L.costLine(L.costInfo([c(0.01), c(null)])), /^at least about 1¢ of AI \(some calls/);
  assert.equal(L.costLine(L.costInfo([])), '');
});
test('the inferred map keeps an agent name in an LLM node id, and folds only a model name', () => {
  assert.equal(L.canonicalNode('chat refund_triage'), 'chat refund_triage');
  assert.equal(L.canonicalNode('chat gpt-4o-mini'), 'chat');
  assert.equal(L.canonicalNode('chat claude-sonnet-4-5'), 'chat');
});
test('helpdesk: decided gates drop the waiting line; hand-offs say who owns it now; no Why on a denial', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const a = desk('req-012-approved');
  const n = L.narrate(a.topo, a.events, 'approval_gate', { finished: true });
  assert.ok(!n.lines.some((l) => /Waiting for a person/.test(l.text)), JSON.stringify(n.lines));
  assert.ok(n.lines.some((l) => /Approved by/.test(l.text)));
  const h = desk('req-020');
  assert.equal(L.gateState(h.topo, h.events, true).state, 'handed');
  assert.match(L.gateState(h.topo, h.events, true).line, /handed to a person/);
  const d = desk('req-012-denied');
  assert.equal(L.outcome(d.topo, d.events).why, null);
  // Fill in a ticket is told only the message: its own line says so, whatever the run's row says.
  const t = L.narrate(a.topo, a.events, 'propose_action', { finished: true });
  assert.ok(t.lines.some((l) => l.kind === 'given' && /none of it/.test(l.text)), JSON.stringify(t.lines));
  const c = L.narrate(a.topo, a.events, 'classify', { finished: true });
  assert.ok(c.lines.some((l) => l.kind === 'given' && /given 4 of 16/.test(l.text)), JSON.stringify(c.lines));
});
test('the overlay: the answer form from params.json_schema, and a JSON answer as rows', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const a = desk('req-012-approved');
  const calls = L.givenBlocks(a.topo, a.events);
  const ticket = calls.find((c) => c.node === 'propose_action');
  const form = ticket.blocks.find((b) => b.role === 'form');
  assert.ok(form && form.fields.some((f) => f.name === 'action_type' && f.description), 'the action_type description is shown');
  const out = ticket.blocks.find((b) => b.role === 'output');
  assert.ok(out.answer && out.answer.some((r) => r.name === 'title' && /JetBrains/.test(r.value)));
  assert.equal(L.answerFields('plain text'), null);
  assert.equal(L.answerFields('{"a": {"b": 1}}'), null);
});

// ---- polish (10-03): check words, the reply said once, inferred names ----------------------------
test('check_words: a check\'s own state words show in the Checks row, the NOW card and the node box', () => {
  const topo = { nodes: [{ id: 'classify', kind: 'llm' }], edges: [],
                 check_words: { unsure: { passed: 'Didn\'t trigger', failed: 'Triggered: sent to a person' } } };
  const ev = (passed, detail) => L.normalizeEvent({ v: 'bench/0', run_id: 'r', seq: 1, ts: 1, node: 'classify', event_type: 'check_result',
    data: { name: 'unsure', label: 'Low-confidence check', passed, detail } });
  const ok = [ev(true, 'The AI was sure enough of its choice.')], bad = [ev(false, 'The AI wasn\'t confident enough in its choice.')];
  assert.equal(L.checkStates(topo, ok, true)[0].line, '✓ Didn\'t trigger.');
  assert.equal(L.checkStates(topo, bad, true)[0].line, '✕ Triggered: sent to a person. The AI wasn\'t confident enough in its choice.');
  const n = L.narrate(topo, ok, 'classify', { finished: true });
  assert.ok(n.lines.some((l) => l.text === 'Low-confidence check: ✓ Didn\'t trigger. The AI was sure enough of its choice.'), JSON.stringify(n.lines));
  // No words declared: the old fallbacks.
  const plain = { nodes: topo.nodes, edges: [] };
  assert.equal(L.checkStates(plain, ok, true)[0].line, '✓ Passed.');
  assert.equal(L.checkStates(plain, bad, true)[0].line, '✕ Didn’t pass. The AI wasn\'t confident enough in its choice.');
});
test('helpdesk: the low-confidence check never says "Passed" anywhere', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  for (const name of ['req-020', 'req-012-approved', 'req-005']) {
    const r = desk(name);
    // The library's helpdesk names this check `confidence_check` (its words travel with it).
    const row = L.checkStates(r.topo, r.events, true).find((c) => c.id === 'confidence_check');
    assert.ok(row, name);
    assert.doesNotMatch(row.line, /Passed/);
    assert.match(row.line, /Didn't trigger|Triggered: sent to a person/);
    const n = L.narrate(r.topo, r.events, 'classify', { finished: true });
    const line = n.lines.find((l) => /Confidence check/i.test(l.text));
    assert.ok(line && /Didn't trigger|Triggered/.test(line.text) && !/Passed/.test(line.text), JSON.stringify(n.lines));
  }
});
test('NOW card: a line the reply already quotes isn\'t said twice (req-020\'s hand-off)', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const h = desk('req-020');
  const fin = h.events.find((e) => e.event_type === 'run_finished');
  // The run's output is the graph's final state: the reply is its response field.
  const reply = fin && fin.data && L.replyOf(fin.data.output);
  assert.ok(reply, 'req-020 has a reply');
  const n = L.narrate(h.topo, h.events, 'handoff', { finished: true, reply, last: 'handoff' });
  const count = n.lines.filter((l) => /Escalated for human review/.test(l.text)).length;
  assert.equal(count, 1, JSON.stringify(n.lines));
  assert.equal(n.lines[n.lines.length - 1].kind, 'reply');
});
test('inferred maps: Presentation names from the operation, the raw id stays the label', () => {
  assert.equal(L.inferredLabel('execute_tool search_handbook'), 'Tool: search handbook');
  assert.equal(L.inferredLabel('retrieval handbook'), 'Search: handbook');
  assert.equal(L.inferredLabel('chat'), 'AI: chat');
  assert.equal(L.inferredLabel('invoke_agent refund_triage'), 'Agent: refund triage');
  assert.equal(L.inferredLabel('my_step'), 'My step');
  const m = L.inferMap([{ v: 'bench/0', run_id: 'r', seq: 1, ts: 1, node: 'execute_tool search_handbook', event_type: 'tool_call', data: {} }], 'x');
  assert.equal(m.nodes[0].label, 'execute_tool search_handbook');
  assert.equal(m.nodes[0].plain_label, 'Tool: search handbook');
});

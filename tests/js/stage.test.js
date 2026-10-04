// Presentation's stage: the callout and recap view models (viewer/logic.js), against the bench's own
// examples and the helpdesk's real recordings. node --test tests/js/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../../viewer/logic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const HELPDESK = path.resolve(ROOT, '../agent-lab/request-queue/demo/bench-recordings');
const haveDesk = fs.existsSync(HELPDESK);
function load(p) {
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const header = rows[0] && rows[0].v === 'bench-recording/0' ? rows.shift() : null;
  return { header, topo: header && header.topology, events: L.sortEvents(rows.map(L.normalizeEvent)) };
}
const hello = (n) => load(path.join(ROOT, 'examples', n + '.recording.jsonl'));
const desk = (n) => load(path.join(HELPDESK, n + '.recording.jsonl'));
function seqOf(events) {
  const seq = [];
  events.forEach((e) => { if (e.node !== '_run' && seq[seq.length - 1] !== e.node) seq.push(e.node); });
  return seq;
}
const text = (h) => h.map((x) => x.t).join('');
const em = (h) => h.filter((x) => x.em).map((x) => x.t);
function at(r, node) { return r.events.slice(0, L.stopAt(r.events, r.topo, node) + 1); }
function ending(r) {
  const seq = seqOf(r.events), last = seq[seq.length - 1];
  const fin = r.events.find((e) => e.event_type === 'run_finished');
  return L.callout(r.topo, r.events, last, { finished: true, last, numbers: L.stepNumbers(seq), reply: L.replyOf(fin && fin.data.output) });
}

// ---- request, reply, numbers ---------------------------------------------------------------------
test('request and reply: a map that declares its fields (app.io) is read exactly, never guessed', () => {
  const topo = { app: { id: 'a', name: 'A', io: { request: 'body', reply: 'final', requester: ['who', 'team'] } } };
  const ev = [{ event_type: 'run_started', node: '_run', ts: 0,
                data: { input: { body: 'the request', message: 'a decoy named like a message', who: 'Ana', team: 'Ops', user_name: 'decoy' } } }];
  assert.deepEqual(L.requestOf(ev, topo), { text: 'the request', who: 'Ana · Ops' });
  assert.equal(L.replyOf({ final: 'the reply', answer: 'a decoy named like a reply' }, topo), 'the reply');
  // a declared field that's empty this run is empty, not a guess from another field
  assert.equal(L.replyOf({ final: null, answer: 'a decoy' }, topo), null);
  assert.equal(L.requestOf([{ event_type: 'run_started', node: '_run', ts: 0, data: { input: { message: 'decoy' } } }], topo).text, null);
  // a string input or output needs no declaration
  assert.equal(L.replyOf('Done.', topo), 'Done.');
});
test('request and reply with no declaration (Level 0): strings as they are; objects by field name, else the longest string', () => {
  const ev = (input) => [{ event_type: 'run_started', node: '_run', ts: 0, data: { input } }];
  assert.deepEqual(L.requestOf(ev('hi there')), { text: 'hi there', who: '' });
  assert.equal(L.requestOf(ev({ run_id: 'r1', message: 'reset my VPN', user_name: 'Ana', role: 'admin' })).text, 'reset my VPN');
  assert.equal(L.requestOf(ev({ run_id: 'r1', message: 'reset my VPN', user_name: 'Ana', role: 'admin' })).who, 'Ana · admin');
  assert.equal(L.requestOf(ev({ a: 'x', b: 'the longest string wins' })).text, 'the longest string wins');
  // The old shape (data.requester) still names who asked.
  assert.equal(L.requestOf([{ event_type: 'run_started', node: '_run', ts: 0, data: { input: 'q', requester: { name: 'Sam', role: 'customer' } } }]).who, 'Sam · customer');
  // A late run_updated carries the input (an agentlab run's input travels on its run span).
  assert.equal(L.requestOf([{ event_type: 'run_started', node: '_run', ts: 0, data: {} }, { event_type: 'run_updated', node: '_run', ts: 1, data: { input: { query: 'late' } } }]).text, 'late');
  assert.equal(L.replyOf('Done.'), 'Done.');
  assert.equal(L.replyOf({ message: 'the request echoed', final_response: 'the reply' }), 'the reply');
  assert.equal(L.replyOf({ message: 'only the request' }), null, 'never shows the request as the reply');
  assert.equal(L.replyOf(null), null);
});
test('steps are numbered in the order they first ran', () => {
  assert.deepEqual(L.stepNumbers(['a', 'b', 'a', 'c']), { a: 1, b: 2, c: 3 });
  assert.deepEqual(L.stepNumbers([]), {});
});
test('stopAt: a gate stops at "waiting"; a node that never ran is -1', () => {
  const r = hello('hello-escalate');
  const i = L.stopAt(r.events, r.topo, 'escalate');
  assert.equal(r.events[i].event_type, 'gate_waiting');
  assert.equal(L.stopAt(r.events, r.topo, 'no-such-node'), -1);
});

// ---- the callout, generic (the bench's own example) -------------------------------------------------
test('callout at a decision: one card per path, the taken one chosen, its words in the headline', () => {
  const r = hello('hello-answer');
  const evs = at(r, 'triage');
  const c = L.callout(r.topo, evs, 'triage', { numbers: L.stepNumbers(seqOf(evs)) });
  assert.equal(c.n, 2);
  assert.ok(c.choices.length >= 2);
  assert.equal(c.choices.filter((x) => x.chosen).length, 1);
  const chosen = c.choices.find((x) => x.chosen);
  assert.deepEqual(em(c.headline), [chosen.label]);
  assert.match(text(c.headline), new RegExp('so next: ' + chosen.toLabel));
  assert.equal(c.reason.text, 'A how-to question the docs cover.');
});
test('callout before the path is known: choices shown, none chosen', () => {
  const r = hello('hello-answer');
  const vs = L.visits(r.events), v = vs.find((x) => x.node === 'triage');
  // A derived branch (the decision names none) is known only once the next step starts.
  const evs = r.events.slice(0, v.last + 1).map((e) => e.event_type === 'decision' ? { ...e, data: { ...e.data, branch: undefined } } : e);
  const c = L.callout(r.topo, evs, 'triage', {});
  assert.ok(c.choices.every((x) => x.chosen === null));
  assert.match(text(c.headline), /is choosing one of \d+ paths/);
});
test('callout at a gate: the exact proposal, "if" lines for each way out, nothing approved yet', () => {
  const r = hello('hello-escalate');
  const c = L.callout(r.topo, at(r, 'escalate'), 'escalate', {});
  assert.equal(c.status, 'waiting');
  assert.deepEqual(em(c.headline), ['exactly this']);
  assert.ok(c.proposal && c.proposal.state === 'waiting');
  assert.ok(c.ifNext.length >= 1);
  assert.equal(c.about.label, 'Who can sign off');
});
test('callout for a step the run never reached: the map\'s own "not needed" words', () => {
  const r = hello('hello-escalate');
  const c = L.callout(r.topo, r.events, 'answer_check', { finished: true });
  assert.equal(c.status, 'not_needed');
  assert.ok(text(c.headline).length > 0);
});
test('callout with no words on the map: humanized ids, still one sentence', () => {
  const topo = { nodes: [{ id: 'fetch_rows' }, { id: 'summarize', kind: 'llm' }], edges: [{ from: 'fetch_rows', to: 'summarize' }] };
  const evs = [{ event_type: 'step_started', node: 'fetch_rows', ts: 1 }, { event_type: 'step_finished', node: 'fetch_rows', ts: 2, data: {} }];
  const c = L.callout(topo, evs, 'fetch_rows', {});
  assert.equal(c.title, 'fetch_rows');
  assert.equal(text(c.headline), 'fetch_rows; next: summarize.');
});
test('proposal cards read the object that has a title, and the map\'s own action words', () => {
  const topo = { actions: [{ id: 'refund', title: 'Refund an order' }] };
  const card = L.proposalCard({ proposed_action: { action_type: 'refund', title: 'Refund #12', description: 'Damaged item', amount: 30, order_id: 'o-1', digest: 'abc' }, verdict: { allowed: true } }, topo);
  assert.equal(card.kicker, 'Refund an order');
  assert.equal(card.title, 'Refund #12');
  assert.equal(card.description, 'Damaged item');
  assert.deepEqual(card.fields.map((f) => f.name), ['Amount']);   // ids and digests stay in Engineering
  assert.equal(L.proposalCard('ship it', topo).title, 'ship it');
  assert.equal(L.proposalCard(null, topo), null);
});
test('recap: the four questions, with "given" never a made-up zero', () => {
  const r = hello('hello-answer');
  const rc = L.recap(r.topo, r.events, true, seqOf(r.events));
  assert.equal(rc.did.text, 'Answered');
  assert.equal(rc.did.path.length, seqOf(r.events).length);
  assert.ok(rc.looked.length && rc.looked[0].line);
  assert.ok(rc.checked.length);
  assert.ok(rc.signed.line);
  // Content not captured: "given" is unknown, said so.
  const blind = r.events.map((e) => e.event_type === 'llm_call' ? { ...e, data: { ...e.data, system: undefined, messages: undefined } } : e);
  const rb = L.recap(r.topo, blind, true, seqOf(blind));
  assert.match(rb.looked.find((s) => s.found).line, /given to the AI: not known/);
});

// ---- the helpdesk's real runs (read-only) -----------------------------------------------------------
test('helpdesk req-012 at the decision: the path from the map, the reason word for word, the cited item', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const r = desk('req-012-approved');
  const evs = at(r, 'classify');
  const c = L.callout(r.topo, evs, 'classify', { numbers: L.stepNumbers(seqOf(evs)) });
  const edge = r.topo.edges.find((e) => e.from === 'classify' && e.to === 'propose_action');
  assert.equal(c.n, 3);
  assert.deepEqual(em(c.headline), [edge.plain_label]);
  assert.equal(c.sub, edge.description);
  assert.equal(c.choices.length, 3);
  assert.equal(c.choices.find((x) => x.chosen).to, 'propose_action');
  assert.equal(c.reason.cited.length, 1);
  assert.ok(c.reason.cited[0].title !== c.reason.cited[0].id, 'cited items are shown by their titles');
  assert.ok(c.checks.length === 1 && c.checks[0].state === 'passed');
  const sent = evs.find((e) => e.event_type === 'check_result' && e.node === 'classify').data.words;
  assert.equal(c.checks[0].word, sent.passed);   // the check's own words, sent with it
});
test('helpdesk req-012 at the gate: waiting, the proposal in the map\'s words', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const r = desk('req-012-approved');
  const evs = at(r, 'approval_gate');
  assert.equal(evs[evs.length - 1].event_type, 'gate_waiting');
  const c = L.callout(r.topo, evs, 'approval_gate', {});
  assert.equal(c.status, 'waiting');
  assert.equal(c.proposal.kicker, r.topo.actions[0].title);
  assert.ok(c.proposal.title && c.proposal.description);
  assert.ok(!evs.some((e) => e.event_type === 'gate_resolved'), 'nothing after the pause leaks in');
  assert.deepEqual(c.ifNext.map((x) => x.to).sort(), ['Hand to a person', 'Open the ticket']);
});
test('helpdesk req-020 at the end: handed over, the reply, and the AI\'s reason from the step that gave it', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const r = desk('req-020');
  const c = ending(r);
  assert.equal(c.status, 'last');
  assert.deepEqual(em(c.headline), ['Handed to a person']);
  assert.match(c.reply, /flagged this for a human/);
  assert.equal(c.why.atStep, 3);
  assert.ok(!/^\{/.test(c.reply), 'the reply is text, not the app\'s state object');
});
test('helpdesk req-012 at the end: done, with the action\'s own title', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const c = ending(desk('req-012-approved'));
  assert.match(text(c.headline), /^Done: Open an IT ticket, approved by a person/);
});

test('a past step\'s badge: the path it took in the map\'s words, a search\'s count, a check\'s verdict', { skip: !haveDesk }, () => {
  const r = desk('req-012-approved');
  const steps = (id) => [{ events: r.events.filter((e) => e.node === id) }];
  const edge = r.topo.edges.find((e) => e.from === 'classify' && e.from_branch === 'needs_write');
  assert.equal(L.stepBadge(r.topo, r.events, 'classify', steps('classify')), '→ ' + edge.plain_label);
  const handbook = r.topo.sources.find((s) => s.id === 'handbook');
  assert.match(L.stepBadge(r.topo, r.events, 'retrieve', steps('retrieve')), new RegExp('^found \\d+ of ' + handbook.count + '$'));
  assert.match(L.stepBadge(r.topo, r.events, 'approval_gate', steps('approval_gate')), /^✓ approved$|^→ /);
});

// ---- usability round v3/6 (the presenter's and the engineer's walks) -----------------------------
// A zero-word library map: no actors declared, two corpora searched by one step.
function zeroWords() {
  return {
    v: 'bench-topology/0', app: { id: 'z', name: 'Z' },
    nodes: [{ id: 'lookup', label: 'lookup', kind: 'step' }, { id: 'triage', label: 'triage', kind: 'step' },
            { id: 'answer', label: 'answer', kind: 'terminal' }],
    edges: [{ from: 'lookup', to: 'triage' }, { from: 'triage', to: 'answer' }],
    sources: [{ id: 'leave', title: 'Leave policies', kind: 'documents', count: 2, items: [{ id: 'pto', title: 'PTO' }, { id: 'sick', title: 'Sick leave' }] },
              { id: 'money', title: 'Money and work', kind: 'documents', count: 3, items: [{ id: 'exp', title: 'Expenses' }, { id: 'pay', title: 'Payroll' }, { id: 'remote', title: 'Remote work' }] }]
  };
}
function zeroRun() {
  const e = (seq, node, event_type, data) => ({ v: 'bench/0', run_id: 'r', seq, ts: seq, node, event_type, step_id: 'r:' + node + ':1', data: data || {} });
  return [
    { v: 'bench/0', run_id: 'r', seq: 0, ts: 0, node: '_run', event_type: 'run_started', data: { input: 'Can I expense a train ticket?' } },
    e(1, 'lookup', 'step_started'),
    e(2, 'lookup', 'retrieval', { source: 'leave', hits: [] }),
    e(3, 'lookup', 'retrieval', { source: 'money', hits: [{ id: 'exp', title: 'Expenses', text: 'Train tickets are reimbursed with a receipt.' }] }),
    e(4, 'lookup', 'step_finished', { status: 'ok' }),
    e(5, 'triage', 'step_started'),
    e(6, 'triage', 'llm_call', { model: 'fake', system: 'x', messages: [{ role: 'user', content: 'Train tickets are reimbursed with a receipt.' }], output: 'policy' }),
    e(7, 'triage', 'step_finished', { status: 'ok' }),
  ];
}

test('no words: a step that called the AI is the AI\'s, and R11 never blames words nobody wrote', () => {
  const topo = zeroWords(), events = zeroRun();
  assert.equal(L.actorOf(L.nodeOf(topo, 'triage'), events), 'ai');
  assert.equal(L.actorOf(L.nodeOf(topo, 'lookup'), events), 'app');
  assert.ok(!L.mapChecks(topo, events).some((f) => f.code === 'R11'), 'no R11 on an unworded step');
  // Words that do say "the app" are still held to it.
  const said = zeroWords(); said.nodes[1].actor = 'app';
  assert.ok(L.mapChecks(said, events).some((f) => f.code === 'R11' && f.node === 'triage'));
  const c = L.callout(topo, events, 'triage', {});
  assert.equal(c.actor, 'ai');
});

test('a step that searched two sources counts both: found 1 of 5 in 2 sources, on the badge and in the callout', () => {
  const topo = zeroWords(), events = zeroRun();
  const steps = [{ events: events.filter((e) => e.node === 'lookup') }];
  assert.equal(L.stepBadge(topo, events, 'lookup', steps), 'found 1 of 5');
  const sr = L.stepSearch(topo, steps[0].events);
  assert.deepEqual(sr, { found: 1, of: 5, sources: ['leave', 'money'] });
  const c = L.callout(topo, events, 'lookup', {});
  assert.equal(text(c.headline), 'Found 1 of 5 in 2 sources; next: triage.');
  assert.deepEqual(c.sources.map((s) => s.id), ['leave', 'money'], 'a source searched with no hits is shown too');
});

test('sentences end once: a label ending in "?" gets no extra period', () => {
  assert.equal(L.endSentence('Is it a policy question?'), 'Is it a policy question?');
  assert.equal(L.endSentence('Open the ticket'), 'Open the ticket.');
  const topo = { app: { id: 'q', name: 'Q' }, nodes: [{ id: 'a', plain_label: 'Look it up' }, { id: 'b', plain_label: 'Is it a policy question?' }], edges: [{ from: 'a', to: 'b' }] };
  const evs = [{ run_id: 'r', ts: 1, node: 'a', event_type: 'llm_call', data: { output: 'x' } }];
  assert.equal(text(L.callout(topo, evs, 'a', {}).headline), 'The AI worked on this step; next: Is it a policy question?');
});

test('a value the map has words for is shown in them (an action\'s title, a branch\'s words)', () => {
  const topo = { actions: [{ id: 'create_ticket', title: 'Open an IT ticket' }], edges: [{ from: 'c', to: 'x', from_branch: 'needs_write', plain_label: 'needs a change' }] };
  assert.equal(L.plainValue(topo, 'c', 'create_ticket'), 'Open an IT ticket');
  assert.equal(L.plainValue(topo, 'c', 'needs_write'), 'needs a change');
  assert.equal(L.plainValue(topo, 'other', 'needs_write'), 'needs_write');
});

test('helpdesk: the headline that is the whole description isn\'t said twice; "0 of 16" is never said', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const r = desk('req-012-approved');
  const evs = at(r, 'ingest');
  const c = L.callout(r.topo, evs, 'ingest', {});
  assert.ok(!c.about || c.about.text.trim() !== text(c.headline).trim(), JSON.stringify(c.about));
  const p = L.callout(r.topo, at(r, 'propose_action'), 'propose_action', {});
  assert.ok(p.given.every((g) => g.n > 0), JSON.stringify(p.given));
  assert.ok(p.wrote && p.wrote.fields.every((f) => f.value !== '–'), 'no empty fields in what it wrote');
});

test('helpdesk: the recap counts only the checks that ran, and a hand-off says why in the AI\'s words', { skip: !haveDesk && 'helpdesk repo not found' }, () => {
  const r = desk('req-021');
  const rc = L.recap(r.topo, r.events, true, seqOf(r.events));
  assert.equal(rc.checkCount.ran + rc.checkCount.notNeeded + rc.checkCount.pending, rc.checked.length);
  assert.ok(rc.checkCount.notNeeded >= 1);
  assert.match(rc.did.text, /^Handed to a person/);
  assert.ok(rc.did.why && rc.did.why.length > 20, 'the AI\'s own reason for the hand-off');
  const ok = desk('req-012-approved');
  assert.equal(L.recap(ok.topo, ok.events, true, seqOf(ok.events)).did.why, null, 'no "why" on an approval');
});

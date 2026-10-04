// The calls inside one step (viewer/logic.js callSequence): ordered by start, overlaps found, each
// tool tied to the answer that asked for it. On the bench's own agent-loop recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../../viewer/logic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function load(p) {
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const header = rows.shift();
  return { topo: header.topology, events: L.sortEvents(rows.map(L.normalizeEvent)) };
}
const loop = load(path.join(ROOT, 'examples/agent-loop.recording.jsonl'));

test('agent loop: six calls on one step, by start, the two tools at once tied to the answer that asked', () => {
  const sid = loop.events.find((e) => e.node === 'research' && e.event_type === 'step_started').step_id;
  const s = L.callSequence(loop.events, sid);
  assert.deepEqual(s.calls.map((c) => c.kind), ['ai', 'tool', 'ai', 'tool', 'tool', 'ai']);
  assert.deepEqual(s.calls.map((c) => c.ev.data.tool || null), [null, 'search_kb', null, 'get_user', 'create_draft', null]);
  assert.deepEqual(s.calls[3].with, [5]);
  assert.deepEqual(s.calls[4].with, [4]);
  assert.deepEqual(s.calls.filter((c) => c.kind === 'tool').map((c) => c.askedBy), [1, 3, 3]);
  assert.ok(L.isCallLoop(s));
  assert.equal(s.ai, 3); assert.equal(s.tools, 3);
  const w = L.callWords(s.calls[2], s);
  assert.equal(w.title, 'Asked the AI again');
  assert.match(w.result, /^it asked for 2 things at once: get user, create draft$/);
  assert.equal(L.callWords(s.calls[5], s).title, 'Asked the AI to finish');
  assert.match(L.callWords(s.calls[1], s).result, /^3 results · best: KB-114 “Resetting your SecureLink VPN profile”$/);
});

test('order is by start, not by when each call was stamped (its end)', () => {
  const ev = (type, ts, lat, seq, extra) => ({ event_type: type, node: 'n', step_id: 's', ts, seq, data: Object.assign({ latency_ms: lat }, extra) });
  const events = [
    { event_type: 'step_started', node: 'n', step_id: 's', ts: 0, seq: 0, data: {} },
    ev('tool_call', 1.0, 200, 1, { tool: 'short_late' }),        // 0.8 → 1.0
    ev('tool_call', 2.0, 1900, 2, { tool: 'long_early' }),        // 0.1 → 2.0
  ];
  const s = L.callSequence(events, 's');
  assert.deepEqual(s.calls.map((c) => c.ev.data.tool), ['long_early', 'short_late']);
  assert.deepEqual(s.calls[0].with, [2]);
});

test('the map line of an agent-loop step counts its calls; a one-call AI step shows tokens', () => {
  const run = L.newRun('r');
  loop.events.forEach((e) => L.reduce(run, e, 0));
  const steps = run.nodeSteps.research.map((id) => run.steps[id]);
  const m = L.stepMeta(loop.topo, loop.events, 'research', steps, { finished: true });
  assert.equal(m.v, '6 calls');
  assert.deepEqual(m.pips, ['ai', 'tool', 'ai', 'tool', 'tool', 'ai']);
  assert.equal(L.stepMeta(loop.topo, loop.events, 'handoff', [], { finished: true }).v, 'not reached');
});

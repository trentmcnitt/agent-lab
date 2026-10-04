// The viewer's data layer for runs from apps built with the agentlab library (SPEC.md 8.6, 8.7):
// run_updated, the map a run carried, inline check words, honest source counts, the map checks.
// node --test tests/js/*.test.js. The same functions run over real library output in
// tests/test_agentlab_ingest.py (library -> bench adapter -> bench.record -> these functions).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../viewer/logic.js';

let seq = 0;
function ev(node, type, data, extra) {
  return Object.assign({ v: 'bench/0', run_id: 'r', ts: 100 + seq, seq: seq++, node, event_type: type, content_mode: 'full', data: data || {} }, extra || {});
}
function runOf(events) { const r = L.newRun('r'); events.forEach((e) => L.reduce(r, e, 0)); return r; }

const MAP = {
  v: 'bench-topology/0', app: { id: 'desk', name: 'Desk', baseline: '~10 minutes' },
  nodes: [
    { id: 'retrieve', kind: 'retrieval', actor: 'rule' },
    { id: 'classify', kind: 'llm', actor: 'ai' },
    { id: 'grounding_check', kind: 'check', actor: 'rule' },
    { id: 'respond', kind: 'step' },
    { id: 'handoff', kind: 'step' }
  ],
  edges: [
    { from: 'retrieve', to: 'classify' },
    { from: 'classify', to: 'grounding_check', from_branch: 'answerable' },
    { from: 'classify', to: 'handoff', from_branch: 'out_of_scope' },
    { from: 'classify', to: 'handoff', from_branch: 'unsafe' },
    { from: 'grounding_check', to: 'respond', from_branch: 'grounded' },
    { from: 'grounding_check', to: 'handoff', from_branch: 'not_grounded' }
  ],
  sources: [{ id: 'handbook', title: 'IT handbook', kind: 'documents', description: '', count: 3,
              items: [{ id: 'sec-1', title: 'Passwords' }, { id: 'sec-2', title: 'Laptops' }, { id: 'sec-3', title: 'Access' }] }],
  story: { id: 'desk', sha256: 'a'.repeat(64) },
  derived: { from: 'langgraph', hashes: { structure: 's', words: 'w', corpora: 'c' },
             warnings: [{ code: 'R12', severity: 'info', node: 'respond', message: 'no words' },
                        { code: 'R3', severity: 'error', node: 'router', message: 'branches unknown' }] }
};
const TEXT1 = 'Reset your password at the self-service portal; IT never asks for it.';

test('run_updated merges into the run it updates: input, label, map hash', () => {
  seq = 0;
  const r = runOf([ev('_run', 'run_started', { app: 'desk', via: 'agentlab' }),
                   ev('classify', 'step_started'),
                   ev('_run', 'run_updated', { input: { text: 'reset my password' }, map_hash: 'b'.repeat(64) })]);
  assert.deepEqual(r.input, { text: 'reset my password' });
  assert.equal(r.started.app, 'desk');
  assert.equal(r.started.map_hash, 'b'.repeat(64));
  assert.match(r.label, /reset my password/);
  assert.equal(r.stepOrder.length, 1, 'a run-level update is not a step');
});

test('runMapHash and chooseMap: the run’s own map, else registered, else inferred', () => {
  seq = 0;
  const h = 'c'.repeat(64);
  const evs = [ev('_run', 'run_started', { app: 'desk' }), ev('_run', 'run_updated', { map_hash: h })];
  assert.equal(L.runMapHash(evs), h);
  assert.equal(L.runMapHash([ev('_run', 'run_started', {})]), null);
  const inferred = { inferred: true, nodes: [], edges: [] }, reg = { nodes: [], edges: [] };
  assert.deepEqual(L.chooseMap(evs, { [h]: MAP }, reg, inferred), { map: MAP, from: 'run', hash: h, wait: false });
  assert.deepEqual(L.chooseMap(evs, {}, reg, inferred), { map: reg, from: 'registered', hash: h, wait: true });
  assert.equal(L.chooseMap([], {}, null, inferred).from, 'inferred');
  assert.equal(L.chooseMap([], {}, null, inferred).wait, false);
});

test('a check’s own words (check_result.data.words) win over the map’s check_words', () => {
  seq = 0;
  const topo = Object.assign({}, MAP, { check_words: { unsure: { passed: 'Map words' } } });
  const evs = [ev('classify', 'step_started'),
               ev('classify', 'check_result', { name: 'unsure', passed: true, state: 'passed', words: { passed: 'Sure enough', failed: 'Sent to a person' } })];
  const row = L.checkStates(topo, evs, true).find((c) => c.id === 'unsure');
  assert.equal(row.line, '✓ Sure enough.');
  assert.equal(L.checkWord(topo, 'unsure', 'passed', { passed: 'Inline' }), 'Inline');
  assert.equal(L.checkWord(topo, 'unsure', 'passed'), 'Map words');
  const steps = runOf(evs).steps;
  assert.equal(L.preview(Object.values(steps), 'presentation', 0, false, topo), '✓ Sure enough');
  const n = L.narrate(topo, evs, 'classify', { finished: true });
  assert.ok(n.lines.some((l) => /Sure enough/.test(l.text)));
});

test('baseline comes from the map when the run doesn’t carry one', () => {
  seq = 0;
  assert.equal(L.baselineOf([ev('_run', 'run_finished', { status: 'ok' })], MAP), '~10 minutes');
  assert.equal(L.baselineOf([ev('_run', 'run_finished', { status: 'ok', baseline: '1 hour' })], MAP), '1 hour');
  assert.equal(L.baselineOf([ev('_run', 'run_finished', { status: 'ok' })]), null);
});

test('sources: available · given to the AI · relied on, checked against the prompt', () => {
  seq = 0;
  const evs = [
    ev('retrieve', 'retrieval', { source: 'handbook', hits: [{ id: 'sec-1', title: 'Passwords', text: TEXT1 }, { id: 'sec-3', title: 'Access', text: 'Access to a system needs approval from its owner.' }] }),
    ev('classify', 'llm_call', { model: 'm', system: 'Use only:\n' + TEXT1, messages: [{ role: 'user', content: 'reset' }] }),
    ev('classify', 'decision', { cited: ['sec-1'] }, { step_id: 's2' })
  ];
  const s = L.sourceStates(MAP, evs)[0];
  assert.equal(s.found, 2);
  assert.equal(s.given, 1);
  assert.equal(s.givenKnown, true);
  assert.equal(s.relied, 1);
  assert.equal(L.sourceCountsLine(s), '3 available · 1 given to the AI · 1 relied on');
});

test('sources: with content not captured or masked whole, "given" is not known, never 0', () => {
  seq = 0;
  const absent = [ev('retrieve', 'retrieval', { source: 'handbook', hits: [{ id: 'sec-1', title: 'Passwords' }] }, { content_mode: 'absent' }),
                  ev('classify', 'llm_call', { model: 'm' }, { content_mode: 'absent' })];
  let s = L.sourceStates(MAP, absent)[0];
  assert.equal(s.givenKnown, false);
  assert.equal(L.sourceCountsLine(s), '3 available · 1 found · given to the AI: not known · 0 relied on');
  seq = 0;
  // "[redacted]" in the hit and "[redacted]" in the prompt is not evidence the document was given.
  const masked = [ev('retrieve', 'retrieval', { source: 'handbook', hits: [{ id: 'sec-1', title: 'Passwords', text: '[redacted]' }] }, { content_mode: 'redacted' }),
                  ev('classify', 'llm_call', { model: 'm', system: '[redacted]', messages: [{ role: 'user', content: '[redacted]' }] }, { content_mode: 'redacted' })];
  s = L.sourceStates(MAP, masked)[0];
  assert.equal(s.given, 0);
  assert.equal(s.givenKnown, false);
  assert.ok(!L.narrate(MAP, masked, 'classify', {}).lines.some((l) => l.kind === 'given' && /was given 1/.test(l.text)));
  // Nothing found: nothing could have been given, and that is known.
  seq = 0;
  s = L.sourceStates(MAP, [ev('classify', 'llm_call', { model: 'm', system: 'x' })])[0];
  assert.equal(s.givenKnown, true);
  assert.equal(L.sourceCountsLine(s), '3 available · 0 given to the AI · 0 relied on');
});

test('mapChecks: the app’s verify findings, then each run rule (R7–R11, R13)', () => {
  seq = 0;
  const evs = [
    ev('_run', 'run_started', { app: 'desk', map_error: 'R13: the run’s map doesn’t match its hash' }),
    ev('retrieve', 'step_started'),
    ev('retrieve', 'retrieval', { source: 'wiki', hits: [] }),
    ev('retrieve', 'retrieval', { source: 'handbook', hits: [], stale_index: true }),
    ev('retrieve', 'llm_call', { model: 'm' }),                       // R11: a rule step called the AI
    ev('classify', 'step_started'),
    ev('classify', 'decision', { branch: 'maybe', cited: ['sec-1', 'sec-9'] }),   // R8, R9
    ev('ghost', 'step_started'),                                      // R7
    ev('grounding_check', 'check_result', { name: 'grounding', passed: true, evidence: ['sec-7'] })
  ];
  const got = L.mapChecks(MAP, evs);
  const codes = got.map((f) => f.code);
  assert.deepEqual(codes.filter((c) => c === 'R13' || c === 'R3' || c === 'R8'), ['R3', 'R8', 'R13'], 'errors first');
  assert.equal(got[got.length - 1].code, 'R12', 'info last');
  assert.ok(got.some((f) => f.code === 'R7' && f.node === 'ghost'));
  assert.ok(got.some((f) => f.code === 'R8' && f.branch === 'maybe' && /answerable/.test(f.message)));
  assert.ok(got.some((f) => f.code === 'R9' && /sec-9/.test(f.message)));
  assert.ok(got.some((f) => f.code === 'R9' && /sec-7/.test(f.message)));
  assert.ok(!got.some((f) => /sec-1"/.test(f.message)), 'a listed item is fine');
  assert.ok(got.some((f) => f.code === 'R9' && /wiki/.test(f.message)));
  assert.ok(got.some((f) => f.code === 'R9' && /stale index/.test(f.message)));
  assert.ok(got.some((f) => f.code === 'R11' && f.node === 'retrieve'));
  assert.ok(got.find((f) => f.code === 'R3').from === 'map');
});

test('mapChecks R10: a many-to-one branch taken without saying which', () => {
  seq = 0;
  const went = [ev('classify', 'step_started'), ev('classify', 'step_finished', { status: 'ok' }),
                ev('handoff', 'step_started'), ev('handoff', 'step_finished', { status: 'ok' })];
  assert.ok(L.mapChecks(MAP, went).some((f) => f.code === 'R10' && f.node === 'classify'));
  seq = 0;
  const said = [ev('classify', 'step_started'), ev('classify', 'decision', { branch: 'unsafe' }),
                ev('handoff', 'step_started')];
  assert.ok(!L.mapChecks(MAP, said).some((f) => f.code === 'R10'));
  seq = 0;
  const oneToOne = [ev('grounding_check', 'step_started'), ev('respond', 'step_started')];
  assert.ok(!L.mapChecks(MAP, oneToOne).some((f) => f.code === 'R10'));
});

test('mapChecks: an inferred map gets no run rules (it was made from these events), a clean run none', () => {
  seq = 0;
  const evs = [ev('chat', 'step_started'), ev('chat', 'llm_call', { model: 'm' })];
  assert.deepEqual(L.mapChecks(L.inferMap(evs, 'a'), evs), []);
  const clean = Object.assign({}, MAP, { derived: undefined });
  seq = 0;
  assert.deepEqual(L.mapChecks(clean, [ev('_run', 'run_started', {}), ev('retrieve', 'step_started'),
    ev('classify', 'decision', { branch: 'answerable', cited: ['sec-1'] }), ev('grounding_check', 'step_started')]), []);
});

test('a run remembers the map it carried, through a late run_updated and a re-sort', () => {
  const r = L.newRun('r');
  L.reduce(r, ev('_run', 'run_started', { app: 'desk' }), 0);
  assert.equal(r.mapHash, undefined);
  L.reduce(r, ev('_run', 'run_updated', { map_hash: 'abc' }), 0);
  assert.equal(r.mapHash, 'abc');
  const rebuilt = L.rebuildRun(r, ev('retrieve', 'step_started', {}, { ts: 50 }), 0);
  assert.equal(rebuilt.mapHash, 'abc');
});

test('two branches to the same step: the run\'s decision says which one it took', () => {
  const topo = { app: { id: 'm', name: 'M' }, nodes: [{ id: 'c' }, { id: 'h' }],
                 edges: [{ from: 'c', to: 'h', from_branch: 'needs_write' }, { from: 'c', to: 'h', from_branch: 'unsure' }] };
  const events = [ev('c', 'step_started'), ev('c', 'decision', { branch: 'unsure' }), ev('c', 'step_finished'), ev('h', 'step_started')];
  assert.deepEqual(L.takenOut(topo, events, 'c').map((e) => e.from_branch), ['unsure']);
  // with no decision both are lit (R10 reports the ambiguity)
  assert.equal(L.takenOut(topo, events.filter((e) => e.event_type !== 'decision'), 'c').length, 2);
});

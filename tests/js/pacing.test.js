// Presentation pacing (viewer/logic.js paceSchedule): recordings keep the full hold per step; a run the
// app feeds as it happens never trails the app by more than a beat. node --test tests/js/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../viewer/logic.js';

// A run whose steps arrived at the given wall times: [node, arr, arrEnd, status].
function run(steps, followsApp) {
  const r = L.newRun('r');
  r.followsApp = !!followsApp;
  steps.forEach(([node, arr, arrEnd, status]) => {
    const id = 'r:' + node;
    r.steps[id] = { id, node, parent: null, arr, arrEnd, status: status || 'ok' };
    r.stepOrder.push(id);
  });
  return r;
}
const SIX = ['queue', 'prompt_build', 'model_call', 'extract', 'post_process', 'checks'];
const shown = (r) => r.stepOrder.map((id) => [r.steps[id].vs, r.steps[id].ve]);

test('a recording (or Step through) holds every step MIN_LIT_MS, one after another', () => {
  const r = run(SIX.map((n) => [n, 1000, 1000]), false);
  assert.equal(L.paceSchedule(r), 1000 + 6 * L.MIN_LIT_MS);
  assert.deepEqual(shown(r)[2], [1000 + 2 * L.MIN_LIT_MS, 1000 + 3 * L.MIN_LIT_MS]);
});

test('beside the app, steps that were over when they arrived are held only a beat each', () => {
  // The old live path: the whole run arrived in one batch after the response (the ghost text was
  // already up). It used to take 6 x 450 ms = 2.7 s to finish on screen; now 6 beats.
  const r = run(SIX.map((n) => [n, 1000, 1000]), true);
  assert.equal(L.paceSchedule(r), 1000 + 6 * L.CATCHUP_MS);
  shown(r).forEach(([vs, ve]) => assert.equal(ve - vs, L.CATCHUP_MS));
});

test('beside the app, a run sent as it happens finishes on screen within ~300 ms of its last event', () => {
  // Real-time live completion: debounce 800 ms, the request goes out (prompt built server-side after
  // ~150 ms of network), the model answers 1.2 s later, and extract / post-process / checks arrive
  // together with the answer, when the app shows the ghost text (t = 2150).
  const r = run([
    ['queue', 0, 800], ['prompt_build', 800, 950], ['model_call', 950, 2150],
    ['extract', 2150, 2150], ['post_process', 2150, 2150], ['checks', 2150, 2150],
  ], true);
  const end = L.paceSchedule(r);
  assert.ok(end - 2150 <= 3 * L.CATCHUP_MS, `finished ${end - 2150} ms after the answer arrived`);
  assert.ok(end - 2150 <= 300);
  // A step that arrived running is shown finished no later than a beat after its end arrived...
  ['queue', 'prompt_build', 'model_call'].forEach((n) => {
    const s = r.steps['r:' + n];
    assert.ok(s.ve - s.arrEnd <= L.CATCHUP_MS, n + ' trails its end by ' + (s.ve - s.arrEnd));
  });
  // ...and is never shown starting before it arrived; every step is visible for a moment.
  r.stepOrder.forEach((id) => {
    const s = r.steps[id];
    assert.ok(s.vs >= s.arr && s.ve - s.vs >= 60, id);
  });
  // The long steps are shown exactly as they happened.
  assert.deepEqual([r.steps['r:queue'].vs, r.steps['r:queue'].ve], [0, 800]);
  assert.equal(r.steps['r:model_call'].ve, 2150);
});

test('beside the app, a step still running stays open; skipped steps keep their shorter hold', () => {
  const r = run([['queue', 0, 800], ['model_call', 800, null]], true);
  assert.equal(L.paceSchedule(r), Infinity);
  const k = run([['a', 0, 0, 'skipped'], ['b', 0, 0]], false);
  assert.equal(L.paceSchedule(k), L.SKIPPED_LIT_MS + L.MIN_LIT_MS);
});

test('nextPaceChange: the next moment something lights or finishes on screen', () => {
  const r = run(SIX.map((n) => [n, 1000, 1000]), true);
  L.paceSchedule(r);
  assert.equal(L.nextPaceChange(r, 1000), 1000 + L.CATCHUP_MS);
  assert.equal(L.nextPaceChange(r, 1000 + 6 * L.CATCHUP_MS), null);
});

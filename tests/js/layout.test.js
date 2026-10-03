// Map layout tests: node --test tests/js/*.test.js
// layout.js is a classic script (window.BenchLayout); it's loaded here in a vm sandbox.
// The property under test: no drawn edge passes through a node box other than its own two ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'viewer/layout.js'), 'utf8'), sandbox);
const layout = sandbox.window.BenchLayout;

const MAPS = {
  helpdesk: path.resolve(ROOT, '../agent-lab/request-queue/app/bench/topology.json'),
  hello: path.join(ROOT, 'examples/hello-agent.topology.json'),
  bespoke: path.resolve(ROOT, '../bespoke-ai-vscode-ext/playground/topology.json'),
};
const GEOMS = { engineering: layout.GEOM, presentation: layout.PRES_GEOM };

// Every sampled point of every edge piece, against every box but the edge's own ends.
function crossings(topo, L) {
  const G = L.g, bad = [];
  topo.edges.forEach((e, i) => {
    const r = L.edges[i];
    if (!r) return;
    for (const n of topo.nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      const p = L.pos[n.id];
      r.pieces.forEach((pc, k) => {
        for (let s = 0; s <= 60; s++) {
          const [x, y] = layout.at(pc, s / 60);
          if (x > p.x && x < p.x + G.w && y > p.y && y < p.y + G.h) { bad.push(`${e.from}->${e.to} piece ${k} hits ${n.id} at ${x.toFixed(1)},${y.toFixed(1)}`); return; }
        }
      });
    }
    // Its own ends: the edge only touches them at its endpoints (no running through the source or target box).
    [e.from, e.to].forEach((id) => {
      const p = L.pos[id];
      r.pieces.forEach((pc, k) => {
        for (let s = 1; s < 60; s++) {
          const [x, y] = layout.at(pc, s / 60);
          if (x > p.x + 0.5 && x < p.x + G.w - 0.5 && y > p.y + 0.5 && y < p.y + G.h - 0.5) { bad.push(`${e.from}->${e.to} piece ${k} runs inside its own end ${id}`); return; }
        }
      });
    });
  });
  return bad;
}
function labelsInBoxes(topo, L) {
  const G = L.g, bad = [];
  topo.edges.forEach((e, i) => {
    const r = L.edges[i];
    if (!r || !r.label) return;
    const x0 = r.label.anchor === 'end' ? r.label.x - (r.label.w || 0) : r.label.x;
    const x1 = x0 + (r.label.w || 0), y0 = r.label.y - 9, y1 = r.label.y + 2;
    for (const n of topo.nodes) {
      const p = L.pos[n.id];
      if (r.routed && x0 < p.x + G.w && x1 > p.x && y0 < p.y + G.h && y1 > p.y) bad.push(`${e.from}->${e.to} label over ${n.id}`);
      else if (!r.routed && r.label.x > p.x && r.label.x < p.x + G.w && r.label.y > p.y && r.label.y < p.y + G.h) bad.push(`${e.from}->${e.to} label anchor in ${n.id}`);
    }
  });
  return bad;
}
function boxesOverlap(topo, L) {
  const G = L.g, ids = topo.nodes.map((n) => n.id), bad = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = L.pos[ids[i]], b = L.pos[ids[j]];
    if (a.x < b.x + G.w && b.x < a.x + G.w && a.y < b.y + G.h && b.y < a.y + G.h) bad.push(ids[i] + '/' + ids[j]);
  }
  return bad;
}

for (const [name, file] of Object.entries(MAPS)) {
  const have = fs.existsSync(file);
  for (const [mode, G] of Object.entries(GEOMS)) {
    test(`layout: no edge crosses a box (${name}, ${mode})`, { skip: !have && `${file} not present` }, () => {
      const topo = JSON.parse(fs.readFileSync(file, 'utf8'));
      const L = layout(topo, G);
      assert.deepEqual(crossings(topo, L), []);
      assert.deepEqual(labelsInBoxes(topo, L), []);
      assert.deepEqual(boxesOverlap(topo, L), []);
      // Everything drawn is inside the canvas.
      for (const n of topo.nodes) { const p = L.pos[n.id]; assert.ok(p.x >= 0 && p.y >= 0 && p.x + G.w <= L.W && p.y + G.h <= L.H, n.id + ' off canvas'); }
      L.edges.forEach((r) => r && r.pieces.forEach((pc) => pc.forEach(([x, y]) => assert.ok(x >= 0 && y >= 0 && x <= L.W && y <= L.H, 'edge off canvas'))));
    });
  }
}

test('layout: the helpdesk long edges are routed (the trick request\'s escalation included)', { skip: !fs.existsSync(MAPS.helpdesk) }, () => {
  const topo = JSON.parse(fs.readFileSync(MAPS.helpdesk, 'utf8'));
  const L = layout(topo, layout.PRES_GEOM);
  const i = topo.edges.findIndex((e) => e.from === 'classify' && e.to === 'handoff');
  assert.ok(L.edges[i].routed);
  assert.match(L.edges[i].d, /^M[\d.]+,[\d.]+( C[\d.,\s]+)+$/);
});

test('layout: a back edge and a row-skipping edge in a made-up map stay clear of boxes', () => {
  const topo = {
    nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id })),
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }, { from: 'd', to: 'e' },
            { from: 'e', to: 'f' }, { from: 'a', to: 'f', from_branch: 'skip_all' }, { from: 'b', to: 'f', from_branch: 'jump' },
            { from: 'e', to: 'b', from_branch: 'retry' }],
  };
  for (const G of Object.values(GEOMS)) {
    const L = layout(topo, G);
    assert.deepEqual(crossings(topo, L), []);
    assert.deepEqual(labelsInBoxes(topo, L), []);
  }
});

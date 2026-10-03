#!/usr/bin/env node
/* Story harness: renders an app's story the way the bench does, at every event of every
   recording, in both modes, and fails on anything a viewer would see broken.

   node tests/story_harness.js [--story <story.js>] [--topology <map.json>] <recording.jsonl>...

   Without --story (or --topology) it uses the story (or map) in each recording's header. It
   loads the story in a sandbox with a stub BenchStory and the viewer's real ctx.h helpers
   (viewer/logic.js helpersFor), folds each recording's events into a run with the viewer's own
   reduce(), and calls every story panel (map panels with "story": true) and every story
   renderer after each event, in "presentation" and "engineering". A call fails on a throw, a
   non-string or empty result where the panel has events, or output containing "undefined",
   "NaN" or "[object Object]". Prints a JSON summary; exits 1 on any failure. No dependencies. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const LOGIC = path.resolve(__dirname, '../viewer/logic.js');
const BAD = /undefined|NaN|\[object Object\]/;

function parseArgs(argv) {
  const a = { story: null, topology: null, recordings: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--story') a.story = argv[++i];
    else if (argv[i] === '--topology') a.topology = argv[++i];
    else a.recordings.push(argv[i]);
  }
  return a;
}

function loadStory(source, appId) {
  const registered = {};
  const sandbox = { BenchStory: { register: (id, s) => { registered[id] = s || {}; } }, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'story.js', timeout: 2000 });
  return registered[appId] || null;
}

function readRecording(p) {
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const header = rows[0] && rows[0].v === 'bench-recording/0' ? rows.shift() : null;
  return { header, events: rows };
}

function check(out, where, failures) {
  if (typeof out !== 'string') { failures.push(where + ': returned ' + (out === undefined ? 'undefined' : typeof out)); return; }
  if (!out.trim()) { failures.push(where + ': empty output'); return; }
  const m = BAD.exec(out);
  if (m) failures.push(where + ': output contains "' + m[0] + '": …' + out.slice(Math.max(0, m.index - 60), m.index + 30).replace(/\s+/g, ' ') + '…');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.recordings.length) { console.error('usage: story_harness.js [--story story.js] [--topology map.json] <recording.jsonl>...'); process.exit(2); }
  const L = await import(pathToFileURL(LOGIC).href);
  const fixedStory = args.story ? fs.readFileSync(args.story, 'utf8') : null;
  const fixedTopo = args.topology ? JSON.parse(fs.readFileSync(args.topology, 'utf8')) : null;
  const failures = [];
  let calls = 0, recs = 0;
  for (const rp of args.recordings) {
    const name = path.basename(rp);
    const { header, events: raw } = readRecording(rp);
    const topo = fixedTopo || (header && header.topology);
    const source = fixedStory || (header && header.story);
    if (!topo) { failures.push(name + ': no map (pass --topology)'); continue; }
    if (!source) { failures.push(name + ': no story (pass --story)'); continue; }
    let story;
    try { story = loadStory(source, topo.app.id); } catch (e) { failures.push(name + ': story failed to load: ' + e.message); continue; }
    if (!story) { failures.push(name + ': the story never called BenchStory.register(\'' + topo.app.id + '\')'); continue; }
    recs++;
    const panels = (topo.panels || []).filter((p) => p.story);
    for (const p of panels) if (!(story.panels && typeof story.panels[p.id] === 'function')) failures.push(name + ': map panel "' + p.id + '" has "story": true but the story has no panels.' + p.id);
    const renderers = story.renderers || {};
    const events = L.sortEvents(raw.map(L.normalizeEvent));
    const run = L.newRun(events[0] ? events[0].run_id : 'run');
    events.forEach((ev, i) => {
      L.reduce(run, ev, i);
      for (const mode of ['presentation', 'engineering']) {
        const h = L.helpersFor(mode);
        for (const p of panels) {
          const fn = story.panels && story.panels[p.id];
          if (typeof fn !== 'function') continue;
          const evs = run.events.filter((e) => p.event_types.indexOf(e.event_type) >= 0 && (!p.nodes || p.nodes.indexOf(e.node) >= 0));
          if (!evs.length) continue;
          const list = p.mode === 'append' ? evs : evs.slice(-1);
          const where = name + ' @' + i + ' ' + mode + ' panel ' + p.id;
          calls++;
          try { check(fn(list, { run, h, all: evs, mode }), where, failures); } catch (e) { failures.push(where + ': threw ' + e.message); }
        }
        const r = renderers[ev.event_type];
        if (typeof r === 'function') {
          const where = name + ' @' + i + ' ' + mode + ' renderer ' + ev.event_type;
          calls++;
          try { check(r(ev, { h, mode }), where, failures); } catch (e) { failures.push(where + ': threw ' + e.message); }
        }
      }
    });
  }
  const summary = { recordings: recs, calls, failures: failures.slice(0, 50), failure_count: failures.length };
  console.log(JSON.stringify(summary, null, 1));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(2); });

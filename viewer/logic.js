/* The bench viewer's pure logic: no DOM, no globals, no clock of its own. bench.js imports it
   (through window.BenchLogic, set by index.html), the story harness and `node --test` import it
   directly, so what's tested is what runs. Everything here takes events and a map and returns
   strings, numbers or plain objects. */

// ---- formatting and the generic event views (a story's ctx.h) -----------------------------
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
export function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '–';
  return ms >= 10000 ? (ms / 1000).toFixed(1) + 's' : ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms';
}
export function fmtUsd(v) { return '$' + Number(v || 0).toFixed(v >= 0.1 ? 3 : 5); }
export function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
export function fmtTok(n) { n = Number(n || 0); return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
export function short(v, n) {
  var s = typeof v === 'string' ? v : JSON.stringify(v);
  n = n || 240;
  return s && s.length > n ? s.slice(0, n) + '…' : s;
}
export function human(s) { return String(s == null ? '' : s).replace(/[_-]+/g, ' ').trim(); }

export function kv(k, v, cls) {
  return '<div class="kv' + (cls ? ' ' + cls : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
}
// Keys Presentation never shows: numbers a room would misread, and ids.
var ENG_ONLY_KEY = /token|cost|score|bm25|fused|confidence|^model$|digest|latency|^id$|_id$|^seq$|sampling|params|cache/i;
export function flatKV(obj, skip, mode) {
  return Object.keys(obj || {}).filter(function (k) {
    return !(skip || []).includes(k) && !(mode === 'presentation' && ENG_ONLY_KEY.test(k));
  }).map(function (k) {
    var v = obj[k];
    return kv(k, v !== null && typeof v === 'object' ? short(v, 160) : v);
  }).join('');
}

/* The bench's own view of each event type. With ctx.mode "presentation" each drops tokens,
   costs, model ids, scores and the model's self-reported confidence. */
export var RENDER = {
  llm_call: function (ev, ctx) {
    var d = ev.data || {};
    if (ctx && ctx.mode === 'presentation') {
      return '<div class="row"><span class="tag">' + esc(ev.node) + '</span> the AI was asked' + (d.latency_ms != null ? '<span class="right">' + fmtMs(d.latency_ms) + '</span>' : '') + '</div>';
    }
    var cache = (d.cache_read_tokens || d.cache_write_tokens) ? ' · cache r' + fmtTok(d.cache_read_tokens) + '/w' + fmtTok(d.cache_write_tokens) : '';
    return '<div class="row mono"><span class="tag">' + esc(ev.node) + '</span> ' + esc(d.model) +
      '<span class="right">' + fmtTok(d.input_tokens) + ' in / ' + fmtTok(d.output_tokens) + ' out' + cache +
      (d.cost_usd != null ? ' · ' + fmtUsd(d.cost_usd) + ' <span class="src src-' + esc(d.cost_source) + '">' + esc(d.cost_source === 'actual' ? 'actual' : 'est') + '</span>' : '') +
      (d.latency_ms != null ? ' · ' + fmtMs(d.latency_ms) : '') + '</span></div>';
  },
  retrieval: function (ev, ctx) {
    var hits = (ev.data || {}).hits || [];
    if (!hits.length) return '<div class="muted">nothing found</div>';
    var pres = ctx && ctx.mode === 'presentation';
    return hits.map(function (h) {
      if (pres) return '<div class="row"><span class="tag">' + esc(h.id) + '</span> ' + esc(h.title || '') + '</div>';
      var extra = Object.keys(h).filter(function (k) { return typeof h[k] === 'number' && k !== 'score'; })
        .map(function (k) { return k + ' ' + Number(h[k]).toFixed(k === 'bm25' ? 1 : 3); }).join(' · ');
      return '<div class="row mono"><span class="tag">' + esc(h.id) + '</span> ' + esc(h.title || '') +
        '<span class="right">' + (h.score != null ? 'score ' + Number(h.score).toFixed(4) : '') + (extra ? ' · ' + esc(extra) : '') + '</span></div>';
    }).join('');
  },
  decision: function (ev, ctx) {
    var d = ev.data || {}, mode = ctx && ctx.mode;
    return (d.choice != null ? kv('choice', d.choice, 'hi') : '') + flatKV(d, ['choice', 'rationale', 'reason'], mode) +
      (d.confidence != null && mode !== 'presentation' ? '<div class="note">confidence is the model’s own estimate, not measured accuracy</div>' : '') +
      (d.rationale ? '<div class="note">' + esc(d.rationale) + '</div>' : '') + (d.reason ? '<div class="note">' + esc(d.reason) + '</div>' : '');
  },
  gate_waiting: function (ev, ctx) {
    var d = ev.data || {}, pres = ctx && ctx.mode === 'presentation';
    return '<div class="gate waiting">⏸ ' + (pres ? 'waiting for a person to approve, in the app' : 'waiting at <b>' + esc(ev.node) + '</b>, decided in the app') + '</div>' +
      (d.proposed ? flatKV(d.proposed, null, ctx && ctx.mode) : '') + (d.digest && !pres ? kv('digest', String(d.digest).slice(0, 16) + '…') : '');
  },
  gate_resolved: function (ev, ctx) {
    var d = ev.data || {};
    return '<div class="gate ' + (d.approved ? 'ok' : 'bad') + '">' + (d.approved ? '✓ approved' : '✕ denied') +
      (d.by ? ' by ' + esc(d.by) : '') + (d.via ? ' via ' + esc(d.via) : '') + '</div>' + flatKV(d, ['approved', 'by', 'via'], ctx && ctx.mode);
  },
  check_result: function (ev, ctx) {
    var d = ev.data || {}, st = checkEventState(ev);
    return '<div class="gate ' + (st === 'passed' ? 'ok' : st === 'failed' ? 'bad' : '') + '">' +
      (st === 'passed' ? '✓ ' : st === 'failed' ? '✕ ' : '– ') + esc(human(d.name || 'check')) + (st === 'not_on_path' ? ': not needed' : '') + '</div>' +
      (d.detail ? '<div class="note">' + esc(d.detail) + '</div>' : '') +
      ((d.evidence || []).length && !(ctx && ctx.mode === 'presentation') ? kv('evidence', d.evidence.join(', ')) : '');
  },
  step_finished: function (ev, ctx) {
    var d = ev.data || {};
    var tm = d.timings && !(ctx && ctx.mode === 'presentation') ? Object.keys(d.timings).map(function (k) { return k + ' ' + fmtMs(d.timings[k]); }).join(' · ') : '';
    return '<div class="row mono"><span class="tag">' + esc(ev.node) + '</span> ' + esc(d.status) +
      '<span class="right">' + fmtMs(d.latency_ms) + (d.latency_inferred ? ' (inferred)' : '') + (tm ? ' · ' + esc(tm) : '') + '</span></div>';
  },
  error: function (ev) { return '<div class="err">' + esc(ev.node) + ': ' + esc((ev.data || {}).message) + '</div>'; },
  tool_call: function (ev, ctx) {
    var d = ev.data || {};
    return '<div class="row mono"><span class="tag">' + esc(d.tool) + '</span> ' + esc(ev.node) + '</div>' + flatKV(d, ['tool'], ctx && ctx.mode);
  }
};
export function renderGeneric(ev, ctx) {
  var r = RENDER[ev.event_type];
  return r ? r(ev, ctx) : '<div class="row mono"><span class="tag">' + esc(ev.event_type) + '</span> ' + esc(ev.node) + '</div>' + flatKV(ev.data, null, ctx && ctx.mode);
}

// Declared panels (SPEC section 4): the map names the fields and how to format them.
export function fmtField(v, f) {
  if (v == null) return '–';
  switch (f) {
    case 'number': return String(Number(v));
    case 'number:1': case 'number:2': case 'number:4': return Number(v).toFixed(+f.split(':')[1]);
    case 'usd': return fmtUsd(v);
    case 'ms': return fmtMs(v);
    case 'tokens': return fmtTok(v);
    case 'percent': return (Number(v) * 100).toFixed(1) + '%';
    case 'json': return short(v, 400);
    default: return typeof v === 'object' ? short(v, 200) : String(v);
  }
}
export function renderFields(ev, fields) {
  return fields.map(function (f) {
    if (typeof f === 'string') f = { key: f };
    var v = ev.data ? ev.data[f.key] : undefined;
    if (f.format === 'quote') return v == null ? '' : '<div class="note">' + esc(v) + '</div>';
    return kv(f.label || f.key, fmtField(v, f.format));
  }).join('');
}

/* A story's ctx.h. `generic` renders in the given mode, so a story calling h.generic(ev)
   inherits Presentation's hiding without knowing about it. */
export function helpersFor(mode) {
  return { esc: esc, kv: kv, fmtMs: fmtMs, fmtUsd: fmtUsd, fmtTok: fmtTok, short: short, fields: renderFields,
           generic: function (ev) { return renderGeneric(ev, { mode: mode }); } };
}

// ---- modes (SPEC section 4a) --------------------------------------------------------------
export var MODES = ['presentation', 'engineering'];
var LEGACY = { overview: 'presentation', detailed: 'engineering' };
// Recordings and the shell's parent source are shown to people; a live stream is an engineer's.
export function sourceDefaultMode(source) { return source === 'live' ? 'engineering' : 'presentation'; }
/* ?mode= > the remembered choice (bench.mode, or the old bench.view migrated) > the source's
   default. `migrate` is the value to store when an old bench.view was translated. */
export function resolveMode(o) {
  o = o || {};
  if (MODES.indexOf(o.param) >= 0) return { mode: o.param, from: 'url', migrate: null };
  if (MODES.indexOf(o.stored) >= 0) return { mode: o.stored, from: 'stored', migrate: null };
  if (LEGACY[o.legacy]) return { mode: LEGACY[o.legacy], from: 'legacy', migrate: LEGACY[o.legacy] };
  return { mode: sourceDefaultMode(o.source), from: 'default', migrate: null };
}

// ---- events -------------------------------------------------------------------------------
// Recordings and postMessage bypass the receiver's alias normalization, so the viewer repeats it.
export var EVENT_ALIASES = { check: 'check_result' };
export function normalizeEvent(ev) {
  if (ev && EVENT_ALIASES[ev.event_type]) return Object.assign({}, ev, { event_type: EVENT_ALIASES[ev.event_type] });
  return ev;
}
var SAME_TS = { run_started: -2, step_started: -1, step_finished: 2, run_finished: 3 };
// ts, then seq, then a run opens before its steps and a step before its content.
export function eventOrder(a, b) {
  return (a.ts - b.ts) || ((a.seq != null && b.seq != null) ? a.seq - b.seq : 0) ||
    ((SAME_TS[a.event_type] || 1) - (SAME_TS[b.event_type] || 1));
}
export function sortEvents(events) { return events.slice().sort(eventOrder); }
function evText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(function (b) { return b && typeof b === 'object' ? (b.text != null ? b.text : b.content != null ? evText(b.content) : JSON.stringify(b)) : String(b); }).join('\n');
  return JSON.stringify(v, null, 2);
}
export var ioText = evText;

// ---- per-run state reduced from events ----------------------------------------------------
export function newRun(id) {
  return { id: id, events: [], steps: {}, stepOrder: [], nodeSteps: {}, open: {}, cost: { actual: 0, estimated: 0 },
           tok: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, t0: null, t1: null, status: null,
           gate: null, contentModes: {}, session: null, label: null, output: null, llmCalls: 0, explicit: false, lastTs: null };
}
function stepFor(run, ev) {
  return ev.step_id || (run.nodeSteps[ev.node] && run.nodeSteps[ev.node][run.nodeSteps[ev.node].length - 1]) || null;
}
/* Folds one event into the run. `now` is the wall clock (ms) the event was shown at, used only
   for pacing what's drawn; every time and number shown comes from the events. */
export function reduce(run, ev, now) {
  if (now == null) now = Date.now();
  run.events.push(ev);
  run.t0 = run.t0 == null ? ev.ts : Math.min(run.t0, ev.ts);
  run.t1 = run.t1 == null ? ev.ts : Math.max(run.t1, ev.ts);
  run.lastTs = run.lastTs == null ? ev.ts : Math.max(run.lastTs, ev.ts);
  run.contentModes[ev.content_mode || 'redacted'] = true;
  if (ev.session_id) run.session = ev.session_id;
  var d = ev.data || {};
  var t = ev.event_type;
  if (t === 'step_started') run.explicit = true;
  if (t === 'run_started') { run.label = d.label || (d.input ? short(d.input, 90) : null); run.input = d.input; run.started = d; return; }
  if (t === 'run_finished') {
    run.status = d.status; run.output = d.output != null ? d.output : run.output;
    Object.keys(run.open).forEach(function (sid) { var s = run.steps[sid]; s.end = ev.ts; s.inferred = true; s.status = s.status || 'ok'; s.arrEnd = now; });
    run.open = {};
    return;
  }
  if (ev.node === '_run') return;

  var sid = t === 'step_started' ? (ev.step_id || run.id + ':' + ev.node + ':' + ((run.nodeSteps[ev.node] || []).length + 1)) : stepFor(run, ev);
  if (!sid || !run.steps[sid]) {
    if (!sid) sid = run.id + ':' + ev.node + ':' + ((run.nodeSteps[ev.node] || []).length + 1);
    // Implicit boundary (SPEC section 2): the previous step ends at its own last event, and
    // this node's work began then. Skipped for runs that send explicit step boundaries (OTLP,
    // which also arrive out of order, so arrival order means nothing there).
    var start = ev.ts;
    if (!ev.parent_step_id && t !== 'step_started' && !run.explicit) {
      Object.keys(run.open).forEach(function (o) {
        var s = run.steps[o];
        if (!s.parent && s.node !== ev.node) { s.end = s.last; s.inferred = true; s.status = s.status || 'ok'; s.arrEnd = now; start = Math.min(start, s.last); delete run.open[o]; }
      });
    }
    run.steps[sid] = { id: sid, node: ev.node, parent: ev.parent_step_id || null, start: start, last: ev.ts, end: null, status: null,
                       events: [], latency: null, inferred: t !== 'step_started', timings: null, arr: now, arrEnd: null };
    run.stepOrder.push(sid);
    (run.nodeSteps[ev.node] = run.nodeSteps[ev.node] || []).push(sid);
    run.open[sid] = true;
  }
  var st = run.steps[sid];
  st.events.push(ev);
  st.last = Math.max(st.last || ev.ts, ev.ts);
  if (t === 'step_finished') {
    st.end = ev.ts; st.status = d.status; st.timings = d.timings || null;
    st.latency = d.latency_ms != null ? d.latency_ms : null;
    st.inferred = !!d.latency_inferred;
    st.arrEnd = now;
    delete run.open[sid];
  } else if (t === 'llm_call') {
    run.llmCalls++;
    if (d.cost_usd != null) run.cost[d.cost_source === 'actual' ? 'actual' : 'estimated'] += Number(d.cost_usd);
    run.tok.input += d.input_tokens || 0; run.tok.output += d.output_tokens || 0;
    run.tok.cache_read += d.cache_read_tokens || 0; run.tok.cache_write += d.cache_write_tokens || 0;
  } else if (t === 'gate_waiting') {
    run.gate = { node: ev.node, state: 'waiting', since: ev.ts, data: d };
  } else if (t === 'gate_resolved') {
    run.gate = { node: ev.node, state: d.approved ? 'approved' : 'denied', since: ev.ts, data: d };
  } else if (t === 'error') {
    st.status = 'error';
  }
}
/* True when `ev` arrived out of order for this run (OTLP batches export children first, the
   root last): the caller rebuilds the run from sorted events instead of folding it in. */
export function needsResort(run, ev) {
  if (!run || !run.events.length) return false;
  if (ev.event_type === 'run_started') return true;
  return ev.ts < run.lastTs;
}
export function rebuildRun(run, ev, now) {
  var fresh = newRun(run.id), old = run.steps;
  sortEvents(run.events.concat(ev ? [ev] : [])).forEach(function (e) { reduce(fresh, e, now); });
  // Keep the wall times steps were first shown at, so a re-sort doesn't replay the run's pacing.
  Object.keys(fresh.steps).forEach(function (sid) {
    if (old[sid]) { fresh.steps[sid].arr = old[sid].arr; if (fresh.steps[sid].arrEnd != null && old[sid].arrEnd != null) fresh.steps[sid].arrEnd = old[sid].arrEnd; }
  });
  return fresh;
}

// ---- the map ------------------------------------------------------------------------------
export function nodeOf(topo, id) {
  return ((topo && topo.nodes) || []).find(function (n) { return n.id === id; }) || null;
}
var KIND_ACTOR = { llm: 'ai', gate: 'person', check: 'rule' };
export function actorOf(node) {
  if (!node) return 'app';
  return node.actor || KIND_ACTOR[node.kind] || 'app';
}
export var ACTOR_WORDS = { ai: 'AI', rule: 'rule', person: 'person', app: 'app' };
export function plainLabel(node, id) { return node ? (node.plain_label || node.label || node.id) : id; }
export function techLabel(node, id) { return node ? (node.label || node.id) : id; }
export function hasBranches(topo, id) {
  return ((topo && topo.edges) || []).some(function (e) { return e.from === id && (e.from_branch || e.when); });
}
/* The nodes Play pauses at: the map's `moment: true` nodes; with none declared, decision nodes
   with branches, check nodes and gates (the outcome is always a stop). */
export function momentNodes(topo) {
  var nodes = (topo && topo.nodes) || [], out = {};
  var declared = nodes.filter(function (n) { return n.moment === true; });
  (declared.length ? declared : nodes.filter(function (n) {
    return n.kind === 'gate' || n.kind === 'check' || hasBranches(topo, n.id);
  })).forEach(function (n) { out[n.id] = true; });
  return out;
}

// ---- the step cursor (replay pacing) ------------------------------------------------------
/* A step is a node visit: consecutive top-level events on one node, a new step_started after
   that node finished counting as a new visit. Child steps belong to the visit they ran in. */
export function visits(events) {
  var out = [], cur = null;
  events.forEach(function (ev, i) {
    if (ev.node === '_run') return;
    if (ev.parent_step_id) { if (cur) cur.last = i; return; }
    var fresh = !cur || cur.node !== ev.node || (ev.event_type === 'step_started' && cur.finished);
    if (fresh) { cur = { node: ev.node, first: i, last: i, finished: false, gateAt: null }; out.push(cur); }
    cur.last = i;
    if (ev.event_type === 'step_finished') cur.finished = true;
    if (ev.event_type === 'gate_waiting' && cur.gateAt == null) cur.gateAt = i;
  });
  return out;
}
/* Event indices to stop after. `next`/`back` step through every visit; `moments` is where Play
   pauses on its own: after each moment node's visit, at a gate's "waiting" too, and at the end. */
export function cursorStops(events, topo) {
  var vs = visits(events), m = momentNodes(topo), last = events.length - 1;
  var steps = vs.map(function (v) { return v.last; });
  var moments = [];
  vs.forEach(function (v) {
    if (!m[v.node]) return;
    if (v.gateAt != null && v.gateAt < v.last) moments.push(v.gateAt);
    moments.push(v.last);
  });
  function fin(a) {
    if (last >= 0 && a.indexOf(last) < 0) a.push(last);
    return a.filter(function (x, i) { return a.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
  }
  return { steps: fin(steps), moments: fin(moments) };
}
export function nextStop(stops, i) { for (var k = 0; k < stops.length; k++) if (stops[k] > i) return stops[k]; return null; }
export function prevStop(stops, i) { for (var k = stops.length - 1; k >= 0; k--) if (stops[k] < i) return stops[k]; return -1; }

// ---- what happened, in plain words ---------------------------------------------------------
function nodeEvents(events, id) { return events.filter(function (e) { return e.node === id; }); }
function visited(events, id) { return events.some(function (e) { return e.node === id && !e.parent_step_id; }); }
function topLevel(events) { return events.filter(function (e) { return e.node !== '_run' && !e.parent_step_id; }); }

/* The edges this run took: a decision's branch names its edge exactly; otherwise two nodes
   that ran one after the other. `seq` is the node order (skipped steps left out by the caller). */
export function takenEdges(topo, events, seq) {
  var taken = {};
  if (!seq) {
    seq = [];
    topLevel(events).forEach(function (e) { if (seq[seq.length - 1] !== e.node) seq.push(e.node); });
  }
  for (var i = 1; i < seq.length; i++) taken[seq[i - 1] + '>' + seq[i]] = true;
  events.forEach(function (e) {
    if (e.event_type !== 'decision' || !e.data || e.data.branch == null) return;
    ((topo && topo.edges) || []).forEach(function (ed) { if (ed.from === e.node && ed.from_branch === e.data.branch) taken[ed.from + '>' + ed.to] = true; });
  });
  return taken;
}
export function takenOut(topo, events, id) {
  var taken = takenEdges(topo, events);
  return ((topo && topo.edges) || []).filter(function (ed) { return ed.from === id && taken[ed.from + '>' + ed.to]; });
}

/* One line on a node box saying what it produced (extracted from bench.js's node preview).
   Engineering may quote the output; Presentation keeps to the branch, the check, the gate,
   an error or a count. */
export function preview(steps, mode, sourceCount, isCheck) {
  var out = null, pres = mode === 'presentation', checked = false;
  steps.forEach(function (s) {
    s.events.forEach(function (e) {
      var d = e.data || {};
      // On a check node, Presentation shows the verdict over the branch name it also reports.
      if (e.event_type === 'decision' && d.branch != null) { if (!(pres && isCheck && checked)) out = '→ ' + human(d.branch); }
      else if (e.event_type === 'gate_resolved') out = d.approved ? '✓ approved' : '✕ denied';
      else if (e.event_type === 'gate_waiting') out = out || (pres ? '⏸ waiting for a person' : '⏸ waiting for a human');
      else if (e.event_type === 'check_result' && ((pres && isCheck) || !out)) { var st = checkEventState(e); checked = true; out = st === 'passed' ? '✓ passed' : st === 'failed' ? '✕ didn’t pass' : '– not needed'; }
      else if (e.event_type === 'error') out = '✕ ' + (pres ? 'something went wrong' : (d.message || 'error'));
      else if (e.event_type === 'retrieval' && d.hits) out = out || (pres
        ? (sourceCount ? d.hits.length + ' of ' + sourceCount : d.hits.length + ' found')
        : (d.hits.length + ' hit' + (d.hits.length === 1 ? '' : 's') + (d.hits[0] && d.hits[0].title ? ': ' + d.hits[0].title : '')));
      else if (!pres && e.event_type === 'llm_call' && d.output != null && !out) out = '“' + short(typeof d.output === 'string' ? d.output : JSON.stringify(d.output), 60) + '”';
      else if (!pres && e.event_type === 'step_finished' && d.output != null && !out) out = '“' + short(typeof d.output === 'string' ? d.output : JSON.stringify(d.output), 60) + '”';
    });
  });
  return out ? String(out).replace(/\s+/g, ' ') : '';
}

// ---- checks -------------------------------------------------------------------------------
// The schema doesn't tie `state` to `passed`; trust `passed`, and use `state` only for not_on_path.
export function checkEventState(ev) {
  var d = ev.data || {};
  if (d.state === 'not_on_path') return 'not_on_path';
  return d.passed ? 'passed' : 'failed';
}
var CHECK_WORDS = {
  passed: '✓ Passed.', failed: '✕ Didn’t pass.', not_on_path: '– Not needed this time.', running: 'Checking…',
  ran: 'Ran.', pending: 'Not reached yet.'
};
function fillCopy(s, d) {
  return String(s).replace(/\{(\w+)\}/g, function (_, k) { return d && d[k] != null ? String(d[k]) : ''; });
}
/* The Checks row: every `kind: check` node, plus each distinct check_result name seen on any
   other node (e.g. a confidence check inside a classify step). A check node can carry its own
   per-state copy as `x-states: {passed, failed, not_on_path}` ({detail} fills in), or just its
   "not needed" line as `x-not-needed` (the helpdesk's form). */
function stateCopy(n) {
  var c = {}, k;
  if (typeof n['x-not-needed'] === 'string') c.not_on_path = n['x-not-needed'];
  for (k in (n['x-states'] || {})) c[k] = n['x-states'][k];
  return c;
}
export function checkStates(topo, events, finished) {
  var rows = [], byName = {};
  ((topo && topo.nodes) || []).filter(function (n) { return n.kind === 'check'; }).forEach(function (n) {
    var evs = events.filter(function (e) { return e.node === n.id && e.event_type === 'check_result'; });
    var state, detail = null, evidence = [];
    if (evs.length) {
      var states = evs.map(checkEventState);
      state = states.indexOf('failed') >= 0 ? 'failed' : states.every(function (s) { return s === 'not_on_path'; }) ? 'not_on_path' : 'passed';
      var pick = evs.filter(function (e) { return checkEventState(e) === state; })[0] || evs[0];
      detail = (pick.data || {}).detail || null;
      evs.forEach(function (e) { ((e.data || {}).evidence || []).forEach(function (x) { if (evidence.indexOf(x) < 0) evidence.push(x); }); });
    } else if (visited(events, n.id)) {
      var errored = nodeEvents(events, n.id).some(function (e) { return e.event_type === 'error'; });
      var done = nodeEvents(events, n.id).some(function (e) { return e.event_type === 'step_finished'; });
      state = errored ? 'failed' : done || finished ? 'ran' : 'running';
    } else state = finished ? 'not_on_path' : 'pending';
    rows.push(checkRow(n.id, plainLabel(n), n.description || '', state, detail, evidence, stateCopy(n)));
    evs.forEach(function (e) { byName[(e.data || {}).name] = true; });
  });
  var named = {};
  events.forEach(function (e) {
    if (e.event_type !== 'check_result') return;
    var nd = nodeOf(topo, e.node);
    if (nd && nd.kind === 'check') return;
    var name = (e.data || {}).name || 'check';
    (named[name] = named[name] || []).push(e);
  });
  Object.keys(named).forEach(function (name) {
    var evs = named[name], states = evs.map(checkEventState);
    var state = states.indexOf('failed') >= 0 ? 'failed' : states.every(function (s) { return s === 'not_on_path'; }) ? 'not_on_path' : 'passed';
    var d = evs[evs.length - 1].data || {};
    rows.push(checkRow(name, d.label || human(name), d.description || '', state, d.detail || null, d.evidence || [], null));
  });
  return rows;
}
function checkRow(id, label, description, state, detail, evidence, copy) {
  var line = copy && copy[state] ? fillCopy(copy[state], { detail: detail }) : CHECK_WORDS[state] + (detail && state !== 'passed' ? ' ' + detail : '');
  return { id: id, label: label, description: description, state: state, detail: detail, evidence: evidence, line: line.trim() };
}

// ---- sources: could look at / given to the AI / relied on ---------------------------------
function promptTexts(events) {
  return events.filter(function (e) { return e.event_type === 'llm_call'; }).map(function (e) {
    var d = e.data || {};
    return { ts: e.ts, seq: e.seq, mode: e.content_mode || 'redacted',
             text: [evText(d.system)].concat((d.messages || []).map(function (m) { return evText(m && m.content); })).join('\n'),
             context: d.context_items || [] };
  });
}
function hitSource(topo, ev, hit) {
  var srcs = (topo && topo.sources) || [];
  var named = (ev.data || {}).source;
  if (named) return named;
  var byItem = srcs.filter(function (s) { return (s.items || []).some(function (it) { return it.id === hit.id; }); })[0];
  if (byItem) return byItem.id;
  var docs = srcs.filter(function (s) { return s.kind === 'documents'; });
  return docs.length === 1 ? docs[0].id : '_search';
}
/* Per declared source (plus a "_search" pseudo-source for hits no declared source owns):
   every item with its state, and the count line. "given" is verified, not trusted: the hit's
   text must appear in a later model call's prompt in the same run. Without prompt text to
   check against, it stays "found by the search" (context_items, if sent, is noted as a hint). */
export function sourceStates(topo, events) {
  var srcs = ((topo && topo.sources) || []).map(function (s) { return s; });
  var prompts = promptTexts(events);
  var relied = {}, failedStep = {};
  events.forEach(function (e) {
    if (e.event_type === 'check_result' && e.step_id && checkEventState(e) === 'failed') failedStep[e.step_id] = true;
  });
  events.forEach(function (e) {
    var d = e.data || {};
    if (e.event_type === 'check_result') (d.evidence || []).forEach(function (x) { relied[x] = true; });
    // A decision's citations don't count when a check in the same step failed them (e.g. an
    // answer that didn't match the sections it cites was never sent).
    if (e.event_type === 'decision' && !(e.step_id && failedStep[e.step_id])) (d.cited || []).forEach(function (x) { relied[x] = true; });
  });
  var found = {};   // source id -> {item id -> hit}
  var anyRetrieval = false;
  events.forEach(function (e) {
    if (e.event_type !== 'retrieval') return;
    anyRetrieval = true;
    ((e.data || {}).hits || []).forEach(function (h) {
      var sid = hitSource(topo, e, h);
      found[sid] = found[sid] || {};
      if (!found[sid][h.id]) found[sid][h.id] = { hit: h, ts: e.ts, seq: e.seq };
    });
  });
  if (found._search && !srcs.some(function (s) { return s.id === '_search'; })) srcs.push({ id: '_search', title: 'What the search found', kind: 'search', description: '', _undeclared: true });
  Object.keys(found).forEach(function (sid) {
    if (sid !== '_search' && !srcs.some(function (s) { return s.id === sid; })) srcs.push({ id: sid, title: human(sid), kind: 'unknown', description: '', _undeclared: true });
  });
  var checkable = prompts.some(function (p) { return p.text.trim(); });
  return srcs.map(function (s) {
    var f = found[s.id] || {};
    var items = (s.items || []).map(function (it) { return { id: it.id, title: it.title }; });
    Object.keys(f).forEach(function (id) { if (!items.some(function (it) { return it.id === id; })) items.push({ id: id, title: f[id].hit.title || id }); });
    var given = 0, nfound = 0, nrelied = 0, hinted = 0;
    items.forEach(function (it) {
      var h = f[it.id];
      it.state = 'could';
      if (h) {
        nfound++;
        it.state = 'found';
        it.text = h.hit.text || null;
        it.hit = h.hit;
        var txt = h.hit.text && h.hit.text.trim();
        if (txt && prompts.some(function (p) { return p.ts >= h.ts && p.text.indexOf(txt) >= 0; })) { it.state = 'given'; given++; }
        else if (prompts.some(function (p) { return p.context.indexOf(it.id) >= 0; })) { it.hinted = true; hinted++; }
      }
      if (relied[it.id] && it.state !== 'could') { it.relied = true; nrelied++; }
    });
    var total = s.count != null ? s.count : (s.items ? s.items.length : null);
    var verified = given > 0 || (checkable && nfound > 0);
    var parts = [];
    if (nfound) {
      if (given) parts.push('Given ' + given + (total != null ? ' of ' + total : ''));
      else parts.push((checkable ? 'Found ' : 'Search found ') + nfound + (total != null ? ' of ' + total : '') + (checkable ? ', none of it given to the AI' : ''));
      if (nrelied) parts.push((given ? 'its answer rests on ' : 'rests on ') + nrelied);
    }
    return { id: s.id, title: s.title, kind: s.kind, description: s.description || '', count: total, items: items,
             found: nfound, given: given, relied: nrelied, hinted: hinted, verified: verified, undeclared: !!s._undeclared,
             line: parts.join(' · ') };
  }).concat([]).filter(function (s) { return !s.undeclared || s.found; }).map(function (s) { s.anyRetrieval = anyRetrieval; return s; });
}
export function sourcesLine(states, finished) {
  var used = states.filter(function (s) { return s.found; });
  if (used.length) return used.map(function (s) { return s.title + ': ' + s.line; }).join(' · ');
  if (!states.length) return 'The app doesn’t say what it can see.';
  return (finished === false ? 'Nothing looked up yet' : 'Nothing was looked up this time') + ' · it can see ' + states.map(function (s) { return s.title; }).join(', ');
}

// ---- who signed off -------------------------------------------------------------------------
export function clock(ts) {
  if (ts == null) return '';
  var d = new Date(ts * 1000), h = d.getHours(), m = d.getMinutes();
  return ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
}
function proposedTitle(p) {
  if (!p || typeof p !== 'object') return p ? String(p) : '';
  return p.title || p.summary || p.action_type && human(p.action_type) || p.route_to && ('route to ' + p.route_to) || '';
}
export function gateState(topo, events, finished) {
  var gates = ((topo && topo.nodes) || []).filter(function (n) { return n.kind === 'gate'; });
  var w = null, r = null;
  events.forEach(function (e) { if (e.event_type === 'gate_waiting') w = e; if (e.event_type === 'gate_resolved') r = e; });
  if (r) {
    var d = r.data || {}, who = d.by || 'a person';
    return { state: d.approved ? 'approved' : 'denied', by: d.by || null, at: r.ts, proposed: (w && w.data && w.data.proposed) || null, node: r.node,
             line: (d.approved ? '✓ Approved by ' : '✕ Denied by ') + who + (r.ts ? ', ' + clock(r.ts) : '') + (w && proposedTitle(w.data.proposed) ? ': ' + proposedTitle(w.data.proposed) : '') };
  }
  if (w) return { state: 'waiting', at: w.ts, proposed: (w.data || {}).proposed || null, node: w.node,
                  line: '⏸ Waiting for a person to approve' + (proposedTitle((w.data || {}).proposed) ? ': ' + proposedTitle(w.data.proposed) : (w.data && w.data.reason ? ': ' + w.data.reason : '')) };
  // Only what the map declares: an inferred map can't know about sign-offs it never saw.
  if (!gates.length) return { state: 'none', line: 'The app declares no sign-off step.' };
  return { state: finished ? 'not_needed' : 'pending', line: finished ? '– Not needed this time.' : 'Not reached yet.' };
}

// ---- time, cost, baseline -------------------------------------------------------------------
/* AI time vs waiting time. Waiting is gate_waiting → gate_resolved (or the run's end, if it
   never resolved). Everything else in the run's span counts as the app's own work. */
/* `nowTs` (unix seconds) is for live sources only: a gate still open is waiting until now. */
export function timeSplit(events, nowTs) {
  if (!events.length) return { total: 0, waiting: 0, work: 0, gated: false };
  var t0 = Infinity, t1 = -Infinity, waiting = 0, open = null, gated = false;
  sortEvents(events).forEach(function (e) {
    t0 = Math.min(t0, e.ts); t1 = Math.max(t1, e.ts);
    if (e.event_type === 'gate_waiting') { gated = true; if (open == null) open = e.ts; }
    if (e.event_type === 'gate_resolved' && open != null) { waiting += e.ts - open; open = null; }
  });
  if (open != null) { if (nowTs != null && nowTs > t1) t1 = nowTs; waiting += t1 - open; }
  var total = t1 - t0;
  return { total: total, waiting: waiting, work: Math.max(0, total - waiting), gated: gated };
}
export function secsWords(s) {
  if (s == null || isNaN(s)) return '–';
  if (s < 1) return 'under a second';
  if (s < 10) return (Math.round(s * 10) / 10) + ' s';
  if (s < 90) return Math.round(s) + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return (Math.round(s / 360) / 10) + ' h';
}
export function timeLine(split) {
  if (split.gated) return 'AI work: ' + secsWords(split.work) + ' · waiting for a person: ' + secsWords(split.waiting);
  return 'Took ' + secsWords(split.total);
}
export function costWords(usd) {
  if (usd == null || isNaN(usd)) return '';
  usd = Number(usd);
  if (usd <= 0) return 'no AI cost';
  if (usd < 0.005) return 'less than a cent';
  if (usd < 0.995) return 'about ' + Math.round(usd * 100) + '¢';
  return 'about $' + usd.toFixed(usd < 10 ? 2 : 0);
}
export function runCost(events) {
  return events.reduce(function (a, e) { return a + (e.event_type === 'llm_call' && e.data && e.data.cost_usd != null ? Number(e.data.cost_usd) : 0); }, 0);
}
export function baselineOf(events) {
  var b = null;
  events.forEach(function (e) { if (e.event_type === 'run_finished' && e.data && typeof e.data.baseline === 'string') b = e.data.baseline; });
  return b ? b.replace(/^\s*manual\s*:\s*/i, '').trim() : null;
}

// ---- the outcome ------------------------------------------------------------------------------
var OUTCOME = {
  answered: 'Answered', answer: 'Answered', responded: 'Answered', replied: 'Answered',
  executed: 'Done', done: 'Done', completed: 'Done', created: 'Done',
  handed_off: 'Handed to a person', handoff: 'Handed to a person', escalated: 'Handed to a person', escalate: 'Handed to a person',
  needs_human: 'Handed to a person', denied: 'Stopped: a person said no', rejected: 'Stopped: a person said no',
  error: 'Something went wrong', failed: 'Something went wrong', aborted: 'Stopped before it finished'
};
var HANDOFF_NODE = /hand.?off|escalat|human|to a person/i;
/* The header's outcome in audit words (answered / done, approved by a person / handed to a
   person), plus a "Why" from the rationale when the run ended with a person. */
export function outcome(topo, events) {
  var fin = null, named = null, rationale = null, gate = null, err = null, action = null;
  events.forEach(function (e) {
    var d = e.data || {};
    if (e.event_type === 'run_finished') { fin = e; if (d.outcome) named = d.outcome; }
    else if (d.outcome && typeof d.outcome === 'string' && !named) named = d.outcome;
    if (e.event_type === 'decision' && d.rationale) rationale = d.rationale;
    if (e.event_type === 'gate_resolved') gate = d;
    if (e.event_type === 'gate_waiting' && d.proposed) action = d.proposed;
    if (e.event_type === 'error') err = d.message || 'error';
  });
  var handed = topLevel(events).some(function (e) {
    var n = nodeOf(topo, e.node);
    return HANDOFF_NODE.test(e.node) || (n && HANDOFF_NODE.test((n.plain_label || '') + ' ' + (n.label || '')) && n.kind !== 'gate');
  });
  if (!fin) {
    var waiting = events.some(function (e) { return e.event_type === 'gate_waiting'; }) && !gate;
    return { done: false, text: err ? 'Something went wrong' : waiting ? 'Waiting for a person to approve' : events.length ? 'Working…' : '', why: null };
  }
  var fd = fin.data || {};
  var text;
  if (fd.status === 'error' || err) text = 'Something went wrong' + (err ? ': ' + err : '');
  else if (gate && gate.approved === false) text = 'Stopped: a person said no, so nothing was done';
  else if (named && OUTCOME[named] === 'Done' || (!named && gate && gate.approved)) {
    var acts = (topo && topo.actions) || [], t = action && (action.action_type || action.type);
    var act = acts.filter(function (a) { return a.id === t; })[0];
    var what = act ? act.title : proposedTitle(action);
    text = 'Done' + (what ? ': ' + what : '') + (gate && gate.approved ? ', approved by a person' : '');
  }
  else if (named) text = OUTCOME[named] || human(named).replace(/^./, function (c) { return c.toUpperCase(); });
  else if (handed) text = 'Handed to a person';
  else text = 'Finished';
  // "Why" only when a person ends up with it (handed over, or a person said no), not on an approval.
  var why = /Handed to a person|said no/.test(text) && rationale ? rationale : null;
  return { done: true, text: text, why: why };
}

// ---- the NOW card -----------------------------------------------------------------------------
/* What the NOW card says about one node, in this order: its note (description), the taken
   edge's note, then the reasons the step's own events give. The generic per-event lines are a
   fallback for maps with no notes (Level 0). Never a number except time and counts. */
export function narrate(topo, events, id, opts) {
  opts = opts || {};
  var node = nodeOf(topo, id), evs = nodeEvents(events, id), lines = [];
  var out = { id: id, title: plainLabel(node, id), technical: techLabel(node, id), actor: actorOf(node), kind: (node && node.kind) || 'step', lines: lines, ran: evs.length > 0 };
  var noted = !!(node && node.description);
  if (noted) lines.push({ kind: 'note', text: node.description });
  if (!evs.length) {
    if (node && node.kind === 'check' && opts.finished) {
      var row = checkStates(topo, events, true).filter(function (c) { return c.id === id; })[0];
      lines.push({ kind: 'state', text: row ? row.line : CHECK_WORDS.not_on_path });
    } else lines.push({ kind: 'muted', text: opts.finished ? 'This step didn’t run this time.' : 'Not reached yet.' });
    return out;
  }
  var edges = takenOut(topo, events, id), edged = false;
  edges.forEach(function (ed) { if (ed.description) { lines.push({ kind: 'edge', text: ed.description }); edged = true; } });
  var fallback = !noted && !edged;
  evs.forEach(function (e) {
    var d = e.data || {}, t = e.event_type;
    if (t === 'decision') {
      if (fallback && d.branch != null) lines.push({ kind: 'state', text: 'Chose: ' + human(d.branch) + '.' });
      if (d.rationale) lines.push({ kind: 'why', text: d.rationale });
      if (d.reason && d.reason !== 'ok' && d.reason !== d.rationale) lines.push({ kind: 'why', text: d.reason });
    } else if (t === 'check_result') {
      var st = checkEventState(e), copy = node && stateCopy(node);
      var who = node && node.kind === 'check' ? '' : (d.label || human(d.name)) + ': ';
      var said = d.detail ? CHECK_WORDS[st].split(' ')[0] + ' ' + d.detail : CHECK_WORDS[st];
      lines.push({ kind: 'state', cls: st, text: copy && copy[st] ? who + fillCopy(copy[st], d) : who + said });
    } else if (t === 'gate_waiting') {
      lines.push({ kind: 'state', cls: 'waiting', text: '⏸ Waiting for a person to approve' + (proposedTitle(d.proposed) ? ': ' + proposedTitle(d.proposed) : '') });
    } else if (t === 'gate_resolved') {
      lines.push({ kind: 'state', cls: d.approved ? 'passed' : 'failed', text: (d.approved ? '✓ Approved by ' : '✕ Denied by ') + (d.by || 'a person') + (e.ts ? ', ' + clock(e.ts) : '') + '.' });
    } else if (t === 'error') {
      lines.push({ kind: 'state', cls: 'failed', text: 'Something went wrong: ' + (d.message || 'error') });
    } else if (t === 'retrieval') {
      var hits = d.hits || [];
      var src = sourceStates(topo, events).filter(function (s) { return s.items.some(function (it) { return hits.some(function (h) { return h.id === it.id; }); }); })[0];
      lines.push({ kind: 'state', text: (hits.length ? 'Found ' + hits.length + (src && src.count != null ? ' of ' + src.count : '') + (src && !src.undeclared ? ' in ' + src.title : '') + ': ' +
        hits.map(function (h) { return h.title || h.id; }).join(' · ') : 'Found nothing.') });
    } else if (t === 'llm_call' && fallback) {
      lines.push({ kind: 'state', text: 'The AI was asked something; see what it was given.' });
    } else if (t === 'tool_call' && fallback) {
      lines.push({ kind: 'state', text: 'Did: ' + human(d.tool || id) + '.' });
    } else if (t !== 'llm_call' && d.reason && typeof d.reason === 'string' && d.reason !== 'ok') {
      lines.push({ kind: 'why', text: d.reason });
    }
  });
  out.model = evs.some(function (e) { return e.event_type === 'llm_call'; });
  return out;
}

// ---- "What the AI was given" -------------------------------------------------------------------
export var ROLE_WORDS = { system: 'Its instructions', developer: 'Its instructions', user: 'The message it was sent', assistant: 'What it said earlier', tool: 'What a tool returned', output: 'What it answered' };
/* Splits `text` into segments, marking every retrieval hit's text found in it. Ranges are found
   in the raw string first and escaped per segment after, so offsets never drift. */
export function highlightSegments(text, hits) {
  text = String(text == null ? '' : text);
  var ranges = [];
  (hits || []).forEach(function (h) {
    var t = h.text && String(h.text).trim();
    if (!t || t.length < 12) return;
    var at = text.indexOf(t);
    while (at >= 0) {
      ranges.push({ a: at, b: at + t.length, hit: h });
      at = text.indexOf(t, at + t.length);
    }
  });
  ranges.sort(function (x, y) { return x.a - y.a || y.b - x.b; });
  var segs = [], pos = 0;
  ranges.forEach(function (r) {
    if (r.a < pos) return;          // overlapping: the earlier, longer range wins
    if (r.a > pos) segs.push({ text: text.slice(pos, r.a) });
    segs.push({ text: text.slice(r.a, r.b), hit: r.hit });
    pos = r.b;
  });
  if (pos < text.length || !segs.length) segs.push({ text: text.slice(pos) });
  return segs;
}
/* The run's model calls as plain blocks: role words instead of roles, and the hits each block
   contains (with the source title they came from). */
export function givenBlocks(topo, events) {
  var hits = [];
  var states = sourceStates(topo, events);
  events.forEach(function (e) {
    if (e.event_type !== 'retrieval') return;
    ((e.data || {}).hits || []).forEach(function (h) {
      var src = states.filter(function (s) { return s.items.some(function (it) { return it.id === h.id; }); })[0];
      hits.push({ id: h.id, title: h.title || h.id, text: h.text, source: src && !src.undeclared ? src.title : null, node: e.node });
    });
  });
  return events.filter(function (e) { return e.event_type === 'llm_call'; }).map(function (e) {
    var d = e.data || {}, blocks = [];
    if (d.system != null) blocks.push({ role: 'system', label: ROLE_WORDS.system, text: evText(d.system) });
    (d.messages || []).forEach(function (m) { blocks.push({ role: m.role, label: ROLE_WORDS[m.role] || human(m.role || 'message'), text: evText(m && m.content) }); });
    if (d.output != null) blocks.push({ role: 'output', label: ROLE_WORDS.output, text: evText(d.output) });
    blocks.forEach(function (b) { b.segments = highlightSegments(b.text, hits); });
    return { node: e.node, title: plainLabel(nodeOf(topo, e.node), e.node), blocks: blocks, mode: e.content_mode || 'redacted' };
  });
}
var PLACEHOLDER = /\[(?:redacted|masked|email|phone|name|address|private key|api key|aws key|jwt|[a-z]+ token)\]|<redacted>/i;
/* The one privacy line Presentation ever shows, inside the overlay, and only when masked
   placeholders actually appear. It never claims what the AI saw: only the app's own
   privacy_note may say that. */
export function privacyLine(topo, events) {
  var masked = events.some(function (e) {
    if (e.event_type !== 'llm_call' && e.event_type !== 'run_started' && e.event_type !== 'retrieval') return false;
    return PLACEHOLDER.test(JSON.stringify(e.data || {}));
  });
  if (!masked) return null;
  var note = topo && topo.app && topo.app.privacy_note;
  return note || 'Some details are replaced with placeholders on this screen.';
}
export function contentModeWords(modes) {
  var ks = Object.keys(modes || {});
  if (ks.length > 1) return 'prompts: mixed';
  return { full: 'prompts: shown in full', absent: 'prompts: not captured', redacted: 'prompts: personal details masked' }[ks[0]] || 'prompts: personal details masked';
}

// ---- the requester ------------------------------------------------------------------------------
export function requesterOf(events) {
  var r = null;
  events.forEach(function (e) { if (e.event_type === 'run_started' && e.data && e.data.requester != null) r = e.data.requester; });
  if (r == null) return '';
  if (typeof r === 'string') return r;
  return [r.name, r.role || r.access].filter(Boolean).join(' · ');
}

// ---- Level 0: a map inferred from the trace -------------------------------------------------------
// semconv span names like "chat gpt-4o" would make a node per model; key LLM spans by operation.
var LLM_SPAN = /^(chat|text_completion|generate_content|embeddings)\s+\S.*$/;
export function canonicalNode(name) {
  var m = LLM_SPAN.exec(String(name || ''));
  return m ? m[1] : name;
}
var KIND_BY_EVENT = { llm_call: 'llm', retrieval: 'retrieval', tool_call: 'tool', gate_waiting: 'gate', gate_resolved: 'gate', check_result: 'check' };
/* Nodes in order of first start; edges from sibling order (same parent step) by start time,
   plus parent → first child; de-duplicated. Labelled "map inferred from the trace". */
export function inferMap(events, appId, appName) {
  var evs = sortEvents(events.map(normalizeEvent)), nodes = [], seen = {}, kinds = {};
  var stepNode = {}, stepParent = {}, stepStart = {};
  evs.forEach(function (e) {
    if (e.node === '_run') return;
    var n = canonicalNode(e.node);
    if (!seen[n]) { seen[n] = true; nodes.push(n); }
    var k = KIND_BY_EVENT[e.event_type];
    if (k && (!kinds[n] || k === 'llm')) kinds[n] = k;
    var sid = e.step_id || (e.run_id + ':' + n);
    if (!(sid in stepNode)) { stepNode[sid] = n; stepParent[sid] = e.parent_step_id || null; stepStart[sid] = e.ts; }
  });
  var groups = {};
  Object.keys(stepNode).forEach(function (sid) {
    var p = stepParent[sid] && stepNode[stepParent[sid]] ? stepParent[sid] : '_root';
    (groups[p] = groups[p] || []).push(sid);
  });
  var edges = [], have = {};
  function add(a, b) { if (a === b || have[a + '>' + b]) return; have[a + '>' + b] = true; edges.push({ from: a, to: b }); }
  Object.keys(groups).forEach(function (p) {
    var sids = groups[p].sort(function (a, b) { return stepStart[a] - stepStart[b]; });
    if (p !== '_root' && sids.length) add(stepNode[p], stepNode[sids[0]]);
    for (var i = 1; i < sids.length; i++) add(stepNode[sids[i - 1]], stepNode[sids[i]]);
  });
  return {
    v: 'bench-topology/0', inferred: true,
    app: { id: appId || 'app', name: appName || appId || 'app', description: 'map inferred from the trace' },
    nodes: nodes.map(function (n) { return { id: n, label: n, kind: kinds[n] || 'step' }; }),
    edges: edges, panels: []
  };
}

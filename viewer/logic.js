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
  return ms >= 10000 ? (ms / 1000).toFixed(1) + 's' : ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms > 0 && ms < 9.95 ? (Math.round(ms * 10) / 10) + 'ms' : Math.round(ms) + 'ms';
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
    return '<div class="gate waiting">⏸ ' + (pres ? 'waiting for a person to approve' : 'waiting at <b>' + esc(ev.node) + '</b>, decided in the app') + '</div>' +
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
  // The map this run carried (a run_updated may bring it late): the viewer draws the run with it.
  if ((t === 'run_started' || t === 'run_updated') && typeof d.map_hash === 'string') run.mapHash = d.map_hash;
  if (t === 'run_started') { run.label = d.label || (d.input ? short(d.input, 90) : null); run.input = d.input; run.started = d; return; }
  // What the bench learned about the run after opening it (an agentlab run's input arrives on its
  // run span, which ends last; a map can arrive after the first steps): merged into run_started.
  if (t === 'run_updated') {
    run.started = Object.assign({}, run.started || {}, d);
    if (d.input !== undefined) { run.input = d.input; if (!(run.started && run.started.label)) run.label = d.input ? short(d.input, 90) : run.label; }
    return;
  }
  if (t === 'run_finished') {
    run.status = d.status; run.output = d.output != null ? d.output : run.output;
    Object.keys(run.open).forEach(function (sid) { var s = run.steps[sid]; s.end = ev.ts; s.inferred = true; s.status = s.status || 'ok'; s.arrEnd = now; });
    run.open = {};
    return;
  }
  if (ev.node === '_run') return;

  var sid = t === 'step_started' ? (ev.step_id || run.id + ':' + ev.node + ':' + ((run.nodeSteps[ev.node] || []).length + 1)) : stepFor(run, ev);
  // A parent nests a step only when it is itself a step of this run. OTLP children name the
  // root agent span as their parent, and that span is the run, not a step (SPEC section 6b).
  var par = ev.parent_step_id && run.steps[ev.parent_step_id] ? ev.parent_step_id : null;
  if (!sid || !run.steps[sid]) {
    if (!sid) sid = run.id + ':' + ev.node + ':' + ((run.nodeSteps[ev.node] || []).length + 1);
    // Implicit boundary (SPEC section 2): the previous step ends at its own last event, and
    // this node's work began then. Skipped for runs that send explicit step boundaries (OTLP,
    // which also arrive out of order, so arrival order means nothing there).
    var start = ev.ts;
    if (!par && t !== 'step_started' && !run.explicit) {
      Object.keys(run.open).forEach(function (o) {
        var s = run.steps[o];
        if (!s.parent && s.node !== ev.node) { s.end = s.last; s.inferred = true; s.status = s.status || 'ok'; s.arrEnd = now; start = Math.min(start, s.last); delete run.open[o]; }
      });
    }
    run.steps[sid] = { id: sid, node: ev.node, parent: par, start: start, last: ev.ts, end: null, status: null,
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
    run.gate = { node: ev.node, state: 'waiting', since: ev.ts, seenAt: now, data: d };
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
/* Who does a step: the map's `actor`, else what its `kind` implies, else (no words at all) what the
   run shows: a step that called the AI is the AI's. `events` (optional) is the run's events. */
export function actorOf(node, events) {
  if (!node) return 'app';
  if (node.actor || KIND_ACTOR[node.kind]) return node.actor || KIND_ACTOR[node.kind];
  if (events && events.some(function (e) { return e.node === node.id && e.event_type === 'llm_call'; })) return 'ai';
  return 'app';
}
// Whether the map itself says who does the step (its actor, or a kind that implies one).
export function actorDeclared(node) { return !!(node && (node.actor || KIND_ACTOR[node.kind])); }
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

// ---- nesting ----------------------------------------------------------------------------------
/* The step ids the events themselves open. A parent_step_id outside this set (an OTLP root
   agent span, which is the run itself) doesn't nest anything: its children are top-level steps. */
export function stepIds(events) {
  var s = {};
  events.forEach(function (e) { if (e.step_id && e.node !== '_run') s[e.step_id] = true; });
  return s;
}
export function nested(ev, steps) { return !!(ev.parent_step_id && steps[ev.parent_step_id]); }

// ---- the step cursor (replay pacing) ------------------------------------------------------
/* A step is a node visit: consecutive top-level events on one node, a new step_started after
   that node finished counting as a new visit. Child steps belong to the visit they ran in. */
export function visits(events) {
  var out = [], cur = null, steps = stepIds(events);
  events.forEach(function (ev, i) {
    if (ev.node === '_run') return;
    if (nested(ev, steps)) { if (cur) cur.last = i; return; }
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
  var steps = vs.map(function (v, i) { return visitStop(vs, i, events, topo); });
  var moments = [];
  vs.forEach(function (v, i) {
    if (!m[v.node]) return;
    if (v.gateAt != null && v.gateAt < v.last) moments.push(v.gateAt);
    moments.push(visitStop(vs, i, events, topo));
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
function visited(events, id) { var s = stepIds(events); return events.some(function (e) { return e.node === id && !nested(e, s); }); }
function topLevel(events) { var s = stepIds(events); return events.filter(function (e) { return e.node !== '_run' && !nested(e, s); }); }

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
  var taken = takenEdges(topo, events), picked = null;
  var outs = ((topo && topo.edges) || []).filter(function (ed) { return ed.from === id && taken[ed.from + '>' + ed.to]; });
  // Two branches to the same next step (a many-to-one path map): the run's decision names which.
  events.forEach(function (e) { if (e.event_type === 'decision' && e.node === id && e.data && e.data.branch != null) picked = e.data.branch; });
  var exact = picked == null ? [] : outs.filter(function (ed) { return ed.from_branch === picked; });
  return exact.length ? exact : outs;
}

/* One line on a node box saying what it produced (extracted from bench.js's node preview).
   Engineering may quote the output; Presentation keeps to the branch, the check, the gate,
   an error or a count. */
export function preview(steps, mode, sourceCount, isCheck, topo) {
  var out = null, pres = mode === 'presentation', checked = false;
  // Presentation names a branch the way the map does: the edge's plain_label, else where it goes.
  function branchWords(node, branch) {
    if (!pres) return human(branch);
    var ed = ((topo && topo.edges) || []).filter(function (x) { return x.from === node && x.from_branch === branch; })[0];
    return ed ? (ed.plain_label || plainLabel(nodeOf(topo, ed.to), ed.to)) : human(branch);
  }
  steps.forEach(function (s) {
    s.events.forEach(function (e) {
      var d = e.data || {};
      // On a check node, Presentation shows the verdict over the branch name it also reports.
      if (e.event_type === 'decision' && d.branch != null) { if (!(pres && isCheck && checked)) out = '→ ' + branchWords(e.node, d.branch); }
      else if (e.event_type === 'gate_resolved') out = d.approved ? '✓ approved' : '✕ denied';
      else if (e.event_type === 'gate_waiting') out = out || (pres ? '⏸ waiting for a person' : '⏸ waiting for a human');
      else if (e.event_type === 'check_result' && ((pres && isCheck) || !out)) {
        var st = checkEventState(e), w = checkWord(topo, isCheck ? e.node : d.name, st, d.words);
        checked = true;
        out = w ? CHECK_SYM[st] + ' ' + w : st === 'passed' ? '✓ passed' : st === 'failed' ? '✕ didn’t pass' : '– not needed';
      }
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

/* A past step's one badge on Presentation's stage (and on the lab's front door, which draws its
   maps with this same function at build time): the path a branching step took, in the map's
   words; else its preview (a check's verdict, "found 4 of 16" for a search, a gate's outcome).
   `steps`: the step's visits ([{events}]); `events`: the run's events shown so far; `counts`
   (optional): item id -> its source's size, from sourceStates, when the caller already has it. */
export function stepBadge(topo, events, id, steps, counts) {
  var node = nodeOf(topo, id) || {};
  if (!counts) {
    counts = {};
    sourceStates(topo, events).forEach(function (s) { s.items.forEach(function (it) { counts[it.id] = s.count; }); });
  }
  var outs = takenOut(topo, events, id).filter(function (ed) { return ed.from_branch || ed.when; });
  if (node.kind !== 'check' && outs.length) return '→ ' + (outs[0].plain_label || human(outs[0].from_branch || outs[0].when));
  var mine = [];
  steps.forEach(function (s) { mine = mine.concat(s.events); });
  var badge = preview(steps, 'presentation', null, node.kind === 'check', topo);
  // A search step: what all its searches found, over everything they searched (several sources
  // or several searches in one step count once each), never one search's share.
  var sr = stepSearch(topo, mine);
  if (sr && /^(\d+ (of \d+|found)|found .*)$/.test(badge)) badge = 'found ' + sr.found + (sr.of != null ? ' of ' + sr.of : '');
  return badge;
}

/* What one step's searches found, across every search it ran and every source it searched:
   {found: distinct items found, of: the searched sources' total size (null when one isn't on the
   map), sources: [source ids searched, in order]}. null when the step searched nothing. A source
   searched with no hits counts too: it was looked through. `stepEvents`: that step's events. */
export function stepSearch(topo, stepEvents) {
  var searched = [], found = {}, any = false;
  stepEvents.forEach(function (e) {
    if (e.event_type !== 'retrieval') return;
    any = true;
    var d = e.data || {};
    if (d.source && searched.indexOf(String(d.source)) < 0) searched.push(String(d.source));
    (d.hits || []).forEach(function (h) {
      found[h.id] = true;
      var sid = hitSource(topo, e, h);
      if (searched.indexOf(sid) < 0) searched.push(sid);
    });
  });
  if (!any) return null;
  var srcs = (topo && topo.sources) || [], of = 0;
  searched.forEach(function (sid) {
    var s = srcs.filter(function (x) { return x.id === sid; })[0];
    var n = s ? (s.count != null ? s.count : (s.items ? s.items.length : null)) : null;
    of = of == null || n == null ? null : of + n;
  });
  return { found: Object.keys(found).length, of: searched.length ? of : null, sources: searched };
}

// Ends a sentence once: "Is it a policy question?" stays as it is; anything else gets a period.
export function endSentence(s) {
  s = String(s == null ? '' : s).replace(/\s+$/, '');
  return /[.!?…:]$/.test(s) ? s : s + '.';
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
var CHECK_SYM = { passed: '✓', failed: '✕', not_on_path: '–' };
/* A check's own words for its states, from the map's `check_words` (keyed by the check's name, or
   a check node's id): {"passed": "Didn't trigger", "failed": "Triggered: sent to a person"}.
   Missing states fall back to Passed / Didn't pass / Not needed this time. */
export function checkWord(topo, key, state, words) {
  // The check's own words, sent with it by the code that ran it (check_result.data.words), win
  // over the map's check_words, which only hand-written maps carry.
  if (words && typeof words[state] === 'string' && words[state]) return words[state];
  var w = topo && topo.check_words && topo.check_words[key];
  return w && typeof w[state] === 'string' && w[state] ? w[state] : null;
}
function eventWords(evs) {
  for (var i = evs.length - 1; i >= 0; i--) { var w = (evs[i].data || {}).words; if (w && typeof w === 'object') return w; }
  return null;
}
function stateHead(topo, key, state, words) {
  var w = checkWord(topo, key, state, words);
  return w ? CHECK_SYM[state] + ' ' + w.replace(/[.\s]+$/, '') + '.' : CHECK_WORDS[state];
}
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
    rows.push(checkRow(n.id, plainLabel(n), n.description || '', state, detail, evidence, stateCopy(n), topo, eventWords(evs)));
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
    rows.push(checkRow(name, d.label || human(name), d.description || '', state, d.detail || null, d.evidence || [], null, topo, eventWords(evs)));
  });
  return rows;
}
function checkRow(id, label, description, state, detail, evidence, copy, topo, words) {
  var line = copy && copy[state] ? fillCopy(copy[state], { detail: detail }) : stateHead(topo, id, state, words) + (detail && state !== 'passed' ? ' ' + detail : '');
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
/* A hit's text, if it can be looked for in a prompt: masked text ("[redacted]" in place of the
   whole document) would match any masked prompt, so it counts only with 12 or more characters
   left once placeholders are taken out. */
function matchText(h) {
  var t = h && typeof h.text === 'string' ? h.text.trim() : '';
  return t && t.replace(new RegExp(PLACEHOLDER.source, 'gi'), '').replace(/\s+/g, '').length >= 12 ? t : '';
}
/* Per declared source (plus a "_search" pseudo-source for hits no declared source owns):
   every item with its state, and the count line. "given" is verified, not trusted: the hit's
   text must appear in a later model call's prompt in the same run. Without prompt text to
   check against, it stays "found by the search" (context_items, if sent, is noted as a hint),
   and `givenKnown` is false: the count is unknown, never zero. */
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
    var given = 0, nfound = 0, nrelied = 0, hinted = 0, withText = 0;
    items.forEach(function (it) {
      var h = f[it.id];
      it.state = 'could';
      if (h) {
        nfound++;
        it.state = 'found';
        it.text = h.hit.text || null;
        it.hit = h.hit;
        var txt = matchText(h.hit);
        if (txt) withText++;
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
    // Whether "given" is a measured number: nothing found (nothing to give), or prompt text and
    // hit text to compare. Content not captured, or masked whole, leaves it unknown.
    var givenKnown = nfound === 0 || given > 0 || (checkable && withText > 0);
    return { id: s.id, title: s.title, kind: s.kind, description: s.description || '', count: total, items: items,
             found: nfound, given: given, givenKnown: givenKnown, relied: nrelied, hinted: hinted, verified: verified,
             undeclared: !!s._undeclared, line: parts.join(' · ') };
  }).concat([]).filter(function (s) { return !s.undeclared || s.found; }).map(function (s) { s.anyRetrieval = anyRetrieval; return s; });
}
/* One source in the universal form, the same for every app: what it holds, what the AI was given
   from it, what the answer rests on. "N available · M given to the AI · K relied on". */
export function sourceCountsLine(s) {
  var parts = [];
  if (s.count != null) parts.push(fmtNum(s.count) + ' available');
  if (s.found && !s.givenKnown) parts.push(fmtNum(s.found) + ' found · given to the AI: not known');
  else parts.push(fmtNum(s.given) + ' given to the AI');
  parts.push(fmtNum(s.relied) + ' relied on');
  return parts.join(' · ');
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
  p = proposalObject(p) || p;
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
  // Handed over before anything needed approving: a person owns it now, which isn't "nobody".
  if (finished && /^Handed to a person/.test(outcome(topo, events).text))
    return { state: 'handed', line: 'No AI action to approve: it was handed to a person, who decides everything from here.' };
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
/* What the run's model calls say about cost: the sum of the prices they carry, and which calls
   carry none. A call with tokens and no price is unknown, never free. */
export function costInfo(events) {
  var calls = 0, priced = 0, usd = 0, unpriced = [];
  events.forEach(function (e) {
    if (e.event_type !== 'llm_call') return;
    var d = e.data || {};
    calls++;
    if (d.cost_usd != null) { priced++; usd += Number(d.cost_usd); }
    else if (unpriced.indexOf(String(d.model || 'unknown')) < 0) unpriced.push(String(d.model || 'unknown'));
  });
  return { calls: calls, priced: priced, usd: usd, unpriced: unpriced, known: calls > 0 && priced === calls };
}
// The cost in Presentation's words: unknown when no call carries a price, a floor when some don't.
export function costLine(info) {
  if (!info.calls) return '';
  if (!info.priced) return 'AI cost not known';
  return (info.known ? '' : 'at least ') + costWords(info.usd) + (info.usd > 0 ? ' of AI' : '') + (info.known ? '' : ' (some calls carry no price)');
}
export function baselineOf(events, topo) {
  var b = null;
  events.forEach(function (e) { if (e.event_type === 'run_finished' && e.data && typeof e.data.baseline === 'string') b = e.data.baseline; });
  // A map built by the agentlab library carries the app's baseline (app.baseline).
  if (!b && topo && topo.app && typeof topo.app.baseline === 'string') b = topo.app.baseline;
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
    // The proposal may be nested ({proposed_action: {...}, ...}): read the object that has the title.
    var po = proposalObject(action) || action;
    var acts = (topo && topo.actions) || [], t = po && (po.action_type || po.type);
    var act = acts.filter(function (a) { return a.id === t; })[0];
    var what = act ? act.title : proposedTitle(po);
    text = 'Done' + (what ? ': ' + what : '') + (gate && gate.approved ? ', approved by a person' : '');
  }
  // An outcome word ("handed_off") is put in plain words; free text (an answer) is the app's, verbatim.
  else if (named) text = OUTCOME[named] || (/\s/.test(named.trim()) ? named.trim() : human(named).replace(/^./, function (c) { return c.toUpperCase(); }));
  else if (handed) text = 'Handed to a person';
  else text = 'Finished';
  // "Why" only when the AI handed it over: on an approval it's noise, and on a denial the
  // rationale is the AI's case for the action, not the reason a person said no.
  var why = /^Handed to a person/.test(text) && rationale ? rationale : null;
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
      // With the map's own words for this state: those words, then the detail. Without: the
      // symbol and the detail (an app's detail says the verdict itself), else Passed / Didn't pass.
      var key = node && node.kind === 'check' ? id : d.name;
      var said = checkWord(topo, key, st, d.words) ? stateHead(topo, key, st, d.words) + (d.detail ? ' ' + d.detail : '')
        : d.detail ? CHECK_WORDS[st].split(' ')[0] + ' ' + d.detail : CHECK_WORDS[st];
      lines.push({ kind: 'state', cls: st, text: copy && copy[st] ? who + fillCopy(copy[st], d) : who + said });
    } else if (t === 'gate_waiting') {
      if (evs.some(function (x) { return x.event_type === 'gate_resolved'; })) return;   // decided: the waiting line is history
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
  // What this step's own model calls were given from the sources (the row below is the whole run's).
  if (out.model) {
    var mine = evs.filter(function (e) { return e.event_type === 'llm_call'; });
    sourceStates(topo, events).forEach(function (s) {
      if (!s.anyRetrieval || !s.found) return;
      var txt = mine.map(function (e) { var d = e.data || {}; return [evText(d.system)].concat((d.messages || []).map(function (m) { return evText(m && m.content); })).join('\n'); }).join('\n');
      if (!txt.trim()) return;
      var n = s.items.filter(function (it) { var t = matchText(it); return t && txt.indexOf(t) >= 0; }).length;
      lines.push({ kind: 'given', text: s.title + ': ' + (n ? 'this step was given ' + n + (s.count != null ? ' of ' + s.count : '') + '.'
                                                         : 'this step was given none of it.') });
    });
  }
  // The last step of a finished run: what the person was finally told, word for word.
  // A line the reply already says word for word (a hand-off's reason quoted in it) isn't said twice.
  if (opts.finished && opts.reply && opts.last === id) {
    var rep = String(opts.reply);
    lines = lines.filter(function (l) { return !((l.kind === 'why' || l.kind === 'state') && l.text && rep.indexOf(String(l.text).trim()) >= 0); });
    lines.push({ kind: 'reply', text: opts.reply });
  }
  // A step visited twice (a model called again after a tool) says each generic line once.
  out.lines = lines.filter(function (l, i) { return !lines.slice(0, i).some(function (m) { return m.kind === l.kind && m.text === l.text; }); });
  return out;
}

// ---- "What the AI was given" -------------------------------------------------------------------
export var ROLE_WORDS = { system: 'Its instructions', developer: 'Its instructions', user: 'What the app sent it', assistant: 'What it said earlier', tool: 'What a tool returned', output: 'What it answered' };
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
      var item = src && src.items.filter(function (it) { return it.id === h.id; })[0];
      hits.push({ id: h.id, title: h.title || h.id, text: h.text, source: src && !src.undeclared ? src.title : null, node: e.node,
                  relied: !!(item && item.relied) });
    });
  });
  return events.filter(function (e) { return e.event_type === 'llm_call'; }).map(function (e) {
    var d = e.data || {}, blocks = [];
    if (d.system != null) blocks.push({ role: 'system', label: ROLE_WORDS.system, text: evText(d.system) });
    (d.messages || []).forEach(function (m) { blocks.push({ role: m.role, label: ROLE_WORDS[m.role] || human(m.role || 'message'), text: evText(m && m.content) }); });
    var form = formFields(d.params);
    // A choice or an answer the map has words for (one of this step's branches, an action) carries
    // those words too, so the room reads "needs a change", not only "needs_write".
    if (form) {
      form.forEach(function (f) { if (f.choices) f.plain = f.choices.map(function (c) { var w = plainValue(topo, e.node, c); return w === c ? null : w; }); });
      blocks.push({ role: 'form', label: 'The form it had to fill in', text: '', fields: form });
    }
    if (d.output != null) {
      var ob = { role: 'output', label: ROLE_WORDS.output, text: evText(d.output) }, obj = answerFields(d.output);
      if (obj) {
        obj.forEach(function (f) { var w = plainValue(topo, e.node, f.value); if (w !== f.value) f.plain = w; });
        ob.answer = obj;
      }
      blocks.push(ob);
    }
    blocks.forEach(function (b) { b.segments = highlightSegments(b.text, hits); });
    return { node: e.node, title: plainLabel(nodeOf(topo, e.node), e.node), blocks: blocks, mode: e.content_mode || 'redacted' };
  });
}
/* A structured-output schema the app sent with the call (params.json_schema, the helpdesk's
   form), as plain rows: each field, what the app told the AI it means, and its allowed values. */
export function formFields(params) {
  var sch = params && (params.json_schema || params.schema);
  var props = sch && sch.properties;
  if (!props || typeof props !== 'object') return null;
  var defs = sch.$defs || sch.definitions || {};
  return Object.keys(props).map(function (k) {
    var p = props[k] || {};
    if (p.$ref) { var ref = defs[String(p.$ref).split('/').pop()]; if (ref) p = Object.assign({}, ref, p); }
    var choices = p.enum || (p.anyOf || []).reduce(function (a, x) { return a.concat(x.enum || (x.$ref && (defs[String(x.$ref).split('/').pop()] || {}).enum) || []); }, []);
    return { name: k, description: p.description || '', choices: choices && choices.length ? choices.map(String) : null };
  });
}
/* A model answer that is one flat JSON object, as rows (field → value), so a room reads it as a
   filled-in form, not as JSON. Anything else stays text. */
export function answerFields(output) {
  var v = output;
  if (typeof v === 'string') { var t = v.trim(); if (t.charAt(0) !== '{') return null; try { v = JSON.parse(t); } catch (e) { return null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  var keys = Object.keys(v);
  if (!keys.length || keys.some(function (k) { return v[k] !== null && typeof v[k] === 'object'; })) return null;
  return keys.map(function (k) { return { name: k, value: v[k] == null ? '–' : String(v[k]) }; });
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
/* Semconv span names like "chat gpt-4o" would make a node per model, so a model name after the
   operation is folded away. Anything else after it (the bench's own adapter puts the agent there:
   "chat refund_triage") is part of the id and stays, so an inferred map, the event log and a
   registered map all use the same id. */
var LLM_SPAN = /^(chat|text_completion|generate_content|embeddings)\s+(\S.*)$/;
var MODEL_NAME = /^(gpt|o[1-9]|chatgpt|claude|gemini|gemma|llama|mistral|mixtral|codestral|command|grok|qwen|deepseek|phi|text-|davinci|anthropic|openai|us\.anthropic)[\w.:\/-]*$/i;
export function canonicalNode(name) {
  var m = LLM_SPAN.exec(String(name || ''));
  return m && MODEL_NAME.test(m[2]) ? m[1] : name;
}
var KIND_BY_EVENT = { llm_call: 'llm', retrieval: 'retrieval', tool_call: 'tool', gate_waiting: 'gate', gate_resolved: 'gate', check_result: 'check' };
/* Presentation's name for an inferred node, from the OpenTelemetry GenAI operation that starts
   its id ("execute_tool search_handbook" -> "Tool: search handbook"); the raw id stays the
   node's label, shown small beneath. Unknown shapes are just put in plain words. */
var OP_WORDS = { execute_tool: 'Tool', retrieval: 'Search', retrieve: 'Search', chat: 'AI', text_completion: 'AI',
                 generate_content: 'AI', embeddings: 'AI', invoke_agent: 'Agent', create_agent: 'Agent setup' };
export function inferredLabel(id, kind) {
  var s = String(id == null ? '' : id).trim(), m = /^(\S+)\s+(.+)$/.exec(s);
  var op = m ? m[1] : s, rest = m ? m[2] : '';
  if (OP_WORDS[op]) return OP_WORDS[op] + ': ' + human(rest || op);
  var h = human(s);
  return h ? h.charAt(0).toUpperCase() + h.slice(1) : s;
}
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
    nodes: nodes.map(function (n) { return { id: n, label: n, plain_label: inferredLabel(n, kinds[n]), kind: kinds[n] || 'step' }; }),
    edges: edges, panels: []
  };
}

// ---- the map a run carried, and the checks on it (SPEC.md 8.6, 8.7) ------------------------------
/* The hash of the map this run carried (run_started.data.map_hash, or a run_updated that brought
   it later). The bench serves that map at /maps/<hash>; a run without one is drawn with the
   registered map, else one inferred from its trace. */
export function runMapHash(events) {
  var h = null;
  (events || []).forEach(function (e) {
    if ((e.event_type === 'run_started' || e.event_type === 'run_updated') && e.data && typeof e.data.map_hash === 'string') h = e.data.map_hash;
  });
  return h;
}
/* Which map to draw a run with: the one it carried (`maps` is hash -> map, what the viewer has
   fetched), else the app's registered map, else an inferred one. `wait` is true when the run
   names a map the viewer doesn't have yet (fetch it, then draw). */
export function chooseMap(events, maps, registered, inferred) {
  var h = runMapHash(events);
  if (h && maps && maps[h]) return { map: maps[h], from: 'run', hash: h, wait: false };
  if (registered) return { map: registered, from: 'registered', hash: h, wait: !!h };
  return { map: inferred || null, from: 'inferred', hash: h, wait: !!h };
}

var SEVERITY = { error: 0, warning: 1, info: 2 };
/* "Checks on this map", for Engineering: the findings the app's own `agentlab.verify` wrote into the
   map (derived.warnings, R0-R6 and R12), then what this run shows (R7-R11, R13). Every rule checks
   that a hand-written or reported name exists in the structure the code produced; none of them
   judges whether the words are right. Returns [{code, severity, node?, branch?, message, from}],
   errors first. */
export function mapChecks(topo, events) {
  events = events || [];
  var out = [], seen = {};
  function add(f) {
    var k = f.code + '|' + (f.node || '') + '|' + (f.branch || '') + '|' + f.message;
    if (seen[k]) return;
    seen[k] = true;
    out.push(f);
  }
  ((topo && topo.derived && topo.derived.warnings) || []).forEach(function (w) {
    add({ code: w.code, severity: w.severity, node: w.node, branch: w.branch, message: w.message, from: 'map' });
  });
  events.forEach(function (e) {
    var d = e.data || {};
    if ((e.event_type === 'run_started' || e.event_type === 'run_updated') && typeof d.map_error === 'string')
      add({ code: 'R13', severity: 'error', message: d.map_error.replace(/^R13:\s*/, '') + ' This run is drawn with a map inferred from its trace.', from: 'run' });
  });
  // The run-time rules need a map the app stands behind; an inferred one is made from these events.
  if (topo && !topo.inferred) {
    var nodes = {}, edges = (topo.edges || []), items = {}, sources = {};
    (topo.nodes || []).forEach(function (n) { nodes[n.id] = n; });
    (topo.sources || []).forEach(function (src) { sources[src.id] = true; (src.items || []).forEach(function (it) { items[it.id] = true; }); });
    var hasItems = Object.keys(items).length > 0;
    var unknownNodes = {}, uncited = {}, llmNodes = {};
    events.forEach(function (e) {
      var d = e.data || {};
      if (e.node !== '_run' && !nodes[e.node]) unknownNodes[e.node] = true;                                      // R7
      if (e.event_type === 'decision' && d.branch != null && nodes[e.node]) {                                    // R8
        var outs = edges.filter(function (ed) { return ed.from === e.node; });
        if (!outs.some(function (ed) { return ed.from_branch === String(d.branch); }))
          add({ code: 'R8', severity: 'error', node: e.node, branch: String(d.branch), from: 'run',
                message: 'reported branch "' + d.branch + '", which ' + e.node + ' doesn’t have' +
                  (outs.length ? ' (its branches: ' + outs.map(function (ed) { return ed.from_branch || ed.to; }).join(', ') + ')' : '') + '.' });
      }
      if (hasItems && (e.event_type === 'decision' || e.event_type === 'check_result')) {                       // R9
        ((e.event_type === 'decision' ? d.cited : d.evidence) || []).forEach(function (id) { if (!items[id]) uncited[id] = e.node; });
      }
      if (e.event_type === 'retrieval') {
        if (d.source && !sources[d.source])
          add({ code: 'R9', severity: 'warning', node: e.node, from: 'run', message: 'searched "' + d.source + '", which the map lists no source for.' });
        if (d.stale_index)
          add({ code: 'R9', severity: 'warning', node: e.node, from: 'run',
                message: 'stale index: the search ran on a different version of "' + (d.source || 'its source') + '" than the one this run’s map lists (the index was rebuilt elsewhere?).' });
      }
      // Only a map that says who does the step can be contradicted: an unworded step is inferred.
      if (e.event_type === 'llm_call' && nodes[e.node] && actorDeclared(nodes[e.node])) {                       // R11
        var who = actorOf(nodes[e.node]);
        if (who === 'rule' || who === 'app') llmNodes[e.node] = who;
      }
    });
    Object.keys(unknownNodes).forEach(function (n) {
      add({ code: 'R7', severity: 'warning', node: n, from: 'run', message: 'events name "' + n + '", which isn’t a step on this map (shown in the unmapped row).' });
    });
    Object.keys(uncited).forEach(function (id) {
      add({ code: 'R9', severity: 'warning', node: uncited[id], from: 'run', message: 'cites "' + id + '", which no source on the map lists.' });
    });
    Object.keys(llmNodes).forEach(function (n) {
      add({ code: 'R11', severity: 'warning', node: n, from: 'run', message: n + ' is marked as done by ' + (llmNodes[n] === 'rule' ? 'a rule' : 'the app') + ', but it called the AI.' });
    });
    // R10: a node whose path map sends two branches to the same step can't be read from what ran
    // next; the run must say which branch it took.
    var manyToOne = {};
    edges.forEach(function (ed) {
      if (ed.from_branch == null) return;
      var k = ed.from + '>' + ed.to;
      manyToOne[k] = (manyToOne[k] || 0) + 1;
    });
    var seq = [];
    topLevel(events).forEach(function (e) { if (seq[seq.length - 1] !== e.node) seq.push(e.node); });
    for (var i = 1; i < seq.length; i++) {
      var k = seq[i - 1] + '>' + seq[i];
      if ((manyToOne[k] || 0) < 2) continue;
      var said = events.some(function (e) { return e.node === seq[i - 1] && e.event_type === 'decision' && e.data && e.data.branch != null; });
      if (!said) add({ code: 'R10', severity: 'warning', node: seq[i - 1], from: 'run',
                      message: seq[i - 1] + ' went to ' + seq[i] + ', which more than one of its branches leads to, and didn’t report which: the path isn’t lit.' });
    }
  }
  return out.sort(function (a, b) { return (SEVERITY[a.severity] - SEVERITY[b.severity]) || String(a.code).localeCompare(String(b.code), 'en', { numeric: true }); });
}

// ---- Presentation: the stage (map + one callout) and the recap --------------------------------------
/* Everything below builds plain view models for Presentation's callout and recap from the map and
   the run's events. Nothing here knows any app: words come from the map (plain_label, description,
   edges' plain_label/description, x-not-needed, never, actions) and facts from standard events.
   bench.js only turns these objects into HTML. */

/* The run's request and reply. A run's input/output may be a string or the app's own state object
   (an agentlab run carries the graph's input and final state). A library app declares which fields
   a person reads (map `app.io`: request, reply, requester; SPEC section 4, checked against the
   graph's state by verify's R15), and those are read exactly. Only a run whose map declares
   nothing (Level 0, an app with no library) falls back to guessing from field names: the first
   string field named like a message or a response, else the longest string field. */
var REQUEST_KEY = /(^|_)(message|text|query|question|prompt|input|request|content|task)$/i;
var REPLY_KEY = /(^|_)(reply|response|answer|output|result|completion)$/i;
var WHO_KEY = /^(requester|user|sender|author|customer|from|caller|asker)(_?name)?$/i;
var ROLE_KEY = /(^|_)(role|access|tier)$/i;
function stringFields(o) {
  return Object.keys(o).filter(function (k) { return typeof o[k] === 'string' && o[k].trim(); });
}
function pickText(v, re) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  var keys = stringFields(v);
  var named = keys.filter(function (k) { return re.test(k); });
  if (named.length) return v[named[0]].trim();
  var longest = keys.sort(function (a, b) { return v[b].length - v[a].length; })[0];
  return longest ? v[longest].trim() : null;
}
function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function ioOf(topo) { return (topo && topo.app && isObj(topo.app.io)) ? topo.app.io : {}; }
function declared(v, field) {
  if (!isObj(v) || !field) return undefined;               // undefined: nothing declared to read
  var x = v[field];
  if (x == null) return null;
  if (typeof x === 'string') return x.trim() || null;
  return JSON.stringify(x);
}
/* {text, who}: who is "<name> · <role>" from the declared requester fields, else when the input
   or run_started.data names them. `topo` is the run's map (optional). */
export function requestOf(events, topo) {
  var started = null, io = ioOf(topo);
  events.forEach(function (e) { if (e.event_type === 'run_started' || e.event_type === 'run_updated') started = Object.assign({}, started || {}, e.data || {}); });
  var input = started && started.input;
  var who = '';
  if (isObj(input) && Array.isArray(io.requester) && io.requester.length) {
    who = io.requester.map(function (f) { return declared(input, f); }).filter(Boolean).join(' · ');
  } else {
    who = requesterOf(events);
    if (!who && isObj(input)) {
      var keys = stringFields(input);
      var name = keys.filter(function (k) { return WHO_KEY.test(k); })[0];
      var role = keys.filter(function (k) { return ROLE_KEY.test(k); })[0];
      who = [name && input[name], role && input[role]].filter(Boolean).join(' · ');
    }
  }
  var text = declared(input, io.request);
  if (text === undefined) text = pickText(input, REQUEST_KEY);
  return { text: text || (started && started.label) || null, who: who || '' };
}
// The reply the run ended with, as text: a string output, the map's declared reply field, else
// (no declaration) the response-named field of an object.
export function replyOf(output, topo) {
  if (output == null) return null;
  if (typeof output === 'string') return output.trim() || null;
  if (!isObj(output)) return null;
  var d = declared(output, ioOf(topo).reply);
  if (d !== undefined) return d;
  var keys = stringFields(output).filter(function (k) { return REPLY_KEY.test(k); });
  return keys.length ? output[keys[0]].trim() : null;
}

/* Run-order numbers: the first time each node ran is its number (1, 2, 3 …), the way the map
   labels the lit path. `seq` is the shown node order (bench.js's _shown().seq). */
export function stepNumbers(seq) {
  var out = {}, n = 0;
  (seq || []).forEach(function (id) { if (out[id] == null) out[id] = ++n; });
  return out;
}

/* Where the presenter's cursor can stop for one node: a gate's "waiting" first, else the end of
   that node's first visit (with a branching node's lookahead, see cursorStops). -1 if it never ran. */
export function stopAt(events, topo, node) {
  var vs = visits(events);
  var i = vs.findIndex(function (v) { return v.node === node; });
  if (i < 0) return -1;
  var v = vs[i];
  if (v.gateAt != null) return v.gateAt;
  return visitStop(vs, i, events, topo);
}
/* A visit's stop. A node whose next step depends on a branch only shows which way it went once
   the next step has started (the branch is derived from what ran next, A7), so its stop includes
   the next visit's step_started. The callout stays on the branching node (see focus in bench.js). */
function visitStop(vs, i, events, topo) {
  var v = vs[i], nx = vs[i + 1];
  if (nx && hasBranches(topo, v.node) && events[nx.first] && events[nx.first].event_type === 'step_started') return nx.first;
  return v.last;
}

var SUBJECT = { ai: 'The AI', rule: 'The rules', person: 'A person', app: 'The app' };
var CHOSE = { ai: 'chose', rule: 'said', person: 'chose', app: 'went with' };
function nextOf(topo, id) {
  var outs = ((topo && topo.edges) || []).filter(function (e) { return e.from === id; });
  return outs.length === 1 && !outs[0].from_branch ? outs[0].to : null;
}
function branchLabel(ed) { return ed.plain_label || human(ed.from_branch || ed.when || ''); }

/* The branch cards for a node with two or more named paths: each path's own words, where it goes,
   and whether this run took it (null until the run shows it). [] for a node with no branches. */
export function choiceCards(topo, events, id) {
  var outs = ((topo && topo.edges) || []).filter(function (e) { return e.from === id && (e.from_branch || e.when); });
  if (outs.length < 2) return [];
  var taken = takenEdges(topo, events);
  var any = outs.some(function (e) { return taken[e.from + '>' + e.to]; });
  return outs.map(function (e) {
    return { branch: e.from_branch || e.when, label: branchLabel(e), description: e.description || '', to: e.to,
             toLabel: plainLabel(nodeOf(topo, e.to), e.to), chosen: any ? !!taken[e.from + '>' + e.to] : null };
  });
}

/* What a gate asks a person to approve, from gate_waiting.proposed, as a card: the object that has
   a title or description (the proposal itself, or the first one inside it), its kind put in the
   map's own words when the map lists that action, and its other short plain fields. */
function proposalObject(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (p.title != null || p.description != null || p.summary != null) return p;
  var keys = Object.keys(p);
  for (var i = 0; i < keys.length; i++) {
    var v = p[keys[i]];
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.title != null || v.description != null || v.summary != null)) return v;
  }
  return p;
}
var KIND_KEY = /^(action_type|action|type|kind)$/;
export function proposalCard(proposed, topo) {
  if (proposed == null) return null;
  if (typeof proposed !== 'object') return { kicker: null, title: String(proposed), description: null, fields: [] };
  var o = proposalObject(proposed) || {};
  var kindKey = Object.keys(o).filter(function (k) { return KIND_KEY.test(k) && typeof o[k] === 'string'; })[0];
  var act = kindKey && ((topo && topo.actions) || []).filter(function (a) { return a.id === o[kindKey]; })[0];
  var fields = Object.keys(o).filter(function (k) {
    var v = o[k];
    return k !== 'title' && k !== 'summary' && k !== 'description' && k !== kindKey && !ENG_ONLY_KEY.test(k) &&
      (typeof v === 'string' ? v.trim() !== '' : typeof v === 'number' || typeof v === 'boolean');
  }).slice(0, 4).map(function (k) { return { name: human(k).replace(/^./, function (c) { return c.toUpperCase(); }), value: String(o[k]) }; });
  return { kicker: act ? act.title : (kindKey ? human(o[kindKey]) : null), title: o.title || o.summary || null,
           description: typeof o.description === 'string' ? o.description : null, fields: fields };
}

/* A value an answer gave, in the map's words when the map has some: an action it can take (its
   title), or one of this step's branches (the path's plain words). Anything else as it is. */
export function plainValue(topo, id, v) {
  var s = String(v);
  var act = ((topo && topo.actions) || []).filter(function (a) { return a.id === s; })[0];
  if (act) return act.title;
  var ed = ((topo && topo.edges) || []).filter(function (e) { return e.from === id && e.from_branch === s && e.plain_label; })[0];
  return ed ? ed.plain_label : s;
}

/* One source in the callout: what it holds, item by item, with each item's state this run and,
   for what the search found, its rank (1 = best match). */
function sourceView(s, events) {
  var rank = {};
  events.forEach(function (e) {
    if (e.event_type !== 'retrieval') return;
    ((e.data || {}).hits || []).forEach(function (h, i) { if (rank[h.id] == null) rank[h.id] = i + 1; });
  });
  // Whether the AI has been asked anything yet: before that, "given" is "not yet", not unknown.
  var asked = events.some(function (e) { return e.event_type === 'llm_call'; });
  return { id: s.id, title: s.title, count: s.count, found: s.found, given: s.given, givenKnown: s.givenKnown, relied: s.relied, asked: asked,
           line: sourceCountsLine(s), undeclared: s.undeclared,
           items: s.items.map(function (it) { return { id: it.id, title: it.title || it.id, state: it.state, relied: !!it.relied, rank: rank[it.id] || null, text: it.text || null }; }) };
}
function itemTitle(topo, id) {
  var t = null;
  ((topo && topo.sources) || []).forEach(function (s) { (s.items || []).forEach(function (it) { if (it.id === id) t = it.title || id; }); });
  return t || id;
}

/* The callout for one node: a header, ONE headline sentence, then evidence objects keyed by what
   the node's events contain. opts: {finished, last (the run's last shown node), numbers (stepNumbers),
   reply (text), starting (the run's newest step has started but shown nothing yet)}. */
export function callout(topo, events, id, opts) {
  opts = opts || {};
  var node = nodeOf(topo, id), evs = nodeEvents(events, id), actor = actorOf(node, events), kind = (node && node.kind) || 'step';
  var nums = opts.numbers || {};
  var out = { id: id, n: nums[id] || null, title: plainLabel(node, id), technical: techLabel(node, id), actor: actor, kind: kind,
              status: 'done', headline: [], sub: null, choices: [], reason: null, checks: [], sources: [], given: [],
              proposal: null, ifNext: [], did: null, wrote: null, reply: null, why: null, about: null, ran: evs.length > 0 };
  var about = node && node.description;
  out.about = about ? { label: kind === 'gate' ? 'Who can sign off' : 'About this step', text: about } : null;
  function head(t) {
    var segs = [];
    Array.prototype.slice.call(arguments).forEach(function (x) { (Array.isArray(x) ? x : [x]).forEach(function (y) { segs.push(typeof y === 'string' ? { t: y } : y); }); });
    out.headline = segs.filter(function (y) { return y.t !== ''; });
  }
  // The step it goes to next, marked (Presentation colours it as the path), the sentence ended once.
  function nextSeg(label) { var e = endSentence(label); return [{ t: e.slice(0, e.length - (e.length > label.replace(/\s+$/, '').length ? 1 : 0)), next: true }, e.length > label.replace(/\s+$/, '').length ? '.' : '']; }
  var nx = nextOf(topo, id), nextWords = nx ? plainLabel(nodeOf(topo, nx), nx) : null;

  if (!evs.length) {
    out.status = opts.finished ? 'not_needed' : 'pending';
    head(opts.finished ? (node && node['x-not-needed']) || 'Not needed this time: this run didn’t come this way.' : 'Not reached yet.');
    return out;
  }
  var err = evs.filter(function (e) { return e.event_type === 'error'; })[0];
  var waiting = evs.filter(function (e) { return e.event_type === 'gate_waiting'; })[0];
  var resolved = evs.filter(function (e) { return e.event_type === 'gate_resolved'; }).pop();
  var decision = evs.filter(function (e) { return e.event_type === 'decision' && e.data && e.data.rationale; }).pop();
  var finishedStep = evs.some(function (e) { return e.event_type === 'step_finished'; });
  out.status = finishedStep ? 'done' : 'now';

  // Evidence objects -------------------------------------------------------------------------------
  out.choices = choiceCards(topo, events, id);
  if (decision) {
    var d = decision.data;
    out.reason = { text: d.rationale, cited: (d.cited || []).map(function (c) { return { id: c, title: itemTitle(topo, c) }; }) };
  }
  var isCheck = kind === 'check';
  evs.forEach(function (e) {
    if (e.event_type !== 'check_result') return;
    var c = e.data || {}, st = checkEventState(e), key = isCheck ? id : c.name;
    var w = checkWord(topo, key, st, c.words);
    out.checks.push({ label: isCheck ? plainLabel(node, id) : (c.label || human(c.name || 'check').replace(/^./, function (x) { return x.toUpperCase(); })),
                      state: st, word: w || { passed: 'Passed', failed: 'Didn’t pass', not_on_path: 'Not needed' }[st],
                      detail: c.detail || null, evidence: (c.evidence || []).map(function (x) { return { id: x, title: itemTitle(topo, x) }; }) });
  });
  var search = stepSearch(topo, evs);
  var states = sourceStates(topo, events);
  if (search) {
    // Every source this step searched, in the order it searched them: one with no hits included.
    out.search = search;
    out.sources = search.sources.map(function (sid) { return states.filter(function (s) { return s.id === sid; })[0]; })
      .filter(Boolean).map(function (s) { return sourceView(s, events); });
  }
  var calls = evs.filter(function (e) { return e.event_type === 'llm_call'; });
  if (calls.length) {
    // What this step's own model calls were given from the sources, when the prompts say.
    var txt = calls.map(function (e) { var cd = e.data || {}; return [evText(cd.system)].concat((cd.messages || []).map(function (m) { return evText(m && m.content); })).join('\n'); }).join('\n');
    // Only what it was given: a step that works from the step before it (given none of a source)
    // says nothing about that source, rather than "0 of 16" a room reads as a fault.
    if (txt.trim()) states.forEach(function (s) {
      if (!s.found) return;
      var n = s.items.filter(function (it) { var t = matchText(it); return t && txt.indexOf(t) >= 0; }).length;
      if (n) out.given.push({ title: s.title, n: n, of: s.count });
    });
    var last = calls[calls.length - 1].data || {};
    // What it wrote, for a step whose answer isn't already a decision's reason.
    if (!decision && last.output != null) {
      var fields = answerFields(last.output);
      // A form's empty fields say nothing to a room; a value the map has words for (an action it
      // can take, a branch's name) is shown in those words.
      out.wrote = fields ? { fields: fields.filter(function (f) { return !ENG_ONLY_KEY.test(f.name) && f.value !== '–' && String(f.value).trim() !== ''; })
                                       .map(function (f) { return { name: human(f.name).replace(/^./, function (c) { return c.toUpperCase(); }), value: plainValue(topo, id, f.value) }; }) }
                         : { text: evText(last.output) };
    }
  }
  var tool = evs.filter(function (e) { return e.event_type === 'tool_call'; }).pop();
  if (tool) {
    var td = tool.data || {}, made = null;
    Object.keys(td).forEach(function (k) { var v = td[k]; if (!made && v && typeof v === 'object' && !Array.isArray(v) && (v.title || v.id)) made = v; });
    out.did = { what: human(td.tool || td.name || 'a tool'), title: made && made.title ? String(made.title) : null, ref: made && made.id != null ? String(made.id) : null };
  }
  if (waiting || resolved) {
    var card = proposalCard(waiting && (waiting.data || {}).proposed, topo);
    out.proposal = Object.assign({ state: resolved ? (resolved.data.approved ? 'approved' : 'denied') : 'waiting',
                                   by: resolved ? (resolved.data.by || null) : null, at: resolved ? resolved.ts : null }, card || { kicker: null, title: null, description: null, fields: [] });
  }

  // The headline: one sentence per state, from the map's words -------------------------------------
  var taken = takenOut(topo, events, id).filter(function (ed) { return ed.from_branch || ed.when; })[0];
  var isLast = opts.finished && opts.last === id;
  if (err) {
    out.status = 'error';
    head('Something went wrong here: ' + ((err.data || {}).message || 'an error') + '.');
  } else if (waiting && !resolved) {
    out.status = 'waiting';
    head('Nothing goes ahead until a person approves ', { t: 'exactly this', em: true }, '.');
    out.ifNext = ((topo && topo.edges) || []).filter(function (e) { return e.from === id; }).map(function (e) {
      return { label: e.from_branch || e.when ? branchLabel(e) : null, to: plainLabel(nodeOf(topo, e.to), e.to) };
    });
  } else if (resolved) {
    var rd = resolved.data || {};
    head((rd.approved ? 'Approved by ' : 'Not approved: ') + (rd.by || 'a person'), taken ? [', so next: '].concat(nextSeg(plainLabel(nodeOf(topo, taken.to), taken.to))) : '.');
  } else if (taken) {
    out.sub = taken.description || null;
    head(SUBJECT[actor] + ' ' + CHOSE[actor] + ' ', { t: branchLabel(taken), em: true }, ', so next: ', nextSeg(plainLabel(nodeOf(topo, taken.to), taken.to)));
  } else if (out.choices.length) {
    head(SUBJECT[actor] + ' is choosing one of ' + out.choices.length + ' paths.');
  } else if (isLast) {
    // handled below: the run's ending is this step's headline
  } else if (search) {
    var many = search.sources.length > 1 ? ' in ' + search.sources.length + ' sources' : '';
    head('Found ', { t: search.found + (search.of != null ? ' of ' + search.of : ''), em: true }, many + (nextWords ? '; next: ' : '.'), nextWords ? nextSeg(nextWords) : '');
  } else if (out.did) {
    head(endSentence('Done: ' + (out.did.title || out.did.what)));
  } else if (calls.length) {
    head(SUBJECT.ai + ' worked on this step' + (nextWords ? '; next: ' : '.'), nextWords ? nextSeg(nextWords) : '');
  } else {
    var first = about ? String(about).split(/(?<=[.!?])\s+/)[0] : null;
    head(first || (plainLabel(node, id) + (nextWords ? '; next: ' : '.')), !first && nextWords ? nextSeg(nextWords) : '');
    // The headline already says the whole description: don't say it again under "About this step".
    if (first && out.about && kind !== 'gate' && String(about).trim() === first.trim()) out.about = null;
  }

  // The run's ending, on its last step: the outcome, the reply, and (handed over) the AI's reason.
  if (isLast) {
    out.status = 'last';
    var oc = outcome(topo, events);
    if (!err) head({ t: oc.text, em: true }, '.');
    out.reply = opts.reply || null;
    if (oc.why) {
      var dn = null;
      events.forEach(function (e) { if (e.event_type === 'decision' && e.data && e.data.rationale === oc.why) dn = e.node; });
      if (!(decision && decision.data.rationale === oc.why)) out.why = { text: oc.why, atStep: dn && nums[dn] ? nums[dn] : null, at: dn ? plainLabel(nodeOf(topo, dn), dn) : null };
    }
  }
  return out;
}

/* The closing recap: the four questions, answered from this run. */
export function recap(topo, events, finished, seq) {
  var oc = outcome(topo, events);
  var states = sourceStates(topo, events);
  var checked = checkStates(topo, events, finished);
  var ran = checked.filter(function (c) { return c.state !== 'not_on_path' && c.state !== 'pending'; }).length;
  var skipped = checked.filter(function (c) { return c.state === 'not_on_path'; }).length;
  return {
    // Handed over: the AI's own reason is what the room needs (e.g. the instruction it refused).
    did: { text: oc.text || (events.length ? 'Still running' : 'Nothing has run yet'), why: oc.why || null, path: (seq || []).map(function (id) { return { id: id, title: plainLabel(nodeOf(topo, id), id), actor: actorOf(nodeOf(topo, id), events) }; }) },
    looked: states.map(function (s) {
      var v = sourceView(s, events);
      v.shown = v.items.filter(function (it) { return it.state === 'given' || it.state === 'found'; })
        .sort(function (a, b) { return (b.relied - a.relied) || ((a.rank || 99) - (b.rank || 99)); });
      return v;
    }),
    checked: checked,
    // "1 check ran · 2 not needed this time": only checks that ran are counted as checking it.
    checkCount: { ran: ran, notNeeded: skipped, pending: checked.length - ran - skipped },
    signed: gateState(topo, events, finished),
    never: (topo && topo.never) || []
  };
}

// ---- small presentation helpers ---------------------------------------------------------------
/* A " · "-separated list of "name: value" pairs (an app's by-hand baseline, for one) as
   [{k, v}], so it can be shown as a labelled list; null when any part isn't such a pair (the text
   is then shown as it is). */
export function labelledPairs(text) {
  var parts = String(text || '').split(/\s+·\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
  if (!parts.length) return null;
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var m = /^([^:]{1,40}?)\s*:\s*(\S.*)$/.exec(parts[i]);
    if (!m) return null;
    out.push({ k: m[1], v: m[2] });
  }
  return out;
}
/* A source item's short face (a tile too small for its title): the number its title starts with
   ("5. Software…" → "5"); among numbered siblings an unnumbered item (a preamble) shows the first
   word of its title, at most 8 letters, so it never reads as a stray letter or collides with a
   real number; otherwise its position. */
export function tileFace(item, idx, items) {
  var NUM = /^\s*(\d+)/, title = String((item && (item.title || item.id)) || ''), own = title.match(NUM);
  if (own) return own[1];
  var numbered = (items || []).some(function (x) { return NUM.test(String((x && x.title) || '')); });
  if (numbered) {
    var w = (title.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/u) || [''])[0];
    if (w) return w.length > 8 ? w.slice(0, 7) + '…' : w;
  }
  return idx != null ? String(idx + 1) : String((item && item.id) || '').slice(0, 3);
}

// ---- the documents display: what a search step found, grouped by file ----------------------------
/* One display model per source a step searched (examples/messy_docs/REPORT rules; display.py is the
   reference this is ported from, and tests/js/documents.test.js holds the two to the same output).
   Built only from the map's sources and the run's events; nothing app-specific, no model.
   - Document: a hit's own `document` field, else an item id "<document>#<n>" belongs to <document>;
     a declared source whose item ids carry no '#' is one document (the source) and its items its parts.
   - Title: the item's title (the app's side picked it); a one-document source uses its own title.
   - Location: "page p" (a numeric `page` on the hit), then "passage n of m" when m is known; a
     one-passage document is "whole file"; a part of a one-document source is located by its title.
   - Snippet: the sentence sharing the most words with the query (ties: the earlier), ≤ 200 chars.
   - States: given / relied as sourceStates has them (given is verified against the prompts).
   - Layout: "sections" (a numbered grid) only for a one-document source whose parts mostly start
     with an ordinal ("5. …", never "2023-…"); else "documents" (grouped by file, best rank first). */
var DOC_SNIPPET_MAX = 200, DOC_PER_CAP = 3;
var DOC_ORDINAL = /^\s*(\d{1,3})[.)]\s/;
var DOC_STOP = {};
'a an the and or to of in on at for is are do does what how can i we you it my our with be that this from as by not'.split(' ').forEach(function (w) { DOC_STOP[w] = true; });
function docWords(t) {
  var out = {};
  (String(t || '').toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function (w) { if (!DOC_STOP[w]) out[w] = true; });
  return out;
}
/* The passage's sentence (or line) that shares the most words with the query; with no overlap, its
   opening. Cut at a word to 200 characters. */
export function snippet(text, query) {
  // A Markdown heading line is the passage's title, not what it says: dropped when there's other text.
  var body = String(text || '').split('\n').filter(function (l) { return !/^\s*#{1,6}\s/.test(l); }).join('\n');
  var flat = (body.trim() ? body : String(text || '')).replace(/\*\*|__/g, '').replace(/[ \t]+/g, ' ').trim();   // and no Markdown bold markers
  var parts = flat.split(/(?<=[.!?])\s+|\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
  // A stray list number split off as a "sentence" says nothing: never the snippet when there's prose.
  var prose = parts.filter(function (p) { return /\p{L}{2,}/u.test(p); });
  if (prose.length) parts = prose;
  var qw = docWords(query), best = parts[0] || '', bestScore = 0;
  parts.forEach(function (p) {
    var pw = docWords(p), s = 0;
    Object.keys(qw).forEach(function (w) { if (pw[w]) s++; });
    if (s > bestScore) { best = p; bestScore = s; }
  });
  best = best.replace(/\s+/g, ' ');
  if (best.length > DOC_SNIPPET_MAX) { var cut = best.slice(0, DOC_SNIPPET_MAX), sp = cut.lastIndexOf(' '); best = (sp >= 0 ? cut.slice(0, sp) : cut) + '…'; }
  return best;
}
function docOfId(id) {
  var s = String(id), i = s.lastIndexOf('#');
  if (i <= 0) return { doc: null, n: null };
  var tail = s.slice(i + 1);
  return { doc: s.slice(0, i), n: /^\d+$/.test(tail) ? Number(tail) : null };
}
function docFace(title, idx, numbered) {
  var m = DOC_ORDINAL.exec(title);
  if (m) return m[1];
  if (numbered) {
    var w = (String(title).match(/[\p{L}\p{N}][\p{L}\p{N}_'’-]*/u) || [''])[0];
    if (w) return w.length <= 8 ? w : w.slice(0, 7) + '…';
  }
  return String(idx + 1);
}
function plural(n, one, many) { return fmtNum(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
function normText(t) { return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

export function documentsStep(topo, events, node) {
  var retrievals = events.filter(function (e) { return e.event_type === 'retrieval' && (node == null || e.node === node); });
  var srcs = (topo && topo.sources) || [];
  var docSources = srcs.filter(function (s) { return s.kind === 'documents'; });
  var order = [];
  retrievals.forEach(function (e) {
    var d = e.data || {};
    var sid = d.source || (docSources.length === 1 ? docSources[0].id : '_search');
    if (order.indexOf(sid) < 0) order.push(sid);
  });
  var states = sourceStates(topo, events);
  return order.map(function (sid) {
    var src = srcs.filter(function (s) { return s.id === sid; })[0] || { id: sid, title: sid === '_search' ? 'What the search found' : human(sid), items: [] };
    var st = states.filter(function (s) { return s.id === sid; })[0] || null;
    var mine = retrievals.filter(function (e) { return ((e.data || {}).source || (docSources.length === 1 ? docSources[0].id : '_search')) === sid; });
    return docSourceModel(src, mine, st, events);
  });
}

function docSourceModel(src, retrievals, st, events) {
  var items = src.items || [];
  // Hits, first sighting wins (rank = its place in its search, 1 = best).
  var hits = {}, hitOrder = [];
  retrievals.forEach(function (e) {
    var d = e.data || {};
    (d.hits || []).forEach(function (h, i) {
      if (hits[h.id]) return;
      hits[h.id] = { hit: h, rank: i + 1, query: d.query };
      hitOrder.push(h.id);
    });
  });
  function hitDoc(id) {
    var h = hits[id] && hits[id].hit;
    if (h && typeof h.document === 'string' && h.document) return h.document;
    return docOfId(id).doc;
  }
  var single = items.length ? !items.some(function (it) { return docOfId(it.id).doc; })
                            : !hitOrder.some(function (id) { return hitDoc(id); });
  var docItems = {}, docOrder = [];
  items.forEach(function (it) {
    var k = docOfId(it.id).doc || (single ? src.id : it.id);
    if (!docItems[k]) { docItems[k] = []; docOrder.push(k); }
    docItems[k].push(it);
  });
  var nDocs = items.length ? docOrder.length : null;
  var nItems = src.count != null ? src.count : (items.length ? items.length : null);
  var numbered = !!(single && items.length && items.filter(function (it) { return DOC_ORDINAL.test(it.title || ''); }).length * 2 > items.length);
  var unit = numbered ? ['section', 'sections'] : ['passage', 'passages'];
  var stItem = {};
  ((st && st.items) || []).forEach(function (it) { stItem[it.id] = it; });
  function given(id) { return !!(stItem[id] && stItem[id].state === 'given'); }
  function relied(id) { return !!(stItem[id] && stItem[id].relied); }
  var givenKnown = st ? st.givenKnown : !hitOrder.length;
  // The same text in more than one hit (exact, ignoring whitespace and case).
  var byText = {};
  hitOrder.forEach(function (id) { var t = hits[id].hit.text; if (t && String(t).trim()) (byText[normText(t)] = byText[normText(t)] || []).push(id); });
  var titleOf = {};
  items.forEach(function (it) { titleOf[it.id] = it.title || it.id; });
  function passageView(id) {
    var v = hits[id], h = v.hit, k = hitDoc(id), n = docOfId(id).n;
    var siblings = k && docItems[k] ? docItems[k] : [];
    var m = siblings.length || (typeof h.passages === 'number' ? h.passages : null);
    if (!(k && docItems[k]) && h.document) n = null;          // an id's "#n" is a passage number only on a declared map
    n = n || (typeof h.passage === 'number' ? h.passage : null);
    var page = typeof h.page === 'number' ? h.page : null;
    var loc;
    if (single) loc = titleOf[id] != null ? titleOf[id] : (h.title || id);
    else if (m === 1) loc = 'whole file';
    else loc = [page ? 'page ' + Math.trunc(page) : null, n && m ? 'passage ' + n + ' of ' + m : (n ? 'passage ' + n : null)].filter(Boolean).join(' · ');
    var same = (byText[normText(h.text)] || []).filter(function (x) { return x !== id; });
    return { id: id, rank: v.rank, state: given(id) ? 'given' : 'found', relied: relied(id), location: loc || null,
             page: page ? Math.trunc(page) : null, n: n || null, of: m || null, score: h.score != null ? h.score : null,
             snippet: snippet(h.text || '', v.query) || null, same_text_as: h.text && String(h.text).trim() ? same : [] };
  }
  var found = hitOrder.slice().sort(function (a, b) { return hits[a].rank - hits[b].rank; });
  var nGiven = found.filter(given).length, nRelied = found.filter(relied).length;
  var matched = {};
  found.forEach(function (id) { matched[single ? src.id : (hitDoc(id) || id)] = true; });
  var model = {
    source: { id: src.id, title: src.title || src.id, kind: src.kind != null ? src.kind : null, description: src.description || '' },
    layout: numbered ? 'sections' : 'documents',
    counts: { documents: nDocs, items: nItems, unit: unit[1], found: found.length, given: givenKnown ? nGiven : null, relied: nRelied,
              documents_matched: single ? (found.length ? 1 : 0) : Object.keys(matched).length }
  };
  var c = model.counts;
  var searched = single && items.length ? 'Searched ' + model.source.title : nDocs != null ? 'Searched ' + plural(nDocs, 'document') : 'Searched';
  model.line = [searched, nItems != null ? plural(nItems, unit[0], unit[1]) : '',
                c.given != null ? c.given + ' given to the AI' : c.found + ' found · given to the AI: not known',
                c.relied + ' relied on'].join(' · ').replace(' ·  · ', ' · ');
  if (numbered) {
    model.sections = items.map(function (it, i) {
      return { id: it.id, face: docFace(it.title || '', i, true), title: it.title || it.id,
               state: hits[it.id] ? (given(it.id) ? 'given' : 'found') : 'could', rank: hits[it.id] ? hits[it.id].rank : null, relied: relied(it.id) };
    });
  }
  if (numbered || single) {
    if (!numbered) model.document = { title: model.source.title, parts: items.length };
    model.passages = found.map(function (id) { return Object.assign(passageView(id), { title: titleOf[id] != null ? titleOf[id] : id }); });
    return model;
  }
  var docs = {}, shownOrder = [];
  found.forEach(function (id) {
    var k = hitDoc(id) || id;
    if (!docs[k]) {
      var its = docItems[k] || [];
      docs[k] = { file: k, title: (its.length ? its[0].title : hits[id].hit.title) || k, passages_total: its.length || null,
                  best_rank: hits[id].rank, relied: false, passages: [], more: 0 };
      shownOrder.push(k);
    }
    var pv = passageView(id);
    docs[k].relied = docs[k].relied || pv.relied;
    if (docs[k].passages.length < DOC_PER_CAP) docs[k].passages.push(pv); else docs[k].more++;
  });
  var shown = shownOrder.map(function (k) { return docs[k]; });
  shown.forEach(function (d) {
    d.title_shared = shown.filter(function (o) { return o.title === d.title; }).length > 1;
    var inn = {};
    d.passages.forEach(function (p) { p.same_text_as.forEach(function (o) { var od = hitDoc(o) || o; if (od !== d.file) inn[od] = true; }); });
    d.same_text_in = Object.keys(inn).sort();
  });
  model.documents = shown;
  model.not_matched = nDocs != null ? nDocs - shown.length : null;
  return model;
}

// ---- the calls inside one step ---------------------------------------------------------------------
/* The model and tool calls one step made, in the order they STARTED (a call's event is stamped at its
   end, so a long early call would otherwise sort after a short later one). Each call's start is
   `ts − latency_ms`; a call with no duration is a point at its `ts` (`timed: false`). A nested step
   (an event whose parent_step_id is this step) contributes its calls one level down (`depth: 1`).
   Calls whose times overlap ran at the same time (`with`: the numbers of the calls it overlapped);
   a tool call answers the model call whose `tool_calls` carried its `call_id` (`askedBy`).
   Returns {calls, start, end, span (seconds), ai, tools, tokIn, tokOut, cost, priced}. */
export function callSequence(events, stepId) {
  var mine = {}, kids = {};
  mine[stepId] = true;
  events.forEach(function (e) { if (e.step_id && e.parent_step_id && mine[e.parent_step_id] && !mine[e.step_id]) { kids[e.step_id] = true; } });
  var stepEvs = events.filter(function (e) { return e.step_id === stepId; });
  var calls = events.filter(function (e) { return (e.event_type === 'llm_call' || e.event_type === 'tool_call') && (e.step_id === stepId || kids[e.step_id]); }).map(function (e) {
    var d = e.data || {}, lat = typeof d.latency_ms === 'number' ? d.latency_ms / 1000 : null;
    return { ev: e, kind: e.event_type === 'llm_call' ? 'ai' : 'tool', depth: e.step_id === stepId ? 0 : 1,
             start: lat != null ? e.ts - lat : e.ts, end: e.ts, dur: lat, timed: lat != null, seq: e.seq != null ? e.seq : 0 };
  });
  calls.sort(function (a, b) { return (a.start - b.start) || (a.seq - b.seq); });
  calls.forEach(function (c, i) { c.n = i + 1; c.with = []; });
  var EPS = 0.0005;
  calls.forEach(function (a) {
    calls.forEach(function (b) {
      if (a !== b && a.timed && b.timed && a.start < b.end - EPS && b.start < a.end - EPS && a.dur > EPS && b.dur > EPS) a.with.push(b.n);
    });
  });
  var byCallId = {};
  calls.forEach(function (c) {
    if (c.kind !== 'ai') return;
    ((c.ev.data || {}).tool_calls || []).forEach(function (t) { if (t && t.id != null) byCallId[String(t.id)] = c.n; });
  });
  calls.forEach(function (c) { var id = (c.ev.data || {}).call_id; c.askedBy = c.kind === 'tool' && id != null && byCallId[String(id)] ? byCallId[String(id)] : null; });
  var started = stepEvs.filter(function (e) { return e.event_type === 'step_started'; })[0];
  var fin = stepEvs.filter(function (e) { return e.event_type === 'step_finished'; })[0];
  var start = started ? started.ts : calls.length ? Math.min.apply(null, calls.map(function (c) { return c.start; })) : null;
  var end = fin ? fin.ts : calls.length ? Math.max.apply(null, calls.map(function (c) { return c.end; })) : null;
  if (calls.length) { start = Math.min(start, Math.min.apply(null, calls.map(function (c) { return c.start; }))); end = Math.max(end, Math.max.apply(null, calls.map(function (c) { return c.end; }))); }
  var tokIn = 0, tokOut = 0, cost = 0, priced = true;
  calls.forEach(function (c) {
    if (c.kind !== 'ai') return;
    var d = c.ev.data || {};
    tokIn += d.input_tokens || 0; tokOut += d.output_tokens || 0;
    if (d.cost_usd != null) cost += Number(d.cost_usd); else priced = false;
  });
  return { calls: calls, start: start, end: end, span: start != null && end != null ? Math.max(0.001, end - start) : 0,
           ai: calls.filter(function (c) { return c.kind === 'ai'; }).length, tools: calls.filter(function (c) { return c.kind === 'tool'; }).length,
           tokIn: tokIn, tokOut: tokOut, cost: cost, priced: priced && calls.some(function (c) { return c.kind === 'ai'; }) };
}
/* Whether a step is worth showing as a sequence: it made more than one call and used a tool, or
   asked the AI more than once (an agent loop inside one step). */
export function isCallLoop(seq) { return !!seq && seq.calls.length > 1 && (seq.tools > 0 || seq.ai > 1); }

function shortValue(v, n) {
  if (v == null) return '';
  if (typeof v === 'string') { var j = null; try { j = JSON.parse(v); } catch (e) {} if (j && typeof j === 'object') v = j; else return short(v.replace(/\s+/g, ' '), n || 60); }
  if (Array.isArray(v)) {
    var best = v[0] && typeof v[0] === 'object' ? v[0] : null, bt = best && (best.title || best.name);
    return v.length + (v.length === 1 ? ' result' : ' results') + (bt ? ' · best: ' + (best.id != null && best.id !== bt ? best.id + ' ' : '') + '“' + short(String(bt), 60) + '”' : '');
  }
  if (typeof v === 'object') {
    var ks = Object.keys(v);
    if (ks.length === 1 && typeof v[ks[0]] !== 'object') return '“' + short(String(v[ks[0]]), n || 60) + '”';
    if (n && n < 60) return '(' + ks.map(human).join(', ') + ')';      // a call's arguments: their names
    var lead = v.name != null ? 'name' : v.title != null ? 'title' : null;
    var rest = ks.filter(function (k) { return k !== lead && v[k] != null && typeof v[k] !== 'object'; }).slice(0, lead ? 2 : 3);
    return short((lead ? [String(v[lead])] : []).concat(rest.map(function (k) { return human(k) + ' ' + String(v[k]); })).join(' · ') || ks.join(', '), n || 90);
  }
  return String(v);
}
/* A call in plain words, for Presentation: {title, result}. Nothing app-specific: the tool's own name
   (humanised), its arguments and result in short, and for a model call what its answer asked for. */
export function callWords(c, seq) {
  var d = c.ev.data || {};
  if (c.kind === 'ai') {
    var before = seq.calls.filter(function (x) { return x.kind === 'ai' && x.n < c.n; }).length;
    var asked = (d.tool_calls || []).map(function (t) { return human(t.name || 'a tool'); });
    var last = !asked.length && !seq.calls.some(function (x) { return x.kind === 'ai' && x.n > c.n; });
    var title = before === 0 ? (asked.length ? 'Asked the AI what to do first' : 'Asked the AI') : last ? 'Asked the AI to finish' : 'Asked the AI again';
    var result = asked.length ? (asked.length > 1 ? 'it asked for ' + asked.length + ' things at once: ' : 'it asked for ') + asked.join(', ')
      : (last && seq.calls.length > 1 ? 'it wrote its answer and stopped' : 'it answered');
    return { title: title, result: result, tok: (d.input_tokens || d.output_tokens) ? fmtNum(d.input_tokens) + '→' + fmtNum(d.output_tokens) + ' tok' : '' };
  }
  var args = shortValue(d.arguments, 48);
  return { title: 'Used ' + human(d.tool || 'a tool') + (args ? ' ' + args : ''), result: d.result != null ? shortValue(d.result, 90) : (d.status ? String(d.status) : ''), tok: '' };
}

// ---- a step's line on the map --------------------------------------------------------------------
/* The one line under a step's name on Presentation's map: its time first, then what's worth knowing
   at a glance (tokens and cost for the AI, "16 sections → 4" for a search, who approved, the record a
   tool made, the calls an agent loop made). {v: the lead value, rest: [strings], pips: ['ai'|'tool']}. */
export function stepMeta(topo, events, id, steps, opts) {
  opts = opts || {};
  var node = nodeOf(topo, id) || {};
  if (!steps || !steps.length) return { v: opts.finished ? 'not reached' : '', rest: [], off: true };
  var mine = [];
  steps.forEach(function (s) { mine = mine.concat(s.events || []); });
  var ms = steps.reduce(function (a, s) { return a + (s.latency != null ? s.latency : s.end != null && s.start != null ? (s.end - s.start) * 1000 : 0); }, 0);
  var time = opts.running ? (opts.runningMs != null ? fmtMs(opts.runningMs) + '…' : 'running…') : fmtMs(ms) + (steps.length > 1 ? ' ×' + steps.length : '');
  var err = mine.filter(function (e) { return e.event_type === 'error'; })[0];
  if (err && !opts.running) return { v: '✕ error', rest: [time] };
  var resolved = mine.filter(function (e) { return e.event_type === 'gate_resolved'; }).pop();
  var waiting = mine.filter(function (e) { return e.event_type === 'gate_waiting'; })[0];
  if (resolved) { var rd = resolved.data || {}; return { v: rd.approved ? 'approved' : 'denied', rest: rd.by ? ['by ' + rd.by] : [] }; }
  if (waiting) return { v: 'waiting', rest: ['for a person'] };
  var sid = steps[steps.length - 1].id;
  var seq = sid ? callSequence(events, sid) : null;
  if (isCallLoop(seq)) return { v: seq.calls.length + ' calls', rest: [time], pips: seq.calls.map(function (c) { return c.kind; }) };
  var calls = mine.filter(function (e) { return e.event_type === 'llm_call'; });
  if (calls.length) {
    var tin = 0, tout = 0, cost = 0;
    calls.forEach(function (e) { var d = e.data || {}; tin += d.input_tokens || 0; tout += d.output_tokens || 0; cost += Number(d.cost_usd || 0); });
    return { v: time, rest: [(tin || tout) ? fmtNum(tin) + '→' + fmtNum(tout) + ' tok' : null, cost ? fmtUsd(cost) : null].filter(Boolean) };
  }
  if (mine.some(function (e) { return e.event_type === 'retrieval'; })) {
    var docs = documentsStep(topo, events, id), m = docs[0];
    if (m) {
      var c = m.counts;
      var lead = c.documents && c.documents > 1 ? fmtNum(c.documents) + ' files · ' : '';
      return { v: time, rest: [lead + (c.items != null ? fmtNum(c.items) + ' ' + c.unit + ' → ' : 'found ') + c.found] };
    }
  }
  var tool = mine.filter(function (e) { return e.event_type === 'tool_call'; }).pop();
  if (tool) {
    var td = tool.data || {}, made = null;
    Object.keys(td).forEach(function (k) { var v = td[k]; if (!made && v && typeof v === 'object' && !Array.isArray(v) && v.id != null) made = v; });
    return { v: made ? String(made.id) : time, rest: [human(td.tool || 'tool')].concat(made ? [] : []) };
  }
  var badge = stepBadge(topo, events, id, steps);
  badge = String(badge || '').replace(/^→\s*/, '');
  return { v: time, rest: badge ? [badge] : [] };
}

/* Letters for the steps this run didn't take (A, B, C … in map order), so the panel can name one
   ("goes to B · Check the answer"). Only once the run is over: before that, any step may still come. */
export function stepLetters(topo, numbers, order) {
  var out = {}, k = 0;
  (order || ((topo && topo.nodes) || []).map(function (n) { return n.id; })).forEach(function (id) {
    if (numbers && numbers[id]) return;
    out[id] = String.fromCharCode(65 + (k % 26)) + (k >= 26 ? String(Math.floor(k / 26)) : '');
    k++;
  });
  return out;
}

/* The bench viewer core: renders any app from its topology manifest plus bench events.
   No framework, no build. Sources feed events in with bench.push(ev); see sources.js. */
(function (global) {
  'use strict';

  var NODE_W = 184, NODE_H = 54, GAP_X = 18, GAP_Y = 30, PAD = 10;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '–';
    return ms >= 10000 ? (ms / 1000).toFixed(1) + 's' : ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms';
  }
  function fmtUsd(v) { return '$' + Number(v || 0).toFixed(v >= 0.1 ? 3 : 5); }
  function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
  function fmtTok(n) { n = Number(n || 0); return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
  function short(v, n) {
    var s = typeof v === 'string' ? v : JSON.stringify(v);
    n = n || 240;
    return s && s.length > n ? s.slice(0, n) + '…' : s;
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  // ---- layout: layered DAG, top to bottom ------------------------------------------------
  function layout(topo) {
    var ids = topo.nodes.map(function (n) { return n.id; });
    var preds = {}, succs = {};
    ids.forEach(function (id) { preds[id] = []; succs[id] = []; });
    topo.edges.forEach(function (e) {
      if (preds[e.to] && succs[e.from]) { preds[e.to].push(e.from); succs[e.from].push(e.to); }
    });
    // Longest-path depth; the iteration cap keeps a cyclic manifest from hanging the page.
    var depth = {};
    ids.forEach(function (id) { depth[id] = 0; });
    for (var it = 0; it < ids.length + 1; it++) {
      var changed = false;
      topo.edges.forEach(function (e) {
        if (depth[e.to] != null && depth[e.from] != null && depth[e.to] < depth[e.from] + 1 && depth[e.from] + 1 < ids.length) {
          depth[e.to] = depth[e.from] + 1; changed = true;
        }
      });
      if (!changed) break;
    }
    var layers = [];
    ids.forEach(function (id) { (layers[depth[id]] = layers[depth[id]] || []).push(id); });
    layers = layers.filter(Boolean);
    // Barycenter ordering, two sweeps, so branches sit under the node they leave.
    var order = {};
    layers.forEach(function (L) { L.forEach(function (id, i) { order[id] = i; }); });
    for (var sweep = 0; sweep < 3; sweep++) {
      layers.forEach(function (L, li) {
        if (li === 0) return;
        L.sort(function (a, b) {
          function bc(x) {
            var p = preds[x]; if (!p.length) return order[x];
            return p.reduce(function (s, q) { return s + order[q]; }, 0) / p.length;
          }
          return bc(a) - bc(b);
        });
        L.forEach(function (id, i) { order[id] = i; });
      });
    }
    var widest = Math.max.apply(null, layers.map(function (L) { return L.length; }));
    var W = PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X;
    var pos = {};
    layers.forEach(function (L, li) {
      var rowW = L.length * NODE_W + (L.length - 1) * GAP_X;
      var x0 = (W - rowW) / 2;
      L.forEach(function (id, i) { pos[id] = { x: x0 + i * (NODE_W + GAP_X), y: PAD + li * (NODE_H + GAP_Y) }; });
    });
    return { pos: pos, W: W, H: PAD * 2 + layers.length * NODE_H + (layers.length - 1) * GAP_Y };
  }

  /* Presentation pacing. Some steps finish in well under a millisecond, so on screen they'd go
     from dark to done in one frame and the flow would be invisible. Each step is held lit for
     at least MIN_LIT_MS, and a step isn't shown starting until the one before it has been
     shown finishing. Only what's drawn is paced: every time and number shown is real. */
  var MIN_LIT_MS = 450;
  function wallNow() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  // ---- per-run state reduced from events -------------------------------------------------
  function newRun(id) {
    return { id: id, events: [], steps: {}, stepOrder: [], nodeSteps: {}, open: {}, cost: { actual: 0, estimated: 0 },
             tok: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, t0: null, t1: null, status: null,
             gate: null, contentModes: {}, session: null, label: null, output: null, llmCalls: 0 };
  }

  function stepFor(run, ev) {
    return ev.step_id || (run.nodeSteps[ev.node] && run.nodeSteps[ev.node][run.nodeSteps[ev.node].length - 1]) || null;
  }

  function reduce(run, ev) {
    run.events.push(ev);
    run.t0 = run.t0 == null ? ev.ts : Math.min(run.t0, ev.ts);
    run.t1 = run.t1 == null ? ev.ts : Math.max(run.t1, ev.ts);
    run.contentModes[ev.content_mode || 'redacted'] = true;
    if (ev.session_id) run.session = ev.session_id;
    var d = ev.data || {};
    var t = ev.event_type;
    if (t === 'run_started') { run.label = d.label || (d.input ? short(d.input, 90) : null); return; }
    if (t === 'run_finished') {
      run.status = d.status; run.output = d.output != null ? d.output : run.output;
      // Close anything still open: the run is over.
      Object.keys(run.open).forEach(function (sid) { var s = run.steps[sid]; s.end = ev.ts; s.inferred = true; s.status = s.status || 'ok'; s.arrEnd = wallNow(); });
      run.open = {};
      return;
    }
    if (ev.node === '_run') return;

    var sid = t === 'step_started' ? (ev.step_id || run.id + ':' + ev.node + ':' + ((run.nodeSteps[ev.node] || []).length + 1)) : stepFor(run, ev);
    if (!sid || !run.steps[sid]) {
      // Implicit open (SPEC section 2): close the previous top-level step, start this node's.
      if (!sid) sid = run.id + ':' + ev.node + ':' + ((run.nodeSteps[ev.node] || []).length + 1);
      // Implicit boundary (SPEC section 2): the previous step ends at its own last event,
      // and this node's work began then, not when its first event arrived.
      var start = ev.ts;
      if (!ev.parent_step_id && t !== 'step_started') {
        Object.keys(run.open).forEach(function (o) {
          var s = run.steps[o];
          if (!s.parent && s.node !== ev.node) { s.end = s.last; s.inferred = true; s.status = s.status || 'ok'; s.arrEnd = wallNow(); start = Math.min(start, s.last); delete run.open[o]; }
        });
      }
      run.steps[sid] = { id: sid, node: ev.node, parent: ev.parent_step_id || null, start: start, last: ev.ts, end: null, status: null,
                         events: [], latency: null, inferred: t !== 'step_started', timings: null, arr: wallNow(), arrEnd: null };
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
      st.arrEnd = wallNow();
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

  // ---- panel renderers, by event type ----------------------------------------------------
  function kv(k, v, cls) {
    return '<div class="kv' + (cls ? ' ' + cls : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }
  function flatKV(obj, skip) {
    return Object.keys(obj || {}).filter(function (k) { return !(skip || []).includes(k); }).map(function (k) {
      var v = obj[k];
      return kv(k, v !== null && typeof v === 'object' ? short(v, 160) : v);
    }).join('');
  }
  var RENDER = {
    llm_call: function (ev) {
      var d = ev.data;
      var cache = (d.cache_read_tokens || d.cache_write_tokens) ? ' · cache r' + fmtTok(d.cache_read_tokens) + '/w' + fmtTok(d.cache_write_tokens) : '';
      return '<div class="row mono"><span class="tag">' + esc(ev.node) + '</span> ' + esc(d.model) +
        '<span class="right">' + fmtTok(d.input_tokens) + ' in / ' + fmtTok(d.output_tokens) + ' out' + cache +
        (d.cost_usd != null ? ' · ' + fmtUsd(d.cost_usd) + ' <span class="src src-' + esc(d.cost_source) + '">' + esc(d.cost_source === 'actual' ? 'actual' : 'est') + '</span>' : '') +
        (d.latency_ms != null ? ' · ' + fmtMs(d.latency_ms) : '') + '</span></div>';
    },
    retrieval: function (ev) {
      var hits = ev.data.hits || [];
      if (!hits.length) return '<div class="muted">no hits</div>';
      return hits.map(function (h) {
        var extra = Object.keys(h).filter(function (k) { return typeof h[k] === 'number' && k !== 'score'; })
          .map(function (k) { return k + ' ' + Number(h[k]).toFixed(k === 'bm25' ? 1 : 3); }).join(' · ');
        return '<div class="row mono"><span class="tag">' + esc(h.id) + '</span> ' + esc(h.title || '') +
          '<span class="right">' + (h.score != null ? 'score ' + Number(h.score).toFixed(4) : '') + (extra ? ' · ' + esc(extra) : '') + '</span></div>';
      }).join('');
    },
    decision: function (ev) {
      var d = ev.data;
      return (d.choice != null ? kv('choice', d.choice, 'hi') : '') + flatKV(d, ['choice', 'rationale', 'reason']) +
        (d.rationale ? '<div class="note">' + esc(d.rationale) + '</div>' : '') + (d.reason ? '<div class="note">' + esc(d.reason) + '</div>' : '');
    },
    gate_waiting: function (ev) {
      var d = ev.data;
      return '<div class="gate waiting">⏸ waiting at <b>' + esc(ev.node) + '</b>, decided in the app</div>' +
        (d.proposed ? flatKV(d.proposed) : '') + (d.digest ? kv('digest', String(d.digest).slice(0, 16) + '…') : '');
    },
    gate_resolved: function (ev) {
      var d = ev.data;
      return '<div class="gate ' + (d.approved ? 'ok' : 'bad') + '">' + (d.approved ? '✓ approved' : '✕ denied') +
        (d.by ? ' by ' + esc(d.by) : '') + (d.via ? ' via ' + esc(d.via) : '') + '</div>' + flatKV(d, ['approved', 'by', 'via']);
    },
    step_finished: function (ev) {
      var d = ev.data;
      var tm = d.timings ? Object.keys(d.timings).map(function (k) { return k + ' ' + fmtMs(d.timings[k]); }).join(' · ') : '';
      return '<div class="row mono"><span class="tag">' + esc(ev.node) + '</span> ' + esc(d.status) +
        '<span class="right">' + fmtMs(d.latency_ms) + (d.latency_inferred ? ' (inferred)' : '') + (tm ? ' · ' + esc(tm) : '') + '</span></div>';
    },
    error: function (ev) { return '<div class="err">' + esc(ev.node) + ': ' + esc(ev.data.message) + '</div>'; },
    tool_call: function (ev) {
      var d = ev.data;
      return '<div class="row mono"><span class="tag">' + esc(d.tool) + '</span> ' + esc(ev.node) + '</div>' + flatKV(d, ['tool']);
    }
  };
  function renderGeneric(ev) {
    var r = RENDER[ev.event_type];
    return r ? r(ev) : '<div class="row mono"><span class="tag">' + esc(ev.event_type) + '</span> ' + esc(ev.node) + '</div>' + flatKV(ev.data);
  }

  // Declared panels (SPEC section 4): the map names the fields and how to format them.
  function fmtField(v, f) {
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
  function renderFields(ev, fields) {
    return fields.map(function (f) {
      if (typeof f === 'string') f = { key: f };
      var v = ev.data ? ev.data[f.key] : undefined;
      if (f.format === 'quote') return v == null ? '' : '<div class="note">' + esc(v) + '</div>';
      return kv(f.label || f.key, fmtField(v, f.format));
    }).join('');
  }

  /* Stories: an app's own script, registered with its map, that draws custom panels
     and renderers on top of the generic bench. A story adds views; it never replaces
     the raw data, which stays one click away on every panel. */
  var STORIES = {};
  var storyListeners = [];
  global.BenchStory = {
    register: function (appId, story) {
      STORIES[appId] = story || {};
      storyListeners.forEach(function (f) { try { f(appId); } catch (e) {} });
    }
  };
  var helpers = { esc: esc, kv: kv, fmtMs: fmtMs, fmtUsd: fmtUsd, fmtTok: fmtTok, short: short, fields: renderFields, generic: renderGeneric };

  // ---- the bench -------------------------------------------------------------------------
  function Bench(root, opts) {
    this.root = root;
    this.opts = opts || {};
    this.topo = null;
    this.runs = {};
    this.runOrder = [];
    this.current = null;
    this.pinned = false;
    this.selectedNode = null;
    this._raf = null;
    this._build();
  }

  Bench.prototype._build = function () {
    var r = this.root;
    r.innerHTML =
      '<header class="bh">' +
        '<span class="app" data-f="app">bench</span>' +
        '<span class="badge" data-f="mode">–</span>' +
        '<span class="badge" data-f="content" title="Whether prompts and outputs are shown exactly as sent, or with personal details masked first. The app decides.">–</span>' +
        '<span class="badge detail-only" data-f="session" title="Live, the bench follows only this session.">session –</span>' +
        '<select data-f="runs" title="Every run the bench has seen"></select>' +
        '<span class="bh-spacer"></span>' +
        '<span class="viewtoggle" role="group" aria-label="Detail level">' +
          '<button data-v="overview" title="The flow, the timeline and what each step did">Overview</button>' +
          '<button data-v="detailed" title="Everything: ids, every field, the raw event log">Detailed</button>' +
        '</span>' +
      '</header>' +
      '<div class="meterbar mono" data-f="meters"></div>' +
      '<div class="bgrid">' +
        '<section class="col graphcol">' +
          '<div class="stitle"><b>Flow</b> <span>every step the app can take · lit = this run · dashed = not taken · click a step</span></div>' +
          '<div class="graphwrap" data-f="graph"></div>' +
          '<div class="stitle"><b>Timeline</b> <span>how long each step took</span></div>' +
          '<div class="waterfall" data-f="waterfall"></div>' +
        '</section>' +
        '<section class="col panelcol" data-f="panels"></section>' +
      '</div>' +
      '<section class="logcol detail-only">' +
        '<div class="stitle"><b>Event log</b> <span>every event received, in order</span> <span class="muted" data-f="logcount"></span></div>' +
        '<div class="log mono" data-f="log"></div>' +
      '</section>';
    this.f = {};
    var self = this;
    r.querySelectorAll('[data-f]').forEach(function (e) { self.f[e.getAttribute('data-f')] = e; });
    this.f.runs.onchange = function () { self.current = self.f.runs.value; self.pinned = self.current !== self.runOrder[self.runOrder.length - 1]; self.render(); };
    var saved = null;
    try { saved = localStorage.getItem('bench.view'); } catch (e) {}
    this.setView(this.opts.view || saved || 'overview');
    r.querySelectorAll('.viewtoggle button').forEach(function (b) {
      b.onclick = function () { self.setView(b.getAttribute('data-v')); try { localStorage.setItem('bench.view', self.view); } catch (e) {} };
    });
  };

  /* Two levels (Trent, 09-29): Overview is the presentation, readable by anyone; Detailed is
     the debugging tool, with ids, every field and the raw event log. */
  Bench.prototype.setView = function (v) {
    this.view = v === 'detailed' ? 'detailed' : 'overview';
    this.root.classList.toggle('view-detailed', this.view === 'detailed');
    this.root.classList.toggle('view-overview', this.view === 'overview');
    var self = this;
    this.root.querySelectorAll('.viewtoggle button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === self.view); });
    this.render();
  };

  Bench.prototype.story = function () {
    return (this.topo && STORIES[this.topo.app.id]) || {};
  };

  Bench.prototype.renderEvent = function (ev, raw) {
    var r = !raw && this.story().renderers && this.story().renderers[ev.event_type];
    if (r) { try { return r(ev, { h: helpers }); } catch (e) { /* fall through to the generic view */ } }
    return raw ? '<div class="row mono"><span class="tag">' + esc(ev.event_type) + '</span> ' + esc(ev.node) + '</div>' + flatKV(ev.data) : renderGeneric(ev);
  };

  /* Loads an app's story: `source` is its script text (from a recording), else the bench
     serves what the app registered at <base>apps/<id>/story.js. */
  Bench.prototype.loadStory = function (appId, source, base) {
    var self = this;
    storyListeners.push(function (id) { if (self.topo && id === self.topo.app.id) { self._buildPanels(); self.render(); } });
    var s = document.createElement('script');
    if (source) s.textContent = source;
    else s.src = (base || '') + 'apps/' + encodeURIComponent(appId) + '/story.js';
    document.head.appendChild(s);
  };

  // Show everything received as already happened: no pacing (e.g. "skip to end").
  Bench.prototype.skipPacing = function () {
    var self = this;
    Object.keys(this.runs).forEach(function (id) {
      var run = self.runs[id];
      run.stepOrder.forEach(function (sid) { var s = run.steps[sid]; s.arr = -1e12; if (s.arrEnd != null) s.arrEnd = -1e12; });
    });
    this.render();
  };

  Bench.prototype.setMode = function (text, cls) {
    this.f.mode.textContent = text;
    this.f.mode.className = 'badge ' + (cls || '');
  };

  Bench.prototype.setTopology = function (topo) {
    this.topo = topo;
    this.layout = layout(topo);
    this.f.app.textContent = topo.app.name;
    this._drawGraph();
    this._buildPanels();
    this.render();
  };

  Bench.prototype.reset = function () {
    this.runs = {}; this.runOrder = []; this.current = null; this.pinned = false; this.render();
  };

  Bench.prototype.push = function (ev) {
    var run = this.runs[ev.run_id];
    if (!run) {
      run = this.runs[ev.run_id] = newRun(ev.run_id);
      this.runOrder.push(ev.run_id);
      if (!this.pinned) { this.current = ev.run_id; this.ioPick = null; }
    }
    reduce(run, ev);
    this._schedule();
  };

  Bench.prototype._schedule = function () {
    var self = this;
    if (this._raf) return;
    this._raf = (global.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { self._raf = null; self.render(); });
  };

  // Branch labels sit near the edge's target end, where branches have fanned apart.
  // Adjacent-layer branches are labelled near their target, where they have fanned apart;
  // long edges near their source, before they pass behind other nodes.
  function labelAt(x1, y1, x2, y2, dy, text, t) {
    var u = 1 - t;
    var x = u * u * u * x1 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x2;
    var y = u * u * u * y1 + 3 * u * u * t * (y1 + dy) + 3 * u * t * t * (y2 - dy) + t * t * t * y2;
    return '<text x="' + (x + 4) + '" y="' + (y - 2) + '">' + esc(text) + '</text>';
  }

  Bench.prototype._drawGraph = function () {
    var L = this.layout, topo = this.topo, g = this.f.graph, self = this;
    var svg = '<svg class="edges" width="' + L.W + '" height="' + L.H + '" viewBox="0 0 ' + L.W + ' ' + L.H + '">' +
      '<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>';
    topo.edges.forEach(function (e, i) {
      var a = L.pos[e.from], b = L.pos[e.to];
      if (!a || !b) return;
      var x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y;
      var dy = Math.max(18, (y2 - y1) / 2);
      svg += '<g class="edge" data-edge="' + i + '"><path d="M' + x1 + ',' + y1 + ' C' + x1 + ',' + (y1 + dy) + ' ' + x2 + ',' + (y2 - dy) + ' ' + x2 + ',' + y2 + '" marker-end="url(#arr)"/>' +
        ((e.from_branch || e.when) ? labelAt(x1, y1, x2, y2, dy, (e.from_branch || e.when).replace(/_/g, ' '), (y2 - y1) > NODE_H + GAP_Y * 1.5 ? 0.22 : 0.78) : '') + '</g>';
    });
    svg += '</svg>';
    var boxes = topo.nodes.map(function (n) {
      var p = L.pos[n.id];
      return '<div class="gnode kind-' + esc(n.kind || 'step') + '" data-node="' + esc(n.id) + '" style="left:' + p.x + 'px;top:' + p.y + 'px;width:' + NODE_W + 'px;height:' + NODE_H + 'px" title="' + esc((n.label || n.id) + (n.description ? ': ' + n.description : '')) + '">' +
        '<div class="gl">' + esc(n.label || n.id) + '</div><div class="gm mono"></div><div class="gp"></div></div>';
    }).join('');
    g.innerHTML = '<div class="graph" style="width:' + L.W + 'px;height:' + L.H + 'px">' + svg + boxes + '</div><div class="unmapped" data-f="unmapped"></div>';
    // Narrow screens: shrink the whole flow to fit rather than scroll sideways.
    var gr = g.querySelector('.graph');
    function fit() {
      var avail = g.clientWidth || L.W, k = Math.min(1, avail / L.W);
      gr.style.transform = k < 1 ? 'scale(' + k + ')' : '';
      gr.style.transformOrigin = 'top left';
      gr.style.margin = k < 1 ? '0' : '0 auto';
      gr.style.marginBottom = k < 1 ? (-(1 - k) * L.H) + 'px' : '';
    }
    fit();
    if (!this._fitBound) { this._fitBound = true; global.addEventListener('resize', function () { if (self._fit) self._fit(); }); }
    this._fit = fit;
    this.f.unmapped = g.querySelector('.unmapped');
    g.querySelectorAll('.gnode').forEach(function (n) {
      n.onclick = function () { var id = n.getAttribute('data-node'); self.selectedNode = self.selectedNode === id ? null : id; self.ioPick = null; self.render(); };
    });
  };

  Bench.prototype._buildPanels = function () {
    var box = this.f.panels;
    box.innerHTML = '';
    this.panelEls = {};
    var panels = (this.topo.panels || []).slice();

    panels.unshift({ id: '_io', title: 'Model I/O · exactly what the model was given, and what it returned', event_types: ['llm_call'] });
    panels.unshift({ id: '_node', title: 'Selected step', event_types: ['*'], mode: 'append' });
    panels.unshift({ id: '_run', title: 'This run', event_types: ['run_started', 'run_finished'] });
    var self = this;
    panels.forEach(function (p) {
      var custom = p.story || p.fields;
      var e = el('div', 'panel' + (p.story ? ' storied' : ''), '<div class="ptitle"><span>' + esc(p.title) + '</span><span class="pright">' +
        (custom ? '<button class="rawbtn" title="Show every field of every event this panel collects">raw</button>' : '') +
        '<span class="pcount mono"></span></span></div><div class="pbody"><span class="muted">–</span></div>');
      box.appendChild(e);
      var P = self.panelEls[p.id] = { spec: p, el: e, body: e.querySelector('.pbody'), count: e.querySelector('.pcount'), raw: false };
      var rb = e.querySelector('.rawbtn');
      if (rb) rb.onclick = function () { P.raw = !P.raw; rb.classList.toggle('on', P.raw); self.render(); };
    });
  };

  Bench.prototype.render = function () {
    if (!this.topo) return;
    var self = this, run = this.current ? this.runs[this.current] : null;
    // run selector
    var sel = this.f.runs;
    if (sel.options.length !== this.runOrder.length) {
      sel.innerHTML = this.runOrder.map(function (id, i) {
        var r = self.runs[id];
        return '<option value="' + esc(id) + '">#' + (i + 1) + ' ' + esc(r.label ? short(r.label, 40) : id) + '</option>';
      }).join('');
    }
    if (this.current) sel.value = this.current;
    sel.style.display = this.runOrder.length ? '' : 'none';

    if (!run) {
      this.f.meters.textContent = 'waiting for events…';
      return;
    }
    // header meters
    var modes = Object.keys(run.contentModes);
    this.f.content.textContent = modes.length > 1 ? 'prompts: mixed' : modes[0] === 'full' ? 'prompts: shown in full' : 'prompts: personal details masked';
    this.f.content.className = 'badge';
    this.f.session.textContent = 'session ' + (run.session || '–');
    function m(v, label, title) { return '<span' + (title ? ' title="' + esc(title) + '"' : '') + '><b>' + v + '</b> ' + label + '</span>'; }
    var cost = (run.cost.actual ? m(fmtUsd(run.cost.actual), 'cost, reported by the provider') : '') +
      (run.cost.estimated ? m(fmtUsd(run.cost.estimated), 'estimated cost', 'Priced by the app from a price table') : '') || m('$0', 'cost');
    var st = run.status || (run.gate && run.gate.state === 'waiting' ? 'waiting' : 'running');
    var stTxt = { ok: '✓ finished', error: '✕ error', aborted: 'aborted', waiting: '⏸ waiting for approval', running: '● running' }[st] || st;
    this.f.meters.innerHTML = cost +
      m(fmtNum(run.tok.input), 'tokens in', run.tok.cache_read ? fmtNum(run.tok.cache_read) + ' of them read from the cache' : '') +
      m(fmtNum(run.tok.output), 'tokens out') +
      m(run.llmCalls, 'model call' + (run.llmCalls === 1 ? '' : 's')) +
      m(fmtMs((run.t1 - run.t0) * 1000), 'total') +
      '<span class="status st-' + esc(st) + '">' + esc(stTxt) + '</span>';

    this._renderGraph(run);
    this._renderWaterfall(run);
    this._renderPanels(run);
    this._renderLog(run);
  };

  // When each top-level step is shown starting and finishing (see MIN_LIT_MS), in wall time.
  function schedule(run) {
    var prevEnd = -Infinity;
    run.stepOrder.forEach(function (sid) {
      var s = run.steps[sid];
      if (s.parent) { s.vs = s.arr; s.ve = s.arrEnd == null ? Infinity : s.arrEnd; return; }
      s.vs = Math.max(s.arr, prevEnd);
      s.ve = s.arrEnd == null ? Infinity : Math.max(s.arrEnd, s.vs + (s.status === 'skipped' ? 150 : MIN_LIT_MS));
      prevEnd = s.ve;
    });
    return prevEnd;
  }

  // One line on the node saying what it produced: the branch it took, or the start of its output.
  function preview(steps) {
    var out = null;
    steps.forEach(function (s) {
      s.events.forEach(function (e) {
        var d = e.data || {};
        if (e.event_type === 'decision' && d.branch != null) out = '→ ' + String(d.branch).replace(/_/g, ' ');
        else if (e.event_type === 'gate_resolved') out = d.approved ? '✓ approved' : '✕ denied';
        else if (e.event_type === 'gate_waiting') out = out || '⏸ waiting for a human';
        else if (e.event_type === 'error') out = '✕ ' + (d.message || 'error');
        else if (e.event_type === 'retrieval' && d.hits) out = out || (d.hits.length + ' hit' + (d.hits.length === 1 ? '' : 's') + (d.hits[0] && d.hits[0].title ? ': ' + d.hits[0].title : ''));
        else if (e.event_type === 'llm_call' && d.output != null && !out) out = '“' + short(typeof d.output === 'string' ? d.output : JSON.stringify(d.output), 60) + '”';
        else if (e.event_type === 'step_finished' && d.output != null && !out) out = '“' + short(typeof d.output === 'string' ? d.output : JSON.stringify(d.output), 60) + '”';
      });
    });
    return out ? String(out).replace(/\s+/g, ' ') : '';
  }

  Bench.prototype._renderGraph = function (run) {
    var self = this, g = this.f.graph, now = wallNow();
    var shownEnd = schedule(run);
    var finished = !!run.status && now >= shownEnd;
    var ran = {}, seq = [], openNode = null;
    run.stepOrder.forEach(function (sid) {
      var s = run.steps[sid];
      if (s.parent || s.vs > now) return;             // not shown starting yet
      ran[s.node] = (ran[s.node] || []).concat([s]);
      if (s.ve > now) openNode = s.node;
      // A step the app reports as skipped was reached but did no work: it is not on the lit path.
      if (s.status !== 'skipped' && seq[seq.length - 1] !== s.node) seq.push(s.node);
    });
    var taken = {};
    for (var i = 1; i < seq.length; i++) taken[seq[i - 1] + '>' + seq[i]] = true;
    // When a node reports the branch it took, that names the edge exactly: consecutive steps
    // can't tell two edges between the same pair of nodes apart, and a branch can be known
    // before the next node has started.
    run.events.forEach(function (e) {
      if (e.event_type !== 'decision' || !e.data || e.data.branch == null || !ran[e.node]) return;
      self.topo.edges.forEach(function (ed) { if (ed.from === e.node && ed.from_branch === e.data.branch) taken[ed.from + '>' + ed.to] = true; });
    });
    g.querySelectorAll('.gnode').forEach(function (n) {
      var id = n.getAttribute('data-node'), steps = ran[id] || [];
      var last = steps[steps.length - 1];
      var cls = 'gnode kind-' + ((self.topo.nodes.find(function (x) { return x.id === id; }) || {}).kind || 'step');
      var shownOpen = last && last.ve > now;
      if (!steps.length) cls += finished ? ' untaken' : ' idle';
      else if (last.status === 'error' && !shownOpen) cls += ' error';
      else if (steps.every(function (s) { return s.status === 'skipped'; })) cls += ' skipped';
      else if (run.gate && run.gate.node === id && run.gate.state === 'waiting') cls += ' gatewait';
      else if (shownOpen) cls += ' active';
      else cls += ' done';
      if (self.selectedNode === id) cls += ' selected';
      n.className = cls;
      var m = '';
      if (steps.length) {
        var cost = 0, tokIn = 0, tokOut = 0;
        steps.forEach(function (s) { s.events.forEach(function (e) { if (e.event_type === 'llm_call') { cost += Number(e.data.cost_usd || 0); tokIn += e.data.input_tokens || 0; tokOut += e.data.output_tokens || 0; } }); });
        var ms;
        if (last.arrEnd == null) ms = now - last.arr;   // still running: a live timer
        else ms = steps.reduce(function (a, s) { return a + (s.latency != null ? s.latency : s.end != null ? (s.end - s.start) * 1000 : 0); }, 0);
        m = fmtMs(ms) + (last.arrEnd == null ? '…' : '') + (steps.length > 1 ? ' ×' + steps.length : '') + (tokIn ? ' · ' + fmtTok(tokIn) + '→' + fmtTok(tokOut) + ' tok' : '') + (cost ? ' · ' + fmtUsd(cost) : '');
      }
      n.querySelector('.gm').textContent = m;
      n.querySelector('.gp').textContent = shownOpen ? '' : preview(steps);
    });
    g.querySelectorAll('.edge').forEach(function (e) {
      var ed = self.topo.edges[+e.getAttribute('data-edge')];
      var k = ed.from + '>' + ed.to;
      e.setAttribute('class', 'edge' + (taken[k] ? ' taken' + (openNode === ed.to ? ' flowing' : '') : finished ? ' untaken' : ''));
    });
    var known = {};
    this.topo.nodes.forEach(function (n) { known[n.id] = true; });
    var unm = Object.keys(ran).filter(function (n) { return !known[n]; });
    this.f.unmapped.innerHTML = unm.length ? '<span class="muted">not in the manifest:</span> ' + unm.map(function (n) { return '<span class="tag">' + esc(n) + '</span>'; }).join(' ') : '';
    // Keep drawing while anything is shown running (live timers) or waiting to be shown.
    var busy = shownEnd > now || run.stepOrder.some(function (sid) { return run.steps[sid].arrEnd == null; });
    clearTimeout(this._tick);
    if (busy) this._tick = setTimeout(function () { self.render(); }, 100);
  };

  Bench.prototype._renderWaterfall = function (run) {
    var span = Math.max(0.001, (run.t1 - run.t0));
    var html = run.stepOrder.map(function (sid) {
      var s = run.steps[sid];
      var end = s.end != null ? s.end : run.t1;
      var left = ((s.start - run.t0) / span) * 100, w = Math.max(0.6, ((end - s.start) / span) * 100);
      var isGate = run.gate && run.gate.node === s.node;
      var ms = s.latency != null ? s.latency : (end - s.start) * 1000;
      return '<div class="wrow' + (s.parent ? ' child' : '') + '"><span class="wl mono">' + esc(s.node) + '</span><span class="wtrack"><span class="wbar' +
        (s.inferred ? ' inferred' : '') + (s.status === 'error' ? ' error' : '') + (s.status === 'skipped' ? ' skipped' : '') + (isGate ? ' gate' : '') + (s.end == null ? ' open' : '') +
        '" style="left:' + left + '%;width:' + w + '%"></span></span><span class="wv mono">' + fmtMs(ms) + (s.inferred ? '<i class="detail-only">~</i>' : '') + '</span></div>';
    }).join('');
    var anyInferred = run.stepOrder.some(function (sid) { return run.steps[sid].inferred; });
    this.f.waterfall.innerHTML = html + (anyInferred ? '<div class="legend muted detail-only">~ = inferred from event times (the app sent no step_finished; see SPEC section 2)</div>' : '');
  };

  Bench.prototype._renderPanels = function (run) {
    var self = this;
    Object.keys(this.panelEls).forEach(function (pid) {
      var P = self.panelEls[pid], spec = P.spec, evs;
      if (pid === '_node') {
        P.el.classList.toggle('empty', !self.selectedNode);
        if (!self.selectedNode) { P.body.innerHTML = '<span class="muted">Click any step in the flow to see what it did.</span>'; P.count.textContent = ''; return; }
        self._renderStep(P, run); return;
      } else {
        evs = run.events.filter(function (e) {
          return spec.event_types.indexOf(e.event_type) >= 0 && (!spec.nodes || spec.nodes.indexOf(e.node) >= 0);
        });
      }
      P.el.classList.toggle('empty', !evs.length);
      P.count.textContent = evs.length ? ' ' + evs.length : '';
      if (!evs.length) { P.body.innerHTML = '<span class="muted">–</span>'; return; }
      if (pid === '_io') { self._renderIO(P, run); return; }
      if (pid === '_run') {
        var st = evs.filter(function (e) { return e.event_type === 'run_started'; })[0];
        var fin = evs.filter(function (e) { return e.event_type === 'run_finished'; })[0];
        P.body.innerHTML = '<div class="detail-only">' + kv('run', run.id) + (st && st.data.origin ? kv('origin', st.data.origin) : '') +
          (fin ? kv('status', fin.data.status + (fin.data.outcome ? ' · ' + fin.data.outcome : '')) : '') + '</div>' +
          (st && st.data.input ? '<div class="iolabel">Request</div><div class="note quote">' + esc(short(typeof st.data.input === 'string' ? st.data.input : JSON.stringify(st.data.input), 600)) + '</div>' : '') +
          (run.output ? '<div class="iolabel">Final output</div><div class="note quote out">' + esc(short(typeof run.output === 'string' ? run.output : JSON.stringify(run.output), 800)) + '</div>' : '');
        return;
      }
      var list = spec.mode === 'append' ? evs : evs.slice(-1);
      var story = self.story();
      if (!P.raw && spec.story && story.panels && story.panels[pid]) {
        try { P.body.innerHTML = story.panels[pid](list, { run: run, h: helpers, all: evs }); return; }
        catch (err) { P.body.innerHTML = '<div class="err">story panel failed: ' + esc(err.message) + '</div>'; }
      }
      P.body.innerHTML = list.map(function (e) {
        if (!P.raw && spec.fields) return '<div class="pev">' + renderFields(e, spec.fields) + '</div>';
        return '<div class="pev">' + self.renderEvent(e, P.raw) + '</div>';
      }).join('');
    });
  };

  function ioText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.every(function (b) { return b && b.type === 'text'; })) return v.map(function (b) { return b.text; }).join('\n');
    return JSON.stringify(v, null, 2);
  }
  function ioBlock(label, text, cls) {
    return '<div class="iolabel">' + esc(label) + ' <span class="muted">' + text.length.toLocaleString() + ' chars</span></div><pre class="io' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</pre>';
  }

  // The Selected step panel: the step's own header (what its box shows), then its input and
  // output; Detailed adds every event it reported.
  Bench.prototype._renderStep = function (P, run) {
    var self = this, id = this.selectedNode;
    var node = this.topo.nodes.find(function (n) { return n.id === id; }) || { id: id };
    var steps = (run.nodeSteps[id] || []).map(function (sid) { return run.steps[sid]; }).filter(function (s) { return !s.parent; });
    var evs = run.events.filter(function (e) { return e.node === id; });
    P.count.textContent = '';
    if (!steps.length) {
      P.body.innerHTML = '<div class="stephead"><b>' + esc(node.label || id) + '</b></div>' + (node.description ? '<div class="note">' + esc(node.description) + '</div>' : '') +
        '<div class="note">' + (run.status ? 'This step didn\u2019t run this time.' : 'Not reached yet.') + '</div>';
      return;
    }
    var ms = steps.reduce(function (a, s) { return a + (s.latency != null ? s.latency : s.end != null ? (s.end - s.start) * 1000 : 0); }, 0);
    var cost = 0, tin = 0, tout = 0, model = null;
    evs.forEach(function (e) { if (e.event_type === 'llm_call') { cost += Number(e.data.cost_usd || 0); tin += e.data.input_tokens || 0; tout += e.data.output_tokens || 0; model = e.data.model; } });
    var head = '<div class="stephead"><b>' + esc(node.label || id) + '</b><span class="tag">' + esc(node.kind || 'step') + '</span></div>' +
      (node.description ? '<div class="note">' + esc(node.description) + '</div>' : '') +
      '<div class="stepstats mono"><span><b>' + fmtMs(ms) + '</b> took</span>' + (steps.length > 1 ? '<span><b>' + steps.length + '</b> times</span>' : '') +
      (model ? '<span><b>' + esc(model) + '</b></span><span><b>' + fmtNum(tin) + '</b> tokens in</span><span><b>' + fmtNum(tout) + '</b> out</span>' : '') +
      (cost ? '<span><b>' + fmtUsd(cost) + '</b></span>' : '') + '</div>';
    var pv = preview(steps);
    if (pv) head += '<div class="stepresult">' + esc(pv) + '</div>';
    var io = '';
    evs.forEach(function (e) {
      if (e.event_type === 'step_started' && e.data && e.data.input != null) io += ioBlock('input', ioText(e.data.input));
      if (e.event_type === 'step_finished' && e.data && e.data.output != null) io += ioBlock('output', ioText(e.data.output), 'out');
    });
    if (model) io += '<div class="note">Its model call, word for word, is in <b>Model I/O</b> below.</div>';
    var raw = '<div class="detail-only"><div class="iolabel">every event it reported</div>' + evs.map(function (e) { return '<div class="pev">' + self.renderEvent(e, true) + '</div>'; }).join('') + '</div>';
    P.body.innerHTML = head + io + raw;
  };

  // The built-in Model I/O panel: the selected node's model call, or the run's latest.
  Bench.prototype._renderIO = function (P, run) {
    var self = this;
    var calls = run.events.filter(function (e) { return e.event_type === 'llm_call'; });
    var pick = calls.filter(function (e) { return !self.selectedNode || e.node === self.selectedNode; });
    if (this.ioPick != null && calls[this.ioPick] && (!self.selectedNode || calls[this.ioPick].node === self.selectedNode)) pick = [calls[this.ioPick]];
    var ev = pick[pick.length - 1];
    P.count.textContent = calls.length ? ' ' + calls.length : '';
    P.el.classList.toggle('empty', !calls.length);
    // Without a model call, a selected step's own input and output are the next best thing.
    if (!ev) {
      var steps = self.selectedNode ? (run.nodeSteps[self.selectedNode] || []).map(function (id) { return run.steps[id]; }) : [];
      var io = '';
      steps.forEach(function (st) { st.events.forEach(function (e) {
        if (e.event_type === 'step_started' && e.data && e.data.input != null) io += ioBlock('step input', ioText(e.data.input));
        if (e.event_type === 'step_finished' && e.data && e.data.output != null) io += ioBlock('step output', ioText(e.data.output), 'out');
      }); });
      P.body.innerHTML = io || '<span class="muted">' + (self.selectedNode ? 'no model call on this node' : 'no model call yet') + '</span>';
      return;
    }
    var d = ev.data || {};
    var tabs = calls.length > 1 ? '<div class="iotabs">' + calls.map(function (c, i) {
      return '<button class="iotab' + (c === ev ? ' on' : '') + '" data-i="' + i + '">' + esc(c.node) + '</button>';
    }).join('') + '</div>' : '';
    var head = '<div class="row mono"><span class="tag">' + esc(ev.node) + '</span> ' + esc(d.model) + '<span class="right">' + fmtTok(d.input_tokens) + ' in / ' +
      fmtTok(d.output_tokens) + ' out' + (d.cost_usd != null ? ' · ' + fmtUsd(d.cost_usd) : '') + (d.latency_ms != null ? ' · ' + fmtMs(d.latency_ms) : '') +
      (d.finish_reason ? ' · ' + esc(d.finish_reason) : '') + '</span></div>';
    var body = '';
    if (d.system != null) body += ioBlock('system', ioText(d.system));
    (d.messages || []).forEach(function (m, i) { body += ioBlock(m.role || 'message ' + (i + 1), ioText(m.content)); });
    if (d.output != null) body += ioBlock('output', ioText(d.output), 'out');
    if (!body) body = '<div class="note">This app doesn\'t send its prompt and response to the bench yet: <span class="mono">llm_call.data.system / messages / output</span> (SPEC section 2).</div>';
    if (ev.content_mode === 'redacted' && (d.system != null || d.messages || d.output != null)) body = '<div class="note">content: redacted (personal details masked before sending)</div>' + body;
    P.body.innerHTML = tabs + head + body;
    P.body.querySelectorAll('.iotab').forEach(function (b) { b.onclick = function () { self.ioPick = +b.getAttribute('data-i'); self.selectedNode = null; self.render(); }; });
  };

  Bench.prototype._renderLog = function (run) {
    var t0 = run.t0;
    this.f.logcount.textContent = run.events.length + ' events';
    this.f.log.innerHTML = run.events.map(function (e) {
      return '<div class="lrow t-' + esc(e.event_type) + '"><span class="ls">' + (e.seq != null ? e.seq : '') + '</span><span class="lt">+' + fmtMs((e.ts - t0) * 1000) +
        '</span><span class="ln">' + esc(e.node) + '</span><span class="le">' + esc(e.event_type) + '</span><span class="ld">' + esc(short(e.data, 400)) + '</span></div>';
    }).join('');
  };

  global.Bench = Bench;
  global.BenchLayout = layout;
})(typeof window !== 'undefined' ? window : this);

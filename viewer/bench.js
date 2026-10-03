/* The bench viewer core: renders any app from its topology manifest plus bench events.
   No framework, no build. Sources feed events in with bench.push(ev); see sources.js.
   The pure logic (narration, source and check states, the cursor, the inferred map, the
   helpers a story gets as ctx.h) lives in logic.js, which index.html loads as
   window.BenchLogic before this file runs. The map's layout and edge routing live in
   layout.js (window.BenchLayout), which the lab's front door loads on its own. */
(function (global) {
  'use strict';


  var BL = null;
  function lg() {
    if (!BL) BL = global.BenchLogic;
    if (!BL) throw new Error('viewer/logic.js is not loaded (window.BenchLogic)');
    return BL;
  }
  function esc(s) { return lg().esc(s); }
  function fmtMs(ms) { return lg().fmtMs(ms); }
  function fmtUsd(v) { return lg().fmtUsd(v); }
  function fmtNum(n) { return lg().fmtNum(n); }
  function fmtTok(n) { return lg().fmtTok(n); }
  function short(v, n) { return lg().short(v, n); }
  function kv(k, v, cls) { return lg().kv(k, v, cls); }
  function flatKV(o, skip, mode) { return lg().flatKV(o, skip, mode); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  // Rewrites an element only when its HTML changed, so a 100 ms redraw keeps scroll and focus.
  function setHTML(e, html) { if (e && e._h !== html) { e._h = html; e.innerHTML = html; } }

  // ---- layout: viewer/layout.js (BenchLayout), shared with the lab's front door ---------------
  function layout(topo, geom) {
    if (!global.BenchLayout) throw new Error('viewer/layout.js is not loaded (window.BenchLayout)');
    return global.BenchLayout(topo, geom);
  }

  /* Presentation pacing. Some steps finish in well under a millisecond, so on screen they'd go
     from dark to done in one frame and the flow would be invisible. Each step is held lit for
     at least MIN_LIT_MS, and a step isn't shown starting until the one before it has been
     shown finishing. Only what's drawn is paced: every time and number shown is real. */
  var MIN_LIT_MS = 450;
  function wallNow() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

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
    this.source = this.opts.source || 'live';   // replay | parent | live: picks the default mode
    this.inferred = null;                        // Level 0: {appId, name} when no map was registered
    this.transport = null;
    this.tstate = null;
    this.presOpen = {};
    this.picker = null;
    this.pair = null;
    this.overlay = null;
    this._raf = null;
    this._build();
  }

  var ACTOR_CHIP = { ai: 'AI', rule: 'rule', person: 'person', app: 'app' };

  Bench.prototype._build = function () {
    var r = this.root;
    var toggle = '<span class="viewtoggle" role="group" aria-label="View mode">' +
      '<button data-v="presentation" title="For a room: plain words, what it looked at, how it was checked, who signed off">Presentation</button>' +
      '<button data-v="engineering" title="Everything: tokens, ids, every field, the raw event log">Engineering</button></span>';
    r.innerHTML =
      '<div class="eng">' +
      '<header class="bh">' +
        '<span class="app" data-f="app">bench</span>' +
        '<span class="badge" data-f="mode">–</span>' +
        '<span class="badge" data-f="content" title="Whether prompts and outputs are shown here exactly as sent, with personal details masked in this record (not necessarily for the model), or not captured at all. The app decides.">–</span>' +
        '<span class="badge" data-f="inferred" hidden title="No map was registered for this app, so the bench drew one from the steps it has seen.">map inferred from the trace</span>' +
        '<button class="badge dl" data-f="download" hidden title="Download this inferred map as a starting topology.json for Level 1: its node ids are the ones your spans produce. Add plain_label and description, then PUT it to /apps/<id>.">⤓ map as topology.json</button>' +
        '<span class="badge" data-f="session" title="Live, the bench follows only this session.">session –</span>' +
        '<select data-f="runs" title="Every run the bench has seen"></select>' +
        '<span class="bh-spacer"></span>' + toggle +
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
      '<section class="logcol">' +
        '<div class="stitle"><b>Event log</b> <span>every event received, in order</span> <span class="muted" data-f="logcount"></span></div>' +
        '<div class="log mono" data-f="log"></div>' +
      '</section>' +
      '</div>' +
      '<div class="pres">' +
        '<header class="p-head">' +
          '<div class="p-req" data-p="req"></div>' +
          '<div class="p-sub"><span class="p-appname" data-p="appname"></span><span class="p-who" data-p="who"></span><span class="p-inferred" data-p="inferred" hidden>map inferred from the trace</span>' +
            '<span class="bh-spacer"></span><span data-p="picker"></span>' + toggle + '</div>' +
          '<div class="p-outrow"><div class="p-out"><div data-p="outcome"></div><div class="p-why" data-p="why"></div></div><div class="p-transport" data-p="transport"></div></div>' +
        '</header>' +
        '<div class="p-main">' +
          '<section class="p-graph"><div class="graphwrap" data-p="graph"></div><div class="edgetip" data-p="tip" hidden></div>' +
            '<button class="p-mapbtn" data-p="mapbtn" title="Give the map the whole screen (for a room); again to bring the details back">⤢ Map only</button></section>' +
          '<section class="p-side">' +
            '<div class="p-now" data-p="now"></div>' +
            '<div class="p-rows" data-p="rows"></div>' +
          '</section>' +
        '</div>' +
        '<footer class="p-bottom" data-p="bottom"></footer>' +
        '<div class="p-overlay" data-p="overlay" hidden></div>' +
      '</div>';
    this.f = {}; this.p = {};
    var self = this;
    r.querySelectorAll('[data-f]').forEach(function (e) { self.f[e.getAttribute('data-f')] = e; });
    r.querySelectorAll('[data-p]').forEach(function (e) { self.p[e.getAttribute('data-p')] = e; });
    this.f.runs.onchange = function () { self.current = self.f.runs.value; self.pinned = self.current !== self.runOrder[self.runOrder.length - 1]; self.render(); };
    r.querySelectorAll('.viewtoggle button').forEach(function (b) {
      b.onclick = function () { self.setViewMode(b.getAttribute('data-v'), true); };
    });
    // Delegated clicks for everything Presentation redraws.
    this.p.now.onclick = this.p.rows.onclick = this.p.bottom.onclick = this.p.overlay.onclick = this.p.transport.onclick = this.p.why.onclick = function (e) { self._presClick(e); };
    this.p.mapbtn.onclick = function () {
      self.mapOnly = !self.mapOnly;
      self.root.classList.toggle('p-maponly', self.mapOnly);
      self.p.mapbtn.textContent = self.mapOnly ? '⤡ Show details' : '⤢ Map only';
      if (self._fit) self._fit();
    };
    this.f.download.onclick = function () { self.downloadMap(); };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.overlay) { self.overlay = null; self.render(); return; }
      // A presenter's keys (and clicker, which sends PageUp/PageDown): step, and Space to play/pause.
      if (self.mode !== 'presentation' || self.overlay || !self.transport || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test((e.target && e.target.tagName) || '') && e.key === ' ') return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
      var act = { ArrowRight: 'next', PageDown: 'next', ArrowLeft: 'back', PageUp: 'back' }[e.key];
      if (e.key === ' ') act = self._tstateShown === 'playing' ? 'pause' : self._tstateShown === 'done' ? 'restart' : 'play';
      if (act && self.transport[act]) { e.preventDefault(); self.selectedNode = null; self.transport[act](); }
    });
    var res = this._resolveMode();
    this.setViewMode(res.mode, false);
  };

  // ?mode= > remembered (bench.mode, or the old bench.view migrated) > the source's default.
  Bench.prototype._resolveMode = function () {
    var param = null, stored = null, legacy = null;
    try { param = new URLSearchParams(global.location ? location.search : '').get('mode'); } catch (e) {}
    if (this.opts.mode) param = this.opts.mode;
    try { stored = localStorage.getItem('bench.mode'); legacy = localStorage.getItem('bench.view'); } catch (e) {}
    var res = lg().resolveMode({ param: param, stored: stored, legacy: legacy, source: this.source });
    if (res.migrate) { try { localStorage.setItem('bench.mode', res.migrate); localStorage.removeItem('bench.view'); } catch (e) {} }
    return res;
  };

  /* Two modes over the same map and events (SPEC section 4a). Presentation relabels and hides;
     Engineering shows everything. */
  Bench.prototype.setViewMode = function (v, remember) {
    this.mode = v === 'engineering' ? 'engineering' : 'presentation';
    if (remember) { try { localStorage.setItem('bench.mode', this.mode); } catch (e) {} }
    this.root.classList.toggle('mode-engineering', this.mode === 'engineering');
    this.root.classList.toggle('mode-presentation', this.mode === 'presentation');
    var self = this;
    this.root.querySelectorAll('.viewtoggle button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === self.mode); });
    if (this.opts.onmode) this.opts.onmode(this.mode);
    if (this.topo) { this._drawGraph(); this._buildPanels(); }
    this.render();
  };
  // Kept for callers of the 09-29 API: overview/detailed map onto the new modes.
  Bench.prototype.setView = function (v) { this.setViewMode(v === 'detailed' ? 'engineering' : v === 'overview' ? 'presentation' : v); };

  Bench.prototype.story = function () {
    return (this.topo && STORIES[this.topo.app.id]) || {};
  };

  Bench.prototype.renderEvent = function (ev, raw) {
    var mode = this.mode;
    var r = !raw && this.story().renderers && this.story().renderers[ev.event_type];
    if (r) { try { return r(ev, { h: lg().helpersFor(mode), mode: mode }); } catch (e) { /* fall through to the generic view */ } }
    return raw ? '<div class="row mono"><span class="tag">' + esc(ev.event_type) + '</span> ' + esc(ev.node) + '</div>' + flatKV(ev.data) : lg().renderGeneric(ev, { mode: mode });
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

  // Show everything received as already happened: no pacing (e.g. "skip to end", stepping back).
  Bench.prototype.skipPacing = function () {
    var self = this;
    Object.keys(this.runs).forEach(function (id) {
      var run = self.runs[id];
      run.stepOrder.forEach(function (sid) { var s = run.steps[sid]; s.arr = -1e12; if (s.arrEnd != null) s.arrEnd = -1e12; });
    });
    this.render();
  };

  // The status badge (live, playing, paused...). Sources call this.
  Bench.prototype.setStatus = function (text, cls) {
    this.f.mode.textContent = text;
    this.f.mode.className = 'badge ' + (cls || '');
  };

  /* Replay only: the presenter's controls. handlers: {back, play, pause, next, restart}.
     setTransportState: playing | paused | moment (Play stopped itself at a moment) | done. */
  Bench.prototype.setTransport = function (handlers) { this.transport = handlers; this.render(); };
  Bench.prototype.setTransportState = function (s) { this.tstate = s; if (s === 'playing' || s === 'restart') this.selectedNode = null; this.render(); };
  // The plain run picker: [{path, title, group}], the current path, and what to do on a pick.
  Bench.prototype.setPicker = function (items, current, onpick) { this.picker = { items: items || [], current: current, onpick: onpick }; this._renderPicker(); };
  // A paired recording (e.g. the same request, denied at the gate): {href, text}.
  Bench.prototype.setPair = function (pair) { this.pair = pair; this.render(); };

  Bench.prototype.setTopology = function (topo) {
    this.topo = topo;
    this.f.app.textContent = topo.app.name;
    this.f.inferred.hidden = this.p.inferred.hidden = this.f.download.hidden = !topo.inferred;
    // Beside a live app its own pane names it; elsewhere the room should know which app this is.
    this.p.appname.textContent = this.source === 'parent' ? '' : topo.app.name;
    this.p.appname.title = topo.app.description || '';
    this._drawGraph();
    this._buildPanels();
    this.render();
  };

  /* Level 0: no map was registered for this app. The bench draws one from the steps it sees
     (logic.inferMap) and redraws it whenever a step it hasn't seen arrives. */
  Bench.prototype.useInferredMap = function (appId, name) {
    this.inferred = { appId: appId, name: name || appId };
    this.setTopology(lg().inferMap([], appId, this.inferred.name));
  };
  Bench.prototype._refreshInferred = function () {
    var all = [], self = this;
    this.runOrder.forEach(function (id) { all = all.concat(self.runs[id].events); });
    this.setTopology(lg().inferMap(all, this.inferred.appId, this.inferred.name));
  };

  // Level 0 → 1: the inferred map as a file to edit and register (its ids are the wire's ids).
  Bench.prototype.downloadMap = function () {
    if (!this.topo) return;
    var t = JSON.parse(JSON.stringify(this.topo));
    delete t.inferred;
    t.app.description = '';
    t.nodes.forEach(function (n) { n.plain_label = n.plain_label || ''; n.description = n.description || ''; });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(t, null, 2) + '\n'], { type: 'application/json' }));
    a.download = (t.app.id || 'app') + '.topology.json';
    document.body.appendChild(a); a.click(); a.remove();
  };

  Bench.prototype.reset = function () {
    if (this._local && !this._localPush) this._endLocal(false);
    this.runs = {}; this.runOrder = []; this.current = null; this.pinned = false; this.render();
  };

  /* "Step through": a run that came from the app (beside it, or live) replayed here, paced like
     a recording, with the presenter's transport and its pauses at the moments that matter. Any
     new event from the app ends it, and the bench follows the app again. */
  Bench.prototype.stepThrough = function () {
    var run = this.current && this.runs[this.current], self = this, L = lg();
    if (!run || !global.BenchSources) return;
    var saved = [], ids = this.runOrder.slice(), keep = this.current;
    ids.forEach(function (id) { saved = saved.concat(self.runs[id].events); });
    var events = L.sortEvents(run.events);
    this._local = { saved: saved, current: keep, transport: this.transport };
    var src = new global.BenchSources.ReplaySource(this, events, {
      stops: L.cursorStops(events, this.topo),
      push: function (ev) { self._localPush = true; try { self.push(ev); } finally { self._localPush = false; } },
      reset: function () { self._localPush = true; try { self.reset(); } finally { self._localPush = false; } },
      onstate: function (st) { self.setTransportState(st); }
    });
    this._local.src = src;
    this.setTransport({ back: function () { src.back(); }, next: function () { src.next(); }, restart: function () { src.start(); },
                        play: function () { src.play(); }, pause: function () { src.pause(); },
                        speed: function () { src.speed = src.speed === 1 ? 2 : src.speed === 2 ? 0.5 : 1; self.speedNow = src.speed; self.render(); },
                        follow: function () { self._endLocal(true); } });
    this.speedNow = 1;
    src.start();
  };
  // Back to following the app: everything it had sent, then anything that arrived meanwhile.
  Bench.prototype._endLocal = function (render) {
    var loc = this._local;
    if (!loc) return;
    this._local = null;
    loc.src.playing = false; clearTimeout(loc.src.timer);
    this.transport = loc.transport; this.tstate = null; this.selectedNode = null;
    this.runs = {}; this.runOrder = []; this.current = null; this.pinned = false;
    var self = this;
    loc.saved.forEach(function (ev) { self.push(ev); });
    if (loc.current && this.runs[loc.current]) this.current = loc.current;
    this.setStatus(this.source === 'parent' ? '● Following the app' : '● Live', 'ok');
    this.skipPacing();
    if (render) this.render();
  };

  Bench.prototype.push = function (ev) {
    var L = lg();
    // While stepping through a past run, anything new from the app means: follow the app again.
    if (this._local && !this._localPush) { this._endLocal(false); }
    ev = L.normalizeEvent(ev);
    if (this.inferred && ev.node !== '_run') {
      var cn = L.canonicalNode(ev.node);
      if (cn !== ev.node) ev = Object.assign({}, ev, { node: cn });
    }
    var run = this.runs[ev.run_id];
    if (!run) {
      run = this.runs[ev.run_id] = L.newRun(ev.run_id);
      this.runOrder.push(ev.run_id);
      if (!this.pinned) { this.current = ev.run_id; this.ioPick = null; }
    }
    // Out of order (OTLP exports the root span last; a late run_started): re-sort and rebuild.
    if (L.needsResort(run, ev)) this.runs[ev.run_id] = L.rebuildRun(run, ev, wallNow());
    else L.reduce(run, ev, wallNow());
    // Redraw the inferred map for a step it hasn't seen, or when a step first shows what kind it is.
    if (this.inferred && ev.node !== '_run') {
      var known = L.nodeOf(this.topo, ev.node);
      if (!known || (known.kind === 'step' && /^(llm_call|retrieval|tool_call|gate_waiting|check_result)$/.test(ev.event_type))) this._refreshInferred();
    }
    this._schedule();
  };

  Bench.prototype._schedule = function () {
    var self = this;
    if (this._raf) return;
    this._raf = (global.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { self._raf = null; self.render(); });
  };

  Bench.prototype._graphEl = function () { return this.mode === 'presentation' ? this.p.graph : this.f.graph; };

  Bench.prototype._drawGraph = function () {
    var pres = this.mode === 'presentation', L = lg();
    var G = pres ? global.BenchLayout.PRES_GEOM : global.BenchLayout.GEOM;
    var Lay = this.layout = layout(this.topo, G), topo = this.topo, self = this;
    var g = this._graphEl(), other = pres ? this.f.graph : this.p.graph;
    other.innerHTML = '';
    var svg = '<svg class="edges" width="' + Lay.W + '" height="' + Lay.H + '" viewBox="0 0 ' + Lay.W + ' ' + Lay.H + '">' +
      '<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>';
    // Every edge comes routed from the layout: short ones curve through the gap between rows,
    // long ones run down a channel clear of every box (layout.js).
    topo.edges.forEach(function (e, i) {
      var r = Lay.edges[i];
      if (!r) return;
      var name = (pres && e.plain_label) || (e.from_branch || e.when || '').replace(/_/g, ' ');
      // A routed edge's label in Presentation is dropped: the source box's own "→ branch" line says it.
      if (pres && r.routed) name = '';
      svg += '<g class="edge' + (r.routed ? ' routed' : '') + '" data-edge="' + i + '"><path d="' + r.d + '" marker-end="url(#arr)"/>' +
        (pres && e.description ? '<path class="hit" d="' + r.d + '"/>' : '') +
        (name && r.label ? '<text x="' + r.label.x + '" y="' + r.label.y + '"' + (r.label.anchor === 'end' ? ' text-anchor="end"' : '') + '>' + esc(name) + '</text>' : '') + '</g>';
    });
    svg += '</svg>';
    var boxes = topo.nodes.map(function (n) {
      var p = Lay.pos[n.id];
      var style = 'left:' + p.x + 'px;top:' + p.y + 'px;width:' + G.w + 'px;height:' + G.h + 'px';
      if (pres) {
        var actor = L.actorOf(n);
        return '<div class="gnode pnode kind-' + esc(n.kind || 'step') + '" data-node="' + esc(n.id) + '" style="' + style + '" title="' + esc(L.plainLabel(n) + (n.description ? ': ' + n.description : '')) + '">' +
          '<span class="actor actor-' + esc(actor) + '">' + esc(ACTOR_CHIP[actor] || actor) + '</span>' +
          '<div class="gl">' + esc(L.plainLabel(n)) + '</div>' +
          (n.plain_label && n.label !== n.plain_label ? '<div class="gt mono">' + esc(n.label || n.id) + '</div>' : '<div class="gt mono">' + esc(n.id !== L.plainLabel(n) ? n.id : '') + '</div>') +
          '<div class="gp"></div></div>';
      }
      return '<div class="gnode kind-' + esc(n.kind || 'step') + '" data-node="' + esc(n.id) + '" style="' + style + '" title="' + esc((n.label || n.id) + (n.description ? ': ' + n.description : '')) + '">' +
        '<div class="gl">' + esc(n.label || n.id) + '</div><div class="gm mono"></div><div class="gp"></div></div>';
    }).join('');
    g.innerHTML = '<div class="graph" style="width:' + Lay.W + 'px;height:' + Lay.H + 'px">' + svg + boxes + '</div><div class="unmapped" data-f="unmapped"></div>';
    var gr = g.querySelector('.graph');
    // Shrink the whole flow to fit rather than scroll: by width always, and in Presentation by
    // height too, so the map, the NOW card and the rows share one screen.
    function fit() {
      var availW = g.clientWidth || Lay.W, k = Math.min(1, availW / Lay.W);
      var byH = pres && global.innerWidth > 560;
      if (byH) {
        var box = g.parentNode, availH = box.clientHeight - 6;
        if (availH > 60) k = Math.min(k, availH / Lay.H);
      }
      k = Math.max(k, 0.35);
      gr.style.transform = k < 1 ? 'scale(' + k + ')' : '';
      gr.style.transformOrigin = 'top left';
      gr.style.marginLeft = Math.max(0, (availW - Lay.W * k) / 2) + 'px';
      gr.style.marginBottom = k < 1 ? (-(1 - k) * Lay.H) + 'px' : '';
      self._fitK = k;
    }
    this._fit = fit;
    fit();
    if (!this._fitBound) { this._fitBound = true; global.addEventListener('resize', function () { if (self._fit) self._fit(); }); }
    this._unmapped = g.querySelector('.unmapped');
    g.querySelectorAll('.gnode').forEach(function (n) {
      n.onclick = function () { var id = n.getAttribute('data-node'); self.selectedNode = self.selectedNode === id ? null : id; self.ioPick = null; self.render(); };
    });
    if (pres) {
      // An edge's description on hover or tap: on a dashed edge, why it wasn't taken.
      var tip = this.p.tip, sec = g.parentNode;
      g.querySelectorAll('.edge').forEach(function (eg) {
        var ed = topo.edges[+eg.getAttribute('data-edge')];
        if (!ed.description) return;
        function show(ev) {
          var untaken = /untaken/.test(eg.getAttribute('class'));
          var taken = /\btaken\b/.test(eg.getAttribute('class'));
          tip.innerHTML = '<b>' + esc(untaken ? 'Not taken this time' : taken ? 'Taken' : 'Path') + (ed.plain_label || ed.from_branch ? ': ' + esc(ed.plain_label || ed.from_branch.replace(/_/g, ' ')) : '') + '</b> ' + esc(ed.description);
          tip.hidden = false;
          var rb = sec.getBoundingClientRect();
          var x = Math.min(Math.max(4, ev.clientX - rb.left + 10), Math.max(4, rb.width - 250));
          tip.style.left = x + 'px'; tip.style.top = (ev.clientY - rb.top + 12) + 'px';
        }
        eg.addEventListener('mouseenter', show);
        eg.addEventListener('mousemove', show);
        eg.addEventListener('mouseleave', function () { tip.hidden = true; });
        eg.addEventListener('click', function (ev) { ev.stopPropagation(); show(ev); });
      });
      sec.onclick = function (ev) { if (!ev.target.closest('.edge')) tip.hidden = true; };
    }
  };

  Bench.prototype._buildPanels = function () {
    var box = this.f.panels;
    box.innerHTML = '';
    this.panelEls = {};
    if (!this.topo) return;
    var panels = (this.topo.panels || []).slice();
    panels.unshift({ id: '_checks', title: 'Checks · how it was checked, with evidence', event_types: ['check_result'] });
    panels.unshift({ id: '_sources', title: 'Sources · could look at / given to the model / relied on', event_types: ['retrieval'] });
    panels.unshift({ id: '_io', title: 'Model I/O · exactly what the model was given, and what it returned', event_types: ['llm_call'] });
    panels.unshift({ id: '_node', title: 'Selected step', event_types: ['*'], mode: 'append' });
    panels.unshift({ id: '_run', title: 'This run', event_types: ['run_started', 'run_finished'] });
    var self = this;
    panels.forEach(function (p) {
      var custom = p.story || p.fields;
      var e = el('div', 'panel' + (p.story ? ' storied' : ''), '<div class="ptitle"><span>' + esc(p.title) + (p.audience && p.audience !== 'both' ? ' <span class="aud">' + esc(p.audience) + '</span>' : '') + '</span><span class="pright">' +
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
    var selKey = this.runOrder.map(function (id) { var r = self.runs[id]; return id + (r.input ? 1 : 0) + (r.status || ''); }).join('|');
    if (sel._key !== selKey) {
      sel._key = selKey;
      sel.innerHTML = this.runOrder.map(function (id, i) {
        var r = self.runs[id];
        // An OTLP run's label is its root span's name ("invoke_agent x", the same every run); its request tells runs apart.
        var lab = r.started && r.started.via === 'otlp' && r.input ? (typeof r.input === 'string' ? r.input : JSON.stringify(r.input)) : r.label;
        return '<option value="' + esc(id) + '">#' + (i + 1) + ' ' + esc(lab ? short(lab, 40) : id) + (r.status && r.status !== 'ok' ? ' · ' + esc(r.status) : '') + '</option>';
      }).join('');
    }
    if (this.current) sel.value = this.current;
    sel.style.display = this.runOrder.length ? '' : 'none';

    if (this.mode === 'presentation') { this._renderPres(run); return; }
    if (!run) {
      this.f.meters.textContent = 'waiting for events…';
      return;
    }
    var L = lg();
    // header meters
    this.f.content.textContent = L.contentModeWords(run.contentModes);
    this.f.content.className = 'badge';
    this.f.session.textContent = 'session ' + (run.session || '–');
    function m(v, label, title) { return '<span' + (title ? ' title="' + esc(title) + '"' : '') + '><b>' + v + '</b> ' + label + '</span>'; }
    var ci = L.costInfo(run.events);
    var cost = (run.cost.actual ? m(fmtUsd(run.cost.actual), 'cost, reported by the provider') : '') +
      (run.cost.estimated ? m(fmtUsd(run.cost.estimated), 'estimated cost', 'Priced by the app from a price table') : '') +
      (ci.unpriced.length ? m('cost unknown', '(no price for ' + esc(ci.unpriced.join(', ')) + ')', 'These model calls carry tokens but no cost_usd, and the bench has no price for them. Unknown, not free.') : '') ||
      (ci.calls ? m('$0', 'cost') : '');
    var st = run.status || (run.gate && run.gate.state === 'waiting' ? 'waiting' : 'running');
    var stTxt = { ok: '✓ finished', error: '✕ error', aborted: 'aborted', waiting: '⏸ waiting for approval', running: '● running' }[st] || st;
    var split = L.timeSplit(run.events), base = L.baselineOf(run.events);
    this.f.meters.innerHTML = cost +
      m(fmtNum(run.tok.input), 'tokens in', run.tok.cache_read ? fmtNum(run.tok.cache_read) + ' of them read from the cache' : '') +
      m(fmtNum(run.tok.output), 'tokens out') +
      m(run.llmCalls, 'model call' + (run.llmCalls === 1 ? '' : 's')) +
      m(fmtMs((run.t1 - run.t0) * 1000), 'total') +
      (split.gated ? m(fmtMs(split.work * 1000), 'work') + m(fmtMs(split.waiting * 1000), 'waiting for a person') : '') +
      (base ? m(esc(base), 'by hand (the app’s estimate)') : '') +
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

  /* What's shown right now, after pacing: the steps shown starting, by node; the node shown
     running; the node order (for lit edges); and whether the run is shown finished. */
  Bench.prototype._shown = function (run) {
    var now = wallNow(), shownEnd = schedule(run);
    var ran = {}, seq = [], openNode = null, lastNode = null, nest = {};
    // A nested step (a retrieval inside a tool call) lights once its parent is shown, with the
    // edge into it; it never becomes the NOW step or part of the run's order.
    function shownStep(s) { return s.vs <= now && (!s.parent || !run.steps[s.parent] || shownStep(run.steps[s.parent])); }
    run.stepOrder.forEach(function (sid) {
      var s = run.steps[sid];
      if (s.parent) {
        if (!shownStep(s)) return;
        ran[s.node] = (ran[s.node] || []).concat([s]);
        if (run.steps[s.parent]) nest[run.steps[s.parent].node + '>' + s.node] = true;
        return;
      }
      if (s.vs > now) return;
      ran[s.node] = (ran[s.node] || []).concat([s]);
      if (s.ve > now) openNode = s.node;
      lastNode = s.node;
      // A step the app reports as skipped was reached but did no work: it is not on the lit path.
      if (s.status !== 'skipped' && seq[seq.length - 1] !== s.node) seq.push(s.node);
    });
    // Events whose step isn't shown yet are held back too, so every panel agrees with the map.
    var hidden = {};
    run.stepOrder.forEach(function (sid) { var s = run.steps[sid]; if (!shownStep(s)) hidden[sid] = true; });
    var events = run.events.filter(function (e) { return !(e.step_id && hidden[e.step_id]); });
    var finished = !!run.status && now >= shownEnd;
    var caught = !Object.keys(hidden).length;   // every step received is on screen
    if (!finished) events = events.filter(function (e) { return e.event_type !== 'run_finished'; });
    return { now: now, shownEnd: shownEnd, ran: ran, seq: seq, nest: nest, openNode: openNode, lastNode: lastNode, finished: finished, caught: caught, events: events };
  };

  Bench.prototype._renderGraph = function (run) {
    var self = this, g = this._graphEl(), L = lg(), pres = this.mode === 'presentation';
    var S = this._shown(run), now = S.now, ran = S.ran, finished = S.finished;
    var nowId = this.selectedNode || S.openNode || S.lastNode;
    var taken = L.takenEdges(this.topo, S.events.filter(function (e) { return ran[e.node] || e.node === '_run'; }), S.seq);
    Object.keys(S.nest).forEach(function (k) { taken[k] = true; });
    var srcCount = {};
    if (pres) L.sourceStates(this.topo, S.events).forEach(function (s) { s.items.forEach(function (it) { srcCount[it.id] = s.count; }); });
    g.querySelectorAll('.gnode').forEach(function (n) {
      var id = n.getAttribute('data-node'), steps = ran[id] || [];
      var last = steps[steps.length - 1];
      var node = L.nodeOf(self.topo, id) || {};
      var cls = 'gnode ' + (pres ? 'pnode ' : '') + 'kind-' + (node.kind || 'step');
      var shownOpen = last && last.ve > now;
      if (!steps.length) cls += finished ? ' untaken' : ' idle';
      else if (last.status === 'error' && !shownOpen) cls += ' error';
      else if (steps.every(function (s) { return s.status === 'skipped'; })) cls += ' skipped';
      else if (run.gate && run.gate.node === id && run.gate.state === 'waiting' && !(run.status && finished)) cls += ' gatewait';
      else if (shownOpen) cls += ' active';
      else cls += ' done';
      if (self.selectedNode === id) cls += ' selected';
      if (pres && !self.selectedNode && nowId === id) cls += ' now';
      if (n.className !== cls) n.className = cls;
      var gm = n.querySelector('.gm');
      if (gm) {
        var m = '';
        if (steps.length) {
          var cost = 0, tokIn = 0, tokOut = 0;
          steps.forEach(function (s) { s.events.forEach(function (e) { if (e.event_type === 'llm_call') { cost += Number(e.data.cost_usd || 0); tokIn += e.data.input_tokens || 0; tokOut += e.data.output_tokens || 0; } }); });
          var ms;
          if (last.arrEnd == null) ms = now - last.arr;   // still running: a live timer
          else ms = steps.reduce(function (a, s) { return a + (s.latency != null ? s.latency : s.end != null ? (s.end - s.start) * 1000 : 0); }, 0);
          m = fmtMs(ms) + (last.arrEnd == null ? '…' : '') + (steps.length > 1 ? ' ×' + steps.length : '') + (tokIn ? ' · ' + fmtTok(tokIn) + '→' + fmtTok(tokOut) + ' tok' : '') + (cost ? ' · ' + fmtUsd(cost) : '');
        }
        gm.textContent = m;
      }
      var pv = '';
      if (!shownOpen) {
        var hitsCount = null;
        steps.forEach(function (s) { s.events.forEach(function (e) { if (e.event_type === 'retrieval' && e.data && e.data.hits && e.data.hits[0]) hitsCount = srcCount[e.data.hits[0].id]; }); });
        pv = L.preview(steps, self.mode, hitsCount, node.kind === 'check', self.topo);
      }
      n.querySelector('.gp').textContent = pv;
    });
    g.querySelectorAll('.edge').forEach(function (e) {
      var ed = self.topo.edges[+e.getAttribute('data-edge')];
      var k = ed.from + '>' + ed.to;
      var c = 'edge' + (taken[k] ? ' taken' + (S.openNode === ed.to ? ' flowing' : '') : finished ? ' untaken' : '') + (ed.description ? ' described' : '');
      if (e.getAttribute('class') !== c) e.setAttribute('class', c);
    });
    var unm = Object.keys(ran).filter(function (n) { return !L.nodeOf(self.topo, n); });
    if (this._unmapped) setHTML(this._unmapped, unm.length ? '<span class="muted">not in the manifest:</span> ' + unm.map(function (n) { return '<span class="tag">' + esc(n) + '</span>'; }).join(' ') : '');
    // Keep drawing while anything is shown running (live timers) or waiting to be shown.
    var busy = S.shownEnd > now || run.stepOrder.some(function (sid) { return run.steps[sid].arrEnd == null; });
    clearTimeout(this._tick);
    if (busy) this._tick = setTimeout(function () { self.render(); }, 100);
    return S;
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
        '" style="left:' + left + '%;width:' + w + '%"></span></span><span class="wv mono">' + fmtMs(ms) + (s.inferred ? '<i>~</i>' : '') + '</span></div>';
    }).join('');
    var anyInferred = run.stepOrder.some(function (sid) { return run.steps[sid].inferred; });
    setHTML(this.f.waterfall, html + (anyInferred ? '<div class="legend muted">~ = inferred from event times (the app sent no step_finished; see SPEC section 2)</div>' : ''));
  };

  Bench.prototype._storyCtx = function (run, evs, mode) {
    return { run: run, h: lg().helpersFor(mode), all: evs, mode: mode };
  };

  Bench.prototype._renderPanels = function (run) {
    var self = this, L = lg();
    Object.keys(this.panelEls).forEach(function (pid) {
      var P = self.panelEls[pid], spec = P.spec, evs;
      if (pid === '_node') {
        P.el.classList.toggle('empty', !self.selectedNode);
        if (!self.selectedNode) { P.body.innerHTML = '<span class="muted">Click any step in the flow to see what it did.</span>'; P.count.textContent = ''; return; }
        self._renderStep(P, run); return;
      }
      if (pid === '_sources') { self._renderSourcesEng(P, run); return; }
      if (pid === '_checks') { self._renderChecksEng(P, run); return; }
      evs = run.events.filter(function (e) {
        return spec.event_types.indexOf(e.event_type) >= 0 && (!spec.nodes || spec.nodes.indexOf(e.node) >= 0);
      });
      P.el.classList.toggle('empty', !evs.length);
      P.count.textContent = evs.length ? ' ' + evs.length : '';
      if (!evs.length) { P.body.innerHTML = '<span class="muted">–</span>'; return; }
      if (pid === '_io') { self._renderIO(P, run); return; }
      if (pid === '_run') {
        var st = evs.filter(function (e) { return e.event_type === 'run_started'; })[0];
        var fin = evs.filter(function (e) { return e.event_type === 'run_finished'; })[0];
        P.body.innerHTML = kv('run', run.id) + (st && st.data.origin ? kv('origin', st.data.origin) : '') +
          (fin ? kv('status', fin.data.status + (fin.data.outcome ? ' · ' + fin.data.outcome : '')) : '') +
          (fin && fin.data.baseline ? kv('baseline (the app says)', fin.data.baseline) : '') +
          (st && st.data.input ? '<div class="iolabel">Request</div><div class="note quote">' + esc(short(typeof st.data.input === 'string' ? st.data.input : JSON.stringify(st.data.input), 600)) + '</div>' : '') +
          (run.output ? '<div class="iolabel">Final output</div><div class="note quote out">' + esc(short(typeof run.output === 'string' ? run.output : JSON.stringify(run.output), 800)) + '</div>' : '');
        return;
      }
      var list = spec.mode === 'append' ? evs : evs.slice(-1);
      var story = self.story();
      if (!P.raw && spec.story && story.panels && story.panels[pid]) {
        try { P.body.innerHTML = story.panels[pid](list, self._storyCtx(run, evs, 'engineering')); return; }
        catch (err) { P.body.innerHTML = '<div class="err">story panel failed: ' + esc(err.message) + '</div>'; }
      }
      P.body.innerHTML = list.map(function (e) {
        if (!P.raw && spec.fields) return '<div class="pev">' + L.renderFields(e, spec.fields) + '</div>';
        return '<div class="pev">' + self.renderEvent(e, P.raw) + '</div>';
      }).join('');
    });
  };

  // Engineering's sources panel: the three states, plus each hit's scores.
  Bench.prototype._renderSourcesEng = function (P, run) {
    var L = lg(), states = L.sourceStates(this.topo, run.events);
    P.el.classList.toggle('empty', !states.length);
    P.count.textContent = '';
    if (!states.length) { P.body.innerHTML = '<span class="muted">no sources declared, nothing retrieved</span>'; return; }
    P.body.innerHTML = states.map(function (s) {
      return '<div class="srcblock"><div class="row"><b>' + esc(s.title) + '</b> <span class="tag">' + esc(s.kind) + '</span><span class="right">' + esc(s.line || 'not used this run') + '</span></div>' +
        (s.description ? '<div class="note">the app says: ' + esc(s.description) + '</div>' : '') +
        (s.items.length ? '<div class="tiles">' + s.items.map(function (it, i) { return tile(it, false, i, s.items); }).join('') + '</div>' : '') +
        s.items.filter(function (it) { return it.hit; }).map(function (it) {
          var h = it.hit, nums = Object.keys(h).filter(function (k) { return typeof h[k] === 'number'; }).map(function (k) { return k + ' ' + Number(h[k]).toFixed(k === 'bm25' ? 1 : 4); }).join(' · ');
          return '<div class="row mono"><span class="tag">' + esc(it.id) + '</span> ' + esc(it.state) + (it.relied ? ' · relied on' : '') + (it.hinted ? ' · app says given' : '') + '<span class="right">' + esc(nums) + '</span></div>';
        }).join('') + '</div>';
    }).join('');
  };
  Bench.prototype._renderChecksEng = function (P, run) {
    var L = lg(), rows = L.checkStates(this.topo, run.events, !!run.status);
    P.el.classList.toggle('empty', !rows.length);
    P.count.textContent = rows.length ? ' ' + rows.length : '';
    if (!rows.length) { P.body.innerHTML = '<span class="muted">no checks declared or reported</span>'; return; }
    P.body.innerHTML = rows.map(function (c) {
      return '<div class="pev"><div class="row"><span class="ck ck-' + esc(c.state) + '">' + esc(c.state.replace(/_/g, ' ')) + '</span> <b>' + esc(c.label) + '</b> <span class="tag">' + esc(c.id) + '</span></div>' +
        (c.detail ? '<div class="note">' + esc(c.detail) + '</div>' : '') + (c.evidence.length ? kv('evidence', c.evidence.join(', ')) : '') + '</div>';
    }).join('');
  };

  // A tile is labelled by the number its title starts with ("5. Software…"), else its position.
  /* A tile's face: the title's own number ("5. Software…" → 5); among numbered siblings an
     unnumbered item (e.g. a preamble) shows its initial instead of a position that would
     collide with a real number; otherwise its position. */
  function tile(it, sel, idx, items) {
    var NUM = /^\s*(\d+)/, own = String(it.title || it.id).match(NUM);
    var numbered = (items || []).some(function (x) { return NUM.test(String(x.title || '')); });
    var n = own || [null, numbered ? String(it.title || it.id).trim().charAt(0).toUpperCase() : idx != null ? idx + 1 : String(it.id).slice(0, 3)];
    return '<button class="tile st-' + esc(it.state) + (it.relied ? ' relied' : '') + (sel ? ' sel' : '') + '" data-item="' + esc(it.id) + '" title="' +
      esc((it.title || it.id) + ' · ' + ({ could: 'could look at, not read this run', found: 'found by the search', given: 'given to the AI', relied: 'relied on' }[it.state] || it.state) + (it.relied ? ' · its answer rests on this' : '')) + '">' +
      esc(n[1]) + '</button>';
  }

  // The Selected step panel: the step's own header (what its box shows), then its input and
  // output, then every event it reported.
  Bench.prototype._renderStep = function (P, run) {
    var self = this, id = this.selectedNode, L = lg();
    var node = L.nodeOf(this.topo, id) || { id: id };
    var steps = (run.nodeSteps[id] || []).map(function (sid) { return run.steps[sid]; }).filter(function (s) { return !s.parent; });
    var evs = run.events.filter(function (e) { return e.node === id; });
    P.count.textContent = '';
    if (!steps.length) {
      P.body.innerHTML = '<div class="stephead"><b>' + esc(node.label || id) + '</b></div>' + (node.description ? '<div class="note">' + esc(node.description) + '</div>' : '') +
        '<div class="note">' + (run.status ? 'This step didn’t run this time.' : 'Not reached yet.') + '</div>';
      return;
    }
    var ms = steps.reduce(function (a, s) { return a + (s.latency != null ? s.latency : s.end != null ? (s.end - s.start) * 1000 : 0); }, 0);
    var cost = 0, tin = 0, tout = 0, model = null;
    evs.forEach(function (e) { if (e.event_type === 'llm_call') { cost += Number(e.data.cost_usd || 0); tin += e.data.input_tokens || 0; tout += e.data.output_tokens || 0; model = e.data.model; } });
    var head = '<div class="stephead"><b>' + esc(node.label || id) + '</b>' + (node.plain_label ? ' <span class="muted">' + esc(node.plain_label) + '</span>' : '') +
      '<span class="tag">' + esc(node.kind || 'step') + ' · ' + esc(L.actorOf(node)) + '</span></div>' +
      (node.description ? '<div class="note">' + esc(node.description) + '</div>' : '') +
      '<div class="stepstats mono"><span><b>' + fmtMs(ms) + '</b> took</span>' + (steps.length > 1 ? '<span><b>' + steps.length + '</b> times</span>' : '') +
      (model ? '<span><b>' + esc(model) + '</b></span><span><b>' + fmtNum(tin) + '</b> tokens in</span><span><b>' + fmtNum(tout) + '</b> out</span>' : '') +
      (cost ? '<span><b>' + fmtUsd(cost) + '</b></span>' : '') + '</div>';
    var pv = L.preview(steps, 'engineering');
    if (pv) head += '<div class="stepresult">' + esc(pv) + '</div>';
    var io = '';
    evs.forEach(function (e) {
      if (e.event_type === 'step_started' && e.data && e.data.input != null) io += ioBlock('input', L.ioText(e.data.input));
      if (e.event_type === 'step_finished' && e.data && e.data.output != null) io += ioBlock('output', L.ioText(e.data.output), 'out');
    });
    if (model) io += '<div class="note">Its model call, word for word, is in <b>Model I/O</b> below.</div>';
    var raw = '<div class="iolabel">every event it reported</div>' + evs.map(function (e) { return '<div class="pev">' + self.renderEvent(e, true) + '</div>'; }).join('');
    P.body.innerHTML = head + io + raw;
  };

  function ioBlock(label, text, cls) {
    return '<div class="iolabel">' + esc(label) + ' <span class="muted">' + text.length.toLocaleString() + ' chars</span></div><pre class="io' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</pre>';
  }

  // The built-in Model I/O panel: the selected node's model call, or the run's latest.
  Bench.prototype._renderIO = function (P, run) {
    var self = this, L = lg();
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
        if (e.event_type === 'step_started' && e.data && e.data.input != null) io += ioBlock('step input', L.ioText(e.data.input));
        if (e.event_type === 'step_finished' && e.data && e.data.output != null) io += ioBlock('step output', L.ioText(e.data.output), 'out');
      }); });
      P.body.innerHTML = io || '<span class="muted">' + (self.selectedNode ? 'no model call on this node' : 'no model call yet') + '</span>';
      return;
    }
    var d = ev.data || {};
    var tabs = calls.length > 1 ? '<div class="iotabs">' + calls.map(function (c, i) {
      return '<button class="iotab' + (c === ev ? ' on' : '') + '" data-i="' + i + '">#' + (i + 1) + ' ' + esc(c.node) + '</button>';
    }).join('') + '</div>' : '';
    var head = '<div class="row mono"><span class="tag">' + esc(ev.node) + '</span> ' + esc(d.model) + '<span class="right">' + fmtTok(d.input_tokens) + ' in / ' +
      fmtTok(d.output_tokens) + ' out' + (d.cost_usd != null ? ' · ' + fmtUsd(d.cost_usd) : '') + (d.latency_ms != null ? ' · ' + fmtMs(d.latency_ms) : '') +
      (d.finish_reason ? ' · ' + esc(d.finish_reason) : '') + '</span></div>';
    var body = '';
    if (d.system != null) body += ioBlock('system', L.ioText(d.system));
    (d.messages || []).forEach(function (m, i) { body += ioBlock(m.role || 'message ' + (i + 1), L.ioText(m.content)); });
    if (d.output != null) body += ioBlock('output', L.ioText(d.output), 'out');
    if (!body) body = '<div class="note">' + (ev.content_mode === 'absent' ? 'Content wasn’t captured for this call (content_mode: absent).' : 'This app doesn\'t send its prompt and response to the bench yet: <span class="mono">llm_call.data.system / messages / output</span> (SPEC section 2).') + '</div>';
    if (ev.content_mode === 'redacted' && (d.system != null || d.messages || d.output != null)) body = '<div class="note">content: redacted (personal details masked in this record, before it reached the bench; the app decides what the model itself saw)</div>' + body;
    P.body.innerHTML = tabs + head + body;
    P.body.querySelectorAll('.iotab').forEach(function (b) { b.onclick = function () { self.ioPick = +b.getAttribute('data-i'); self.selectedNode = null; self.render(); }; });
  };

  Bench.prototype._renderLog = function (run) {
    var t0 = run.t0;
    this.f.logcount.textContent = run.events.length + ' events';
    setHTML(this.f.log, run.events.map(function (e) {
      return '<div class="lrow t-' + esc(e.event_type) + '"><span class="ls">' + (e.seq != null ? e.seq : '') + '</span><span class="lt">+' + fmtMs((e.ts - t0) * 1000) +
        '</span><span class="ln">' + esc(e.node) + '</span><span class="le">' + esc(e.event_type) + '</span><span class="ld">' + esc(short(e.data, 400)) + '</span></div>';
    }).join(''));
  };

  // ---- Presentation ----------------------------------------------------------------------
  Bench.prototype._renderPicker = function () {
    var box = this.p.picker, pk = this.picker, self = this;
    if (!box) return;
    if (!pk || pk.items.length < 2) { box.innerHTML = ''; return; }
    var groups = [], by = {};
    pk.items.forEach(function (it) { var g = it.group || ''; if (!by[g]) { by[g] = []; groups.push(g); } by[g].push(it); });
    box.innerHTML = '<label class="p-pick"><span>Try another request</span><select>' + groups.map(function (g) {
      var opts = by[g].map(function (it) { return '<option value="' + esc(it.path) + '"' + (it.path === pk.current ? ' selected' : '') + '>' + esc(it.title) + '</option>'; }).join('');
      return g ? '<optgroup label="' + esc(g) + '">' + opts + '</optgroup>' : opts;
    }).join('') + '</select></label>';
    box.querySelector('select').onchange = function (e) { if (pk.onpick) pk.onpick(e.target.value); };
  };

  Bench.prototype._presClick = function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act'), arg = t.getAttribute('data-arg');
    if (act === 'row') { this.presOpen[arg] = !this.presOpen[arg]; }
    else if (act === 'given') { this.overlay = { focus: arg || null }; }
    else if (act === 'close') { if (e.target === t || t.classList.contains('p-close')) this.overlay = null; else return; }
    else if (act === 'item') { this.presItem = this.presItem === arg ? null : arg; this.presOpen.looked = true; }
    else if (act === 'record') { this.presOpen.record = !this.presOpen.record; }
    else if (act === 'clearsel') { this.selectedNode = null; }
    else if (act === 'why') { this.whyOpen = !this.whyOpen; }
    else if (act === 'bigtext') { this.bigText = !this.bigText; }
    else if (act === 'stepthrough') { this.selectedNode = null; this.stepThrough(); return; }
    else if (this.transport && this.transport[act]) { this.selectedNode = null; this.transport[act](); return; }
    else return;
    this.render();
  };

  Bench.prototype._renderPres = function (run) {
    var L = lg(), self = this, topo = this.topo, p = this.p;
    this._renderPicker && !p.picker.firstChild && this._renderPicker();
    p.inferred.hidden = !topo.inferred;
    var S = run ? this._renderGraphPres(run) : null;
    var events = S ? S.events : [];
    var finished = S ? S.finished : false;
    // The replay can stop (a moment, a pause, the end) while pacing is still drawing the steps
    // before it; until the screen catches up it reads as still playing, so the Continue sits
    // on the step it belongs to.
    var tstate = this.tstate;
    if (S && (tstate === 'moment' || tstate === 'paused' || tstate === 'stepping') && !S.caught) tstate = tstate === 'stepping' ? 'stepping' : 'catching';
    if (tstate === 'stepping' && S && S.caught) tstate = 'paused';
    if (S && tstate === 'done' && !finished) tstate = 'catching';
    this._tstateShown = tstate;

    // Header: the request and who asked (dropped beside a live app, whose pane shows it), the outcome.
    var input = run && run.input != null ? (typeof run.input === 'string' ? run.input : JSON.stringify(run.input)) : (run && run.label) || '';
    setHTML(p.req, this.source === 'parent' ? '' : (input ? '<span title="' + esc(input) + '">“' + esc(input.replace(/\s+/g, ' ')) + '”</span>' : '<span class="muted">' + (run ? '' : 'Waiting for a request…') + '</span>'));
    p.req.hidden = this.source === 'parent' && true;
    setHTML(p.who, run ? esc(L.requesterOf(run.events)) : '');
    var oc = run ? L.outcome(topo, events) : { text: '', why: null, done: false };
    if (!oc.done && oc.text === 'Working…' && (tstate === 'paused' || tstate === 'moment' || tstate === 'stepping')) oc.text = 'Paused · ▶ to go on, ◂ ▸ to step';
    setHTML(p.outcome, oc.text ? '<span class="p-oc' + (oc.done ? ' done' : '') + '">' + (oc.done ? '▸ ' : '') + esc(oc.text) + '</span>' : '');
    // The reason is the strongest line on a hand-off; clamped to two lines, a click shows it whole.
    setHTML(p.why, oc.why ? '<span data-act="why" title="' + (this.whyOpen ? 'Show less' : 'Show it all') + '"><b>Why:</b> ' + esc(oc.why) + '</span>' : '');
    p.why.classList.toggle('full', !!this.whyOpen);
    setHTML(p.transport, this._transportHTML(finished, run, S));

    // NOW card: the selected step, else the step being shown, else (finished) the last one.
    var nowId = this.selectedNode || (S && (S.openNode || S.lastNode)) || null;
    this._nowNode = nowId;
    setHTML(p.now, this._nowHTML(run, events, nowId, finished, S));
    setHTML(p.rows, run ? this._rowsHTML(run, events, finished) : '');
    setHTML(p.bottom, run ? this._bottomHTML(run, events, finished) : '');
    if (this.overlay && run) {
      p.overlay.hidden = false; setHTML(p.overlay, this._overlayHTML(run, events));
      // Opened from a step: start at that step's call, not at the top of the run.
      if (this.overlay.focus && !this.overlay.scrolled) {
        var sec = p.overlay.querySelector('.g-call.focus');
        if (sec) { p.overlay.scrollTop = Math.max(0, sec.offsetTop - 60); this.overlay.scrolled = true; }
      }
    }
    else { p.overlay.hidden = true; }
    if (this._fit) this._fit();
  };

  Bench.prototype._renderGraphPres = function (run) {
    return this._renderGraph(run);
  };

  /* Replay: ◂ ▶ ▸ ⟲ (keys: ← → or PageUp/PageDown, Space). Beside the app or live, there is no
     transport, but a finished run (or one waiting for a person) can be stepped through here. */
  Bench.prototype._transportHTML = function (finished, run, S) {
    if (!this.transport) {
      var idle = run && S && S.caught && (finished || (run.gate && run.gate.state === 'waiting'));
      return idle && global.BenchSources ? '<button data-act="stepthrough" class="main" title="Replay this run here, one step at a time, pausing at the moments that matter (the app stays as it is)">▶ Step through it</button>' : '';
    }
    var s = this._tstateShown || this.tstate;
    var playing = s === 'playing';
    var catching = s === 'catching';
    var started = run && run.events.length > 0;
    return '<button data-act="back" title="Back one step (←)">◂</button>' +
      (playing ? '<button data-act="pause" class="main" title="Pause (Space)">❚❚ Pause</button>'
               : catching ? '<button class="main" disabled title="Finishing">❚❚ Playing</button>'
               : s === 'done' ? '<button data-act="restart" class="main" title="Play it again from the start">↻ Replay</button>'
               : '<button data-act="play" class="main" title="Play (Space); it pauses at the moments that matter">▶ ' + (started ? 'Continue' : 'Play') + '</button>') +
      '<button data-act="next" title="Forward one step (→)">▸</button>' +
      '<button data-act="restart" title="Start over">⟲</button>' +
      (this.transport.speed ? '<button data-act="speed" class="speed" title="Playing speed">' + (this.speedNow || 1) + '×</button>' : '') +
      (this.transport.follow ? '<button data-act="follow" title="Stop stepping through and follow the app again">' + (this.source === 'parent' ? '✕ Follow the app' : '✕ Back to live') + '</button>' : '');
  };

  Bench.prototype._nowHTML = function (run, events, id, finished, S) {
    var L = lg(), topo = this.topo, self = this;
    if (!run || !id) return '<div class="p-nowhead"><span class="p-label">Now</span></div><div class="p-line muted">' +
      (run ? 'Starting…' : this.source === 'parent' ? 'Nothing has run yet. Pick a request in the app, and this side shows what the AI does with it.' : 'Nothing has run yet.') + '</div>';
    var reply = run.output != null ? (typeof run.output === 'string' ? run.output : JSON.stringify(run.output)) : null;
    var n = L.narrate(topo, events, id, { finished: finished, reply: reply, last: S && S.lastNode });
    // The map box already carries the technical name; the card keeps to plain words.
    var head = '<div class="p-nowhead"><span class="p-label">' + (this.selectedNode ? 'Selected' : 'Now') + '</span><b>' + esc(n.title) + '</b>' +
      '<span class="actor actor-' + esc(n.actor) + '">' + esc(ACTOR_CHIP[n.actor] || n.actor) + '</span>' +
      (this.selectedNode ? '<button class="p-x" data-act="clearsel" title="Follow the run again">✕</button>' : '') + '</div>';
    var lines = n.lines.map(function (l) {
      if (l.kind === 'reply') return '<div class="p-line k-reply"><span class="p-replyt">What the person was told</span>' + esc(l.text) + '</div>';
      return '<div class="p-line k-' + esc(l.kind) + (l.cls ? ' c-' + esc(l.cls) : '') + '">' + esc(l.text) + '</div>';
    }).join('');
    // The app's own story panels for this step (audience both or presentation), in Presentation's voice.
    var panels = '';
    var story = this.story();
    (topo.panels || []).forEach(function (pn) {
      var aud = pn.audience || 'both';
      if (aud === 'engineering') return;
      if (!(pn.story || pn.fields || aud === 'presentation')) return;
      if (pn.nodes && pn.nodes.indexOf(id) < 0) return;
      var evs = events.filter(function (e) { return e.node === id && pn.event_types.indexOf(e.event_type) >= 0; });
      if (!evs.length) return;
      var list = pn.mode === 'append' ? evs : evs.slice(-1), html;
      try {
        if (pn.story && story.panels && story.panels[pn.id]) html = story.panels[pn.id](list, self._storyCtx(run, evs, 'presentation'));
        else if (pn.fields) html = list.map(function (e) { return L.renderFields(e, pn.fields); }).join('');
        else html = list.map(function (e) { return L.renderGeneric(e, { mode: 'presentation' }); }).join('');
      } catch (err) { html = '<div class="err">This step’s story panel failed: ' + esc(err.message) + '</div>'; }
      // Presentation's heading is the panel's plain_title; a panel without one shows no heading
      // here (its title is Engineering's name for it).
      if (html) panels += '<div class="p-story">' + (pn.plain_title ? '<div class="p-storyt">' + esc(pn.plain_title) + '</div>' : '') + html + '</div>';
    });
    var acts = '';
    // Only on a step where the AI was asked something, and only when the app sent the text.
    var calls = events.filter(function (e) { return e.event_type === 'llm_call' && e.node === id; });
    var hasText = calls.some(function (e) { var d = e.data || {}; return d.system != null || (d.messages || []).length || d.output != null; });
    if (this._tstateShown === 'moment' && this.transport) acts += '<button class="p-btn primary" data-act="play">Continue ▸</button>';
    if (hasText) acts += '<button class="p-btn" data-act="given" data-arg="' + esc(id) + '">What the AI was given ▸</button>';
    if (this.pair && n.kind === 'gate' && events.some(function (e) { return e.event_type === 'gate_resolved'; })) acts += '<a class="p-btn" href="' + esc(this.pair.href) + '">' + esc(this.pair.text) + '</a>';
    // The buttons sit above the body, so a long note never scrolls "Continue" out of reach.
    return head + (acts ? '<div class="p-acts">' + acts + '</div>' : '') + '<div class="p-nowbody">' + lines + panels + '</div>';
  };

  Bench.prototype._rowsHTML = function (run, events, finished) {
    var L = lg(), topo = this.topo, open = this.presOpen, self = this;
    function row(key, q, summary, body) {
      var on = !!open[key];
      return '<div class="p-row' + (on ? ' open' : '') + '"><button class="p-rowhead" data-act="row" data-arg="' + key + '" aria-expanded="' + on + '">' +
        '<span class="p-q">' + esc(q) + '</span><span class="p-sum">' + summary + '</span><span class="p-chev">' + (on ? '▾' : '▸') + '</span></button>' +
        (on ? '<div class="p-rowbody">' + body + '</div>' : '') + '</div>';
    }
    // What it looked at
    var srcs = L.sourceStates(topo, events);
    var srcBody = srcs.map(function (s) {
      var sel = s.items.filter(function (it) { return it.id === self.presItem; })[0];
      return '<div class="p-src"><div><b>' + esc(s.title) + '</b>' + (s.line ? ' <span class="muted">· ' + esc(s.line) + '</span>' : '') + '</div>' +
        (s.description ? '<div class="p-says">The app says: ' + esc(s.description) + '</div>' : '') +
        (s.items.length ? '<div class="tiles">' + s.items.map(function (it, i) { return tile(it, it.id === self.presItem, i, s.items).replace('<button', '<button data-act="item" data-arg="' + esc(it.id) + '"'); }).join('') + '</div>' : '') +
        (sel ? '<div class="p-item"><b>' + esc(sel.title) + '</b> ' + (sel.text ? '<span class="muted">' + esc(sel.state === 'given' ? '· given to the AI, word for word' : '· found by the search') + '</span><pre class="io">' + esc(sel.text) + '</pre>' : '<span class="muted">· not read this run</span>') + '</div>' : '') +
        '</div>';
    }).join('') + (srcs.some(function (s) { return s.items.length; }) ? '<div class="legend"><span class="tile st-could">·</span> could look at <span class="tile st-found">·</span> found by the search <span class="tile st-given">·</span> given to the AI <span class="tile st-given relied">·</span> its answer rests on it</div>' : '');
    var html = row('looked', 'What it looked at', esc(L.sourcesLine(srcs, finished)), srcBody || '<span class="muted">The app doesn’t say what it can see.</span>');
    // How it was checked
    var checks = L.checkStates(topo, events, finished);
    var ckSum = checks.length ? checks.map(function (c) { return '<span class="ck ck-' + esc(c.state) + '">' + esc({ passed: '✓', failed: '✕', not_on_path: '–', ran: '•', running: '…', pending: '·' }[c.state] || '') + ' ' + esc(c.label) + (c.state === 'not_on_path' ? ': not needed' : '') + '</span>'; }).join(' ')
      : '<span class="muted">No checks declared</span>';
    html += row('checked', 'How it was checked', ckSum, checks.map(function (c) {
      return '<div class="p-check"><b>' + esc(c.label) + '</b> <span class="c-' + esc(c.state) + '">' + esc(c.line) + '</span>' + (c.description ? '<div class="p-says">' + esc(c.description) + '</div>' : '') + '</div>';
    }).join('') || '<span class="muted">The app declares no checks.</span>');
    // Who signed off
    var g = L.gateState(topo, events, finished);
    var gBody = '<div>' + esc(g.line) + '</div>';
    if (g.proposed) gBody += '<div class="p-says">What they were shown: ' + esc(typeof g.proposed === 'object' ? (g.proposed.title || '') + (g.proposed.description ? ': ' + g.proposed.description : '') || JSON.stringify(g.proposed) : g.proposed) + '</div>';
    if (this.pair && (g.state === 'approved' || g.state === 'denied')) gBody += '<a class="p-btn" href="' + esc(this.pair.href) + '">' + esc(this.pair.text) + '</a>';
    html += row('signed', 'Who signed off', esc(g.line), gBody);
    // What it can never do
    var never = topo.never || [], actions = topo.actions || [];
    if (never.length || actions.length) {
      html += row('never', 'What it can never do', esc(never.length ? never.join(' · ') : 'The app doesn’t say'),
        (never.length ? '<div class="p-says">The app says it can never:</div><ul>' + never.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
        (actions.length ? '<div class="p-says">What it can do (the app says):</div><ul>' + actions.map(function (a) { return '<li><b>' + esc(a.title) + '</b>' + (a.description ? ': ' + esc(a.description) : '') + '</li>'; }).join('') + '</ul>' : ''));
    }
    return html;
  };

  Bench.prototype._bottomHTML = function (run, events, finished) {
    var L = lg(), topo = this.topo;
    var bits = [];
    // Live, an open gate keeps waiting by the wall clock; a replay's times are the recorded ones.
    var nowTs = null;
    if (this.source !== 'replay' && !this._local && !finished && run.gate && run.gate.state === 'waiting' && run.gate.seenAt != null)
      nowTs = run.gate.since + (wallNow() - run.gate.seenAt) / 1000;   // the app's own clock, run on by the wall
    // Mid-run the time is a running total, said as one ("So far: 2.3 s"), not a clipped "Took…".
    var split = events.length ? L.timeSplit(events, nowTs) : null;
    if (split) bits.push(esc(finished || split.gated ? L.timeLine(split) : 'So far: ' + L.timeLine(split).replace(/^Took /, '')));
    var cl = L.costLine(L.costInfo(events));
    if (cl) bits.push(esc(cl));
    var base = finished ? L.baselineOf(events) : null;
    if (base) bits.push('by hand: ' + esc(base) + ' <span class="muted">(the team’s estimate)</span>');
    var tr = topo.app && topo.app.track_record;
    var html = '<div class="p-bline">' + bits.join(' <span class="sep">·</span> ') +
      (tr ? ' <button class="p-link" data-act="record">How it’s been tested ' + (this.presOpen.record ? '▾' : '▸') + '</button>' : '') + '</div>';
    if (tr && this.presOpen.record) html += '<div class="p-record">The app says: ' + esc(tr) + '</div>';
    return html;
  };

  // "What the AI was given": the run's model calls, as plain blocks, with retrieved text marked.
  Bench.prototype._overlayHTML = function (run, events) {
    var L = lg(), calls = L.givenBlocks(this.topo, events), focus = this.overlay && this.overlay.focus;
    var note = L.privacyLine(this.topo, events);
    var anyHit = false;
    var body = calls.map(function (c) {
      var blocks = c.blocks.map(function (b) {
        if (b.role === 'form') {
          return '<div class="g-block g-form"><div class="g-role">' + esc(b.label) + '</div><div class="g-note">The app sent this with its request: the fields the AI\u2019s answer had to fill in, and what it was told each one means.</div>' +
            '<dl class="g-fields">' + b.fields.map(function (f) {
              return '<dt>' + esc(f.name.replace(/_/g, ' ')) + '</dt><dd>' + (f.description ? esc(f.description) : '<span class="muted">no description</span>') +
                (f.choices ? '<div class="muted">one of: ' + esc(f.choices.join(' · ')) + '</div>' : '') + '</dd>';
            }).join('') + '</dl></div>';
        }
        var segs = b.segments.map(function (sg) {
          if (!sg.hit) return esc(sg.text);
          anyHit = true;
          return '<span class="hlwrap"><span class="hltag">from ' + esc(sg.hit.source ? sg.hit.source + ': ' : '') + esc(sg.hit.title) + '</span><mark>' + esc(sg.text) + '</mark></span>';
        }).join('');
        // A one-object JSON answer reads as a filled-in form; its exact text stays one click away.
        if (b.answer) {
          return '<div class="g-block g-output"><div class="g-role">' + esc(b.label) + '</div><dl class="g-fields g-answer">' + b.answer.map(function (f) {
              return '<dt>' + esc(f.name.replace(/_/g, ' ')) + '</dt><dd>' + esc(f.value) + (/confidence/i.test(f.name) ? ' <span class="muted">(the AI\u2019s own estimate, not measured accuracy)</span>' : '') + '</dd>';
            }).join('') + '</dl><details class="g-raw"><summary>its exact text</summary><pre class="g-text">' + segs + '</pre></details></div>';
        }
        return '<div class="g-block g-' + esc(b.role || 'x') + '"><div class="g-role">' + esc(b.label) + '</div><pre class="g-text">' + segs + '</pre></div>';
      }).join('');
      return '<section class="g-call' + (focus && focus === c.node ? ' focus' : '') + '" data-node="' + esc(c.node) + '"><h4>Step: ' + esc(c.title) + '</h4>' + (blocks || '<div class="muted">The app didn\u2019t send this call\u2019s text.</div>') + '</section>';
    }).join('');
    return '<div class="g-panel' + (this.bigText ? ' big' : '') + '"><div class="g-head"><b>What the AI was given</b><span class="muted">every time the AI was asked something in this run, word for word as the app recorded it</span>' +
      '<button class="g-big" data-act="bigtext" title="Larger or smaller text">' + (this.bigText ? 'A\u2212 Smaller text' : 'A+ Larger text') + '</button>' +
      '<button class="p-close" data-act="close" title="Close (Esc)">\u2715 Close</button></div>' +
      (anyHit ? '<div class="g-note"><mark class="g-key">highlighted</mark> text was found by the search and pasted into the AI\u2019s prompt, word for word; the label above each says where it came from.</div>' : '') +
      (note ? '<div class="g-note">' + esc(note) + '</div>' : '') +
      '<div class="g-body">' + (body || '<div class="muted">The AI hasn\u2019t been asked anything yet.</div>') + '</div></div>';
  };

  global.Bench = Bench;
})(typeof window !== 'undefined' ? window : this);

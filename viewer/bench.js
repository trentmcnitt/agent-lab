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
    // Live: each run is drawn with the map it carried (SPEC 8.6), fetched once per hash.
    this.mapsBase = null;                        // set by useRunMaps(base); null = maps arrive with the events
    this.maps = {};                              // hash -> map | 'loading' | 'failed'
    this.mapHash = null;                         // the hash of the map on screen, when it came from a run
    this.storyNote = null;                       // why the run's story wasn't served (Engineering)
    this._storyKeys = {};
    this.transport = null;
    this.tstate = null;
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
    /* ONE bar on top in both modes: the app's name, the run's status (Presentation), "Try another",
       and the mode switch, always in the same place. (The switch used to be drawn twice, once in
       each mode's own header; Engineering's header wraps on a narrow window, so its copy dropped to
       the left of a second row while Presentation's stayed on the right.) */
    r.innerHTML =
      '<header class="topbar">' +
        '<span class="tb-app" data-p="appname"></span>' +
        '<span class="tb-status" data-p="status"></span>' +
        '<span class="tb-spacer"></span>' +
        '<span class="p-inferred" data-p="inferred" hidden>map inferred from the trace</span>' +
        '<span class="tb-pick" data-p="picker"></span>' + toggle +
      '</header>' +
      '<div class="eng">' +
      '<header class="bh">' +
        '<span class="app" data-f="app" hidden>bench</span>' +
        '<span class="badge" data-f="mode">–</span>' +
        '<span class="badge" data-f="content" title="Whether prompts and outputs are shown here exactly as sent, with personal details masked in this record (not necessarily for the model), or not captured at all. The app decides.">–</span>' +
        '<span class="badge" data-f="inferred" hidden title="No map was registered for this app, so the bench drew one from the steps it has seen.">map inferred from the trace</span>' +
        '<button class="badge dl" data-f="download" hidden title="Download this inferred map as a starting topology.json for Level 1: its node ids are the ones your spans produce. Add plain_label and description, then PUT it to /apps/<id>.">⤓ map as topology.json</button>' +
        '<span class="badge" data-f="session" title="Live, the bench follows only this session.">session –</span>' +
        '<select data-f="runs" title="Every run the bench has seen"></select>' +
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
        // Presentation (Build spec v3, the A+B hybrid): the map is the stage; ONE callout bubble,
        // joined to the step it explains by a wedge, says what happened there. A quiet footer.
        // Who asked and what, with the room to read it (the status, picker and switch are in the bar above).
        '<header class="ps-head"><div class="ps-ask"><span class="ps-who" data-p="who"></span><span class="ps-req" data-p="req"></span></div></header>' +
        '<div class="ps-stage" data-p="stage">' +
          '<svg class="ps-wedge" data-p="wedge" aria-hidden="true"></svg><svg class="ps-seam" data-p="seam" aria-hidden="true"></svg>' +
          '<section class="ps-map"><div class="graphwrap" data-p="graph"></div><div class="edgetip" data-p="tip" hidden></div></section>' +
          '<section class="ps-side" data-p="side"><div class="ps-bubble" data-p="bubble" aria-live="polite"></div></section>' +
        '</div>' +
        '<footer class="ps-foot"><div class="ps-facts" data-p="bottom"></div>' +
          '<div class="ps-ctl"><div class="p-transport" data-p="transport"></div>' +
            '<button class="ps-key" data-act="maponly" title="The map alone, for the whole-system view (M)"><kbd>M</kbd><span class="kl">Map</span></button>' +
            '<button class="ps-key" data-act="recap" title="The run in four answers (R)"><kbd>R</kbd><span class="kl">Recap</span></button>' +
            '<button class="ps-key ps-help" data-act="keys" title="The presenter\'s keys (?): → or PageDown next step, ← back" aria-label="Keys"><kbd>?</kbd><span class="kl">Keys</span></button></div></footer>' +
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
    this.root.querySelector('.pres').addEventListener('click', function (e) { self._presClick(e); });
    this.f.download.onclick = function () { self.downloadMap(); };
    document.addEventListener('keydown', function (e) { self._presKey(e); });
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
  /* The page's own replay controls (index.html's #controls) belong to Engineering: they sit under
     the shared bar, so the mode switch is the first row's in both modes. */
  Bench.prototype.mountControls = function (el) {
    var eng = this.root.querySelector('.eng');
    if (el && eng) eng.insertBefore(el, eng.firstChild);
  };
  // Kept for callers of the 09-29 API: overview/detailed map onto the new modes.
  Bench.prototype.setView = function (v) { this.setViewMode(v === 'detailed' ? 'engineering' : v === 'overview' ? 'presentation' : v); };

  Bench.prototype.story = function () {
    return (this.topo && STORIES[this.topo.app.id]) || {};
  };

  Bench.prototype.renderEvent = function (ev, raw) {
    var mode = this.mode;
    var r = !raw && this.story().renderers && this.story().renderers[ev.event_type];
    if (r) { try { return r(ev, { h: lg().helpersFor(mode), mode: mode, topo: this.topo }); } catch (e) { /* fall through to the generic view */ } }
    return raw ? '<div class="row mono"><span class="tag">' + esc(ev.event_type) + '</span> ' + esc(ev.node) + '</div>' + flatKV(ev.data) : lg().renderGeneric(ev, { mode: mode });
  };

  /* Loads an app's story: `source` is its script text (from a recording); else, for a map that
     names its story by hash (`story: {id, sha256}`, a library app), the bench serves the trusted
     file only when its hash matches (SPEC 8.6), and says why when it doesn't; else the bench
     serves what the app registered at <base>apps/<id>/story.js. */
  Bench.prototype.loadStory = function (appId, source, base, sha256) {
    var self = this;
    if (!this._storyListening) {
      this._storyListening = true;
      storyListeners.push(function (id) { if (self.topo && id === self.topo.app.id) { self._buildPanels(); self.render(); } });
    }
    function inject(text, src) {
      var s = document.createElement('script');
      if (src) s.src = src; else s.textContent = text;
      document.head.appendChild(s);
    }
    if (source) { inject(source); return; }
    var url = (base || '') + 'apps/' + encodeURIComponent(appId) + '/story.js';
    if (!sha256) { inject(null, url); return; }
    if (this._storyKeys[appId + '#' + sha256]) return;
    this._storyKeys[appId + '#' + sha256] = true;
    fetch(url + '?sha256=' + encodeURIComponent(sha256)).then(function (r) {
      // Served with a note (the bench's story dev mode): shown, and said in Engineering.
      var why = r.headers.get('X-Agent-Lab-Story');
      if (r.ok) return r.text().then(function (t) { self.storyNote = why ? { severity: 'info', message: why } : null; inject(t); });
      self.storyNote = { severity: 'warning', message: why || ('the bench did not serve the story (' + r.status + ')') };
      self.render();
    }).catch(function (e) { self.storyNote = { severity: 'warning', message: 'the story could not be fetched: ' + e.message }; self.render(); });
  };

  /* Live: draw each run with the map it carried. A run_started/run_updated names its map's hash;
     the bench serves the map at <base>maps/<hash>. Two code versions can be live at once: the run
     on screen picks the map. A run with no map hash keeps whatever map is on screen. */
  Bench.prototype.useRunMaps = function (base) { this.mapsBase = base || ''; this._followRunMap(); };
  Bench.prototype._followRunMap = function () {
    var run = this.current && this.runs[this.current], h = run && run.mapHash, self = this;
    if (this.mapsBase == null || !h || h === this.mapHash) return;
    var m = this.maps[h];
    if (m && typeof m === 'object') { this._applyRunMap(h, m); return; }
    if (m) return;                                   // loading, or failed once: keep the map on screen
    this.maps[h] = 'loading';
    fetch(this.mapsBase + 'maps/' + encodeURIComponent(h)).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function (map) {
      self.maps[h] = map;
      var cur = self.current && self.runs[self.current];
      if (cur && cur.mapHash === h) self._applyRunMap(h, map);
    }).catch(function () { self.maps[h] = 'failed'; });
  };
  Bench.prototype._applyRunMap = function (h, map) {
    this.mapHash = h;
    this.inferred = null;                            // a run that carries its map is never Level 0
    this.setTopology(map);
    if (map.story && typeof map.story === 'object' && map.story.sha256) this.loadStory(map.app.id, null, this.mapsBase, map.story.sha256);
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
    this.p.appname.hidden = !this.p.appname.textContent;
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

  Bench.prototype._drawGraph = function () {
    if (this.mode === 'presentation') { this.f.graph.innerHTML = ''; this._drawStage(); return; }
    var G = global.BenchLayout.GEOM;
    var Lay = this.layout = layout(this.topo, G), topo = this.topo, self = this;
    var g = this.f.graph;
    this.p.graph.innerHTML = '';
    var svg = '<svg class="edges" width="' + Lay.W + '" height="' + Lay.H + '" viewBox="0 0 ' + Lay.W + ' ' + Lay.H + '">' +
      '<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>';
    // Every edge comes routed from the layout: short ones curve through the gap between rows,
    // long ones run down a channel clear of every box (layout.js).
    topo.edges.forEach(function (e, i) {
      var r = Lay.edges[i];
      if (!r) return;
      var name = global.BenchLayout.edgeText(topo, r, false);   // parallel branches: one line, joined names
      svg += '<g class="edge' + (r.routed ? ' routed' : '') + '" data-edge="' + i + '"><path d="' + r.d + '" marker-end="url(#arr)"/>' +
        (name && r.label ? '<text x="' + r.label.x + '" y="' + r.label.y + '"' + (r.label.anchor === 'end' ? ' text-anchor="end"' : '') + '>' + esc(name) + '</text>' : '') + '</g>';
    });
    svg += '</svg>';
    var boxes = topo.nodes.map(function (n) {
      var p = Lay.pos[n.id];
      var style = 'left:' + p.x + 'px;top:' + p.y + 'px;width:' + G.w + 'px;height:' + G.h + 'px';
      return '<div class="gnode kind-' + esc(n.kind || 'step') + '" data-node="' + esc(n.id) + '" style="' + style + '" title="' + esc((n.label || n.id) + (n.description ? ': ' + n.description : '')) + '">' +
        '<div class="gl">' + esc(n.label || n.id) + '</div><div class="gm mono"></div><div class="gp"></div></div>';
    }).join('');
    g.innerHTML = '<div class="graph" style="width:' + Lay.W + 'px;height:' + Lay.H + 'px">' + svg + boxes + '</div><div class="unmapped" data-f="unmapped"></div>';
    var gr = g.querySelector('.graph');
    // Shrink the whole flow to fit the column's width rather than scroll.
    function fit() {
      var availW = g.clientWidth || Lay.W, k = Math.max(0.35, Math.min(1, availW / Lay.W));
      gr.style.transform = k < 1 ? 'scale(' + k + ')' : '';
      gr.style.transformOrigin = 'top left';
      gr.style.marginLeft = Math.max(0, (availW - Lay.W * k) / 2) + 'px';
      gr.style.marginBottom = k < 1 ? (-(1 - k) * Lay.H) + 'px' : '';
    }
    this._fit = fit;
    fit();
    this._bindResize();
    this._unmapped = g.querySelector('.unmapped');
    g.querySelectorAll('.gnode').forEach(function (n) {
      n.onclick = function () { var id = n.getAttribute('data-node'); self.selectedNode = self.selectedNode === id ? null : id; self.ioPick = null; self.render(); };
    });
  };
  Bench.prototype._bindResize = function () {
    var self = this;
    if (this._fitBound) return;
    this._fitBound = true;
    global.addEventListener('resize', function () {
      // Presentation picks its geometry from the stage's size: crossing a breakpoint redraws the map.
      if (self.mode === 'presentation' && self.topo && self._stageGeom !== self._pickStageGeom()) { self._drawStage(); self.render(); return; }
      if (self._fit) self._fit();
      if (self.mode === 'presentation') self._placeBubble();
    });
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
    panels.unshift({ id: '_mapchecks', title: 'Checks on this map · do the map’s words still match the code?', event_types: [] });
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
    this._followRunMap();
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
        // A run whose input is the app's state object: its request (the map's declared field, else a guess).
        var req = r.input && typeof r.input === 'object' ? lg().requestOf(r.events, self.topo).text : null;
        var lab = req || (r.started && r.started.via === 'otlp' && r.input ? (typeof r.input === 'string' ? r.input : JSON.stringify(r.input)) : r.label);
        return '<option value="' + esc(id) + '">#' + (i + 1) + ' ' + esc(lab ? short(lab, 40) : id) + (r.status && r.status !== 'ok' ? ' · ' + esc(r.status) : '') + '</option>';
      }).join('');
    }
    if (this.current) sel.value = this.current;
    sel.style.display = this.runOrder.length ? '' : 'none';

    if (this.mode === 'presentation') { this._renderPres(run); return; }
    // The bar's status pill is the same in both modes (Engineering reads it from every event it has).
    var oc0 = run ? lg().outcome(this.topo, run.events) : null;
    var st0 = !run ? { cls: 'idle', text: 'Waiting for a request' }
      : oc0.done ? { cls: /^Handed/.test(oc0.text) ? 'handed' : /^(Stopped|Something)/.test(oc0.text) ? 'bad' : 'ok', text: oc0.text === 'Finished' ? 'Finished' : 'Finished · ' + oc0.text }
      : /^Waiting/.test(oc0.text) ? { cls: 'waiting', text: 'Waiting for a person to approve' } : { cls: 'running', text: 'Running' };
    setHTML(this.p.status, '<span class="ps-pill st-' + st0.cls + '" title="' + esc(st0.text) + '"><i></i><b>' + esc(st0.text) + '</b></span>');
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
    var split = L.timeSplit(run.events), base = L.baselineOf(run.events, this.topo);
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
    var ran = {}, seq = [], openNode = null, lastNode = null, nest = {}, focusNode = null, starting = {};
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
      // The step Presentation's callout is about: the newest one that has shown something. A step
      // that has only started (the one a branch just chose) is "starting": it lights the path into
      // it, while the callout stays on the step that chose it.
      var said = s.events.some(function (e) { return e.event_type !== 'step_started'; }) || s.ve <= now;
      if (said) { focusNode = s.node; delete starting[s.node]; } else starting[s.node] = true;
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
    if (finished && lastNode) focusNode = lastNode;
    return { now: now, shownEnd: shownEnd, ran: ran, seq: seq, nest: nest, openNode: openNode, lastNode: lastNode, focusNode: focusNode || lastNode,
             starting: starting, finished: finished, caught: caught, events: events };
  };

  Bench.prototype._renderGraph = function (run) {
    var self = this, g = this.f.graph, L = lg();
    var S = this._shown(run), now = S.now, ran = S.ran, finished = S.finished;
    var taken = this._taken(S);
    g.querySelectorAll('.gnode').forEach(function (n) {
      var id = n.getAttribute('data-node'), steps = ran[id] || [];
      var last = steps[steps.length - 1];
      var node = L.nodeOf(self.topo, id) || {};
      var cls = 'gnode kind-' + (node.kind || 'step');
      var shownOpen = last && last.ve > now;
      if (!steps.length) cls += finished ? ' untaken' : ' idle';
      else if (last.status === 'error' && !shownOpen) cls += ' error';
      else if (steps.every(function (s) { return s.status === 'skipped'; })) cls += ' skipped';
      else if (run.gate && run.gate.node === id && run.gate.state === 'waiting' && !(run.status && finished)) cls += ' gatewait';
      else if (shownOpen) cls += ' active';
      else cls += ' done';
      if (self.selectedNode === id) cls += ' selected';
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
      n.querySelector('.gp').textContent = shownOpen ? '' : L.preview(steps, 'engineering', null, node.kind === 'check', self.topo);
    });
    g.querySelectorAll('.edge').forEach(function (e) {
      var i0 = +e.getAttribute('data-edge'), ed = self.topo.edges[i0], r = self.layout && self.layout.edges[i0];
      var k = ed.from + '>' + ed.to;
      var described = ((r && r.edges) || [i0]).some(function (j) { return self.topo.edges[j] && self.topo.edges[j].description; });
      var c = 'edge' + (taken[k] ? ' taken' + (S.openNode === ed.to ? ' flowing' : '') : finished ? ' untaken' : '') + (described ? ' described' : '');
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

  // The edges this run is shown to have taken (a nested step lights the edge into it).
  Bench.prototype._taken = function (S) {
    var ran = S.ran, taken = lg().takenEdges(this.topo, S.events.filter(function (e) { return ran[e.node] || e.node === '_run'; }), S.seq);
    Object.keys(S.nest).forEach(function (k) { taken[k] = true; });
    return taken;
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
    return { run: run, h: lg().helpersFor(mode), all: evs, mode: mode, topo: this.topo };
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
      if (pid === '_mapchecks') { self._renderMapChecks(P, run); return; }
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
  /* Verification (architecture A8): the app's own verify findings carried in the map, then what
     this run shows. Errors red, warnings amber, info plain. */
  Bench.prototype._renderMapChecks = function (P, run) {
    var rows = lg().mapChecks(this.topo, run.events);
    // A story the bench wouldn't serve (its file differs from the one this run was built with, or
    // isn't trusted) is a finding about this map too: the generic views render instead.
    if (this.storyNote) rows = [{ code: 'story', severity: this.storyNote.severity, message: this.storyNote.message, from: 'run' }].concat(rows);
    var bad = rows.filter(function (r) { return r.severity !== 'info'; }).length;
    P.el.classList.toggle('empty', !rows.length);
    P.count.textContent = bad ? ' ' + bad : '';
    if (!rows.length) {
      P.body.innerHTML = '<span class="muted">' + (this.topo.inferred ? 'The map is inferred from this trace: there are no hand-written words to check.'
        : 'No findings: every name the map’s words and this run’s events use is in the structure the code produced.') + '</span>';
      return;
    }
    P.body.innerHTML = rows.map(function (r) {
      return '<div class="mc mc-' + esc(r.severity) + '"><span class="tag">' + esc(r.code) + '</span> <b>' + esc(r.severity) + '</b>' +
        (r.node ? ' <span class="mono">' + esc(r.node) + (r.branch ? ' → ' + esc(r.branch) : '') + '</span>' : '') +
        ' <span class="muted">(' + (r.from === 'map' ? 'from the app’s verify' : 'from this run') + ')</span><div class="note">' + esc(r.message) + '</div></div>';
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

  // A tile's face is logic.tileFace: its title's number, else a word of its title, else its position.
  function tile(it, sel, idx, items) {
    var n = [null, lg().tileFace(it, idx, items)];
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

  // A badge too long for its box ends at a word, with "…" (the whole of it in the tooltip).
  function clipWords(s, max) {
    s = String(s || '');
    if (s.length <= max) return s;
    var cut = s.slice(0, max - 1), sp = cut.lastIndexOf(' ');
    return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '') + '…';
  }

  // A badge clipped (at a word, with "…") to the room its box has, measured at its own type.
  function fitBadge(s, b) {
    if (!s || !b || !_measure) return clipWords(s, 22);
    _measure.font = '600 ' + b.font + 'px -apple-system, BlinkMacSystemFont, sans-serif';
    if (_measure.measureText(s).width <= b.room) return s;
    for (var n = s.length - 1; n > 6; n--) { var c = clipWords(s, n); if (_measure.measureText(c).width <= b.room) return c; }
    return clipWords(s, 7);
  }

  // ---- Presentation: the stage ------------------------------------------------------------
  /* The map is the stage (layout.js at a presentation geometry), the run's path lit and numbered
     in run order, past steps keeping a one-line badge. ONE callout bubble beside it, joined to the
     step it explains by a filled wedge, says what happened there (logic.callout): a headline
     sentence from the map's own words, then that step's evidence. Keys: → Space PageDown next,
     ← PageUp back, M the map alone, R the recap (also the step after the last). All words come
     from the map and the events; nothing here knows any app. */
  var ACTOR_WORDS_P = { ai: 'The AI', rule: 'A rule', person: 'A person', app: 'The app' };
  var STAGE_BREAK = 600;   // map column width (px) below which the pane geometry is used

  /* The stage's box size for this map: one line of name when every name fits the box's width at
     the stage's type, else two (measured, so a long-named app gets taller boxes, never clipped
     names or a badge pressed against them). Box padding and type are index.html's .snode rules. */
  /* The box's type and spacing (index.html's .snode rules, in px): the name, the step number's disc
     before it, the footer's badge; padX/padY are the stripe, borders and padding. The box's height
     is built from these, so the name and footer always have the room they're drawn with. */
  var BOX_TYPE = {
    stage: { font: 22, badge: 21, line: 1.18, num: 30, padX: 6 + 18 + 14 + 1.5, padY: 8 + 8 + 3, gap: 8 },
    pane: { font: 18, badge: 16, line: 1.18, num: 26, padX: 5 + 12 + 10 + 1.5, padY: 8 + 8 + 3, gap: 8 }
  };
  var _measure = null;
  function boxGeom(topo, G, which) {
    var T = BOX_TYPE[which] || BOX_TYPE.stage, ctx;
    try { _measure = _measure || document.createElement('canvas').getContext('2d'); ctx = _measure; } catch (e) { ctx = null; }
    var lines = 1;
    if (ctx) {
      ctx.font = '600 ' + T.font + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      var room = G.w - T.padX - (T.num + 10) - 8;   // a margin: the page's text runs a little wider than the canvas's
      // Each name wrapped at its words, as the page will: the most lines any name takes.
      topo.nodes.forEach(function (n) {
        var ws = String(lg().plainLabel(n)).split(/\s+/), k = 1, cur = '';
        ws.forEach(function (w) {
          var t = cur ? cur + ' ' + w : w;
          if (cur && ctx.measureText(t).width > room) { k++; cur = w; } else cur = t;
        });
        lines = Math.max(lines, k);
      });
    }
    var out = {}; Object.keys(G).forEach(function (k) { out[k] = G[k]; });
    out.lines = lines;
    var nameH = Math.max(T.num, Math.min(lines, 2) * T.font * T.line);
    out.h = Math.ceil(T.padY + nameH + T.gap + T.badge * 1.45);
    return out;
  }

  Bench.prototype._pickStageGeom = function () {
    var side = this.p.side, stage = this.p.stage;
    var W = (stage && stage.clientWidth) || global.innerWidth || 1200;
    var mapW = this.mapOnly ? W : W - ((side && side.offsetWidth) || W * 0.5);
    if (global.innerWidth <= 640) mapW = W;   // stacked: the map gets the full width
    return mapW >= STAGE_BREAK ? 'stage' : 'pane';
  };

  Bench.prototype._drawStage = function () {
    var self = this, topo = this.topo, L = lg();
    this.root.classList.toggle('p-maponly', !!this.mapOnly);
    var which = this._stageGeom = this._pickStageGeom();
    this.root.classList.toggle('ps-pane', which === 'pane');
    var G = which === 'stage' ? global.BenchLayout.STAGE_GEOM : global.BenchLayout.PANE_GEOM;
    // Two box shapes: wide (names on one line, a shorter map) and narrow (names may take two lines,
    // a taller map). The one drawn larger in the room the map has wins: a short wide stage takes
    // wide boxes, a tall narrow pane beside an app takes narrow ones.
    var sec0 = this.p.graph.parentNode, aw = Math.max(1, sec0.clientWidth - 8), ahh = Math.max(1, sec0.clientHeight - 8);
    var best = null;
    [G, Object.assign({}, G, { w: Math.round(G.w * 0.8) })].forEach(function (cand) {
      var gc = boxGeom(topo, cand, which), lc = layout(topo, gc);
      var kc = Math.min(aw / lc.W, global.innerWidth > 640 && ahh > 80 ? ahh / lc.H : Infinity);
      // A shape whose names would run to three lines is out (unless no shape avoids it).
      var ok = gc.lines <= 2;
      if (!best || (ok && !best.ok) || (ok === best.ok && kc > best.k + 0.01)) best = { k: kc, g: gc, lay: lc, ok: ok };
    });
    G = best.g;
    // How many characters of badge fit beside the actor chip (in the pane the chip gives way to a
    // badge: the box's stripe still says who does the step).
    var T = BOX_TYPE[which] || BOX_TYPE.stage;
    this._badge = { room: G.w - T.padX - 3 * T.badge - 24, font: T.badge };
    var Lay = this.layout = best.lay, g = this.p.graph;
    // Arrowheads in px (not stroke widths, which made the lit path's heads fill the whole gap),
    // one per edge state so each head takes its line's colour.
    var ah = which === 'stage' ? 12 : 9;
    function head(id) {
      return '<marker id="' + id + '" class="' + id + '" viewBox="0 0 10 10" refX="9.6" refY="5" markerUnits="userSpaceOnUse" markerWidth="' + ah + '" markerHeight="' + ah + '" orient="auto">' +
        '<path d="M0.6,0.8 L9.6,5 L0.6,9.2 L2.8,5 z" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round"/></marker>';
    }
    var svg = '<svg class="edges" width="' + Lay.W + '" height="' + Lay.H + '" viewBox="0 0 ' + Lay.W + ' ' + Lay.H + '">' +
      '<defs>' + head('parr') + head('parr-t') + head('parr-u') + '</defs>';
    topo.edges.forEach(function (e, i) {
      var r = Lay.edges[i];
      if (!r) return;
      // No labels on the stage's edges: a branching step's badge names the path it took.
      svg += '<g class="edge' + (r.routed ? ' routed' : '') + '" data-edge="' + i + '"><path d="' + r.d + '" marker-end="url(#parr)"/>' +
        (r.edges.some(function (k) { return topo.edges[k].description; }) ? '<path class="hit" d="' + r.d + '"/>' : '') + '</g>';
    });
    svg += '</svg>';
    var boxes = topo.nodes.map(function (n) {
      var p = Lay.pos[n.id], actor = L.actorOf(n);
      return '<div class="gnode snode a-' + esc(actor) + ' kind-' + esc(n.kind || 'step') + '" data-node="' + esc(n.id) + '" style="left:' + p.x + 'px;top:' + p.y + 'px;width:' + G.w + 'px;height:' + G.h + 'px" title="' + esc(L.plainLabel(n) + (n.description ? ': ' + n.description : '')) + '">' +
        // The step's number in a disc before its name (its place kept while it has none, so every
        // name starts at the same x); under them, who does the step and (once it has run) one badge.
        '<div class="gl"><span class="s-num" hidden></span><span class="gt">' + esc(L.plainLabel(n)) + '</span></div>' +
        '<div class="s-foot"><span class="actor actor-' + esc(actor) + '">' + esc(ACTOR_CHIP[actor] || actor) + '</span><span class="gp" hidden></span></div></div>';
    }).join('');
    g.innerHTML = '<div class="graph" style="width:' + Lay.W + 'px;height:' + Lay.H + 'px">' + svg + boxes + '</div>';
    var gr = g.querySelector('.graph'), sec = g.parentNode;
    // Fit the whole map in its column, by width and height (stacked on a phone: by width only).
    function fit() {
      var availW = sec.clientWidth - 8 || Lay.W, availH = sec.clientHeight - 8;
      // The map alone (M) has the whole stage: it grows into it, up to half again its size.
      var k = Math.min(self.mapOnly ? 1.5 : 1, availW / Lay.W);
      if (global.innerWidth > 640 && availH > 80) k = Math.min(k, availH / Lay.H);
      k = Math.max(k, 0.3);
      self._fitK = k;
      gr.style.transform = k !== 1 ? 'scale(' + k + ')' : '';
      gr.style.transformOrigin = 'top left';
      var padX = Math.max(0, (availW - Lay.W * k) / 2), padY = global.innerWidth > 640 ? Math.max(0, (availH - Lay.H * k) / 2) : 0;
      gr.style.marginLeft = padX + 'px';
      gr.style.marginTop = padY + 'px';
      gr.style.marginBottom = k !== 1 ? (-(1 - k) * Lay.H) + 'px' : '';
    }
    this._fit = fit;
    fit();
    this._bindResize();
    g.querySelectorAll('.gnode').forEach(function (n) {
      n.onclick = function () { var id = n.getAttribute('data-node'); self.selectedNode = self.selectedNode === id ? null : id; self.recapOpen = false; self.presItem = null; self.render(); };
    });
    // A path's own words on hover or tap: on a dashed path, why it wasn't taken.
    var tip = this.p.tip;
    g.querySelectorAll('.edge').forEach(function (eg) {
      var i0 = +eg.getAttribute('data-edge'), r = Lay.edges[i0];
      // A line may draw several parallel branches: each one's words.
      var eds = ((r && r.edges) || [i0]).map(function (k) { return topo.edges[k]; }).filter(function (x) { return x.description; });
      if (!eds.length) return;
      function show(ev) {
        var cls = eg.getAttribute('class');
        var state = /untaken/.test(cls) ? 'Not taken this time' : /\btaken\b/.test(cls) ? 'Taken' : 'Path';
        tip.innerHTML = eds.map(function (ed, j) {
          return '<b>' + esc(j ? 'Or' : state) + (ed.plain_label || ed.from_branch ? ': ' + esc(ed.plain_label || ed.from_branch.replace(/_/g, ' ')) : '') + '</b> ' + esc(ed.description);
        }).join('<br>');
        tip.hidden = false;
        var rb = sec.getBoundingClientRect();
        tip.style.left = Math.min(Math.max(4, ev.clientX - rb.left + 10), Math.max(4, rb.width - 300)) + 'px';
        tip.style.top = (ev.clientY - rb.top + 12) + 'px';
      }
      eg.addEventListener('mouseenter', show);
      eg.addEventListener('mousemove', show);
      eg.addEventListener('mouseleave', function () { tip.hidden = true; });
      eg.addEventListener('click', function (ev) { ev.stopPropagation(); show(ev); });
    });
    sec.onclick = function (ev) { if (!ev.target.closest('.edge')) tip.hidden = true; };
  };

  // The map's state for what's shown: lit path, numbers in run order, badges on past steps.
  Bench.prototype._renderStage = function (run) {
    var self = this, g = this.p.graph, L = lg(), topo = this.topo;
    var S = this._shown(run), now = S.now, ran = S.ran, finished = S.finished;
    var taken = this._taken(S), nums = L.stepNumbers(S.seq);
    var focus = this.recapOpen ? null : (this.selectedNode || S.focusNode);
    var counts = {};
    L.sourceStates(topo, S.events).forEach(function (s) { s.items.forEach(function (it) { counts[it.id] = s.count; }); });
    g.querySelectorAll('.gnode').forEach(function (n) {
      var id = n.getAttribute('data-node'), steps = ran[id] || [], last = steps[steps.length - 1];
      var node = L.nodeOf(topo, id) || {};
      var actor = L.actorOf(node, S.events);
      var cls = 'gnode snode a-' + actor + ' kind-' + (node.kind || 'step');
      var shownOpen = last && last.ve > now;
      if (!steps.length) cls += finished ? ' untaken' : ' idle';
      else if (last.status === 'error' && !shownOpen) cls += ' error';
      else if (steps.every(function (s) { return s.status === 'skipped'; })) cls += ' skipped';
      else if (run.gate && run.gate.node === id && run.gate.state === 'waiting' && !(run.status && finished)) cls += ' gatewait';
      else if (S.starting[id]) cls += ' starting';
      else if (shownOpen) cls += ' active';
      else cls += ' done';
      if (focus === id) cls += ' focus';
      if (self.selectedNode === id) cls += ' selected';
      if (n.className !== cls) n.className = cls;
      // An unworded step's actor is read from the run (it called the AI: the AI's), so its chip follows.
      var chip = n.querySelector('.actor'), cw = ACTOR_CHIP[actor] || actor;
      if (chip && chip.textContent !== cw) { chip.textContent = cw; chip.className = 'actor actor-' + actor; }
      var num = n.querySelector('.s-num');
      var nv = nums[id] ? String(nums[id]) : '';
      if (num.textContent !== nv) num.textContent = nv;
      num.hidden = !nv;
      // A past step keeps one badge: the path it took, or its verdict, or what it found.
      var badge = '';
      if (steps.length && focus !== id && !S.starting[id]) badge = L.stepBadge(topo, S.events, id, steps, counts);
      // Finished: every box the run didn't reach says so, so none reads as still to come.
      else if (!steps.length && finished) badge = '– not needed';
      // The badge's room: its box's footer, less the actor chip beside it, less the badge's own
      // padding. Where the whole badge won't fit beside the chip, the chip shrinks to its actor's
      // dot (the word in its tooltip), so the badge is never cut while there's any way to fit it.
      var gp = n.querySelector('.gp'), foot = gp.parentNode;
      var fw = foot.clientWidth;
      chip.classList.remove('mini'); chip.title = '';
      var chipW = chip.offsetWidth + 10, bf = self._badge ? self._badge.font : 14;
      if (badge && fw && _measure) {
        _measure.font = '600 ' + bf + 'px -apple-system, BlinkMacSystemFont, sans-serif';
        if (_measure.measureText(badge).width > fw - chipW - 24) { chip.classList.add('mini'); chip.title = ACTOR_WORDS_P[actor] || actor; chipW = chip.offsetWidth + 8; }
      }
      var shown = fitBadge(badge, self._badge && fw ? { font: bf, room: fw - chipW - 24 } : self._badge);
      if (gp.textContent !== shown) { gp.textContent = shown; gp.title = shown === badge ? '' : badge; }
      gp.hidden = !badge;
      gp.parentNode.classList.toggle('has-badge', !!badge);
    });
    g.querySelectorAll('.edge').forEach(function (e) {
      var i0 = +e.getAttribute('data-edge'), ed = topo.edges[i0], r = self.layout && self.layout.edges[i0];
      var k = ed.from + '>' + ed.to;
      var described = ((r && r.edges) || [i0]).some(function (j) { return topo.edges[j] && topo.edges[j].description; });
      var c = 'edge' + (taken[k] ? ' taken' + (S.openNode === ed.to ? ' flowing' : '') : finished ? ' untaken' : '') + (described ? ' described' : '');
      if (e.getAttribute('class') !== c) e.setAttribute('class', c);
    });
    // The lit path is drawn over the lines it shares a trunk with (SVG paints in document order).
    var svgE = g.querySelector('svg.edges');
    if (svgE) {
      var es = [].slice.call(svgE.querySelectorAll('.edge'));
      var want = es.slice().sort(function (a, b) {
        var ta = /\btaken\b/.test(a.getAttribute('class')) ? 1 : 0, tb = /\btaken\b/.test(b.getAttribute('class')) ? 1 : 0;
        return ta - tb || a.getAttribute('data-edge') - b.getAttribute('data-edge');
      });
      if (want.some(function (e, i) { return e !== es[i]; })) want.forEach(function (e) { svgE.appendChild(e); });
    }
    var busy = S.shownEnd > now || run.stepOrder.some(function (sid) { return run.steps[sid].arrEnd == null; });
    clearTimeout(this._tick);
    if (busy) this._tick = setTimeout(function () { self.render(); }, 100);
    S.focus = focus;
    S.numbers = nums;
    return S;
  };

  Bench.prototype._renderPicker = function () {
    var box = this.p.picker, pk = this.picker;
    if (!box) return;
    if (!pk || pk.items.length < 2) { box.innerHTML = ''; return; }
    var groups = [], by = {};
    pk.items.forEach(function (it) { var g = it.group || ''; if (!by[g]) { by[g] = []; groups.push(g); } by[g].push(it); });
    box.innerHTML = '<label class="p-pick"><span>Try another</span><select>' + groups.map(function (g) {
      var opts = by[g].map(function (it) { return '<option value="' + esc(it.path) + '"' + (it.path === pk.current ? ' selected' : '') + '>' + esc(it.title) + '</option>'; }).join('');
      return g ? '<optgroup label="' + esc(g) + '">' + opts + '</optgroup>' : opts;
    }).join('') + '</select></label>';
    box.querySelector('select').onchange = function (e) { if (pk.onpick) pk.onpick(e.target.value); };
  };

  Bench.prototype._presClick = function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || !this.root.contains(t)) return;
    var act = t.getAttribute('data-act'), arg = t.getAttribute('data-arg');
    if (act === 'given') { this.overlay = { focus: arg || null }; }
    else if (act === 'close') { if (e.target === t || t.classList.contains('p-close')) this.overlay = null; else return; }
    else if (act === 'item') { this.presItem = this.presItem === arg ? null : arg; }
    else if (act === 'clearsel') { this.selectedNode = null; }
    else if (act === 'more') { this.moreOpen = !this.moreOpen; }
    else if (act === 'bigtext') { this.bigText = !this.bigText; }
    else if (act === 'maponly') { this.toggleMapOnly(); return; }
    else if (act === 'recap') { this.recapOpen = !this.recapOpen; this.selectedNode = null; }
    else if (act === 'keys') { this.keysOpen = !this.keysOpen; }
    else if (act === 'stepthrough') { this.selectedNode = null; this.recapOpen = false; this.stepThrough(); return; }
    else if (this.transport && this.transport[act]) { this.selectedNode = null; this.recapOpen = false; this.presItem = null; this.transport[act](); return; }
    else return;
    this.render();
  };

  Bench.prototype.toggleMapOnly = function () {
    this.mapOnly = !this.mapOnly;
    if (this.topo) { this._drawStage(); this.render(); }
  };
  Bench.prototype.openRecap = function (on) { this.recapOpen = on !== false; this.selectedNode = null; this.render(); };

  /* A presenter's keys, and a clicker's (it sends PageUp/PageDown): → Space PageDown go forward one
     step (and from the last step to the recap), ← PageUp go back (out of the recap first), Home the
     first step, End the end, M shows the map alone, R the recap, ? the keys, Esc closes what's
     open. In the recap, the forward and back keys (and ↓ ↑) scroll it first when it's taller than
     the screen, so the whole recap can be shown from a clicker. */
  var KEYS_HELP = [['→  Space  PageDown', 'next step (from the last: the recap)'], ['←  PageUp', 'back one step'],
                   ['Home', 'the first step'], ['End', 'the end'], ['R', 'the recap: the run in four answers'], ['M', 'the map alone'],
                   ['?', 'these keys'], ['Esc', 'close what’s open']];
  Bench.prototype._presKey = function (e) {
    if (e.key === 'Escape') {
      if (this.keysOpen) this.keysOpen = false;
      else if (this.overlay) this.overlay = null;
      else if (this.recapOpen) this.recapOpen = false;
      else if (this.selectedNode) this.selectedNode = null;
      else return;
      this.render();
      return;
    }
    if (this.mode !== 'presentation' || this.overlay || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
    var k = e.key;
    if (k === '?') { e.preventDefault(); this.keysOpen = !this.keysOpen; this.render(); return; }
    if (k === 'm' || k === 'M') { e.preventDefault(); this.toggleMapOnly(); return; }
    if (k === 'r' || k === 'R') { e.preventDefault(); this.openRecap(!this.recapOpen); return; }
    var fwd = k === 'ArrowRight' || k === 'PageDown' || k === ' ', back = k === 'ArrowLeft' || k === 'PageUp';
    var down = k === 'ArrowDown', up = k === 'ArrowUp';
    if (this.recapOpen && (fwd || back || down || up)) {
      var b = this.p.bubble, room = b.scrollHeight - b.clientHeight;
      var by = (down || up) ? 80 : Math.max(80, b.clientHeight * 0.8);
      if ((fwd || down) && b.scrollTop < room - 1) { e.preventDefault(); b.scrollTop = Math.min(room, b.scrollTop + by); return; }
      if ((back || up) && b.scrollTop > 0) { e.preventDefault(); b.scrollTop = Math.max(0, b.scrollTop - by); return; }
      if (down || up) { e.preventDefault(); return; }
    }
    if (this.keysOpen) { this.keysOpen = false; this.render(); }
    if (k === 'Home' || k === 'End') {
      e.preventDefault();
      this.presItem = null; this.selectedNode = null; this.recapOpen = false;
      var go = this.transport && this.transport[k === 'Home' ? 'first' : 'end'];
      if (go) go(); else this.render();
      return;
    }
    if (!fwd && !back) return;
    e.preventDefault();
    this.presItem = null;
    if (back && this.recapOpen) { this.openRecap(false); return; }
    if (this.selectedNode) { this.selectedNode = null; this.render(); return; }
    var atEnd = this.tstate === 'done' || (!this.transport && this._lastShown && this._lastShown.finished);
    if (fwd && atEnd) { if (!this.recapOpen) this.openRecap(true); return; }
    if (!this.transport) return;
    this.transport[fwd ? 'next' : 'back']();
  };

  Bench.prototype._renderPres = function (run) {
    var L = lg(), self = this, topo = this.topo, p = this.p;
    if (!p.picker.firstChild) this._renderPicker();
    p.inferred.hidden = !topo.inferred;
    var S = run ? this._renderStage(run) : null;
    this._lastShown = S;
    var events = S ? S.events : [];
    var finished = S ? S.finished : false;
    // The replay can stop (a moment, a pause, the end) while pacing is still drawing the steps
    // before it; until the screen catches up it reads as still playing.
    var tstate = this.tstate;
    if (S && (tstate === 'moment' || tstate === 'paused' || tstate === 'stepping') && !S.caught) tstate = tstate === 'stepping' ? 'stepping' : 'catching';
    if (tstate === 'stepping' && S && S.caught) tstate = 'paused';
    if (S && tstate === 'done' && !finished) tstate = 'catching';
    this._tstateShown = tstate;

    // Header: who asked and what (beside a live app its own pane shows them), and where it stands.
    var req = run ? L.requestOf(run.events, topo) : { text: null, who: '' };
    var beside = this.source === 'parent';
    // The whole request, always: a trick hidden at its end is the point of some runs. A long one
    // is set smaller rather than cut.
    var rlen = req.text ? req.text.length : 0;
    p.req.className = 'ps-req' + (rlen > 320 ? ' r-xlong' : rlen > 170 ? ' r-long' : '');
    setHTML(p.req, beside ? '' : req.text ? '<span>“' + esc(req.text.replace(/\s+/g, ' ')) + '”</span>' : '<span class="muted">' + (run ? '' : 'Waiting for a request…') + '</span>');
    setHTML(p.who, beside ? '' : esc(req.who));
    var oc = run ? L.outcome(topo, events) : { text: '', done: false };
    var st = !run ? { cls: 'idle', text: 'Waiting for a request' }
      : oc.done ? { cls: /^Handed/.test(oc.text) ? 'handed' : /^(Stopped|Something)/.test(oc.text) ? 'bad' : 'ok', text: oc.text === 'Finished' ? 'Finished' : 'Finished · ' + oc.text }
      : /^Waiting/.test(oc.text) ? { cls: 'waiting', text: 'Waiting for a person to approve' }
      : (tstate === 'paused' || tstate === 'moment' || tstate === 'stepping') ? { cls: 'paused', text: 'Paused' + (S && S.focusNode && S.numbers && S.numbers[S.focusNode] ? ' at step ' + S.numbers[S.focusNode] : '') }
      : { cls: 'running', text: oc.text === 'Something went wrong' ? oc.text : 'Running' };
    setHTML(p.status, '<span class="ps-pill st-' + st.cls + '" title="' + esc(st.text) + '"><i></i><b>' + esc(st.text) + '</b></span>');
    setHTML(p.transport, this._transportHTML(finished, run, S));
    setHTML(p.bottom, run ? this._bottomHTML(run, events, finished) : '');
    this.root.querySelectorAll('.ps-key').forEach(function (b) {
      var on = b.getAttribute('data-act') === 'maponly' ? !!self.mapOnly : !!self.recapOpen;
      b.classList.toggle('on', on);
    });

    // The callout (or the recap): the selected step, else the step the run is on.
    var html;
    if (!run) html = '<div class="bb bb-empty"><p class="bb-headline">' + (beside ? 'Nothing has run yet. Pick a request in the app, and this side shows what the AI does with it.' : 'Nothing has run yet.') + '</p></div>';
    else if (this.recapOpen) html = this._recapHTML(run, events, finished, S);
    else html = S.focus ? this._bubbleHTML(run, events, S.focus, finished, S) : '<div class="bb bb-empty"><p class="bb-headline">Starting…</p></div>';
    if (this.keysOpen) html = '<div class="bb ps-keys"><div class="bb-head"><span class="bb-name">Keys</span><button class="p-x" data-act="keys" title="Close (Esc)">✕</button></div>' +
      '<dl class="bb-fields">' + KEYS_HELP.map(function (x) { return '<dt><kbd>' + esc(x[0]) + '</kbd></dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl></div>';
    setHTML(p.bubble, html);
    p.bubble.classList.toggle('is-recap', !!(run && this.recapOpen));
    if (this.overlay && run) {
      p.overlay.hidden = false; setHTML(p.overlay, this._overlayHTML(run, events));
      if (this.overlay.focus && !this.overlay.scrolled) {
        var sec = p.overlay.querySelector('.g-call.focus');
        if (sec) { p.overlay.scrollTop = Math.max(0, sec.offsetTop - 60); this.overlay.scrolled = true; }
      }
    } else p.overlay.hidden = true;
    if (this._fit) this._fit();
    this._placeBubble();
  };

  /* Moves the bubble down its column toward the step it explains, and draws the wedge between
     them. The wedge sits under the map's boxes (z-order), so it can pass behind a box in its way. */
  Bench.prototype._placeBubble = function () {
    var p = this.p, wedge = p.wedge, seam = p.seam, bub = p.bubble, stage = p.stage;
    var focusEl = this.recapOpen || this.mapOnly ? null : p.graph.querySelector('.gnode.focus');
    var stacked = global.innerWidth <= 640;
    if (!focusEl || stacked || !bub.firstChild) { wedge.innerHTML = seam.innerHTML = ''; wedge._h = seam._h = null; bub.style.marginTop = bub.style.maxHeight = ''; return; }
    var sr = stage.getBoundingClientRect(), side = p.side, sideR = side.getBoundingClientRect();
    var nr = focusEl.getBoundingClientRect();
    var ny = nr.top + nr.height / 2 - sideR.top;
    var sideH = side.clientHeight, bh = Math.min(sideH, bub.scrollHeight + 2), room = sideH - bh;
    // Center the bubble's wedge end on the step when there's room; never past the column.
    var top = Math.max(0, Math.min(room, ny - Math.min(140, bh / 2)));
    var cur = parseFloat(bub.style.marginTop) || 0;
    if (Math.abs(cur - top) > 1) bub.style.marginTop = top + 'px';
    bub.style.maxHeight = (sideH - top) + 'px';
    // From where the bubble is going, not where its slide (a CSS transition) happens to be now.
    var bLeft = sideR.left - sr.left, bTop = sideR.top - sr.top + top;
    var x1 = nr.right - sr.left - 2, y1 = nr.top + nr.height / 2 - sr.top;
    var hw = Math.min(16, nr.height / 3);
    var x2 = bLeft + 2;
    var lo = bTop + 28, hi = bTop + bh - 28;
    var yc = Math.max(lo, Math.min(hi, y1)), hw2 = Math.min(34, Math.max(12, (hi - lo) / 2));
    if (x2 - x1 < 8) { wedge.innerHTML = seam.innerHTML = ''; wedge._h = seam._h = null; return; }
    wedge.setAttribute('width', sr.width); wedge.setAttribute('height', sr.height);
    var pts = [[x1, y1 - hw], [x2, yc - hw2], [x2, yc + hw2], [x1, y1 + hw]].map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); });
    var html = '<polygon class="w-fill" points="' + pts.join(' ') + '"/>' +
      '<polyline class="w-edge" points="' + pts[0] + ' ' + pts[1] + '"/><polyline class="w-edge" points="' + pts[3] + ' ' + pts[2] + '"/>';
    var actor = (focusEl.className.match(/\ba-(\w+)/) || [])[1] || 'app';
    wedge.setAttribute('class', 'ps-wedge a-' + actor);
    seam.setAttribute('class', 'ps-seam a-' + actor);
    if (wedge._h !== html) { wedge._h = html; wedge.innerHTML = html; }
    // The seam: the wedge's last few pixels drawn over the bubble's border, so the two read as one
    // shape while the rest of the wedge stays under the map's boxes.
    var sx = x2 - 10, t = (sx - x1) / (x2 - x1);
    var ya = (y1 - hw) + t * ((yc - hw2) - (y1 - hw)), yb = (y1 + hw) + t * ((yc + hw2) - (y1 + hw));
    var sp = [[sx, ya], [x2 + 3, yc - hw2], [x2 + 3, yc + hw2], [sx, yb]].map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); });
    var shtml = '<polygon class="w-fill" points="' + sp.join(' ') + '"/><polyline class="w-edge" points="' + sp[0] + ' ' + sp[1] + '"/><polyline class="w-edge" points="' + sp[3] + ' ' + sp[2] + '"/>';
    seam.setAttribute('width', sr.width); seam.setAttribute('height', sr.height);
    if (seam._h !== shtml) { seam._h = shtml; seam.innerHTML = shtml; }
  };

  /* Replay: ◂ ▶ ▸ ⟲ (keys: ← → or PageUp/PageDown, Space = next). Beside the app or live, there
     is no transport, but a finished run (or one waiting for a person) can be stepped through here. */
  // One icon set for the transport (stroked, the text's colour, sized by the button's type).
  function svgI(d) { return '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><path d="' + d + '"/></svg>'; }
  var ICON = { back: svgI('M12.5 4.5 7 10l5.5 5.5'), next: svgI('M7.5 4.5 13 10l-5.5 5.5'), restart: svgI('M4.5 4.5v4.5H9M4.9 8.8A6 6 0 1 1 4.6 12') };
  Bench.prototype._transportHTML = function (finished, run, S) {
    if (!this.transport) {
      var idle = run && S && S.caught && (finished || (run.gate && run.gate.state === 'waiting'));
      return idle && global.BenchSources ? '<button data-act="stepthrough" class="main" title="Replay this run here, one step at a time, pausing at the moments that matter (the app stays as it is)">▶ Step through it</button>' : '';
    }
    var s = this._tstateShown || this.tstate;
    var playing = s === 'playing', catching = s === 'catching';
    var started = run && run.events.length > 0;
    return '<button data-act="back" class="ico" title="Back one step (← or PageUp)" aria-label="Back one step">' + ICON.back + '</button>' +
      (playing ? '<button data-act="pause" class="main" title="Pause">❚❚ Pause</button>'
               : catching ? '<button class="main" disabled title="Finishing">❚❚ Playing</button>'
               : s === 'done' ? '<button data-act="restart" class="main" title="Play it again from the start">' + ICON.restart + ' Replay</button>'
               : '<button data-act="play" class="main" title="Play; it pauses at the moments that matter">▶ ' + (started ? 'Continue' : 'Play') + '</button>') +
      '<button data-act="next" class="ico" title="Forward one step (→, Space or PageDown)" aria-label="Forward one step">' + ICON.next + '</button>' +
      '<button data-act="restart" class="ico" title="Start over from the first step" aria-label="Start over">' + ICON.restart + '</button>' +
      (this.transport.speed ? '<button data-act="speed" class="speed" title="Playing speed">' + (this.speedNow || 1) + '×</button>' : '') +
      (this.transport.follow ? '<button data-act="follow" title="Stop stepping through and follow the app again">' + (this.source === 'parent' ? '✕ Follow the app' : '✕ Back to live') + '</button>' : '');
  };

  // ---- the callout -------------------------------------------------------------------------
  var STATUS_TAG = { now: 'Now', done: 'Done', waiting: 'Waiting', last: 'Last step', not_needed: 'Not needed', pending: 'Not yet', error: 'Error' };
  function para(h) {
    return h.map(function (x) { return x.em ? '<em>' + esc(x.t) + '</em>' : esc(x.t); }).join('');
  }
  function sec(label, body, cls) { return '<section class="bb-sec' + (cls ? ' ' + cls : '') + '"><h4>' + esc(label) + '</h4>' + body + '</section>'; }
  function chip(title, cls) { return '<span class="bb-chip' + (cls ? ' ' + cls : '') + '">' + esc(title) + '</span>'; }
  // A long text (an answer, a description) folds after a few lines; "more" opens it.
  function foldText(text, open, cls) {
    var long = String(text).length > 260;
    return '<div class="bb-text' + (cls ? ' ' + cls : '') + (long && !open ? ' folded' : '') + '">' + esc(text) + '</div>' +
      (long ? '<button class="bb-more" data-act="more">' + (open ? 'less ▴' : 'more ▾') + '</button>' : '');
  }
  var CHECK_SYM_P = { passed: '✓', failed: '✕', not_on_path: '–' };

  // The evidence for one source, the same for every app: counts, then its items as tiles.
  Bench.prototype._sourceHTML = function (s) {
    var self = this;
    var nums = '<div class="bb-counts">' +
      (s.count != null ? '<span><b>' + lg().fmtNum(s.count) + '</b> available</span><i>→</i>' : '') +
      (!s.asked ? '<span class="c-given"><b>' + s.found + '</b> found <span class="unk">(the AI hasn’t been asked anything yet)</span></span>'
        : s.givenKnown ? '<span class="c-given"><b>' + s.given + '</b> given to the AI</span>' : '<span class="c-given"><b>' + s.found + '</b> found <span class="unk">(whether the AI was given them isn’t recorded)</span></span>') +
      (s.asked ? '<i>→</i><span class="c-relied"><b>' + s.relied + '</b> relied on</span>' : '') + '</div>';
    var compact = s.items.length > 24;
    var tiles = '<div class="bb-tiles' + (compact ? ' compact' : '') + '">' + s.items.map(function (it, i) {
      var face = lg().tileFace(it, i, s.items);
      return '<button class="bb-tile st-' + esc(it.state) + (it.relied ? ' relied' : '') + (self.presItem === it.id ? ' sel' : '') + '" data-act="item" data-arg="' + esc(it.id) + '" title="' + esc(it.title) + '">' +
        '<span class="t-face">' + esc(face) + '</span><span class="t-title">' + esc(it.title) + '</span>' + (it.rank ? '<span class="t-rank">#' + it.rank + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    var ranked = s.items.some(function (it) { return it.rank; });
    var legend = '<div class="bb-legend"><span><i class="lg st-could"></i>available</span>' +
      (s.items.some(function (it) { return it.state === 'found'; }) ? '<span><i class="lg st-found"></i>found by the search</span>' : '') +
      '<span><i class="lg st-given"></i>given to the AI</span><span><i class="lg relied"></i>relied on</span>' +
      (ranked && !compact ? '<span class="lg-r"><b class="lg-rank">#1</b>the search’s best match</span>' : '') + '</div>';
    var sel = s.items.filter(function (it) { return it.id === self.presItem; })[0];
    var item = sel ? '<div class="b-item"><b>' + esc(sel.title) + '</b> <span class="muted">' + esc(sel.text ? (sel.state === 'given' ? '· given to the AI, word for word' : '· found by the search') : '· not read this run') + '</span>' +
      (sel.text ? '<pre class="io">' + esc(sel.text) + '</pre>' : '') + '</div>' : '';
    return sec(s.title, nums + tiles + legend + item, 'bb-source');
  };

  Bench.prototype._bubbleHTML = function (run, events, id, finished, S) {
    var L = lg(), topo = this.topo, self = this;
    var reply = L.replyOf(run.output, topo);
    var c = L.callout(topo, events, id, { finished: finished, last: S.lastNode, numbers: S.numbers, reply: reply });
    var tag = this.selectedNode ? 'Selected' : STATUS_TAG[c.status] || '';
    var head = '<div class="bb-head">' + (c.n ? '<span class="bb-num">' + c.n + '</span>' : '') +
      '<span class="bb-name">' + esc(c.title) + '</span>' +
      '<span class="bb-who">' + esc(ACTOR_WORDS_P[c.actor] || c.actor) + '</span>' +
      (tag ? '<span class="bb-tag t-' + esc(this.selectedNode ? 'selected' : c.status) + '">' + esc(tag) + '</span>' : '') +
      (this.selectedNode ? '<button class="p-x" data-act="clearsel" title="Follow the run again (Esc)">✕</button>' : '') + '</div>';
    var acts = '';
    if (this._tstateShown === 'moment' && this.transport && !this.selectedNode) acts += '<button class="p-btn primary" data-act="play">Continue ▸</button>';
    var calls = events.filter(function (e) { return e.event_type === 'llm_call' && e.node === id; });
    if (calls.some(function (e) { var d = e.data || {}; return d.system != null || (d.messages || []).length || d.output != null; }))
      acts += '<button class="p-btn" data-act="given" data-arg="' + esc(id) + '">What the AI was given ▸</button>';
    if (this.pair && c.proposal && c.proposal.state !== 'waiting') acts += '<a class="p-btn" href="' + esc(this.pair.href) + '">' + esc(this.pair.text) + '</a>';
    var body = '<p class="bb-headline">' + para(c.headline) + '</p>' + (c.sub ? '<p class="bb-sub">' + esc(c.sub) + '</p>' : '');
    var evidence = 0;
    // A sign-off's ways out are its "Next, if …" lines under the proposal, not cards.
    if (c.choices.length && c.ran && !c.proposal) {
      evidence++;
      body += sec(c.choices.some(function (x) { return x.chosen; }) ? 'Its choice' : 'The paths it can take', '<div class="bb-cards">' + c.choices.map(function (x) {
        return '<div class="bb-card' + (x.chosen ? ' chosen' : x.chosen === false ? ' not' : '') + '" title="' + esc(x.description) + '">' + (x.chosen ? '<span class="bb-chosen">Chosen</span>' : '') +
          '<b>' + esc(x.label) + '</b><span>→ ' + esc(x.toLabel) + '</span></div>';
      }).join('') + '</div>');
    }
    if (c.reason) {
      evidence++;
      body += sec('Its reason, word for word', '<blockquote class="bb-quote">' + foldText(c.reason.text, this.moreOpen) + '</blockquote>' +
        (c.reason.cited.length ? '<div class="bb-chips"><span class="muted">It relied on</span> ' + c.reason.cited.map(function (x) { return chip(x.title, 'cited'); }).join(' ') + '</div>' : ''));
    }
    if (c.given.length) body += '<div class="bb-given">' + c.given.map(function (g) {
      return 'It was given <b>' + g.n + (g.of != null ? ' of ' + g.of : '') + '</b> from ' + esc(g.title) + '.';
    }).join(' ') + '</div>';
    if (c.sources.length) { evidence++; c.sources.forEach(function (s) { body += self._sourceHTML(s); }); }
    if (c.proposal) {
      evidence++;
      var pr = c.proposal;
      var card = '<div class="bb-proposal' + (pr.state === 'waiting' ? ' waiting' : '') + '">' + (pr.kicker ? '<div class="bb-kicker">' + esc(pr.kicker) + '</div>' : '') +
        (pr.title ? '<div class="bb-ptitle">' + esc(pr.title) + '</div>' : '') +
        (pr.fields.length ? '<dl class="bb-fields">' + pr.fields.map(function (f) { return '<dt>' + esc(f.name) + '</dt><dd>' + esc(f.value) + '</dd>'; }).join('') + '</dl>' : '') +
        (pr.description ? foldText(pr.description, this.moreOpen, 'bb-pdesc') : '') + '</div>';
      var lead = pr.state === 'waiting' ? 'What a person is asked to approve' : pr.state === 'approved' ? 'What a person approved' : 'What a person turned down';
      var foot = pr.state === 'waiting' ? '<div class="bb-inapp"><b>Approve</b> / <b>Deny</b> is pressed in the app, not here.</div>' +
        (c.ifNext.length ? '<div class="bb-next">' + c.ifNext.map(function (x) { return '<div><span>Next, if ' + (x.label ? '“' + esc(x.label) + '”' : 'it goes ahead') + ':</span> ' + esc(x.to) + '</div>'; }).join('') + '</div>' : '')
        : (pr.by ? '<div class="bb-inapp">' + (pr.state === 'approved' ? '✓ Approved by ' : '✕ Not approved by ') + esc(pr.by) + (pr.at ? ', ' + esc(L.clock(pr.at)) : '') + '.</div>' : '');
      body += sec(lead, card + foot);
    }
    if (c.checks.length) {
      evidence++;
      body += sec(c.kind === 'check' ? 'The verdict' : 'Checked at this step', c.checks.map(function (k) {
        return '<div class="bb-check c-' + esc(k.state) + '"><span class="bb-sym">' + (CHECK_SYM_P[k.state] || '•') + '</span><div><b>' + esc(k.label) + ':</b> ' + esc(k.word) +
          (k.detail ? ' <span class="muted">' + esc(k.detail) + '</span>' : '') +
          (k.evidence.length ? '<div class="bb-chips"><span class="muted">Its evidence</span> ' + k.evidence.map(function (x) { return chip(x.title, 'cited'); }).join(' ') + '</div>' : '') + '</div></div>';
      }).join(''));
    }
    if (c.did) { evidence++; body += sec('What it did', '<div class="bb-did">' + esc(c.did.what) + (c.did.title ? ': <b>' + esc(c.did.title) + '</b>' : '') + (c.did.ref ? ' <span class="bb-chip">' + esc(c.did.ref) + '</span>' : '') + '</div>'); }
    if (c.wrote) {
      evidence++;
      body += sec('What it wrote', c.wrote.fields ? '<dl class="bb-fields">' + c.wrote.fields.map(function (f) { return '<dt>' + esc(f.name) + '</dt><dd>' + esc(f.value) + '</dd>'; }).join('') + '</dl>'
                                                 : foldText(c.wrote.text, this.moreOpen));
    }
    if (c.reply) { evidence++; body += sec('What the person was told', '<blockquote class="bb-quote reply">' + foldText(c.reply, this.moreOpen) + '</blockquote>'); }
    if (c.why) body += sec('Why, in the AI’s words' + (c.why.atStep ? ' (at step ' + c.why.atStep + ')' : ''), '<blockquote class="bb-quote">' + foldText(c.why.text, this.moreOpen) + '</blockquote>');
    // The step's own description: always at a sign-off (who may sign), else when nothing else shows.
    if (c.about && (c.kind === 'gate' || !evidence)) body += sec(c.about.label, '<p class="bb-about">' + esc(c.about.text) + '</p>', 'bb-aboutsec');
    body += this._storyHTML(run, events, id);
    return '<div class="bb a-' + esc(c.actor) + ' s-' + esc(c.status) + '">' + head + (acts ? '<div class="p-acts">' + acts + '</div>' : '') + '<div class="bb-body">' + body + '</div></div>';
  };

  /* The app's own story panels for this step (audience both or presentation), under their
     plain_title: Trent's outlet for a bespoke view or added color. Additive: the generic
     evidence above always shows. */
  Bench.prototype._storyHTML = function (run, events, id) {
    var L = lg(), topo = this.topo, story = this.story(), self = this, out = '';
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
      if (html) out += '<section class="bb-sec bb-story">' + (pn.plain_title ? '<h4>' + esc(pn.plain_title) + '</h4>' : '') + '<div class="bb-storybody">' + html + '</div></section>';
    });
    return out;
  };

  // ---- the recap: the run in four answers ----------------------------------------------------
  Bench.prototype._recapHTML = function (run, events, finished, S) {
    var L = lg(), topo = this.topo, self = this;
    var rc = L.recap(topo, events, finished, S.seq);
    function q(label, answer, body) { return '<section class="rc-q"><h4>' + esc(label) + '</h4><p class="rc-a">' + answer + '</p>' + (body || '') + '</section>'; }
    var path = '<div class="rc-path">' + rc.did.path.map(function (x, i) { return '<span class="rc-step a-' + esc(x.actor) + '"><i>' + (i + 1) + '</i>' + esc(x.title) + '</span>'; }).join('<span class="rc-arrow">→</span>') + '</div>';
    var looked = rc.looked.length ? rc.looked.map(function (s) {
      return (rc.looked.length > 1 ? '<div class="rc-src"><b>' + esc(s.title) + '</b>: ' + esc(s.line) + '</div>' : '') +
        (s.shown.length ? '<ul class="rc-items">' + s.shown.map(function (it) {
          return '<li class="' + (it.relied ? 'relied' : '') + '">' + (it.relied ? '★ ' : '') + esc(it.title) + (it.relied ? ' <span class="muted">· relied on</span>' : it.state === 'found' ? ' <span class="muted">· found, not given</span>' : '') + '</li>';
        }).join('') + '</ul>' : '');
    }).join('') : '<span class="muted">The app doesn’t say what it can see.</span>';
    var lookedA = rc.looked.length === 1 ? '<b>' + esc(rc.looked[0].title) + ':</b> ' + esc(rc.looked[0].line)
      : rc.looked.length ? esc(rc.looked.some(function (s) { return s.found; }) ? 'What it was given, and what its answer rests on' : 'Nothing was looked up this time') : 'The app doesn’t say';
    var checks = rc.checked.length ? '<ul class="rc-checks">' + rc.checked.map(function (c) {
      return '<li class="c-' + esc(c.state) + '"><span class="bb-sym">' + ({ passed: '✓', failed: '✕', not_on_path: '–', ran: '•', running: '…', pending: '·' }[c.state] || '•') + '</span><span><b>' + esc(c.label.replace(/^./, function (x) { return x.toUpperCase(); })) + '</b> ' + esc(c.line.replace(/^[✓✕–]\s*/, '')) + '</span></li>';
    }).join('') + '</ul>' : '';
    var cc = rc.checkCount;
    var checkedA = !rc.checked.length ? 'The app declares no checks'
      : [cc.ran ? cc.ran + (cc.ran === 1 ? ' check ran' : ' checks ran') : 'No check ran',
         cc.notNeeded ? cc.notNeeded + ' not needed this time' : '', cc.pending ? cc.pending + ' not reached yet' : ''].filter(Boolean).join(' · ');
    var signed = rc.signed.line + (rc.signed.state === 'approved' || rc.signed.state === 'denied' ? '' : '');
    var pair = this.pair && (rc.signed.state === 'approved' || rc.signed.state === 'denied') ? '<a class="p-btn" href="' + esc(this.pair.href) + '">' + esc(this.pair.text) + '</a>' : '';
    var tr = topo.app && topo.app.track_record;
    return '<div class="bb rc">' +
      '<div class="bb-head"><span class="rc-k">Recap</span><span class="bb-name">The run in four answers</span>' + (finished ? '' : '<span class="bb-tag t-now">So far</span>') +
        '<button class="p-x" data-act="recap" title="Back to the steps (← or Esc)">✕</button></div>' +
      '<div class="bb-body">' +
      q('What did it do?', '<b>' + esc(rc.did.text) + '</b>', path +
        (rc.did.why ? '<div class="rc-why"><span>Why, in the AI’s words:</span><blockquote class="bb-quote">' + esc(rc.did.why) + '</blockquote></div>' : '')) +
      q('What did it look at?', lookedA, looked) +
      q('How was it checked?', esc(checkedA), checks) +
      q('Did a person sign off?', esc(signed), pair) +
      (rc.never.length ? '<p class="rc-never"><span>It can never:</span> ' + rc.never.map(esc).join(' · ') + '</p>' : '') +
      (tr ? '<p class="rc-record"><span>How it’s been tested (the app says):</span> ' + esc(tr) + '</p>' : '') +
      '</div></div>';
  };

  /* The footer: two labelled rows. "This run": its time and cost in words. Then, once it's
     finished, "By hand": the app's own baseline (a "name: value · …" list shown as one), or before
     that "It can never": the map's never list. */
  Bench.prototype._bottomHTML = function (run, events, finished) {
    var L = lg(), topo = this.topo;
    // Live, an open gate keeps waiting by the wall clock; a replay's times are the recorded ones.
    var nowTs = null;
    if (this.source !== 'replay' && !this._local && !finished && run.gate && run.gate.state === 'waiting' && run.gate.seenAt != null)
      nowTs = run.gate.since + (wallNow() - run.gate.seenAt) / 1000;
    var split = events.length ? L.timeSplit(events, nowTs) : null;
    function item(k, v) { return '<span class="fi">' + (k ? '<span class="fk">' + esc(k) + '</span> ' : '') + '<span class="fv">' + esc(v) + '</span></span>'; }
    var facts = [];
    if (split) {
      if (split.gated) facts.push(item('AI work', L.secsWords(split.work)), item('Waiting for a person', L.secsWords(split.waiting)));
      else facts.push(item(finished ? 'Took' : 'So far', L.secsWords(split.total)));
    }
    var info = L.costInfo(events);
    if (info.calls) {
      if (!info.priced) facts.push(item('AI cost', 'not known'));
      else facts.push(item('AI cost', (info.known ? '' : 'at least ') + L.costWords(info.usd) + (info.known ? '' : ' (some calls carry no price)')));
    }
    var LABELS = ['This run', 'By hand', 'It can never'];
    function row(label, items, cls) {
      var lab = '<span>' + esc(label) + '</span>' + LABELS.filter(function (t) { return t !== label; }).map(function (t) { return '<span class="fghost" aria-hidden="true">' + t + '</span>'; }).join('');
      return '<div class="frow"><span class="flabel">' + lab + '</span><span class="fitems' + (cls ? ' ' + cls : '') + '">' + items.join('') + '</span></div>';
    }
    var rows = facts.length ? [row('This run', facts)] : [];
    var base = finished ? L.baselineOf(events, topo) : null;
    var never = topo.never || [];
    if (base) {
      var pairs = L.labelledPairs(base);
      rows.push(row('By hand', pairs ? pairs.map(function (x) { return item(x.k.replace(/^./, function (c) { return c.toUpperCase(); }), x.v); }) : [item('', base)]));
    } else if (never.length) rows.push(row('It can never', never.map(function (x) { return item('', x); }), 'never'));
    // The footer keeps room for two rows (index.html), so its growing never moves the stage. The
    // label column is as wide as the widest label it ever holds (invisible copies share its first
    // cell, see row), so the facts don't shift sideways when "It can never" becomes "By hand".
    return rows.join('');
  };

  // "What the AI was given": the run's model calls, as plain blocks, with retrieved text marked.
  Bench.prototype._overlayHTML = function (run, events) {
    var L = lg(), calls = L.givenBlocks(this.topo, events), focus = this.overlay && this.overlay.focus;
    var note = L.privacyLine(this.topo, events);
    var anyHit = false;
    var anyRelied = false;
    // A value with the map's words beside it: "needs a change (needs_write)".
    function worded(v, w) { return w ? '<b>' + esc(w) + '</b> <span class="muted">(' + esc(v) + ')</span>' : esc(v); }
    var body = calls.map(function (c) {
      // The answer first: it is what the room is waiting for; what it was given follows.
      var ordered = c.blocks.filter(function (b) { return b.role === 'output'; }).concat(c.blocks.filter(function (b) { return b.role !== 'output'; }));
      var blocks = ordered.map(function (b) {
        if (b.role === 'form') {
          return '<div class="g-block g-form"><div class="g-role">' + esc(b.label) + '</div><div class="g-note">The app sent this with its request: the fields the AI\u2019s answer had to fill in, and what it was told each one means.</div>' +
            '<dl class="g-fields">' + b.fields.map(function (f) {
              return '<dt>' + esc(f.name.replace(/_/g, ' ')) + '</dt><dd>' + (f.description ? esc(f.description) : '') +
                (f.choices ? '<div class="g-choices">one of: ' + f.choices.map(function (x, i) { return worded(x, f.plain && f.plain[i]); }).join(' · ') + '</div>' : '') + '</dd>';
            }).join('') + '</dl></div>';
        }
        var segs = b.segments.map(function (sg) {
          if (!sg.hit) return esc(sg.text);
          anyHit = true;
          if (sg.hit.relied) anyRelied = true;
          return '<span class="hlwrap' + (sg.hit.relied ? ' relied' : '') + '"><span class="hltag">' + (sg.hit.relied ? '★ relied on · ' : '') + 'from ' + esc(sg.hit.source ? sg.hit.source + ': ' : '') + esc(sg.hit.title) + '</span><mark>' + esc(sg.text) + '</mark></span>';
        }).join('');
        // A one-object JSON answer reads as a filled-in form; its exact text stays one click away.
        if (b.answer) {
          return '<div class="g-block g-output"><div class="g-role">' + esc(b.label) + '</div><dl class="g-fields g-answer">' + b.answer.map(function (f) {
              return '<dt>' + esc(f.name.replace(/_/g, ' ')) + '</dt><dd>' + worded(f.value, f.plain) + (/confidence/i.test(f.name) ? ' <span class="muted">(the AI\u2019s own estimate, not measured accuracy)</span>' : '') + '</dd>';
            }).join('') + '</dl><details class="g-raw"><summary>its exact text</summary><pre class="g-text">' + segs + '</pre></details></div>';
        }
        return '<div class="g-block g-' + esc(b.role || 'x') + '"><div class="g-role">' + esc(b.label) + '</div><pre class="g-text">' + segs + '</pre></div>';
      }).join('');
      return '<section class="g-call' + (focus && focus === c.node ? ' focus' : '') + '" data-node="' + esc(c.node) + '"><h4>Step: ' + esc(c.title) + '</h4>' + (blocks || '<div class="muted">The app didn\u2019t send this call\u2019s text.</div>') + '</section>';
    }).join('');
    return '<div class="g-panel' + (this.bigText ? ' big' : '') + '"><div class="g-head"><b>What the AI was given</b><span class="muted">every time the AI was asked something in this run, word for word as the app recorded it</span>' +
      '<button class="g-big" data-act="bigtext" title="Larger or smaller text">' + (this.bigText ? 'A\u2212 Smaller text' : 'A+ Larger text') + '</button>' +
      '<button class="p-close" data-act="close" title="Close (Esc)">\u2715 Close</button></div>' +
      (anyHit ? '<div class="g-note"><mark class="g-key">highlighted</mark> text was found by the search and pasted into the AI\u2019s prompt, word for word; the label above each says where it came from.' +
        (anyRelied ? ' <mark class="g-key relied">★ relied on</mark> marks what its answer rests on.' : '') + '</div>' : '') +
      (note ? '<div class="g-note">' + esc(note) + '</div>' : '') +
      '<div class="g-body">' + (body || '<div class="muted">The AI hasn\u2019t been asked anything yet.</div>') + '</div></div>';
  };

  global.Bench = Bench;
})(typeof window !== 'undefined' ? window : this);

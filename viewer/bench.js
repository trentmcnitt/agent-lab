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
  // The pill for a run the app has gone quiet on (logic.quietRun): what the bench knows, nothing more.
  var QUIET_PILL = { cls: 'paused', text: 'No word from the app', full: 'The app has sent nothing for this run for a while, so its clock is stopped where the app last spoke. It picks up if the app does.' };
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
    /* Presentation's view: 'map' (the whole map, a line under it about the step it's on) or 'detail'
       (the map compact on top, a step's detail under it). Beside an app the run plays on the whole
       map; a recording a presenter steps through opens on the detail. Engineering is always 'detail'. */
    this.view = this.source === 'replay' ? 'detail' : 'map';
    this._edgeLit = {};                          // edges drawn lit so far (a newly lit one draws on)
    this._raf = null;
    this._build();
    this.root.classList.toggle('beside', this.source === 'parent');
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
        '<span class="tb-brand" data-p="brand"><span class="tb-logo"><i></i></span><span><span class="tb-app" data-p="appname"></span><span class="tb-sub" data-p="appsub">agent lab</span></span></span>' +
        '<div class="tb-ask"><div class="ps-who" data-p="who"></div><div class="ps-req" data-p="req"></div></div>' +
        '<span class="tb-status" data-p="status"></span>' +
        '<span class="p-inferred" data-p="inferred" hidden>map inferred from the trace</span>' +
        '<span class="tb-pick" data-p="picker"></span>' + toggle +
      '</header>' +
      // Engineering (S4): the same map as Presentation on the left; on the right a docked panel led by
      // the step's card (its numbers, then every model and tool call inside it as a waterfall), the
      // run's other panels folded under it; the event log is a drawer at the bottom.
      '<div class="eng">' +
      '<div class="eng-top" data-f="top">' +
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
      '</div>' +
      // The same pane-first structure as Presentation: the map pinned on top, the step's card and the
      // run's panels scrolling under it.
      '<div class="bgrid" data-f="stage">' +
        '<section class="col graphcol ps-map" data-f="map"><div class="ps-flowhead" data-f="flowhead"></div><div class="graphwrap" data-f="graph"></div><div class="ps-cue" data-f="cue" hidden></div><div class="edgetip" data-f="tip" hidden></div></section>' +
        '<section class="col panelcol" data-f="panels"></section>' +
      '</div>' +
      '<section class="logcol" data-f="logcol">' +
        '<button class="logtoggle" data-f="logtoggle" title="Every event received, in order"><b>Event log</b> <span data-f="logcount"></span><span class="lt-arrow" data-f="logarrow">▴ show</span></button>' +
        '<div class="log mono" data-f="log"></div>' +
      '</section>' +
      '</div>' +
      '<div class="pres">' +
        // Presentation, pane-first: the map on top, always. The whole map while a run plays (a line
        // under it says what the step it's on did); a step clicked, the same map glides to a compact
        // size pinned on top and that step's detail opens under it. "What the AI was given" is a
        // drawer over the detail only: the map stays in view.
        '<div class="ps-stage" data-p="stage">' +
          '<section class="ps-map" data-p="map"><div class="ps-flowhead" data-p="flowhead"></div><div class="graphwrap" data-p="graph"></div>' +
            '<div class="ps-cue" data-p="cue" hidden></div><div class="edgetip" data-p="tip" hidden></div></section>' +
          '<section class="ps-side" data-p="side"><button class="ps-grab" data-act="mapview" title="Back to the whole map (M)" aria-label="Back to the whole map"><svg viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 6l4 4 4-4\"/></svg></button><div class="ps-now" data-p="now" aria-live="polite"></div>' +
            '<div class="ps-bubble" data-p="bubble" aria-live="polite"></div><div class="ps-more" data-p="more" hidden><span>▾ more below</span></div>' +
            '<div class="ps-drawer" data-p="drawer" aria-hidden="true"></div></section>' +
        '</div>' +
        '<footer class="ps-foot"><div class="ps-facts" data-p="bottom"></div><div class="ps-strip" data-p="strip"></div>' +
          '<div class="ps-ctl"><div class="p-transport" data-p="transport"></div>' +
            '<button class="ps-key" data-act="maponly" title="The whole map, or the map with a step\'s detail under it (M)"><kbd>M</kbd><span class="kl">map</span></button>' +
            '<button class="ps-key" data-act="recap" title="The run in four answers (R)"><kbd>R</kbd><span class="kl">recap</span></button>' +
            '<button class="ps-key ps-help" data-act="keys" title="The presenter\'s keys (?): → or PageDown next step, ← back" aria-label="Keys"><kbd>?</kbd><span class="kl">keys</span></button></div></footer>' +
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
    this.p.bubble.addEventListener('scroll', function () { self._moreCue(); });
    this.f.download.onclick = function () { self.downloadMap(); };
    // The event log is a drawer: shut, it is one line; open, it takes the bottom third.
    this.f.logtoggle.onclick = function () { self.logOpen = !self.logOpen; self._applyLog(); };
    this._applyLog();
    // Engineering's panel: a step's waterfall rows open and shut; a panel's title folds it.
    this.engOpen = { _io: true };
    this.f.panels.addEventListener('click', function (ev) {
      var sm = ev.target.closest('.wfr > summary');
      if (sm) {
        ev.preventDefault();
        var k = sm.parentNode.getAttribute('data-k');
        self.wfOpen = self.wfOpen || {};
        self.wfOpen[k] = !sm.parentNode.open;
        sm.parentNode.open = self.wfOpen[k];
        var body = sm.closest('.pbody'); if (body) body._h = null;
        self._placeMarker();
        return;
      }
      var pt = ev.target.closest('.ptitle');
      if (pt && !ev.target.closest('.rawbtn')) {
        var el = pt.parentNode, id = el.getAttribute('data-panel');
        self.engOpen[id] = !el.classList.contains('open');
        el.classList.toggle('open', self.engOpen[id]);
        return;
      }
      if (ev.target.closest('[data-act=clearsel]')) { self.selectedNode = null; self.render(); }
    });
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
    var top = this.f.top;
    if (el && top) top.insertBefore(el, top.firstChild);
  };
  Bench.prototype._applyLog = function () {
    this.f.logcol.classList.toggle('open', !!this.logOpen);
    this.f.logarrow.textContent = this.logOpen ? '▾ hide' : '▴ show';
    if (this._fit && this.mode === 'engineering') { this._fit(); this._placeMarker(); }
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
    this._instant = true;                            // what's lit now was lit already: no draw-on
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
    this.p.brand.hidden = !this.p.appname.textContent;
    this.p.brand.title = topo.app.description || '';
    this.p.appsub.textContent = 'agent lab · ' + (this.source === 'replay' ? 'replay' : 'live');
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
      if (!this.pinned) {
        this.current = ev.run_id; this.ioPick = null; this._edgeLit = {};
        // A new request beside the app (or live) plays on the whole map, from its first step.
        if (this.source !== 'replay' && !this._localPush) {
          this.selectedNode = null; this.overlay = null; this.recapOpen = false; this.presItem = null;
          if (this.view !== 'map' && this.mode === 'presentation') this.setView('map');
        }
      }
    }
    // Out of order (OTLP exports the root span last; a late run_started): re-sort and rebuild.
    if (L.needsResort(run, ev)) this.runs[ev.run_id] = L.rebuildRun(run, ev, wallNow());
    else L.reduce(run, ev, wallNow());
    // When the app last spoke about this run (quietRun): set after a rebuild, which replaces the run.
    this.runs[ev.run_id].lastArr = wallNow();
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

  /* Both modes draw the same map (the stage): Presentation's in .pres, Engineering's in .eng. Only the
     mode on screen has one, so the SVG ids (#parr-t, #pglow) are never on the page twice. */
  Bench.prototype._drawGraph = function () {
    (this.mode === 'presentation' ? this.f.graph : this.p.graph).innerHTML = '';
    this._drawStage();
  };
  Bench.prototype._bindResize = function () {
    var self = this;
    if (this._fitBound) return;
    this._fitBound = true;
    // The stage changing size (the bar over it growing when a request arrives, the footer wrapping)
    // changes the map's room: draw it again for the room it has now.
    if (global.ResizeObserver) {
      var seen = {};
      var ro = new global.ResizeObserver(function (entries) {
        var changed = entries.some(function (en) { var k = en.target.getAttribute('data-p') || en.target.getAttribute('data-f'), h = Math.round(en.contentRect.height), w = Math.round(en.contentRect.width); var was = seen[k]; seen[k] = w + 'x' + h; return was && was !== seen[k]; });
        if (!changed) return;
        clearTimeout(self._roT);
        self._roT = setTimeout(function () { if (self.topo) { self._instant = true; self._drawStage(); self.render(); } }, 150);
      });
      ro.observe(this.p.stage); ro.observe(this.f.stage);
    }
    // The boxes are sized from the room the map has: a resize redraws the map (no draw-on, no glide).
    global.addEventListener('resize', function () {
      clearTimeout(self._rsT);
      if (self._fit) self._fit();
      self._rsT = setTimeout(function () { if (self.topo) { self._instant = true; self._drawStage(); self.render(); } }, 120);
    });
  };

  /* Engineering's panels, in the docked panel under the step's card: what the AI was given (open),
     then the sources, the checks, the map's own checks, the run, the step timeline and the app's own
     panels, each folded until its title is clicked. */
  Bench.prototype._buildPanels = function () {
    var box = this.f.panels;
    box.innerHTML = '';
    this.panelEls = {};
    if (!this.topo) return;
    var panels = (this.topo.panels || []).slice();
    panels.unshift({ id: '_timeline', title: 'Timeline · how long each step took', event_types: [] });
    panels.unshift({ id: '_run', title: 'This run · the request and the final output', event_types: ['run_started', 'run_finished'] });
    panels.unshift({ id: '_mapchecks', title: 'Checks on this map · do the map’s words still match the code?', event_types: [] });
    panels.unshift({ id: '_checks', title: 'Checks · how it was checked, with evidence', event_types: ['check_result'] });
    panels.unshift({ id: '_sources', title: 'Sources · could look at / given to the model / relied on', event_types: ['retrieval'] });
    panels.unshift({ id: '_io', title: 'Model I/O · exactly what the model was given, and what it returned', event_types: ['llm_call'] });
    panels.unshift({ id: '_node', title: 'Selected step', event_types: ['*'], mode: 'append' });
    var self = this;
    panels.forEach(function (p) {
      var custom = p.story || p.fields;
      var open = p.id === '_node' || !!self.engOpen[p.id];
      var e = el('div', 'panel' + (p.id === '_node' ? ' stepcard' : '') + (p.story ? ' storied' : '') + (open ? ' open' : ''), '<div class="ptitle"><span class="pt"><i class="chev"></i>' + esc(p.title) + (p.audience && p.audience !== 'both' ? ' <span class="aud">' + esc(p.audience) + '</span>' : '') + '</span><span class="pright">' +
        (custom ? '<button class="rawbtn" title="Show every field of every event this panel collects">raw</button>' : '') +
        '<span class="pcount mono"></span></span></div><div class="pbody"><span class="muted">–</span></div>');
      e.setAttribute('data-panel', p.id);
      box.appendChild(e);
      var P = self.panelEls[p.id] = { spec: p, el: e, body: e.querySelector('.pbody'), count: e.querySelector('.pcount'), raw: false };
      var rb = e.querySelector('.rawbtn');
      if (rb) rb.onclick = function () { P.raw = !P.raw; rb.classList.toggle('on', P.raw); self.render(); };
    });
    this.f.waterfall = this.panelEls._timeline.body;
    // Before any run: one line saying so, not a column of empty folded panels.
    box.appendChild(el('div', 'eng-wait', '<b>Waiting for a run.</b> ' + (this.source === 'parent' ? 'Start a run in the app: every' : 'When the app runs, every') +
      ' model call, tool call and event it reports shows here, under the step it belongs to.'));
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
      : oc0.done ? { cls: /^Handed/.test(oc0.text) ? 'handed' : /^Stopped before/.test(oc0.text) ? 'paused' : /^(Stopped|Something)/.test(oc0.text) ? 'bad' : 'ok', text: pillWords(oc0.text), full: oc0.text }
      : /^Waiting/.test(oc0.text) ? { cls: 'waiting', text: 'Waiting for a person to approve' }
      : this._quiet(run) ? QUIET_PILL : { cls: 'running', text: 'Running' };
    setHTML(this.p.status, '<span class="ps-pill st-' + st0.cls + '" title="' + esc(st0.full || st0.text) + '"><i></i><b>' + esc(st0.text) + '</b></span>');
    var nSteps0 = this.topo.nodes.length;
    this.f.panels.classList.toggle('norun', !run);
    if (!run) {
      this.f.meters.textContent = 'waiting for events…';
      setHTML(this.f.flowhead, this._flowheadHTML(null, null));
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
    var st = run.status || (run.gate && run.gate.state === 'waiting' ? 'waiting' : this._quiet(run) ? 'quiet' : 'running');
    var stTxt = { ok: '✓ finished', error: '✕ error', aborted: 'aborted', waiting: '⏸ waiting for approval', running: '● running', quiet: '⏸ no word from the app' }[st] || st;
    var split = L.timeSplit(run.events), base = L.baselineOf(run.events, this.topo);
    this.f.meters.innerHTML = cost +
      m(fmtNum(run.tok.input), 'tokens in', run.tok.cache_read ? fmtNum(run.tok.cache_read) + ' of them read from the cache' : '') +
      m(fmtNum(run.tok.output), 'tokens out') +
      m(run.llmCalls, 'model call' + (run.llmCalls === 1 ? '' : 's')) +
      m(fmtMs((run.t1 - run.t0) * 1000), 'total') +
      (split.gated ? m(fmtMs(split.work * 1000), 'work') + m(fmtMs(split.waiting * 1000), 'waiting for a person') : '') +
      (base ? m(esc(base), 'by hand (the app’s estimate)') : '') +
      '<span class="status st-' + esc(st) + '">' + esc(stTxt) + '</span>';

    var S = this._renderStage(run);
    this._lastShown = S;
    setHTML(this.f.flowhead, this._flowheadHTML(run, S));
    this._renderWaterfall(run);
    this._renderPanels(run, S);
    this._renderLog(run);
    var fa = S.focus ? L.actorOf(L.nodeOf(this.topo, S.focus), S.events) : null;
    this.f.stage.className = 'bgrid' + (fa ? ' a-' + fa : '');
    if (this._fit) this._fit();
    this._placeMarker();
  };
  /* The status pill's words: short, so the bar never reflows when the run ends (the whole outcome is
     its tooltip and the last step's headline). */
  function pillWords(t) {
    t = String(t || '');
    if (/^Done\b.*approved by a person/.test(t)) return 'Finished · approved by a person';
    if (/^Done\b/.test(t)) return 'Finished · done';
    if (/^Stopped: a person said no/.test(t)) return 'Stopped · a person said no';
    if (/^Something went wrong/.test(t)) return 'Something went wrong';
    if (/^Stopped/.test(t)) return t;
    if (t === 'Finished' || t.length > 28) return 'Finished';
    return 'Finished · ' + t;
  }

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
    var quiet = this._quiet(run, now);
    return { quiet: quiet, now: now, shownEnd: shownEnd, ran: ran, seq: seq, nest: nest, openNode: openNode, lastNode: lastNode, focusNode: focusNode || lastNode,
             starting: starting, finished: finished, caught: caught, events: events };
  };

  /* Beside the app (embedded sync), a run the app has gone quiet on (logic.quietRun): its clock stops
     where the app last spoke. Not while stepping through a run here (those pauses are the presenter's). */
  Bench.prototype._quiet = function (run, now) {
    if (this.source !== 'parent' || this._local || !run) return null;
    return lg().quietRun(run, now != null ? now : wallNow());
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

  Bench.prototype._renderPanels = function (run, S) {
    var self = this, L = lg();
    Object.keys(this.panelEls).forEach(function (pid) {
      var P = self.panelEls[pid], spec = P.spec, evs;
      if (pid === '_node') {
        // The step the map points at: the one clicked, else the one the run is on.
        var id = S && S.focus;
        P.el.classList.toggle('empty', !id);
        if (!id) { setHTML(P.body, '<span class="muted">Click any step in the map to see what it did.</span>'); P.count.textContent = ''; return; }
        self._renderStep(P, run, id, S); return;
      }
      if (pid === '_timeline') { P.count.textContent = ''; return; }
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

  /* Engineering's step card, first in the docked panel: the step's badge and name, its numbers in one
     strip (step and node ids, its model and tool calls, tokens, cost, time), what the step is for, then
     every call inside it as a waterfall by start time; its input and output and every event it
     reported fold under it. */
  Bench.prototype._renderStep = function (P, run, id, S) {
    var self = this, L = lg();
    var node = L.nodeOf(this.topo, id) || { id: id };
    var steps = (run.nodeSteps[id] || []).map(function (sid) { return run.steps[sid]; }).filter(function (s) { return !s.parent; });
    var evs = run.events.filter(function (e) { return e.node === id; });
    var actor = L.actorOf(node, run.events), bn = badgeOf(S, id), fold = this.foldOpen || {};
    P.count.textContent = '';
    var last = steps[steps.length - 1];
    var waiting = run.gate && run.gate.node === id && run.gate.state === 'waiting' && !run.status;
    var ms = steps.reduce(function (a, s) { return a + (s.latency != null ? s.latency : s.end != null ? (s.end - s.start) * 1000 : 0); }, 0);
    var tag = !steps.length ? (run.status ? 'not reached this run' : 'not reached yet') : waiting ? 'waiting for a person' : last && last.end == null ? 'running' : 'done · ' + fmtMs(ms);
    var head = '<div class="es-head a-' + esc(actor) + '"><span class="bb-num' + (S.numbers && S.numbers[id] ? '' : ' off') + '">' + esc(bn || '·') + '</span>' +
      '<span class="es-name">' + esc(L.plainLabel(node, id)) + '</span><span class="bb-who">' + esc(ACTOR_CHIP[actor] || actor) + '</span>' +
      '<span class="bb-tag t-' + (!steps.length ? 'not_needed' : waiting ? 'waiting' : last && last.end == null ? 'now' : 'done') + '"><i></i>' + esc(tag) + '</span>' +
      (this.selectedNode ? '<button class="p-x" data-act="clearsel" title="Follow the run again (Esc)">✕</button>' : '') + '</div>';
    var desc = node.description ? '<p class="es-desc">' + esc(node.description) + '</p>' : '';
    if (!steps.length) {
      setHTML(P.body, head + metas(['node <b>' + esc(id) + '</b>', '<b>' + esc(node.kind || 'step') + '</b>']) + desc +
        '<p class="es-none">' + (run.status ? 'This step didn’t run this time.' : 'Not reached yet.') + '</p>');
      return;
    }
    var seqs = steps.map(function (s) { return L.callSequence(run.events, s.id); });
    var nAi = 0, nTool = 0, tin = 0, tout = 0, cost = 0, priced = false, model = null;
    seqs.forEach(function (q) { nAi += q.ai; nTool += q.tools; });
    evs.forEach(function (e) { var d = e.data || {}; if (e.event_type === 'llm_call') { tin += d.input_tokens || 0; tout += d.output_tokens || 0; if (d.cost_usd != null) { cost += Number(d.cost_usd); priced = true; } model = d.model || model; } });
    var strip = metas(['step <b>' + esc(last.id) + '</b>' + (steps.length > 1 ? ' ×' + steps.length : ''), 'node <b>' + esc(id) + '</b>',
      nAi || nTool ? '<b>' + nAi + '</b> chat · <b>' + nTool + '</b> tool' : '<b>' + esc(node.kind || 'step') + '</b> · no calls',
      model && nAi === 1 ? '<b>' + esc(model) + '</b>' : '',
      tin || tout ? '<b>' + fmtNum(tin) + '</b>→<b>' + fmtNum(tout) + '</b> tok' : '', priced ? '<b>' + fmtUsd(cost) + '</b>' : nAi ? 'cost <b>—</b>' : '',
      '<b>' + fmtMs(ms) + '</b>']);
    var wf = steps.map(function (s) { return self._waterfallHTML(run, s); }).join('');
    var pv = L.preview(steps, 'engineering');
    var result = pv ? '<div class="es-result"><span>result</span>' + esc(pv) + '</div>' : '';
    var io = '';
    evs.forEach(function (e) {
      if (e.event_type === 'step_started' && e.data && e.data.input != null) io += ioBlock('input', L.ioText(e.data.input));
      if (e.event_type === 'step_finished' && e.data && e.data.output != null) io += ioBlock('output', L.ioText(e.data.output), 'out');
    });
    function folded(k, label, body) {
      return body ? '<details class="es-fold" data-fold="' + esc(k) + '"' + (fold[k] ? ' open' : '') + '><summary><i class="chev"></i>' + label + '</summary><div class="es-fbody">' + body + '</div></details>' : '';
    }
    var raw = evs.map(function (e) { return '<div class="pev">' + self.renderEvent(e, true) + '</div>'; }).join('');
    setHTML(P.body, head + strip + desc + wf + result +
      folded('io', 'Its input and output', io) + folded('events', 'Every event it reported <span class="n">' + evs.length + '</span>', raw) +
      (nAi ? '<p class="es-note">Each model call, word for word: the next panel down.</p>' : ''));
    if (!P.body._foldBound) {
      P.body._foldBound = true;
      P.body.addEventListener('click', function (ev) {
        var sm = ev.target.closest('.es-fold > summary');
        if (!sm) return;
        ev.preventDefault();
        var d = sm.parentNode, k = d.getAttribute('data-fold');
        self.foldOpen = self.foldOpen || {};
        self.foldOpen[k] = !d.open;
        d.open = self.foldOpen[k];
        P.body._h = null;
      });
    }
  };

  /* Round ticks for a time axis `span` seconds long: 0, then a step of 1, 2 or 5 × a power of ten, at
     most about six of them. */
  function niceTicks(span) {
    var raw = span / 6, p = Math.pow(10, Math.floor(Math.log10(raw || 1e-3))), unit = p;
    [1, 2, 5, 10].some(function (m) { unit = m * p; return unit >= raw; });
    var out = [];
    for (var t = 0; t <= span + 1e-9; t += unit) out.push(Math.round(t / unit) * unit);
    return { unit: unit, ticks: out };
  }
  function tickWord(t, unit) {
    if (t === 0) return '0';
    return unit >= 1 ? t + 's' : unit >= 0.1 ? (Math.round(t * 10) / 10) + 's' : Math.round(t * 1000) + 'ms';
  }

  /* Engineering's look inside one step: its span, then every model and tool call by start time
     (logic.callSequence), each on the step's own time axis (round ticks, a gridline each) with its
     duration and tokens; a row opens (▸) to its step and call ids, arguments, result (a list one
     item per line), tokens (cache reads included) and, for a model call, the tools its answer asked for. */
  Bench.prototype._waterfallHTML = function (run, step) {
    var L = lg(), seq = L.callSequence(run.events, step.id);
    if (!seq.calls.length) return '';
    var span = seq.span, nt = niceTicks(span);
    var ticks = nt.ticks.map(function (t) {
      var x = t / span * 100;
      return x > 100.5 ? '' : '<span style="left:' + x.toFixed(2) + '%"' + (x > 92 ? ' class="end"' : '') + '>' + tickWord(t, nt.unit) + '</span>';
    }).join('');
    var grid = 'background-size:' + (nt.unit / span * 100).toFixed(3) + '% 100%';
    function pos(a, b) { return 'left:' + ((a - seq.start) / span * 100).toFixed(2) + '%;width:' + Math.max(0.4, (b - a) / span * 100).toFixed(2) + '%'; }
    var open = this.wfOpen || {}, firstTool = (seq.calls.filter(function (c) { return c.kind === 'tool'; })[0] || {}).n;
    function json(v) { return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); }
    // A list result: one item per line, so each reads on its own.
    function listed(v) {
      if (typeof v === 'string') { try { var j = JSON.parse(v); if (j && typeof j === 'object') v = j; } catch (e) {} }
      if (Array.isArray(v)) return v.map(function (x) { return esc(L.short(json(x), 300)); }).join('\n');
      return esc(L.short(json(v), 800));
    }
    var rows = seq.calls.map(function (c, i) {
      var d = c.ev.data || {}, last = i === seq.calls.length - 1, key = step.id + '#' + c.n;
      var isOpen = open[key] != null ? open[key] : c.n === firstTool;
      var label = c.kind === 'ai' ? esc(d.model || 'model') : esc(d.tool || 'tool') + (d.arguments != null ? ' <span class="ar">' + esc(L.short(json(d.arguments), 40)) + '</span>' : '');
      var meta = '<b>' + (c.timed ? L.fmtMs((c.end - c.start) * 1000) : '–') + '</b>' + (c.kind === 'ai' ? ' · ' + L.fmtNum(d.input_tokens) + '→' + L.fmtNum(d.output_tokens) : '');
      var kv = [['step / call', esc(step.id) + (d.call_id ? ' · call ' + esc(d.call_id) : '') + (c.askedBy ? ' · asked for by call ' + c.askedBy : '')],
                ['started', '+' + L.fmtMs((c.start - seq.start) * 1000) + (c.with.length ? ' · same time as ' + c.with.join(', ') : '') + (c.timed ? '' : ' · no duration sent (stamped at its end)')]];
      if (c.kind === 'ai') {
        kv.push(['tokens', L.fmtNum(d.input_tokens) + ' in' + (d.cache_read_tokens ? ' (cache read ' + L.fmtNum(d.cache_read_tokens) + ')' : '') + ' → ' + L.fmtNum(d.output_tokens) + ' out' + (d.finish_reason ? ' · finish <span class="s">' + esc(d.finish_reason) + '</span>' : '') + (d.cost_usd != null ? ' · ' + L.fmtUsd(d.cost_usd) : '')]);
        (d.tool_calls || []).forEach(function (tc) { kv.push(['asked for', esc(tc.name || '') + ' <pre>' + esc(json(tc.arguments)) + '</pre>']); });
        if (!(d.tool_calls || []).length && d.output != null) kv.push(['output', '<pre>' + esc(L.short(L.ioText(d.output), 600)) + '</pre>']);
      } else {
        if (d.arguments != null) kv.push(['arguments', '<pre class="s">' + esc(json(d.arguments)) + '</pre>']);
        if (d.result != null) kv.push(['result', '<pre>' + listed(d.result) + '</pre>']);
      }
      return '<details class="wfr ' + c.kind + '" data-k="' + esc(key) + '"' + (isOpen ? ' open' : '') + ' style="--k:var(--' + (c.kind === 'ai' ? 'ai' : 'app') + ')"><summary>' +
        '<span class="nm"><i class="chev"></i><span class="no">' + c.n + '</span><span class="tw">' + (c.depth ? '│ └' : last ? '└' : '├') + '</span><span class="op">' + (c.kind === 'ai' ? 'chat' : 'tool') + '</span>' + label + '</span>' +
        '<span class="lane" style="' + grid + '"><span class="bar' + ((c.end - seq.start) / span > 0.7 ? ' inl' : '') + '" style="' + pos(c.start, c.timed ? c.end : c.start) + '">' + (c.kind === 'ai' && d.finish_reason ? '<i>' + esc(d.finish_reason) + '</i>' : '') + '</span></span>' +
        '<span class="mt">' + (c.with.length ? '<span class="par">with ' + c.with.join(', ') + '</span>' : '') + meta + '</span></summary><div class="xp">' + kv.map(function (x) { return '<span class="k">' + x[0] + '</span><span>' + x[1] + '</span>'; }).join('') + '</div></details>';
    }).join('');
    var nodeRow = '<div class="wfr node"><div class="sum"><span class="nm"><i class="chev none"></i><span class="op">step</span>' + esc(step.node) + '</span><span class="lane" style="' + grid + '"><span class="bar node" style="' + pos(seq.start, seq.end) + '"></span></span><span class="mt"><b>' + L.fmtMs(span * 1000) + '</b></span></div></div>';
    return '<div class="es-lab">Calls inside this step · in the order they started · click a row</div><div class="wf"><div class="hd"><span>call</span><span class="ticks">' + ticks + '</span><span>took · tokens</span></div>' + nodeRow + rows + '</div>' +
      '<div class="es-cap">order: by start (ts − latency_ms), not by event ts (stamped at the end) · ' + seq.ai + ' chat · ' + seq.tools + ' tool' + (seq.calls.some(function (c) { return c.with.length; }) ? ' · “with N”: ran at the same time as call N' : '') + '</div>';
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

  // ---- Presentation: the stage ------------------------------------------------------------
  /* Pane-first: the map is always on top. While a run plays (the 'map' view) it fills the bench: the
     run's path lights step by step (each step held lit at least MIN_LIT_MS), the line being travelled
     draws on and marches, the lit path is one unbroken spine, and a step waiting for a person pulses
     with a cue pointing at the app. A line under the map says what the step it's on did. Click a step
     (the 'detail' view) and the same map glides to a compact size pinned on top, that step ringed in
     its actor's colour; its detail opens under it (logic.callout, logic.documentsStep,
     logic.callSequence). Keys: → Space PageDown next, ← PageUp back, M the whole map, R the recap.
     All words come from the map and the events; nothing here knows any app. */
  var ACTOR_WORDS_P = { ai: 'The AI', rule: 'A rule', person: 'A person', app: 'The app' };
  var WIDE_MAP = 900;          // a map region at least this wide (a full screen) draws the larger type
  var MIN_NAME_PX = 13;        // the smallest a step's name is drawn; a map too tall for that scrolls, following its step
  var DETAIL_MAP_SHARE = 0.55;  // the detail view's map takes at most this share of the stage
  var GLIDE_MS = 440, DRAW_MS = 420;
  var EASE = 'cubic-bezier(.2,.7,.2,1)';
  function reducedMotion() { try { return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

  /* The box types (index.html's .graph.t-* .snode rules, in px): the name's font and line, the line
     under it (0: none), the badge, the padding and gaps, whether the actor's word is in the box (its
     slot measured per box), and the map's gaps. roomy: the whole map; compact: pinned above a detail.
     The W types are for a map region a full screen wide. */
  var BOX_TYPE = {
    roomy: { font: 16, line: 20, meta: 16, badge: 26, padL: 10, padR: 12, gap: 10, padY: 7, who: 12.5, gx: 44, gy: 28, pad: 10, minW: 220, maxW: 340 },
    roomyW: { font: 18, line: 22, meta: 18, badge: 28, padL: 12, padR: 14, gap: 12, padY: 10, who: 13.5, gx: 72, gy: 40, pad: 14, minW: 300, maxW: 400 },
    compact: { font: 16, line: 20, meta: 0, badge: 24, padL: 8, padR: 10, gap: 9, padY: 5, who: 0, gx: 36, gy: 12, pad: 5, minW: 200, maxW: 320 },
    compactW: { font: 17, line: 21, meta: 0, badge: 26, padL: 10, padR: 12, gap: 10, padY: 6, who: 0, gx: 56, gy: 16, pad: 6, minW: 260, maxW: 380 }
  };
  var _measure = null;
  function measureCtx() { try { _measure = _measure || document.createElement('canvas').getContext('2d'); } catch (e) { _measure = null; } return _measure; }
  // The room a box's name needs on one line (px), per node: name + badge + padding (+ its actor's word).
  function nameNeeds(topo, T) {
    var ctx = measureCtx(), out = {};
    topo.nodes.forEach(function (n) {
      var name = String(lg().plainLabel(n)), who = T.who ? String(ACTOR_CHIP[lg().actorOf(n)] || '').toUpperCase() : '';
      var nw = name.length * T.font * 0.56, ww = who.length * T.who * 0.68;
      if (ctx) {
        ctx.font = '500 ' + T.font + 'px Geist, Inter, system-ui, sans-serif'; nw = ctx.measureText(name).width;
        if (who) { ctx.font = '500 ' + T.who + 'px "Geist Mono", ui-monospace, monospace'; ww = ctx.measureText(who).width + who.length * T.who * 0.06; }
      }
      out[n.id] = { name: nw, rest: T.padL + T.padR + 2 + T.badge + T.gap + (who ? ww + 10 : 0) + 6 };
    });
    return out;
  }
  // Lines a name takes in a box `w` wide (two at most; a compact box keeps one and ellipsizes).
  function nameLines(topo, T, w, needs) {
    var ctx = measureCtx(), lines = 1;
    if (ctx) ctx.font = '500 ' + T.font + 'px Geist, Inter, system-ui, sans-serif';
    topo.nodes.forEach(function (n) {
      var room = w - needs[n.id].rest;
      if (needs[n.id].name <= room) return;
      if (!T.meta) { lines = Math.max(lines, 1); return; }
      var ws = String(lg().plainLabel(n)).split(/\s+/), k = 1, cur = '';
      ws.forEach(function (x) {
        var t = cur ? cur + ' ' + x : x;
        if (cur && (ctx ? ctx.measureText(t).width : t.length * T.font * 0.56) > room) { k++; cur = x; } else cur = t;
      });
      lines = Math.max(lines, k);
    });
    return Math.min(lines, 2);
  }
  /* The geometry for a view in a room aw × ah: box width from the room (two candidates: the width the
     columns fill, and the width the longest name needs on one line), box height from the type. The one
     whose names are drawn largest wins; on a tie, fewer lines. */
  function pickGeom(topo, view, aw, ah) {
    var T = BOX_TYPE[(view === 'map' ? 'roomy' : 'compact') + (aw >= WIDE_MAP ? 'W' : '')];
    var base = view === 'map' ? global.BenchLayout.ROOMY_GEOM : global.BenchLayout.COMPACT_GEOM;
    var probe = layout(topo, Object.assign({}, base, { w: 200, h: 40, gx: T.gx, gy: T.gy, pad: T.pad })), rows = {}, cols = 1;
    topo.nodes.forEach(function (n) { var p = probe.pos[n.id]; if (p) { rows[p.y] = (rows[p.y] || 0) + 1; cols = Math.max(cols, rows[p.y]); } });
    var needs = nameNeeds(topo, T), need1 = 0;
    Object.keys(needs).forEach(function (id) { need1 = Math.max(need1, needs[id].name + needs[id].rest); });
    function clampW(w) { return Math.round(Math.max(T.minW, Math.min(T.maxW, w))); }
    var fill = clampW((aw - 2 * T.pad - (cols - 1) * T.gx) / cols), best = null;
    [fill, clampW(Math.ceil(need1) + 2)].filter(function (w, i, a) { return a.indexOf(w) === i; }).forEach(function (w) {
      var lines = nameLines(topo, T, w, needs);
      var h = Math.ceil(2 * T.padY + lines * T.line + (T.meta ? 2 + T.meta : 0));
      var G = Object.assign({}, base, { w: w, h: h, gx: T.gx, gy: T.gy, pad: T.pad, lines: lines });
      var lay = layout(topo, G), k = Math.min(1, aw / lay.W, ah > 40 ? ah / lay.H : 1);
      var px = T.font * k - (lines > 1 ? 0.6 : 0);
      if (!best || px > best.px + 0.05) best = { G: G, lay: lay, k: k, px: px, T: T };
    });
    return best;
  }

  /* The elements one mode draws its stage into: Presentation's (.pres) or Engineering's (.eng). */
  Bench.prototype._E = function () {
    var f = this.f, p = this.p;
    return this.mode === 'engineering'
      ? { eng: true, graph: f.graph, tip: f.tip, stage: f.stage, map: f.map, cue: f.cue, head: f.flowhead, bubble: f.panels }
      : { eng: false, graph: p.graph, tip: p.tip, stage: p.stage, map: p.map, cue: p.cue, head: p.flowhead, bubble: p.bubble };
  };
  Bench.prototype._viewNow = function () { return this.mode === 'engineering' ? 'detail' : this.view; };
  /* Presentation's view: 'map' or 'detail'. The whole map clears what a detail had open. */
  Bench.prototype.setView = function (v) {
    v = v === 'detail' ? 'detail' : 'map';
    if (v === 'map') { this.selectedNode = null; this.overlay = null; this.recapOpen = false; this.keysOpen = false; this.presItem = null; }
    if (this.view === v) { this.render(); return; }
    this.view = v;
    if (this.topo && this.mode === 'presentation') this._drawStage(true);
    this.render();
  };

  /* Draws the map for the view on screen, sized to its room. glide: the boxes move from where they
     were to where they are now (the map growing or shrinking between the two views), the lines and
     their labels fading in once the boxes have arrived. */
  Bench.prototype._drawStage = function (glide) {
    var self = this, topo = this.topo, L = lg(), E = this._E();
    var view = this._viewNow();
    this.root.classList.toggle('v-map', view === 'map');
    this.root.classList.toggle('v-detail', view === 'detail');
    this.root.classList.toggle('p-maponly', !E.eng && view === 'map');
    var g = E.graph, sec = E.map, before = null;
    if (E.tip) E.tip.hidden = true;
    this._drawnAt = Date.now();
    if (glide && !reducedMotion() && g.querySelector('.gnode')) {
      before = { nodes: {}, h: sec.getBoundingClientRect().height };
      g.querySelectorAll('.gnode').forEach(function (n) { before.nodes[n.getAttribute('data-node')] = n.getBoundingClientRect(); });
    }
    // The room. The whole map takes what the stage has above the line under it; pinned above a
    // detail it takes what it needs, at most DETAIL_MAP_SHARE of the stage.
    sec.style.height = '';
    var headH = E.head ? E.head.offsetHeight : 0;
    var aw = Math.max(200, g.clientWidth - 8), ah;
    if (view === 'map') ah = Math.max(120, sec.clientHeight - headH - 10);
    else ah = Math.max(140, Math.round(E.stage.clientHeight * DETAIL_MAP_SHARE) - headH - 10);
    var P = pickGeom(topo, view, aw, ah);
    var G = this._geom = P.G, Lay = this.layout = P.lay, T = this._type = P.T;
    if (view === 'detail') sec.style.height = Math.ceil(Math.min(ah, Lay.H * Math.max(P.k, MIN_NAME_PX / T.font)) + headH + 8) + 'px';
    // Arrowheads only on the lines not taken; a lit line runs into its box (no seam, no head).
    var ah2 = T.font >= 17 ? 9 : 8;
    function head(id) {
      return '<marker id="' + id + '" class="' + id + '" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="' + ah2 + '" markerHeight="' + ah2 + '" orient="auto-start-reverse">' +
        '<path d="M0 1 L9 5 L0 9 z" fill="currentColor"/></marker>';
    }
    var svg = '<svg class="edges" width="' + Lay.W + '" height="' + Lay.H + '" viewBox="0 0 ' + Lay.W + ' ' + Lay.H + '">' +
      '<defs>' + head('parr-u') + '<filter id="pglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>';
    topo.edges.forEach(function (e, i) {
      var r = Lay.edges[i];
      if (!r) return;
      svg += '<g class="edge' + (r.routed ? ' routed' : '') + '" data-edge="' + i + '"><path class="glow" d="' + r.d + '"/><path class="ln" d="' + r.d + '"/><path class="flow" d="' + r.d + '"/>' +
        (r.edges.some(function (k) { return topo.edges[k].description; }) ? '<path class="hit" d="' + r.d + '"/>' : '') + '</g>';
    });
    svg += '</svg>';
    var boxes = topo.nodes.map(function (n) {
      var p = Lay.pos[n.id], actor = L.actorOf(n);
      return '<div class="gnode snode a-' + esc(actor) + ' kind-' + esc(n.kind || 'step') + '" data-node="' + esc(n.id) + '" tabindex="0" role="button" title="' + esc(L.plainLabel(n)) + '" style="left:' + p.x + 'px;top:' + p.y + 'px;width:' + G.w + 'px;height:' + G.h + 'px">' +
        '<span class="s-num"></span><div class="s-body"><div class="gl"><span class="gt">' + esc(L.plainLabel(n)) + '</span></div><div class="s-meta"></div></div>' +
        '<span class="actor actor-' + esc(actor) + '">' + esc(ACTOR_CHIP[actor] || actor) + '</span><span class="s-back" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg></span></div>';
    }).join('');
    var tkey = (view === 'map' ? 'roomy' : 'compact') + (T === BOX_TYPE.roomyW || T === BOX_TYPE.compactW ? ' t-wide' : '') + (G.lines > 1 ? ' t-two' : '');
    var labels = this._edgeLabels(Lay, G, T);
    g.innerHTML = '<div class="graph t-' + tkey + '" style="width:' + Lay.W + 'px;height:' + Lay.H + 'px">' + svg + labels + boxes + '</div>';
    var gr = g.querySelector('.graph');
    /* Lines that meet on their way into one step share their last runs: their dashes are measured from
       that end, so where they overlap the dashes coincide (out of phase, they'd fill in to a solid line). */
    var into = {};
    Lay.edges.forEach(function (r) { if (r) into[r.to] = (into[r.to] || 0) + 1; });
    g.querySelectorAll('svg.edges .edge').forEach(function (eg) {
      var r = Lay.edges[+eg.getAttribute('data-edge')], ln = eg.querySelector('path.ln');
      if (!r || !ln || !ln.getTotalLength) return;
      var len = 0;
      try { len = ln.getTotalLength(); } catch (e) { return; }
      eg._len = len;
      if (into[r.to] >= 2) ln.style.strokeDashoffset = ((11 - (len % 11)) % 11).toFixed(2);
    });
    // Fit the map in its room, by width and height, never above its size. A floor for a projector:
    // a name is never drawn under MIN_NAME_PX; a map too tall for that scrolls in its region instead,
    // keeping the step it's on in view.
    // The room is measured once here, before any glide: while the region's height animates, a fit
    // would read the wrong height. A resize (of the window, or of the stage) draws the map again.
    // The line under the whole map takes its height now, not on the render after this draw: measured
    // without it, the map coming back from a detail was fitted to room the line then took.
    if (!E.eng && this.p.now) {
      if (view === 'map' && !this.p.now.firstChild) { this.p.now.innerHTML = '<div class="now"></div>'; this.p.now._h = null; }
      else if (view !== 'map' && this.p.now.firstChild) { this.p.now.innerHTML = ''; this.p.now._h = null; }
    }
    var roomH = g.clientHeight - 4;
    function fit() {
      var availW = g.clientWidth - 8 || Lay.W, availH = roomH;
      var kw = Math.min(1, availW / Lay.W), k = Math.min(kw, availH > 40 ? availH / Lay.H : 1);
      var floor = (T.meta ? MIN_NAME_PX - 0.5 : MIN_NAME_PX) / T.font, scroll = k < floor && kw > k;
      if (scroll) k = Math.min(kw, floor);
      g.classList.toggle('scrolly', scroll);
      k = Math.max(k, 0.3);
      self._fitK = k;
      gr.style.transform = k !== 1 ? 'scale(' + k + ')' : '';
      gr.style.transformOrigin = 'top left';
      gr.style.marginLeft = Math.max(0, (availW - Lay.W * k) / 2) + 'px';
      gr.style.marginBottom = k !== 1 ? (-(1 - k) * Lay.H) + 'px' : '';
    }
    this._fit = fit;
    fit();
    this._bindResize();
    // Glide: each box from its old place and size to its new one (FLIP), the map's region with it.
    if (before) {
      var k = this._fitK || 1;
      g.querySelectorAll('.gnode').forEach(function (n) {
        var a = before.nodes[n.getAttribute('data-node')], b = n.getBoundingClientRect();
        if (!a || !b.width || !b.height) return;
        var dx = (a.left - b.left) / k, dy = (a.top - b.top) / k, sx = a.width / b.width, sy = a.height / b.height;
        n.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')', transformOrigin: '0 0' },
                   { transform: 'none', transformOrigin: '0 0' }], { duration: GLIDE_MS, easing: EASE });
      });
      var fade = [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }];
      g.querySelectorAll('svg.edges, .elabel').forEach(function (x) { x.animate(fade, { duration: GLIDE_MS + 120, easing: 'ease-out' }); });
      var hNow = sec.getBoundingClientRect().height;
      if (Math.abs(hNow - before.h) > 2) sec.animate([{ height: before.h + 'px' }, { height: hNow + 'px' }], { duration: GLIDE_MS, easing: EASE });
    }
    this._instant = true;   // the lines lit on the new map were lit already
    /* A step opens its detail; the step the detail is already about (the ringed one) is the way back
       to the whole map: click it again (or Enter on it). On hover or keyboard focus it says so in a
       small tag inside its box (index.html: .s-back). */
    function act(n, keyed) {
      var id = n.getAttribute('data-node');
      if (self.mode === 'engineering') { self.selectedNode = self.selectedNode === id ? null : id; self.render(); return; }
      if (self.view === 'detail' && n.classList.contains('focus')) self.setView('map');
      else {
        self.selectedNode = id; self.recapOpen = false; self.presItem = null; self.overlay = null; self.keysOpen = false;
        if (self.view !== 'detail') self.setView('detail'); else self.render();
      }
      // A keyboard user keeps their place: the same step, on the map just drawn.
      if (keyed) { var again = E.graph.querySelector('.gnode[data-node="' + id.replace(/"/g, '\\"') + '"]'); if (again) again.focus({ preventScroll: true }); }
    }
    g.querySelectorAll('.gnode').forEach(function (n) {
      n.onclick = function () { act(n, false); };
      n.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); act(n, true); } };
    });
    // A path's own words on hover or tap: on a dashed path, why it wasn't taken.
    var tip = E.tip;
    g.querySelectorAll('.edge').forEach(function (eg) {
      var i0 = +eg.getAttribute('data-edge'), r = Lay.edges[i0];
      var eds = ((r && r.edges) || [i0]).map(function (k) { return topo.edges[k]; }).filter(function (x) { return x.description; });
      if (!eds.length) return;
      function show(ev) {
        if (Date.now() - (self._drawnAt || 0) < 900 && ev.type !== 'click') return;   // the map just moved under a still pointer
        var cls = eg.getAttribute('class');
        var state = /untaken/.test(cls) ? 'Not taken this time' : /\btaken\b/.test(cls) ? 'Taken' : 'Path';
        tip.innerHTML = eds.map(function (ed, j) {
          return '<b>' + esc(j ? 'Or' : state) + (ed.plain_label || ed.from_branch ? ': ' + esc(ed.plain_label || ed.from_branch.replace(/_/g, ' ')) : '') + '</b> ' + esc(ed.description);
        }).join('<br>');
        tip.hidden = false;
        var rb = sec.getBoundingClientRect();
        tip.style.left = Math.min(Math.max(4, ev.clientX - rb.left + 10), Math.max(4, rb.width - 340)) + 'px';
        tip.style.top = (ev.clientY - rb.top + 12) + 'px';
      }
      eg.addEventListener('mouseenter', show);
      eg.addEventListener('mousemove', show);
      eg.addEventListener('mouseleave', function () { tip.hidden = true; });
      eg.addEventListener('click', function (ev) { ev.stopPropagation(); show(ev); });
    });
    sec.onclick = function (ev) { if (!ev.target.closest('.edge')) tip.hidden = true; };
  };

  /* A plate on each branch's line with its words. Placed on the line's own straight runs, never over a
     box or another label: a run in a gap between rows first (where the line turns across), else a
     vertical run; on several candidate points along each. A label with no clear place is left off
     (the panel names every branch, and a hover on the line gives its words). */
  Bench.prototype._edgeLabels = function (Lay, G, T) {
    // index.html: .t-roomy .elabel and .t-compact .elabel (a plate that fits in the gap between rows)
    var fs = !T ? 13 : T.meta ? (T.font >= 17 ? 13 : 12.5) : 12, PH = !T ? 25 : fs + (T.meta ? 9 : 7);
    var topo = this.topo, ctx = measureCtx(), M = T ? 3 : 6, out = '', placed = [];
    var boxes = topo.nodes.map(function (n) { var p = Lay.pos[n.id]; return p ? [p.x - M, p.y - M, p.x + G.w + M, p.y + G.h + M] : null; }).filter(Boolean);
    function hits(r) {
      return boxes.concat(placed).some(function (b) { return r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1]; });
    }
    if (ctx) ctx.font = '400 ' + fs + 'px "Geist Mono", ui-monospace, monospace';
    Lay.edges.forEach(function (r, i) {
      if (!r) return;
      var text = global.BenchLayout.edgeText(topo, r, true);
      if (!text) return;
      var w = (ctx ? ctx.measureText(text).width : text.length * fs * 0.6) + (T ? 14 : 18), h = PH;
      // The straight runs of the line, longest first; a horizontal run first.
      var runs = [];
      r.pieces.forEach(function (p) {
        var a = p[0], b = p[3];
        if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 20) runs.push({ v: true, x: a[0], y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
        else if (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > 20) runs.push({ v: false, y: a[1], x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
      });
      // A run another line also draws (lines merging into one step) is a poor place for a label: it can't
      // say which line it names. Runs of its own first.
      runs.forEach(function (run) {
        run.shared = Lay.edges.some(function (o, j) {
          return o && j !== i && o.pieces.some(function (p) {
            var a2 = p[0], b2 = p[3];
            if (run.v) return Math.abs(a2[0] - b2[0]) < 0.5 && Math.abs(a2[0] - run.x) < 0.5 && Math.min(run.y1, Math.max(a2[1], b2[1])) - Math.max(run.y0, Math.min(a2[1], b2[1])) > 12;
            return Math.abs(a2[1] - b2[1]) < 0.5 && Math.abs(a2[1] - run.y) < 0.5 && Math.min(run.x1, Math.max(a2[0], b2[0])) - Math.max(run.x0, Math.min(a2[0], b2[0])) > 12;
          });
        });
      });
      runs.sort(function (a, b) { return (a.shared - b.shared) || (a.v - b.v) || ((b.v ? b.y1 - b.y0 : b.x1 - b.x0) - (a.v ? a.y1 - a.y0 : a.x1 - a.x0)); });
      var spot = null;
      runs.some(function (run) {
        return [0.5, 0.35, 0.65, 0.22, 0.78].some(function (t) {
          var cands = [];
          if (run.v) {
            var y = run.y0 + (run.y1 - run.y0) * t;
            // On the line first (the plate breaks it, so the words belong to it), else beside it.
            cands.push({ x: run.x, y: y, side: false, r: [run.x - w / 2, y - h / 2, run.x + w / 2, y + h / 2] });
            cands.push({ x: run.x + 10, y: y, side: true, r: [run.x + 10, y - h / 2, run.x + 10 + w, y + h / 2] });
          } else {
            var x = run.x0 + (run.x1 - run.x0) * t;
            if (run.x1 - run.x0 < w + 8) { if (t !== 0.5) return false; }
            cands.push({ x: x, y: run.y, side: false, r: [x - w / 2, run.y - h / 2, x + w / 2, run.y + h / 2] });
          }
          var c = cands.filter(function (c) { return !hits(c.r); })[0];
          if (c) spot = c;
          return !!c;
        });
      });
      if (!spot) return;
      placed.push([spot.r[0] - 4, spot.r[1] - 4, spot.r[2] + 4, spot.r[3] + 4]);
      out += '<div class="elabel' + (spot.side ? ' side' : '') + '" data-edge="' + i + '" style="left:' + spot.x.toFixed(1) + 'px;top:' + spot.y.toFixed(1) + 'px">' + esc(text) + '</div>';
    });
    return out;
  };

  // The map's state for what's shown: lit path, numbers in run order, a line under each name.
  Bench.prototype._renderStage = function (run) {
    var self = this, E = this._E(), g = E.graph, L = lg(), topo = this.topo;
    var S = this._shown(run), now = S.now, ran = S.ran, finished = S.finished;
    // A finished run's lit path breathes a little (index.html: .run-done).
    var done = !!(run && finished);
    if (g.classList.contains('run-done') !== done) g.classList.toggle('run-done', done);
    var taken = this._taken(S), nums = L.stepNumbers(S.seq);
    var order = topo.nodes.map(function (n) { return n.id; });
    if (this.layout) order.sort(function (a, b) { var pa = self.layout.pos[a], pb = self.layout.pos[b]; return pa && pb ? (pa.y - pb.y) || (pa.x - pb.x) : 0; });
    var letters = finished ? L.stepLetters(topo, nums, order) : {};
    var focus = this.recapOpen && !E.eng ? null : (this.selectedNode || S.focusNode);
    /* One marker: the step the text under the map is about is ringed in its actor's colour, its badge
       filled. On the whole map a step running is marked by its own glow, and a finished run's line is
       about the run, not a step: no ring then. */
    var whole = this._viewNow() === 'map', still = /^(paused|moment|stepping)$/.test(this._tstateShown || this.tstate || '');
    var ring = whole && !this.selectedNode && (finished || !still) ? null : focus;
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
      else if (S.quiet && (S.starting[id] || shownOpen)) cls += ' stalled';
      else if (S.starting[id]) cls += ' starting';
      else if (shownOpen) cls += ' active';
      else cls += ' done';
      if (ring === id && !(whole && !self.selectedNode && (shownOpen || S.starting[id]))) cls += ' focus';
      if (self.selectedNode === id) cls += ' selected';
      /* The running sweep keeps its phase from the step's own start, so a redraw of the map (the
         stage resizing as the request arrives re-creates the boxes) never restarts it mid-pass.
         Set once per step on each box: changing a running animation's delay would jump it. */
      if (/ (active|starting)\b/.test(cls) && last && n._sweepFor !== last.id) {
        n._sweepFor = last.id;
        n.style.setProperty('--sweep-delay', -Math.max(0, Math.round(now - last.vs)) + 'ms');
      }
      if (n.className !== cls) n.className = cls;
      // The ringed step in the detail is the way back to the whole map (a click, Enter or Space).
      var back = !E.eng && !whole && ring === id, al = String(L.plainLabel(node)) + (back ? '. Shown below; activate for the whole map' : '');
      if (n.getAttribute('aria-label') !== al) n.setAttribute('aria-label', al);
      var chip = n.querySelector('.actor'), cw = ACTOR_CHIP[actor] || actor;
      if (chip && chip.textContent !== cw) { chip.textContent = cw; chip.className = 'actor actor-' + actor; }
      var num = n.querySelector('.s-num');
      var nv = nums[id] ? String(nums[id]) : (letters[id] || '');
      if (num.textContent !== nv) num.textContent = nv;
      // The line under the name: its time, then what's worth a glance (logic.stepMeta).
      var running = !!(shownOpen || S.starting[id]);
      var m = L.stepMeta(topo, S.events, id, steps, { finished: finished, running: running, quiet: !!S.quiet,
        runningMs: running && last.arr > 0 && last.arrEnd == null ? (S.quiet ? S.quiet.at : now) - last.arr : null });
      var html = (m.v ? '<span class="v">' + esc(m.v) + '</span>' : '') + m.rest.map(function (x) { return ' · ' + esc(x); }).join('') +
        (m.pips ? '<span class="pips">' + m.pips.map(function (k) { return '<i class="' + k + '"></i>'; }).join('') + '</span>' : '');
      setHTML(n.querySelector('.s-meta'), html);
    });
    // Lines: this run's path lit; the one into the step being shown running marches (to a person's
    // step in their colour); a line newly lit draws on from its source.
    var lit = {}, fresh = [];
    g.querySelectorAll('.edge').forEach(function (e) {
      var i0 = +e.getAttribute('data-edge'), ed = topo.edges[i0], r = self.layout && self.layout.edges[i0];
      var k = ed.from + '>' + ed.to;
      var described = ((r && r.edges) || [i0]).some(function (j) { return topo.edges[j] && topo.edges[j].description; });
      var toPerson = L.actorOf(L.nodeOf(topo, ed.to) || {}, S.events) === 'person';
      var flowing = taken[k] && (S.openNode === ed.to || S.starting[ed.to]) && !finished && !S.quiet;
      var c = 'edge' + (taken[k] ? ' taken' + (flowing ? ' flowing' + (toPerson ? ' to-person' : '') : '') : finished ? ' untaken' : '') + (described ? ' described' : '');
      if (e.getAttribute('class') !== c) e.setAttribute('class', c);
      if (taken[k]) { lit[i0] = true; if (!self._edgeLit[i0]) fresh.push(e); }
    });
    var instant = this._instant || fresh.length > 2;
    this._instant = false;
    this._edgeLit = lit;
    g.querySelectorAll('.elabel').forEach(function (lb) {
      var i0 = +lb.getAttribute('data-edge'), ed = topo.edges[i0];
      lb.classList.toggle('lit', !!taken[ed.from + '>' + ed.to]);
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
    if (!instant && !reducedMotion()) fresh.forEach(function (e) {
      var len = e._len || 0;
      if (!len) return;
      e.querySelectorAll('path.ln, path.glow').forEach(function (pth) {
        pth.style.strokeDasharray = len + ' ' + len;
        var a = pth.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: DRAW_MS, easing: 'cubic-bezier(.4,0,.2,1)' });
        a.onfinish = a.oncancel = function () { pth.style.strokeDasharray = ''; };
      });
    });
    this._placeCue(run, S, finished);
    // Quiet: nothing moves until the app speaks again (push renders then), so the clock stops ticking.
    var busy = !S.quiet && (S.shownEnd > now || run.stepOrder.some(function (sid) { return run.steps[sid].arrEnd == null; }));
    clearTimeout(this._tick);
    if (busy) this._tick = setTimeout(function () { self.render(); }, 100);
    // A scrolling map keeps the step the panel is on in view when that step changes.
    if (focus !== this._focusShown) {
      this._focusShown = focus;
      var fe = focus && g.classList.contains('scrolly') && g.querySelector('.gnode.focus');
      if (fe) { var gb = g.getBoundingClientRect(), fb = fe.getBoundingClientRect(); if (fb.top < gb.top + 8 || fb.bottom > gb.bottom - 8) g.scrollTop += fb.top - gb.top - gb.height / 2 + fb.height / 2; }
    }
    S.focus = focus;
    S.numbers = nums;
    S.letters = letters;
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
    if (act === 'given') { this.overlay = { focus: arg || null }; this.bigText = this.bigText || false; }
    else if (act === 'close') { this.overlay = null; }
    else if (act === 'item') { this.presItem = this.presItem === arg ? null : arg; }
    else if (act === 'clearsel') { this.selectedNode = null; this.overlay = null; }
    else if (act === 'sel') { this.selectedNode = arg; this.overlay = null; this.presItem = null; this.recapOpen = false; }
    else if (act === 'open') { this.selectedNode = arg || null; this.recapOpen = false; this.setView('detail'); return; }
    else if (act === 'mapview') { this.setView('map'); return; }
    else if (act === 'more') { this.moreOpen = !this.moreOpen; }
    else if (act === 'bigtext') { this.bigText = !this.bigText; }
    else if (act === 'maponly') { this.toggleMapOnly(); return; }
    else if (act === 'recap') { this.openRecap(!this.recapOpen); return; }
    else if (act === 'keys') { this.keysOpen = !this.keysOpen; if (this.keysOpen && this.view !== 'detail') { this.setView('detail'); return; } }
    else if (act === 'stepthrough') { this.selectedNode = null; this.recapOpen = false; this.overlay = null; this.stepThrough(); return; }
    else if (this.transport && this.transport[act]) { this.selectedNode = null; this.recapOpen = false; this.presItem = null; this.overlay = null; this.transport[act](); return; }
    else return;
    this.render();
  };

  // M: the whole map, or the map compact with the detail under it.
  Bench.prototype.toggleMapOnly = function () { this.setView(this.view === 'map' ? 'detail' : 'map'); };
  Bench.prototype.openRecap = function (on) {
    this.recapOpen = on !== false; this.selectedNode = null; this.overlay = null;
    if (this.recapOpen && this.view !== 'detail' && this.mode === 'presentation') this.setView('detail'); else this.render();
  };

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
      else if (this.mode === 'presentation' && this.view === 'detail') { this.setView('map'); return; }
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
    // A step clicked: ← → walk the run's path from it (past the last step, the recap).
    if (this.selectedNode) {
      var shown = this._lastShown, seq = shown ? shown.seq : [], i = seq.indexOf(this.selectedNode);
      if (i < 0) { this.selectedNode = null; this.render(); return; }
      var j = i + (fwd ? 1 : -1);
      if (j >= 0 && j < seq.length) { this.selectedNode = seq[j]; this.render(); return; }
      if (fwd && shown.finished) this.openRecap(true);
      return;
    }
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

    // The bar: who asked and what (beside a live app its own pane shows them), and where it stands.
    var req = run ? L.requestOf(run.events, topo) : { text: null, who: '' };
    var beside = this.source === 'parent';
    var rlen = req.text ? req.text.length : 0;
    p.req.className = 'ps-req' + (rlen > 320 ? ' r-xlong' : rlen > 170 ? ' r-long' : '');
    // Beside the app: the request too (two lines at most; the app shows it whole), so the room knows
    // which request the map is about without looking across.
    if (beside) p.req.className += ' r-beside';
    p.req.title = beside && req.text ? req.text : '';
    setHTML(p.req, req.text ? '“' + esc(req.text.replace(/\s+/g, ' ')) + '”' : '<span class="muted">' + (run ? '' : beside ? 'Waiting for the app to run…' : 'Waiting for a request…') + '</span>');
    var who = String(req.who || '').split(' · ').filter(Boolean);
    setHTML(p.who, who.length ? '<b>' + esc(who[0]) + '</b>' + who.slice(1).map(function (x) { return ' · ' + esc(x); }).join('') : '');
    var oc = run ? L.outcome(topo, events) : { text: '', done: false };
    var st = !run ? { cls: 'idle', text: 'Waiting for a request' }
      : oc.done ? { cls: /^Handed/.test(oc.text) ? 'handed' : /^Stopped before/.test(oc.text) ? 'paused' : /^(Stopped|Something)/.test(oc.text) ? 'bad' : 'ok', text: pillWords(oc.text), full: oc.text }
      : /^Waiting/.test(oc.text) ? { cls: 'waiting', text: 'Waiting for a person to approve' }
      : S && S.quiet ? QUIET_PILL
      : (tstate === 'paused' || tstate === 'moment' || tstate === 'stepping') ? { cls: 'paused', text: 'Paused' + (S && S.focusNode && S.numbers && S.numbers[S.focusNode] ? ' at step ' + S.numbers[S.focusNode] : '') }
      : { cls: 'running', text: oc.text === 'Something went wrong' ? oc.text : 'Running' };
    setHTML(p.status, '<span class="ps-pill st-' + st.cls + '" title="' + esc(st.full || st.text) + '"><i></i><b>' + esc(st.text) + '</b></span>');
    // The map's heading: how many steps the app has, how many this run took.
    setHTML(p.flowhead, this._flowheadHTML(run, S));
    setHTML(p.transport, this._transportHTML(finished, run, S));
    var focusSeq = this._focusSeq(run, S);
    setHTML(p.bottom, run ? this._bottomHTML(run, events, finished, S, focusSeq) : '');
    setHTML(p.strip, run ? this._stripHTML(run, S, focusSeq) : '');
    this.root.querySelectorAll('.ps-key').forEach(function (b) {
      var a = b.getAttribute('data-act');
      b.classList.toggle('on', a === 'maponly' ? self.view === 'map' : a === 'recap' ? !!self.recapOpen : !!self.keysOpen);
    });
    // The whole map's line: what the step it's on did (or how the run ended), one click from its detail.
    setHTML(p.now, this.view === 'map' ? this._nowHTML(run, events, finished, S, tstate) : '');

    // The panel (or the recap): the selected step, else the step the run is on.
    var html, focusActor = null;
    if (!run) html = '<div class="bb bb-empty"><p class="bb-headline">' + (beside ? 'Nothing has run yet. When the app runs, this side shows what the AI does.' : 'Nothing has run yet.') + '</p></div>';
    else if (this.recapOpen) html = this._recapHTML(run, events, finished, S);
    else if (S.focus) { html = this._bubbleHTML(run, events, S.focus, finished, S); focusActor = L.actorOf(L.nodeOf(topo, S.focus), events); }
    else html = '<div class="bb bb-empty"><p class="bb-headline">Starting…</p></div>';
    if (this.keysOpen) html = '<div class="bb ps-keys"><div class="bb-head"><span class="bb-name">Keys</span><button class="p-x" data-act="keys" title="Close (Esc)">✕</button></div>' +
      '<section class="bb-sec"><dl class="bb-fields">' + KEYS_HELP.map(function (x) { return '<dt><kbd>' + esc(x[0]) + '</kbd></dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl></section></div>';
    var prevFocus = p.bubble._focus;
    if (this.view !== 'detail') html = '';
    setHTML(p.bubble, html);
    // A new step's panel opens at its top, rising in (the old one gone at once).
    var fkey = this.view + (this.keysOpen ? 'keys' : '') + (this.recapOpen ? 'recap' : '') + (S && S.focus);
    if (prevFocus !== fkey) {
      p.bubble.scrollTop = 0; p.bubble._focus = fkey;
      var card = p.bubble.firstChild;
      if (prevFocus != null && card && card.animate && !reducedMotion()) card.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
    }
    p.bubble.classList.toggle('is-recap', !!(run && this.recapOpen));
    p.stage.className = 'ps-stage' + (focusActor && !this.keysOpen ? ' a-' + focusActor : '');
    // "What the AI was given": a drawer over the detail only; the map stays in view.
    var dr = p.drawer, open = !!(this.overlay && run && this.view === 'detail');
    if (open) {
      var was = dr.classList.contains('open');
      setHTML(dr, this._drawerHTML(run, events, S));
      if (!was) { dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false'); var db = dr.querySelector('.dr-body'); if (db) db.scrollTop = 0; }
    } else if (dr.classList.contains('open')) { dr.classList.remove('open'); dr.setAttribute('aria-hidden', 'true'); }
    if (this._fit) this._fit();
    this._placeCue(run, S, finished);
    this._moreCue();
  };
  // The panel's "more below" cue: shown while its content runs past its foot (its scrollbar is hidden).
  Bench.prototype._moreCue = function () {
    var b = this.p.bubble, m = this.p.more;
    if (!b || !m) return;
    var hide = this.view !== 'detail' || !!this.overlay || b.scrollHeight - b.clientHeight - b.scrollTop < 6;
    if (m.hidden !== hide) m.hidden = hide;
  };

  // The old divider-and-pointer marker is gone (one marker: the ring on the box). Kept for callers.
  Bench.prototype._placeMarker = function () {};

  /* "Your turn": while the run waits for a person, a cue beside the waiting step on the whole map,
     on the side the app is (its left), else under the step. The detail view's card says it instead. */
  Bench.prototype._placeCue = function (run, S, finished) {
    var E = this._E(), cue = E.cue;
    if (!cue) return;
    var gw = !E.eng && this._viewNow() === 'map' && !finished && E.graph.querySelector('.gnode.gatewait');
    if (!gw) { if (!cue.hidden) cue.hidden = true; return; }
    setHTML(cue, (this.source === 'parent' ? '<span class="ar" aria-hidden="true">◀</span>' : '') + '<b>Your turn:</b> approve or deny it in the app');
    cue.hidden = false;
    var mr = E.map.getBoundingClientRect(), nr = gw.getBoundingClientRect(), cw = cue.offsetWidth, ch = cue.offsetHeight;
    var left = nr.left - mr.left - cw - 14, top = nr.top - mr.top + nr.height / 2 - ch / 2;
    if (left < 6) { left = Math.max(6, Math.min(nr.left - mr.left, mr.width - cw - 6)); top = nr.bottom - mr.top + 8; }
    cue.style.left = Math.round(left) + 'px'; cue.style.top = Math.round(top) + 'px';
  };

  /* Replay: ◀ prev, play, next ▶, ↻ (keys: ← → or PageUp/PageDown, Space = next). Beside the app or
     live, there is no transport, but a finished run (or one waiting for a person) can be stepped
     through here. */
  function svgI(d) { return '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><path d="' + d + '"/></svg>'; }
  var ICON = { restart: svgI('M4.5 4.5v4.5H9M4.9 8.8A6 6 0 1 1 4.6 12') };
  Bench.prototype._transportHTML = function (finished, run, S) {
    if (!this.transport) {
      var idle = run && S && S.caught && (finished || (run.gate && run.gate.state === 'waiting'));
      return idle && global.BenchSources ? '<button data-act="stepthrough" class="main" title="Replay this run here, one step at a time, pausing at the moments that matter (the app stays as it is)">▶ Step through it</button>' : '';
    }
    var s = this._tstateShown || this.tstate;
    var playing = s === 'playing', catching = s === 'catching';
    var started = run && run.events.length > 0;
    return '<button data-act="back" title="Back one step (← or PageUp)" aria-label="Back one step">◀ prev</button>' +
      (playing ? '<button data-act="pause" class="main" title="Pause">❚❚ pause</button>'
               : catching ? '<button class="main" disabled title="Finishing">❚❚ playing</button>'
               : s === 'done' ? '<button data-act="restart" class="main" title="Play it again from the start">' + ICON.restart + ' replay</button>'
               : '<button data-act="play" class="main" title="Play; it pauses at the moments that matter">▶ ' + (started ? 'continue' : 'play') + '</button>') +
      '<button data-act="next" title="Forward one step (→, Space or PageDown)" aria-label="Forward one step">next ▶</button>' +
      (s === 'done' ? '' : '<button data-act="restart" title="Start over from the first step" aria-label="Start over">' + ICON.restart + '</button>') +
      (this.transport.speed ? '<button data-act="speed" class="speed" title="Playing speed">' + (this.speedNow || 1) + '×</button>' : '') +
      (this.transport.follow ? '<button data-act="follow" title="Stop stepping through and follow the app again">' + (this.source === 'parent' ? '✕ follow the app' : '✕ back to live') + '</button>' : '');
  };

  // ---- the panel ---------------------------------------------------------------------------------
  var STATUS_TAG = { now: 'running', done: 'done', waiting: 'waiting for a person', last: 'done', not_needed: 'not reached this run', pending: 'not reached yet', error: 'error' };
  function para(h) {
    return h.map(function (x) { return x.em ? '<em>' + esc(x.t) + '</em>' : x.next ? '<span class="nx">' + esc(x.t) + '</span>' : esc(x.t); }).join('');
  }
  function sec(label, body, cls) { return '<section class="bb-sec' + (cls ? ' ' + cls : '') + '"><h4>' + label + '</h4>' + body + '</section>'; }
  function chip(title, cls) { return '<span class="bb-chip' + (cls ? ' ' + cls : '') + '">' + esc(title) + '</span>'; }
  function metas(items) { items = items.filter(Boolean); return items.length ? '<div class="bb-metas">' + items.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>' : ''; }
  // A long text (an answer, a description) folds after a few lines; "more" opens it.
  function foldText(text, open, cls) {
    var long = String(text).length > 260;
    return '<div class="bb-text' + (cls ? ' ' + cls : '') + (long && !open ? ' folded' : '') + '">' + esc(text) + '</div>' +
      (long ? '<button class="bb-more" data-act="more">' + (open ? 'less ▴' : 'more ▾') + '</button>' : '');
  }
  var CHECK_SYM_P = { passed: '✓ passed', failed: '✕ failed', not_on_path: '– not needed' };
  function ucfirst(s) { return String(s || '').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function stepMs(run, id) {
    return (run.nodeSteps[id] || []).map(function (sid) { return run.steps[sid]; }).filter(function (s) { return s && !s.parent; })
      .reduce(function (a, s) { return a + (s.latency != null ? s.latency : s.end != null ? (s.end - s.start) * 1000 : 0); }, 0);
  }
  // A step's badge in the panel: its number in run order, else its letter (untaken), else blank.
  function badgeOf(S, id) { return (S.numbers && S.numbers[id]) ? String(S.numbers[id]) : (S.letters && S.letters[id]) || ''; }
  function sectionFace(title) { var m = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(String(title || '')); return m ? { face: '§' + m[1], rest: m[2] } : { face: '', rest: String(title || '') }; }

  // The call sequence of the step the panel is about, when that step is an agent loop.
  Bench.prototype._focusSeq = function (run, S) {
    if (!run || !S || !S.focus || this.recapOpen) return null;
    var steps = (S.ran[S.focus] || []).filter(function (s) { return !s.parent; });
    var last = steps[steps.length - 1];
    if (!last) return null;
    var seq = lg().callSequence(S.events, last.id);
    return lg().isCallLoop(seq) ? seq : null;
  };

  /* A search step's documents, the same for every app (logic.documentsStep): counts, then what was
     given to the AI best match first (grouped by file when a source has many files), then the whole
     source as tiles (numbered sections) or the matched files. A tile opens what it says. */
  Bench.prototype._documentsHTML = function (m, st, run, id, showStats) {
    var self = this, L = lg(), c = m.counts;
    var stItems = {};
    ((st && st.items) || []).forEach(function (it) { stItems[it.id] = it; });
    var out = '';
    if (showStats !== false) {
      // Before the AI has been asked anything, "given" isn't unknown: it hasn't happened yet.
      var shownAsked = this._lastShown && this._lastShown.events.some(function (e) { return e.event_type === 'llm_call'; });
      if (!shownAsked && c.given == null) c = Object.assign({}, c, { notYet: true });
      var givenNum = c.notYet ? '<div class="num">' + c.found + '</div><div class="what">found · <span class="unk">not given to the AI yet</span></div>' : c.given != null ? '<div class="num">' + c.given + '</div><div class="what">given to the AI</div>' : '<div class="num">' + c.found + '</div><div class="what">found <span class="unk">· given to the AI not known</span></div>';
      out += '<div class="bb-stats"><div class="bb-stat"><div class="num">' + (c.items != null ? L.fmtNum(c.items) : c.found) + '</div><div class="what">' + (c.items != null ? esc(c.unit) + ' searched' + (c.documents > 1 ? ' in ' + L.fmtNum(c.documents) + ' files' : '') : 'found') + '</div></div>' +
        '<div class="bb-stat g">' + givenNum + '</div><div class="bb-stat r"><div class="num">' + c.relied + '</div><div class="what">relied on</div></div></div>';
    }
    if (m.source.description) out += '<p class="bb-sub" style="margin-top:14px">' + esc(m.source.description) + '</p>';
    var label = c.given ? 'Given to the AI · best match first' : 'Found by the search · best match first';
    function tags(pv, extra) {
      return '<div class="tags">' + (pv.relied ? '<span class="tg rel">relied on</span>' : '') + (extra || '') +
        (pv.score != null ? '<span>score ' + esc(Number(pv.score).toFixed(Math.abs(pv.score) >= 1 ? 2 : 4)) + '</span>' : '') + '</div>';
    }
    var rows = '';
    if (m.passages) {
      rows = m.passages.map(function (pv) {
        var f = m.layout === 'sections' ? sectionFace(pv.title) : { face: '', rest: pv.title };
        return '<div class="bb-row' + (pv.relied ? ' relied' : '') + (pv.state === 'found' ? ' found' : '') + '"><div class="rk">#' + pv.rank + '</div><div><div class="loc">' +
          (f.face ? '<span class="face">' + esc(f.face) + '</span>' : '') + '<span>' + esc(f.rest) + '</span></div>' +
          (pv.snippet ? '<div class="snip">' + esc(pv.snippet) + '</div>' : '') + '</div>' + tags(pv) + '</div>';
      }).join('');
    } else {
      var rankOf = {};
      m.documents.forEach(function (d) { rankOf[d.file] = d.best_rank; });
      // Letters and digits only: "Refund Policy" is inside "Copy of Refund Policy FINAL_v2.md".
      function squash(t) { return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
      rows = m.documents.map(function (d) {
        var showTitle = d.title && d.title !== d.file && squash(String(d.file).replace(/^.*\//, '')).indexOf(squash(d.title)) < 0;
        var best = d.passages[0];
        // A duplicate names its twin by the row it's on: "same text as #2" (the file name is on that row).
        var same = d.same_text_in.length ? '<span class="tg dup" title="' + esc('same text in ' + d.same_text_in.join(', ')) + '">same text as ' +
          d.same_text_in.map(function (f) { return rankOf[f] != null ? '#' + rankOf[f] : f; }).join(', ') + '</span>' : '';
        return '<div class="bb-row' + (d.relied ? ' relied' : '') + (best && best.state === 'found' ? ' found' : '') + '"><div class="rk">#' + d.best_rank + '</div><div><div class="loc"><span class="face">' + esc(d.file) + '</span>' +
          (showTitle ? '<span>' + esc(d.title) + '</span>' : '') + (d.passages.length === 1 && best.location ? '<span class="part">' + esc(best.location) + '</span>' : '') + '</div>' +
          d.passages.map(function (pv) {
            return '<div class="psg">' + (d.passages.length > 1 && pv.location ? '<span class="part" style="font:400 13px var(--mono);color:var(--text-3)">' + esc(pv.location) + (pv.relied ? ' · relied on' : '') + '</span>' : '') +
              (pv.snippet ? '<div class="snip">' + esc(pv.snippet) + '</div>' : '') + '</div>';
          }).join('') + (d.more ? '<div class="more">+' + d.more + ' more from this file</div>' : '') + '</div>' + tags(Object.assign({}, best, { relied: d.relied }), same) + '</div>';
      }).join('');
    }
    if (rows) out += sec(label, '<div class="bb-rows">' + rows + '</div>');
    // The whole source.
    var tiles = '', head = '', cap = '';
    if (m.sections) {
      head = 'The whole ' + (m.source.title.length > 28 ? 'document' : esc(m.source.title)) + ' · <span class="n">' + m.sections.length + ' sections</span>';
      tiles = m.sections.map(function (s) {
        return '<button class="bb-tile st-' + esc(s.state) + (s.relied ? ' relied' : '') + (self.presItem === s.id ? ' sel' : '') + '" data-act="item" data-arg="' + esc(s.id) + '" title="' + esc(s.title) + '">' +
          esc(s.face) + (s.rank ? '<sup>#' + s.rank + '</sup>' : '') + '</button>';
      }).join('');
      cap = 'Each tile is a numbered part of the document as the app split it: the numbers are the document’s own.';
    } else if (m.documents) {
      head = 'The whole ' + (c.documents != null ? 'source · <span class="n">' + L.fmtNum(c.documents) + ' files</span>' : 'search');
      tiles = m.documents.map(function (d) {
        var st0 = d.passages.some(function (pv) { return pv.state === 'given'; }) ? 'given' : 'found';
        return '<button class="bb-tile file st-' + st0 + (d.relied ? ' relied' : '') + (self.presItem === d.passages[0].id ? ' sel' : '') + '" data-act="item" data-arg="' + esc(d.passages[0].id) + '" title="' + esc(d.title) + '">' + esc(d.file) + '<sup>#' + d.best_rank + '</sup></button>';
      }).join('') + (m.not_matched ? '<span class="bb-tile file more">+ ' + L.fmtNum(m.not_matched) + ' file' + (m.not_matched === 1 ? '' : 's') + ' not matched</span>' : '');
      var shared = {};
      m.documents.forEach(function (d) { if (d.title_shared) shared[d.title] = (shared[d.title] || 0) + 1; });
      var t = Object.keys(shared)[0];
      if (t) cap = '<b>' + ucfirst(numWord(shared[t])) + ' files are titled “' + esc(t) + '.”</b> Each row shows the file name and where in the file, because the title alone can’t tell them apart.';
      if (m.documents.some(function (d) { return d.same_text_in.length; })) cap += (cap ? ' ' : '') + 'Identical text is flagged; nothing is merged or hidden.';
    }
    if (tiles && (m.sections || (m.documents && m.documents.length > 1) || m.not_matched)) out += sec(head, '<div class="bb-tiles">' + tiles + '</div>' + (cap ? '<div class="bb-cap">' + cap + '</div>' : ''));
    var sel = this.presItem && stItems[this.presItem];
    if (sel) out += '<div class="b-item"><b>' + esc(sel.title || sel.id) + '</b> <span class="muted">' + (sel.text ? (sel.state === 'given' ? '· given to the AI, word for word' : '· found by the search') : '· not read this run') + '</span>' +
      (sel.text ? '<pre class="io">' + esc(sel.text) + '</pre>' : '') + '</div>';
    // The counts line says what the three numbers on top say: only without them.
    if (showStats === false) out += '<div class="bb-countline">' + esc(m.line) + '</div>';
    return out;
  };
  function numWord(n) { return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] || String(n); }

  /* The calls inside one step, Presentation's way: numbered in the order they started, each in plain
     words with a small bar on the step's own timeline; calls that ran at once marked. */
  Bench.prototype._sequenceHTML = function (seq) {
    var L = lg(), span = seq.span || 1;
    // A tool's own name is set as code wherever the words name it.
    var names = {};
    seq.calls.forEach(function (c) { var t = (c.ev.data || {}).tool; if (c.kind === 'tool' && t) names[t] = true; (((c.ev.data || {}).tool_calls) || []).forEach(function (x) { if (x && x.name) names[x.name] = true; }); });
    var nameRe = Object.keys(names).length ? new RegExp('(' + Object.keys(names).map(function (n) { return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).sort(function (a, b) { return b.length - a.length; }).join('|') + ')', 'g') : null;
    function coded(t) { var h = esc(t); return nameRe ? h.replace(nameRe, '<code>$1</code>') : h; }
    var rows = seq.calls.map(function (c) {
      var w = L.callWords(c, seq), k = c.kind === 'ai' ? 'var(--ai)' : 'var(--app)';
      var left = ((c.start - seq.start) / span * 100), width = c.timed ? ((c.end - c.start) / span * 100) : 0;
      return '<div class="bb-call' + (c.with.length ? ' par' : '') + (c.depth ? ' d1' : '') + '" style="--k:' + k + '"><div class="no">' + c.n + '</div>' +
        '<div class="wd"><div class="w"><span class="who2">' + (c.kind === 'ai' ? 'AI' : 'tool') + '</span><span class="wt">' + coded(w.title) + '</span>' +
        (c.with.length ? '<span class="same">same time as ' + c.with.join(', ') + '</span>' : '') + '</div>' +
        '<div class="r">' + (w.result ? (c.kind === 'ai' ? '→ ' : '') + coded(w.result) : '') + (w.tok ? ' · <span class="tk2">' + esc(w.tok) + '</span>' : '') + '</div></div>' +
        '<div class="tk"><span style="left:' + left.toFixed(2) + '%;width:' + Math.max(0.6, width).toFixed(2) + '%"></span></div><div class="d">' + (c.timed ? L.fmtMs((c.end - c.start) * 1000) : '–') + '</div></div>';
    }).join('');
    var nt = niceTicks(span);
    var axis = '<div class="bb-axis"><span></span><span></span><div class="ax">' + nt.ticks.map(function (t) {
      var x = t / span * 100;
      return x > 100.5 ? '' : '<span style="left:' + x.toFixed(2) + '%"' + (x > 90 ? ' class="end"' : '') + '>' + tickWord(t, nt.unit) + '</span>';
    }).join('') + '</div><span></span></div>';
    // Calls that ran at once, and the answer that asked for them.
    var cap = '', groups = [], seen = {};
    seq.calls.forEach(function (c) {
      if (!c.with.length || seen[c.n]) return;
      var g = [c.n].concat(c.with).sort(function (a, b) { return a - b; });
      g.forEach(function (n) { seen[n] = true; });
      groups.push(g);
    });
    groups.forEach(function (g) {
      var calls = g.map(function (n) { return seq.calls[n - 1]; });
      var asker = calls[0].askedBy && calls.every(function (c) { return c.askedBy === calls[0].askedBy; }) ? calls[0].askedBy : null;
      var names = g.slice(0, -1).join(', ') + ' and ' + g[g.length - 1];
      cap += '<b>' + names + ' ran at the same time.</b> ' + (asker ? 'The AI asked for ' + (g.length === 2 ? 'both' : 'all ' + g.length) + ' in one answer (call ' + asker + '), so the app ran them together; the step waited for the slowest. ' : '');
    });
    return axis + '<div class="bb-seq">' + rows + '</div>' + (cap ? '<div class="bb-cap">' + cap + '</div>' : '');
  };

  /* The map's heading: how many steps the app has and how many this run took; on the whole map, the
     hint; on the compact one (its boxes carry no actor word), whose each colour is, and the way back
     to the whole map. */
  Bench.prototype._flowheadHTML = function (run, S) {
    var L = lg(), topo = this.topo, eng = this.mode === 'engineering', took = S ? S.seq.length : 0;
    var left = '<span class="fh-l"><b class="fh-k">How it works</b><span>' + topo.nodes.length + ' steps</span>' + (run ? '<span>this run <b>' + took + '</b></span>' : '') + '</span>';
    if (this._viewNow() === 'map') return left + (run ? '<span class="fh-hint">Click a step to open it</span>' : '');
    var have = {};
    topo.nodes.forEach(function (n) { have[L.actorOf(n)] = true; });
    var legend = ['ai', 'app', 'rule', 'person'].filter(function (a) { return have[a]; }).map(function (a) { return '<span class="a-' + a + '"><i></i>' + esc(ACTOR_CHIP[a]) + '</span>'; }).join('');
    var fid = this.selectedNode || (S && S.focus), fnum = S && fid ? (S.numbers && S.numbers[fid]) || (S.letters && S.letters[fid]) || '' : '';
    return left + '<span class="ps-legend">' + legend + '</span>' + (eng ? '' : '<span class="fh-back" aria-hidden="true">Click ' + (fnum ? 'step ' + esc(fnum) + ' ' : 'it ') + 'again for the whole map <kbd>M</kbd></span>');
  };

  /* The line under the whole map: the step the run is on (its badge, name and headline), or how the run
     ended; a click opens the detail. */
  Bench.prototype._nowHTML = function (run, events, finished, S, tstate) {
    var L = lg(), topo = this.topo, beside = this.source === 'parent';
    if (!run) return '<div class="now idle"><div class="now-t"><div class="now-h">' + (beside ? 'Waiting for the app to run. The run plays here: each step lights up as it happens, and any step opens to show what it did.' : 'Waiting for a run.') + '</div></div></div>';
    var cont = tstate === 'moment' && this.transport ? '<button class="p-btn primary" data-act="play">Continue ▸</button>' : '';
    if (finished) {
      var oc = L.outcome(topo, events), first = S.seq[0];
      return '<div class="now done"><div class="now-t"><div class="now-name">' + esc(oc.text) + '</div><div class="now-h">' + S.seq.length + ' of ' + topo.nodes.length +
        ' steps ran. Click any step to see what it did.</div></div>' + (first ? '<button class="now-open" data-act="open" data-arg="' + esc(first) + '">Step 1 ▸</button>' : '') + '</div>';
    }
    var id = S.focusNode;
    if (!id) return '<div class="now"><div class="now-t"><div class="now-h">Starting…</div></div></div>';
    var c = L.callout(topo, events, id, { finished: finished, last: S.lastNode, numbers: S.numbers, reply: L.replyOf(run.output, topo) });
    var waiting = run.gate && run.gate.node === id && run.gate.state === 'waiting';
    var st = waiting ? 'waiting for a person' : S.openNode === id || S.starting[id] ? (S.quiet ? 'no word from the app' : 'running') : 'done';
    if (waiting) c.status = 'waiting'; else if (st === 'running') c.status = 'now';
    return '<div class="now a-' + esc(c.actor) + ' s-' + esc(c.status) + '"><span class="bb-num">' + esc(badgeOf(S, id) || '·') + '</span><div class="now-t"><div class="now-name">' + esc(c.title) +
      (st ? ' <span class="now-st">' + esc(st) + '</span>' : '') + '</div><div class="now-h">' + para(c.headline) + '</div></div>' + cont +
      '<button class="now-open" data-act="open" data-arg="' + esc(id) + '" title="Open this step (the map stays on top)">Open ▸</button></div>';
  };

  Bench.prototype._bubbleHTML = function (run, events, id, finished, S) {
    var L = lg(), topo = this.topo, self = this;
    var reply = L.replyOf(run.output, topo);
    var c = L.callout(topo, events, id, { finished: finished, last: S.lastNode, numbers: S.numbers, reply: reply });
    var node = L.nodeOf(topo, id) || {};
    var stepEvs = events.filter(function (e) { return e.node === id; });
    var ran = c.ran, ms = stepMs(run, id);
    var resolved = stepEvs.filter(function (e) { return e.event_type === 'gate_resolved'; }).pop();
    var tagText = c.status === 'done' || c.status === 'last' ? (resolved ? (resolved.data.approved ? 'approved' : 'denied') : 'done · ' + L.fmtMs(ms)) : STATUS_TAG[c.status] || c.status;
    var bn = badgeOf(S, id);
    var head = '<div class="bb-head"><span class="bb-num' + (S.numbers[id] ? '' : ' off') + '">' + esc(bn || '·') + '</span>' +
      '<span class="bb-name">' + esc(c.title) + '</span>' +
      '<span class="bb-who">' + esc(ACTOR_CHIP[c.actor] || c.actor) + '</span>' +
      '<span class="bb-tag t-' + esc(c.status) + '"><i></i>' + esc(tagText) + '</span>' +
      '<button class="bb-min" data-act="mapview" title="Back to the whole map (M)"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg><span>Map</span></button></div>';
    // A step clicked while the run goes on: one press back to following it.
    var live = this.selectedNode && !finished && S.focusNode && S.focusNode !== id;
    if (live) head += '<button class="p-follow" data-act="clearsel" title="The detail follows the run again">↻ follow the run · step ' + esc(badgeOf(S, S.focusNode)) + '</button>';
    // The step's numbers in one strip.
    var calls = stepEvs.filter(function (e) { return e.event_type === 'llm_call'; });
    var seq = S.focus === id ? this._focusSeq(run, S) : null;
    var strip = '';
    var docs = stepEvs.some(function (e) { return e.event_type === 'retrieval'; }) ? L.documentsStep(topo, events, id) : [];
    if (seq) {
      strip = metas(['<b>' + seq.calls.length + '</b> calls', '<b>' + seq.ai + '</b> to the AI · <b>' + seq.tools + '</b> tool' + (seq.tools === 1 ? '' : 's'),
                     seq.tokIn || seq.tokOut ? '<b>' + L.fmtNum(seq.tokIn) + '</b> in → <b>' + L.fmtNum(seq.tokOut) + '</b> out tok' : '',
                     seq.priced ? '<b>' + L.fmtUsd(seq.cost) + '</b>' : '', '<b>' + L.fmtMs(ms) + '</b>']);
    } else if (calls.length) {
      var tin = 0, tout = 0, cost = 0, model = null, unpriced = false;
      calls.forEach(function (e) { var d = e.data || {}; tin += d.input_tokens || 0; tout += d.output_tokens || 0; if (d.cost_usd != null) cost += Number(d.cost_usd); else unpriced = true; model = d.model || model; });
      strip = metas([model ? 'model <b>' + esc(model) + '</b>' : '', (calls.length > 1 ? '<b>' + calls.length + '</b> calls · ' : '') + '<b>' + L.fmtNum(tin) + '</b> in → <b>' + L.fmtNum(tout) + '</b> out tok',
                     unpriced ? 'cost <b>not known</b>' : '<b>' + L.fmtUsd(cost) + '</b>', '<b>' + L.fmtMs(ms) + '</b>']);
    } else if (docs.length) {
      var rt = stepEvs.filter(function (e) { return e.event_type === 'retrieval'; })[0], nh = ((rt.data || {}).hits || []).length;
      strip = metas(['source <b>' + esc(docs.map(function (m) { return m.source.title; }).join(', ')) + '</b>', 'search · <b>top ' + nh + '</b>', '<b>' + L.fmtMs(ms) + '</b>', 'no AI']);
    } else if (ran && c.status !== 'waiting' && !resolved) {
      var tool = stepEvs.filter(function (e) { return e.event_type === 'tool_call'; }).pop();
      strip = metas([tool ? 'tool <b>' + esc((tool.data || {}).tool || '') + '</b>' : '', '<b>' + L.fmtMs(ms) + '</b>', 'no AI']);
    }
    var acts = '';
    if (this._tstateShown === 'moment' && this.transport && !this.selectedNode) acts += '<button class="p-btn primary" data-act="play">Continue ▸</button>';
    if (calls.some(function (e) { var d = e.data || {}; return d.system != null || (d.messages || []).length || d.output != null; }))
      acts += '<button class="p-btn p-given" data-act="given" data-arg="' + esc(id) + '">What the AI was given <span aria-hidden="true">↑</span></button>';
    if (this.pair && c.proposal && c.proposal.state !== 'waiting') acts += '<a class="p-btn" href="' + esc(this.pair.href) + '">' + esc(this.pair.text) + '</a>';

    var headline = c.headline;
    var sub = c.sub;
    // Not reached: which step chose another way, in the map's words.
    if (!ran && finished) {
      var why = this._notReached(events, id, S);
      if (why) headline = why;
      sub = node.description || null;
    }
    if (seq) {
      var nx = (S.seq.indexOf(id) >= 0 && S.seq[S.seq.indexOf(id) + 1]) || null;
      headline = [{ t: 'It asked the AI ' }, { t: seq.ai + (seq.ai === 1 ? ' time' : ' times'), em: true }, { t: ' and used ' }, { t: seq.tools + (seq.tools === 1 ? ' tool' : ' tools'), em: true }]
        .concat(nx ? [{ t: ', then next: ' }, { t: L.plainLabel(L.nodeOf(topo, nx), nx), next: true }, { t: '.' }] : [{ t: '.' }]);
      sub = 'Here the AI picks its own next move: each answer asks for a tool or finishes. In the order each call started.';
    }
    // The sub-line says what the step does, not the picked branch's words again (its card says them).
    if (sub && c.choices.some(function (x) { return x.chosen && x.description && x.description.trim() === String(sub).trim(); })) {
      sub = node.description && node.description.length <= 180 ? node.description : null;
    }
    var body = '<p class="bb-headline">' + para(headline) + '</p>' + (sub ? '<p class="bb-sub">' + esc(sub) + '</p>' : '') + '\u0000ROW\u0000';
    var evidence = 0;
    if (seq) {
      evidence++;
      body += sec('The calls inside this step · in the order they started', this._sequenceHTML(seq));
      var lastAi = seq.calls.filter(function (x) { return x.kind === 'ai'; }).pop();
      var ended = lastAi && lastAi.ev.data && lastAi.ev.data.output != null ? L.ioText(lastAi.ev.data.output) : null;
      if (ended && !c.reply) body += sec('What it ended with', '<blockquote class="bb-quote reply">' + foldText(ended, this.moreOpen) + '<span class="qsrc">the text of call ' + lastAi.n + '</span></blockquote>');
    }
    // A sign-off's ways out are its "Next, if …" lines under the proposal, not cards.
    if (c.choices.length && ran && !c.proposal) {
      evidence++;
      var any = c.choices.some(function (x) { return x.chosen; });
      body += sec(any ? 'The ' + numWord(c.choices.length) + ' choices it had' : 'The paths it can take', '<div class="bb-cards">' + c.choices.map(function (x) {
        var tb = badgeOf(S, x.to);
        return '<div class="bb-card' + (x.chosen ? ' chosen' : x.chosen === false ? ' not' : '') + '"><div class="k">' + esc(x.label) + (x.chosen ? '<span class="bb-chosen">Picked</span>' : '') + '</div>' +
          '<div class="to">' + (tb ? '<i>' + esc(tb) + '</i>' : '→ ') + esc(x.toLabel) + '</div>' + (x.description ? '<div class="why">' + esc(x.description) + '</div>' : '') + '</div>';
      }).join('') + '</div>');
    }
    if (c.reason) {
      evidence++;
      var dec = stepEvs.filter(function (e) { return e.event_type === 'decision' && e.data && e.data.rationale; }).pop();
      var conf = dec && typeof dec.data.confidence === 'number' ? dec.data.confidence : null;
      var thr = null;
      stepEvs.forEach(function (e) { var d = e.data || {}; if (e.event_type === 'check_result' && typeof d.threshold === 'number') thr = d.threshold; });
      body += sec(c.actor === 'ai' ? 'The AI’s reason, word for word' : 'Its reason, word for word', '<blockquote class="bb-quote">' + foldText(c.reason.text, this.moreOpen) +
        '<span class="qsrc">' + esc(['the reason it gave', conf != null ? 'confidence ' + conf.toFixed(2) : ''].filter(Boolean).join(' · ')) + '</span></blockquote>' +
        (conf != null ? '<div class="bb-meter"><span>how sure</span><div class="bar"><div class="f" style="width:' + Math.max(0, Math.min(100, conf * 100)) + '%"></div>' +
          (thr != null ? '<div class="th" style="left:' + thr * 100 + '%"></div><div class="thl" style="left:' + thr * 100 + '%">' + thr + ' · below this, a person gets it</div>' : '') +
          '</div><b>' + conf.toFixed(2) + '</b><span>the AI’s own estimate</span></div>' : ''));
      if (c.reason.cited.length) body += this._reliedHTML(events, c.reason.cited, 'cited');
    }
    if (c.given.length && !docs.length && !(c.reason && c.reason.cited.length)) body += '<div class="bb-given">' + c.given.map(function (g) {
      return 'It was given <b>' + g.n + (g.of != null ? ' of ' + g.of : '') + '</b> from ' + esc(g.title) + '.';
    }).join(' ') + '</div>';
    if (docs.length) {
      evidence++;
      var states = L.sourceStates(topo, events);
      docs.forEach(function (m) { body += self._documentsHTML(m, states.filter(function (s) { return s.id === m.source.id; })[0], run, id); });
    }
    if (c.proposal) {
      evidence++;
      var pr = c.proposal;
      var stateW = pr.state === 'waiting' ? '<span class="wait">⏸ waiting for a person</span>' : pr.state === 'approved' ? '<span class="ok">✓ approved' + (pr.by ? ' by ' + esc(pr.by) : '') + '</span>' : '<span class="no">✕ not approved' + (pr.by ? ' by ' + esc(pr.by) : '') + '</span>';
      var fields = (pr.title ? [{ name: 'title', value: pr.title }] : []).concat(pr.description ? [{ name: 'description', value: pr.description }] : []).concat(pr.fields);
      // The app's fingerprint of the exact action (a digest it sent with the proposal), when it sent one.
      var gw = stepEvs.filter(function (e) { return e.event_type === 'gate_waiting'; })[0], fp = null;
      (function find(o, d) {
        if (fp || !o || typeof o !== 'object' || d > 2) return;
        Object.keys(o).forEach(function (k) { var v = o[k]; if (!fp && /digest|sha256|fingerprint/i.test(k) && typeof v === 'string' && /^[0-9a-f]{16,}$/i.test(v)) fp = v; else find(v, d + 1); });
      })(gw && gw.data, 0);
      var fpRow = fp ? '<dt>fingerprint</dt><dd class="bb-fp"><span class="mono">sha256 ' + esc(fp.slice(0, 12)) + '…' + esc(fp.slice(-6)) + '</span><span class="muted"> the app’s digest of exactly this action</span></dd>' : '';
      var card = '<div class="bb-proposal' + (pr.state === 'waiting' ? ' waiting' : '') + '"><div class="th"><b>' + esc(pr.kicker || 'What it would do') + '</b>' + stateW + '</div>' +
        (fields.length || fpRow ? '<dl class="bb-fields">' + fields.map(function (f) { return '<dt>' + esc(String(f.name).toLowerCase()) + '</dt><dd>' + (f.name === 'description' ? foldText(f.value, self.moreOpen) : esc(f.value)) + '</dd>'; }).join('') + fpRow + '</dl>' : '') + '</div>';
      var lead = pr.state === 'waiting' ? 'What a person is asked to approve' : pr.state === 'approved' ? 'What a person approved' : 'What a person turned down';
      var foot = pr.state === 'waiting' ? '<div class="bb-inapp"><b>Approve</b> / <b>Deny</b> is pressed in the app, not here.</div>' +
        (c.ifNext.length ? '<div class="bb-next">' + c.ifNext.map(function (x) { return '<div><span>Next, if ' + (x.label ? '“' + esc(x.label) + '”' : 'it goes ahead') + ':</span> ' + esc(x.to) + '</div>'; }).join('') + '</div>' : '')
        : (pr.at ? '<div class="bb-inapp">' + (pr.state === 'approved' ? 'Approved' : 'Turned down') + ' at ' + esc(L.clock(pr.at)) + '.</div>' : '');
      body += sec(lead, card + foot);
      if (pr.state !== 'waiting') body += this._neighboursHTML(events, id, S, finished);
    }
    if (c.checks.length) {
      evidence++;
      var lines = c.checks.map(function (k) {
        return '<div class="bb-check c-' + esc(k.state) + '"><span class="bb-sym">' + (CHECK_SYM_P[k.state] || '•') + '</span><div><b>' + esc(k.label) + '</b> — ' + esc(k.detail || k.word) +
          (k.evidence.length ? '<div class="bb-chips"><span>its evidence</span> ' + k.evidence.map(function (x) { return chip(x.title, 'cited'); }).join(' ') + '</div>' : '') + '</div></div>';
      }).join('');
      body += c.kind === 'check' ? sec('The verdict', lines) : '<section class="bb-sec">' + lines + '</section>';
    }
    if (c.did) { evidence++; body += sec('What it did', '<div class="bb-box"><div class="k">' + esc(c.did.what) + '</div><div class="v bb-did">' + (c.did.ref ? '<span class="g mono">' + esc(c.did.ref) + '</span> ' : '') + esc(c.did.title || '') + '</div></div>'); }
    if (c.wrote && !seq) {
      evidence++;
      body += sec('What it wrote', c.wrote.fields ? '<div class="bb-proposal"><dl class="bb-fields">' + c.wrote.fields.map(function (f) { return '<dt>' + esc(String(f.name).toLowerCase()) + '</dt><dd>' + esc(f.value) + '</dd>'; }).join('') + '</dl></div>'
                                                 : '<div class="bb-answer">' + foldText(c.wrote.text, this.moreOpen) + '</div>');
    }
    if (c.reply) { evidence++; body += sec('What the person was told', '<blockquote class="bb-quote reply">' + foldText(c.reply, this.moreOpen) + '</blockquote>'); }
    if (c.why) body += sec('Why, in the AI’s words' + (c.why.atStep ? ' (at step ' + c.why.atStep + ')' : ''), '<blockquote class="bb-quote">' + foldText(c.why.text, this.moreOpen) + '</blockquote>');
    if (!ran && finished) body += this._whereNextHTML(id, S);
    // The step's own description: always at a sign-off (who may sign), else when nothing else shows.
    if (c.about && (c.kind === 'gate' || !evidence) && !(!ran && finished)) body += sec(esc(c.about.label), '<p class="bb-about">' + esc(c.about.text) + '</p>', 'bb-aboutsec');
    body += this._storyHTML(run, events, id);
    // The numbers and the buttons on one row: a row of the panel's height saved for its evidence.
    // The headline first (what happened, without a scroll beside an app), then the numbers and the buttons on one row.
    var row = strip || acts ? '<div class="bb-strip">' + strip + (acts ? '<div class="p-acts">' + acts + '</div>' : '') + '</div>' : '';
    body = body.replace('\u0000ROW\u0000', row);
    // Previous and next along this run's path.
    var at = S.seq.indexOf(id), pv = at > 0 ? S.seq[at - 1] : null, nx2 = at >= 0 ? S.seq[at + 1] : null;
    function navBtn(n2, dir) {
      var a = L.actorOf(L.nodeOf(topo, n2) || {}, events), t = L.plainLabel(L.nodeOf(topo, n2), n2);
      return '<button class="bb-go a-' + esc(a) + '" data-act="sel" data-arg="' + esc(n2) + '">' + (dir < 0 ? '← ' : '') + '<span class="b">' + esc(badgeOf(S, n2)) + '</span>' + esc(t) + (dir > 0 ? ' →' : '') + '</button>';
    }
    var nav = pv || nx2 ? '<div class="bb-nav">' + (pv ? navBtn(pv, -1) : '<span></span>') + (nx2 ? navBtn(nx2, 1) : '') + '</div>' : '';
    return '<div class="bb a-' + esc(c.actor) + ' s-' + esc(c.status) + '">' + head + '<div class="bb-body">' + body + '</div>' + nav + '</div>';
  };

  // What a decision rests on, as rows (the passage's own sentence when the search found it).
  Bench.prototype._reliedHTML = function (events, ids, word) {
    var L = lg(), topo = this.topo, byId = {};
    L.documentsStep(topo, events, null).forEach(function (m) {
      var given = m.counts.given;
      (m.passages || []).forEach(function (pv) { byId[pv.id] = { pv: pv, title: pv.title, of: given }; });
      (m.documents || []).forEach(function (d) { d.passages.forEach(function (pv) { byId[pv.id] = { pv: pv, title: d.file + (d.title && d.title !== d.file ? ' · ' + d.title : ''), of: given }; }); });
    });
    var rows = ids.map(function (x) {
      var hit = byId[x.id];
      if (!hit) return '<div class="bb-row relied"><div class="rk">–</div><div><div class="loc"><span>' + esc(x.title) + '</span></div><div class="snip">not among what the search returned</div></div><div class="tags"><span class="tg rel">' + esc(word) + '</span></div></div>';
      var f = sectionFace(hit.title);
      return '<div class="bb-row relied"><div class="rk">#' + hit.pv.rank + '</div><div><div class="loc">' + (f.face ? '<span class="face">' + esc(f.face) + '</span>' : '') + '<span>' + esc(f.rest) + '</span></div>' +
        (hit.pv.snippet ? '<div class="snip">' + esc(hit.pv.snippet) + '</div>' : '') + '</div><div class="tags"><span class="tg rel">' + esc(word) + '</span>' +
        (hit.of != null ? '<span>' + hit.pv.rank + ' of ' + hit.of + ' given</span>' : '') + '</div></div>';
    }).join('');
    return sec('Relied on', '<div class="bb-rows">' + rows + '</div>');
  };

  // A step this run didn't reach: the step that chose another way, and the way it chose.
  Bench.prototype._notReached = function (events, id, S) {
    var L = lg(), topo = this.topo;
    var ins = (topo.edges || []).filter(function (e) { return e.to === id && (e.from_branch || e.when); });
    for (var i = 0; i < ins.length; i++) {
      var from = ins[i].from;
      if (!S.numbers[from]) continue;
      var took = L.takenOut(topo, events, from).filter(function (e) { return e.from_branch || e.when; })[0];
      if (!took) continue;
      return [{ t: 'Not reached — step ' }, { t: String(S.numbers[from]), em: true }, { t: ' picked ' }, { t: took.plain_label || L.human(took.from_branch || took.when), next: true },
              { t: ', not ' }, { t: ins[i].plain_label || L.human(ins[i].from_branch || ins[i].when), em: true }, { t: '.' }];
    }
    return [{ t: 'Not reached — this run didn’t come this way.' }];
  };
  Bench.prototype._whereNextHTML = function (id, S) {
    var L = lg(), topo = this.topo;
    var ins = (topo.edges || []).filter(function (e) { return e.to === id; }), outs = (topo.edges || []).filter(function (e) { return e.from === id; });
    function step(n) { var b = badgeOf(S, n); return (b ? '<span class="mono">' + esc(b) + '</span> · ' : '') + esc(L.plainLabel(L.nodeOf(topo, n), n)); }
    var boxes = [];
    if (ins.length) boxes.push('<div class="bb-box"><div class="k">comes from</div><div class="v">' + ins.map(function (e) { return step(e.from) + (e.plain_label ? ' <span class="muted">(' + esc(e.plain_label) + ')</span>' : ''); }).join('<br>') + '</div></div>');
    if (outs.length) boxes.push('<div class="bb-box"><div class="k">goes to</div><div class="v">' + outs.map(function (e) { return step(e.to) + (e.plain_label ? ' <span class="muted">(' + esc(e.plain_label) + ')</span>' : ''); }).join('<br>') + '</div></div>');
    return boxes.length ? sec('Where it sits', '<div class="bb-duo">' + boxes.join('') + '</div>') : '';
  };
  // A sign-off's neighbours on this run's path: what the check before it said, what the step after it did.
  Bench.prototype._neighboursHTML = function (events, id, S, finished) {
    var L = lg(), topo = this.topo, i = S.seq.indexOf(id), out = [];
    var prev = i > 0 ? S.seq[i - 1] : null, next = i >= 0 ? S.seq[i + 1] : null;
    var pn = prev && L.nodeOf(topo, prev);
    if (pn && pn.kind === 'check') {
      var pc = L.callout(topo, events, prev, { finished: finished, numbers: S.numbers });
      var took = L.takenOut(topo, events, prev).filter(function (e) { return e.from_branch || e.when; })[0];
      var k = pc.checks[0], word = took ? ucfirst(took.plain_label || L.human(took.from_branch)) : k ? k.word : '';
      var detail = k && k.detail ? k.detail : '';
      if (detail && word && detail.toLowerCase().indexOf(word.toLowerCase()) === 0) detail = detail.slice(word.length).replace(/^[.\s—:-]+/, '');
      out.push('<div class="bb-box"><div class="k">' + esc(pc.title) + ' (step ' + S.numbers[prev] + ')</div><div class="v"><span class="' + (k && k.state === 'failed' ? 'b' : 'g') + '">' + esc(word) + '</span>' + (detail ? ' — ' + esc(detail) : '') + '</div></div>');
    }
    if (next) {
      var nc = L.callout(topo, events, next, { finished: finished, numbers: S.numbers });
      var v = nc.did ? (nc.did.ref ? '<span class="g mono">' + esc(nc.did.ref) + '</span> ' : '') + esc(nc.did.title || nc.did.what) : esc(nc.headline.map(function (x) { return x.t; }).join(''));
      out.push('<div class="bb-box"><div class="k">What happened next (step ' + S.numbers[next] + ')</div><div class="v">' + v + '</div></div>');
    }
    return out.length ? '<section class="bb-sec"><div class="bb-duo">' + out.join('') + '</div></section>' : '';
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
      (finished && L.baselineOf(events, topo) ? '<p class="rc-record"><span>By hand (the app’s estimate):</span> ' + esc(L.baselineOf(events, topo)) + '</p>' : '') +
      (tr ? '<p class="rc-record"><span>How it’s been tested (the app says):</span> ' + esc(tr) + '</p>' : '') +
      '</div></div>';
  };

  /* The footer's numbers: the run's time (AI work and waiting, when a person had to sign off), its AI
     cost with its calls and tokens, and once it's over the app's own by-hand estimate. When the panel
     is on a step that ran an agent loop, that step's own numbers instead. */
  Bench.prototype._bottomHTML = function (run, events, finished, S, seq) {
    var L = lg(), topo = this.topo;
    // A label may come in two lengths [long, short]: the short one at pane width (index.html .lg/.sh).
    function lab(k) { return Array.isArray(k) ? '<span class="lg">' + esc(k[0]) + '</span><span class="sh">' + esc(k[1]) + '</span>' : esc(k); }
    function item(k, v, cls, title) { return '<span class="fi' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + (k ? '<span class="fk">' + lab(k) + '</span> ' : '') + '<span class="fv">' + esc(v) + '</span>' + '</span>'; }
    function plain(html) { return '<span class="fi">' + html + '</span>'; }
    if (seq) {
      var n = S.numbers[S.focus];
      return item('step ' + (n || ''), L.fmtMs(seq.span * 1000)) +
        plain('<span class="fk">AI cost</span> <span class="fv' + (seq.priced ? '' : ' unk') + '">' + (seq.priced ? esc(L.fmtUsd(seq.cost)) : 'not known') + '</span> · ' + seq.ai + ' call' + (seq.ai === 1 ? '' : 's') + ' + ' + seq.tools + ' tool' + (seq.tools === 1 ? '' : 's') +
              (seq.tokIn || seq.tokOut ? ' · ' + L.fmtNum(seq.tokIn) + '→' + L.fmtNum(seq.tokOut) + ' tok' : ''));
    }
    // Live, an open gate keeps waiting by the wall clock; a replay's times are the recorded ones.
    var nowTs = null;
    if (this.source !== 'replay' && !this._local && !finished && run.gate && run.gate.state === 'waiting' && run.gate.seenAt != null)
      nowTs = run.gate.since + (wallNow() - run.gate.seenAt) / 1000;
    var split = events.length ? L.timeSplit(events, nowTs) : null;
    var out = '';
    if (split) {
      if (split.gated) out += item('AI work', L.secsWords(split.work)) + item(['Waiting for a person', 'waiting'], L.secsWords(split.waiting));
      else out += item(finished ? 'total' : 'so far', L.secsWords(split.total));
    }
    var info = L.costInfo(events);
    if (info.calls) {
      var tin = 0, tout = 0;
      events.forEach(function (e) { if (e.event_type === 'llm_call') { tin += (e.data || {}).input_tokens || 0; tout += (e.data || {}).output_tokens || 0; } });
      var tail = '<span class="calls">' + esc(' · ' + info.calls + ' call' + (info.calls === 1 ? '' : 's')) + '</span>' + (tin || tout ? '<span class="lg">' + esc(' · ' + L.fmtNum(tin) + '→' + L.fmtNum(tout) + ' tok') + '</span>' : '');
      if (!info.priced) out += plain('<span class="fk">AI cost</span> <span class="fv unk" title="The model calls carry no price, and the bench has none for this model: unknown, not free">not known</span>' + tail);
      else out += plain('<span class="fk">AI cost</span> <span class="fv">' + (info.known ? '' : 'at least ') + esc(L.fmtUsd(info.usd)) + '</span>' + tail);
    }
    // The app's by-hand estimate is in the recap (it's a sentence, not a number for this bar).
    return out;
  };
  /* Where the time went: one bar per step of this run, sized by its time (the step the panel is on
     outlined); inside an agent-loop step, one bar per call. */
  Bench.prototype._stripHTML = function (run, S, seq) {
    var L = lg(), topo = this.topo, self = this;
    if (seq) {
      return '<span>inside this step</span><div class="tl">' + seq.calls.map(function (c) {
        return '<span class="' + c.kind + '" style="flex:' + Math.max(0.02, (c.end - c.start)).toFixed(3) + '" title="' + c.n + ' · ' + esc(L.callWords(c, seq).title) + '"></span>';
      }).join('') + '</div>';
    }
    if (!S || !S.seq.length) return '';
    var ms = S.seq.map(function (id) { return stepMs(run, id); });
    var max = Math.max.apply(null, ms.concat([1]));
    return '<span>where the time went</span><div class="tl">' + S.seq.map(function (id, i) {
      var a = L.actorOf(L.nodeOf(topo, id), S.events);
      return '<span class="' + (a === 'ai' ? 'ai' : a === 'person' ? 'person' : '') + (S.focus === id ? ' cur' : '') + '" style="flex:' + Math.max(ms[i], max * 0.015).toFixed(1) + '" title="' + (i + 1) + ' · ' + esc(L.plainLabel(L.nodeOf(topo, id), id)) + ' · ' + L.fmtMs(ms[i]) + '"></span>';
    }).join('') + '</div>';
  };

  /* "What the AI was given", a drawer over the detail (the map stays in view): the step's model calls
     (all of the run's when it names none), as plain blocks, its answer first, retrieved text marked. */
  Bench.prototype._drawerHTML = function (run, events, S) {
    var L = lg(), focus = this.overlay && this.overlay.focus, node = focus && L.nodeOf(this.topo, focus);
    var n = focus && S ? badgeOf(S, focus) : '', actor = node ? L.actorOf(node, events) : 'ai';
    return '<div class="dr-hd a-' + esc(actor) + '"><button class="dr-back" data-act="close" title="Back to the step (Esc)">← back' + (n ? ' to step <span class="b">' + esc(n) + '</span>' : '') + '</button>' +
      '<div class="dr-t">What the AI was given<small>' + (node ? 'step ' + esc(n || '·') + ' · ' + esc(L.plainLabel(node, focus)) + ' · ' : '') + 'word for word, as the app recorded it</small></div>' +
      '<button class="g-big" data-act="bigtext" title="Larger or smaller text">' + (this.bigText ? 'A\u2212 smaller' : 'A+ larger') + '</button></div>' +
      '<div class="dr-body g-panel' + (this.bigText ? ' big' : '') + '">' + this._overlayHTML(run, events) + '</div>';
  };
  Bench.prototype._overlayHTML = function (run, events) {
    var L = lg(), focus = this.overlay && this.overlay.focus, calls = L.givenBlocks(this.topo, events);
    if (focus && calls.some(function (c) { return c.node === focus; })) calls = calls.filter(function (c) { return c.node === focus; });
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
      return '<section class="g-call' + (focus && focus === c.node ? ' focus' : '') + '" data-node="' + esc(c.node) + '">' + (calls.length > 1 ? '<h4>Step: ' + esc(c.title) + '</h4>' : '') + (blocks || '<div class="muted">The app didn\u2019t send this call\u2019s text.</div>') + '</section>';
    }).join('');
    return (anyHit ? '<div class="g-note"><mark class="g-key">highlighted</mark> text was found by the search and pasted into the AI\u2019s prompt, word for word; the label above each says where it came from.' +
        (anyRelied ? ' <mark class="g-key relied">★ relied on</mark> marks what its answer rests on.' : '') + '</div>' : '') +
      (note ? '<div class="g-note">' + esc(note) + '</div>' : '') +
      '<div class="g-body">' + (body || '<div class="muted">The AI hasn\u2019t been asked anything yet.</div>') + '</div>';
  };

  global.Bench = Bench;
})(typeof window !== 'undefined' ? window : this);

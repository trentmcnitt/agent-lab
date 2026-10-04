/* Event sources for the bench: a live SSE stream from the receiver, the shell's postMessages,
   or a recording played back with its original timing. All only ever call bench.push(ev). */
(function (global) {
  'use strict';

  // appId: only that app's runs (the receiver filters; an OTLP run is its service.name's).
  function LiveSource(bench, base, sessionId, appId) {
    this.bench = bench;
    var q = [];
    if (sessionId) q.push('session_id=' + encodeURIComponent(sessionId));
    if (appId) q.push('app=' + encodeURIComponent(appId));
    this.url = base + 'stream' + (q.length ? '?' + q.join('&') : '');
  }
  LiveSource.prototype.start = function () {
    var self = this;
    this.bench.setStatus('● Live · connecting', 'warn');
    this.es = new EventSource(this.url);
    this.es.onopen = function () { self.bench.setStatus('● Live', 'ok'); };
    this.es.onerror = function () { self.bench.setStatus('● Live · reconnecting', 'warn'); };
    this.es.onmessage = function (m) {
      try { self.bench.push(JSON.parse(m.data)); } catch (e) { /* a malformed line never stops the stream */ }
    };
    // The receiver's backlog is over: those runs already happened, so they're shown finished, not
    // paced out step by step as if they were running now.
    this.es.addEventListener('caught_up', function () { self.bench.skipPacing(); });
  };

  /* Embedded sync (SPEC section 3a): the shell relays the app's replay as postMessages. The app
     sets the pace, so there are no transport controls and no pauses. */
  function ParentSource(bench) { this.bench = bench; }
  ParentSource.prototype.start = function () {
    var self = this, registered = false;
    // It follows the app's own run, which may itself be a recording (the static demo): not "live".
    this.bench.setStatus('● Following the app', 'ok');
    window.addEventListener('message', function (m) {
      if (m.source !== window.parent || !m.data || typeof m.data.type !== 'string') return;
      var d = m.data;
      if (d.type === 'bench:register' && d.topology) {
        self.bench.setTopology(d.topology);
        if (d.story && !registered) self.bench.loadStory(d.topology.app.id, d.story);
        registered = true;
      } else if (d.type === 'bench:events' && Array.isArray(d.events)) {
        d.events.forEach(function (ev) { self.bench.push(ev); });
      } else if (d.type === 'bench:event' && d.event) {
        self.bench.push(d.event);
      } else if (d.type === 'bench:reset') {
        self.bench.reset();
      }
    });
    // The shell serves the bench, so they share an origin.
    window.parent.postMessage({ type: 'bench:ready' }, location.origin);
  };

  function parseJSONL(text) {
    return text.split('\n').filter(function (l) { return l.trim(); }).map(function (l) { return JSON.parse(l); });
  }

  /* A recording: JSONL whose first line may be a header, {"v": "bench-recording/0",
     "topology": {...}, "story": "<js>" | null, "title"?, "group"?}, then one event per line. */
  function parseRecording(text) {
    var rows = parseJSONL(text), header = null;
    if (rows.length && rows[0].v === 'bench-recording/0') header = rows.shift();
    return { header: header, events: rows };
  }

  /* Plays events with the gaps between their ts values, so a replay feels like the run did.
     Gaps longer than maxGap (a human taking a minute to approve) are shortened to it.
     The presenter's cursor (opts.stops, from BenchLogic.cursorStops): Play pauses on its own
     after each "moment" (autoPause); next() plays to the end of the next step; back() rebuilds
     the run from the first event up to the previous step's end, without pacing. */
  function ReplaySource(bench, events, opts) {
    opts = opts || {};
    this.bench = bench;
    var L = global.BenchLogic;
    this.events = L ? L.sortEvents(events) : events.slice().sort(function (a, b) { return a.ts - b.ts || (a.seq || 0) - (b.seq || 0); });
    this.speed = opts.speed || 1;
    this.maxGap = opts.maxGap != null ? opts.maxGap : 1.5;
    this.minGap = opts.minGap != null ? opts.minGap : 0.04;
    this.stops = opts.stops || { steps: [], moments: [] };
    this.autoPause = opts.autoPause !== false;
    this.i = 0;
    this.until = null;
    this.timer = null;
    this.onstate = opts.onstate || function () {};
    // A replay of a run already on the bench (Bench.stepThrough) pushes and resets through the bench's own hooks.
    this.push = opts.push || function (ev) { bench.push(ev); };
    this._reset = opts.reset || function () { bench.reset(); };
    this.what = opts.what || 'a recording';
  }
  ReplaySource.prototype._label = function () {
    return '▶ Playing ' + this.what + (this.speed !== 1 ? ' · ' + this.speed + '×' : '');
  };
  ReplaySource.prototype.start = function () { this._reset(); this.i = 0; this.until = null; this.onstate('restart'); this.play(); };
  ReplaySource.prototype.play = function () {
    var self = this;
    if (this.i >= this.events.length) return this.start();
    this.playing = true;
    clearTimeout(this.timer);
    // A single step (next) isn't Play: the transport keeps reading as paused while it plays out.
    this.onstate(this.until != null ? 'stepping' : 'playing');
    (function step() {
      if (!self.playing) return;
      if (self.i >= self.events.length) {
        self.playing = false; self.bench.setStatus('Recording · finished', 'ok'); self.onstate('done'); return;
      }
      var k = self.i, ev = self.events[self.i++];
      self.push(ev);
      self.bench.setStatus(self._label(), 'rep');
      if (self.i >= self.events.length) return step();
      if (self.until != null && k >= self.until) { self.until = null; return self._stop('paused'); }
      if (self.until == null && self.autoPause && self.stops.moments.indexOf(k) >= 0) return self._stop('moment');
      var next = self.events[self.i];
      var gap = Math.min(self.maxGap, Math.max(self.minGap, next.ts - ev.ts)) / self.speed;
      if (next.ts === ev.ts) gap = 0;
      self.timer = setTimeout(step, gap * 1000);
    })();
  };
  ReplaySource.prototype._stop = function (state) {
    this.playing = false; clearTimeout(this.timer);
    this.bench.setStatus(state === 'moment' ? 'Recording · paused at a moment' : 'Recording · paused', 'warn');
    this.onstate(state);
  };
  ReplaySource.prototype.pause = function () { this.until = null; this._stop('paused'); };
  /* Forward one step (a node visit), then pause. The step's events go in at once and the bench's
     own pacing draws them (each step held lit a moment), so every press counts: two presses in
     quick succession are two steps, never one step and a press lost to a step still playing out. */
  ReplaySource.prototype.next = function () {
    var L = global.BenchLogic, target = L.nextStop(this.stops.steps, this.i - 1);
    this.playing = false; clearTimeout(this.timer); this.until = null;
    if (target == null) return this.finish();
    while (this.i <= target && this.i < this.events.length) this.push(this.events[this.i++]);
    if (this.i >= this.events.length) { this.bench.setStatus('Recording · finished', 'ok'); this.onstate('done'); }
    else { this.bench.setStatus('Recording · paused', 'warn'); this.onstate('stepping'); }
  };
  // The first step, paused: where a presenter starts (and the Home key).
  ReplaySource.prototype.first = function () {
    this.playing = false; clearTimeout(this.timer); this.until = null;
    this.seek(this.stops.steps.length ? this.stops.steps[0] : 0);
  };
  // Back one step: reset and replay events[0..previous stop] at once, with pacing skipped.
  ReplaySource.prototype.back = function () {
    var L = global.BenchLogic;
    this.playing = false; clearTimeout(this.timer); this.until = null;
    var cur = this.i - 1, target = L.prevStop(this.stops.steps, cur);
    this.seek(target);
  };
  ReplaySource.prototype.seek = function (target) {
    this._reset();
    this.i = 0;
    while (this.i <= target && this.i < this.events.length) this.push(this.events[this.i++]);
    this.bench.skipPacing();
    if (this.i >= this.events.length) { this.bench.setStatus('Recording · finished', 'ok'); this.onstate('done'); }
    else { this.bench.setStatus('Recording · paused', 'warn'); this.onstate('paused'); }
  };
  ReplaySource.prototype.restart = function () { this.start(); };
  ReplaySource.prototype.finish = function () {
    this.playing = false; clearTimeout(this.timer); this.until = null;
    while (this.i < this.events.length) this.push(this.events[this.i++]);
    this.bench.skipPacing();
    this.bench.setStatus('Recording · finished', 'ok'); this.onstate('done');
  };

  global.BenchSources = { LiveSource: LiveSource, ParentSource: ParentSource, ReplaySource: ReplaySource, parseJSONL: parseJSONL, parseRecording: parseRecording };
})(typeof window !== 'undefined' ? window : this);

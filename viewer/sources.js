/* Event sources for the bench: a live SSE stream from the receiver, or a recording
   played back with its original timing. Both only ever call bench.push(ev). */
(function (global) {
  'use strict';

  function LiveSource(bench, base, sessionId) {
    this.bench = bench;
    this.url = base + 'stream' + (sessionId ? '?session_id=' + encodeURIComponent(sessionId) : '');
  }
  LiveSource.prototype.start = function () {
    var self = this;
    this.bench.setMode('● Live · connecting', 'warn');
    this.es = new EventSource(this.url);
    this.es.onopen = function () { self.bench.setMode('● Live', 'ok'); };
    this.es.onerror = function () { self.bench.setMode('● Live · reconnecting', 'warn'); };
    this.es.onmessage = function (m) {
      try { self.bench.push(JSON.parse(m.data)); } catch (e) { /* a malformed line never stops the stream */ }
    };
  };

  /* Embedded sync (SPEC section 3a): the shell relays the app's replay as postMessages. */
  function ParentSource(bench) { this.bench = bench; }
  ParentSource.prototype.start = function () {
    var self = this, registered = false;
    this.bench.setMode('● Live · following the app', 'ok');
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
     "topology": {...}, "story": "<js>" | null}, followed by one event per line. */
  function parseRecording(text) {
    var rows = parseJSONL(text), header = null;
    if (rows.length && rows[0].v === 'bench-recording/0') header = rows.shift();
    return { header: header, events: rows };
  }

  /* Plays events with the gaps between their ts values, so a replay feels like the run did.
     Gaps longer than maxGap (a human taking a minute to approve) are shortened to it. */
  function ReplaySource(bench, events, opts) {
    opts = opts || {};
    this.bench = bench;
    this.events = events.slice().sort(function (a, b) { return a.ts - b.ts || (a.seq || 0) - (b.seq || 0); });
    this.speed = opts.speed || 1;
    this.maxGap = opts.maxGap != null ? opts.maxGap : 1.5;
    this.minGap = opts.minGap != null ? opts.minGap : 0.04;
    this.i = 0;
    this.timer = null;
    this.onstate = opts.onstate || function () {};
  }
  ReplaySource.prototype._label = function () {
    return '▶ Playing a recording' + (this.speed !== 1 ? ' · ' + this.speed + '×' : '');
  };
  ReplaySource.prototype.start = function () { this.bench.reset(); this.i = 0; this.play(); };
  ReplaySource.prototype.play = function () {
    var self = this;
    this.playing = true;
    clearTimeout(this.timer);
    (function step() {
      if (!self.playing) return;
      if (self.i >= self.events.length) {
        self.playing = false; self.bench.setMode('Recording · finished', 'ok'); self.onstate('done'); return;
      }
      var ev = self.events[self.i++];
      self.bench.push(ev);
      self.bench.setMode(self._label(), 'rep');
      var next = self.events[self.i];
      if (!next) return step();
      var gap = Math.min(self.maxGap, Math.max(self.minGap, next.ts - ev.ts)) / self.speed;
      if (next.ts === ev.ts) gap = 0;
      self.timer = setTimeout(step, gap * 1000);
    })();
    this.onstate('playing');
  };
  ReplaySource.prototype.pause = function () { this.playing = false; clearTimeout(this.timer); this.bench.setMode('Recording · paused', 'warn'); this.onstate('paused'); };
  ReplaySource.prototype.finish = function () {
    this.pause();
    while (this.i < this.events.length) this.bench.push(this.events[this.i++]);
    this.bench.skipPacing();
    this.bench.setMode('Recording · finished', 'ok'); this.onstate('done');
  };

  global.BenchSources = { LiveSource: LiveSource, ParentSource: ParentSource, ReplaySource: ReplaySource, parseJSONL: parseJSONL, parseRecording: parseRecording };
})(typeof window !== 'undefined' ? window : this);

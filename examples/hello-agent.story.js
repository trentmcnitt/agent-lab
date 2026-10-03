BenchStory.register('hello-agent', {
  panels: {
    // A story panel: the app decides how its own decision reads. ctx.mode lets one panel read
    // two ways: Presentation drops the model's self-reported confidence (it isn't accuracy).
    triage: function (events, ctx) {
      var d = events[events.length - 1].data, h = ctx.h;
      var where = '<div style="font-size:13px;margin-bottom:6px">Sent to <b style="color:var(--accent)">' +
        h.esc(String(d.branch).replace('_', ' ')) + '</b></div>';
      if (ctx.mode === 'presentation') return where;
      var pct = Math.round((d.confidence || 0) * 100);
      return where +
        '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--accent-2),var(--accent))"></div></div>' +
        '<div class="note">' + pct + '% confident (the model’s own estimate, not measured accuracy) · ' + h.esc(d.rationale) + '</div>';
    }
  }
});

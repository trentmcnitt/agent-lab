BenchStory.register('hello-agent', {
  panels: {
    // A story panel: the app decides how its own decision reads.
    triage: function (events, ctx) {
      var d = events[events.length - 1].data, h = ctx.h;
      var pct = Math.round((d.confidence || 0) * 100);
      return '<div style="font-size:13px;margin-bottom:6px">Sent to <b style="color:var(--accent)">' +
        h.esc(d.branch.replace('_', ' ')) + '</b></div>' +
        '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,var(--accent-2),var(--accent))"></div></div>' +
        '<div class="note">' + pct + '% confident · ' + h.esc(d.rationale) + '</div>';
    }
  }
});

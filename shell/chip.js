/* "Open in Agent Lab": a floating chip any app can drop in with one tag.

   <script src="http://127.0.0.1:8790/shell/chip.js"
           data-shell="http://127.0.0.1:8790/shell/"
           data-appid="my-app"></script>

   Outside the shell, clicking it opens this page inside the shell (app left, bench right).
   Inside the shell it doesn't show: there, it's always side by side.
   window.benchSession() returns the session id the shell handed this page (or null), so the
   app can stamp it on the events it sends. */
(function () {
  'use strict';
  var me = document.currentScript;
  var shell = (me && me.getAttribute('data-shell')) || new URL('./', me ? me.src : location.href).href;
  var appId = me && me.getAttribute('data-appid');
  var params = new URLSearchParams(location.search);
  var session = params.get('bench_session');
  var embedded = window.self !== window.top;
  window.benchSession = function () { return session; };

  function mount() {
    if (embedded) return;
    var css = document.createElement('style');
    css.textContent =
      '.bench-chip{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:7px;' +
      'padding:7px 12px 7px 10px;border-radius:999px;border:1px solid #2a3350;background:rgba(15,20,32,.92);color:#e6ebff;' +
      'font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:.02em;cursor:pointer;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);text-decoration:none}' +
      '.bench-chip:hover{border-color:#5eead4}' +
      '.bench-chip .dot{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,#5eead4,#a78bfa);box-shadow:0 0 8px rgba(94,234,212,.7)}';
    document.head.appendChild(css);
    var a = document.createElement('a');
    a.className = 'bench-chip';
    a.innerHTML = '<span class="dot"></span><span></span>';
    a.lastChild.textContent = 'Open in Agent Lab';
    a.title = 'See what the AI is doing, beside the app';
    var u = new URL(shell);
    u.searchParams.set('app', location.href);
    if (appId) u.searchParams.set('appid', appId);
    a.href = u.href;
    document.body.appendChild(a);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();

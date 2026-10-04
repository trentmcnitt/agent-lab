/* The map's layout: a layered DAG, top to bottom, with every edge routed so it never passes
   through a box. Pure geometry: no DOM. A classic script that sets window.BenchLayout, so the
   bench and the lab's front door draw a map the same way; node --test loads it with vm.

   BenchLayout(topo, geom) -> { pos: {id: {x, y}}, W, H, g, edges: [routed edge | null] }
   A routed edge (same index as topo.edges) is { from, to, d, pieces, routed, label, edges }:
   - pieces: cubic Béziers [[x0,y0],[x1,y1],[x2,y2],[x3,y3]] (a straight run is a cubic too),
     so a test can sample the exact curve that's drawn;
   - routed: true when the edge skips rows (or goes back up) and runs in a channel;
   - label: {x, y, anchor} where the edge's branch label goes, or null;
   - edges: the topo.edges indices this one line draws. Two branches between the same two steps
     (a many-to-one path map: "needs a change" and "unsure" both to "hand off") are one line with
     joined labels (BenchLayout.edgeText); the later ones' entries are null, like an edge whose
     end isn't on the map, so nothing is drawn twice.

   An edge between adjacent rows is the usual S-curve through the gap between them. A longer
   edge (Sugiyama's long edge) leaves its source through the gap below it, runs straight down a
   channel that is clear of every box in the rows it passes (a gap between columns if one is
   wide enough, else a lane outside the outer columns), and enters its target through the gap
   above it. Rows have no boxes in their gaps, so the curves in the gaps never touch a box. */
(function (global) {
  'use strict';

  var GEOM = { w: 184, h: 54, gx: 18, gy: 30, pad: 10 };
  // Presentation: wider boxes, tighter rows, so an 8-layer map fits a ~640 px pane.
  // A routed edge's label is left off there (the source box's "→ branch" line says it): routedLabels.
  var PRES_GEOM = { w: 212, h: 50, gx: 12, gy: 16, pad: 8, routedLabels: false };
  // Presentation's stage (the map beside one callout, Build spec v3): boxes big enough for a
  // two-line plain name at projector size plus one badge, and a smaller one for a ~960 px pane.
  // lane/clear: channel spacing and clearance, scaled with the boxes so long edges stay distinct.
  var STAGE_GEOM = { w: 300, h: 92, gx: 64, gy: 24, pad: 18, routedLabels: false, lane: 14, clear: 10 };
  var PANE_GEOM = { w: 196, h: 70, gx: 30, gy: 18, pad: 12, routedLabels: false, lane: 10, clear: 7 };
  var CLEAR_DEFAULT = 6;   // a channel keeps at least this far from any box (geom.clear overrides)
  var LANE_DEFAULT = 9;    // spacing between parallel channels (geom.lane overrides)
  var CHAR_W = 5.9;   // the edge label font (9.5px monospace), per character

  function cubic(a, b, c, d) { return [a, b, c, d]; }
  function line(a, b) {
    return [a, [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3], [a[0] + 2 * (b[0] - a[0]) / 3, a[1] + 2 * (b[1] - a[1]) / 3], b];
  }
  function at(p, t) {
    var u = 1 - t;
    return [u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
            u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]];
  }
  function r1(v) { return Math.round(v * 10) / 10; }
  function pathD(pieces) {
    var d = '';
    pieces.forEach(function (p, i) {
      if (i === 0) d += 'M' + r1(p[0][0]) + ',' + r1(p[0][1]);
      d += ' C' + r1(p[1][0]) + ',' + r1(p[1][1]) + ' ' + r1(p[2][0]) + ',' + r1(p[2][1]) + ' ' + r1(p[3][0]) + ',' + r1(p[3][1]);
    });
    return d;
  }
  // The longer of the two names a branch label can show (Presentation's, Engineering's), for room.
  function branchText(e) {
    var a = String(e.plain_label || ''), b = String(e.from_branch || e.when || '');
    return a.length > b.length ? a : b;
  }
  /* The words on one drawn line: each of its branches' words (`plain`: the plain_label, else the
     branch name; otherwise the branch name), joined. */
  function edgeText(topo, routed, plain) {
    var seen = {}, out = [];
    ((routed && routed.edges) || []).forEach(function (k) {
      var e = topo.edges[k], t = e ? String((plain && e.plain_label) || e.from_branch || e.when || '').replace(/_/g, ' ') : '';
      if (t && !seen[t]) { seen[t] = true; out.push(t); }
    });
    return out.join(' · ');
  }

  function layout(topo, geom) {
    var G = geom || GEOM;
    var CLEAR = G.clear || CLEAR_DEFAULT, LANE = G.lane || LANE_DEFAULT;
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
    var row = {};
    layers.forEach(function (L, li) { L.forEach(function (id) { row[id] = li; }); });
    // Barycenter ordering, a few sweeps, so branches sit under the node they leave.
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
    var widest = Math.max.apply(null, layers.map(function (L) { return L.length; }).concat([1]));
    var W0 = G.pad * 2 + widest * G.w + (widest - 1) * G.gx;
    var pos = {};
    layers.forEach(function (L, li) {
      var rowW = L.length * G.w + (L.length - 1) * G.gx;
      var x0 = (W0 - rowW) / 2;
      L.forEach(function (id, i) { pos[id] = { x: x0 + i * (G.w + G.gx), y: G.pad + li * (G.h + G.gy) }; });
    });
    function rowTop(li) { return G.pad + li * (G.h + G.gy); }
    // The x ranges a channel can't use in rows lo..hi (boxes, plus clearance).
    function blocked(lo, hi) {
      var out = [];
      for (var li = lo; li <= hi; li++) (layers[li] || []).forEach(function (id) { out.push([pos[id].x - CLEAR, pos[id].x + G.w + CLEAR]); });
      return out.sort(function (a, b) { return a[0] - b[0]; });
    }
    function free(x, bl) { return bl.every(function (b) { return x <= b[0] || x >= b[1]; }); }
    var verticals = [];   // channels already taken: {x, y0, y1}
    function clash(x, y0, y1) {
      return verticals.some(function (v) { return Math.abs(v.x - x) < LANE - 0.5 && v.y0 < y1 && y0 < v.y1; });
    }
    var minBox = Infinity, maxBox = -Infinity;
    ids.forEach(function (id) { minBox = Math.min(minBox, pos[id].x); maxBox = Math.max(maxBox, pos[id].x + G.w); });

    // Parallel edges (same from and to) are one line: the first carries every index.
    var firstOf = {}, group = {};
    topo.edges.forEach(function (e, i) {
      var k = e.from + '\u0000' + e.to;
      if (firstOf[k] == null) { firstOf[k] = i; group[i] = [i]; } else group[firstOf[k]].push(i);
    });
    // Long edges first-come, in map order; short ones don't need a channel.
    var edges = topo.edges.map(function (e, i) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b || !group[i]) return null;
      var r = route(e, a, b, group[i].map(function (k) { return branchText(topo.edges[k]); }).filter(Boolean).join(' · '));
      r.edges = group[i];
      return r;
    });
    function route(e, a, b, text) {
      var x1 = a.x + G.w / 2, y1 = a.y + G.h, x2 = b.x + G.w / 2, y2 = b.y;
      var ls = row[e.from], lt = row[e.to];
      if (lt === ls + 1) {
        var dy = Math.max(G.gy > 20 ? 18 : 12, (y2 - y1) / 2);
        var p = cubic([x1, y1], [x1, y1 + dy], [x2, y2 - dy], [x2, y2]);
        var lp = at(p, 0.78);
        return { from: e.from, to: e.to, pieces: [p], routed: false, label: text ? { x: lp[0] + 4, y: lp[1] - 2, anchor: 'start' } : null };
      }
      var down = lt > ls;
      // The rows the channel passes, and where it starts and ends (in the gaps).
      var lo = down ? ls + 1 : lt, hi = down ? lt - 1 : ls;
      var yA = down ? rowTop(ls + 1) : y1 + G.gy / 2;           // channel start
      var yC = down ? rowTop(lt - 1) + G.h : y2 - G.gy / 2;     // channel end
      var bl = blocked(lo, hi), cands = [];
      // Candidates: the ideal spot clamped into each free interval, then lanes stepping away from it.
      // Merge into free intervals.
      var ivs = [], cur = -Infinity;
      bl.forEach(function (b) { if (b[0] > cur) ivs.push([cur, b[0]]); cur = Math.max(cur, b[1]); });
      ivs.push([cur, Infinity]);
      if (!bl.length) ivs = [[-Infinity, Infinity]];
      var ideal = down ? (x1 + x2) / 2 : Math.max(x1, x2);
      ivs.forEach(function (iv) {
        var lo2 = iv[0] === -Infinity ? Math.min(minBox - CLEAR - LANE * 8, x1, x2) : iv[0];
        var hi2 = iv[1] === Infinity ? Math.max(maxBox + CLEAR + LANE * 8, x1, x2) : iv[1];
        if (hi2 < lo2) return;
        var c0 = Math.min(Math.max(ideal, lo2), hi2);
        for (var k = 0; k <= 8; k++) [c0 + k * LANE, c0 - k * LANE].forEach(function (c) {
          if (c >= lo2 && c <= hi2) cands.push(c);
        });
      });
      var y0v = Math.min(yA, yC), y1v = Math.max(yA, yC);
      var best = null, bestScore = Infinity;
      cands.forEach(function (c) {
        if (!free(c, bl) || clash(c, y0v, y1v)) return;
        // Shortest detour; on a tie, nearest the source, so the edge leaves straight down and
        // crosses over in the last gap rather than running across the rows it passes.
        var s = Math.abs(c - x1) + Math.abs(c - x2) + 0.01 * Math.abs(c - x1);
        if (s < bestScore - 1e-9) { bestScore = s; best = c; }
      });
      if (best == null) best = maxBox + CLEAR + LANE * (verticals.length + 1);
      var cx = best;
      verticals.push({ x: cx, y0: y0v, y1: y1v });
      var pieces;
      if (down) {
        var hA = yA - y1, hC = y2 - yC;
        pieces = [cubic([x1, y1], [x1, y1 + hA / 2], [cx, y1 + hA / 2], [cx, yA]), line([cx, yA], [cx, yC]),
                  cubic([cx, yC], [cx, yC + hC / 2], [x2, yC + hC / 2], [x2, y2])];
      } else {
        // Back up the map: out of the gap below the source, up the channel, into the gap above the target.
        var g2 = G.gy / 2;
        pieces = [cubic([x1, y1], [x1, y1 + g2], [cx, y1 + g2], [cx, yA]), line([cx, yA], [cx, yC]),
                  cubic([cx, yC], [cx, yC - g2], [x2, yC - g2], [x2, y2])];
      }
      // The label rides the channel just after the turn, on the side away from the boxes when the
      // channel runs outside them; in a gap between columns it sits on the run out of the source.
      var label = null;
      if (text && G.routedLabels !== false) {
        var outsideR = cx >= maxBox, outsideL = cx <= minBox;
        if (outsideR) label = { x: cx + 4, y: yA + 12, anchor: 'start' };
        else if (outsideL) label = { x: cx - 4, y: yA + 12, anchor: 'end' };
        else { var m = at(pieces[0], 0.5); label = { x: m[0] + 4, y: m[1] + 3, anchor: 'start' }; }
        label.w = text.length * CHAR_W;
      }
      return { from: e.from, to: e.to, pieces: pieces, routed: true, label: label };
    }

    // Lanes outside the columns (and their labels) widen the map: shift everything to fit.
    var minX = 0, maxX = W0, minY = 0, maxY = G.pad * 2 + Math.max(0, layers.length * G.h + (layers.length - 1) * G.gy);
    edges.forEach(function (ed) {
      if (!ed) return;
      ed.pieces.forEach(function (p) { p.forEach(function (q) { minX = Math.min(minX, q[0] - G.pad); maxX = Math.max(maxX, q[0] + G.pad); minY = Math.min(minY, q[1] - G.pad); maxY = Math.max(maxY, q[1] + G.pad); }); });
      if (ed.routed && ed.label) {
        var lx0 = ed.label.anchor === 'end' ? ed.label.x - ed.label.w : ed.label.x, lx1 = lx0 + ed.label.w;
        minX = Math.min(minX, lx0 - 2); maxX = Math.max(maxX, lx1 + 2);
      }
    });
    var sx = -minX, sy = -minY;
    if (sx || sy) {
      ids.forEach(function (id) { pos[id].x += sx; pos[id].y += sy; });
      edges.forEach(function (ed) {
        if (!ed) return;
        ed.pieces.forEach(function (p) { p.forEach(function (q) { q[0] += sx; q[1] += sy; }); });
        if (ed.label) { ed.label.x += sx; ed.label.y += sy; }
      });
    }
    edges.forEach(function (ed) { if (ed) ed.d = pathD(ed.pieces); });
    return { pos: pos, W: maxX - minX, H: maxY - minY, g: G, edges: edges };
  }

  layout.GEOM = GEOM;
  layout.PRES_GEOM = PRES_GEOM;
  layout.STAGE_GEOM = STAGE_GEOM;
  layout.PANE_GEOM = PANE_GEOM;
  layout.at = at;
  layout.edgeText = edgeText;
  global.BenchLayout = layout;
})(typeof window !== 'undefined' ? window : this);

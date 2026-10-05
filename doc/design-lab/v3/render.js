// design-lab v1 の描画。data.js の架空データから、<html data-screen="..."> に応じた画面を描く。
// グラフはインライン SVG をここで組み立てる（ライブラリなし）。色はすべて CSS カスタムプロパティ経由。
(function () {
  var D = window.LAB_DATA, V = window.LAB_VARIANTS;
  var TYPE = { feed: { label: "フィード", i: 1 }, carousel: { label: "カルーセル", i: 2 }, reel: { label: "リール", i: 3 }, story: { label: "ストーリーズ", i: 4 } };
  var NAV = [["overview", "概要"], ["media-list", "投稿一覧"], ["media-detail", "投稿詳細"], ["reels", "リール分析"], ["stories", "ストーリーズ"], ["timing", "投稿時刻"], ["connection", "接続と収集ログ"]];
  var SCREENS = {};

  // ---------- 文字と数字 ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function n(v) { return v == null ? "—" : Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function pct(v, d) { return v == null ? "—" : (v * 100).toFixed(d == null ? 1 : d) + "%"; }
  function sec(v) { return v == null ? "—" : (Math.round(v * 10) / 10) + " 秒"; }
  function dt(iso) { var m = iso.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+)/); return m ? (+m[2]) + "/" + (+m[3]) + " " + m[4] + ":" + m[5] : iso; }
  function dtFull(iso) { return iso.replace("T", " "); }
  function dateShort(d) { var p = d.split("-"); return (+p[1]) + "/" + (+p[2]); }
  function rate(a, b) { return b ? a / b : null; }
  function median(arr) { var a = arr.slice().sort(function (x, y) { return x - y; }); var m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function chartColor(type) { return "var(--chart-" + TYPE[type].i + ")"; }
  function delta(cur, prev) {
    var r = prev ? (cur - prev) / prev : 0;
    var dir = Math.abs(r) < 0.005 ? "flat" : r > 0 ? "up" : "down";
    var arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "±";
    return '<span class="delta" data-dir="' + dir + '">' + arrow + " " + (r > 0 ? "+" : "") + (r * 100).toFixed(1) + "%</span>";
  }
  function deltaPt(cur, prev) {
    var d = (cur - prev) * 100;
    var dir = Math.abs(d) < 0.05 ? "flat" : d > 0 ? "up" : "down";
    var arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "±";
    return '<span class="delta" data-dir="' + dir + '">' + arrow + " " + (d > 0 ? "+" : "") + d.toFixed(1) + " pt</span>";
  }
  function tag(type) { return '<span class="tag" data-type="' + type + '"><i></i>' + TYPE[type].label + "</span>"; }
  function thumb(p, cls) { return '<span class="thumb' + (cls ? " " + cls : "") + '" data-type="' + p.type + '" style="--hue:' + p.hue + '">' + (p.type === "reel" ? "▶" : p.type === "carousel" ? "▣" : "") + "</span>"; }
  function card(title, body, o) {
    o = o || {};
    return '<section class="card' + (o.cls ? " " + o.cls : "") + '">' +
      (title ? '<div class="card__head"><h2>' + title + "</h2>" + (o.sub ? '<span class="card__sub">' + o.sub + "</span>" : "") + "</div>" : "") +
      body + (o.foot ? '<div class="card__foot">' + o.foot + "</div>" : "") + "</section>";
  }
  function kpi(label, value, deltaHtml, denom, unit, hint) {
    return '<div class="card kpi"><div class="kpi__label"' + (hint ? ' title="' + esc(hint) + '" style="cursor:help;text-decoration:underline dotted"' : "") + '>' + label + '</div><div class="kpi__value">' + value + (unit ? "<small>" + unit + "</small>" : "") + "</div>" +
      '<div class="kpi__delta">' + (deltaHtml || "") + (denom ? '<span class="kpi__denom">' + denom + "</span>" : "") + "</div></div>";
  }
  function legend(items) {
    return '<div class="legend">' + items.map(function (it) {
      return "<span><i" + (it.kind ? ' class="' + it.kind + '"' : "") + (it.color ? ' style="background:' + it.color + '"' : "") + "></i>" + it.label + "</span>";
    }).join("") + "</div>";
  }
  function note(text) { return '<p class="note">' + text + "</p>"; }
  function typeLegend() { return legend(["feed", "carousel", "reel", "story"].map(function (t) { return { label: TYPE[t].label, color: chartColor(t) }; })); }

  // ---------- SVG の部品 ----------
  function svgOpen(w, h) { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" role="img">'; }
  function niceMax(v) { if (!(v > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))); var f = v / p; var nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10; return nf * p; }
  function ticks(max, count) { var out = []; for (var i = 0; i <= count; i++) out.push(max * i / count); return out; }
  function fmtAxis(v) { return v >= 10000 ? (v / 10000) + "万" : v < 1 && v > 0 ? pct(v, 0) : n(v); }
  // 横棒（右端だけ 4px の角丸）と縦棒（上端だけ角丸）
  function barH(x, y, w, h, r) { r = Math.max(0, Math.min(r, w, h / 2)); return "M" + x + " " + y + "h" + (w - r) + "a" + r + " " + r + " 0 0 1 " + r + " " + r + "v" + (h - 2 * r) + "a" + r + " " + r + " 0 0 1 -" + r + " " + r + "h-" + (w - r) + "z"; }
  function barV(x, y, w, h, r) { r = Math.max(0, Math.min(r, h, w / 2)); return "M" + x + " " + (y + h) + "v-" + (h - r) + "a" + r + " " + r + " 0 0 1 " + r + " -" + r + "h" + (w - 2 * r) + "a" + r + " " + r + " 0 0 1 " + r + " " + r + "v" + (h - r) + "z"; }

  // 折れ線。series: [{ values, color, label, dashed, dots, endLabel }]、labels: x のラベル、markers: 縦線を引く index、band: [下側[], 上側[]]
  function lineChart(o) {
    var w = o.w, h = o.h || 200, m = { t: 16, r: o.align ? 8 : 14, b: 26, l: 44 };
    var iw = w - m.l - m.r, ih = h - m.t - m.b;
    var all = [];
    o.series.forEach(function (s) { all = all.concat(s.values.filter(function (v) { return v != null; })); });
    if (o.band) all = all.concat(o.band[1]);
    var min = o.min != null ? o.min : 0;
    var max = o.max || niceMax(Math.max.apply(null, all) * 1.08);
    var N = o.labels.length;
    var x = o.align ? function (i) { return m.l + iw / N * i + iw / N / 2; } : function (i) { return m.l + (N > 1 ? iw * i / (N - 1) : iw / 2); };
    var y = function (v) { return m.t + ih - ih * (v - min) / (max - min); };
    var s = svgOpen(w, h) + '<g class="chart-grid">';
    ticks(max - min, 4).forEach(function (t) { var yy = y(t + min); s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + yy + '" y2="' + yy + '"/>'; });
    s += '</g><g class="chart-axis">';
    ticks(max - min, 4).forEach(function (t) { s += '<text x="' + (m.l - 6) + '" y="' + (y(t + min) + 4) + '" text-anchor="end">' + (o.yFmt ? o.yFmt(t + min) : fmtAxis(t + min)) + "</text>"; });
    var step = Math.max(1, Math.ceil(N / Math.max(2, Math.floor(iw / (o.align ? 44 : 56)))));
    o.labels.forEach(function (l, i) { if (i % step === 0 || (!o.align && N <= 8 && i === N - 1)) s += '<text x="' + x(i) + '" y="' + (h - 6) + '" text-anchor="middle">' + l + "</text>"; });
    s += "</g>";
    (o.markers || []).forEach(function (i) { s += '<line class="chart-marker" x1="' + x(i) + '" x2="' + x(i) + '" y1="' + m.t + '" y2="' + (m.t + ih) + '"/>'; });
    if (o.align) (o.markers || []).forEach(function (i) { s += '<path d="M' + x(i).toFixed(1) + " " + (m.t + ih + 2) + 'l-3 5h6z" fill="var(--chart-marker)"/>'; });
    if (o.band) {
      var up = o.band[1].map(function (v, i) { return x(i).toFixed(1) + "," + y(v).toFixed(1); });
      var lo = o.band[0].map(function (v, i) { return x(i).toFixed(1) + "," + y(v).toFixed(1); }).reverse();
      s += '<polygon class="chart-band" points="' + up.concat(lo).join(" ") + '"><title>' + (o.bandLabel || "") + "</title></polygon>";
    }
    o.series.forEach(function (se) {
      var pts = se.values.map(function (v, i) { return v == null ? null : [x(i), y(v)]; }).filter(Boolean);
      var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("");
      s += '<path class="' + (se.dashed ? "chart-ref" : "chart-line") + '" d="' + d + '"' + (se.dashed ? "" : ' style="stroke:' + se.color + '"') + "><title>" + esc(se.label || "") + "</title></path>";
      if (se.dots) pts.forEach(function (p, i) { s += '<circle class="chart-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="4" fill="' + se.color + '"><title>' + esc(se.label || "") + " " + o.labels[i] + ": " + n(se.values[i]) + "</title></circle>"; });
      if (se.endLabel && pts.length) { var last = pts[pts.length - 1]; s += '<text class="chart-label chart-label--b" x="' + (last[0] - 2).toFixed(1) + '" y="' + (last[1] - 8).toFixed(1) + '" text-anchor="end">' + se.endLabel + "</text>"; }
    });
    return s + "</svg>";
  }

  // 縦棒。values, labels, color | colors[], markers（x 軸下に投稿の印）, valueLabels: "all" か index の配列, dim: 薄くする index, nLabels: 2 行目のラベル
  function vbars(o) {
    var w = o.w, h = o.h || 180, m = { t: 18, r: 8, b: o.nLabels ? 40 : 26, l: o.noAxis ? 8 : 44 };
    var iw = w - m.l - m.r, ih = h - m.t - m.b;
    var vals = o.values.map(function (v) { return v == null ? 0 : v; });
    var max = o.max || niceMax(Math.max.apply(null, vals) * 1.1);
    var N = vals.length, slot = iw / N, bw = Math.min(o.maxBar || 26, slot * 0.62);
    var y = function (v) { return m.t + ih - ih * v / max; };
    var s = svgOpen(w, h);
    if (!o.noAxis) {
      s += '<g class="chart-grid">';
      ticks(max, 4).forEach(function (t) { s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + y(t) + '" y2="' + y(t) + '"/>'; });
      s += '</g><g class="chart-axis">';
      ticks(max, 4).forEach(function (t) { s += '<text x="' + (m.l - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + (o.fmt ? o.fmt(t) : fmtAxis(t)) + "</text>"; });
      s += "</g>";
    } else {
      s += '<g class="chart-axis"><line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + (m.t + ih) + '" y2="' + (m.t + ih) + '"/></g>';
    }
    var step = Math.max(1, Math.ceil(N / Math.max(2, Math.floor(iw / 44))));
    s += '<g class="chart-axis">';
    o.labels.forEach(function (l, i) {
      if (i % step === 0) s += '<text x="' + (m.l + slot * i + slot / 2).toFixed(1) + '" y="' + (h - (o.nLabels ? 18 : 6)) + '" text-anchor="middle">' + l + "</text>";
      if (o.nLabels) s += '<text x="' + (m.l + slot * i + slot / 2).toFixed(1) + '" y="' + (h - 4) + '" text-anchor="middle" opacity=".6">n=' + o.nLabels[i] + "</text>";
    });
    s += "</g>";
    vals.forEach(function (v, i) {
      var x = m.l + slot * i + (slot - bw) / 2, hgt = ih * v / max;
      var col = o.colors ? o.colors[i] : o.color;
      var dim = o.dim && o.dim.indexOf(i) >= 0;
      if (v > 0) s += '<path d="' + barV(x, y(v), bw, hgt, 4) + '" fill="' + col + '"' + (dim ? ' opacity=".35"' : "") + "><title>" + (o.tips ? o.tips[i] : o.labels[i] + ": " + (o.fmt ? o.fmt(o.values[i]) : n(o.values[i]))) + "</title></path>";
      else if (o.values[i] == null) s += '<text class="chart-label chart-label--muted" x="' + (x + bw / 2).toFixed(1) + '" y="' + (m.t + ih - 6) + '" text-anchor="middle">—</text>';
      if (o.valueLabels === "all" || (o.valueLabels && o.valueLabels.indexOf(i) >= 0)) s += '<text class="chart-label' + (o.boldLabels ? " chart-label--b" : "") + '" x="' + (x + bw / 2).toFixed(1) + '" y="' + (y(v) - 5).toFixed(1) + '" text-anchor="middle">' + (o.fmt ? o.fmt(o.values[i]) : n(o.values[i])) + "</text>";
    });
    (o.markers || []).forEach(function (i) { s += '<path d="M' + (m.l + slot * i + slot / 2).toFixed(1) + " " + (m.t + ih + 2) + 'l-3 5h6z" fill="var(--chart-marker)"/>'; });
    return s + "</svg>";
  }

  // 100% 積み上げの横棒。rows: [{ label, parts: [{ type, value }] }]。区切りは 2px の面の色。割合は棒の下に本文色で書く。
  function stacked100(o) {
    var w = o.w, rowH = 40, labelW = 64, gap = 2;
    var h = rowH * o.rows.length;
    var s = svgOpen(w, h);
    o.rows.forEach(function (r, ri) {
      var total = r.parts.reduce(function (a, p) { return a + p.value; }, 0) || 1;
      var y = ri * rowH + 4, x = labelW, bw = w - labelW;
      s += '<text class="chart-label" x="0" y="' + (y + 13) + '">' + r.label + "</text>";
      r.parts.forEach(function (p, pi) {
        var pw = bw * p.value / total;
        if (pw <= 0) return;
        var rw = Math.max(0, pw - (pi < r.parts.length - 1 ? gap : 0));
        s += '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + rw.toFixed(1) + '" height="16" rx="' + (pi === r.parts.length - 1 ? 4 : 0) + '" fill="' + chartColor(p.type) + '"><title>' + TYPE[p.type].label + ": " + n(p.value) + "（" + pct(p.value / total, 0) + "）</title></rect>";
        if (rw >= 30) s += '<text class="chart-label chart-label--muted" x="' + (x + rw / 2).toFixed(1) + '" y="' + (y + 30) + '" text-anchor="middle">' + pct(p.value / total, 0) + "</text>";
        x += pw;
      });
    });
    return s + "</svg>";
  }

  // 散布図。points: [{ x, y, label, hi }]
  function scatter(o) {
    var w = o.w, h = o.h || 240, m = { t: 14, r: 16, b: 40, l: 48 };
    var iw = w - m.l - m.r, ih = h - m.t - m.b;
    var xmax = niceMax(Math.max.apply(null, o.points.map(function (p) { return p.x; })) * 1.1);
    var ymax = niceMax(Math.max.apply(null, o.points.map(function (p) { return p.y; })) * 1.1);
    var x = function (v) { return m.l + iw * v / xmax; }, y = function (v) { return m.t + ih - ih * v / ymax; };
    var s = svgOpen(w, h) + '<g class="chart-grid">';
    ticks(xmax, 4).forEach(function (t) { s += '<line x1="' + x(t) + '" x2="' + x(t) + '" y1="' + m.t + '" y2="' + (m.t + ih) + '"/>'; });
    ticks(ymax, 4).forEach(function (t) { s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + y(t) + '" y2="' + y(t) + '"/>'; });
    s += '</g><g class="chart-axis">';
    ticks(xmax, 4).forEach(function (t) { s += '<text x="' + x(t) + '" y="' + (m.t + ih + 14) + '" text-anchor="middle">' + (o.xFmt ? o.xFmt(t) : fmtAxis(t)) + "</text>"; });
    ticks(ymax, 4).forEach(function (t) { s += '<text x="' + (m.l - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + (o.yFmt ? o.yFmt(t) : fmtAxis(t)) + "</text>"; });
    s += '<text x="' + (m.l + iw / 2) + '" y="' + (h - 4) + '" text-anchor="middle">' + o.xLabel + "</text>";
    s += '<text x="' + (m.l + 4) + '" y="' + (m.t - 4) + '">' + o.yLabel + "</text></g>";
    if (o.refY != null) s += '<line class="chart-ref" x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + y(o.refY) + '" y2="' + y(o.refY) + '"/>';
    o.points.forEach(function (p) {
      s += '<circle cx="' + x(p.x).toFixed(1) + '" cy="' + y(p.y).toFixed(1) + '" r="' + (p.hi ? 6 : 5) + '" fill="' + o.color + '" opacity=".85" class="chart-dot"><title>' + esc(p.label) + "</title></circle>";
      if (p.hi) s += '<text class="chart-label" x="' + (x(p.x) + 9).toFixed(1) + '" y="' + (y(p.y) + 4).toFixed(1) + '">' + esc(p.label) + "</text>";
    });
    return s + "</svg>";
  }

  // ヒートマップ（1 色の濃淡）。values[r][c]（null は該当なし）、counts[r][c]。件数 2 未満は薄く。
  function heatmap(o) {
    var w = o.w, labelW = 28, cellH = 30;
    var cols = o.cols.length, rows = o.rows.length, cellW = (w - labelW) / cols;
    var h = cellH * rows + 22;
    var max = Math.max.apply(null, [].concat.apply([], o.values).filter(function (v) { return v != null; }));
    var s = svgOpen(w, h) + '<g class="chart-axis">';
    o.cols.forEach(function (c, ci) { s += '<text x="' + (labelW + cellW * ci + cellW / 2).toFixed(1) + '" y="12" text-anchor="middle">' + c + "</text>"; });
    o.rows.forEach(function (r, ri) { s += '<text x="' + (labelW - 8) + '" y="' + (22 + cellH * ri + cellH / 2 + 4) + '" text-anchor="end">' + r + "</text>"; });
    s += "</g>";
    o.rows.forEach(function (r, ri) {
      o.cols.forEach(function (c, ci) {
        var v = o.values[ri][ci], cnt = o.counts[ri][ci];
        var x = labelW + cellW * ci, y = 22 + cellH * ri;
        if (v == null) { s += '<rect class="heat-cell heat-cell--none" x="' + x.toFixed(1) + '" y="' + y + '" width="' + cellW.toFixed(1) + '" height="' + cellH + '" rx="3"/>'; return; }
        var p = Math.round(12 + 88 * v / max);
        s += '<rect class="heat-cell" x="' + x.toFixed(1) + '" y="' + y + '" width="' + cellW.toFixed(1) + '" height="' + cellH + '" rx="3" fill="color-mix(in oklab, var(--heat) ' + p + '%, var(--color-surface))"><title>' + r + " " + c + " 時: 中央値 " + n(v) + "（n=" + cnt + "）</title></rect>";
        if (cellW >= 34) {
          var tx = (x + cellW / 2).toFixed(1), tfill = p > 70 ? "var(--color-surface)" : "var(--color-text)";
          // 件数 1 件のセルは数字の横に ※ を添える（色は中央値のまま。注記はカードの下）
          s += '<text x="' + tx + '" y="' + (y + cellH / 2 + 4) + '" text-anchor="middle" font-size="10.5" fill="' + tfill + '">' + n(v) + (cnt < 2 ? "※" : "") + "</text>";
        }
      });
    });
    return s + "</svg>";
  }

  // リールのカットと画面の文字のタイムライン
  function cutTimeline(o) {
    var w = o.w, m = { l: 6, r: 6 }, iw = w - m.l - m.r, len = o.lenMs;
    var x = function (ms) { return m.l + iw * ms / len; };
    var rulerY = 14, sceneY = 26, sceneH = 18, textY = 52, textH = 14, h = textY + textH + 26;
    var s = svgOpen(w, h) + '<g class="chart-axis">';
    for (var t = 0; t <= len; t += 5000) s += '<line x1="' + x(t).toFixed(1) + '" x2="' + x(t).toFixed(1) + '" y1="' + (rulerY - 4) + '" y2="' + rulerY + '"/><text x="' + x(t).toFixed(1) + '" y="' + (rulerY - 6) + '" text-anchor="middle">' + (t / 1000) + "s</text>";
    s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + rulerY + '" y2="' + rulerY + '"/></g>';
    var cuts = o.cuts.concat([len]);
    for (var i = 0; i < cuts.length - 1; i++) {
      var a = x(cuts[i]), b = x(cuts[i + 1]);
      s += '<rect x="' + a.toFixed(1) + '" y="' + sceneY + '" width="' + Math.max(0, b - a - 2).toFixed(1) + '" height="' + sceneH + '" rx="3" fill="' + o.color + '" opacity="' + (i % 2 ? ".55" : ".85") + '"><title>シーン ' + (i + 1) + ": " + ((cuts[i + 1] - cuts[i]) / 1000).toFixed(1) + " 秒</title></rect>";
    }
    o.cuts.forEach(function (c, i) { if (i) s += '<path d="M' + x(c).toFixed(1) + " " + (sceneY - 2) + 'l-3 -5h6z" fill="var(--color-text)"/>'; });
    
    o.texts.forEach(function (tx, i) {
      var a = x(tx.start), b = x(tx.end);
      var ly = textY + textH + 12 + (i % 2) * 12;
      s += '<rect x="' + a.toFixed(1) + '" y="' + textY + '" width="' + (b - a).toFixed(1) + '" height="' + textH + '" rx="3" fill="var(--color-text)" opacity=".75"><title>' + esc(tx.text) + "（" + (tx.start / 1000).toFixed(1) + "〜" + (tx.end / 1000).toFixed(1) + " 秒、" + tx.pos + "）</title></rect>";
      s += '<text class="chart-label" x="' + a.toFixed(1) + '" y="' + ly + '" font-size="10.5">' + esc(tx.text) + "</text>";
    });
    return s + "</svg>";
  }

  // ファネル（HTML）
  function funnel(items) {
    var max = items[0].value;
    return '<div class="funnel">' + items.map(function (it, i) {
      var prev = i ? items[i - 1].value : null;
      return '<div class="funnel__row"><span>' + it.label + '</span><div class="funnel__bar"><i style="width:' + Math.max(1.5, it.value / max * 100).toFixed(1) + '%"></i></div>' +
        '<span><span class="funnel__val">' + n(it.value) + "</span>" + (prev ? '<span class="funnel__rate">' + pct(it.value / prev, prev > 1000 ? 1 : 0) + "</span>" : "") + "</span></div>";
    }).join("") + "</div>";
  }

  // ---------- 画面の枠 ----------
  function hashNow() { return (typeof location !== "undefined" && location.hash) || ""; }
  function shell(screen) {
    return '<header class="topbar"><div class="topbar__in"><div class="brand"><span class="brand__mark"></span>' + esc(D.account.name) + "<small>" + esc(D.account.handle) + "</small></div><nav class=\"nav\">" +
      NAV.map(function (nv) { return '<a href="' + nv[0] + ".html" + hashNow() + '"' + (nv[0] === screen ? ' aria-current="page"' : "") + ">" + nv[1] + "</a>"; }).join("") +
      '</nav></div></header><main class="main" id="main"></main>';
  }
  function pageHead(title, sub, tools) {
    return '<div class="page-head"><div><h1>' + title + '</h1><div class="sub">' + sub + "</div></div>" + (tools ? '<div class="tools">' + tools + "</div>" : "") + "</div>";
  }
  var PT_NOTE = "日次指標の日付は API の区切り（米国太平洋時間）。日本時間では 16 時（冬時間は 17 時）に日が変わるため、日本時間の日付には組み替えられない。投稿単位の集計（投稿日時、初速、曜日×時間帯）は日本時間。";

  // ---------- 概要 ----------
  SCREENS.overview = function (ctx) {
    var K = D.kpis, dates = D.daily.dates, labels = dates.map(dateShort);
    var postIdx = D.posts.map(function (p) { return dates.indexOf(p.at.slice(0, 10)); }).filter(function (i) { return i >= 0; });
    var head = pageHead("概要", D.period.label + "（" + D.period.from + " 〜 " + D.period.to + "）・最終更新 " + dtFull(D.updatedAt),
      '<span class="select">過去 30 日</span><span class="select">前の 30 日と比較</span><span class="btn btn--ghost">CSV</span>');
    var kpis = '<div class="kpis">' +
      kpi("リーチ", n(K.reach.cur), delta(K.reach.cur, K.reach.prev), "前期 " + n(K.reach.prev), null, "リーチ = 期間中に投稿やストーリーズを見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）") +
      kpi("閲覧数", n(K.views.cur), delta(K.views.cur, K.views.prev), "前期 " + n(K.views.prev), null, "閲覧数 = 投稿やストーリーズが表示された回数。同じ人が何度見ても数える（2025-04-21 から views に統一）") +
      kpi("フォロワー純増", "+" + n(K.followerGain.cur), delta(K.followerGain.cur, K.followerGain.prev), "現在 " + n(D.account.followers), null, "フォロワー純増 = 期間中にフォローされた数 − フォローを外された数") +
      kpi("エンゲージメント率", pct(K.engagementRate.cur, 2), deltaPt(K.engagementRate.cur, K.engagementRate.prev), "分母: リーチ", null, "エンゲージメント率 = (いいね + コメント + 保存 + シェア) ÷ リーチ") +
      kpi("保存率", pct(K.saveRate.cur, 2), deltaPt(K.saveRate.cur, K.saveRate.prev), "分母: リーチ・目安 2〜3%", null, "保存率 = 保存 ÷ リーチ") +
      kpi("プロフィール訪問（参考）", n(K.profileVisits.cur), delta(K.profileVisits.cur, K.profileVisits.prev), "フィードとストーリーズの投稿単位の合計", null, "プロフィール訪問（参考） = フィードとストーリーズの投稿からプロフィールに来た数の合計。リールからの訪問とアカウント全体の訪問は API で取れないため含まない") +
      "</div>";
    var w8 = ctx.cw(8), w4 = ctx.cw(4);
    var reachMax = D.daily.reach.indexOf(Math.max.apply(null, D.daily.reach));
    var trend = card("リーチとフォロワー数の日次推移",
      '<p class="small muted">リーチ</p><div class="chart">' + vbars({ w: w8, h: 170, values: D.daily.reach, labels: labels, color: "var(--chart-1)", markers: postIdx, valueLabels: [reachMax], boldLabels: true }) + "</div>" +
      '<p class="small muted" style="margin-top:24px">フォロワー数</p><div class="chart">' + lineChart({ w: w8, h: 130, align: true, labels: labels, min: 1800, max: 2000, markers: postIdx, series: [{ values: D.daily.followers, color: "var(--chart-1)", label: "フォロワー数", endLabel: n(D.account.followers) }] }) + "</div>",
      { foot: '<span style="color:var(--chart-marker)">▲</span> は投稿のあった日' });
    var rows = [
      { label: "投稿数", parts: D.byType.map(function (t) { return { type: t.type, value: t.posts }; }) },
      { label: "リーチ", parts: D.byType.map(function (t) { return { type: t.type, value: t.reach }; }) },
      { label: "保存", parts: D.byType.filter(function (t) { return t.type !== "story"; }).map(function (t) { return { type: t.type, value: t.saves }; }) }
    ];
    var types = card("投稿の種類の内訳", typeLegend() + '<div class="chart">' + stacked100({ w: w4, rows: rows }) + "</div>" +
      '<div class="table-wrap"><table class="table"><thead><tr><th>種類</th><th class="num">投稿</th><th class="num" title="リーチ = 投稿を見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）" style="cursor:help;text-decoration:underline dotted">リーチ</th><th class="num" title="保存 = 保存された数" style="cursor:help;text-decoration:underline dotted">保存</th></tr></thead><tbody>' +
      D.byType.map(function (t) { return "<tr><td>" + tag(t.type) + '</td><td class="num">' + n(t.posts) + '</td><td class="num">' + n(t.reach) + '</td><td class="num">' + (t.type === "story" ? "—" : n(t.saves)) + "</td></tr>"; }).join("") +
      "</tbody></table></div>", { foot: "ストーリーズの保存は API にない。" });
    return head + kpis + '<div class="grid"><div class="col-8">' + trend + '</div><div class="col-4 stack">' + types + "</div></div>" + note(PT_NOTE);
  };

  // ---------- 起動 ----------
  function ctxOf() {
    var main = document.getElementById("main");
    var cs = getComputedStyle(main), root = getComputedStyle(document.documentElement);
    var pad = parseFloat(cs.paddingLeft) || 16;
    var cpad = parseFloat(root.getPropertyValue("--card-pad")) || 16, gap = parseFloat(root.getPropertyValue("--gap")) || 16;
    var W = main.clientWidth - pad * 2;
    var ctx = { W: W, narrow: window.innerWidth <= 900, mobile: window.innerWidth <= 700, pad: cpad, gap: gap };
    ctx.cw = function (span) { if (ctx.narrow && span < 12) span = span === 3 ? 6 : 12; var cols = 12 / span; return Math.max(200, Math.floor((W - gap * (cols - 1)) / cols - cpad * 2)); };
    return ctx;
  }
  function currentVariant() { var m = hashNow().replace("#", "").slice(0, 2); return V.filter(function (x) { return x.id === m; })[0] || V[0]; }
  function render() {
    var screen = document.documentElement.getAttribute("data-screen") || "overview";
    document.getElementById("app").innerHTML = shell(screen);
    var ctx = ctxOf();
    document.getElementById("main").innerHTML = '<div class="stack">' + (SCREENS[screen] || SCREENS.overview)(ctx) + "</div>";
    var v = currentVariant();
    var lt = document.getElementById("labTheme"); if (lt) lt.textContent = "案" + v.id + " " + v.name;
    var link = document.getElementById("labTokens"), href = "../tokens/" + v.tokens;
    if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
    document.title = NAV.filter(function (nv) { return nv[0] === screen; })[0][1] + " | 案" + v.id + " " + v.name;
  }
  window.LAB_RENDER = { SCREENS: SCREENS, render: render };
  if (typeof document !== "undefined" && document.getElementById) {
    var timer;
    window.addEventListener("resize", function () { clearTimeout(timer); timer = setTimeout(render, 150); });
    window.addEventListener("hashchange", render);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render); else render();
  }

  // ---------- 以降、画面ごとの描画を SCREENS に登録する（部品を共有） ----------
  window.LAB_P = { esc: esc, n: n, pct: pct, sec: sec, dt: dt, dtFull: dtFull, dateShort: dateShort, rate: rate, median: median, chartColor: chartColor, delta: delta, tag: tag, thumb: thumb, card: card, kpi: kpi, legend: legend, note: note, typeLegend: typeLegend, lineChart: lineChart, vbars: vbars, stacked100: stacked100, scatter: scatter, heatmap: heatmap, cutTimeline: cutTimeline, funnel: funnel, pageHead: pageHead, PT_NOTE: PT_NOTE, TYPE: TYPE, SCREENS: SCREENS };
})();

// ---------- 投稿一覧、投稿詳細、リール分析、ストーリーズ、投稿時刻、接続と収集ログ ----------
(function () {
  var D = window.LAB_DATA, P = window.LAB_P, S = P.SCREENS;
  var n = P.n, pct = P.pct, esc = P.esc, tag = P.tag, card = P.card, note = P.note, legend = P.legend;
  function hash() { return (typeof location !== "undefined" && location.hash) || ""; }
  // 投稿したときのフォロワー数（見本用の近似。現在の数から投稿日までの日数で減らす）
  function folAt(p) { var days = (Date.parse("2026-10-01") - Date.parse(p.at.slice(0, 10))) / 864e5; return Math.round(1948 - days * 2.4); }
  function reachRate(p) { return p.reach / folAt(p); }
  function er(p) { return (p.likes + p.comments + p.saves + p.shares) / p.reach; }
  function q75(arr) { var a = arr.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(a.length * 0.75))]; }
  function q25(arr) { var a = arr.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length * 0.25)]; }
  // 投稿詳細の上のカード（量の指標）。値の下に、同じ種類の投稿の中央値と 25〜75% の範囲を添える。取れない項目は「—」。
  function qtyTiles(p, peers) {
    var HS = ' style="cursor:help;text-decoration:underline dotted"';
    var items = [
      ["リーチ", "reach", n, "リーチ = 投稿を見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）"],
      ["閲覧数", "views", n, "閲覧数 = 投稿が表示された回数。同じ人が何度見ても数える"],
      ["いいね", "likes", n, "いいね = いいねされた数"],
      ["保存", "saves", n, "保存 = 保存された数"],
      ["シェア", "shares", n, "シェア = シェアされた数"],
      ["プロフィール訪問", "pv", n, "プロフィール訪問 = この投稿からプロフィールに来た数。リールは API で取れない（—）"],
      ["フォロー", "follows", n, "フォロー = この投稿からフォローした数。リールは API で取れない（—）"],
      ["平均視聴時間", "watch", P.sec, "平均視聴時間 = 1 回の再生あたりの平均の視聴時間。リールだけ取れる"]
    ];
    return items.map(function (it) {
      var v = p[it[1]], f = it[2];
      var vals = peers.map(function (t) { return t[it[1]]; }).filter(function (x) { return x != null; });
      var SM = '<small style="display:block;color:var(--color-text-muted);font-size:var(--font-size-xs)">';
      var cmp = vals.length ? SM + "中央値: " + f(P.median(vals)) + "</small>" + SM + "25〜75%: " + f(q25(vals)) + "〜" + f(q75(vals)) + "</small>" : SM + "中央値: —</small>" + SM + "25〜75%: —</small>";
      return '<div><span title="' + esc(it[3] + "。下の小さな数字は、同じ種類の投稿の中央値と 25〜75% の範囲") + '"' + HS.replace('style="', 'style="display:block;margin-bottom:6px;') + ">" + it[0] + "</span><b style=\"margin-bottom:6px\">" + (v == null ? '<span class="dim">—</span>' : f(v)) + "</b>" + cmp + "</div>";
    }).join("");
  }
  function table(head, rows, foot) { return '<div class="table-wrap"><table class="table"><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody>" + (foot ? "<tfoot>" + foot + "</tfoot>" : "") + "</table></div>"; }

  // ---------- 投稿一覧 ----------
  S["media-list"] = function (ctx) {
    var posts = D.posts;
    var head = P.pageHead("投稿一覧", "全 " + n(D.account.mediaCount) + " 件・最終更新 " + P.dtFull(D.updatedAt), '<span class="btn btn--ghost">CSV</span>');
    var filters = '';
    var sorts = '<div class="tools"><span class="select">並べ替え: 投稿日時（新しい順）</span><span class="select">期間: 過去 90 日</span></div>';
    var th = '<th></th><th>投稿</th><th>種類</th><th aria-sort="descending">投稿日時</th><th class="num">リーチ</th><th class="num hide-m" title="閲覧数 = 投稿が表示された回数。同じ人が何度見ても数える" style="cursor:help;text-decoration:underline dotted">閲覧数</th><th class="num hide-m" title="いいね = いいねされた数" style="cursor:help;text-decoration:underline dotted">いいね</th><th class="num">保存</th><th class="num" title="保存率 = 保存 ÷ リーチ" style="cursor:help;text-decoration:underline dotted">保存率</th><th class="num" title="シェア率 = シェア ÷ リーチ" style="cursor:help;text-decoration:underline dotted">シェア率</th><th class="num" title="ER（エンゲージメント率） = (いいね + コメント + 保存 + シェア) ÷ リーチ" style="cursor:help;text-decoration:underline dotted">ER</th><th class="num hide-m" title="プロフ訪問 = この投稿からプロフィールに来た数。リールは API で取れない（—）" style="cursor:help;text-decoration:underline dotted">プロフ訪問</th>';
    var rows = posts.map(function (p) {
      return "<tr><td><a href=\"media-detail.html" + hash() + "\">" + P.thumb(p) + '</a></td><td class="title"><a href="media-detail.html' + hash() + '">' + esc(p.title) + "</a></td><td>" + tag(p.type) + '</td><td class="nowrap small">' + P.dt(p.at) + '</td><td class="num">' + n(p.reach) +
        '</td><td class="num hide-m">' + n(p.views) + '</td><td class="num hide-m">' + n(p.likes) + '</td><td class="num">' + n(p.saves) + '</td><td class="num">' + pct(p.saves / p.reach) + '</td><td class="num">' + pct(p.shares / p.reach) + '</td><td class="num">' + pct(er(p)) +
        '</td><td class="num hide-m">' + (p.pv == null ? '<span class="dim">—</span>' : n(p.pv)) + "</td></tr>";
    }).join("");
    var cards = '<div class="only-m media-cards">' + posts.map(function (p) {
      return '<div class="media-card"><a href="media-detail.html' + hash() + '">' + P.thumb(p) + '</a><div><div class="media-card__meta">' + tag(p.type) + "<span>" + P.dt(p.at) + '</span></div><div class="media-card__title"><a href="media-detail.html' + hash() + '">' + esc(p.title) + '</a></div><div class="media-card__nums"><div><b>' + n(p.reach) + "</b><span title=\"リーチ = 投稿を見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）\" style=\"cursor:help;text-decoration:underline dotted\">リーチ</span></div><div><b>" + n(p.saves) + "</b><span>保存</span></div><div><b>" + pct(p.saves / p.reach) + "</b><span>保存率</span></div><div><b>" + pct(er(p)) + "</b><span>ER</span></div></div></div></div>";
    }).join("") + "</div>";
    return head + '<div class="toolbar">' + filters + sorts + "</div>" + card(null, '<div class="only-d">' + table(th, rows) + "</div>" + cards) + '<nav class="pager" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:center;margin-top:calc(var(--space) * 2)"><span class="btn btn--ghost" style="opacity:.4">‹ 前へ</span><span class="btn" aria-current="page">1</span><span class="btn btn--ghost">2</span><span class="btn btn--ghost">3</span><span class="muted">…</span><span class="btn btn--ghost">24</span><span class="btn btn--ghost">次へ ›</span><span class="small muted" style="width:100%;text-align:center">1〜50 件目（全 1,186 件）</span></nav>';
  };

  // ---------- 投稿詳細 ----------
  S["media-detail"] = function (ctx) {
    var p = D.posts[0], G = D.growth, T = D.reelTimeline;
    var reels = D.posts.filter(function (t) { return t.type === "reel"; });
    var head = '<nav class="crumbs" aria-label="パンくずリスト"><ol><li><a href="media-list.html' + hash() + '">投稿一覧</a></li><li aria-current="page">' + esc(p.title) + "</li></ol></nav>" + P.pageHead("投稿詳細", "");
    var top = card(null, '<div class="detail-head">' + P.thumb(p, "thumb--lg") + '<div class="detail-head__body"><div class="media-card__meta">' + tag(p.type) + "<span>" + P.dtFull(p.at) + " 投稿</span><span>長さ " + p.len + " 秒</span><span>最終更新 " + P.dtFull(D.updatedAt) + "</span></div><h2>" + esc(p.title) + '</h2><p class="caption">今朝入った新豆を焙煎。火入れの瞬間と、1 ハゼまでの音を 28 秒で。（架空のキャプション）</p>' +
      "</div></div>",
      {});
    var w6 = ctx.cw(6);
    var growth = card("リーチの伸び方",
      legend([{ label: "この投稿", color: P.chartColor("reel") }, { label: "中央値", kind: "dash" }, { label: "25〜75% の範囲", color: "color-mix(in oklab, #3aa6dd 22%, var(--color-surface))" }]) +
      '<div class="metrics-row" style="grid-template-columns:repeat(2,minmax(0,1fr));margin:0 0 var(--gap)"><div><span style="display:block">中央値に対する倍率</span><b>' + (G.reach[5] / G.medianReel[5]).toFixed(1) + ' 倍</b></div><div><span style="display:block">全体の順位</span><b>上位 ' + Math.max(1, Math.round(reels.filter(function (t) { return t.reach >= p.reach; }).length / reels.length * 100)) + '%</b></div></div>' +
      '<div class="chart">' + P.lineChart({ w: ctx.cw(12), h: 220, labels: G.steps, band: [G.p25Reel, G.p75Reel], bandLabel: "25〜75%", series: [{ values: G.medianReel, dashed: true, label: "中央値" }, { values: G.reach, color: P.chartColor("reel"), label: "この投稿", dots: true, endLabel: n(G.reach[5]) }] }) + "</div>",
      {});
    // 質の指標を、行ごとの目盛の帯グラフで比べる。線は最小〜最大、帯は 25〜75%、縦線は中央値、点はこの投稿。右ほどよい側（スキップ率は向きを逆にする）。
    var DEF = {
      "リーチ": "リーチ = 投稿を見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）",
      "閲覧数": "閲覧数 = 投稿が表示された回数。同じ人が何度見ても数える",
      "いいね": "いいね = いいねされた数",
      "保存": "保存 = 保存された数",
      "シェア": "シェア = シェアされた数",
      "プロフィール訪問": "プロフィール訪問 = この投稿からプロフィールに来た数。リールは API で取れない",
      "フォロー": "フォロー = この投稿からフォローした数。リールは API で取れない",
      "平均視聴時間": "平均視聴時間 = 1 回の再生あたりの平均の視聴時間。リールだけ取れる",
      "リーチ率": "リーチ率 = 7 日時点のリーチ ÷ 投稿したときのフォロワー数。フォロワー数の増減の影響を取り除いて比べるための値",
      "保存率": "保存率 = 保存 ÷ リーチ",
      "シェア率": "シェア率 = シェア ÷ リーチ",
      "いいね率": "いいね率 = いいね ÷ リーチ",
      "ER": "ER（エンゲージメント率） = (いいね + コメント + 保存 + シェア) ÷ リーチ",
      "視聴維持率": "視聴維持率 = 平均視聴時間 ÷ 動画の長さ。リールだけ取れる",
      "スキップ率": "スキップ率 = 再生の最初の 3 秒以内に次へ進まれた割合。低いほどよい。リールだけ取れる"
    };
    function nameCell(label) { return '<span class="small" title="' + esc(DEF[label] || "") + '" style="cursor:help;text-decoration:underline dotted">' + label + "</span>"; }
    function cmpRow(label, mine, f, lowerIsBetter, fmt) {
      var pct = fmt || P.pct;
      var vals = reels.map(f).filter(function (v) { return v != null && !isNaN(v); });
      if (mine == null || !vals.length) return '<div style="display:grid;grid-column:1 / -1;grid-template-columns:subgrid;align-items:center;padding:4px 0">' + nameCell(label) + '<b class="num dim" style="text-align:right">—</b><span class="small" style="color:var(--color-text-muted);opacity:.7">（この種類では取れない）</span></div>';
      var med = P.median(vals), lo = q25(vals), hi = q75(vals);
      var mn = Math.min.apply(null, vals.concat([mine])), mx = Math.max.apply(null, vals.concat([mine]));
      var W = Math.max(140, w6 - 210), H = 28, pad = 8;
      var x = function (v) { var r = (v - mn) / ((mx - mn) || 1); if (lowerIsBetter) r = 1 - r; return (pad + r * (W - pad * 2)).toFixed(1); };
      var a = x(lo), b = x(hi), left = Math.min(a, b), wid = Math.abs(b - a);
      var tip = esc("下位 25%: " + pct(lo) + "\n中央値: " + pct(med) + "\n上位 25%: " + pct(hi));
      var svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + tip + '"><title>' + tip + "</title>" +
        '<line x1="' + x(mn) + '" x2="' + x(mx) + '" y1="14" y2="14" stroke="var(--chart-grid)" stroke-width="2"/>' +
        '<rect x="' + left + '" y="7" width="' + wid.toFixed(1) + '" height="14" rx="3" fill="color-mix(in oklab, #3aa6dd 22%, var(--color-surface))"/>' +
        '<line x1="' + x(med) + '" x2="' + x(med) + '" y1="4" y2="24" class="chart-ref"/>' +
        '<circle cx="' + x(mine) + '" cy="14" r="5" fill="' + P.chartColor("reel") + '" stroke="var(--color-surface)" stroke-width="2"/></svg>';
      return '<div style="display:grid;grid-column:1 / -1;grid-template-columns:subgrid;align-items:center;padding:4px 0">' + nameCell(label) + '<b class="num" style="text-align:right">' + pct(mine) + "</b>" + svg + "</div>";
    }
    var GH = function (s) { return '<p class="small muted" style="margin:12px 0 2px;font-weight:700">' + s + "</p>"; };
    var LEG = legend([{ label: "この投稿", color: P.chartColor("reel") }, { label: "中央値", kind: "dash" }, { label: "25〜75% の範囲", color: "color-mix(in oklab, #3aa6dd 22%, var(--color-surface))" }]);
    var qtyCard = card("量の指標", LEG + '<div style="display:grid;grid-template-columns:max-content max-content 1fr;column-gap:12px">' + 
      cmpRow("リーチ", p.reach, function (t) { return t.reach; }, false, n) +
      cmpRow("閲覧数", p.views, function (t) { return t.views; }, false, n) +
      cmpRow("いいね", p.likes, function (t) { return t.likes; }, false, n) +
      cmpRow("保存", p.saves, function (t) { return t.saves; }, false, n) +
      cmpRow("シェア", p.shares, function (t) { return t.shares; }, false, n) +
      cmpRow("プロフィール訪問", p.pv, function (t) { return t.pv; }, false, n) +
      cmpRow("フォロー", p.follows, function (t) { return t.follows; }, false, n) +
      cmpRow("平均視聴時間", p.watch, function (t) { return t.watch; }, false, P.sec) + "</div>");
    var qualCard = card("質の指標", LEG + '<div style="display:grid;grid-template-columns:max-content max-content 1fr;column-gap:12px">' + 
      cmpRow("リーチ率", reachRate(p), reachRate, false, function (v) { return P.pct(v, 0); }) +
      cmpRow("保存率", p.saves / p.reach, function (t) { return t.saves / t.reach; }) +
      cmpRow("シェア率", p.shares / p.reach, function (t) { return t.shares / t.reach; }) +
      cmpRow("いいね率", p.likes / p.reach, function (t) { return t.likes / t.reach; }) +
      cmpRow("ER", er(p), er) +
      cmpRow("視聴維持率", p.watch / p.len, function (t) { return t.watch / t.len; }) +
      cmpRow("スキップ率", p.skip, function (t) { return t.skip; }, true) + "</div>",
      { foot: "右ほどよい。スキップ率は低いほどよいので、向きを逆にしている。" });
    var textTotal = T.texts.reduce(function (a, t) { return a + (t.end - t.start); }, 0);
    var HS3 = ' style="display:block;cursor:help;text-decoration:underline dotted"';
    var vt = function (label, value, hint) { return '<div><span title="' + esc(hint) + '"' + HS3 + ">" + label + "</span><b>" + value + "</b></div>"; };
    var chars = T.texts.reduce(function (a, t) { return a + t.text.replace(/s/g, "").length; }, 0);
    var videoStats = '<div class="metrics-row" style="margin:0 0 var(--gap)">' +
      vt("動画の長さ", (T.lenMs / 1000).toFixed(1) + " 秒", "動画の長さ = 動画の全体の秒数") +
      vt("画面変化", (T.cuts.length - 1) + " 回", "画面変化 = 画面が大きく切り替わった回数。編集上のカットと一致しないことがある（フェードやズームにも反応する）") +
      vt("平均シーン長", (T.lenMs / 1000 / T.cuts.length).toFixed(1) + " 秒", "平均シーン長 = 動画の長さ ÷ シーンの数") +
      vt("最初の文字まで", (T.texts[0].start / 1000).toFixed(1) + " 秒", "最初の文字まで = 動画の始まりから、画面に最初の文字が出るまでの秒数") +
      vt("冒頭 3 秒の文字", T.texts[0].start < 3000 ? "あり" : "なし", "冒頭 3 秒の文字 = 動画の最初の 3 秒に、画面の文字が出ているか") +
      vt("文字の数", T.texts.length + " 件", "文字の数 = 画面に出た文字のまとまりの数") +
      vt("総文字数", chars + " 文字", "総文字数 = 画面に出た文字の合計の文字数（空白を除く）") +
      vt("文字の表示割合", pct(textTotal / T.lenMs, 0), "文字の表示割合 = 画面に文字が出ている時間 ÷ 動画の長さ") + "</div>";
    var tl = card("カットと画面の文字のタイムライン",
      videoStats + legend([{ label: "シーン（交互に濃淡）", color: P.chartColor("reel") }, { label: "画面の文字の表示区間", color: "var(--color-text)" }]) +
      '<div class="chart" style="margin-bottom:var(--gap)">' + P.cutTimeline({ w: ctx.cw(12), lenMs: T.lenMs, cuts: T.cuts, texts: T.texts, color: P.chartColor("reel") }) + "</div>" +
      table("<th>文字</th><th class=\"num\">開始</th><th class=\"num\">終了</th><th>位置</th>", T.texts.map(function (t) { return "<tr><td>" + esc(t.text) + '</td><td class="num">' + (t.start / 1000).toFixed(1) + ' 秒</td><td class="num">' + (t.end / 1000).toFixed(1) + " 秒</td><td>" + t.pos + "</td></tr>"; }).join("")),
      {});
    return head + top + '<div class="grid"><div class="col-6">' + qtyCard + '</div><div class="col-6">' + qualCard + '</div><div class="col-12">' + growth + '</div><div class="col-12">' + tl + "</div></div>";
  };

  // ---------- リール分析 ----------
  S.reels = function (ctx) {
    // 見本用の架空のリール 28 件（20〜50 件程度の段階の見た目を確かめるため）。乱数は固定の種で毎回同じ値になる。
    var seed = 7; function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
    var hours = [7, 8, 12, 12, 18, 19, 20, 21, 21, 22];
    var R = [];
    for (var i = 0; i < 28; i++) {
      var len = Math.round(8 + rnd() * 62), scene = 1.2 + rnd() * 4.5, cuts = Math.max(1, Math.round(len / scene) - 1);
      var text3 = rnd() < 0.6, first = text3 ? 0.2 + rnd() * 2.6 : 3.2 + rnd() * 5, chars = Math.round(rnd() * 80), cap = Math.round(20 + rnd() * 260);
      var daysAgo = 175 - i * 6, fol = Math.round(1950 - daysAgo * 2.4);
      var rate = 1.7 * Math.exp(-0.22 * (len / (cuts + 1) - 2.5)) * (text3 ? 1.3 : 1) * Math.exp((rnd() - 0.5) * 0.9);
      var d = new Date(Date.UTC(2026, 9, 1) - daysAgo * 864e5), hr = hours[Math.floor(rnd() * hours.length)];
      R.push({ id: 100 + i, type: "reel", hue: Math.round(rnd() * 360), title: "架空のリール " + (i + 1), date: d.toISOString().slice(0, 10), wday: d.getUTCDay(), hour: hr,
        len: len, cuts: cuts, scene: len / (cuts + 1), text3: text3, first: first, chars: chars, cap: cap, fol: fol, rate: rate, reach: Math.round(rate * fol),
        ret: Math.min(0.9, Math.max(0.15, 0.62 - 0.005 * len + (rnd() - 0.5) * 0.2 + rate * 0.03)), skip: Math.min(0.7, Math.max(0.1, 0.42 - (text3 ? 0.08 : 0) - rate * 0.03 + (rnd() - 0.5) * 0.12)),
        share: Math.max(0.001, 0.002 + rate * 0.004 + (rnd() - 0.5) * 0.004), save: Math.max(0.002, 0.01 + rate * 0.006 + (rnd() - 0.5) * 0.01) });
    }
    var c3 = P.chartColor("reel"), HS = ' style="cursor:help;text-decoration:underline dotted"';
    var RATE_HINT = "リーチ率 = 7 日時点のリーチ ÷ 投稿したときのフォロワー数。フォロワー数の増減の影響を取り除いて比べるための値";
    var rp = function (v) { return pct(v, 0); };
    var head = P.pageHead("リール分析", "リール " + R.length + " 件（過去 1 年間）・目的変数: <span title=\"" + esc(RATE_HINT) + "\"" + HS + ">リーチ率</span>", '<span class="select">期間: 過去 1 年間</span>');
    var wq = ctx.cw(4), w3 = ctx.cw(3), w12 = ctx.cw(12);

    // 1. 要因と目的変数の関係（順位相関とその幅）
    function ranks(a) { var idx = a.map(function (v, i) { return [v, i]; }).sort(function (x, y) { return x[0] - y[0]; }), r = []; for (var i = 0; i < idx.length;) { var j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (var k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; }
    function spearman(xs, ys) { var rx = ranks(xs), ry = ranks(ys), n = xs.length, mx = (n + 1) / 2, a = 0, b = 0, c = 0; for (var i = 0; i < n; i++) { a += (rx[i] - mx) * (ry[i] - mx); b += (rx[i] - mx) * (rx[i] - mx); c += (ry[i] - mx) * (ry[i] - mx); } return b && c ? a / Math.sqrt(b * c) : 0; }
    function ci(f) { var xs = R.map(f), ys = R.map(function (r) { return r.rate; }), bs = []; for (var b = 0; b < 300; b++) { var sx = [], sy = []; for (var i = 0; i < R.length; i++) { var k = Math.floor(rnd() * R.length); sx.push(xs[k]); sy.push(ys[k]); } bs.push(spearman(sx, sy)); } bs.sort(function (x, y) { return x - y; }); return { r: spearman(xs, ys), lo: bs[7], hi: bs[292] }; }
    var VARS = [
      ["動画の長さ", function (r) { return r.len; }, "動画の長さ = 動画の全体の秒数"],
      ["画面変化の回数", function (r) { return r.cuts; }, "画面変化の回数 = 画面が大きく切り替わった回数"],
      ["平均シーン長", function (r) { return r.scene; }, "平均シーン長 = 動画の長さ ÷ シーンの数"],
      ["最初の文字まで", function (r) { return r.first; }, "最初の文字まで = 画面に最初の文字が出るまでの秒数"],
      ["冒頭 3 秒の文字", function (r) { return r.text3 ? 1 : 0; }, "冒頭 3 秒の文字 = 最初の 3 秒に画面の文字があるか（あり = 1、なし = 0）"],
      ["総文字数", function (r) { return r.chars; }, "総文字数 = 画面に出た文字の合計の文字数"],
      ["キャプションの長さ", function (r) { return r.cap; }, "キャプションの長さ = キャプションの文字数"],
      ["投稿の時刻", function (r) { return r.hour; }, "投稿の時刻 = 投稿した時刻（日本時間の時）"]
    ];
    var cor = VARS.map(function (v) { var c = ci(v[1]); c.label = v[0]; c.hint = v[2]; return c; }).sort(function (a, b) { return Math.abs(b.r) - Math.abs(a.r); });
    var FW = Math.max(160, w12 - 260);
    function fx(v) { return (8 + (v + 1) / 2 * (FW - 16)).toFixed(1); }
    var forest = '<div style="display:grid;grid-template-columns:max-content max-content 1fr;column-gap:12px">' +
      '<span></span><span></span><svg width="' + FW + '" height="16" viewBox="0 0 ' + FW + ' 16"><g class="chart-axis">' + [-1, -0.5, 0, 0.5, 1].map(function (t) { return '<text x="' + fx(t) + '" y="12" text-anchor="middle">' + t + "</text>"; }).join("") + "</g></svg>" +
      cor.map(function (c) {
        var clear = c.lo > 0 || c.hi < 0, col = clear ? "var(--color-primary)" : "var(--chart-axis)";
        var tip = esc("順位相関: " + c.r.toFixed(2) + "\n幅（95%）: " + c.lo.toFixed(2) + "〜" + c.hi.toFixed(2) + (clear ? "" : "\n幅が 0 をまたぐので、まだわからない"));
        return '<div style="display:grid;grid-column:1 / -1;grid-template-columns:subgrid;align-items:center;padding:4px 0"><span class="small" title="' + esc(c.hint) + '"' + HS + ">" + c.label + '</span><b class="num" style="text-align:right' + (clear ? "" : ";opacity:.55") + '">' + (c.r > 0 ? "+" : "") + c.r.toFixed(2) + "</b>" +
          '<svg width="' + FW + '" height="22" viewBox="0 0 ' + FW + ' 22" role="img" aria-label="' + tip + '"><title>' + tip + "</title>" +
          '<line x1="' + fx(0) + '" x2="' + fx(0) + '" y1="0" y2="22" class="chart-ref"/>' +
          '<line x1="' + fx(c.lo) + '" x2="' + fx(c.hi) + '" y1="11" y2="11" stroke="' + col + '" stroke-width="3" stroke-linecap="round"' + (clear ? "" : ' opacity=".55"') + "/>" +
          '<circle cx="' + fx(c.r) + '" cy="11" r="5" fill="' + col + '" stroke="var(--color-surface)" stroke-width="2"/></svg></div>';
      }).join("") + "</div>";
    var corCard = card("リーチ率と結び付いている要因", legend([{ label: "順位相関", color: "var(--color-primary)" }, { label: "幅が 0 をまたぐ（まだわからない）", color: "var(--chart-axis)" }]) + forest,
      { foot: "右（+）ほど、その値が大きいリールほどリーチ率が高い。左（−）ほど、その値が小さいリールほどリーチ率が高い。" });

    // 2. リーチ率の上位と下位の比べ
    var sorted = R.slice().sort(function (a, b) { return b.rate - a.rate; }), q = Math.max(1, Math.round(R.length / 4));
    var top = sorted.slice(0, q), bot = sorted.slice(-q);
    function md(g, f) { return P.median(g.map(f)); }
    function meanOf(g, f) { return g.reduce(function (a, r) { return a + f(r); }, 0) / g.length; }
    var CMP = [
      ["リーチ率", function (r) { return r.rate; }, rp, RATE_HINT],
      ["動画の長さ", function (r) { return r.len; }, function (v) { return v.toFixed(0) + " 秒"; }, VARS[0][2]],
      ["画面変化の回数", function (r) { return r.cuts; }, function (v) { return v.toFixed(0) + " 回"; }, VARS[1][2]],
      ["平均シーン長", function (r) { return r.scene; }, function (v) { return v.toFixed(1) + " 秒"; }, VARS[2][2]],
      ["最初の文字まで", function (r) { return r.first; }, function (v) { return v.toFixed(1) + " 秒"; }, VARS[3][2]],
      ["冒頭 3 秒の文字", function (r) { return r.text3 ? 1 : 0; }, function (v) { return pct(v, 0) + " があり"; }, VARS[4][2]],
      ["総文字数", function (r) { return r.chars; }, function (v) { return v.toFixed(0) + " 文字"; }, VARS[5][2]],
      ["キャプションの長さ", function (r) { return r.cap; }, function (v) { return v.toFixed(0) + " 文字"; }, VARS[6][2]]
    ];
    var thumbs = function (g) { return '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0">' + g.map(function (r) { return '<span title="' + esc(r.title + "（リーチ率 " + rp(r.rate) + "）") + '">' + P.thumb(r) + "</span>"; }).join("") + "</div>"; };
    var tbCard = card("リーチ率の上位と下位",
      '<div class="grid" style="margin-bottom:var(--gap)"><div class="col-6"><p class="small muted">上位 25%（' + q + " 件）</p>" + thumbs(top) + '</div><div class="col-6"><p class="small muted">下位 25%（' + q + " 件）</p>" + thumbs(bot) + "</div></div>" +
      table("<th>項目</th><th class=\"num\">上位 25%</th><th class=\"num\">下位 25%</th>", CMP.map(function (c) {
        var f = c[0] === "冒頭 3 秒の文字" ? meanOf : md;
        return '<tr><td><span title="' + esc(c[3]) + '"' + HS + ">" + c[0] + '</span></td><td class="num">' + c[2](f(top, c[1])) + '</td><td class="num">' + c[2](f(bot, c[1])) + "</td></tr>";
      }).join("")), {});

    // 3. 数値の要因とリーチ率の散布図
    var medRate = P.median(R.map(function (r) { return r.rate; }));
    var sc = function (label, f, fmt, w) { return '<div class="col-4"><p class="small muted">' + label + '</p><div class="chart">' + P.scatter({ w: w, h: 190, color: c3, xLabel: label, yLabel: "リーチ率", xFmt: fmt, yFmt: rp, refY: medRate,
      points: R.map(function (r) { return { x: f(r), y: r.rate, label: r.title + "（" + label + " " + fmt(f(r)) + "、リーチ率 " + rp(r.rate) + "）" }; }) }) + "</div></div>"; };
    var secF = function (v) { return Math.round(v) + "s"; }, numF = function (v) { return Math.round(v); };
    var scCard = card("数値の要因とリーチ率", '<div class="grid">' +
      sc("動画の長さ", function (r) { return r.len; }, secF, wq) + sc("画面変化の回数", function (r) { return r.cuts; }, numF, wq) + sc("平均シーン長", function (r) { return r.scene; }, function (v) { return v.toFixed(1) + "s"; }, wq) +
      sc("最初の文字まで", function (r) { return r.first; }, function (v) { return v.toFixed(1) + "s"; }, wq) + sc("総文字数", function (r) { return r.chars; }, numF, wq) + sc("キャプションの長さ", function (r) { return r.cap; }, numF, wq) + "</div>",
      { foot: "点線はリーチ率の中央値。" });

    // 4. 区分の要因とリーチ率
    function grp(label, groups) {
      var vals = groups.map(function (g) { var a = R.filter(g[1]); return { label: g[0], n: a.length, v: a.length ? P.median(a.map(function (r) { return r.rate; })) : null }; });
      var dim = []; vals.forEach(function (v, i) { if (v.n < 3) dim.push(i); });
      return '<div class="col-4"><p class="small muted">' + label + '</p><div class="chart">' + P.vbars({ w: wq, h: 180, values: vals.map(function (v) { return v.v; }), labels: vals.map(function (v) { return v.label; }), color: c3, valueLabels: "all", fmt: rp, nLabels: vals.map(function (v) { return v.n; }), dim: dim }) + "</div></div>";
    }
    var grpCard = card("区分の要因とリーチ率", '<div class="grid">' +
      grp("冒頭 3 秒の文字", [["あり", function (r) { return r.text3; }], ["なし", function (r) { return !r.text3; }]]) +
      grp("投稿の曜日", [["平日", function (r) { return r.wday >= 1 && r.wday <= 5; }], ["土日", function (r) { return r.wday === 0 || r.wday === 6; }]]) +
      grp("投稿の時間帯", [["朝", function (r) { return r.hour < 11; }], ["昼", function (r) { return r.hour >= 11 && r.hour < 17; }], ["夜", function (r) { return r.hour >= 17; }]]) + "</div>",
      { foot: "棒はリーチ率の中央値。n は件数で、3 件未満の区分は薄く表示する。" });

    // 5. 途中の指標とリーチ率
    var sc4 = function (label, f, w) { return '<div class="col-3"><p class="small muted">' + label + '</p><div class="chart">' + P.scatter({ w: w, h: 180, color: c3, xLabel: label, yLabel: "リーチ率", xFmt: function (v) { return pct(v, v < 0.05 ? 1 : 0); }, yFmt: rp, refY: medRate,
      points: R.map(function (r) { return { x: f(r), y: r.rate, label: r.title + "（" + label + " " + pct(f(r), 1) + "、リーチ率 " + rp(r.rate) + "）" }; }) }) + "</div></div>"; };
    var midCard = card("視聴と反応の指標とリーチ率", '<div class="grid">' +
      sc4("視聴維持率", function (r) { return r.ret; }, w3) + sc4("スキップ率", function (r) { return r.skip; }, w3) + sc4("シェア率", function (r) { return r.share; }, w3) + sc4("保存率", function (r) { return r.save; }, w3) + "</div>",
      { foot: "点線はリーチ率の中央値。" });

    // 6. リーチとリーチ率の推移
    var labs = R.map(function (r) { return Number(r.date.slice(5, 7)) + "/" + Number(r.date.slice(8, 10)); });
    var trendCard = card("リーチとリーチ率の推移",
      '<p class="small muted">7 日時点のリーチ</p><div class="chart">' + P.vbars({ w: w12, h: 160, values: R.map(function (r) { return r.reach; }), labels: labs, color: c3 }) + "</div>" +
      '<p class="small muted" style="margin-top:24px">リーチ率</p><div class="chart">' + P.lineChart({ w: w12, h: 140, align: true, labels: labs, yFmt: rp, series: [{ values: R.map(function (r) { return r.rate; }), color: c3, label: "リーチ率", dots: true }] }) + "</div>",
      { foot: "横軸は投稿日。リーチが右肩上がりでもリーチ率が横ばいなら、伸びはフォロワーの増加による。" });

    return head + '<div class="grid"><div class="col-12">' + corCard + '</div><div class="col-12">' + tbCard + '</div><div class="col-12">' + scCard + '</div><div class="col-12">' + grpCard + '</div><div class="col-12">' + midCard + '</div><div class="col-12">' + trendCard + "</div></div>";
  };

  // ---------- ストーリーズ ----------
  S.stories = function (ctx) {
    // 見本用の架空のストーリーズ（過去 30 日）。ほぼ 1 日 1 枚で、ときどき続けて 2〜3 枚出す。乱数は固定の種で毎回同じ値になる。
    var seed = 11; function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
    var c4 = P.chartColor("story"), HS = ' style="cursor:help;text-decoration:underline dotted"';
    var th = function (label, text, cls, extra) { return '<th class="' + (cls || "num") + '"' + (extra || "") + (text ? ' title="' + esc(text) + '"' + HS : "") + ">" + label + "</th>"; };
    var DEF = {
      views: "閲覧 = そのストーリーズが表示された回数",
      rate: "閲覧率 = 閲覧 ÷ 投稿したときのフォロワー数。フォロワー数の増減の影響を取り除いて比べるための値",
      exitRate: "離脱率 = 離脱 ÷ 閲覧",
      fwd: "次へ = 次のストーリーズへ進んだ回数",
      back: "戻る = 前のストーリーズへ戻った回数",
      swipe: "次のアカウントへ = 次のアカウントのストーリーズへ移った回数",
      link: "リンク = リンクのスタンプが押された回数",
      replies: "返信 = ストーリーズへの返信（メッセージ）の数"
    };
    var L = [], base = Date.UTC(2026, 8, 2, 12);
    for (var d = 0; d < 30; d++) {
      if (rnd() < 0.25) continue;
      var k = rnd() < 0.15 ? 2 + Math.round(rnd()) : 1, hour = 8 + Math.floor(rnd() * 14);
      for (var j = 0; j < k; j++) {
        var at = new Date(base + d * 864e5 + (hour - 12) * 36e5 + j * 4 * 6e4), fol = Math.round(1880 + d * 2.3);
        var views = Math.round(fol * (0.16 + rnd() * 0.1) * (1 - j * 0.15)), exit = Math.round(views * (0.04 + rnd() * 0.08)), swipe = Math.round(views * (0.03 + rnd() * 0.05)), back = Math.round(views * (0.01 + rnd() * 0.03));
        L.push({ at: at, fol: fol, kind: rnd() < 0.4 ? "video" : "image", hue: Math.round(rnd() * 360), views: views, exit: exit, swipe: swipe, back: back, fwd: Math.max(0, views - exit - swipe - back), link: rnd() < 0.3 ? Math.round(rnd() * 12) : 0, replies: Math.round(rnd() * 4) });
      }
    }
    L.forEach(function (s) { s.rate = s.views / s.fol; s.exitRate = s.exit / s.views; s.label = (s.at.getUTCMonth() + 1) + "/" + s.at.getUTCDate() + " " + String(s.at.getUTCHours()).padStart(2, "0") + ":" + String(s.at.getUTCMinutes()).padStart(2, "0"); });
    var newest = L.slice().reverse();
    var head = P.pageHead("ストーリーズ", "全 " + L.length + " 件（過去 30 日）", '<span class="select">期間: 過去 30 日</span>');
    var w6 = ctx.cw(6), w12 = ctx.cw(12);

    // 期間全体の指標
    var vt = function (label, value, text) { return '<div><span title="' + esc(text) + '" style="display:block;cursor:help;text-decoration:underline dotted">' + label + "</span><b>" + value + "</b></div>"; };
    var sum = function (f) { return L.reduce(function (a, s) { return a + f(s); }, 0); };
    var stats = card(null, '<div class="metrics-row" style="margin:0">' +
      vt("件数", L.length + " 件", "件数 = 期間中に出したストーリーズの数") +
      vt("閲覧率の中央値", pct(P.median(L.map(function (s) { return s.rate; })), 0), DEF.rate) +
      vt("離脱率の中央値", pct(P.median(L.map(function (s) { return s.exitRate; })), 1), DEF.exitRate) +
      vt("リンクの合計", n(sum(function (s) { return s.link; })), DEF.link) +
      vt("返信の合計", n(sum(function (s) { return s.replies; })), DEF.replies) + "</div>");

    // 1. 一覧
    var listCard = card("ストーリーズの一覧", table("<th></th>" + th("投稿日時", "", "", ' aria-sort="descending"') + "<th>種類</th>" + th("閲覧", DEF.views) + th("閲覧率", DEF.rate) + th("離脱率", DEF.exitRate) + th("次へ", DEF.fwd, "num hide-m") + th("戻る", DEF.back, "num hide-m") + th("次のアカウントへ", DEF.swipe, "num hide-m") + th("リンク", DEF.link) + th("返信", DEF.replies, "num hide-m"),
      newest.map(function (s) {
        return '<tr><td><span class="thumb" data-type="story" style="--hue:' + s.hue + '">' + (s.kind === "video" ? "▶" : "") + '</span></td><td class="nowrap small">' + s.label + "</td><td>" + (s.kind === "video" ? "動画" : "画像") + '</td><td class="num">' + n(s.views) + '</td><td class="num">' + pct(s.rate, 0) + '</td><td class="num">' + pct(s.exitRate, 1) +
          '</td><td class="num hide-m">' + n(s.fwd) + '</td><td class="num hide-m">' + n(s.back) + '</td><td class="num hide-m">' + n(s.swipe) + '</td><td class="num">' + n(s.link) + '</td><td class="num hide-m">' + n(s.replies) + "</td></tr>";
      }).join("")), {});

    // 2. 閲覧率の推移
    var labs = L.map(function (s) { return (s.at.getUTCMonth() + 1) + "/" + s.at.getUTCDate(); });
    var trendCard = card("閲覧率の推移", '<div class="chart">' + P.lineChart({ w: w12, h: 180, align: true, labels: labs, yFmt: function (v) { return pct(v, 0); },
      series: [{ values: L.map(function (s) { return s.rate; }), color: c4, label: "閲覧率", dots: true }] }) + "</div>", {});

    // 3. 操作の内訳（1 件ごと）
    var ops = [["fwd", "次へ", 90], ["back", "戻る", 65], ["exit", "離脱", 45], ["swipe", "次のアカウントへ", 25]];
    var mix = function (p) { return "color-mix(in oklab, var(--heat) " + p + "%, var(--color-surface))"; };
    var recent = newest.slice(0, 10), labelW = 78, bw = w6 - labelW, rowH = 30;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w6 + " " + (rowH * recent.length) + '" width="' + w6 + '" height="' + (rowH * recent.length) + '" role="img">';
    recent.forEach(function (s, i) {
      var total = s.fwd + s.back + s.exit + s.swipe || 1, x = labelW, y = i * rowH + 6;
      svg += '<text class="chart-label" x="0" y="' + (y + 13) + '">' + s.label + "</text>";
      ops.forEach(function (o, oi) {
        var v = s[o[0]], pw = bw * v / total; if (pw <= 0) return;
        var rw = Math.max(0, pw - (oi < ops.length - 1 ? 2 : 0));
        svg += '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + rw.toFixed(1) + '" height="18" rx="' + (oi === ops.length - 1 ? 4 : 0) + '" fill="' + mix(o[2]) + '"><title>' + s.label + " " + o[1] + ": " + n(v) + "（" + pct(v / total, 0) + "）</title></rect>";
        x += pw;
      });
    });
    svg += "</svg>";
    var opsCard = card("操作の内訳（直近 10 件）", legend(ops.map(function (o) { return { label: o[1], color: mix(o[2]) }; })) + '<div class="chart">' + svg + "</div>", {});

    // 4. 離脱ファネル（続けて 2 件以上出したまとまりがあるときだけ）。前の 1 件から 6 時間以上空いたら別のまとまり
    var groups = [], cur = [];
    L.forEach(function (s, i) { if (i && s.at - L[i - 1].at >= 6 * 36e5) { groups.push(cur); cur = []; } cur.push(s); }); groups.push(cur);
    var multi = groups.filter(function (g) { return g.length >= 2; });
    var funCard;
    if (multi.length) {
      var g = multi[multi.length - 1], v0 = g[0].views;
      funCard = card("離脱ファネル（" + g[0].label + " から続けて " + g.length + " 件）", '<div class="chart">' + P.vbars({ w: w6, h: 200, values: g.map(function (s) { return s.views / v0; }), labels: g.map(function (s, i) { return (i + 1) + " 件目"; }), color: c4, valueLabels: "all", maxBar: 40, max: 1, fmt: function (v) { return pct(v, 0); },
        tips: g.map(function (s, i) { return (i + 1) + " 件目: " + pct(s.views / v0, 0) + "（閲覧 " + n(s.views) + "）"; }) }) + "</div>", {});
    } else {
      funCard = card("離脱ファネル", '<p class="small muted">期間中に、続けて 2 件以上出したストーリーズはありません。</p>', {});
    }

    return head + stats + '<div class="grid"><div class="col-12">' + listCard + '</div><div class="col-12">' + trendCard + '</div><div class="col-6">' + opsCard + '</div><div class="col-6">' + funCard + "</div></div>";
  };

  // ---------- 投稿時刻 ----------
  S.timing = function (ctx) {
    var T = D.timing, B = D.timingByBand, W = D.timingByDay;
    var total = B.n.reduce(function (a, b) { return a + b; }, 0);
    var head = P.pageHead("投稿時刻", "投稿後 24 時間のリーチ（過去 1 年間の投稿 " + total + " 件）", '<span class="select">指標: 24 時間リーチ</span><span class="select">種類: すべて</span>');
    var heat = card("曜日 × 時間帯の 24 時間リーチ（中央値）",'<div class="chart">' + P.heatmap({ w: ctx.cw(12), rows: T.days, cols: T.bands, values: T.median, counts: T.n }) + "</div>",
      { foot: "※: n=1" });
    var dim = []; B.n.forEach(function (c, i) { if (c < 3) dim.push(i); });
    var bands = card("時間帯別の 24 時間リーチ（中央値）",'<div class="chart">' + P.vbars({ w: ctx.cw(6), h: 220, values: B.median, labels: B.bands, color: "var(--heat)", valueLabels: "all", nLabels: B.n, dim: dim }) + "</div>");
    var wdim = []; W.n.forEach(function (c, i) { if (c < 3) wdim.push(i); });
    var days = card("曜日別の 24 時間リーチ（中央値）",'<div class="chart">' + P.vbars({ w: ctx.cw(6), h: 220, values: W.median, labels: W.days, color: "var(--heat)", valueLabels: "all", nLabels: W.n, dim: wdim }) + "</div>");
    // 組み合わせごとの投稿 1 件ずつの 24 時間リーチ（架空。中央値のまわりに決まった比率で散らす）
    var spread = function (m, cnt, seed) {
      var out = [];
      for (var k = 0; k < cnt; k++) { var f = cnt === 1 ? 1 : 1 + (k - (cnt - 1) / 2) * (0.9 / cnt) + (((seed + k * 5) % 3) - 1) * 0.06; out.push(Math.round(m * f)); }
      return out;
    };
    var cells = [], all = [];
    T.days.forEach(function (d, di) { T.bands.forEach(function (b, bi) {
      var cnt = T.n[di][bi]; if (!cnt) return;
      var vs = spread(T.median[di][bi], cnt, di * 8 + bi); all = all.concat(vs);
      if (cnt >= 2) cells.push({ d: d, b: b, v: T.median[di][bi], n: cnt, vs: vs });
    }); });
    cells.sort(function (a, b) { return b.v - a.v; });
    var top = cells.slice(0, 5), allMed = P.median(all);
    // 帯グラフ: 線は最小〜最大、点は投稿 1 件ずつ、縦線はこの組み合わせの中央値、灰色の線は全投稿の中央値。目盛は全行で共通
    var sVals = top.reduce(function (a, c) { return a.concat(c.vs); }, [allMed]);
    var sMin = Math.min.apply(null, sVals), sMax = Math.max.apply(null, sVals);
    var SW = Math.max(160, ctx.cw(12) - 340), SH = 28, sp = 8;
    var sx = function (v) { return (sp + (v - sMin) / ((sMax - sMin) || 1) * (SW - sp * 2)).toFixed(1); };
    var strip = function (c) {
      var mn = Math.min.apply(null, c.vs), mx = Math.max.apply(null, c.vs);
      var tip = esc(c.d + " " + c.b + " 時: " + c.vs.map(n).join("、") + "（中央値 " + n(c.v) + "）");
      return '<svg width="' + SW + '" height="' + SH + '" viewBox="0 0 ' + SW + " " + SH + '" role="img" aria-label="' + tip + '">' +
        '<line x1="' + sx(allMed) + '" x2="' + sx(allMed) + '" y1="0" y2="' + SH + '" stroke="var(--color-text-muted)" stroke-width="1" opacity=".5"/>' +
        '<line x1="' + sx(mn) + '" x2="' + sx(mx) + '" y1="14" y2="14" stroke="var(--chart-grid)" stroke-width="2"/>' +
        '<rect x="' + sx(q25(c.vs)) + '" y="7" width="' + (sx(q75(c.vs)) - sx(q25(c.vs))).toFixed(1) + '" height="14" rx="3" fill="color-mix(in oklab, #3aa6dd 22%, var(--color-surface))"/>' +
        '<line x1="' + sx(c.v) + '" x2="' + sx(c.v) + '" y1="4" y2="24" class="chart-ref"/>' +
        c.vs.map(function (v) { return '<g><title>' + n(v) + '</title><circle cx="' + sx(v) + '" cy="14" r="10" fill="transparent"/><circle cx="' + sx(v) + '" cy="14" r="5" fill="' + P.chartColor("reel") + '" stroke="var(--color-surface)" stroke-width="2"/></g>'; }).join("") + "</svg>";
    };
    var bestLeg = legend([{ label: "投稿", color: P.chartColor("reel") }, { label: "組み合わせの中央値", kind: "dash" }, { label: "25〜75% の範囲", color: "color-mix(in oklab, #3aa6dd 22%, var(--color-surface))" }, { label: "全投稿の中央値（" + n(allMed) + "）", color: "var(--color-text-muted)" }]);
    var best = card("上位の組み合わせ", bestLeg + table("<th>曜日</th><th>時間帯</th><th class=\"num\">中央値</th><th class=\"num\">件数</th><th>投稿ごとの 24 時間リーチ</th>", top.map(function (c) { return "<tr><td>" + c.d + "</td><td>" + c.b + " 時</td><td class=\"num\">" + n(c.v) + '</td><td class="num">' + c.n + "</td><td>" + strip(c) + "</td></tr>"; }).join("")), { sub: "件数 1 件の組み合わせは除く" });
    return head + '<div class="grid"><div class="col-12">' + heat + '</div><div class="col-6">' + bands + '</div><div class="col-6">' + days + '</div><div class="col-12">' + best + "</div></div>";
  };

  // ---------- 接続と収集ログ ----------
  S.connection = function (ctx) {
    var C = D.connection, J = D.jobs;
    var failed = J.filter(function (j) { return j.state === "bad"; }).length, warned = J.filter(function (j) { return j.state === "warn"; }).length;
    var head = P.pageHead("接続と収集ログ", "最終成功 " + P.dtFull(C.lastSuccessAt) + "・次回 " + P.dtFull(C.nextRunAt), '<span class="btn btn--ghost">今すぐ収集</span>');
    var alert = failed ? '<div class="callout" data-state="bad"><b>直近 24 時間に失敗が ' + failed + ' 件。</b> media-poll が 20:00 に HTTP 500 で失敗（3 回の再試行後）。21:00 の実行で回復済み。3 回続けて失敗したら通知する。</div>' : "";
    var kpis = '<div class="kpis">' + P.kpi("24 時間の実行", "48", null, "成功 46・注意 " + warned + "・失敗 " + failed) + P.kpi("連続失敗", "0", null, "通知のしきい値 3") + P.kpi("トークン期限まで", String(C.tokenDaysLeft), null, C.tokenExpiresAt, "日") +
      P.kpi("API 使用率", pct(C.rateUsage, 0), null, "直近 1 時間") + P.kpi("保存した投稿", n(D.account.mediaCount), null, "初速の収集中 1 件") + P.kpi("保存した日次指標", "742", null, "日分（2 年分を遡って取得済み）") + "</div>";
    var tState = C.tokenDaysLeft < 7 ? "bad" : C.tokenDaysLeft < 14 ? "warn" : "ok";
    var status = card("接続状態", '<div class="stack"><dl class="dl"><dt>状態</dt><dd><span class="status" data-state="ok">接続中</span></dd><dt>Facebook ページ</dt><dd>' + esc(C.pageName) + "</dd><dt>Instagram</dt><dd>" + esc(C.igAccount) + "（プロアカウント・架空）</dd><dt>トークン</dt><dd>長期トークン・" + C.tokenIssuedAt + " 発行</dd><dt>期限</dt><dd>" + C.tokenExpiresAt + "（あと " + C.tokenDaysLeft + " 日）</dd></dl>" +
      '<div class="progress" data-state="' + tState + '"><i style="width:' + pct(C.tokenDaysLeft / C.tokenDaysTotal, 0) + '"></i></div><p class="xs muted">期限の 14 日前から注意、7 日前から重大として通知する。</p></div>', { sub: "Meta Graph API" });
    var sched = card("収集スケジュール", '<div class="stack"><dl class="dl"><dt>投稿の確認</dt><dd>' + C.schedule + "</dd><dt>日次指標</dt><dd>毎日 23:30（PT の前日分）</dd><dt>ストーリーズ</dt><dd>毎時 00 分（公開中は 15 分おき）</dd><dt>トークン確認</dt><dd>毎日 18:00</dd><dt>実行環境</dt><dd>GitHub Actions（Production）</dd></dl>" +
      '<p class="xs muted">API 使用率（直近 1 時間）: ' + pct(C.rateUsage, 0) + '</p><div class="progress" data-state="ok"><i style="width:' + pct(C.rateUsage, 0) + '"></i></div></div>', { sub: "cron" });
    var label = { ok: "成功", warn: "注意", bad: "失敗" };
    var rows = J.map(function (j) {
      return '<tr data-state="' + (j.state === "ok" ? "" : j.state) + '"><td class="nowrap small">' + P.dt(j.at) + "</td><td><code>" + j.job + '</code></td><td><span class="status" data-state="' + j.state + '">' + label[j.state] + '</span></td><td class="num hide-m">' + (j.ms / 1000).toFixed(1) + ' 秒</td><td class="num hide-m">' + n(j.items) + '</td><td><span class="log-msg" title="' + esc(j.msg) + '">' + esc(j.msg) + "</span></td></tr>";
    }).join("");
    var log = card("ジョブの実行記録", '<div class="chips"><span class="chip" aria-pressed="true">すべて</span><span class="chip">失敗のみ</span><span class="chip">media-poll</span><span class="chip">stories-poll</span><span class="chip">insights-daily</span><span class="chip">token-check</span></div>' +
      table("<th>時刻</th><th>ジョブ</th><th>結果</th><th class=\"num hide-m\">所要</th><th class=\"num hide-m\">件数</th><th>内容</th>", rows),
      { sub: "直近 12 件" });
    return head + alert + kpis + '<div class="grid"><div class="col-6">' + status + '</div><div class="col-6">' + sched + '</div><div class="col-12">' + log + "</div></div>";
  };
})();

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
  function tag(type) { return '<span class="tag" data-type="' + type + '"><i></i>' + TYPE[type].label + "</span>"; }
  function thumb(p, cls) { return '<span class="thumb' + (cls ? " " + cls : "") + '" data-type="' + p.type + '" style="--hue:' + p.hue + '">' + (p.type === "reel" ? "▶" : p.type === "carousel" ? "▣" : "") + "</span>"; }
  function card(title, body, o) {
    o = o || {};
    return '<section class="card' + (o.cls ? " " + o.cls : "") + '">' +
      (title ? '<div class="card__head"><h2>' + title + "</h2>" + (o.sub ? '<span class="card__sub">' + o.sub + "</span>" : "") + "</div>" : "") +
      body + (o.foot ? '<div class="card__foot">' + o.foot + "</div>" : "") + "</section>";
  }
  function kpi(label, value, deltaHtml, denom, unit) {
    return '<div class="card kpi"><div class="kpi__label">' + label + '</div><div class="kpi__value">' + value + (unit ? "<small>" + unit + "</small>" : "") + "</div>" +
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
    var w = o.w, h = o.h || 200, m = { t: 16, r: 14, b: 26, l: 44 };
    var iw = w - m.l - m.r, ih = h - m.t - m.b;
    var all = [];
    o.series.forEach(function (s) { all = all.concat(s.values.filter(function (v) { return v != null; })); });
    if (o.band) all = all.concat(o.band[1]);
    var min = o.min != null ? o.min : 0;
    var max = o.max || niceMax(Math.max.apply(null, all) * 1.08);
    var N = o.labels.length;
    var x = function (i) { return m.l + (N > 1 ? iw * i / (N - 1) : iw / 2); };
    var y = function (v) { return m.t + ih - ih * (v - min) / (max - min); };
    var s = svgOpen(w, h) + '<g class="chart-grid">';
    ticks(max - min, 4).forEach(function (t) { var yy = y(t + min); s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + yy + '" y2="' + yy + '"/>'; });
    s += '</g><g class="chart-axis">';
    ticks(max - min, 4).forEach(function (t) { s += '<text x="' + (m.l - 6) + '" y="' + (y(t + min) + 4) + '" text-anchor="end">' + fmtAxis(t + min) + "</text>"; });
    var step = Math.max(1, Math.ceil(N / Math.max(2, Math.floor(iw / 56))));
    o.labels.forEach(function (l, i) { if (i % step === 0 || (N <= 8 && i === N - 1)) s += '<text x="' + x(i) + '" y="' + (h - 6) + '" text-anchor="middle">' + l + "</text>"; });
    s += "</g>";
    (o.markers || []).forEach(function (i) { s += '<line class="chart-marker" x1="' + x(i) + '" x2="' + x(i) + '" y1="' + m.t + '" y2="' + (m.t + ih) + '"/>'; });
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
      ticks(max, 4).forEach(function (t) { s += '<text x="' + (m.l - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + fmtAxis(t) + "</text>"; });
      s += "</g>";
    } else {
      s += '<g class="chart-axis"><line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + (m.t + ih) + '" y2="' + (m.t + ih) + '"/></g>';
    }
    var step = Math.max(1, Math.ceil(N / Math.max(2, Math.floor(iw / 44))));
    s += '<g class="chart-axis">';
    o.labels.forEach(function (l, i) {
      if (i % step === 0) s += '<text x="' + (m.l + slot * i + slot / 2).toFixed(1) + '" y="' + (h - (o.nLabels ? 18 : 6)) + '" text-anchor="middle">' + l + "</text>";
      if (o.nLabels) s += '<text x="' + (m.l + slot * i + slot / 2).toFixed(1) + '" y="' + (h - 4) + '" text-anchor="middle"' + (o.nLabels[i] < 3 ? ' opacity=".55"' : "") + ">n=" + o.nLabels[i] + "</text>";
    });
    s += "</g>";
    vals.forEach(function (v, i) {
      var x = m.l + slot * i + (slot - bw) / 2, hgt = ih * v / max;
      var col = o.colors ? o.colors[i] : o.color;
      var dim = o.dim && o.dim.indexOf(i) >= 0;
      if (v > 0) s += '<path d="' + barV(x, y(v), bw, hgt, 4) + '" fill="' + col + '"' + (dim ? ' opacity=".35"' : "") + "><title>" + o.labels[i] + ": " + (o.fmt ? o.fmt(o.values[i]) : n(o.values[i])) + "</title></path>";
      else if (o.values[i] == null) s += '<text class="chart-label chart-label--muted" x="' + (x + bw / 2).toFixed(1) + '" y="' + (m.t + ih - 6) + '" text-anchor="middle">—</text>';
      if (o.valueLabels === "all" || (o.valueLabels && o.valueLabels.indexOf(i) >= 0)) s += '<text class="chart-label" x="' + (x + bw / 2).toFixed(1) + '" y="' + (y(v) - 5).toFixed(1) + '" text-anchor="middle">' + (o.fmt ? o.fmt(o.values[i]) : n(o.values[i])) + "</text>";
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
        s += '<rect class="heat-cell" x="' + x.toFixed(1) + '" y="' + y + '" width="' + cellW.toFixed(1) + '" height="' + cellH + '" rx="3" fill="color-mix(in oklab, var(--heat) ' + p + '%, var(--color-surface))"' + (cnt < 2 ? ' opacity=".45"' : "") + "><title>" + r + " " + c + " 時: 中央値 " + n(v) + "（n=" + cnt + "）</title></rect>";
        if (cellW >= 34) s += '<text x="' + (x + cellW / 2).toFixed(1) + '" y="' + (y + cellH / 2 + 4) + '" text-anchor="middle" font-size="10.5" fill="' + (p > 55 ? "var(--color-surface)" : "var(--color-text)") + '"' + (cnt < 2 ? ' opacity=".7"' : "") + ">" + n(v) + "</text>";
      });
    });
    return s + "</svg>";
  }

  // リールのカットと画面の文字のタイムライン
  function cutTimeline(o) {
    var w = o.w, m = { l: 6, r: 6 }, iw = w - m.l - m.r, len = o.lenMs;
    var x = function (ms) { return m.l + iw * ms / len; };
    var rulerY = 14, sceneY = 26, sceneH = 18, textY = 62, textH = 14, h = textY + textH + 26;
    var s = svgOpen(w, h) + '<g class="chart-axis">';
    for (var t = 0; t <= len; t += 5000) s += '<line x1="' + x(t).toFixed(1) + '" x2="' + x(t).toFixed(1) + '" y1="' + (rulerY - 4) + '" y2="' + rulerY + '"/><text x="' + x(t).toFixed(1) + '" y="' + (rulerY - 6) + '" text-anchor="middle">' + (t / 1000) + "s</text>";
    s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + rulerY + '" y2="' + rulerY + '"/></g>';
    var cuts = o.cuts.concat([len]);
    for (var i = 0; i < cuts.length - 1; i++) {
      var a = x(cuts[i]), b = x(cuts[i + 1]);
      s += '<rect x="' + a.toFixed(1) + '" y="' + sceneY + '" width="' + Math.max(0, b - a - 2).toFixed(1) + '" height="' + sceneH + '" rx="3" fill="' + o.color + '" opacity="' + (i % 2 ? ".55" : ".85") + '"><title>シーン ' + (i + 1) + ": " + ((cuts[i + 1] - cuts[i]) / 1000).toFixed(1) + " 秒</title></rect>";
    }
    o.cuts.forEach(function (c, i) { if (i) s += '<path d="M' + x(c).toFixed(1) + " " + (sceneY - 2) + 'l-3 -5h6z" fill="var(--color-text)"/>'; });
    s += '<text class="chart-label chart-label--muted" x="' + m.l + '" y="' + (sceneY + sceneH + 12) + '">大きな画面変化 ' + (o.cuts.length - 1) + " 回・平均シーン長 " + (len / 1000 / o.cuts.length).toFixed(1) + " 秒</text>";
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
      kpi("リーチ", n(K.reach.cur), delta(K.reach.cur, K.reach.prev), "前期 " + n(K.reach.prev)) +
      kpi("閲覧数", n(K.views.cur), delta(K.views.cur, K.views.prev), "前期 " + n(K.views.prev)) +
      kpi("フォロワー純増", "+" + n(K.followerGain.cur), delta(K.followerGain.cur, K.followerGain.prev), "現在 " + n(D.account.followers)) +
      kpi("エンゲージメント率", pct(K.engagementRate.cur, 2), delta(K.engagementRate.cur, K.engagementRate.prev), "分母: リーチ") +
      kpi("保存率", pct(K.saveRate.cur, 2), delta(K.saveRate.cur, K.saveRate.prev), "分母: リーチ・目安 2〜3%") +
      kpi("プロフィール訪問（参考）", n(K.profileVisits.cur), delta(K.profileVisits.cur, K.profileVisits.prev), "フィードとストーリーズの投稿単位の合計") +
      "</div>";
    var w8 = ctx.cw(8), w4 = ctx.cw(4);
    var reachMax = D.daily.reach.indexOf(Math.max.apply(null, D.daily.reach));
    var trend = card("日次推移",
      legend([{ label: "リーチ（日次）", color: "var(--chart-1)" }, { label: "▲ 投稿日", kind: "line", color: "transparent" }]) +
      '<div class="chart">' + vbars({ w: w8, h: 170, values: D.daily.reach, labels: labels, color: "var(--chart-1)", markers: postIdx, valueLabels: [reachMax] }) + "</div>" +
      '<p class="small muted">フォロワー数</p><div class="chart">' + lineChart({ w: w8, h: 130, labels: labels, min: 1800, max: 2000, markers: postIdx, series: [{ values: D.daily.followers, color: "var(--chart-1)", label: "フォロワー数", endLabel: n(D.account.followers) }] }) + "</div>",
      { sub: "日付は米国太平洋時間の区切り", foot: "▲ は投稿のあった日（日本時間）。" });
    var fun = card("ファネル", funnel(D.funnel), { sub: "期間の合計", foot: "アカウント単位のプロフィール訪問は API にないため、ファネルには入れていない。" });
    var rows = [
      { label: "投稿数", parts: D.byType.map(function (t) { return { type: t.type, value: t.posts }; }) },
      { label: "リーチ", parts: D.byType.map(function (t) { return { type: t.type, value: t.reach }; }) },
      { label: "保存", parts: D.byType.filter(function (t) { return t.type !== "story"; }).map(function (t) { return { type: t.type, value: t.saves }; }) }
    ];
    var types = card("投稿の種類の内訳", typeLegend() + '<div class="chart">' + stacked100({ w: w4, rows: rows }) + "</div>" +
      '<div class="table-wrap"><table class="table"><thead><tr><th>種類</th><th class="num">投稿</th><th class="num">リーチ</th><th class="num">保存</th></tr></thead><tbody>' +
      D.byType.map(function (t) { return "<tr><td>" + tag(t.type) + '</td><td class="num">' + n(t.posts) + '</td><td class="num">' + n(t.reach) + '</td><td class="num">' + (t.type === "story" ? "—" : n(t.saves)) + "</td></tr>"; }).join("") +
      "</tbody></table></div>", { foot: "ストーリーズの保存は API にない。" });
    return head + kpis + '<div class="grid"><div class="col-8">' + trend + '</div><div class="col-4 stack">' + fun + types + "</div></div>" + note(PT_NOTE);
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
  function er(p) { return (p.likes + p.comments + p.saves + p.shares) / p.reach; }
  function q75(arr) { var a = arr.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(a.length * 0.75))]; }
  function table(head, rows, foot) { return '<div class="table-wrap"><table class="table"><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody>" + (foot ? "<tfoot>" + foot + "</tfoot>" : "") + "</table></div>"; }

  // ---------- 投稿一覧 ----------
  S["media-list"] = function (ctx) {
    var posts = D.posts;
    var head = P.pageHead("投稿一覧", "全 " + n(D.account.mediaCount) + " 件のうち直近 " + posts.length + " 件・最終更新 " + P.dtFull(D.updatedAt), '<span class="btn btn--ghost">CSV</span>');
    var filters = '<div class="chips"><span class="chip" aria-pressed="true">すべて</span><span class="chip">フィード</span><span class="chip">カルーセル</span><span class="chip">リール</span><span class="chip">コラボ・ブーストを除く</span></div>';
    var sorts = '<div class="tools"><span class="select">並べ替え: 投稿日時（新しい順）</span><span class="select">期間: 過去 90 日</span></div>';
    var th = '<th></th><th>投稿</th><th>種類</th><th aria-sort="descending">投稿日時</th><th class="num">リーチ</th><th class="num hide-m">閲覧数</th><th class="num hide-m">いいね</th><th class="num">保存</th><th class="num">保存率</th><th class="num">シェア率</th><th class="num">ER</th><th class="num hide-m">プロフ訪問</th>';
    var rows = posts.map(function (p) {
      return "<tr><td>" + P.thumb(p) + '</td><td class="title"><a href="media-detail.html' + hash() + '">' + esc(p.title) + "</a></td><td>" + tag(p.type) + '</td><td class="nowrap small">' + P.dt(p.at) + '</td><td class="num">' + n(p.reach) +
        '</td><td class="num hide-m">' + n(p.views) + '</td><td class="num hide-m">' + n(p.likes) + '</td><td class="num">' + n(p.saves) + '</td><td class="num">' + pct(p.saves / p.reach) + '</td><td class="num">' + pct(p.shares / p.reach) + '</td><td class="num">' + pct(er(p)) +
        '</td><td class="num hide-m">' + (p.pv == null ? '<span class="dim">—</span>' : n(p.pv)) + "</td></tr>";
    }).join("");
    var cards = '<div class="only-m media-cards">' + posts.map(function (p) {
      return '<div class="media-card">' + P.thumb(p) + '<div><div class="media-card__meta">' + tag(p.type) + "<span>" + P.dt(p.at) + '</span></div><div class="media-card__title">' + esc(p.title) + '</div><div class="media-card__nums"><div><b>' + n(p.reach) + "</b><span>リーチ</span></div><div><b>" + n(p.saves) + "</b><span>保存</span></div><div><b>" + pct(p.saves / p.reach) + "</b><span>保存率</span></div><div><b>" + pct(er(p)) + "</b><span>ER</span></div></div></div></div>";
    }).join("") + "</div>";
    return head + '<div class="toolbar">' + filters + sorts + "</div>" + card(null, '<div class="only-d">' + table(th, rows) + "</div>" + cards, { foot: "率の分母はリーチ。ER = (いいね＋コメント＋保存＋シェア) ÷ リーチ。プロフィール訪問はリールでは取れない（—）。並べ替えと絞り込みは見た目だけ。" });
  };

  // ---------- 投稿詳細 ----------
  S["media-detail"] = function (ctx) {
    var p = D.posts[0], G = D.growth, T = D.reelTimeline;
    var reels = D.posts.filter(function (t) { return t.type === "reel"; });
    var head = P.pageHead("投稿詳細", '<a href="media-list.html' + hash() + '">投稿一覧</a> › ' + esc(p.title));
    var top = card(null, '<div class="detail-head">' + P.thumb(p, "thumb--lg") + '<div class="detail-head__body"><div class="media-card__meta">' + tag(p.type) + "<span>" + P.dtFull(p.at) + " 投稿</span><span>長さ " + p.len + " 秒</span><span>最終更新 " + P.dtFull(D.updatedAt) + "</span></div><h2>" + esc(p.title) + '</h2><p class="caption">今朝入った新豆を焙煎。火入れの瞬間と、1 ハゼまでの音を 28 秒で。（架空のキャプション）</p>' +
      '<div class="metrics-row"><div><b>' + n(p.reach) + "</b><span>リーチ</span></div><div><b>" + n(p.views) + "</b><span>閲覧数</span></div><div><b>" + n(p.likes) + "</b><span>いいね（" + pct(p.likes / p.reach) + "）</span></div><div><b>" + n(p.saves) + "</b><span>保存（" + pct(p.saves / p.reach) + "）</span></div><div><b>" + n(p.shares) + "</b><span>シェア（" + pct(p.shares / p.reach) + "）</span></div><div><b>" + P.sec(p.watch) + "</b><span>平均視聴時間</span></div><div><b>" + pct(p.watch / p.len, 0) + "</b><span>視聴維持率</span></div><div><b>" + pct(p.skip, 0) + "</b><span>スキップ率</span></div></div></div></div>",
      { foot: "リールは API でプロフィール訪問とフォローが取れないため、視聴系の指標を表示する。" });
    var w6 = ctx.cw(6);
    var growth = card("投稿後の伸び方（リーチ）",
      legend([{ label: "この投稿", color: P.chartColor("reel") }, { label: "リールの中央値", kind: "dash" }, { label: "25〜75% の範囲", color: "color-mix(in oklab, var(--chart-ref) 25%, var(--color-surface))" }]) +
      '<div class="chart">' + P.lineChart({ w: w6, h: 220, labels: G.steps, band: [G.p25Reel, G.p75Reel], bandLabel: "リールの 25〜75%", series: [{ values: G.medianReel, dashed: true, label: "リールの中央値" }, { values: G.reach, color: P.chartColor("reel"), label: "この投稿", dots: true, endLabel: n(G.reach[5]) }] }) + "</div>",
      { sub: "同じ種類（リール " + reels.length + " 件）との比較", foot: "7 日時点で中央値の " + (G.reach[5] / G.medianReel[5]).toFixed(2) + " 倍。横軸は収集の時点（1h〜7d。90 日まで続く）。" });
    function cmpRow(label, mine, f, lowerIsBetter) {
      var med = P.median(reels.map(f)), hi = q75(reels.map(f));
      var good = lowerIsBetter ? mine <= med : mine >= med;
      return "<tr><td>" + label + '</td><td class="num"><b>' + pct(mine) + '</b></td><td class="num">' + pct(med) + '</td><td class="num">' + pct(hi) + '</td><td><span class="delta" data-dir="' + (good ? "up" : "down") + '">' + (good ? "中央値以上" : "中央値未満") + "</span></td></tr>";
    }
    var cmp = card("同じ種類との比較", table("<th>指標</th><th class=\"num\">この投稿</th><th class=\"num\">中央値</th><th class=\"num\">上位 25%</th><th></th>",
      cmpRow("保存率", p.saves / p.reach, function (t) { return t.saves / t.reach; }) +
      cmpRow("シェア率", p.shares / p.reach, function (t) { return t.shares / t.reach; }) +
      cmpRow("いいね率", p.likes / p.reach, function (t) { return t.likes / t.reach; }) +
      cmpRow("ER", er(p), er) +
      cmpRow("視聴維持率", p.watch / p.len, function (t) { return t.watch / t.len; }) +
      cmpRow("スキップ率", p.skip, function (t) { return t.skip; }, true)),
      { sub: "リール " + reels.length + " 件・率の分母はリーチ", foot: "平均ではなく中央値と上位 25% で比べる（一部のバズ投稿に引っ張られないため）。スキップ率は低いほどよい。" });
    var textTotal = T.texts.reduce(function (a, t) { return a + (t.end - t.start); }, 0);
    var tl = card("カットと画面の文字のタイムライン",
      legend([{ label: "シーン（交互に濃淡）", color: P.chartColor("reel") }, { label: "画面の文字の表示区間", color: "var(--color-text)" }]) +
      '<div class="chart">' + P.cutTimeline({ w: ctx.cw(12), lenMs: T.lenMs, cuts: T.cuts, texts: T.texts, color: P.chartColor("reel") }) + "</div>" +
      table("<th>文字</th><th class=\"num\">開始</th><th class=\"num\">終了</th><th>位置</th>", T.texts.map(function (t) { return "<tr><td>" + esc(t.text) + '</td><td class="num">' + (t.start / 1000).toFixed(1) + ' 秒</td><td class="num">' + (t.end / 1000).toFixed(1) + " 秒</td><td>" + t.pos + "</td></tr>"; }).join("")),
      { sub: "R4（カット）と R4.1（文字）で追加", foot: "最初の文字まで " + (T.texts[0].start / 1000).toFixed(1) + " 秒・冒頭 3 秒に文字あり・文字が表示されている時間の割合 " + pct(textTotal / T.lenMs, 0) + "・「大きな画面変化」は編集上のカットと一致しないことがある（フェードやズームにも反応する）。" });
    return head + top + '<div class="grid"><div class="col-6">' + growth + '</div><div class="col-6">' + cmp + '</div><div class="col-12">' + tl + "</div></div>";
  };

  // ---------- リール分析 ----------
  S.reels = function (ctx) {
    var reels = D.posts.filter(function (t) { return t.type === "reel"; });
    var c3 = P.chartColor("reel");
    var head = P.pageHead("リール分析", "リール " + reels.length + " 件（過去 90 日）・動画特徴量とインサイトの掛け合わせ", '<span class="select">期間: 過去 90 日</span><span class="select">縦軸: 視聴維持率</span>');
    var w6 = ctx.cw(6), w4 = ctx.cw(4), w8 = ctx.cw(8);
    var sc = card("長さと視聴維持率", '<div class="chart">' + P.scatter({ w: w6, h: 240, color: c3, xLabel: "動画の長さ（秒）", yLabel: "視聴維持率", xFmt: function (v) { return v + "s"; }, yFmt: function (v) { return pct(v, 0); },
      points: reels.map(function (r) { return { x: r.len, y: r.watch / r.len, label: r.title + "（" + r.len + " 秒、" + pct(r.watch / r.len, 0) + "）", hi: r.id === 12 || r.id === 15 }; }) }) + "</div>",
      { sub: "視聴維持率 = 平均視聴時間 ÷ 動画の長さ（長さは R4 で自前取得）", foot: "点にホバーで投稿名。短いほど維持率は高いが、件数が少ないうちは傾向として読まない。" });
    var buckets = [["0〜15 秒", 0, 15], ["15〜30 秒", 15, 30], ["30〜60 秒", 30, 60], ["60 秒超", 60, 1e9]];
    var bk = buckets.map(function (b) { var g = reels.filter(function (r) { return r.len > b[1] && r.len <= b[2]; }); return { label: b[0], n: g.length, ret: g.length ? P.median(g.map(function (r) { return r.watch / r.len; })) : null, skip: g.length ? P.median(g.map(function (r) { return r.skip; })) : null, reach: g.length ? P.median(g.map(function (r) { return r.reach; })) : null }; });
    var dim = []; bk.forEach(function (b, i) { if (b.n < 2) dim.push(i); });
    var bucketCard = card("長さの区分ごとの中央値", '<div class="chart">' + P.vbars({ w: w6, h: 200, values: bk.map(function (b) { return b.ret; }), labels: bk.map(function (b) { return b.label; }), color: c3, valueLabels: "all", fmt: function (v) { return pct(v, 0); }, nLabels: bk.map(function (b) { return b.n; }), dim: dim, max: 1 }) + "</div>" +
      table("<th>区分</th><th class=\"num\">件数</th><th class=\"num\">視聴維持率</th><th class=\"num\">スキップ率</th><th class=\"num\">リーチ</th>", bk.map(function (b) { return '<tr class="' + (b.n < 2 ? "dim" : "") + '"><td>' + b.label + '</td><td class="num">' + b.n + '</td><td class="num">' + pct(b.ret, 0) + '</td><td class="num">' + pct(b.skip, 0) + '</td><td class="num">' + n(b.reach) + "</td></tr>"; }).join("")),
      { sub: "縦棒は視聴維持率の中央値", foot: "件数が 2 件未満の区分は薄く表示する。" });
    var bins = [["〜5", 0, 5], ["6〜10", 6, 10], ["11〜15", 11, 15], ["16〜", 16, 1e9]];
    var cnt = bins.map(function (b) { return reels.filter(function (r) { return r.cuts >= b[1] && r.cuts <= b[2]; }).length; });
    var cutsCard = card("大きな画面変化の回数の分布", '<div class="chart">' + P.vbars({ w: w4, h: 170, values: cnt, labels: bins.map(function (b) { return b[0] + " 回"; }), color: c3, valueLabels: "all", noAxis: true, fmt: function (v) { return v + " 件"; } }) + "</div>",
      { sub: "ffmpeg のシーン検出", foot: "フェード、ズーム、激しい動きにも反応するため「大きな画面変化の回数」と呼ぶ。" });
    var withT = reels.filter(function (r) { return r.text3; }), noT = reels.filter(function (r) { return !r.text3; });
    function med(g, f) { return g.length ? P.median(g.map(f)) : null; }
    var textCard = card("冒頭 3 秒の文字の有無", '<div class="grid"><div class="col-4"><div class="chart">' + P.vbars({ w: Math.max(200, Math.floor((w8 - 32) / 3)), h: 170, values: [med(withT, function (r) { return r.skip; }), med(noT, function (r) { return r.skip; })], labels: ["文字あり", "文字なし"], color: c3, valueLabels: "all", fmt: function (v) { return pct(v, 0); }, nLabels: [withT.length, noT.length], max: 0.5 }) + '</div><p class="xs muted">スキップ率の中央値</p></div><div class="col-8">' +
      table("<th>冒頭 3 秒の文字</th><th class=\"num\">件数</th><th class=\"num\">スキップ率</th><th class=\"num\">視聴維持率</th><th class=\"num\">保存率</th><th class=\"num\">リーチ</th>",
        [["あり", withT], ["なし", noT]].map(function (g) { return "<tr><td>" + g[0] + '</td><td class="num">' + g[1].length + '</td><td class="num">' + pct(med(g[1], function (r) { return r.skip; }), 0) + '</td><td class="num">' + pct(med(g[1], function (r) { return r.watch / r.len; }), 0) + '</td><td class="num">' + pct(med(g[1], function (r) { return r.saves / r.reach; })) + '</td><td class="num">' + n(med(g[1], function (r) { return r.reach; })) + "</td></tr>"; }).join("")) + "</div></div>",
      { sub: "R4.1 で追加", foot: "「冒頭 3 秒に文字があるリールはスキップ率が低いか」を確かめる表。中央値で比べる。" });
    return head + '<div class="grid"><div class="col-6">' + sc + '</div><div class="col-6">' + bucketCard + '</div><div class="col-4">' + cutsCard + '</div><div class="col-8">' + textCard + "</div></div>" + note("件数が少ないうちは統計的な結論を出せない。区分ごとの件数を必ず表示し、少ない区分は目立たない表示にする（要件 4.5 章）。");
  };

  // ---------- ストーリーズ ----------
  S.stories = function (ctx) {
    var day = D.stories[0], c4 = P.chartColor("story");
    var head = P.pageHead("ストーリーズ", day.date + "（" + day.slides.length + " 枚）・直近 3 日", '<span class="seg"><button aria-pressed="true">9/30</button><button>9/29</button><button>9/28</button></span><span class="select">期間: 過去 7 日</span>');
    var w6 = ctx.cw(6);
    var strip = '<div class="story-strip">' + day.slides.map(function (s, i) { return '<span class="thumb" data-type="reel" style="--hue:' + (40 + i * 50) + '">' + (s.kind === "video" ? "▶" : "") + "</span>"; }).join("") + "</div>";
    var views = day.slides.map(function (s) { return s.views; });
    var fun = card("1 枚ごとの閲覧数（離脱ファネル）", strip + '<div class="chart">' + P.vbars({ w: w6, h: 200, values: views, labels: day.slides.map(function (s, i) { return (i + 1) + " 枚目"; }), color: c4, valueLabels: "all", maxBar: 40 }) + "</div>",
      { sub: "閲覧数は 1 枚ごとの合計", foot: "完了率 " + pct(views[views.length - 1] / views[0], 0) + "（最後の 1 枚 ÷ 最初の 1 枚）。" });
    var ops = [["fwd", "次へ", 90], ["back", "戻る", 65], ["exit", "離脱", 45], ["swipe", "次のアカウントへ", 25]];
    var mix = function (p) { return "color-mix(in oklab, var(--heat) " + p + "%, var(--color-surface))"; };
    var labelW = 48, bw = w6 - labelW, rowH = 38;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w6 + " " + (rowH * day.slides.length) + '" width="' + w6 + '" height="' + (rowH * day.slides.length) + '" role="img">';
    day.slides.forEach(function (s, i) {
      var total = s.fwd + s.back + s.exit + s.swipe || 1, x = labelW, y = i * rowH + 4;
      svg += '<text class="chart-label" x="0" y="' + (y + 13) + '">' + (i + 1) + " 枚目</text>";
      ops.forEach(function (o, oi) {
        var v = s[o[0]], pw = bw * v / total; if (pw <= 0) return;
        var rw = Math.max(0, pw - (oi < ops.length - 1 ? 2 : 0));
        svg += '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + rw.toFixed(1) + '" height="16" rx="' + (oi === ops.length - 1 ? 4 : 0) + '" fill="' + mix(o[2]) + '"><title>' + o[1] + ": " + n(v) + "（" + pct(v / total, 0) + "）</title></rect>";
        if (rw >= 30) svg += '<text class="chart-label chart-label--muted" x="' + (x + rw / 2).toFixed(1) + '" y="' + (y + 30) + '" text-anchor="middle">' + pct(v / total, 0) + "</text>";
        x += pw;
      });
    });
    svg += "</svg>";
    var opsCard = card("操作の内訳", legend(ops.map(function (o) { return { label: o[1], color: mix(o[2]) }; })) + '<div class="chart">' + svg + "</div>",
      { sub: "各枚の操作の合計に対する割合（1 色の濃淡）", foot: "離脱率 = 離脱 ÷ 閲覧数、次のアカウントへの移動率 = 次のアカウントへ ÷ 閲覧数。最後の 1 枚は「次へ」がない。" });
    var tbl = card("1 枚ごとの数字", table("<th>枚</th><th>種類</th><th class=\"num\">長さ</th><th class=\"num\">閲覧</th><th class=\"num hide-m\">次へ</th><th class=\"num hide-m\">戻る</th><th class=\"num\">離脱</th><th class=\"num\">次のアカウントへ</th><th class=\"num hide-m\">リンク</th><th class=\"num\">離脱率</th>",
      day.slides.map(function (s, i) { return "<tr><td>" + (i + 1) + "</td><td>" + (s.kind === "video" ? "動画" : "画像") + '</td><td class="num">' + s.len + ' 秒</td><td class="num">' + n(s.views) + '</td><td class="num hide-m">' + n(s.fwd) + '</td><td class="num hide-m">' + n(s.back) + '</td><td class="num">' + n(s.exit) + '</td><td class="num">' + n(s.swipe) + '</td><td class="num hide-m">' + n(s.link) + '</td><td class="num">' + pct(s.exit / s.views) + "</td></tr>"; }).join("")),
      { foot: "動画の長さは R1 でストーリーズの動画を解析して得る（24 時間で取得できなくなるため）。" });
    var days = card("日ごとの要約", table("<th>日</th><th class=\"num\">枚数</th><th class=\"num\">最初の閲覧</th><th class=\"num\">最後の閲覧</th><th class=\"num\">完了率</th><th class=\"num\">リンク</th>",
      D.stories.map(function (d) { var v = d.slides.map(function (s) { return s.views; }); var link = d.slides.reduce(function (a, s) { return a + s.link; }, 0); return "<tr><td>" + P.dateShort(d.date) + '</td><td class="num">' + d.slides.length + '</td><td class="num">' + n(v[0]) + '</td><td class="num">' + n(v[v.length - 1]) + '</td><td class="num">' + pct(v[v.length - 1] / v[0], 0) + '</td><td class="num">' + n(link) + "</td></tr>"; }).join("")));
    return head + '<div class="grid"><div class="col-6">' + fun + '</div><div class="col-6">' + opsCard + '</div><div class="col-8">' + tbl + '</div><div class="col-4">' + days + "</div></div>";
  };

  // ---------- 投稿時刻 ----------
  S.timing = function (ctx) {
    var T = D.timing, B = D.timingByBand;
    var total = B.n.reduce(function (a, b) { return a + b; }, 0);
    var head = P.pageHead("投稿時刻", "投稿後 24 時間のリーチの中央値（日本時間、過去 180 日の投稿 " + total + " 件）", '<span class="select">指標: 24 時間リーチ</span><span class="select">種類: すべて</span>');
    var heat = card("曜日 × 時間帯", '<div class="chart">' + P.heatmap({ w: ctx.cw(8), rows: T.days, cols: T.bands, values: T.median, counts: T.n }) + "</div>",
      { sub: "濃いほど中央値が高い。件数 2 件未満は薄く", foot: "セルの数字は 24 時間リーチの中央値。ホバーで件数。深夜帯（0〜6 時）は投稿がない。" });
    var dim = []; B.n.forEach(function (c, i) { if (c < 3) dim.push(i); });
    var bands = card("時間帯別の初速", '<div class="chart">' + P.vbars({ w: ctx.cw(4), h: 220, values: B.median, labels: B.bands, color: "var(--heat)", valueLabels: "all", nLabels: B.n, dim: dim }) + "</div>",
      { sub: "曜日をまとめた中央値", foot: "18〜21 時が最も高いが、投稿数も多い（n=34）。件数 3 件未満は薄く。" });
    var cells = [];
    T.days.forEach(function (d, di) { T.bands.forEach(function (b, bi) { if (T.n[di][bi] >= 2) cells.push({ d: d, b: b, v: T.median[di][bi], n: T.n[di][bi] }); }); });
    cells.sort(function (a, b) { return b.v - a.v; });
    var best = card("上位の組み合わせ", table("<th>曜日</th><th>時間帯</th><th class=\"num\">中央値</th><th class=\"num\">件数</th>", cells.slice(0, 5).map(function (c) { return "<tr><td>" + c.d + "</td><td>" + c.b + " 時</td><td class=\"num\">" + n(c.v) + '</td><td class="num">' + c.n + "</td></tr>"; }).join("")), { sub: "件数 2 件以上" });
    return head + '<div class="grid"><div class="col-8">' + heat + '</div><div class="col-4 stack">' + bands + best + "</div></div>" + note("この画面は投稿日時をもとに日本時間で集計する。時間帯別のオンラインフォロワー数は API で取れないため、自分の投稿の初速で代用する（要件 F-UI-42）。" + P.PT_NOTE);
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
      '<div class="progress" data-state="' + tState + '"><i style="width:' + pct(C.tokenDaysLeft / C.tokenDaysTotal, 0) + '"></i></div><p class="xs muted">期限の 14 日前から注意、7 日前から重大として通知する。</p><p><span class="btn">再接続（Facebook でログイン）</span> <span class="btn btn--ghost">トークンを確認</span></p></div>', { sub: "Meta Graph API" });
    var sched = card("収集スケジュール", '<div class="stack"><dl class="dl"><dt>投稿の確認</dt><dd>' + C.schedule + "</dd><dt>日次指標</dt><dd>毎日 23:30（PT の前日分）</dd><dt>ストーリーズ</dt><dd>毎時 00 分（公開中は 15 分おき）</dd><dt>トークン確認</dt><dd>毎日 18:00</dd><dt>実行環境</dt><dd>GitHub Actions（Production）</dd></dl>" +
      '<p class="xs muted">API 使用率（直近 1 時間）: ' + pct(C.rateUsage, 0) + '</p><div class="progress" data-state="ok"><i style="width:' + pct(C.rateUsage, 0) + '"></i></div></div>', { sub: "cron" });
    var label = { ok: "成功", warn: "注意", bad: "失敗" };
    var rows = J.map(function (j) {
      return '<tr data-state="' + (j.state === "ok" ? "" : j.state) + '"><td class="nowrap small">' + P.dt(j.at) + "</td><td><code>" + j.job + '</code></td><td><span class="status" data-state="' + j.state + '">' + label[j.state] + '</span></td><td class="num hide-m">' + (j.ms / 1000).toFixed(1) + ' 秒</td><td class="num hide-m">' + n(j.items) + '</td><td><span class="log-msg" title="' + esc(j.msg) + '">' + esc(j.msg) + "</span></td></tr>";
    }).join("");
    var log = card("ジョブの実行記録", '<div class="chips"><span class="chip" aria-pressed="true">すべて</span><span class="chip">失敗のみ</span><span class="chip">media-poll</span><span class="chip">stories-poll</span><span class="chip">insights-daily</span><span class="chip">token-check</span></div>' +
      table("<th>時刻</th><th>ジョブ</th><th>結果</th><th class=\"num hide-m\">所要</th><th class=\"num hide-m\">件数</th><th>内容</th>", rows),
      { sub: "直近 12 件", foot: "失敗した行は背景を変え、内容を太字にする。注意（レート制限、繰り延べ）は薄い黄色。" });
    return head + alert + kpis + '<div class="grid"><div class="col-6">' + status + '</div><div class="col-6">' + sched + '</div><div class="col-12">' + log + "</div></div>";
  };
})();

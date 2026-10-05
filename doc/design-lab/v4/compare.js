// design-lab v4: 期間比較の画面だけの見本。数字はすべて架空。
// v3 の render.js から、書式と折れ線の部品だけを複製した（NAV と案の切り替えは外した）。
// 日次の値と投稿は、日付から決まる式で作る（乱数は使わない。再読み込みしても同じ値）。
(function () {
  var D = (typeof window !== "undefined" && window.LAB_DATA) || { account: { name: "こまち焙煎所（架空）", handle: "@komachi.roast.demo" }, updatedAt: "2026-10-01T23:30" };

  // ---------- 文字と数字（v3 の render.js と同じ） ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function n(v) { return v == null ? "—" : Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function pct(v, d) { return v == null ? "—" : (v * 100).toFixed(d == null ? 1 : d) + "%"; }
  var MISSING = '<span title="計算に要る記録がない" style="cursor:help">—</span>';

  // 差（apps/web の lib/metrics.ts の deltaRate、deltaPoint、deltaCount と components/Delta.tsx に合わせる）
  function deltaHtml(kind, cur, prev) {
    var value, text;
    if (kind === "rate") {
      if (cur == null) return "";
      if (prev == null || prev === 0) return '<span class="delta" data-dir="flat">前期 0</span>';
      value = (cur - prev) / prev;
      text = Math.abs(value * 100) < 0.05 ? "±0.0%" : (value > 0 ? "+" : "") + (value * 100).toFixed(1) + "%";
    } else if (kind === "pt") {
      if (cur == null || prev == null) return "";
      value = cur - prev;
      text = Math.abs(value * 100) < 0.05 ? "±0.0 pt" : (value > 0 ? "+" : "") + (value * 100).toFixed(1) + " pt";
    } else {
      if (cur == null || prev == null) return "";
      value = cur - prev;
      text = value === 0 ? "±0" : (value > 0 ? "+" : "-") + n(Math.abs(value));
    }
    var dir = kind === "count" ? (value === 0 ? "flat" : value > 0 ? "up" : "down") : Math.abs(value) < 0.0005 ? "flat" : value > 0 ? "up" : "down";
    var body = dir === "flat" ? text : (dir === "up" ? "▲ " : "▼ ") + text;
    return '<span class="delta" data-dir="' + dir + '">' + body + "</span>";
  }

  function card(title, body, foot) {
    return '<section class="card col-12"><div class="card__head"><h2>' + title + "</h2></div>" + body + (foot ? '<div class="card__foot">' + foot + "</div>" : "") + "</section>";
  }

  // ---------- 日付（YYYY-MM-DD を UTC の日として扱う） ----------
  function toDate(ymd) { var p = ymd.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function ymdOf(d) { return d.toISOString().slice(0, 10); }
  function addDays(ymd, k) { var d = toDate(ymd); d.setUTCDate(d.getUTCDate() + k); return ymdOf(d); }
  function dayNo(ymd) { return Math.round(toDate(ymd).getTime() / 86400000); }
  function monthOf(y, m) { // m は 1〜12。範囲外は年を繰る
    var d = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0));
    return { from: ymdOf(d), to: ymdOf(last) };
  }
  function eachDay(p) { var out = [], d = p.from; while (d <= p.to) { out.push(d); d = addDays(d, 1); } return out; }
  function periodLabel(p) { return p.from + "〜" + p.to; }

  // ---------- 架空のデータ（日付から決まる式） ----------
  var LATEST = "2026-09-30";      // 日次指標の最新の日（太平洋時間の日付）
  var DATA_START = "2025-08-20";  // 日次指標の始まり（前年同月の B が途中から始まる見本にする）
  var POST_START = "2025-06-01";  // 投稿はこれより前からある
  function h(i, k) { var x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }

  function dailyOf(ymd) {
    if (ymd < DATA_START || ymd > LATEST) return null;
    var i = dayNo(ymd), g = (i - dayNo(DATA_START)) / 400;
    var reach = Math.round((1700 + 900 * g) * (1 + 0.22 * Math.sin(i * 2 * Math.PI / 7)) + 1100 * h(i, 1) + (postOf(ymd) ? postOf(ymd).reach * 0.35 : 0));
    return { reach: reach, views: Math.round(reach * (1.45 + 0.4 * h(i, 3))), nonFollowerReach: Math.round(reach * (0.32 + 0.22 * h(i, 2))) };
  }
  // フォロワー数の記録（日本時間の日付）
  function followersOf(ymd) {
    if (ymd < DATA_START || ymd > LATEST) return null;
    var i = dayNo(ymd) - dayNo(DATA_START);
    return 1180 + Math.floor(i * 1.6 + 14 * h(i, 4));
  }
  // 1 日に 0 か 1 件の投稿（投稿日時の日本時間の日付）。値は各投稿の最新の値
  function postOf(ymd) {
    if (ymd < POST_START || ymd > LATEST) return null;
    var i = dayNo(ymd);
    if (h(i, 5) < 0.68) return null;
    var k = h(i, 6), kind = k < 0.35 ? "feed" : k < 0.62 ? "carousel" : "reel";
    var r = h(i, 7);
    var reach = Math.round(kind === "feed" ? 700 + 900 * r : kind === "carousel" ? 1400 + 2400 * r : 2800 + 9000 * r);
    return {
      date: ymd, kind: kind, reach: reach,
      likes: Math.round(reach * (0.045 + 0.05 * h(i, 8))),
      comments: Math.round(reach * (0.002 + 0.006 * h(i, 9))),
      saves: Math.round(reach * (kind === "carousel" ? 0.04 + 0.07 * h(i, 10) : 0.008 + 0.03 * h(i, 10))),
      shares: Math.round(reach * (kind === "reel" ? 0.008 + 0.02 * h(i, 11) : 0.002 + 0.008 * h(i, 11))),
      pv: kind === "reel" ? null : Math.round(reach * (0.01 + 0.02 * h(i, 12)))  // リールのプロフィール訪問は API で取れない
    };
  }

  // ---------- 期間 ----------
  var PRESETS = [["7d", "前 7 日"], ["30d", "前 30 日"], ["90d", "前 3 か月"], ["month", "前月"], ["yoy", "前年同月"]];
  function resolve(preset) {
    var y = +LATEST.slice(0, 4), m = +LATEST.slice(5, 7);
    if (preset === "7d") return { a: { from: addDays(LATEST, -6), to: LATEST }, b: { from: addDays(LATEST, -13), to: addDays(LATEST, -7) } };
    if (preset === "90d") return { a: { from: addDays(LATEST, -89), to: LATEST }, b: { from: addDays(LATEST, -179), to: addDays(LATEST, -90) } };
    if (preset === "month") return { a: monthOf(y, m - 1), b: monthOf(y, m - 2) };
    if (preset === "yoy") return { a: monthOf(y, m - 1), b: monthOf(y - 1, m - 1) };
    return { a: { from: addDays(LATEST, -29), to: LATEST }, b: { from: addDays(LATEST, -59), to: addDays(LATEST, -30) } };
  }
  function presetNow() {
    var p = (typeof location !== "undefined" && location.hash || "").replace("#", "");
    return PRESETS.some(function (x) { return x[0] === p; }) ? p : "30d";  // 不明な値は既定（前 30 日）
  }

  // ---------- 期間の集計 ----------
  function ratio(list, num, den) {
    var used = list.filter(function (x) { return num(x) != null && den(x) != null; });
    var s1 = 0, s2 = 0;
    used.forEach(function (x) { s1 += num(x); s2 += den(x); });
    return { value: used.length && s2 > 0 ? s1 / s2 : null, used: used.length, total: list.length };
  }
  function side(p) {
    var days = eachDay(p), rows = days.map(dailyOf).filter(Boolean);
    var sum = function (k) { return rows.length ? rows.reduce(function (a, r) { return a + r[k]; }, 0) : null; };
    var posts = days.map(postOf).filter(Boolean);
    var fStart = followersOf(addDays(p.from, -1)), fEnd = followersOf(p.to);
    var pvUsed = posts.filter(function (x) { return x.pv != null; });
    var inter = function (x) { return x.likes + x.comments + x.saves + x.shares; };
    var reachOf = function (x) { return x.reach; };
    return {
      periodDays: days.length, days: rows.length,
      reach: sum("reach"), views: sum("views"),
      nf: { value: rows.length ? sum("nonFollowerReach") / sum("reach") : null, used: rows.length, total: rows.length },
      followers: fStart != null && fEnd != null ? fEnd - fStart : null,
      posts: posts,
      er: ratio(posts, inter, reachOf),
      save: ratio(posts, function (x) { return x.saves; }, reachOf),
      share: ratio(posts, function (x) { return x.shares; }, reachOf),
      pv: { sum: pvUsed.length ? pvUsed.reduce(function (a, x) { return a + x.pv; }, 0) : null, used: pvUsed.length, total: posts.length }
    };
  }
  function byKind(posts, k) { return posts.filter(function (x) { return x.kind === k; }).length; }

  // ---------- 1. 主要指標 ----------
  var KINDS = [["feed", "フィード"], ["carousel", "カルーセル"], ["reel", "リール"]];

  // 指標の定義のヒント（apps/web/src/lib/metric-definitions.ts の文言と同じ。ほかの画面と同じく点線の下線と title）
  var HINT = {
    "リーチ（日別合計）": "リーチ = 期間中に投稿やストーリーズを見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）。この表では日別の値の合計",
    "閲覧数（日別合計）": "閲覧数 = 投稿やストーリーズが表示された回数。同じ人が何度見ても数える（2025-04-21 から views に統一）。この表では日別の値の合計",
    "フォロワー純増": "フォロワー純増 = 期間中にフォローされた数 − フォローを外された数",
    "非フォロワーリーチ比率": "非フォロワーリーチ比率 = フォロワー以外へのリーチ ÷（フォロワーへのリーチ + フォロワー以外へのリーチ）",
    "投稿数": "投稿数 = 期間中に投稿した数（投稿日時の日本時間の日付）",
    "ER": "ER（エンゲージメント率） = (いいね + コメント + 保存 + シェア) ÷ リーチ",
    "保存率": "保存率 = 保存 ÷ リーチ",
    "シェア率": "シェア率 = シェア ÷ リーチ",
    "プロフィール訪問（参考）": "プロフィール訪問（参考） = フィード（カルーセルを含む）の投稿からプロフィールに来た数の合計。リールからの訪問とアカウント全体の訪問は API で取れないため含まない",
    "リーチ": "リーチ = 投稿を見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）"
  };
  function hintLabel(label) {
    var h = HINT[label];
    return h ? '<span title="' + esc(h) + '" style="cursor:help;text-decoration:underline dotted">' + label + "</span>" : label;
  }
  function usedNote(r, unit) { return r.used < r.total ? r.total + " " + unit + "中 " + r.used + " " + unit : null; }
  function valueCell(v, format, noteText, cls) {
    if (v == null) return '<td class="num ' + cls + '">' + MISSING + "</td>";
    return '<td class="num ' + cls + '">' + (format === "percent" ? pct(v) : n(v)) + (noteText ? '<div class="xs muted">' + noteText + "</div>" : "") + "</td>";
  }
  function summaryCard(pa, pb) {
    var a = side(pa), b = side(pb);
    var rows = [
      { label: "リーチ（日別合計）", a: a.reach, b: b.reach, f: "count", d: "rate" },
      { label: "閲覧数（日別合計）", a: a.views, b: b.views, f: "count", d: "rate" },
      { label: "フォロワー純増", a: a.followers, b: b.followers, f: "count", d: "count" },
      { label: "非フォロワーリーチ比率", a: a.nf.value, b: b.nf.value, f: "percent", d: "pt", an: usedNote(a.nf, "日"), bn: usedNote(b.nf, "日") },
      { label: "投稿数", a: a.posts.length, b: b.posts.length, f: "count", d: "rate" }
    ].concat(KINDS.map(function (k) {
      return { label: k[1], a: byKind(a.posts, k[0]), b: byKind(b.posts, k[0]), f: "count", d: "rate", sub: true };
    })).concat([
      { label: "ER", a: a.er.value, b: b.er.value, f: "percent", d: "pt", an: usedNote(a.er, "件"), bn: usedNote(b.er, "件") },
      { label: "保存率", a: a.save.value, b: b.save.value, f: "percent", d: "pt", an: usedNote(a.save, "件"), bn: usedNote(b.save, "件") },
      { label: "シェア率", a: a.share.value, b: b.share.value, f: "percent", d: "pt", an: usedNote(a.share, "件"), bn: usedNote(b.share, "件") },
      { label: "プロフィール訪問（参考）", a: a.pv.sum, b: b.pv.sum, f: "count", d: "rate", an: usedNote(a.pv, "件"), bn: usedNote(b.pv, "件") }
    ]);
    var table = '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">指標</th>' +
      '<th scope="col" class="num is-a">A <span class="muted">' + periodLabel(pa) + "</span></th>" +
      '<th scope="col" class="num is-b">B <span class="muted">' + periodLabel(pb) + "</span></th>" +
      '<th scope="col" class="num">差</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><th scope="row" class="row-head' + (r.sub ? " row-head--sub" : "") + '">' + hintLabel(r.label) + "</th>" +
          valueCell(r.a, r.f, r.an, "is-a") + valueCell(r.b, r.f, r.bn, "is-b") + '<td class="num">' + deltaHtml(r.d, r.a, r.b) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    var gaps = [["A", a], ["B", b]].filter(function (x) { return x[1].days < x[1].periodDays; })
      .map(function (x) { return x[0] + ": " + x[1].periodDays + " 日中 " + x[1].days + " 日分"; });
    var bBefore = pb.to < DATA_START;
    var notes = gaps.length || bBefore ? '<div class="note">' + (gaps.length ? "<p>" + gaps.join("、") + "（合計はある日の合計）</p>" : "") +
      (bBefore ? "<p>この期間の日次指標はありません（日次指標は " + DATA_START + " から）</p>" : "") + "</div>" : "";
    var foot = "<p>リーチ、閲覧数、非フォロワーリーチ比率の 1 日は、日本時間の 16 時から翌日の 16 時まで。Instagram の集計の区切りによる。</p>" +
      "<p>フォロワー純増: 日本時間の日付の記録（期間の前日の記録から終わりの日の記録までの差）。</p>" +
      "<p>投稿数、ER、保存率、シェア率、プロフィール訪問: 投稿日時の日本時間の日付で期間に入れ、各投稿の最新の値で集計。</p>";
    return card("主要指標", table + notes, foot);
  }

  // ---------- 2. 日次の重ね合わせ（v3 の lineChart を A 実線、B 破線用に手直し） ----------
  function niceMax(v) { if (!(v > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))); var f = v / p; var nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10; return nf * p; }
  function ticks(max, count) { var out = []; for (var i = 0; i <= count; i++) out.push(max * i / count); return out; }
  function fmtAxis(v) { return v >= 10000 ? (v / 10000) + "万" : n(v); }
  function lineChart(o) {
    var w = o.w, h = o.h, m = { t: 16, r: 14, b: o.labels2 ? 42 : 26, l: 44 };
    var iw = w - m.l - m.r, ih = h - m.t - m.b;
    var all = [];
    o.series.forEach(function (s) { all = all.concat(s.values.filter(function (v) { return v != null; })); });
    var max = niceMax(Math.max.apply(null, all.length ? all : [1]) * 1.08);
    var N = o.labels.length;
    var x = function (i) { return m.l + (N > 1 ? iw * i / (N - 1) : iw / 2); };
    var y = function (v) { return m.t + ih - ih * v / max; };
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + esc(o.title) + '"><g class="chart-grid">';
    ticks(max, 4).forEach(function (t) { s += '<line x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + y(t) + '" y2="' + y(t) + '"/>'; });
    s += '</g><g class="chart-axis">';
    ticks(max, 4).forEach(function (t) { s += '<text x="' + (m.l - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + fmtAxis(t) + "</text>"; });
    var step = Math.max(1, Math.ceil(N / Math.max(2, Math.floor(iw / 56))));
    // labels2 があれば X 軸のラベルを 2 段にする（1 段目 A、2 段目 B。行の頭に名前）
    // 色は style で付ける（.chart-axis text の CSS の fill は、SVG の fill 属性より強い）。A は A の線の色、B は B の線の色
    var rows = o.labels2 ? [[o.labels, h - 22, o.rowNames[0], ' style="fill:' + o.rowColors[0] + '"'], [o.labels2, h - 6, o.rowNames[1], ' style="fill:' + o.rowColors[1] + '"']] : [[o.labels, h - 6, null, ""]];
    rows.forEach(function (r) {
      // 行の名前は左端に置く（最初の日付のラベルは x = m.l を中心に描くので、m.l の近くに置くと重なる）
      if (r[2]) s += '<text x="' + (m.l - 18) + '" y="' + r[1] + '" text-anchor="end" font-weight="700"' + r[3] + ">" + r[2] + "</text>";
      r[0].forEach(function (l, i) { if (l && (i % step === 0 || (N <= 8 && i === N - 1))) s += '<text x="' + x(i) + '" y="' + r[1] + '" text-anchor="middle"' + r[3] + ">" + l + "</text>"; });
    });
    s += "</g>";
    o.series.forEach(function (se) {
      // 行のない日（null）で線を切る
      var d = "", pen = false;
      se.values.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); pen = true;
      });
      s += '<path class="' + (se.dashed ? "chart-line--dash" : "chart-line") + '" d="' + d + '" style="stroke:' + se.color + '"><title>' + esc(se.label) + "</title></path>";
      se.values.forEach(function (v, i) {
        if (v == null) return;
        // 点を出さない系列も、ヒントのために透明な点を置く
        s += '<circle class="chart-dot" cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="4" fill="' + se.color + '"' + (se.dots ? "" : ' fill-opacity="0" stroke-opacity="0"') + "><title>" + esc(se.tips[i]) + "</title></circle>";
      });
    });
    return s + "</svg>";
  }
  function overlayCard(pa, pb) {
    var da = eachDay(pa), db = eachDay(pb), len = Math.max(da.length, db.length);
    var md = function (ymd) { return ymd ? +ymd.slice(5, 7) + "/" + +ymd.slice(8, 10) : ""; };
    var labels = [], labelsB = [], va = [], vb = [];
    for (var i = 0; i < len; i++) {
      labels.push(md(da[i])); labelsB.push(md(db[i]));
      var ra = da[i] ? dailyOf(da[i]) : null, rb = db[i] ? dailyOf(db[i]) : null;
      va.push(ra ? ra.reach : null); vb.push(rb ? rb.reach : null);
    }
    var tips = function (name, days, values) { return values.map(function (v, i) { return name + " " + md(days[i]) + ": " + n(v); }); };
    var series = [
      { label: "A（" + periodLabel(pa) + "）", values: va, color: "var(--color-primary)", dots: len <= 31, tips: tips("A", da, va) },
      { label: "B（" + periodLabel(pb) + "）", values: vb, color: "var(--color-neutral)", dashed: true, tips: tips("B", db, vb) }
    ];
    var title = "リーチの日次。A " + periodLabel(pa) + " と B " + periodLabel(pb) + " を 1 日目をそろえて重ねた折れ線";
    var legend = '<div class="legend"><span><i class="line" style="background:var(--color-primary)"></i>A ' + periodLabel(pa) + '</span><span><i class="dash-neutral"></i>B ' + periodLabel(pb) + "</span></div>";
    var body = legend +
      '<div class="chart only-d">' + lineChart({ w: 1140, h: 256, labels: labels, labels2: labelsB, rowNames: ["A", "B"], rowColors: ["var(--color-primary)", "var(--color-neutral)"], series: series, title: title }) + "</div>" +
      '<div class="chart only-m">' + lineChart({ w: 340, h: 216, labels: labels, labels2: labelsB, rowNames: ["A", "B"], rowColors: ["var(--color-primary)", "var(--color-neutral)"], series: series, title: title }) + "</div>";
    return card("リーチ", body, "1 日は日本時間の 16 時から翌日の 16 時まで。");
  }

  // ---------- 3. 投稿の基準値 ----------
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function stat(values) {
    var v = values.filter(function (x) { return x != null; }).sort(function (x, y) { return x - y; });
    return { n: v.length, mean: v.length ? v.reduce(function (a, x) { return a + x; }, 0) / v.length : null, median: quantile(v, 0.5), p75: quantile(v, 0.75), p25: quantile(v, 0.25),
      min: v.length ? v[0] : null, max: v.length ? v[v.length - 1] : null };
  }
  // apps/web の baselineDisplay、baselineNote（3 件未満は範囲を出さない、10 件未満は薄く）
  function display(cnt) { return cnt <= 0 ? "none" : cnt < 3 ? "range_only" : cnt < 10 ? "faint" : "normal"; }
  var METRICS = [
    { key: "reach", label: "リーチ", f: "count", get: function (x) { return x.reach; } },
    { key: "save_rate", label: "保存率", f: "percent", get: function (x) { return x.saves / x.reach; } },
    { key: "er", label: "ER", f: "percent", get: function (x) { return (x.likes + x.comments + x.saves + x.shares) / x.reach; } }
  ];
  // 帯グラフ（投稿詳細と同じ形）: 細い線は最小〜最大、帯は 25〜75%、縦線は中央値。A は青、B は灰。目盛は指標ごとに A と B で共通
  function bandSvg(st, lo, hi, color, fmt, showRange) {
    var W = 420, H = 28, pad = 8;
    var x = function (v) { return (pad + (v - lo) / ((hi - lo) || 1) * (W - pad * 2)).toFixed(1); };
    var NL = String.fromCharCode(10);
    var tip = esc("平均: " + fmt(st.mean) + NL + "中央値: " + fmt(st.median) +
      (showRange ? NL + "上位 25%: " + fmt(st.p75) + NL + "下位 25%: " + fmt(st.p25) + NL + "最小〜最大: " + fmt(st.min) + "〜" + fmt(st.max) : ""));
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="' + H + '" preserveAspectRatio="none" role="img" aria-label="' + tip + '"><title>' + tip + "</title>";
    if (showRange) {
      svg += '<line x1="' + x(st.min) + '" x2="' + x(st.max) + '" y1="14" y2="14" stroke="' + color + '" stroke-opacity=".45" stroke-width="2"/>' +
        '<rect x="' + x(st.p25) + '" y="7" width="' + Math.max(2, x(st.p75) - x(st.p25)).toFixed(1) + '" height="14" rx="3" fill="color-mix(in oklab, ' + color + ' 28%, var(--color-surface))"/>';
    }
    return svg + '<line x1="' + x(st.median) + '" x2="' + x(st.median) + '" y1="3" y2="25" stroke="' + color + '" stroke-width="2.5"/></svg>';
  }
  function baselineCard(pa, pb) {
    var sides = [["A", pa, side(pa).posts, "var(--color-primary)"], ["B", pb, side(pb).posts, "var(--color-neutral)"]];
    var body = "";
    METRICS.forEach(function (m) {
      var fmt = function (v) { return v == null ? "—" : m.f === "percent" ? pct(v) : n(v); };
      var sts = sides.map(function (s) { return stat(s[2].map(m.get)); });
      var lo = Math.min.apply(null, sts.filter(function (t) { return t.n; }).map(function (t) { return t.min; }).concat([Infinity]));
      var hi = Math.max.apply(null, sts.filter(function (t) { return t.n; }).map(function (t) { return t.max; }).concat([-Infinity]));
      sides.forEach(function (s, i) {
        var st = sts[i], dsp = display(st.n), q = dsp === "faint" || dsp === "normal";
        body += '<tr class="' + (i === 0 ? "is-a" : "is-b") + '">' +
          (i === 0 ? '<th scope="rowgroup" rowspan="2" class="row-head">' + hintLabel(m.label) + "</th>" : "") +
          '<td class="nowrap">' + s[0] + ' <span class="muted xs">' + periodLabel(s[1]) + "</span></td>";
        if (st.n === 0) body += '<td class="band-cell muted">' + MISSING + '</td><td class="num">' + MISSING + '</td><td class="num xs muted">n = 0</td>';
        else body += '<td class="band-cell">' + bandSvg(st, lo, hi, s[3], fmt, q) + '</td><td class="num">' + fmt(st.median) + "</td>" +
          '<td class="num xs muted">n = ' + st.n + "</td>";
        body += "</tr>";
      });
    });
    var legend = '<div class="legend"><span><i class="band-key band-key--line"></i>最小〜最大</span><span><i class="band-key band-key--box"></i>25〜75% の範囲</span><span><i class="band-key band-key--med"></i>中央値</span></div>';
    var table = legend + '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">指標</th><th scope="col">期間</th>' +
      '<th scope="col">分布</th><th scope="col" class="num">中央値</th><th scope="col" class="num">n</th></tr></thead><tbody>' +
      body + "</tbody></table></div>";
    return card("投稿の基準値", table);
  }

  // ---------- 期間の帯（見出しの下。もとの入力欄の位置） ----------
  function jpDate(ymd, withYear) { var p = ymd.split("-"); return (withYear ? +p[0] + "年" : "") + +p[1] + "月" + +p[2] + "日"; }
  function jpRange(p) { return jpDate(p.from, true) + " 〜 " + jpDate(p.to, p.to.slice(0, 4) !== p.from.slice(0, 4)); }
  function periodStrip(pa, pb) {
    function block(tag, label, p, cls) {
      return '<div class="period-block ' + cls + '"><div class="period-block__label"><b>' + tag + "</b> " + label + '</div><div class="period-block__range ' + (tag === "A" ? "is-a" : "is-b") + '">' + jpRange(p) +
        '</div><div class="period-block__days">' + eachDay(p).length + " 日間</div></div>";
    }
    return '<section class="card period-strip">' + block("A", "最新の期間", pa, "period-block--a") + block("B", "比べる期間", pb, "period-block--b") + "</section>";
  }

  // ---------- 画面 ----------
  function page(preset) {
    var sel = resolve(preset);
    var tools = '<nav class="seg" aria-label="比べる期間">' + PRESETS.map(function (p) {
      return '<a href="#' + p[0] + '"' + (p[0] === preset ? ' aria-current="page"' : "") + ">" + p[1] + "</a>";
    }).join("") + '</nav><a class="btn btn--ghost" href="#' + preset + '" title="見本では何もしない（実装では期間 A の日次の CSV）">CSV</a>';
    var head = '<div class="page-head"><div><h1>期間比較</h1><div class="sub">最終更新 ' + esc(D.updatedAt.replace("T", " ")) + '</div></div><div class="tools">' + tools + "</div></div>";
    var shell = '<header class="topbar"><div class="topbar__in"><div class="brand"><span class="brand__mark"></span>' + esc(D.account.name) + "<small>" + esc(D.account.handle) + '</small></div><nav class="nav"><a href="#' + preset + '" aria-current="page">期間比較</a></nav></div></header>';
    return shell + '<main class="main stack">' + head + periodStrip(sel.a, sel.b) + '<div class="grid">' + summaryCard(sel.a, sel.b) + overlayCard(sel.a, sel.b) + baselineCard(sel.a, sel.b) + "</div></main>";
  }

  function render() { document.getElementById("app").innerHTML = page(presetNow()); }
  if (typeof document !== "undefined" && document.getElementById) {
    window.addEventListener("hashchange", render);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render); else render();
  }
  // DOM なしで確かめるための出口
  if (typeof module !== "undefined") module.exports = { page: page, resolve: resolve, side: side };
})();

/**
 * 動画の画面の文字（R4.1 設計 8 章「画面」）の単体テスト。
 * タイムラインの文字の区間（`lib/video-timeline.ts`、`CutTimeline`）、リール分析の文字の要因と目的変数のスキップ率、
 * 並べ替えのキー、検索パラメータ `q`（`lib/reels.ts`）。行は架空の値をテストの中で作る（DB は使わない）
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CutTimeline } from "@/components/charts/CutTimeline";
import { sortHeaderHref } from "@/components/SortHeader";
import { buildHref } from "@/components/href";
import { pagerItems } from "@/components/Pager";
import {
  buildReelsView,
  FACTORS,
  factorCorrelations,
  factorValue,
  FIRST_3S_TEXT,
  formatFactor,
  formatHasText,
  groupCards,
  groupFirst3sTextShare,
  objectiveOptionLabel,
  OBJECTIVE_LABEL,
  OBJECTIVES,
  parseReelsParams,
  REEL_SORT_KEYS,
  reelsQuery,
  responseMetricsFor,
  sortReels,
  textAnalyzed,
  textBucket,
  type ReelRow,
} from "@/lib/reels";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import {
  clipTextSpans,
  labelCapacity,
  textLabelsFit,
  textPosition,
  timelineModel,
  truncateLabel,
  videoTextMissing,
  type TextSpan,
} from "@/lib/video-timeline";

/** 架空のリール。既定はカットも文字も今の条件で解析済み（`test/reels.test.ts` と同じ形） */
function reel(i: number, over: Partial<ReelRow> = {}): ReelRow {
  return {
    media_id: `00009${String(i).padStart(4, "0")}`,
    posted_at: new Date(Date.UTC(2026, 8, 1, 3, 0) + i * 86400000),
    caption: `架空のリール ${i}`,
    thumbnail_path: null,
    gone_at: null,
    elapsed_hours: 24 * (40 - i),
    caption_chars: 10 + i,
    hours_since_previous_post: 24 * (i + 1),
    analysis_status: "success",
    duration_ms: 5000 + i * 3000,
    cut_count: i,
    avg_scene_ms: 2000 + i * 100,
    first_cut_ms: i === 0 ? null : 500 + i * 10,
    cuts_in_first_3s: i % 3,
    cuts_in_last_3s: (i + 1) % 2,
    reach: 100 + i * 10,
    views: 200 + i * 20,
    avg_watch_time_ms: 3000,
    retention_rate: 0.5 + i * 0.1,
    skip_rate: 0.1 + i * 0.05,
    share_rate: 0.01,
    save_rate: 0.02,
    reach_rate: null,
    text_status: "success",
    text_segmenter_current: true,
    first_text_ms: i === 0 ? null : 1000 + i * 100,
    has_text_in_first_3s: i !== 0 && i % 2 === 0,
    text_coverage_ratio: (i % 10) / 10,
    total_text_chars: i * 12,
    ...over,
  };
}

function span(start: number, end: number, over: Partial<TextSpan> = {}): TextSpan {
  return { start, end, text: `文字${start}`, position: "top", captionLike: false, ...over };
}

function expectClean(html: string) {
  expect(html).not.toMatch(/NaN|Infinity|undefined/);
}

/* ------------------------------------------------------------------
 * タイムライン
 * ------------------------------------------------------------------ */

describe("タイムラインの文字の区間", () => {
  it("クリップ: start >= duration と start >= end は捨て、end > duration は duration に丸める。並びは入力のまま", () => {
    const spans = [span(0, 2000), span(8000, 9000), span(5000, 5000), span(6000, 12000), span(3000, 1000), span(-1, 500)];
    const out = clipTextSpans(spans, 8000);
    expect(out.map((t) => [t.start, t.end])).toEqual([
      [0, 2000],
      [6000, 8000],
    ]);
    // 表の行はそのまま（クリップはタイムラインだけ）: 入力は変えない
    expect(spans[3]?.end).toBe(12000);
  });

  it("timelineModel: texts が null なら段を描かない（R4 のまま）、空なら 3 段を空で描く", () => {
    const none = timelineModel([], 8000);
    expect(none?.texts).toBeNull();
    const empty = timelineModel([], 8000, []);
    expect(empty?.texts).toEqual([]);
    const some = timelineModel([2000], 8000, [span(1000, 9000)]);
    expect(some?.texts).toEqual([span(1000, 8000)]);
    expect(timelineModel([], 0, [span(0, 1)])).toBeNull();
  });

  it("textLabelsFit: 同じ段で [start, end) が重なる後の区間は文字を出さない。別の段は出す", () => {
    const spans = [
      span(0, 3000),
      span(2000, 4000), // 上で先の区間と重なる → 出さない
      span(3000, 5000), // 上で [0,3000) と端が接するだけ → 出す
      span(2000, 4000, { position: "bottom" }), // 下は別の段 → 出す
      span(4500, 6000), // 上で [3000,5000) と重なる → 出さない
      span(2500, 2600, { position: "middle" }),
    ];
    expect(textLabelsFit(spans)).toEqual([true, false, true, true, false, true]);
    expect(textLabelsFit([])).toEqual([]);
  });

  it("truncateLabel: コードポイントで数え、サロゲートペアを割らない。幅に入る文字数は全角換算 11 px", () => {
    expect(truncateLabel("あいうえお", 5)).toBe("あいうえお");
    expect(truncateLabel("あいうえお", 4)).toBe("あいう…");
    expect(truncateLabel("🍣🍣🍣🍣", 3)).toBe("🍣🍣…");
    expect(truncateLabel("🍣🍣🍣🍣", 4)).toBe("🍣🍣🍣🍣");
    expect(truncateLabel("あい", 1)).toBe("");
    expect(truncateLabel("あい", 0)).toBe("");
    expect(truncateLabel("あ", 1)).toBe("あ");
    expect(labelCapacity(110)).toBe(10);
    expect(labelCapacity(5)).toBe(0);
    expect(labelCapacity(-20)).toBe(0);
  });

  it("textPosition: 3 値以外は middle", () => {
    expect(textPosition("top")).toBe("top");
    expect(textPosition("bottom")).toBe("bottom");
    expect(textPosition("left")).toBe("middle");
  });
});

describe("CutTimeline の描画（文字の段）", () => {
  const render = (texts: TextSpan[] | null, over: { width?: number; labels?: boolean } = {}) => {
    const m = timelineModel([3000], 10000, texts);
    if (m === null) throw new Error("model");
    return renderToStaticMarkup(createElement(CutTimeline, { model: m, ...over }));
  };

  it("texts が null なら段がなく、aria-label も R4 のまま、高さ 52", () => {
    const html = render(null);
    expectClean(html);
    expect(html).not.toContain('data-part="lane"');
    expect(html).toContain('aria-label="カットのタイムライン: 長さ 10.0 秒、画面変化 1 回、シーン 2 本"');
    expect(html).toContain('height="52"');
  });

  it("0 本: 3 段を空で描き、aria-label に「文字の区間 0 本」、高さ約 100", () => {
    const html = render([]);
    expectClean(html);
    expect(html.match(/data-part="lane"/g)).toHaveLength(3);
    expect(html).not.toContain('data-part="text"');
    expect(html).toContain("文字の区間 0 本");
    expect(html).toContain('height="100"');
  });

  it("区間の rect、title と aria-label に全文、テロップらしい区間は濃い塗りと stroke", () => {
    const html = render([
      span(0, 5000, { text: "とても長い看板の文字がここに入ります", position: "bottom" }),
      span(1000, 4000, { text: "テロップ", position: "top", captionLike: true }),
    ]);
    expectClean(html);
    expect(html.match(/data-part="text"/g)).toHaveLength(2);
    expect(html).toContain("文字の区間 2 本");
    expect(html).toContain('data-caption="true"');
    expect(html).toContain('stroke="var(--color-text)"');
    expect(html).toContain('opacity=".45"');
    expect(html).toContain('opacity=".25"');
    expect(html).toContain("文字 2: 1.0 秒〜4.0 秒、位置 上、テロップらしい: テロップ");
    expect(html).toContain("位置 下: とても長い看板の文字がここに入ります");
    expect(html.match(/data-part="text-label"/g)).toHaveLength(2);
  });

  it("同じ段で重なる後の区間は帯の文字を出さない（全文は title に残る）", () => {
    const html = render([span(0, 5000, { text: "さき" }), span(2000, 7000, { text: "あと" })]);
    expect(html.match(/data-part="text-label"/g)).toHaveLength(1);
    expect(html).toContain(">さき</text>");
    expect(html).not.toContain(">あと</text>");
    expect(html).toContain("文字 2: 2.0 秒〜7.0 秒、位置 上: あと");
  });

  it("幅に入らない文字は切って「…」。幅が狭ければ出さない。labels が偽なら文字を出さない", () => {
    // 幅 340 → 内側 324 px、区間 1 秒 = 32.4 px → (32.4 − 6) / 11 = 2 文字
    const narrow = render([span(0, 1000, { text: "あいうえお" })], { width: 340 });
    expect(narrow).toContain(">あ…</text>");
    const tiny = render([span(0, 100, { text: "あいうえお" })], { width: 340 });
    expect(tiny).not.toContain('data-part="text-label"');
    expect(tiny).toContain("あいうえお"); // title には全文
    const noLabels = render([span(0, 9000, { text: "あいうえお" })], { labels: false });
    expect(noLabels).not.toContain('data-part="text-label"');
    expect(noLabels).toContain("あいうえお");
  });

  it("読み取った文字は自動エスケープされる（タグが素通りしない）", () => {
    const html = render([span(0, 9000, { text: "<script>alert(1)</script>" })]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("文字の解析の状態から「—」の理由", () => {
  it("null と success で版が古い → not_yet、no_video_url と failed → missing、success で今の版 → null", () => {
    expect(videoTextMissing(null, null)).toEqual({ reason: "not_yet", text: null });
    expect(videoTextMissing("success", false)).toEqual({ reason: "not_yet", text: null });
    expect(videoTextMissing("success", null)).toEqual({ reason: "not_yet", text: null });
    expect(videoTextMissing("no_video_url", true)).toEqual({ reason: "missing", text: "取得できなかった" });
    expect(videoTextMissing("failed", false)).toEqual({ reason: "missing", text: "取得できなかった" });
    expect(videoTextMissing("success", true)).toBeNull();
  });
});

/* ------------------------------------------------------------------
 * リール分析
 * ------------------------------------------------------------------ */

describe("文字の要因", () => {
  it("FACTORS に 3 つ（全部で 12、散布図は 11 枚）。「冒頭 3 秒の文字」は要因に入らない", () => {
    expect(FACTORS.map((f) => f.key)).toContain("first_text");
    expect(FACTORS.map((f) => f.key)).toContain("text_coverage");
    expect(FACTORS.map((f) => f.key)).toContain("total_text_chars");
    // 11 の要因に「前回投稿からの日数」を足して 12。散布図に出さないのは経過日数だけ
    expect(FACTORS).toHaveLength(12);
    expect(FACTORS.filter((f) => f.scatter)).toHaveLength(11);
    expect((FACTORS as readonly { key: string }[]).some((f) => f.key === FIRST_3S_TEXT.key)).toBe(false);
    expect(FIRST_3S_TEXT.label).toBe("冒頭 3 秒の文字");
  });

  it("値はビューの列をそのまま。first_text は秒、text_coverage は 0〜1、total_text_chars は数", () => {
    const r = reel(3, { first_text_ms: 1234, text_coverage_ratio: 0.1234, total_text_chars: 240 });
    expect(factorValue(r, "first_text")).toBeCloseTo(1.234, 10);
    expect(factorValue(r, "text_coverage")).toBe(0.1234);
    expect(factorValue(r, "total_text_chars")).toBe(240);
    // 文字の解析がまだ（ビューが null にする）→ すべて null
    const pending = reel(3, { text_status: null, text_segmenter_current: null, first_text_ms: null, text_coverage_ratio: null, total_text_chars: null });
    expect(factorValue(pending, "first_text")).toBeNull();
    expect(factorValue(pending, "text_coverage")).toBeNull();
    expect(factorValue(pending, "total_text_chars")).toBeNull();
    expect(textAnalyzed(r)).toBe(true);
    expect(textAnalyzed(pending)).toBe(false);
    expect(textAnalyzed(reel(1, { text_segmenter_current: false }))).toBe(false);
  });

  it("書式: percent は小数なしの %、冒頭 3 秒の文字は あり／なし／—", () => {
    expect(formatFactor(0.1234, "percent")).toBe("12%");
    expect(formatFactor(0, "percent")).toBe("0%");
    expect(formatFactor(null, "percent")).toBe("—");
    expect(formatFactor(1.5, "seconds")).toBe("1.5 秒");
    expect(formatHasText(true)).toBe("あり");
    expect(formatHasText(false)).toBe("なし");
    expect(formatHasText(null)).toBe("—");
  });

  it("要因ごとの n: 文字がない動画は first_text から除く。文字の解析がまだの動画は 3 つとも除く", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => reel(i)),
      reel(6, { text_status: null, text_segmenter_current: null, first_text_ms: null, text_coverage_ratio: null, total_text_chars: null }),
    ];
    const cs = factorCorrelations(rows, "views");
    expect(cs.find((c) => c.key === "duration")?.n).toBe(7);
    expect(cs.find((c) => c.key === "first_text")?.n).toBe(5);
    expect(cs.find((c) => c.key === "text_coverage")?.n).toBe(6);
    expect(cs.find((c) => c.key === "total_text_chars")?.n).toBe(6);
  });

  it("上位と下位の「冒頭 3 秒の文字がある割合」は文字の解析が済んだ行だけで数える", () => {
    const g = [
      reel(1, { has_text_in_first_3s: true }),
      reel(2, { has_text_in_first_3s: false }),
      reel(3, { has_text_in_first_3s: true }),
      reel(4, { has_text_in_first_3s: null, text_status: null, text_segmenter_current: null }),
    ];
    expect(groupFirst3sTextShare(g)).toBeCloseTo(2 / 3, 10);
    expect(groupFirst3sTextShare([reel(4, { has_text_in_first_3s: null })])).toBeNull();
    expect(groupFirst3sTextShare([])).toBeNull();
  });

  it("区分「冒頭 3 秒の文字」: なし／あり の 2 本。解析がまだの行は入らない", () => {
    expect(textBucket(true)).toBe("has");
    expect(textBucket(false)).toBe("none");
    expect(textBucket(null)).toBeNull();
    const rows = [
      reel(1, { has_text_in_first_3s: false, views: 10 }),
      reel(2, { has_text_in_first_3s: true, views: 30 }),
      reel(3, { has_text_in_first_3s: true, views: 50 }),
      reel(4, { has_text_in_first_3s: null, text_status: null, text_segmenter_current: null, views: 999 }),
      reel(5, { analysis_status: null, has_text_in_first_3s: true, views: 999 }),
    ];
    const g = groupCards(rows, "views");
    expect(g.text3s.map((b) => b.label)).toEqual(["なし", "あり"]);
    expect(g.text3s.map((b) => b.n)).toEqual([1, 2]);
    expect(g.text3s.map((b) => b.value)).toEqual([10, 40]);
    // カットの区分は文字の有無に関係なく解析済みの 4 件
    expect(g.length.reduce((a, b) => a + b.n, 0)).toBe(4);
  });
});

describe("目的変数のスキップ率", () => {
  it("選択肢に skip_rate。文言は指標の定義と同じで件数つき。不正値は既定", () => {
    expect(OBJECTIVES).toContain("skip_rate");
    expect(OBJECTIVE_LABEL.skip_rate).toBe(METRIC_DEFINITIONS.skip_rate.label);
    expect(objectiveOptionLabel("skip_rate", 7)).toBe("スキップ率（7 件）");
    expect(parseReelsParams({ y: "skip_rate" }).y).toBe("skip_rate");
    expect(parseReelsParams({ y: "retention_rate" }).y).toBe("reach_rate");
  });

  it("「視聴と反応」は y と同じ指標の 1 枚を出さない（スキップ率を選ぶと 3 枚、ほかは 4 枚）", () => {
    expect(responseMetricsFor("skip_rate")).toEqual(["retention_rate", "share_rate", "save_rate"]);
    expect(responseMetricsFor("reach_rate")).toEqual(["retention_rate", "skip_rate", "share_rate", "save_rate"]);
    const rows = Array.from({ length: 5 }, (_, i) => reel(i));
    expect(buildReelsView(rows, "skip_rate").responseScatter.map((s) => s.key)).toEqual(["retention_rate", "share_rate", "save_rate"]);
    expect(buildReelsView(rows, "views").responseScatter).toHaveLength(4);
    const v = buildReelsView(rows, "skip_rate");
    expect(v.objectiveCounts.skip_rate).toBe(5);
    expect(v.analyzedN).toBe(5);
    // 上位は値の大小のまま（スキップ率が高い順）
    expect(v.topBottom?.top[0]?.media_id).toBe(reel(4).media_id);
    expect(v.topBottom?.bottom[0]?.media_id).toBe(reel(0).media_id);
  });
});

describe("並べ替えのキーと検索パラメータ q", () => {
  it("キーに has_text_in_first_3s（0／1）、text_coverage、total_text_chars。値のないものは最後", () => {
    expect(REEL_SORT_KEYS).toContain("has_text_in_first_3s");
    expect(REEL_SORT_KEYS).toContain("text_coverage");
    expect(REEL_SORT_KEYS).toContain("total_text_chars");
    const rows = [
      reel(1, { has_text_in_first_3s: false, text_coverage_ratio: 0.5, total_text_chars: 10 }),
      reel(2, { has_text_in_first_3s: true, text_coverage_ratio: 0.2, total_text_chars: 30 }),
      reel(3, { has_text_in_first_3s: null, text_coverage_ratio: null, total_text_chars: null }),
    ];
    const ids = (rs: readonly ReelRow[]) => rs.map((r) => r.media_id);
    expect(ids(sortReels(rows, "has_text_in_first_3s", "desc"))).toEqual([reel(2).media_id, reel(1).media_id, reel(3).media_id]);
    expect(ids(sortReels(rows, "has_text_in_first_3s", "asc"))).toEqual([reel(1).media_id, reel(2).media_id, reel(3).media_id]);
    expect(ids(sortReels(rows, "text_coverage", "desc"))).toEqual([reel(1).media_id, reel(2).media_id, reel(3).media_id]);
    expect(ids(sortReels(rows, "total_text_chars", "asc"))).toEqual([reel(1).media_id, reel(2).media_id, reel(3).media_id]);
    expect(parseReelsParams({ sort: "text_coverage" }).sort).toBe("text_coverage");
  });

  it("q は正規化して保つ。空白だけ・長すぎ・配列は null（既定の画面）", () => {
    expect(parseReelsParams({ q: "ＡＢＣ 徒歩" }).q).toBe("abc徒歩");
    expect(parseReelsParams({ q: "   " }).q).toBeNull();
    expect(parseReelsParams({ q: "a".repeat(101) }).q).toBeNull();
    expect(parseReelsParams({ q: ["a", "b"] }).q).toBeNull();
    expect(parseReelsParams({ q: "１００％" }).q).toBe("100%");
  });

  it("並べ替え、ページ送り、指標の選択のリンクが q を保つ。q がなければ出さない", () => {
    const params = parseReelsParams({ y: "views", sort: "duration", dir: "asc", q: "徒歩" });
    const query = reelsQuery(params);
    expect(query.q).toBe("徒歩");
    expect(reelsQuery({ ...params, q: null }).q).toBeUndefined();
    const href = sortHeaderHref({ sortKey: "reach", sort: params.sort, order: params.dir, path: "/reels", query, orderParam: "dir" });
    expect(href).toBe("/reels?dir=desc&q=%E5%BE%92%E6%AD%A9&sort=reach&y=views");
    expect(buildHref("/reels", reelsQuery({ ...params, y: "reach_rate" }))).toBe("/reels?dir=asc&q=%E5%BE%92%E6%AD%A9&sort=duration");
    expect(buildHref("/reels", query, { page: 2 })).toContain("q=%E5%BE%92%E6%AD%A9");
    expect(pagerItems(1, 1)).toEqual([1]);
  });
});

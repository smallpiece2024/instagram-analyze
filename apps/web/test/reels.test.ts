/**
 * リール分析の計算（`lib/reels.ts`）、投稿詳細のカットのタイムライン（`lib/video-timeline.ts`）、
 * 部品（`Scatter`、`Forest`、`CutTimeline`）、ナビゲーション、並べ替えのリンクの単体テスト（R4 設計 7 章「画面」）。
 * 行は架空の値をテストの中で作る（DB は使わない）
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CutTimeline } from "@/components/charts/CutTimeline";
import { Forest, type ForestRow } from "@/components/charts/Forest";
import { Scatter, scatterDomain, type ScatterPoint } from "@/components/charts/Scatter";
import { activeNavHref, NAV_ITEMS } from "@/components/NavLinks";
import { sortHeaderHref } from "@/components/SortHeader";
import { JOB_ORDER, PAGE_SIZE } from "@/lib/format";
import {
  analyzedWithObjective,
  bootstrapIndexSets,
  buildReelsView,
  correlationWithInterval,
  dayType,
  edgeCutBucket,
  factorCorrelations,
  groupCards,
  groupFactorSummary,
  lengthBucket,
  objectiveOptionLabel,
  paginateReels,
  parkMiller,
  parseReelsParams,
  ranks,
  reelsQuery,
  sortReels,
  weekdayOf,
  WEEKDAY_BUCKETS,
  spearman,
  timeBand,
  topBottom,
  withObjective,
  type ReelRow,
} from "@/lib/reels";
import {
  markersFit,
  retentionMissing,
  timelineModel,
  timelineTickStepMs,
  timelineTicks,
  videoAnalysisMissing,
} from "@/lib/video-timeline";

/** 架空のリール。既定は解析済みで、目的変数（閲覧数）がある */
function reel(i: number, over: Partial<ReelRow> = {}): ReelRow {
  return {
    media_id: `00009${String(i).padStart(4, "0")}`,
    posted_at: new Date(Date.UTC(2026, 8, 1, 3, 0) + i * 86400000),
    caption: `架空のリール ${i}`,
    thumbnail_path: null,
    gone_at: null,
    elapsed_hours: 24 * (40 - i),
    caption_chars: 10 + i,
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
    skip_rate: 0.3,
    share_rate: 0.01,
    save_rate: 0.02,
    reach_rate: null,
    ...over,
  };
}

/** SVG に NaN、Infinity、undefined が出ていないこと */
function expectClean(html: string) {
  expect(html).not.toMatch(/NaN|Infinity|undefined/);
}

describe("順位相関", () => {
  it("既知の値: 単調増加は 1、単調減少は -1", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    // 順位の差 d = (0, 0, 1, -1, 0) → 1 - 6Σd² / (n(n² - 1)) = 1 - 12 / 120 = 0.9
    expect(spearman([1, 2, 3, 4, 5], [1, 2, 4, 3, 5])).toBeCloseTo(0.9, 10);
  });

  it("同順位は平均の順位", () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(ranks([5, 5, 5])).toEqual([2, 2, 2]);
    // x = (1, 2, 2, 3) と y = (1, 2, 3, 4): 平均の順位のピアソン相関
    const r = spearman([1, 2, 2, 3], [1, 2, 3, 4]) as number;
    expect(r).toBeCloseTo(4.5 / Math.sqrt(4.5 * 5), 10);
  });

  it("n = 3 未満と分散 0 で null（0 と表示しない）", () => {
    expect(spearman([1, 2], [1, 2])).toBeNull();
    expect(spearman([], [])).toBeNull();
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2, 3], [7, 7, 7])).toBeNull();
    expect(spearman([1, 2, 3], [3, 1, 2])).not.toBeNull();
  });
});

describe("ブートストラップ", () => {
  it("Park-Miller は同じ種で同じ列（見本と同じ式）", () => {
    const a = parkMiller(7);
    const b = parkMiller(7);
    const first = a();
    expect(first).toBe(b());
    // seed = 7 × 16807 = 117649 → (117649 - 1) / 2147483646
    expect(first).toBeCloseTo(117648 / 2147483646, 15);
  });

  it("index の組は n と種だけで決まり、範囲に収まる", () => {
    const s1 = bootstrapIndexSets(5, 50);
    const s2 = bootstrapIndexSets(5, 50);
    expect(s1).toEqual(s2);
    expect(s1).toHaveLength(50);
    expect(s1.every((set) => set.length === 5 && set.every((i) => i >= 0 && i < 5))).toBe(true);
    expect(bootstrapIndexSets(0)).toEqual([]);
  });

  it("分散 0 になった回は捨てる（幅は残った回から。全部捨てれば幅なし）", () => {
    // 2 通りの値しかない x では、同じ行ばかり引いた回は分散 0 になる
    const xs = [0, 0, 1, 1];
    const ys = [1, 2, 3, 4];
    const sets = [
      [0, 0, 0, 0], // x の分散 0 → 捨てる
      [0, 1, 2, 3],
      [0, 2, 1, 3],
    ];
    const c = correlationWithInterval("cut_count", xs, ys, sets);
    expect(c.r).not.toBeNull();
    expect(c.lo).not.toBeNull();
    expect(c.lo).toBeCloseTo(c.r as number, 10);
    const none = correlationWithInterval("cut_count", xs, ys, [[0, 0, 0, 0]]);
    expect(none.r).not.toBeNull();
    expect(none.lo).toBeNull();
    expect(none.hi).toBeNull();
  });

  it("入力の順を変えても、要因を足しても、他の要因の幅が同じ", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      reel(i, { views: 200 + ((i * 7) % 12) * 15, duration_ms: 4000 + ((i * 5) % 12) * 2500 }),
    );
    const base = factorCorrelations(rows, "views");
    const reversed = factorCorrelations(rows.slice().reverse(), "views");
    expect(reversed).toEqual(base);
    // 1 つの要因だけを計算しても（要因の数を変えても）同じ index の組を使うので、幅は同じ
    const sorted = rows.slice().sort((a, b) => (a.media_id < b.media_id ? -1 : 1));
    const sets = bootstrapIndexSets(sorted.length);
    const only = correlationWithInterval(
      "duration",
      sorted.map((r) => (r.duration_ms as number) / 1000),
      sorted.map((r) => r.views as number),
      sets,
    );
    const d = base.find((c) => c.key === "duration");
    expect(only).toEqual(d);
    expect(d?.lo).not.toBeNull();
    expect((d?.lo as number) <= (d?.r as number) && (d?.r as number) <= (d?.hi as number)).toBe(true);
  });

  it("要因ごとの n: 最初の画面変化まで は画面変化 0 回（null）を除く", () => {
    const rows = Array.from({ length: 6 }, (_, i) => reel(i));
    const cs = factorCorrelations(rows, "views");
    expect(cs.find((c) => c.key === "duration")?.n).toBe(6);
    expect(cs.find((c) => c.key === "first_cut")?.n).toBe(5);
    expect(cs.map((c) => c.key)).toEqual([
      "duration",
      "cut_count",
      "avg_scene",
      "cuts_in_first_3s",
      "cuts_in_last_3s",
      "first_cut",
      "caption_chars",
      "elapsed_days",
    ]);
  });
});

describe("カードごとの母集団", () => {
  const rows = [
    reel(1),
    reel(2, { analysis_status: null }),
    reel(3, { analysis_status: "failed", duration_ms: null }),
    reel(4, { views: null }),
    reel(5),
  ];

  it("解析済みかつ目的変数あり／目的変数ありだけ", () => {
    expect(analyzedWithObjective(rows, "views").map((r) => r.media_id)).toEqual([reel(1).media_id, reel(5).media_id]);
    expect(withObjective(rows, "views")).toHaveLength(4);
    expect(withObjective(rows, "reach_rate")).toHaveLength(0);
  });

  it("buildReelsView: 件数、選択肢の件数、区分の母集団", () => {
    const v = buildReelsView(rows, "views");
    expect(v.total).toBe(5);
    expect(v.analyzedCount).toBe(3);
    expect(v.analyzedN).toBe(2);
    expect(v.objectiveN).toBe(4);
    expect(v.objectiveCounts).toEqual({ reach_rate: 0, reach: 5, views: 4 });
    // 長さの区分は解析済みの 2 件、曜日は目的変数のある 4 件
    expect(v.groups.length.reduce((a, b) => a + b.n, 0)).toBe(2);
    expect(v.groups.day.reduce((a, b) => a + b.n, 0)).toBe(4);
    expect(v.responseScatter.find((s) => s.key === "retention_rate")?.points).toHaveLength(4);
    expect(v.factorScatter).toHaveLength(7);
    expect(v.topBottom).toBeNull();
    // n = 2 なので相関はすべて「—」
    expect(v.correlations.every((c) => c.r === null && c.lo === null)).toBe(true);
  });

  it("選択肢の文言に件数", () => {
    expect(objectiveOptionLabel("reach_rate", 2)).toBe("リーチ率（2 件）");
    expect(objectiveOptionLabel("views", 20)).toBe("閲覧数（20 件）");
  });
});

describe("上位と下位", () => {
  const ids = (rs: readonly ReelRow[]) => rs.map((r) => r.media_id);

  it("n = 1〜3 は表を出さない（null）", () => {
    for (const n of [0, 1, 2, 3]) {
      expect(topBottom(Array.from({ length: n }, (_, i) => reel(i)), "views")).toBeNull();
    }
  });

  it("n = 4、5 は q = 1。位置で切る", () => {
    const four = topBottom([reel(1), reel(2), reel(3), reel(4)], "views");
    expect(four?.q).toBe(1);
    expect(ids(four?.top ?? [])).toEqual([reel(4).media_id]);
    expect(ids(four?.bottom ?? [])).toEqual([reel(1).media_id]);
    const five = topBottom([reel(1), reel(2), reel(3), reel(4), reel(5)], "views");
    expect(five?.q).toBe(1);
    expect(five?.n).toBe(5);
  });

  it("境目に同じ値: media_id の順で決める", () => {
    const rows = [reel(4, { views: 100 }), reel(3, { views: 100 }), reel(2, { views: 100 }), reel(1, { views: 100 })];
    const tb = topBottom(rows, "views");
    expect(ids(tb?.top ?? [])).toEqual([reel(1).media_id]);
    expect(ids(tb?.bottom ?? [])).toEqual([reel(4).media_id]);
  });

  it("要因の中央値と、冒頭 3 秒は 1 回以上の割合", () => {
    const g = [reel(1, { cuts_in_first_3s: 0 }), reel(2, { cuts_in_first_3s: 2 }), reel(3, { cuts_in_first_3s: 1 })];
    expect(groupFactorSummary(g, "cuts_in_first_3s")).toBeCloseTo(2 / 3, 10);
    expect(groupFactorSummary(g, "duration")).toBe(11);
    // 最後 3 秒も 1 回以上の割合（0、1、1 → 2/3）
    const h = [reel(1, { cuts_in_last_3s: 0 }), reel(2, { cuts_in_last_3s: 1 }), reel(3, { cuts_in_last_3s: 3 })];
    expect(groupFactorSummary(h, "cuts_in_last_3s")).toBeCloseTo(2 / 3, 10);
    expect(groupFactorSummary([], "duration")).toBeNull();
  });
});

describe("区分の境界", () => {
  it("長さ: 10 秒ごとで、ちょうどは上のグループ（下端を含む）。60 秒以上は 1 つ", () => {
    expect(lengthBucket(0)).toBe("lt10");
    expect(lengthBucket(9999)).toBe("lt10");
    expect(lengthBucket(10000)).toBe("lt20");
    expect(lengthBucket(29999)).toBe("lt30");
    expect(lengthBucket(30000)).toBe("lt40");
    expect(lengthBucket(59999)).toBe("lt60");
    expect(lengthBucket(60000)).toBe("ge60");
    expect(lengthBucket(180000)).toBe("ge60");
    expect(lengthBucket(null)).toBeNull();
  });

  it("冒頭と最後 3 秒: 0 回、1 回、2 回、3 回以上", () => {
    expect([0, 1, 2, 3, 7].map(edgeCutBucket)).toEqual(["c0", "c1", "c2", "c3", "c3"]);
    expect(edgeCutBucket(null)).toBeNull();
  });

  it("各曜日は日本時間。日曜 23:59 JST は日、月曜 00:00 JST は月", () => {
    expect(weekdayOf(new Date("2026-10-04T14:59:00Z"))).toBe("sun");
    expect(weekdayOf(new Date("2026-10-04T15:00:00Z"))).toBe("mon");
    expect(WEEKDAY_BUCKETS.map((b) => b.label)).toEqual(["月", "火", "水", "木", "金", "土", "日"]);
  });

  it("曜日と時間帯は日本時間。UTC 15:00 をまたぐ投稿", () => {
    // 2026-10-02（金）14:59 UTC = 23:59 JST 金 → 平日、夜
    const fri = new Date("2026-10-02T14:59:00Z");
    expect(dayType(fri)).toBe("weekday");
    expect(timeBand(fri)).toBe("night");
    // 2026-10-02（金）15:00 UTC = 10-03 00:00 JST 土 → 土日、朝
    const sat = new Date("2026-10-02T15:00:00Z");
    expect(dayType(sat)).toBe("weekend");
    expect(timeBand(sat)).toBe("morning");
    // 11 時ちょうどは昼、17 時ちょうどは夜（JST）
    expect(timeBand(new Date("2026-10-05T02:00:00Z"))).toBe("daytime");
    expect(timeBand(new Date("2026-10-05T01:59:00Z"))).toBe("morning");
    expect(timeBand(new Date("2026-10-05T08:00:00Z"))).toBe("night");
    // 日曜 23:59 JST（日曜 14:59 UTC）は土日、月曜 00:00 JST（日曜 15:00 UTC）は平日
    expect(dayType(new Date("2026-10-04T14:59:00Z"))).toBe("weekend");
    expect(dayType(new Date("2026-10-04T15:00:00Z"))).toBe("weekday");
  });

  it("長さの残りの境目: 19999 と 20000、39999 と 40000、49999 と 50000。負の長さは lt10", () => {
    expect(lengthBucket(19999)).toBe("lt20");
    expect(lengthBucket(20000)).toBe("lt30");
    expect(lengthBucket(39999)).toBe("lt40");
    expect(lengthBucket(40000)).toBe("lt50");
    expect(lengthBucket(49999)).toBe("lt50");
    expect(lengthBucket(50000)).toBe("lt60");
    expect(lengthBucket(-1)).toBe("lt10");
    expect(lengthBucket(-60000)).toBe("lt10");
  });

  it("冒頭と最後 3 秒: 負の値は null、2.5 は c2", () => {
    expect(edgeCutBucket(-1)).toBeNull();
    expect(edgeCutBucket(-0.5)).toBeNull();
    expect(edgeCutBucket(2.5)).toBe("c2");
  });

  it("1 週間 7 日分の曜日（日本時間の正午）", () => {
    // 2026-10-05 は月曜。03:00 UTC = 12:00 JST
    const days = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 9, 5 + i, 3, 0)));
    expect(days.map(weekdayOf)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
    expect(days.map(dayType)).toEqual(["weekday", "weekday", "weekday", "weekday", "weekday", "weekend", "weekend"]);
    // 日本時間の月曜 08:59（日曜 23:59 UTC）も月曜（UTC の曜日で数えない）
    expect(weekdayOf(new Date("2026-10-04T23:59:00Z"))).toBe("mon");
  });

  it("土曜 23:59 JST は土、日曜 00:00 JST は日（どちらも土日）", () => {
    const sat = new Date("2026-10-10T14:59:00Z");
    const sun = new Date("2026-10-10T15:00:00Z");
    expect(weekdayOf(sat)).toBe("sat");
    expect(weekdayOf(sun)).toBe("sun");
    expect(dayType(sat)).toBe("weekend");
    expect(dayType(sun)).toBe("weekend");
    // 金曜 23:59 JST は金
    expect(weekdayOf(new Date("2026-10-09T14:59:00Z"))).toBe("fri");
  });

  it("最後 3 秒のグループは cuts_in_last_3s で分ける（冒頭 3 秒と取り違えない）", () => {
    const rows = [
      reel(1, { cuts_in_first_3s: 0, cuts_in_last_3s: 2, views: 10 }),
      reel(2, { cuts_in_first_3s: 0, cuts_in_last_3s: 2, views: 30 }),
      reel(3, { cuts_in_first_3s: 2, cuts_in_last_3s: 0, views: 100 }),
      reel(4, { cuts_in_first_3s: 1, cuts_in_last_3s: 3, views: 50 }),
      reel(5, { cuts_in_first_3s: 1, cuts_in_last_3s: null, views: 70 }),
    ];
    const g = groupCards(rows, "views");
    expect(g.last3s.map((b) => b.label)).toEqual(["0 回", "1 回", "2 回", "3 回以上"]);
    expect(g.last3s.map((b) => b.n)).toEqual([1, 0, 2, 1]);
    expect(g.last3s.map((b) => b.value)).toEqual([100, null, 20, 50]);
    // 冒頭 3 秒は別の分かれ方
    expect(g.first3s.map((b) => b.n)).toEqual([2, 2, 1, 0]);
    expect(g.first3s.map((b) => b.value)).toEqual([20, 60, 100, null]);
  });

  it("区分の中央値と件数。値がない区分は null", () => {
    const rows = [reel(1, { duration_ms: 10000, views: 10 }), reel(2, { duration_ms: 12000, views: 30 }), reel(3, { duration_ms: 61000 })];
    const g = groupCards(rows, "views");
    expect(g.length.map((b) => b.n)).toEqual([0, 2, 0, 0, 0, 0, 1]);
    expect(g.length[1]?.value).toBe(20);
    expect(g.length[0]?.value).toBeNull();
    expect(g.first3s).toHaveLength(4);
    expect(g.weekday).toHaveLength(7);
  });
});

describe("検索パラメータ", () => {
  it("既定と不正値", () => {
    expect(parseReelsParams({})).toEqual({ y: "reach_rate", sort: "posted", dir: "desc" });
    expect(parseReelsParams({ y: "retention_rate", sort: "drop table", dir: "up" })).toEqual({
      y: "reach_rate",
      sort: "posted",
      dir: "desc",
    });
    expect(parseReelsParams({ y: ["views", "reach"], sort: ["duration"], dir: ["asc"] })).toEqual({
      y: "reach_rate",
      sort: "posted",
      dir: "desc",
    });
    expect(parseReelsParams({ y: "views", sort: "duration", dir: "asc" })).toEqual({ y: "views", sort: "duration", dir: "asc" });
  });

  it("並べ替えのリンクは y を保つ。y の選択は sort と dir を保つ", () => {
    const params = parseReelsParams({ y: "views", sort: "duration", dir: "asc" });
    const query = reelsQuery(params);
    const href = sortHeaderHref({ sortKey: "reach", sort: params.sort, order: params.dir, path: "/reels", query, orderParam: "dir" });
    expect(href).toBe("/reels?dir=desc&sort=reach&y=views");
    const same = sortHeaderHref({ sortKey: "duration", sort: params.sort, order: params.dir, path: "/reels", query, orderParam: "dir" });
    expect(same).toBe("/reels?dir=desc&sort=duration&y=views");
    expect(reelsQuery({ ...params, y: "reach_rate" })).toEqual({ y: undefined, sort: "duration", dir: "asc" });
    // 投稿一覧の並べ替えは今までどおり order
    expect(sortHeaderHref({ sortKey: "reach", sort: "posted", order: "desc", path: "/media", query: {} })).toBe(
      "/media?order=desc&sort=reach",
    );
  });

  it("一覧の並べ替え: 値のないものは向きによらず最後", () => {
    const rows = [reel(1, { duration_ms: null }), reel(2, { duration_ms: 3000 }), reel(3, { duration_ms: 9000 })];
    expect(sortReels(rows, "duration", "asc").map((r) => r.duration_ms)).toEqual([3000, 9000, null]);
    expect(sortReels(rows, "duration", "desc").map((r) => r.duration_ms)).toEqual([9000, 3000, null]);
    expect(sortReels(rows, "posted", "desc").map((r) => r.media_id)).toEqual([reel(3).media_id, reel(2).media_id, reel(1).media_id]);
  });
});

describe("一覧のページ送り", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => reel(i));

  it("0 件、ちょうど 10 件は 1 ページ。11 件は 2 ページで、2 ページ目は 1 件", () => {
    expect(PAGE_SIZE).toBe(10);
    const zero = paginateReels([], "posted", "desc", 1);
    expect(zero).toEqual({ pageRows: [], currentPage: 1, pageCount: 1 });
    const ten = paginateReels(many(10), "posted", "desc", 1);
    expect(ten.pageCount).toBe(1);
    expect(ten.pageRows).toHaveLength(10);
    const eleven1 = paginateReels(many(11), "posted", "desc", 1);
    expect(eleven1.pageCount).toBe(2);
    expect(eleven1.pageRows).toHaveLength(10);
    const eleven2 = paginateReels(many(11), "posted", "desc", 2);
    expect(eleven2.currentPage).toBe(2);
    // 新しい順の最後は最も古い reel(0)
    expect(eleven2.pageRows.map((r) => r.media_id)).toEqual([reel(0).media_id]);
  });

  it("範囲外の page は最後のページに丸める", () => {
    const far = paginateReels(many(11), "posted", "desc", 99);
    expect(far.currentPage).toBe(2);
    expect(far.pageCount).toBe(2);
    expect(far.pageRows.map((r) => r.media_id)).toEqual([reel(0).media_id]);
    const tenFar = paginateReels(many(10), "posted", "desc", 2);
    expect(tenFar.currentPage).toBe(1);
    expect(tenFar.pageRows).toHaveLength(10);
  });

  it("全件を並べ替えてから切り出す（ページの中だけの並べ替えにしない）", () => {
    // 入力の順と長さの順をずらす（i × 7 mod 15 は 0〜14 の並べ替え）
    const rows = Array.from({ length: 15 }, (_, i) => reel(i, { duration_ms: 1000 + ((i * 7) % 15) * 1000 }));
    const p1 = paginateReels(rows, "duration", "desc", 1);
    const p2 = paginateReels(rows, "duration", "desc", 2);
    const d = (rs: readonly ReelRow[]) => rs.map((r) => r.duration_ms as number);
    expect(d(p1.pageRows)).toEqual([15000, 14000, 13000, 12000, 11000, 10000, 9000, 8000, 7000, 6000]);
    expect(d(p2.pageRows)).toEqual([5000, 4000, 3000, 2000, 1000]);
    const asc = paginateReels(rows, "duration", "asc", 1);
    expect(d(asc.pageRows)).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
  });
});

describe("カットのタイムライン", () => {
  it("画面変化 0 回なら帯は 1 本", () => {
    const m = timelineModel([], 8000);
    expect(m?.scenes).toEqual([{ start: 0, end: 8000 }]);
    expect(m?.cuts).toEqual([]);
  });

  it("0 ms の画面変化、重複、長さ以上の時刻は捨てる", () => {
    const m = timelineModel([0, 2000, 2000, 5000, 8000, 9000], 8000);
    expect(m?.cuts).toEqual([2000, 5000]);
    expect(m?.scenes).toEqual([
      { start: 0, end: 2000 },
      { start: 2000, end: 5000 },
      { start: 5000, end: 8000 },
    ]);
  });

  it("duration_ms が null か 0 なら描かない", () => {
    expect(timelineModel([1000], null)).toBeNull();
    expect(timelineModel([1000], 0)).toBeNull();
  });

  it("目盛の間隔は動画の長さから", () => {
    // 内側の幅 1124 px、目盛 1 つ 44 px → 最大 25 個
    expect(timelineTickStepMs(10000, 1124)).toBe(1000);
    expect(timelineTickStepMs(60000, 1124)).toBe(5000);
    expect(timelineTickStepMs(60000, 324)).toBe(10000);
    expect(timelineTickStepMs(900000, 324)).toBe(300000);
    expect(timelineTicks(12000, 5000)).toEqual([0, 5000, 10000]);
  });

  it("印が詰まるときは三角を省く", () => {
    const m = timelineModel([1000, 1600, 5000], 60000);
    if (m === null) throw new Error("model");
    expect(markersFit(m, 1124)).toBe(true);
    expect(markersFit(m, 324)).toBe(false);
    const html = renderToStaticMarkup(createElement(CutTimeline, { model: m, width: 340 }));
    expectClean(html);
    expect(html).toContain('data-markers="false"');
    expect(html).not.toContain('data-part="cut"');
    expect(html.match(/data-part="scene"/g)).toHaveLength(4);
  });

  it("描画: 帯 1 本、title と aria-label", () => {
    const m = timelineModel([], 8000);
    if (m === null) throw new Error("model");
    const html = renderToStaticMarkup(createElement(CutTimeline, { model: m }));
    expectClean(html);
    expect(html.match(/data-part="scene"/g)).toHaveLength(1);
    expect(html).toContain("aria-label=\"カットのタイムライン: 長さ 8.0 秒、画面変化 0 回、シーン 1 本\"");
  });
});

describe("解析の状態から「—」の理由", () => {
  it("行なし → not_yet、no_video_url と failed → missing、success → null", () => {
    expect(videoAnalysisMissing(null)).toEqual({ reason: "not_yet", text: null });
    expect(videoAnalysisMissing("no_video_url")).toEqual({ reason: "missing", text: "取得できなかった" });
    expect(videoAnalysisMissing("failed")).toEqual({ reason: "missing", text: "取得できなかった" });
    expect(videoAnalysisMissing("success")).toBeNull();
  });

  it("視聴維持率: フィード動画は unsupported、リールは状態の対応", () => {
    expect(retentionMissing({ kind: "feed", analysisStatus: "success", durationMs: 1000, value: 0.5 })?.reason).toBe("unsupported");
    expect(retentionMissing({ kind: "reel", analysisStatus: null, durationMs: null, value: null })?.reason).toBe("not_yet");
    expect(retentionMissing({ kind: "reel", analysisStatus: "failed", durationMs: null, value: null })?.reason).toBe("missing");
    expect(retentionMissing({ kind: "reel", analysisStatus: "success", durationMs: 0, value: null })?.reason).toBe(
      "no_baseline_data",
    );
    expect(retentionMissing({ kind: "reel", analysisStatus: "success", durationMs: 9000, value: null })?.reason).toBe("missing");
    expect(retentionMissing({ kind: "reel", analysisStatus: "success", durationMs: 9000, value: 1.3 })).toBeNull();
  });
});

describe("Scatter と Forest", () => {
  const scatter = (points: ScatterPoint[], refY?: number | null) =>
    renderToStaticMarkup(createElement(Scatter, { title: "t", points, refY }));

  it("点 0 個、1 個、x が全部同じ、値が 1 超えでも NaN を出さない", () => {
    expectClean(scatter([]));
    expectClean(scatter([{ x: 3, y: 0.4, tip: "a" }]));
    const same = scatter([
      { x: 5, y: 1, tip: "a", href: "/media/1" },
      { x: 5, y: 2, tip: "b", href: "/media/2" },
    ]);
    expectClean(same);
    expect(same).toContain('href="/media/1"');
    expect(same.match(/data-part="point"/g)).toHaveLength(2);
    expectClean(scatter([{ x: 1.4, y: 2.5, tip: "a" }, { x: 0.2, y: 0.1, tip: "b" }], 1.2));
  });

  it("軸の範囲はデータから（下端を 0 に固定しない。上限も固定しない）", () => {
    const d = scatterDomain([0.8, 1.6]);
    expect(d.min).toBeGreaterThan(0);
    expect(d.max).toBeGreaterThanOrEqual(1.6);
    const one = scatterDomain([5]);
    expect(one.max).toBeGreaterThan(one.min);
    const none = scatterDomain([]);
    expect(none.max).toBeGreaterThan(none.min);
  });

  it("Forest: r が null の行は「—」で幅を描かない。幅が 0 をまたぐ行は薄く", () => {
    const rows: ForestRow[] = [
      { key: "a", label: "動画の長さ", hint: "h", n: 2, r: null, lo: null, hi: null },
      { key: "b", label: "画面変化の回数", hint: "h", n: 10, r: 0.4, lo: -0.1, hi: 0.8 },
      { key: "c", label: "平均シーン長", hint: "h", n: 10, r: -0.6, lo: -0.9, hi: -0.2 },
    ];
    const html = renderToStaticMarkup(createElement(Forest, { rows }));
    expectClean(html);
    expect(html).toContain("—");
    // 3 行 × PC とスマートフォンの 2 枚。r のある 2 行だけ点と幅
    expect(html.match(/data-part="r"/g)).toHaveLength(4);
    expect(html.match(/data-part="interval"/g)).toHaveLength(4);
    expect(html.match(/data-faint="true"/g)).toHaveLength(2);
    expect(html).toContain("+0.40");
    expect(html).toContain("-0.60");
  });
});

describe("ナビゲーションと収集ログ", () => {
  it("リール分析は投稿一覧の次", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(hrefs.indexOf("/reels")).toBe(hrefs.indexOf("/media") + 1);
    expect(NAV_ITEMS.find((i) => i.href === "/reels")?.label).toBe("リール分析");
    expect(activeNavHref("/reels")).toBe("/reels");
    expect(activeNavHref("/media/123")).toBe("/media");
  });

  it("video_analysis は media_snapshot の後", () => {
    expect(JOB_ORDER.indexOf("video_analysis")).toBe(JOB_ORDER.indexOf("media_snapshot") + 1);
  });
});

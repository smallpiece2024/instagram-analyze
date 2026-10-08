/**
 * 投稿時刻（`lib/timing.ts` と `app/timing/_timing/cards.tsx`）の単体テスト（R5 設計 7.1 節「画面（単体）」、T15、T16）。
 * 行は架空の値をテストの中で作る（DB は使わない）。曜日と時は SQL が JST に変換して渡す前提なので、ここでは isodow と hour を直接与える
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { comboPoints, HeatCard, NoTiming, TopCard } from "@/app/timing/_timing/cards";
import { parseKindFilter, parseTimingMetric } from "@/lib/params";
import {
  bandIndex,
  buildTimingView,
  dayIndex,
  faintIndexes,
  median,
  timingMetricOptionLabel,
  timingQuery,
  type TimingRow,
} from "@/lib/timing";

let seq = 0;
function row(p: Partial<TimingRow> & { isodow: number; hour: number }): TimingRow {
  seq += 1;
  return {
    media_id: p.media_id ?? `m${String(seq).padStart(3, "0")}`,
    kind: p.kind ?? "feed",
    posted_at: p.posted_at ?? new Date(Date.UTC(2026, 8, 1) + seq * 60_000),
    isodow: p.isodow,
    hour: p.hour,
    reach_24h: p.reach_24h ?? null,
    views_24h: p.views_24h ?? null,
    reach_latest: p.reach_latest ?? null,
    views_latest: p.views_latest ?? null,
  };
}

describe("時間帯と曜日の位置", () => {
  it("時間帯は 3 時間ごとで下端を含む（3:00 ちょうどは 3-6、0 時は 0-3）", () => {
    expect(bandIndex(0)).toBe(0);
    expect(bandIndex(2)).toBe(0);
    expect(bandIndex(3)).toBe(1);
    expect(bandIndex(5)).toBe(1);
    expect(bandIndex(21)).toBe(7);
    expect(bandIndex(23)).toBe(7);
  });

  it("範囲外の時と曜日は null", () => {
    expect(bandIndex(24)).toBeNull();
    expect(bandIndex(-1)).toBeNull();
    expect(bandIndex(1.5)).toBeNull();
    expect(dayIndex(0)).toBeNull();
    expect(dayIndex(8)).toBeNull();
    expect(dayIndex(1)).toBe(0);
    expect(dayIndex(7)).toBe(6);
  });
});

describe("中央値", () => {
  it("線形補間（percentile_cont と同じ）。0 件は null", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([30, 10])).toBe(20);
    expect(median([1, 100, 2])).toBe(2);
  });
});

describe("buildTimingView", () => {
  const rows: TimingRow[] = [
    // 月 9-12: 2 件
    row({ isodow: 1, hour: 9, reach_24h: 100, reach_latest: 150 }),
    row({ isodow: 1, hour: 11, reach_24h: 300, reach_latest: 350 }),
    // 月 0-3: 1 件（※）
    row({ isodow: 1, hour: 0, reach_24h: 50, reach_latest: 60 }),
    // 日 21-24: リール 1 件
    row({ isodow: 7, hour: 23, kind: "reel", reach_24h: 1000, reach_latest: 1200, views_24h: 5000 }),
    // 24 時間の値なし（最新だけ）
    row({ isodow: 3, hour: 12, reach_24h: null, reach_latest: 80 }),
  ];

  it("曜日 × 時間帯の中央値と件数、件数 0 は null と 0", () => {
    const v = buildTimingView(rows, "reach_24h", "all");
    expect(v.total).toBe(4);
    expect(v.heat.median[0]?.[3]).toBe(200);
    expect(v.heat.n[0]?.[3]).toBe(2);
    expect(v.heat.median[0]?.[0]).toBe(50);
    expect(v.heat.n[0]?.[0]).toBe(1);
    expect(v.heat.median[6]?.[7]).toBe(1000);
    expect(v.heat.median[2]?.[4]).toBeNull();
    expect(v.heat.n[2]?.[4]).toBe(0);
    expect(v.heat.median).toHaveLength(7);
    expect(v.heat.median[0]).toHaveLength(8);
  });

  it("時間帯別と曜日別", () => {
    const v = buildTimingView(rows, "reach_24h", "all");
    expect(v.byBand.n).toEqual([1, 0, 0, 2, 0, 0, 0, 1]);
    expect(v.byBand.median[3]).toBe(200);
    expect(v.byBand.median[1]).toBeNull();
    expect(v.byDay.n).toEqual([3, 0, 0, 0, 0, 0, 1]);
    expect(v.byDay.median[0]).toBe(100);
    expect(v.overallMedian).toBe(200);
    expect(faintIndexes(v.byDay.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("指標の切り替え（最新のリーチ）で 24 時間の値のない投稿も入る", () => {
    const v = buildTimingView(rows, "reach_latest", "all");
    expect(v.total).toBe(5);
    expect(v.heat.median[2]?.[4]).toBe(80);
  });

  it("種類で絞る。指標ごとの件数は選んだ種類の中で数える", () => {
    const v = buildTimingView(rows, "reach_24h", "reel");
    expect(v.total).toBe(1);
    expect(v.heat.n[0]?.[3]).toBe(0);
    expect(v.metricCounts).toEqual({ reach_24h: 1, views_24h: 1, reach_latest: 1, views_latest: 0 });
    const all = buildTimingView(rows, "reach_24h", "all");
    expect(all.metricCounts).toEqual({ reach_24h: 4, views_24h: 1, reach_latest: 5, views_latest: 0 });
  });

  it("上位の組み合わせ: 件数 1 件は除き、中央値の高い順、同じなら曜日、時間帯の順に 5 行", () => {
    const rs: TimingRow[] = [];
    // 7 つの組み合わせ（各 2 件）。中央値 500 が 3 つ（火 3-6、月 6-9、月 3-6）
    const add = (isodow: number, hour: number, a: number, b: number) => {
      rs.push(row({ isodow, hour, reach_24h: a }), row({ isodow, hour, reach_24h: b }));
    };
    add(2, 3, 400, 600); // 火 3-6: 500
    add(1, 6, 500, 500); // 月 6-9: 500
    add(1, 4, 450, 550); // 月 3-6: 500
    add(4, 12, 900, 1100); // 木 12-15: 1000
    add(5, 18, 100, 100); // 金 18-21: 100
    add(6, 9, 200, 200); // 土 9-12: 200
    add(7, 0, 50, 50); // 日 0-3: 50
    rs.push(row({ isodow: 3, hour: 15, reach_24h: 99999 })); // 件数 1 件（除く）
    const v = buildTimingView(rs, "reach_24h", "all");
    expect(v.top.map((c) => [c.day, c.band, c.median, c.n])).toEqual([
      [3, 4, 1000, 2],
      [0, 1, 500, 2],
      [0, 2, 500, 2],
      [1, 1, 500, 2],
      [5, 3, 200, 2],
    ]);
  });

  it("上位の組み合わせの点は投稿日時、同時刻は id の順。点は投稿詳細へのリンク", () => {
    const t = new Date(Date.UTC(2026, 8, 10, 3));
    const rs = [
      row({ media_id: "b", isodow: 2, hour: 12, reach_24h: 10, posted_at: t }),
      row({ media_id: "a", isodow: 2, hour: 12, reach_24h: 20, posted_at: t }),
      row({ media_id: "c", isodow: 2, hour: 12, reach_24h: 30, posted_at: new Date(t.getTime() - 1000) }),
    ];
    const v = buildTimingView(rs, "reach_24h", "all");
    expect(v.top[0]?.points.map((p) => p.media_id)).toEqual(["c", "a", "b"]);
    const pts = comboPoints(v.top[0]!);
    expect(pts.map((p) => p.href)).toEqual(["/media/c", "/media/a", "/media/b"]);
  });

  it("範囲外の曜日と時の行は数えない", () => {
    const v = buildTimingView([row({ isodow: 0, hour: 3, reach_24h: 1 }), row({ isodow: 1, hour: 24, reach_24h: 1 })], "reach_24h", "all");
    expect(v.total).toBe(0);
    expect(v.metricCounts.reach_24h).toBe(0);
  });
});

describe("方針の回帰（T15）", () => {
  it("24 時間の値が 0 件でも、既定の指標は 24 時間リーチ、種類はすべて", () => {
    const rs = [row({ isodow: 1, hour: 9, reach_latest: 10 })];
    const m = parseTimingMetric(undefined);
    const kind = parseKindFilter(undefined);
    expect(m).toBe("reach_24h");
    expect(kind).toBe("all");
    const v = buildTimingView(rs, m, kind);
    expect(v.m).toBe("reach_24h");
    expect(v.total).toBe(0);
    expect(timingMetricOptionLabel("reach_24h", v.metricCounts.reach_24h)).toBe("24 時間リーチ（0 件）");
    expect(timingMetricOptionLabel("reach_latest", v.metricCounts.reach_latest)).toBe("最新のリーチ（1 件）");
  });

  it("リンクのクエリは指標と種類を持つ", () => {
    expect(timingQuery("views_latest", "carousel")).toEqual({ m: "views_latest", kind: "carousel" });
  });
});

describe("カードの描画", () => {
  it("ヒートマップ: 件数 1 は ※、見出しに指標の名前、「初速」の語を出さない", () => {
    const v = buildTimingView(
      [row({ isodow: 1, hour: 0, reach_24h: 50 }), row({ isodow: 2, hour: 9, reach_24h: 80 }), row({ isodow: 2, hour: 9, reach_24h: 120 })],
      "reach_24h",
      "all",
    );
    const html = renderToStaticMarkup(createElement(HeatCard, { view: v }));
    expect(html).toContain("曜日 × 時間帯の 24 時間リーチ（中央値）");
    const latest = renderToStaticMarkup(createElement(HeatCard, { view: buildTimingView([], "reach_latest", "all") }));
    expect(latest).toContain("曜日 × 時間帯の最新のリーチ（中央値）");
    expect(html).toContain("50※");
    expect(html).not.toContain("100※");
    expect(html).toContain("※: n=1");
    expect(html).not.toContain("初速");
  });

  it("ヒートマップ: 全部同じ値でも NaN を出さない（T16）", () => {
    const v = buildTimingView(
      [row({ isodow: 1, hour: 0, reach_24h: 7 }), row({ isodow: 4, hour: 15, reach_24h: 7 })],
      "reach_24h",
      "all",
    );
    const html = renderToStaticMarkup(createElement(HeatCard, { view: v }));
    expect(html).not.toContain("NaN");
    expect(html).toContain("最小 7");
    expect(html).toContain("最大 7");
  });

  it("上位の組み合わせ: 組み合わせがなければ「—」、1 行でも NaN を出さない", () => {
    const one = buildTimingView([row({ isodow: 1, hour: 0, reach_24h: 7 })], "reach_24h", "all");
    const html1 = renderToStaticMarkup(createElement(TopCard, { view: one }));
    expect(html1).toContain("—");
    expect(html1).not.toContain("<table");
    const two = buildTimingView(
      [row({ isodow: 1, hour: 0, reach_24h: 7 }), row({ isodow: 1, hour: 1, reach_24h: 7 })],
      "reach_24h",
      "all",
    );
    const html2 = renderToStaticMarkup(createElement(TopCard, { view: two }));
    expect(html2).toContain("<table");
    expect(html2).not.toContain("NaN");
    expect(html2).toContain("件数 1 件の組み合わせは除く");
  });

  it("対象 0 件の表示は「—」だけ", () => {
    expect(renderToStaticMarkup(createElement(NoTiming))).toContain("—");
  });
});

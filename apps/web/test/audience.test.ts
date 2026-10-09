/**
 * オーディエンスの計算（`lib/audience.ts`）とカードの描画の単体テスト（R5 設計 6.4 節、7.1 節の T9、T15、S11）。
 * 行は架空の値をテストの中で作る（DB は使わない）。都市は `CityA, PrefA` などの架空の名前、人数も架空
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BreakdownCardView, TrendCard } from "@/app/audience/_audience/cards";
import {
  addDays,
  breakdownCard,
  buildAudienceView,
  indexCaptures,
  latestWeekOf,
  shareRows,
  topRows,
  TOP_LIMIT,
  type AudienceBreakdown,
  type AudienceRow,
} from "@/lib/audience";

const W1 = "2026-09-21";
const W2 = "2026-09-28";
const W3 = "2026-10-05";

/** 1 つの記録の行。`values` が空なら `empty` の 1 行（value_key は null） */
function capture(week: string, breakdown: AudienceBreakdown, values: Record<string, number>, fetchedAt?: Date): AudienceRow[] {
  const at = fetchedAt ?? new Date(`${week}T06:00:00+09:00`);
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return [{ week_start: week, breakdown, status: "empty", fetched_at: at, value_key: null, value: null }];
  }
  return entries.map(([k, v]) => ({ week_start: week, breakdown, status: "ok", fetched_at: at, value_key: k, value: v }));
}

/** n 件の都市（CityNN, PrefA）。人数は件数ぶんの架空の値 */
function cities(n: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) out[`City${String(i).padStart(2, "0")}, PrefA`] = 100 - i;
  return out;
}

describe("割合と並び", () => {
  it("割合の分母は返った区分の合計", () => {
    const rows = shareRows(new Map([["F", 30], ["M", 10]]), "gender");
    expect(rows).toEqual([
      { label: "女性", value: 30, share: 0.75 },
      { label: "男性", value: 10, share: 0.25 },
    ]);
  });

  it("性別は表示名にし、女性、男性、不明の順（DB の値は F、M、U）", () => {
    const rows = shareRows(new Map([["U", 1], ["M", 2], ["F", 3]]), "gender");
    expect(rows.map((r) => r.label)).toEqual(["女性", "男性", "不明"]);
  });

  it("合計が 0 なら割合は null（0 で割らない）", () => {
    const rows = shareRows(new Map([["F", 0], ["M", 0]]), "gender");
    expect(rows.map((r) => r.share)).toEqual([null, null]);
  });

  it("年齢は区分の名前の順（入力の順によらない）", () => {
    const rows = shareRows(new Map([["65+", 1], ["18-24", 5], ["35-44", 9], ["25-34", 3]]), "age");
    expect(rows.map((r) => r.label)).toEqual(["18-24", "25-34", "35-44", "65+"]);
  });

  it("国と都市は人数の多い順、同数は名前の順", () => {
    const rows = shareRows(new Map([["CityB, PrefA", 5], ["CityC, PrefB", 9], ["CityA, PrefA", 5]]), "city");
    expect(rows.map((r) => r.label)).toEqual(["CityC, PrefB", "CityA, PrefA", "CityB, PrefA"]);
  });

  it.each([
    [10, 10, 0],
    [11, 10, 1],
    [45, 10, 35],
  ])("「ほか n 件」の境目: %i 件なら %i 行とほか %i 件", (n, shown, others) => {
    const all = shareRows(new Map(Object.entries(cities(n))), "city");
    const r = topRows(all, TOP_LIMIT);
    expect(r.rows).toHaveLength(shown);
    expect(r.others).toBe(others);
  });

  it("上位で切っても割合の分母は全区分の合計", () => {
    const view = buildAudienceView(capture(W1, "city", cities(11)));
    const card = view.cards.find((c) => c.breakdown === "city");
    expect(card?.kind).toBe("ok");
    if (card?.kind !== "ok") return;
    const total = Object.values(cities(11)).reduce((a, b) => a + b, 0);
    expect(card.total).toBe(total);
    expect(card.rows[0]?.share).toBeCloseTo(100 / total);
  });
});

describe("最新の週（T9、T15）", () => {
  it("全体で最も新しい週を 1 つ決め、その週に行のない内訳は「—」", () => {
    const rows = [
      ...capture(W1, "gender", { F: 3, M: 2 }),
      ...capture(W1, "age", { "18-24": 4 }),
      ...capture(W2, "age", { "18-24": 6 }),
    ];
    const index = indexCaptures(rows);
    expect(latestWeekOf(index)).toBe(W2);
    expect(breakdownCard(index, W2, "gender").kind).toBe("missing");
    expect(breakdownCard(index, W2, "age").kind).toBe("ok");
  });

  it("最新の週が empty なら前の週の値で埋めない", () => {
    const rows = [...capture(W1, "country", { JP: 50, US: 5 }), ...capture(W2, "country", {})];
    const view = buildAudienceView(rows);
    const card = view.cards.find((c) => c.breakdown === "country");
    expect(card).toEqual({ kind: "missing", breakdown: "country", fetchedAt: new Date(`${W2}T06:00:00+09:00`) });
  });

  it("記録が 0 週なら最新の週は null で、カードはすべて「—」", () => {
    const view = buildAudienceView([]);
    expect(view.latestWeek).toBeNull();
    expect(view.weekCount).toBe(0);
    expect(view.hasOk).toBe(false);
    expect(view.cards.every((c) => c.kind === "missing")).toBe(true);
    expect(view.weeks).toEqual([]);
  });

  it("記録の週の数と最終更新", () => {
    const late = new Date("2026-10-06T05:31:00+09:00");
    const view = buildAudienceView([...capture(W1, "age", { "18-24": 1 }), ...capture(W3, "age", { "18-24": 1 }, late)]);
    expect(view.weekCount).toBe(2);
    expect(view.lastFetchedAt).toEqual(late);
  });

  it("empty だけなら反応したユーザーの節を出さない（hasOk が偽）", () => {
    const view = buildAudienceView([...capture(W1, "age", {}), ...capture(W1, "gender", {})]);
    expect(view.hasOk).toBe(false);
    expect(buildAudienceView(capture(W1, "city", { "CityA, PrefA": 1 })).hasOk).toBe(true);
  });
});

describe("推移（T9）", () => {
  it("週の軸は記録のない週も含め、その週は欠け（線を切る）", () => {
    const rows = [...capture(W1, "country", { JP: 1, KR: 3 }), ...capture(W3, "country", { JP: 1, KR: 1 })];
    const view = buildAudienceView(rows);
    expect(view.weeks).toEqual([W1, W2, W3]);
    expect(view.country.series).toEqual([
      { label: "JP", values: [0.25, null, 0.5] },
      { label: "KR", values: [0.75, null, 0.5] },
    ]);
  });

  it("上位 45 件から外れて返らなかった週は 0 ではなく欠け", () => {
    const rows = [
      ...capture(W1, "country", { JP: 8, KR: 2 }),
      ...capture(W2, "country", { JP: 10 }),
      ...capture(W3, "country", { JP: 6, KR: 4 }),
    ];
    const view = buildAudienceView(rows);
    const kr = view.country.series.find((s) => s.label === "KR");
    expect(kr?.values).toEqual([0.2, null, 0.4]);
  });

  it("empty の週は欠け", () => {
    const rows = [...capture(W1, "country", { JP: 1 }), ...capture(W2, "country", {}), ...capture(W3, "country", { JP: 1 })];
    expect(buildAudienceView(rows).country.series[0]?.values).toEqual([1, null, 1]);
  });

  it("国は最新の週の上位 5 か国だけ", () => {
    const latest = { AA: 9, BB: 8, CC: 7, DD: 6, EE: 5, FF: 4 };
    const view = buildAudienceView([...capture(W1, "country", { FF: 100 }), ...capture(W2, "country", latest)]);
    expect(view.country.series.map((s) => s.label)).toEqual(["AA", "BB", "CC", "DD", "EE"]);
  });

  it("最新の週に国がなければ国の系列は 0 本", () => {
    const view = buildAudienceView([...capture(W1, "country", { JP: 1 }), ...capture(W2, "age", { "18-24": 1 })]);
    expect(view.country.series).toEqual([]);
  });

  it("日付の加算は月と年をまたぐ", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
  });
});

describe("描画（S11）", () => {
  it("都市の名前は文字として出る（タグとして解釈しない）", () => {
    const view = buildAudienceView(capture(W1, "city", { "<script>alert(1)</script>": 3, "#<img src=x onerror=alert(1)>": 2 }));
    const card = view.cards.find((c) => c.breakdown === "city");
    if (!card) throw new Error("no card");
    const html = renderToStaticMarkup(createElement(BreakdownCardView, { card, week: W1, metricLabel: "フォロワーの属性" }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("分母: 返った区分の合計");
    expect(html).toContain(`${W1} の週（日本時間）の記録・取得 2026-09-21 06:00`);
  });

  it("「—」のカードと「ほか n 件」", () => {
    const missing = renderToStaticMarkup(
      createElement(BreakdownCardView, { card: { kind: "missing", breakdown: "age", fetchedAt: null }, week: W1, metricLabel: "x" }),
    );
    expect(missing).toContain("—");
    expect(missing).not.toContain("<svg");
    const view = buildAudienceView(capture(W1, "city", cities(12)));
    const card = view.cards.find((c) => c.breakdown === "city");
    if (!card) throw new Error("no card");
    expect(renderToStaticMarkup(createElement(BreakdownCardView, { card, week: W1, metricLabel: "x" }))).toContain("ほか 2 件");
  });

  it("1 週だけの推移は点だけで NaN を出さない", () => {
    const view = buildAudienceView(capture(W1, "country", { JP: 1, KR: 1 }));
    const html = renderToStaticMarkup(
      createElement(TrendCard, {
        weeks: view.weeks,
        country: view.country.series,
        latestWeek: W1,
        lastFetchedAt: view.lastFetchedAt,
      }),
    );
    expect(html).not.toContain("NaN");
    expect(html).toContain("<circle");
  });
});

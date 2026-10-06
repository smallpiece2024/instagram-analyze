import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BandRow, type BandRowProps } from "@/components/charts/BandRow";
import { LineChart, type LineChartProps } from "@/components/charts/LineChart";
import { Legend } from "@/components/charts/Legend";
import { Stacked100, type Stacked100Props } from "@/components/charts/Stacked100";
import { VBars, type VBarsProps } from "@/components/charts/VBars";
import { dimRuns, niceMax, segments, yDomain } from "@/components/charts/scale";
import { pagerItems } from "@/components/Pager";
import { BaselineBand, bandDomain } from "@/app/compare/_compare/BaselineBand";
import { jpRange, monthDay } from "@/app/compare/_compare/labels";

/** SVG に NaN、Infinity、undefined が出ていないこと */
function expectClean(html: string) {
  expect(html).not.toMatch(/NaN|Infinity|undefined/);
  expect(html.startsWith("<svg")).toBe(true);
}

const vbars = (p: Partial<VBarsProps>) =>
  renderToStaticMarkup(createElement(VBars, { title: "t", values: [], labels: [], ...p }));
const line = (p: Partial<LineChartProps>) =>
  renderToStaticMarkup(createElement(LineChart, { title: "t", labels: [], series: [], ...p }));
const stacked = (p: Partial<Stacked100Props>) => renderToStaticMarkup(createElement(Stacked100, { title: "t", rows: [], ...p }));
const band = (p: Partial<BandRowProps>) =>
  renderToStaticMarkup(
    createElement(BandRow, {
      label: "リーチ",
      value: 100,
      stats: { n: 0, min: null, max: null, p25: null, median: null, p75: null },
      ...p,
    }),
  );

describe("目盛", () => {
  it("niceMax は 0、負、NaN で 1", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(2.4)).toBe(2.5);
  });

  it("yDomain は値なしと全部同じ値でも幅を持つ", () => {
    expect(yDomain([])).toEqual({ min: 0, max: 1 });
    expect(yDomain([0, 0])).toEqual({ min: 0, max: 1 });
    const d = yDomain([5, 5], { min: 5 });
    expect(d.max).toBeGreaterThan(d.min);
    const fixed = yDomain([5], { min: 5, max: 5 });
    expect(fixed.max).toBeGreaterThan(fixed.min);
  });

  it("segments は null で区切る", () => {
    expect(segments([1, 2, null, 3])).toEqual([
      { start: 0, items: [1, 2] },
      { start: 3, items: [3] },
    ]);
    expect(segments([null, null])).toEqual([]);
  });
});

describe("VBars", () => {
  it("0 件、1 点、全部 null、全部同じ値で例外を投げず NaN を出さない", () => {
    expectClean(vbars({}));
    expectClean(vbars({ values: [5], labels: ["a"] }));
    const allNull = vbars({ values: [null, null], labels: ["a", "b"] });
    expectClean(allNull);
    expect(allNull).toContain("—");
    expectClean(vbars({ values: [0, 0, 0], labels: ["a", "b", "c"], valueLabels: "all" }));
    expectClean(vbars({ values: [3, 3, 3], labels: ["a", "b", "c"], markers: [1], nLabels: [1, 2, 3], noAxis: true }));
  });

  it("aria-label を付ける", () => {
    expect(vbars({ title: "日次のリーチ", values: [1], labels: ["a"] })).toContain('aria-label="日次のリーチ"');
  });

  it("縦の破線とラベル、投稿の印のヒントを描く（LineChart と同じ形）", () => {
    const html = vbars({
      values: [1, 2, 3],
      labels: ["a", "b", "c"],
      markers: [0, 2],
      markerTips: ["投稿 1", "投稿 2"],
      refLines: [{ index: 1, label: "指標変更" }],
    });
    expectClean(html);
    expect(html).toContain('class="chart-ref"');
    expect(html).toContain("指標変更");
    expect(html).toContain("<title>投稿 1</title>");
    expect(html).toContain("<title>投稿 2</title>");
    // ヒントは ▲ の周りの透明な四角に付ける（一辺 18px）
    expect(html.match(/<rect[^>]*width="18"[^>]*height="18"[^>]*fill="transparent"/g)).toHaveLength(2);
  });
});

describe("LineChart", () => {
  it("0 件、1 点、全部 null、全部同じ値で例外を投げず NaN を出さない", () => {
    expectClean(line({}));
    expectClean(line({ labels: ["a"], series: [{ label: "s", values: [5], dots: true, endLabel: "5" }] }));
    expectClean(line({ labels: ["a", "b"], series: [{ label: "s", values: [null, null], dots: true, endLabel: "x" }] }));
    expectClean(line({ labels: ["a", "b", "c"], series: [{ label: "s", values: [7, 7, 7] }], min: 7 }));
    expectClean(line({ labels: ["a", "b"], series: [{ label: "s", values: [0, 0] }], align: true, markers: [0], refLines: [{ index: 1, label: "指標変更" }] }));
  });

  it("null の点で線を切る（M が 2 回）", () => {
    const html = line({ labels: ["a", "b", "c", "d"], series: [{ label: "s", values: [1, 2, null, 4], color: "red" }] });
    const d = /class="chart-line" d="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(d.match(/M/g)?.length).toBe(2);
  });

  it("破線の系列も color が効く。color がなければ .chart-ref の色のまま", () => {
    const html = line({
      labels: ["a", "b"],
      series: [
        { label: "B", values: [1, 2], dashed: true, color: "var(--color-neutral)" },
        { label: "中央値", values: [2, 3], dashed: true },
      ],
    });
    expect(html).toMatch(/class="chart-ref" d="[^"]+" style="stroke:var\(--color-neutral\)"/);
    expect(html).toMatch(/class="chart-ref" d="[^"]+"><title>中央値/);
  });

  it("pointTips を点のヒントにする。dots がない系列は透明な点にヒントを付ける", () => {
    const html = line({
      labels: ["1 日目", "2 日目"],
      series: [
        { label: "A", values: [1, 2], dots: true, pointTips: ["A 2026-09-01", "A 2026-09-02"] },
        { label: "B", values: [3, null], dashed: true, pointTips: ["B 2025-09-01", "B 2025-09-02"] },
      ],
    });
    expectClean(html);
    expect(html).toContain("<title>A 2026-09-02</title>");
    expect(html).toContain("<title>B 2025-09-01</title>");
    // 値のない点にはヒントを出さない
    expect(html).not.toContain("B 2025-09-02");
    expect(html.match(/data-part="tip"/g)?.length).toBe(1);
  });

  it("dimIndexes の点とつながる線、帯を薄く描く", () => {
    const html = line({
      labels: ["a", "b", "c", "d"],
      series: [{ label: "中央値", values: [1, 2, 3, 4], dashed: true, dimIndexes: [3] }],
      band: { lower: [0, 1, 2, 3], upper: [2, 3, 4, 5], label: "25〜75%", dimIndexes: [3] },
    });
    expectClean(html);
    // 線は通常（a〜c）と薄い（c〜d）の 2 本、帯も 2 つ
    expect(html.match(/class="chart-ref"/g)?.length).toBe(2);
    expect(html.match(/class="chart-band"/g)?.length).toBe(2);
    expect(html.match(/opacity="\.45"/g)?.length).toBe(2);
    // 薄くしないときは 1 本
    const plain = line({ labels: ["a", "b"], series: [{ label: "s", values: [1, 2] }] });
    expect(plain).not.toContain("opacity=");
  });

  it("帯は両側がある区間だけ描く", () => {
    const html = line({
      labels: ["a", "b", "c"],
      series: [{ label: "s", values: [1, 2, 3] }],
      band: { lower: [0, null, 1], upper: [2, 3, null], label: "25〜75%" },
    });
    expectClean(html);
    expect(html.match(/chart-band/g)?.length).toBe(1);
  });

  it("labels2 があれば X 軸のラベルを 2 段にし、行の頭の名前と行の色を付ける", () => {
    const html = line({
      labels: ["9/1", "9/2", "9/3"],
      labels2: ["8/1", "8/2", ""],
      rowNames: ["A", "B"],
      rowColors: ["var(--color-primary)", "var(--color-neutral)"],
      series: [{ label: "A", values: [1, 2, 3] }],
      height: 200,
    });
    expectClean(html);
    // 1 段目は y = 178、2 段目は y = 194
    expect(html).toMatch(/<text x="[^"]+" y="178" text-anchor="middle" style="fill:var\(--color-primary\)">9\/1<\/text>/);
    expect(html).toMatch(/<text x="[^"]+" y="194" text-anchor="middle" style="fill:var\(--color-neutral\)">8\/2<\/text>/);
    // 行の名前は太字で、最初のラベル（x = 44）より左に右寄せ
    expect(html).toContain('<text x="26" y="178" text-anchor="end" font-weight="700" style="fill:var(--color-primary)">A</text>');
    expect(html).toContain('<text x="26" y="194" text-anchor="end" font-weight="700" style="fill:var(--color-neutral)">B</text>');
    // 空のラベルは出さない
    expect(html.match(/y="194" text-anchor="middle"/g)?.length).toBe(2);
  });

  it("labels2 がなければ 1 段（既存の使い方のまま）", () => {
    const html = line({ labels: ["a", "b"], series: [{ label: "s", values: [1, 2] }], height: 200 });
    expect(html).toMatch(/y="194" text-anchor="middle">a<\/text>/);
    expect(html).not.toContain('font-weight="700"');
  });
});

describe("Stacked100", () => {
  it("0 行、合計 0、null で例外を投げず NaN を出さない", () => {
    expectClean(stacked({}));
    const zero = stacked({ rows: [{ label: "今期", parts: [{ kind: "feed", value: 0 }, { kind: "reel", value: null }] }] });
    expectClean(zero);
    expect(zero).toContain("—");
    expectClean(
      stacked({
        rows: [
          { label: "今期", parts: [{ kind: "feed", value: 3 }, { kind: "carousel", value: 1 }, { kind: "reel", value: 6 }] },
        ],
      }),
    );
  });
});

describe("BandRow（件数による出し方）", () => {
  it("n = 0 は線、帯、中央値を描かない", () => {
    const html = band({ stats: { n: 0, min: null, max: null, p25: null, median: null, p75: null } });
    expectClean(html);
    expect(html).toContain('data-display="none"');
    expect(html).not.toContain('data-part="peers"');
    expect(html).toContain("比べられる投稿がありません");
  });

  it("n = 1〜2 は帯を描かず、線と中央値だけ", () => {
    for (const n of [1, 2]) {
      const html = band({ stats: { n, min: 80, max: 120, p25: 90, median: 100, p75: 110 } });
      expectClean(html);
      expect(html).toContain('data-display="range_only"');
      expect(html).not.toContain('data-part="band"');
      expect(html).toContain('data-part="median"');
    }
  });

  it("n = 3〜9 は薄く描く", () => {
    const html = band({ stats: { n: 5, min: 80, max: 120, p25: 90, median: 100, p75: 110 } });
    expectClean(html);
    expect(html).toContain('data-display="faint"');
    expect(html).toContain('opacity=".45"');
    expect(html).toContain('data-part="band"');
    expect(html).toContain("少ないので目安");
  });

  it("n = 10 以上は通常の表示", () => {
    const html = band({ stats: { n: 10, min: 80, max: 120, p25: 90, median: 100, p75: 110 } });
    expect(html).toContain('data-display="normal"');
    expect(html).not.toContain("opacity=");
  });

  it("reverse で向きを逆にする（小さい値が右）", () => {
    const stats = { n: 10, min: 0.1, max: 0.5, p25: 0.2, median: 0.3, p75: 0.4 };
    const cx = (html: string) => Number(/data-part="self" cx="([\d.]+)"/.exec(html)?.[1]);
    const normal = band({ value: 0.1, stats, format: "percent", width: 520 });
    const reversed = band({ value: 0.1, stats, format: "percent", width: 520, reverse: true });
    expectClean(reversed);
    expect(cx(normal)).toBe(10);
    expect(cx(reversed)).toBe(510);
    expect(reversed).toContain('data-reverse="true"');
    expect(normal).not.toContain("data-reverse");
    // 帯は幅が正のまま（25% が右、75% が左）
    const rect = /data-part="band" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(reversed);
    expect(Number(rect?.[2])).toBeGreaterThan(0);
    expect(Number(rect?.[1])).toBeCloseTo(10 + (500 * (0.5 - 0.4)) / 0.4, 1);
  });

  it("全部同じ値（幅 0）、自分の値が null でも NaN を出さない", () => {
    expectClean(band({ value: 5, stats: { n: 4, min: 5, max: 5, p25: 5, median: 5, p75: 5 } }));
    expectClean(band({ value: 0, stats: { n: 4, min: 0, max: 0, p25: 0, median: 0, p75: 0 } }));
    const noSelf = band({ value: null, stats: { n: 4, min: 1, max: 9, p25: 2, median: 5, p75: 7 } });
    expectClean(noSelf);
    expect(noSelf).not.toContain('data-part="self"');
  });
});

describe("Legend", () => {
  it("項目を並べる", () => {
    const html = renderToStaticMarkup(createElement(Legend, { items: [{ label: "リーチ", color: "var(--chart-1)" }, { label: "前期", shape: "dash" }] }));
    expect(html).toContain("リーチ");
    expect(html).toContain('class="dash"');
  });

  it("dash も色を受け取る（線の色）", () => {
    const html = renderToStaticMarkup(
      createElement(Legend, { items: [{ label: "B", color: "var(--color-neutral)", shape: "dash" }] }),
    );
    expect(html).toContain('class="dash" style="border-top-color:var(--color-neutral)"');
  });
});

describe("dimRuns", () => {
  it("薄い点につながる線を分け、境目の点を共有する", () => {
    const pts = [0, 1, 2, 3].map((i) => ({ i }));
    expect(dimRuns(pts, new Set([3]))).toEqual([
      { dim: false, items: [{ i: 0 }, { i: 1 }, { i: 2 }] },
      { dim: true, items: [{ i: 2 }, { i: 3 }] },
    ]);
    expect(dimRuns([{ i: 5 }], new Set([5]))).toEqual([{ dim: true, items: [{ i: 5 }] }]);
    expect(dimRuns([], new Set())).toEqual([]);
  });
});

describe("pagerItems（‹ 前へ 1 2 3 … 24 次へ ›）", () => {
  it("最初と最後、今のページと前後 1 ページを出し、2 ページ以上空くところを … にする", () => {
    expect(pagerItems(1, 24)).toEqual([1, 2, "gap", 24]);
    expect(pagerItems(2, 24)).toEqual([1, 2, 3, "gap", 24]);
    expect(pagerItems(12, 24)).toEqual([1, "gap", 11, 12, 13, "gap", 24]);
    expect(pagerItems(24, 24)).toEqual([1, "gap", 23, 24]);
    expect(pagerItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pagerItems(1, 1)).toEqual([1]);
    expect(pagerItems(99, 3)).toEqual([1, 2, 3]);
    expect(pagerItems(1, 0)).toEqual([]);
  });
});

describe("期間比較の基準値の帯（BaselineBand）", () => {
  const stat = (p: Partial<Parameters<typeof BaselineBand>[0]["stat"]>) => ({
    n: 10,
    mean: 210,
    median: 200,
    p25: 150,
    p75: 250,
    min: 100,
    max: 300,
    ...p,
  });
  const render = (p: Partial<Parameters<typeof BaselineBand>[0]>) =>
    renderToStaticMarkup(
      createElement(BaselineBand, { stat: stat({}), format: "count", color: "var(--color-primary)", lo: 100, hi: 300, ...p }),
    );

  it("3 件以上は線、帯、中央値を描き、ヒントに平均、中央値、上位 25%、下位 25%、最小〜最大", () => {
    const html = render({});
    expectClean(html);
    expect(html).toContain('data-part="range"');
    expect(html).toContain('data-part="band"');
    expect(html).toContain('data-part="median"');
    expect(html).toContain("<title>平均: 210\n中央値: 200\n上位 25%: 250\n下位 25%: 150\n最小〜最大: 100〜300</title>");
    // 薄い表示はしない（3〜9 件でも）
    expect(render({ stat: stat({ n: 5 }) })).not.toContain(" opacity=");
  });

  it("1〜2 件は中央値の縦線だけ", () => {
    const html = render({ stat: stat({ n: 2 }) });
    expectClean(html);
    expect(html).not.toContain('data-part="range"');
    expect(html).not.toContain('data-part="band"');
    expect(html).toContain('data-part="median"');
    expect(html).toContain("<title>平均: 210\n中央値: 200</title>");
  });

  it("目盛は値のある期間の最小と最大。幅 0 でも NaN を出さない", () => {
    const empty = { n: 0, mean: null, median: null, p25: null, p75: null, min: null, max: null };
    expect(bandDomain([stat({ min: 50, max: 120 }), stat({ min: 80, max: 400 })])).toEqual({ lo: 50, hi: 400 });
    expect(bandDomain([stat({ min: 50, max: 120 }), empty])).toEqual({ lo: 50, hi: 120 });
    expect(bandDomain([empty, empty])).toEqual({ lo: 0, hi: 1 });
    expectClean(render({ stat: stat({ n: 1, mean: 5, median: 5, p25: 5, p75: 5, min: 5, max: 5 }), lo: 5, hi: 5 }));
  });
});

describe("期間比較の日付の表記", () => {
  it("jpRange は年をまたぐときだけ終わりにも年", () => {
    expect(jpRange({ from: "2026-09-01", to: "2026-09-30" })).toBe("2026年9月1日 〜 9月30日");
    expect(jpRange({ from: "2025-12-25", to: "2026-01-07" })).toBe("2025年12月25日 〜 2026年1月7日");
  });

  it("monthDay は「9/1」", () => {
    expect(monthDay("2026-09-01")).toBe("9/1");
    expect(monthDay("2026-12-31")).toBe("12/31");
  });
});

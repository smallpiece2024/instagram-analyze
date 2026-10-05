import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BandRow, type BandRowProps } from "@/components/charts/BandRow";
import { LineChart, type LineChartProps } from "@/components/charts/LineChart";
import { Legend } from "@/components/charts/Legend";
import { Stacked100, type Stacked100Props } from "@/components/charts/Stacked100";
import { VBars, type VBarsProps } from "@/components/charts/VBars";
import { niceMax, segments, yDomain } from "@/components/charts/scale";

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

  it("帯は両側がある区間だけ描く", () => {
    const html = line({
      labels: ["a", "b", "c"],
      series: [{ label: "s", values: [1, 2, 3] }],
      band: { lower: [0, null, 1], upper: [2, 3, null], label: "25〜75%" },
    });
    expectClean(html);
    expect(html.match(/chart-band/g)?.length).toBe(1);
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
});

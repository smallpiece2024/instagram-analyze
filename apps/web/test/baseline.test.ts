import { describe, expect, it } from "vitest";
import { baselineDisplay, baselineNote, peerStats, percentileCont } from "@/lib/metrics";

describe("baselineDisplay（比較相手の数 n による出し方）", () => {
  it("0 / 1 / 2 / 3 / 9 / 10 の境目", () => {
    expect(baselineDisplay(0)).toBe("none");
    expect(baselineDisplay(1)).toBe("range_only");
    expect(baselineDisplay(2)).toBe("range_only");
    expect(baselineDisplay(3)).toBe("faint");
    expect(baselineDisplay(9)).toBe("faint");
    expect(baselineDisplay(10)).toBe("normal");
    expect(baselineDisplay(Number.NaN)).toBe("none");
  });

  it("注記", () => {
    expect(baselineNote(0)).toBe("比べられる投稿がありません");
    expect(baselineNote(2)).toBe("同じ種類の投稿が 2 件のため範囲を出さない");
    expect(baselineNote(7)).toBe("n = 7（少ないので目安）");
    expect(baselineNote(12)).toBe("n = 12");
  });
});

describe("peerStats", () => {
  it("自分を含めない比較相手の値で数える（呼び出し側が自分を除いた配列を渡す）", () => {
    const self = 50;
    const all = [self, 10, 20, 30];
    const peers = all.slice(1);
    expect(peerStats(peers).n).toBe(3);
    expect(baselineDisplay(peerStats(peers).n)).toBe("faint");
  });

  it("指標ごとに n が違う（null の投稿は数えない）", () => {
    const reach = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200];
    const reachRate = [0.1, null, 0.2, null, null, 0.3, null, null, 0.4, null, 0.5, null];
    expect(peerStats(reach).n).toBe(12);
    expect(peerStats(reachRate).n).toBe(5);
    expect(baselineDisplay(peerStats(reach).n)).toBe("normal");
    expect(baselineDisplay(peerStats(reachRate).n)).toBe("faint");
  });

  it("percentile_cont と同じ線形補間", () => {
    const s = peerStats([1, 2, 3, 4]);
    expect(s.median).toBe(2.5);
    expect(s.p25).toBe(1.75);
    expect(s.p75).toBe(3.25);
    expect(s.mean).toBe(2.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
    expect(percentileCont([7], 0.25)).toBe(7);
    expect(percentileCont([], 0.5)).toBeNull();
  });

  it("0 件はすべて null", () => {
    expect(peerStats([null, Number.NaN])).toEqual({ n: 0, mean: null, median: null, p25: null, p75: null, min: null, max: null });
  });
});

import { describe, expect, it } from "vitest";
import {
  EMPTY,
  elapsedDaysLabel,
  formatAxis,
  formatDateShort,
  formatJstCompactDate,
  formatJstSeconds,
  formatPercent,
  formatSeconds,
  formatSignedCount,
  formatSignedPercent,
  formatSignedPt,
  formatValue,
  lastUpdatedLabel,
} from "@/lib/format";
import {
  deltaCount,
  deltaPoint,
  deltaRate,
  isSupported,
  KIND_LABEL,
  kindColor,
  MISSING_REASON_TEXT,
  multipleOfMedian,
  NO_FOLLOWERS_AT_POST_TEXT,
  rankDescending,
  ratio,
  ratioMissing,
  ratioOfSums,
  reachRateMissing,
  valueMissing,
} from "@/lib/metrics";

describe("書式", () => {
  it("率は % の小数 1 桁。null と NaN は —", () => {
    expect(formatPercent(0.0213)).toBe("2.1%");
    expect(formatPercent(0.0213, 2)).toBe("2.13%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(null)).toBe(EMPTY);
    expect(formatPercent(Number.NaN)).toBe(EMPTY);
  });

  it("ポイント差（2.0% → 3.0% は +1.0 pt）、増減率、人数の差", () => {
    expect(formatSignedPt(0.03 - 0.02)).toBe("+1.0 pt");
    expect(formatSignedPt(-0.005)).toBe("-0.5 pt");
    expect(formatSignedPt(0.0001)).toBe("±0.0 pt");
    expect(formatSignedPercent(0.123)).toBe("+12.3%");
    expect(formatSignedPercent(-0.04)).toBe("-4.0%");
    expect(formatSignedPercent(0)).toBe("±0.0%");
    expect(formatSignedCount(1234)).toBe("+1,234");
    expect(formatSignedCount(-3)).toBe("-3");
    expect(formatSignedCount(0)).toBe("±0");
  });

  it("秒、値の種類、目盛", () => {
    expect(formatSeconds(12.34)).toBe("12.3 秒");
    expect(formatSeconds(null)).toBe(EMPTY);
    expect(formatValue(1234.4, "count")).toBe("1,234");
    expect(formatValue(null, "count")).toBe(EMPTY);
    expect(formatValue(0.05, "percent")).toBe("5.0%");
    expect(formatAxis(25000, "count")).toBe("2.5万");
    expect(formatAxis(500, "count")).toBe("500");
    expect(formatAxis(0.2, "percent")).toBe("20%");
    expect(formatAxis(0.05, "percent")).toBe("5.0%");
    expect(formatAxis(Number.NaN, "count")).toBe("");
  });

  it("日付と時刻（JST）", () => {
    expect(formatDateShort("2026-10-05")).toBe("10/5");
    expect(formatDateShort("bad")).toBe("bad");
    expect(formatJstSeconds(new Date("2026-10-04T23:30:05Z"))).toBe("2026-10-05 08:30:05");
    expect(formatJstSeconds(null)).toBe("");
    expect(formatJstCompactDate(new Date("2026-10-04T15:00:00Z"))).toBe("20261005");
    expect(lastUpdatedLabel(new Date("2026-10-04T23:30:00Z"))).toBe("最終更新 2026-10-05 08:30");
    expect(lastUpdatedLabel(null)).toBe(`最終更新 ${EMPTY}`);
    expect(elapsedDaysLabel(12 * 24 + 5)).toBe("投稿から 12 日");
    expect(elapsedDaysLabel(23)).toBe("投稿から 0 日");
    expect(elapsedDaysLabel(null)).toBe(EMPTY);
  });
});

describe("種類", () => {
  it("表記と系列の色", () => {
    expect(KIND_LABEL.carousel).toBe("カルーセル");
    expect(kindColor("feed")).toBe("var(--chart-1)");
    expect(kindColor("story")).toBe("var(--chart-4)");
  });
});

describe("ratio", () => {
  it("分母が 0 か null、分子が null なら null（0% にしない）", () => {
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(5, null)).toBeNull();
    expect(ratio(null, 10)).toBeNull();
    expect(ratio(0, 10)).toBe(0);
    expect(ratio(3, 4)).toBe(0.75);
  });
});

describe("「—」の理由", () => {
  it("unsupported: リールのプロフィール訪問とフォロー、フィードとカルーセルの視聴系、視聴維持率はリール以外（R4）", () => {
    expect(valueMissing("profile_visits", "reel", null)?.reason).toBe("unsupported");
    expect(valueMissing("follows", "reel", 3)?.reason).toBe("unsupported");
    expect(ratioMissing("follow_conversion_rate", "reel", 1, 2)?.reason).toBe("unsupported");
    expect(valueMissing("avg_watch_time_ms", "feed", null)?.reason).toBe("unsupported");
    expect(valueMissing("skip_rate", "carousel", null)?.reason).toBe("unsupported");
    expect(isSupported("retention_rate", "reel")).toBe(true);
    expect(isSupported("retention_rate", "feed")).toBe(false);
    expect(valueMissing("profile_visits", "carousel", 1)).toBeNull();
    expect(valueMissing("skip_rate", "reel", 0.3)).toBeNull();
    expect(MISSING_REASON_TEXT.unsupported).toBe("この種類では API で取れない");
  });

  it("missing: 取れるはずの値が null", () => {
    const m = valueMissing("profile_visits", "feed", null);
    expect(m).toEqual({ reason: "missing", text: "取得できなかった" });
    expect(ratioMissing("er", "feed", null, 100)?.reason).toBe("missing");
    expect(ratioMissing("er", "feed", 10, null)?.reason).toBe("missing");
  });

  it("no_baseline_data: 分母が 0", () => {
    expect(ratioMissing("save_rate", "reel", 0, 0)?.reason).toBe("no_baseline_data");
    expect(ratioMissing("save_rate", "reel", 3, 100)).toBeNull();
  });

  it("unsupported は分母 0 より先に判定する", () => {
    expect(ratioMissing("profile_visit_rate", "reel", 0, 0)?.reason).toBe("unsupported");
  });

  it("リーチ率: 7 日未満は not_yet（文言なし）", () => {
    const m = reachRateMissing({ kind: "feed", elapsedLatestHours: 7 * 24 - 1, reach7d: null, followersAtPost: null });
    expect(m).toEqual({ reason: "not_yet", text: null });
    expect(reachRateMissing({ kind: "feed", elapsedLatestHours: null, reach7d: null, followersAtPost: 100 })?.reason).toBe(
      "not_yet",
    );
  });

  it("リーチ率: 7 日以上で投稿時のフォロワー数がない、0、7 日時点が許容外なら no_baseline_data", () => {
    expect(reachRateMissing({ kind: "feed", elapsedLatestHours: 7 * 24, reach7d: 100, followersAtPost: null })).toEqual({
      reason: "no_baseline_data",
      text: NO_FOLLOWERS_AT_POST_TEXT,
    });
    expect(reachRateMissing({ kind: "reel", elapsedLatestHours: 300, reach7d: 100, followersAtPost: 0 })?.reason).toBe(
      "no_baseline_data",
    );
    expect(reachRateMissing({ kind: "carousel", elapsedLatestHours: 4800, reach7d: null, followersAtPost: 500 })).toEqual({
      reason: "no_baseline_data",
      text: "計算に要る記録がない",
    });
    expect(reachRateMissing({ kind: "feed", elapsedLatestHours: 200, reach7d: 120, followersAtPost: 500 })).toBeNull();
  });
});

describe("ratioOfSums", () => {
  it("分子か分母が null の投稿を除き、n 件中 m 件の m が合う", () => {
    const r = ratioOfSums([
      { numerator: 10, denominator: 100 },
      { numerator: null, denominator: 100 },
      { numerator: 5, denominator: null },
      { numerator: 20, denominator: 300 },
    ]);
    expect(r.used).toBe(2);
    expect(r.total).toBe(4);
    expect(r.value).toBeCloseTo(30 / 400);
  });

  it("m = 0 と分母の合計 0 は null（—）", () => {
    expect(ratioOfSums([{ numerator: null, denominator: 1 }]).value).toBeNull();
    expect(ratioOfSums([]).value).toBeNull();
    expect(ratioOfSums([{ numerator: 0, denominator: 0 }])).toEqual({ value: null, used: 1, total: 1 });
  });
});

describe("multipleOfMedian", () => {
  it("中央値 0 と null は null（—）", () => {
    expect(multipleOfMedian(10, 0)).toBeNull();
    expect(multipleOfMedian(10, null)).toBeNull();
    expect(multipleOfMedian(null, 5)).toBeNull();
    expect(multipleOfMedian(10, 5)).toBe(2);
  });
});

describe("rankDescending", () => {
  it("同じ値は同じ順位（1, 2, 2, 4）", () => {
    const values = [30, 20, 20, 10, null];
    expect(rankDescending(30, values)).toEqual({ rank: 1, of: 4 });
    expect(rankDescending(20, values)).toEqual({ rank: 2, of: 4 });
    expect(rankDescending(10, values)).toEqual({ rank: 4, of: 4 });
  });

  it("比べる値が 1 件（m = 1）と値が null は null（—）", () => {
    expect(rankDescending(5, [5, null])).toBeNull();
    expect(rankDescending(null, [1, 2, 3])).toBeNull();
  });
});

describe("前期間比", () => {
  it("件数は増減率。前期 0 と null は prev_zero、今期 null は出さない", () => {
    const up = deltaRate(120, 100);
    expect(up).toMatchObject({ kind: "rate", dir: "up" });
    expect(up?.kind === "rate" ? up.value : Number.NaN).toBeCloseTo(0.2);
    expect(deltaRate(80, 100)).toMatchObject({ kind: "rate", dir: "down" });
    expect(deltaRate(100, 100)).toMatchObject({ dir: "flat" });
    expect(deltaRate(5, 0)).toEqual({ kind: "prev_zero" });
    expect(deltaRate(5, null)).toEqual({ kind: "prev_zero" });
    expect(deltaRate(null, 5)).toBeNull();
  });

  it("率はポイント差（2.0% → 3.0% は +1.0 pt）", () => {
    const d = deltaPoint(0.03, 0.02);
    expect(d?.kind).toBe("pt");
    expect(d && d.kind === "pt" && formatSignedPt(d.value)).toBe("+1.0 pt");
    expect(deltaPoint(null, 0.02)).toBeNull();
    expect(deltaPoint(0.02, 0.02)).toMatchObject({ dir: "flat" });
  });

  it("人数は差", () => {
    expect(deltaCount(105, 100)).toEqual({ kind: "count", value: 5, dir: "up" });
    expect(deltaCount(100, null)).toBeNull();
  });
});

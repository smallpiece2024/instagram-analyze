/**
 * 「AI・OCR の利用状況」の計算（`lib/ocr-usage.ts`。R4.1 設計 6.4 節、8 章「画面」）の単体テスト
 */
import { describe, expect, it } from "vitest";
import {
  currentMonthUsage,
  estimatedCostUsd,
  fillMonths,
  formatUsd,
  FREE_UNITS_WARN_BELOW,
  monthKeyUtc,
  recentMonthKeys,
  remainingFreeUnits,
  USAGE_MONTHS,
  VISION_FREE_UNITS_PER_MONTH,
  VISION_USD_PER_1000_UNITS,
  type OcrMonthRow,
} from "@/lib/ocr-usage";

function row(month: string, units: number, over: Partial<OcrMonthRow> = {}): OcrMonthRow {
  return { month, requests: 1, failed_requests: 0, images: units, units, videos: 1, ...over };
}

describe("定数", () => {
  it("無料枠 1,000 ユニット、$1.50 / 1,000 ユニット、12 か月、注意は 100 未満", () => {
    expect(VISION_FREE_UNITS_PER_MONTH).toBe(1000);
    expect(VISION_USD_PER_1000_UNITS).toBe(1.5);
    expect(USAGE_MONTHS).toBe(12);
    expect(FREE_UNITS_WARN_BELOW).toBe(100);
  });
});

describe("remainingFreeUnits と estimatedCostUsd", () => {
  it("残りは 1,000 − ユニットで 0 を下回らない", () => {
    expect(remainingFreeUnits(0)).toBe(1000);
    expect(remainingFreeUnits(901)).toBe(99);
    expect(remainingFreeUnits(1000)).toBe(0);
    expect(remainingFreeUnits(1500)).toBe(0);
    expect(remainingFreeUnits(-5)).toBe(1000);
  });

  it("推定費用 = max(units − 1,000, 0) ÷ 1,000 × $1.50。無料枠の中は $0.00", () => {
    expect(estimatedCostUsd(0)).toBe(0);
    expect(estimatedCostUsd(1000)).toBe(0);
    expect(estimatedCostUsd(1001)).toBeCloseTo(0.0015, 10);
    expect(estimatedCostUsd(2000)).toBeCloseTo(1.5, 10);
    expect(estimatedCostUsd(3500)).toBeCloseTo(3.75, 10);
    expect(formatUsd(estimatedCostUsd(0))).toBe("$0.00");
    expect(formatUsd(estimatedCostUsd(2000))).toBe("$1.50");
    expect(formatUsd(estimatedCostUsd(1001))).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("月（UTC）の補い", () => {
  const now = new Date("2026-10-11T03:00:00Z");

  it("monthKeyUtc は UTC の月。月末の JST と UTC のずれ", () => {
    expect(monthKeyUtc(now)).toBe("2026-10");
    // 2026-10-31 23:00 UTC は JST では 11 月 1 日だが UTC の 10 月
    expect(monthKeyUtc(new Date("2026-10-31T23:00:00Z"))).toBe("2026-10");
    expect(monthKeyUtc(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
  });

  it("recentMonthKeys は今月から新しい順に 12 か月（年をまたぐ）", () => {
    const keys = recentMonthKeys(now);
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe("2026-10");
    expect(keys[11]).toBe("2025-11");
    expect(recentMonthKeys(new Date("2026-01-15T00:00:00Z"), 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
  });

  it("fillMonths: 欠けた月は 0 の行、範囲外の行は捨てる、新しい順", () => {
    const rows = [row("2026-10", 120), row("2026-07", 800, { failed_requests: 2 }), row("2025-01", 999)];
    const out = fillMonths(rows, now);
    expect(out).toHaveLength(12);
    expect(out.map((r) => r.month)).toEqual(recentMonthKeys(now));
    expect(out[0]).toEqual(row("2026-10", 120));
    expect(out[3]).toEqual(row("2026-07", 800, { failed_requests: 2 }));
    expect(out[1]).toEqual({ month: "2026-09", requests: 0, failed_requests: 0, images: 0, units: 0, videos: 0 });
    expect(out.some((r) => r.month === "2025-01")).toBe(false);
    expect(fillMonths([], now).every((r) => r.units === 0)).toBe(true);
  });

  it("currentMonthUsage: 今月の行がなければ 0 の行", () => {
    expect(currentMonthUsage([row("2026-10", 5)], now).units).toBe(5);
    const empty = currentMonthUsage([row("2026-09", 5)], now);
    expect(empty).toEqual({ month: "2026-10", requests: 0, failed_requests: 0, images: 0, units: 0, videos: 0 });
    expect(remainingFreeUnits(empty.units)).toBe(1000);
  });
});

/**
 * 「上限」の計算（`lib/capacity.ts`。課題 ia-6ui）の単体テスト
 */
import { describe, expect, it } from "vitest";
import {
  capacityGrowth,
  DAILY_DAYS,
  dailyLimits,
  DB_LIMIT_BYTES,
  formatBytes,
  formatSignedBytes,
  GROWTH_DAYS,
  isOverWarnRatio,
  jstDateKey,
  median,
  recentJstDateKeys,
  RUN_DURATION_WARN_SECONDS,
  slowDays,
  STORAGE_LIMIT_BYTES,
  usageRatio,
  WARN_RATIO,
  type CapacityDailyRow,
  type RateUsageRow,
  type RunDurationRow,
} from "@/lib/capacity";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

function cap(captured_on: string, dbMb: number, storageMb = 1): CapacityDailyRow {
  return { captured_on, db_bytes: dbMb * MB, storage_bytes: storageMb * MB, storage_objects: 10 };
}

function run(iso: string, duration_seconds: number): RunDurationRow {
  return { began_at: new Date(iso), duration_seconds };
}

function rate(iso: string, call_count: number, total_cputime = 0, total_time = 0): RateUsageRow {
  return { started_at: new Date(iso), rate_usage: { call_count, total_cputime, total_time } };
}

describe("定数", () => {
  it("DB 8 GB、Storage 100 GB、8 割、15 分、30 日、14 日", () => {
    expect(DB_LIMIT_BYTES).toBe(8 * GB);
    expect(STORAGE_LIMIT_BYTES).toBe(100 * GB);
    expect(WARN_RATIO).toBe(0.8);
    expect(RUN_DURATION_WARN_SECONDS).toBe(900);
    expect(GROWTH_DAYS).toBe(30);
    expect(DAILY_DAYS).toBe(14);
  });
});

describe("usageRatio と isOverWarnRatio", () => {
  it("使用率 = 値 ÷ 上限。負や不正な値は 0", () => {
    expect(usageRatio(2 * GB, DB_LIMIT_BYTES)).toBe(0.25);
    expect(usageRatio(0, DB_LIMIT_BYTES)).toBe(0);
    expect(usageRatio(-1, DB_LIMIT_BYTES)).toBe(0);
    expect(usageRatio(Number.NaN, DB_LIMIT_BYTES)).toBe(0);
    expect(usageRatio(1, 0)).toBe(0);
    expect(usageRatio(16 * GB, DB_LIMIT_BYTES)).toBe(2);
  });

  it("8 割ちょうどから警告", () => {
    expect(isOverWarnRatio(DB_LIMIT_BYTES * 0.8, DB_LIMIT_BYTES)).toBe(true);
    expect(isOverWarnRatio(DB_LIMIT_BYTES * 0.8 - 1, DB_LIMIT_BYTES)).toBe(false);
    expect(isOverWarnRatio(52 * MB, DB_LIMIT_BYTES)).toBe(false);
  });
});

describe("formatBytes と formatSignedBytes", () => {
  it("1 GB 未満は MB（小数 1 桁）、以上は GB（小数 2 桁）", () => {
    expect(formatBytes(0)).toBe("0.0 MB");
    expect(formatBytes(1.7 * MB)).toBe("1.7 MB");
    expect(formatBytes(52 * MB)).toBe("52.0 MB");
    expect(formatBytes(GB - 1)).toBe("1024.0 MB");
    expect(formatBytes(GB)).toBe("1.00 GB");
    expect(formatBytes(DB_LIMIT_BYTES)).toBe("8.00 GB");
    expect(formatBytes(STORAGE_LIMIT_BYTES)).toBe("100.00 GB");
    expect(formatBytes(Number.NaN)).toBe("0.0 MB");
    expect(formatBytes(-5)).toBe("0.0 MB");
  });

  it("差は符号つき。0 は ±", () => {
    expect(formatSignedBytes(3.2 * MB)).toBe("+3.2 MB");
    expect(formatSignedBytes(-1 * MB)).toBe("-1.0 MB");
    expect(formatSignedBytes(0)).toBe("±0.0 MB");
    expect(formatSignedBytes(100)).toBe("±0.0 MB");
    expect(formatSignedBytes(2 * GB)).toBe("+2.00 GB");
  });
});

describe("capacityGrowth", () => {
  it("行がなければ null", () => {
    expect(capacityGrowth([])).toBeNull();
  });

  it("行が 1 つだけなら相手は null", () => {
    const g = capacityGrowth([cap("2026-11-21", 52)]);
    expect(g?.latest.captured_on).toBe("2026-11-21");
    expect(g?.base).toBeNull();
    expect(g?.days).toBeNull();
    expect(g?.dbDiff).toBeNull();
    expect(g?.storageDiff).toBeNull();
  });

  it("30 日前以前でいちばん新しい行と比べる（順不同の入力でもよい）", () => {
    const rows = [
      cap("2026-10-10", 30, 1),
      cap("2026-11-21", 52, 5),
      cap("2026-10-22", 40, 2),
      cap("2026-10-21", 38, 2),
      cap("2026-11-20", 51, 4),
    ];
    const g = capacityGrowth(rows);
    expect(g?.latest.captured_on).toBe("2026-11-21");
    // 2026-10-22 はちょうど 30 日前
    expect(g?.base?.captured_on).toBe("2026-10-22");
    expect(g?.days).toBe(30);
    expect(g?.dbDiff).toBe(12 * MB);
    expect(g?.storageDiff).toBe(3 * MB);
  });

  it("30 日前の行が欠けていれば、それより前でいちばん新しい行", () => {
    const g = capacityGrowth([cap("2026-11-21", 52), cap("2026-10-25", 41), cap("2026-10-15", 35), cap("2026-10-01", 20)]);
    expect(g?.base?.captured_on).toBe("2026-10-15");
    expect(g?.days).toBe(37);
  });

  it("30 日前以前の行がなければいちばん古い行。日数は実際の日数", () => {
    const g = capacityGrowth([cap("2026-11-21", 52), cap("2026-11-20", 51), cap("2026-11-18", 50)]);
    expect(g?.base?.captured_on).toBe("2026-11-18");
    expect(g?.days).toBe(3);
    expect(g?.dbDiff).toBe(2 * MB);
  });
});

describe("median", () => {
  it("奇数個は中央、偶数個は中の 2 つの平均、空は null", () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
    expect(median([12, 182])).toBe(97);
  });

  it("入力を並べ替えない", () => {
    const v = [3, 1, 2];
    median(v);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe("JST の日付", () => {
  it("jstDateKey は JST の日付（UTC 15 時で日が変わる）", () => {
    expect(jstDateKey(new Date("2026-11-20T14:59:59Z"))).toBe("2026-11-20");
    expect(jstDateKey(new Date("2026-11-20T15:00:00Z"))).toBe("2026-11-21");
  });

  it("recentJstDateKeys は今日から新しい順に 14 日（月をまたぐ）", () => {
    const keys = recentJstDateKeys(new Date("2026-11-05T03:00:00Z"));
    expect(keys).toHaveLength(14);
    expect(keys[0]).toBe("2026-11-05");
    expect(keys[5]).toBe("2026-10-31");
    expect(keys[13]).toBe("2026-10-23");
  });
});

describe("dailyLimits と slowDays", () => {
  const now = new Date("2026-11-21T03:00:00Z");

  it("空の入力でも 14 日分の行を出す", () => {
    const out = dailyLimits([], [], now);
    expect(out).toHaveLength(14);
    expect(out[0]).toEqual({ date: "2026-11-21", runs: 0, maxSeconds: null, medianSeconds: null, maxUsage: null });
    expect(slowDays(out)).toEqual([]);
  });

  it("日（JST）ごとに回数、所要の最大と中央値、使用率の最大。範囲外は捨てる", () => {
    const runs = [
      run("2026-11-20T15:17:00Z", 12), // JST 11-21
      run("2026-11-20T16:17:00Z", 182), // JST 11-21
      run("2026-11-20T14:17:00Z", 20), // JST 11-20
      run("2026-11-19T20:17:00Z", 901), // JST 11-20
      run("2026-11-19T21:17:00Z", 10), // JST 11-20
      run("2026-10-01T00:00:00Z", 5000), // 範囲外
    ];
    const rates = [
      rate("2026-11-20T15:17:05Z", 3, 12, 7), // JST 11-21 → 12
      rate("2026-11-20T16:17:05Z", 9), // JST 11-21 → 9
      rate("2026-11-20T14:17:05Z", 4), // JST 11-20
      rate("2026-10-01T00:00:00Z", 99), // 範囲外
    ];
    const out = dailyLimits(runs, rates, now);
    expect(out).toHaveLength(14);
    expect(out[0]).toEqual({ date: "2026-11-21", runs: 2, maxSeconds: 182, medianSeconds: 97, maxUsage: 12 });
    expect(out[1]).toEqual({ date: "2026-11-20", runs: 3, maxSeconds: 901, medianSeconds: 20, maxUsage: 4 });
    expect(out[2]).toEqual({ date: "2026-11-19", runs: 0, maxSeconds: null, medianSeconds: null, maxUsage: null });
    expect(slowDays(out).map((d) => d.date)).toEqual(["2026-11-20"]);
  });

  it("所要が 15 分ちょうどは警告にしない", () => {
    const out = dailyLimits([run("2026-11-21T00:00:00Z", 900)], [], now);
    expect(slowDays(out)).toEqual([]);
  });
});

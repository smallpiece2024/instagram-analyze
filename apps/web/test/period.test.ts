import { describe, expect, it } from "vitest";
import {
  addDays,
  clampPeriod,
  diffDays,
  eachDay,
  isStale,
  isValidYmd,
  lastNDays,
  monthOf,
  periodLength,
  presetPeriods,
  previousMonth,
  previousPeriod,
  sameMonthLastYear,
  todayPacific,
} from "@/lib/period";

describe("日付の計算", () => {
  it("暦として正しい日だけ", () => {
    expect(isValidYmd("2026-02-28")).toBe(true);
    expect(isValidYmd("2024-02-29")).toBe(true);
    expect(isValidYmd("2025-02-29")).toBe(false);
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("2026-13-01")).toBe(false);
    expect(isValidYmd("2026-1-01")).toBe(false);
  });

  it("月末、年末、うるう年をまたいで足し引きする", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-10-05", -365)).toBe("2025-10-05");
    expect(diffDays("2026-01-01", "2026-12-31")).toBe(364);
  });

  it("不正な日付は例外", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
  });
});

describe("期間", () => {
  it("前 7 日、前 30 日", () => {
    const a7 = lastNDays("2026-10-04", 7);
    expect(a7).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(previousPeriod(a7)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    const a30 = lastNDays("2026-03-01", 30);
    expect(a30).toEqual({ from: "2026-01-31", to: "2026-03-01" });
    expect(periodLength(previousPeriod(a30))).toBe(30);
    expect(previousPeriod(a30)).toEqual({ from: "2026-01-01", to: "2026-01-30" });
  });

  it("同じ日の 1 日の期間", () => {
    const p = lastNDays("2026-10-04", 1);
    expect(p).toEqual({ from: "2026-10-04", to: "2026-10-04" });
    expect(periodLength(p)).toBe(1);
    expect(previousPeriod(p)).toEqual({ from: "2026-10-03", to: "2026-10-03" });
    expect(eachDay(p)).toEqual(["2026-10-04"]);
  });

  it("前月（月末が 28／29／30／31 日）", () => {
    expect(previousMonth("2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousMonth("2024-03-31")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(previousMonth("2026-10-01")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(previousMonth("2026-09-30")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(previousMonth("2026-01-10")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("前年同月（うるう年の 2 月の前年は 28 日まで）", () => {
    expect(sameMonthLastYear("2024-02-29")).toEqual({ from: "2023-02-01", to: "2023-02-28" });
    expect(periodLength(monthOf("2024-02-10"))).toBe(29);
    expect(sameMonthLastYear("2025-02-10")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(sameMonthLastYear("2026-10-04")).toEqual({ from: "2025-10-01", to: "2025-10-31" });
  });

  it("プリセット 7d／30d: 最新の日までの N 日と、その直前の N 日", () => {
    expect(presetPeriods("7d", "2026-10-04")).toEqual({
      a: { from: "2026-09-28", to: "2026-10-04" },
      b: { from: "2026-09-21", to: "2026-09-27" },
    });
    expect(presetPeriods("30d", "2026-10-04")).toEqual({
      a: { from: "2026-09-05", to: "2026-10-04" },
      b: { from: "2026-08-06", to: "2026-09-04" },
    });
  });

  it("プリセット month: 最新の日を含む月の前の月と、その前の月（どちらも暦月の 1 日〜末日）", () => {
    expect(presetPeriods("month", "2026-10-04")).toEqual({
      a: { from: "2026-09-01", to: "2026-09-30" },
      b: { from: "2026-08-01", to: "2026-08-31" },
    });
    // 最新の日が月末でも、その月ではなく前の月
    expect(presetPeriods("month", "2026-09-30")).toEqual({
      a: { from: "2026-08-01", to: "2026-08-31" },
      b: { from: "2026-07-01", to: "2026-07-31" },
    });
    // 年をまたぐ
    expect(presetPeriods("month", "2026-02-10")).toEqual({
      a: { from: "2026-01-01", to: "2026-01-31" },
      b: { from: "2025-12-01", to: "2025-12-31" },
    });
  });

  it("プリセット yoy: 最新の日を含む月の前の月と、その 1 年前の同じ月", () => {
    expect(presetPeriods("yoy", "2026-10-04")).toEqual({
      a: { from: "2026-09-01", to: "2026-09-30" },
      b: { from: "2025-09-01", to: "2025-09-30" },
    });
    // 前の月がうるう年の 2 月なら、前年同月は 28 日まで（日数が違う）
    const leap = presetPeriods("yoy", "2024-03-10");
    expect(leap).toEqual({
      a: { from: "2024-02-01", to: "2024-02-29" },
      b: { from: "2023-02-01", to: "2023-02-28" },
    });
    expect(periodLength(leap.a)).toBe(29);
    expect(periodLength(leap.b)).toBe(28);
    // 最新の日が 1 月なら、前の月は前年の 12 月
    expect(presetPeriods("yoy", "2027-01-05")).toEqual({
      a: { from: "2026-12-01", to: "2026-12-31" },
      b: { from: "2025-12-01", to: "2025-12-31" },
    });
  });

  it("最新の日より後を切り詰める", () => {
    expect(clampPeriod({ from: "2026-10-01", to: "2026-10-31" }, "2025-08-20", "2026-10-04")).toEqual({
      period: { from: "2026-10-01", to: "2026-10-04" },
      truncated: true,
    });
    expect(clampPeriod({ from: "2026-09-01", to: "2026-09-30" }, "2025-08-20", "2026-10-04")).toEqual({
      period: { from: "2026-09-01", to: "2026-09-30" },
      truncated: false,
    });
  });

  it("データの始まりより前を切り詰め、全部が外なら null", () => {
    expect(clampPeriod({ from: "2025-08-01", to: "2025-08-31" }, "2025-08-20", "2026-10-04")).toEqual({
      period: { from: "2025-08-20", to: "2025-08-31" },
      truncated: true,
    });
    expect(clampPeriod({ from: "2025-07-01", to: "2025-07-31" }, "2025-08-20", "2026-10-04")).toBeNull();
    expect(clampPeriod({ from: "2026-11-01", to: "2026-11-30" }, null, "2026-10-04")).toBeNull();
  });
});

describe("太平洋時間の今日と古いデータ", () => {
  it("太平洋時間の日付を取る（夏時間 UTC-7、冬時間 UTC-8）", () => {
    expect(todayPacific(new Date("2026-10-05T06:59:00Z"))).toBe("2026-10-04");
    expect(todayPacific(new Date("2026-10-05T07:00:00Z"))).toBe("2026-10-05");
    expect(todayPacific(new Date("2026-12-05T07:59:00Z"))).toBe("2026-12-04");
    expect(todayPacific(new Date("2026-12-05T08:00:00Z"))).toBe("2026-12-05");
  });

  it("今日から 3 日より前なら古い", () => {
    expect(isStale("2026-10-01", "2026-10-04")).toBe(false);
    expect(isStale("2026-09-30", "2026-10-04")).toBe(true);
    expect(isStale(null, "2026-10-04")).toBe(false);
  });
});

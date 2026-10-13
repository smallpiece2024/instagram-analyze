/**
 * レポートの月（`lib/report-month.ts`）の単体テスト（R6 設計 7.1 節「画面（単体）」、T14、T20、Q14）。
 * `?month=` の検査、既定の月、選べる月の列挙。DB は読まない
 */
import { describe, expect, it } from "vitest";
import { clampPeriod } from "../src/lib/period";
import {
  defaultReportMonth,
  parseReportMonth,
  REPORT_MONTH_PATTERN,
  reportMonthPeriod,
  resolveReportMonth,
  selectableReportMonths,
  yearMonthOf,
} from "../src/lib/report-month";

const RANGE = { start: "2026-03-15", latest: "2026-10-11" };
const SELECTABLE = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];

describe("選べる月の列挙（selectableReportMonths）", () => {
  it("データの始まりの月から latest を含む月まで、古い順。今月（途中）を含める", () => {
    expect(selectableReportMonths(RANGE)).toEqual(SELECTABLE);
  });

  it("同じ月なら 1 つ", () => {
    expect(selectableReportMonths({ start: "2026-10-01", latest: "2026-10-11" })).toEqual(["2026-10"]);
  });

  it("年をまたぐ", () => {
    expect(selectableReportMonths({ start: "2025-11-20", latest: "2026-02-03" })).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("getDailyRange が null なら空", () => {
    expect(selectableReportMonths(null)).toEqual([]);
  });

  it("latest が start より前の月、日付の形が不正なら空（例外を投げない）", () => {
    expect(selectableReportMonths({ start: "2026-10-01", latest: "2026-09-30" })).toEqual([]);
    expect(selectableReportMonths({ start: "2026-13-01", latest: "2026-10-11" })).toEqual([]);
    expect(selectableReportMonths({ start: "", latest: "2026-10-11" })).toEqual([]);
  });
});

describe("既定の月（defaultReportMonth。T20）", () => {
  it("latest が 10 月 11 日なら 9 月", () => {
    expect(defaultReportMonth({ start: "2026-01-01", latest: "2026-10-11" })).toBe("2026-09");
  });

  it("latest が 1 月なら前年 12 月", () => {
    expect(defaultReportMonth({ start: "2025-01-01", latest: "2026-01-15" })).toBe("2025-12");
  });

  it("月初 1 日で latest がまだ前月なら前々月（latest の定義どおり。直さない）", () => {
    // 日本時間の 10 月 1 日。日次指標の最新の日は太平洋時間で 9 月 30 日
    expect(defaultReportMonth({ start: "2026-01-01", latest: "2026-09-30" })).toBe("2026-08");
  });

  it("前月がデータの始まりより前（データが今月から始まった）なら、選べる最初の月", () => {
    expect(defaultReportMonth({ start: "2026-10-05", latest: "2026-10-11" })).toBe("2026-10");
    // 既定はつねに選べる月に含まれる
    const range = { start: "2026-10-05", latest: "2026-10-11" };
    expect(selectableReportMonths(range)).toContain(defaultReportMonth(range));
  });

  it("既定は presetPeriods(\"month\", latest).a と同じ月（データが十分にあるとき）", () => {
    expect(defaultReportMonth(RANGE)).toBe("2026-09");
    expect(reportMonthPeriod(defaultReportMonth(RANGE))).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });
});

describe("?month= の検査（parseReportMonth。T14、S6）", () => {
  it("形は YYYY-MM で、月は 01〜12 だけ", () => {
    expect(REPORT_MONTH_PATTERN.test("2026-09")).toBe(true);
    expect(REPORT_MONTH_PATTERN.test("2026-13")).toBe(false);
    expect(REPORT_MONTH_PATTERN.test("2026-1")).toBe(false);
    expect(REPORT_MONTH_PATTERN.test("2026-00")).toBe(false);
    expect(REPORT_MONTH_PATTERN.test("2026-09-01")).toBe(false);
    expect(REPORT_MONTH_PATTERN.test(" 2026-09")).toBe(false);
  });

  it("選べる月に含まれる文字列 1 つなら返す", () => {
    expect(parseReportMonth("2026-09", SELECTABLE)).toBe("2026-09");
    expect(parseReportMonth("2026-03", SELECTABLE)).toBe("2026-03");
    expect(parseReportMonth("2026-10", SELECTABLE)).toBe("2026-10");
  });

  it("string[]（同じ名前が 2 つ）、undefined、文字列でない値は不正", () => {
    expect(parseReportMonth(["2026-09", "2026-08"], SELECTABLE)).toBeUndefined();
    expect(parseReportMonth(["2026-09"], SELECTABLE)).toBeUndefined();
    expect(parseReportMonth(undefined, SELECTABLE)).toBeUndefined();
    expect(parseReportMonth(null, SELECTABLE)).toBeUndefined();
    expect(parseReportMonth(202609, SELECTABLE)).toBeUndefined();
  });

  it("2026-13、2026-1、空、日付つきは不正", () => {
    expect(parseReportMonth("2026-13", SELECTABLE)).toBeUndefined();
    expect(parseReportMonth("2026-1", SELECTABLE)).toBeUndefined();
    expect(parseReportMonth("", SELECTABLE)).toBeUndefined();
    expect(parseReportMonth("2026-09-01", SELECTABLE)).toBeUndefined();
  });

  it("未来、データの前（範囲の外）は不正", () => {
    expect(parseReportMonth("2026-11", SELECTABLE)).toBeUndefined();
    expect(parseReportMonth("2027-01", SELECTABLE)).toBeUndefined();
    expect(parseReportMonth("2026-02", SELECTABLE)).toBeUndefined();
    expect(parseReportMonth("2025-12", SELECTABLE)).toBeUndefined();
  });

  it("0000-01 で例外を投げず不正（範囲の検査を monthOf より先にする。T14）", () => {
    expect(() => parseReportMonth("0000-01", SELECTABLE)).not.toThrow();
    expect(parseReportMonth("0000-01", SELECTABLE)).toBeUndefined();
    expect(() => resolveReportMonth("0000-01", RANGE)).not.toThrow();
  });

  it("選べる月が空なら何も通らない（Action は拒む）", () => {
    expect(parseReportMonth("2026-09", [])).toBeUndefined();
  });
});

describe("ページの月の決定（resolveReportMonth）", () => {
  it("正しい月はその暦月。隠し項目に入れる month と期間がそろう", () => {
    expect(resolveReportMonth("2026-07", RANGE)).toEqual({
      month: "2026-07",
      period: { from: "2026-07-01", to: "2026-07-31" },
      selectable: SELECTABLE,
      fellBack: false,
    });
  });

  it("値がなければ既定（fellBack は false）", () => {
    const r = resolveReportMonth(undefined, RANGE);
    expect(r?.month).toBe("2026-09");
    expect(r?.period).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(r?.fellBack).toBe(false);
  });

  it("不正、範囲の外、string[] は既定に戻す（fellBack は true）", () => {
    for (const v of ["2026-13", "2026-1", "2026-11", "2026-02", "0000-01", ["2026-09", "2026-08"], 7]) {
      const r = resolveReportMonth(v, RANGE);
      expect(r?.month, String(v)).toBe("2026-09");
      expect(r?.fellBack, String(v)).toBe(true);
    }
  });

  it("今月（途中）を選べる。期間は暦月のまま（切り詰めは呼ぶ側の clampPeriod）", () => {
    expect(resolveReportMonth("2026-10", RANGE)?.period).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("日次指標がなければ null", () => {
    expect(resolveReportMonth("2026-09", null)).toBeNull();
    expect(resolveReportMonth(undefined, null)).toBeNull();
  });

  it("うるう年の 2 月は 29 日まで", () => {
    expect(reportMonthPeriod("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(yearMonthOf("2028-02-29")).toBe("2028-02");
  });
});

describe("方針の回帰: 今月を選んでも to の切り詰め以外は同じ（clampPeriod。R6 設計 7.1 節）", () => {
  it("今月は to だけ latest に切り詰め、from は暦月の初日のまま。前月とデータの始まりの月は切り詰めない", () => {
    const current = resolveReportMonth("2026-10", RANGE);
    if (!current) throw new Error("今月が解決できない");
    expect(current.period).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    // ページと同じ呼び方（dataStart は渡さない。from は切り詰めない）
    expect(clampPeriod(current.period, null, RANGE.latest)).toEqual({ period: { from: "2026-10-01", to: "2026-10-11" }, truncated: true });

    const prev = resolveReportMonth("2026-09", RANGE);
    if (!prev) throw new Error("前月が解決できない");
    expect(clampPeriod(prev.period, null, RANGE.latest)).toEqual({ period: { from: "2026-09-01", to: "2026-09-30" }, truncated: false });

    // データの始まりが 3 月 15 日でも、3 月は 1 日から（月の構成を変えない）
    const first = resolveReportMonth("2026-03", RANGE);
    if (!first) throw new Error("最初の月が解決できない");
    expect(clampPeriod(first.period, null, RANGE.latest)).toEqual({ period: { from: "2026-03-01", to: "2026-03-31" }, truncated: false });
  });

  it("latest が月初 1 日の今月は 1 日だけの期間になり、null（空の期間）にはならない", () => {
    expect(clampPeriod({ from: "2026-10-01", to: "2026-10-31" }, null, "2026-10-01")).toEqual({
      period: { from: "2026-10-01", to: "2026-10-01" },
      truncated: true,
    });
  });

  it("選べる月の数と既定の月は、今月を選んでも変わらない（resolveReportMonth の selectable）", () => {
    const current = resolveReportMonth("2026-10", RANGE);
    const prev = resolveReportMonth("2026-09", RANGE);
    const none = resolveReportMonth(undefined, RANGE);
    expect(current?.selectable).toEqual(SELECTABLE);
    expect(prev?.selectable).toEqual(SELECTABLE);
    expect(none?.selectable).toEqual(SELECTABLE);
    expect(current?.fellBack).toBe(false);
  });
});

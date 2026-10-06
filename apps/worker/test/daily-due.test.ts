/** `commands/daily-due.ts` の判定（DB に触れない純粋関数） */
import { describe, expect, it } from "vitest";
import { DAILY_DUE_HOURS, isDailyDue } from "../src/commands/daily-due.js";

const NOW = new Date("2026-10-06T21:17:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000);

describe("isDailyDue", () => {
  it("前回の成功から 24 時間以上なら due", () => {
    expect(DAILY_DUE_HOURS).toBe(24);
    expect(isDailyDue(hoursAgo(25), NOW)).toBe(true);
    expect(isDailyDue(hoursAgo(24), NOW)).toBe(true);
  });

  it("24 時間未満なら due でない（翌朝 05 時台の回の 1 時間前など）", () => {
    expect(isDailyDue(hoursAgo(23), NOW)).toBe(false);
    expect(isDailyDue(hoursAgo(1), NOW)).toBe(false);
  });

  it("記録がなければ due", () => {
    expect(isDailyDue(undefined, NOW)).toBe(true);
  });
});

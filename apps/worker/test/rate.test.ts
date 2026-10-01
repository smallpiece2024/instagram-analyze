import { describe, expect, it } from "vitest";
import { RateLimitExceeded, RateMonitor, type RateUsage } from "../src/jobs/rate.js";

const headers = (business: unknown, app: unknown) => ({ businessUseCaseUsage: business, appUsage: app });

describe("RateMonitor", () => {
  it("初期値がなければ usage は undefined、percent は 0", () => {
    const monitor = new RateMonitor();
    expect(monitor.usage()).toBeUndefined();
    expect(monitor.percent()).toBe(0);
    expect(monitor.exceeds(1)).toBe(false);
  });

  it("初期値（直近の job_runs.rate_usage や前のジョブの最終値）をそのまま使う", () => {
    const initial: RateUsage = { call_count: 10, total_cputime: 42, total_time: 7 };
    const monitor = new RateMonitor(initial);
    expect(monitor.usage()).toEqual(initial);
    expect(monitor.percent()).toBe(42);
  });

  it("update でヘッダから読んだ値に置き換える。ID は含めない", () => {
    const monitor = new RateMonitor({ call_count: 1, total_cputime: 1, total_time: 1 });
    monitor.update(
      headers(
        { "17841400000000000": [{ type: "instagram", call_count: 5, total_cputime: 10, total_time: 3 }] },
        { call_count: 7, total_cputime: 1, total_time: 9 },
      ),
    );
    expect(monitor.usage()).toEqual({ call_count: 7, total_cputime: 10, total_time: 9 });
    expect(JSON.stringify(monitor.usage())).not.toContain("17841400000000000");
    expect(monitor.percent()).toBe(10);
  });

  it("ヘッダがない、または読めないときは前の値を保つ", () => {
    const monitor = new RateMonitor({ call_count: 3, total_cputime: 4, total_time: 5 });
    monitor.update(headers(undefined, undefined));
    expect(monitor.usage()).toEqual({ call_count: 3, total_cputime: 4, total_time: 5 });
    monitor.update(headers("not json", "not json"));
    expect(monitor.usage()).toEqual({ call_count: 3, total_cputime: 4, total_time: 5 });
  });

  it("exceeds はしきい値ちょうどで true（≥）", () => {
    const monitor = new RateMonitor({ call_count: 50, total_cputime: 20, total_time: 10 });
    expect(monitor.exceeds(50)).toBe(true);
    expect(monitor.exceeds(51)).toBe(false);
    expect(monitor.exceeds(49)).toBe(true);
  });

  it("estimated_time_to_regain_access を保持する", () => {
    const monitor = new RateMonitor();
    monitor.update(
      headers(
        {
          a: [
            { call_count: 100, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 30 },
            { call_count: 1, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 45 },
          ],
        },
        undefined,
      ),
    );
    expect(monitor.usage()).toEqual({
      call_count: 100,
      total_cputime: 1,
      total_time: 1,
      estimated_time_to_regain_access: 45,
    });
    expect(monitor.exceeds(90)).toBe(true);
  });
});

describe("RateLimitExceeded", () => {
  it("固定文言と回復見込み（分）を持つ Error", () => {
    const error = new RateLimitExceeded("レート制限の使用率がしきい値を超えた", 12);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RateLimitExceeded");
    expect(error.message).toBe("レート制限の使用率がしきい値を超えた");
    expect(error.estimatedMinutes).toBe(12);
    expect(new RateLimitExceeded("x").estimatedMinutes).toBeUndefined();
  });

  it("forUsage と forError は URL や ID を含まない固定文言を作る", () => {
    expect(RateLimitExceeded.forUsage(95, 90).message).toBe(
      "レート制限の使用率がしきい値を超えた（使用率 95%、しきい値 90%）",
    );
    expect(RateLimitExceeded.forUsage(95, 90, 7).estimatedMinutes).toBe(7);
    expect(RateLimitExceeded.forError(80004).message).toBe("レート制限のエラー（コード 80004）");
    expect(RateLimitExceeded.forError(undefined).message).toBe("レート制限のエラー（HTTP 429）");
    expect(RateLimitExceeded.forError(4, 3).estimatedMinutes).toBe(3);
  });
});

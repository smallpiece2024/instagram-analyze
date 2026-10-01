/**
 * `jobs/account-daily.ts` の純粋関数の単体テスト（`toFollowerCountRows`、`resolveDays`）。
 * ジョブ本体は `test/db/account-daily.test.ts` の結合テストで動かす
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAYS,
  FOLLOWER_COUNT_DAYS_BACK,
  FOLLOWER_COUNT_METRIC,
  job,
  resolveDays,
  toFollowerCountRows,
} from "../src/jobs/account-daily.js";
import type { InsightsResponse } from "../src/jobs/account-metrics.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";
const FETCHED_AT = new Date("2026-10-01T12:00:00.000Z");

function body(values: { value?: unknown; end_time?: string }[], name = FOLLOWER_COUNT_METRIC): InsightsResponse {
  return { data: [{ name, period: "day", values }] };
}

describe("account_daily の定数", () => {
  it("job の名前と既定値", () => {
    expect(job.name).toBe("account_daily");
    expect(job.shouldRun).toBeUndefined();
    expect(DEFAULT_DAYS).toBe(4);
    expect(FOLLOWER_COUNT_DAYS_BACK).toBe(29);
  });
});

describe("resolveDays", () => {
  it("省略時は 4。1 以上の整数はそのまま。それ以外は例外", () => {
    expect(resolveDays(undefined)).toBe(4);
    expect(resolveDays(1)).toBe(1);
    expect(resolveDays(10)).toBe(10);
    expect(() => resolveDays(0)).toThrow("--days は 1 以上の整数");
    expect(() => resolveDays(-1)).toThrow("--days は 1 以上の整数");
    expect(() => resolveDays(1.5)).toThrow("--days は 1 以上の整数");
    expect(() => resolveDays(Number.NaN)).toThrow("--days は 1 以上の整数");
  });
});

describe("toFollowerCountRows", () => {
  const base = { accountId: ACCOUNT_ID, fetchedAt: FETCHED_AT, rawResponseId: "7" };

  it("end_time の PT の日付が metric_date になる（夏時間 07:00Z、冬時間 08:00Z とも同日）。行の形", () => {
    const rows = toFollowerCountRows({
      ...base,
      body: body([
        { value: 3, end_time: "2026-09-30T07:00:00+0000" },
        { value: 0, end_time: "2026-11-02T08:00:00+0000" },
        { value: "4", end_time: "2026-10-01T07:00:00.000Z" },
      ]),
    });
    expect(rows).toEqual([
      {
        account_id: ACCOUNT_ID,
        metric_date: "2026-09-30",
        metric: "follower_count",
        breakdown: "",
        breakdown_value: "",
        value: 3,
        fetched_at: FETCHED_AT,
        raw_response_id: "7",
      },
      expect.objectContaining({ metric_date: "2026-11-02", value: 0 }),
      expect.objectContaining({ metric_date: "2026-10-01", value: 4 }),
    ]);
  });

  it("value がない、または数値でなければ null。end_time がない、または読めない要素は飛ばす", () => {
    const rows = toFollowerCountRows({
      ...base,
      body: body([
        { end_time: "2026-09-28T07:00:00+0000" },
        { value: "abc", end_time: "2026-09-29T07:00:00+0000" },
        { value: 5 },
        { value: 6, end_time: "2026-09-30T07:00:00" },
        { value: 7, end_time: "not a date Z" },
      ]),
    });
    expect(rows.map((r) => [r.metric_date, r.value])).toEqual([
      ["2026-09-28", null],
      ["2026-09-29", null],
    ]);
  });

  it("body がない、data が空、values がない、name が違う → 0 行。rawResponseId が undefined なら null", () => {
    expect(toFollowerCountRows({ ...base, body: undefined })).toEqual([]);
    expect(toFollowerCountRows({ ...base, body: { data: [] } })).toEqual([]);
    expect(toFollowerCountRows({ ...base, body: { data: [{ name: FOLLOWER_COUNT_METRIC }] } })).toEqual([]);
    expect(toFollowerCountRows({ ...base, body: body([{ value: 1, end_time: "2026-09-30T07:00:00+0000" }], "reach") })).toEqual([]);
    const rows = toFollowerCountRows({ ...base, rawResponseId: undefined, body: body([{ value: 1, end_time: "2026-09-30T07:00:00+0000" }]) });
    expect(rows[0]?.raw_response_id).toBeNull();
  });

  it("data の順序に依存しない（follower_count を名前で引く）", () => {
    const rows = toFollowerCountRows({
      ...base,
      body: {
        data: [
          { name: "reach", period: "day", values: [{ value: 99, end_time: "2026-09-30T07:00:00+0000" }] },
          { name: FOLLOWER_COUNT_METRIC, period: "day", values: [{ value: 1, end_time: "2026-09-30T07:00:00+0000" }] },
        ],
      },
    });
    expect(rows.map((r) => r.value)).toEqual([1]);
  });
});

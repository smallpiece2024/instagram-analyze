import { describe, expect, it } from "vitest";
import {
  addDays,
  elapsedSeconds,
  JST,
  metricDateFromEndTime,
  pacificDayRange,
  PT,
  STORY_LIFETIME_MS,
  storyExpiresAt,
  zonedDate,
  zonedMidnightUtc,
} from "../src/lib/time.js";

const iso = (d: Date): string => d.toISOString();
const sec = (s: string): number => Math.floor(new Date(s).getTime() / 1000);

describe("zonedDate", () => {
  it("JST の境界: UTC 14:59:59 は当日、15:00:00 は翌日", () => {
    expect(zonedDate(new Date("2026-10-01T14:59:59Z"), JST)).toBe("2026-10-01");
    expect(zonedDate(new Date("2026-10-01T15:00:00Z"), JST)).toBe("2026-10-02");
  });

  it("PT の境界: PDT は UTC 06:59:59／07:00:00、PST は 07:59:59／08:00:00", () => {
    expect(zonedDate(new Date("2026-10-01T06:59:59Z"), PT)).toBe("2026-09-30");
    expect(zonedDate(new Date("2026-10-01T07:00:00Z"), PT)).toBe("2026-10-01");
    expect(zonedDate(new Date("2026-12-01T07:59:59Z"), PT)).toBe("2026-11-30");
    expect(zonedDate(new Date("2026-12-01T08:00:00Z"), PT)).toBe("2026-12-01");
  });

  it("年末年始: 同じ瞬間が PT では 12/31、JST では 1/1", () => {
    const d = new Date("2027-01-01T00:00:00Z");
    expect(zonedDate(d, PT)).toBe("2026-12-31");
    expect(zonedDate(d, JST)).toBe("2027-01-01");
  });

  it("夏時間の切り替えの瞬間（PT 02:00）をまたいでも日付は変わらない", () => {
    // 2026-03-08 02:00 PST → 03:00 PDT（UTC 10:00）
    expect(zonedDate(new Date("2026-03-08T09:59:59Z"), PT)).toBe("2026-03-08");
    expect(zonedDate(new Date("2026-03-08T10:00:00Z"), PT)).toBe("2026-03-08");
    // 2026-11-01 02:00 PDT → 01:00 PST（UTC 09:00）
    expect(zonedDate(new Date("2026-11-01T08:59:59Z"), PT)).toBe("2026-11-01");
    expect(zonedDate(new Date("2026-11-01T09:00:00Z"), PT)).toBe("2026-11-01");
  });

  it("不正な日時は RangeError", () => {
    expect(() => zonedDate(new Date("garbage"), PT)).toThrow(RangeError);
  });
});

describe("zonedMidnightUtc", () => {
  it("JST の 0 時は前日の UTC 15:00", () => {
    expect(iso(zonedMidnightUtc("2027-01-01", JST))).toBe("2026-12-31T15:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-10-02", JST))).toBe("2026-10-01T15:00:00.000Z");
  });

  it("PT の 0 時は PDT なら UTC 07:00、PST なら UTC 08:00", () => {
    expect(iso(zonedMidnightUtc("2026-10-01", PT))).toBe("2026-10-01T07:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-12-31", PT))).toBe("2026-12-31T08:00:00.000Z");
  });

  it("夏時間の切り替え日（2026-03-08 開始、2026-11-01 終了）とその翌日", () => {
    expect(iso(zonedMidnightUtc("2026-03-08", PT))).toBe("2026-03-08T08:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-03-09", PT))).toBe("2026-03-09T07:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-11-01", PT))).toBe("2026-11-01T07:00:00.000Z");
    expect(iso(zonedMidnightUtc("2026-11-02", PT))).toBe("2026-11-02T08:00:00.000Z");
  });

  it("書式が違う、または存在しない日付は RangeError", () => {
    expect(() => zonedMidnightUtc("2026/03/08", PT)).toThrow(RangeError);
    expect(() => zonedMidnightUtc("2026-3-8", PT)).toThrow(RangeError);
    expect(() => zonedMidnightUtc("2026-02-30", PT)).toThrow(RangeError);
    expect(() => zonedMidnightUtc("2026-13-01", PT)).toThrow(RangeError);
  });
});

describe("pacificDayRange", () => {
  it("2026-11-01（夏時間の終了日。25 時間）: until は翌日 0 時 − 1 秒で、since + 86399 ではない", () => {
    const range = pacificDayRange("2026-11-01");
    expect(range).toEqual({ since: sec("2026-11-01T07:00:00Z"), until: sec("2026-11-02T07:59:59Z") });
    expect(range.until - range.since).toBe(25 * 3600 - 1);
  });

  it("2026-03-08（夏時間の開始日。23 時間）", () => {
    const range = pacificDayRange("2026-03-08");
    expect(range).toEqual({ since: sec("2026-03-08T08:00:00Z"), until: sec("2026-03-09T06:59:59Z") });
    expect(range.until - range.since).toBe(23 * 3600 - 1);
  });

  it("通常の日は 24 時間 − 1 秒", () => {
    const range = pacificDayRange("2026-10-01");
    expect(range).toEqual({ since: sec("2026-10-01T07:00:00Z"), until: sec("2026-10-02T06:59:59Z") });
    expect(range.until - range.since).toBe(86399);
  });

  it("年末: 12/31 の翌日は翌年の 1/1", () => {
    expect(pacificDayRange("2026-12-31")).toEqual({
      since: sec("2026-12-31T08:00:00Z"),
      until: sec("2027-01-01T07:59:59Z"),
    });
  });
});

describe("metricDateFromEndTime", () => {
  it("end_time の PT の日付そのもの（P3 で確定。前日ではない）", () => {
    expect(metricDateFromEndTime("2026-09-27T07:00:00+0000")).toBe("2026-09-27");
    expect(metricDateFromEndTime("2026-11-02T08:00:00+0000")).toBe("2026-11-02");
    expect(metricDateFromEndTime("2026-11-01T07:00:00+0000")).toBe("2026-11-01");
    expect(metricDateFromEndTime("2026-03-08T08:00:00+0000")).toBe("2026-03-08");
    expect(metricDateFromEndTime("2026-03-09T07:00:00+0000")).toBe("2026-03-09");
    expect(metricDateFromEndTime("2026-12-31T08:00:00+0000")).toBe("2026-12-31");
  });

  it("+00:00 や Z の形式も読める。+0900 のような別のオフセットも PT に直す", () => {
    expect(metricDateFromEndTime("2026-11-02T08:00:00+00:00")).toBe("2026-11-02");
    expect(metricDateFromEndTime("2026-11-02T08:00:00Z")).toBe("2026-11-02");
    // 2026-11-01T23:00:00Z = PT 2026-11-01 15:00
    expect(metricDateFromEndTime("2026-11-02T08:00:00+0900")).toBe("2026-11-01");
    expect(metricDateFromEndTime("2026-11-02T08:00:00+09:00")).toBe("2026-11-01");
  });

  it("オフセットのない文字列は実行環境のタイムゾーンに依存するので RangeError", () => {
    expect(() => metricDateFromEndTime("2026-11-02T08:00:00")).toThrow(RangeError);
    expect(() => metricDateFromEndTime("2026-11-02")).toThrow(RangeError);
  });

  it("読めない文字列は RangeError", () => {
    expect(() => metricDateFromEndTime("garbage")).toThrow(RangeError);
    expect(() => metricDateFromEndTime("2026-13-40T08:00:00Z")).toThrow(RangeError);
  });
});

describe("addDays", () => {
  it("月末と年末をまたぐ。うるう年も扱う", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-10-01", 0)).toBe("2026-10-01");
    expect(addDays("2026-10-01", -29)).toBe("2026-09-02");
    expect(addDays("2026-10-01", -730)).toBe("2024-10-01");
  });

  it("書式が違う、存在しない日付、整数でない日数は RangeError", () => {
    expect(() => addDays("2026-02-29", 1)).toThrow(RangeError);
    expect(() => addDays("20261001", 1)).toThrow(RangeError);
    expect(() => addDays("2026-10-01", 1.5)).toThrow(RangeError);
  });

  it("Date の範囲を超える日数は RangeError（桁あふれで NaN にしない）", () => {
    expect(() => addDays("2026-10-01", 1e8)).toThrow(RangeError);
    expect(() => addDays("2026-10-01", -2e8)).toThrow(RangeError);
    expect(() => addDays("2026-10-01", Number.NaN)).toThrow(RangeError);
    expect(() => addDays("2026-10-01", Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("年 0000〜0099 を 1900 年代に読み替えない", () => {
    expect(addDays("0050-01-01", 1)).toBe("0050-01-02");
    expect(addDays("0099-12-31", 1)).toBe("0100-01-01");
    expect(() => addDays("0050-02-30", 0)).toThrow(RangeError);
  });
});

describe("follower_count の窓（設計 5.2 章）", () => {
  it("D−29 の PT 0 時を since にすると、夏時間の切り替えをまたいでも PT の暦日が 30 日を超えない", () => {
    const today = "2026-03-20"; // ジョブ開始時刻の PT の日付。窓が 2026-03-08 をまたぐ
    const jobStart = new Date("2026-03-20T12:00:00Z"); // PT 05:00 PDT
    expect(zonedDate(jobStart, PT)).toBe(today);

    const since = zonedMidnightUtc(addDays(today, -29), PT);
    expect(iso(since)).toBe("2026-02-19T08:00:00.000Z");
    // since の PT の日付から今日までが 30 日（両端を含む）
    expect(addDays(zonedDate(since, PT), 29)).toBe(today);

    // 比較: now − 30×86400 秒だと PT の暦日が 31 日になり、API の「直近 30 日」を超える
    const naive = new Date(jobStart.getTime() - 30 * 86_400_000);
    expect(addDays(zonedDate(naive, PT), 29)).not.toBe(today);
    expect(addDays(zonedDate(naive, PT), 30)).toBe(today);
  });
});

describe("elapsedSeconds", () => {
  it("切り捨て。負の値はそのまま返す", () => {
    const posted = new Date("2026-10-01T00:00:00.000Z");
    expect(elapsedSeconds(posted, new Date("2026-10-01T00:00:01.999Z"))).toBe(1);
    expect(elapsedSeconds(posted, new Date("2026-10-01T01:00:00.000Z"))).toBe(3600);
    expect(elapsedSeconds(posted, posted)).toBe(0);
    expect(elapsedSeconds(posted, new Date("2026-09-30T23:59:59.500Z"))).toBe(-1);
    expect(elapsedSeconds(posted, new Date("2026-09-30T23:59:00.000Z"))).toBe(-60);
  });
});

describe("storyExpiresAt", () => {
  it("投稿の 24 時間後", () => {
    const posted = new Date("2026-10-01T12:34:56.789Z");
    expect(iso(storyExpiresAt(posted))).toBe("2026-10-02T12:34:56.789Z");
    expect(STORY_LIFETIME_MS).toBe(86_400_000);
  });
});

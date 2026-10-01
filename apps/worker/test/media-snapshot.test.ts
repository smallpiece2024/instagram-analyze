/**
 * `jobs/media-snapshot.ts` の純粋関数の単体テスト（設計 9.1 章の `isSnapshotDue`、`snapshotIntervalFor` の行）。
 * 境界の「まで」は ≤ で固定する。ジョブ本体は `test/db/snapshots.test.ts`（結合）で確かめる。
 */
import { describe, expect, it } from "vitest";
import { isSnapshotDue, job, SNAPSHOT_GRACE_SECONDS, snapshotIntervalFor } from "../src/jobs/media-snapshot.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const POSTED_AT = new Date("2026-10-01T00:00:00.000Z");

/** 投稿からの相対時刻 */
function at(offsetMs: number): Date {
  return new Date(POSTED_AT.getTime() + offsetMs);
}

describe("snapshotIntervalFor", () => {
  it.each<[string, number, number]>([
    ["0 秒", 0, HOUR / SECOND],
    ["20 時間", (20 * HOUR) / SECOND, HOUR / SECOND],
    ["24 時間ちょうど", (24 * HOUR) / SECOND, HOUR / SECOND],
    ["24 時間 + 1 秒", (24 * HOUR) / SECOND + 1, DAY / SECOND],
    ["5 日", (5 * DAY) / SECOND, DAY / SECOND],
    ["30 日ちょうど", (30 * DAY) / SECOND, DAY / SECOND],
    ["30 日 + 1 秒", (30 * DAY) / SECOND + 1, (7 * DAY) / SECOND],
    ["90 日ちょうど", (90 * DAY) / SECOND, (7 * DAY) / SECOND],
    ["90 日 + 1 秒", (90 * DAY) / SECOND + 1, (30 * DAY) / SECOND],
    ["400 日", (400 * DAY) / SECOND, (30 * DAY) / SECOND],
    ["負（時計のずれ）", -60, HOUR / SECOND],
  ])("前回時点の経過 %s → 間隔 %i 秒", (_label, elapsed, expected) => {
    expect(snapshotIntervalFor(elapsed)).toBe(expected);
  });
});

describe("isSnapshotDue", () => {
  it("スナップショットがなければ常に対象（初回の取り込み）", () => {
    expect(isSnapshotDue(POSTED_AT, null, at(1 * SECOND))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, null, at(400 * DAY))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, null, POSTED_AT)).toBe(true);
  });

  it("postedAt が now より後なら対象外。ちょうど同じなら対象", () => {
    expect(isSnapshotDue(at(1 * SECOND), null, POSTED_AT)).toBe(false);
    expect(isSnapshotDue(POSTED_AT, null, POSTED_AT)).toBe(true);
  });

  it("lastFetchedAt が now より後（時計のずれ）なら対象外", () => {
    expect(isSnapshotDue(POSTED_AT, at(2 * HOUR), at(2 * HOUR - 1 * SECOND))).toBe(false);
    expect(isSnapshotDue(POSTED_AT, at(2 * HOUR), at(2 * HOUR))).toBe(false);
  });

  it("24 時間まで: 前回から 50 分（1 時間 − 10 分）で対象。その 1 秒前は対象外", () => {
    const last = at(3 * HOUR);
    expect(isSnapshotDue(POSTED_AT, last, at(3 * HOUR + 50 * MINUTE))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, last, at(3 * HOUR + 50 * MINUTE - 1 * SECOND))).toBe(false);
    expect(isSnapshotDue(POSTED_AT, last, at(3 * HOUR + 1 * HOUR))).toBe(true);
    expect(SNAPSHOT_GRACE_SECONDS).toBe(10 * 60);
  });

  it("境目をまたぐ直後: 前回 23 時間なら 24 時間時点で取る。前回 24 時間ちょうどは間隔 1 時間、24 時間 + 1 秒は間隔 1 日", () => {
    expect(isSnapshotDue(POSTED_AT, at(23 * HOUR), at(24 * HOUR))).toBe(true);

    const exactly24h = at(24 * HOUR);
    expect(isSnapshotDue(POSTED_AT, exactly24h, at(24 * HOUR + 50 * MINUTE))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, exactly24h, at(24 * HOUR + 50 * MINUTE - 1 * SECOND))).toBe(false);

    const after24h = at(24 * HOUR + 1 * SECOND);
    expect(isSnapshotDue(POSTED_AT, after24h, at(24 * HOUR + 1 * SECOND + 1 * HOUR))).toBe(false);
    expect(isSnapshotDue(POSTED_AT, after24h, at(24 * HOUR + 1 * SECOND + 1 * DAY - 10 * MINUTE))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, after24h, at(24 * HOUR + 1 * SECOND + 1 * DAY - 10 * MINUTE - 1 * SECOND))).toBe(false);
  });

  it("30 日ちょうどは間隔 1 日、30 日 + 1 秒は間隔 7 日", () => {
    const exactly30d = at(30 * DAY);
    expect(isSnapshotDue(POSTED_AT, exactly30d, at(31 * DAY - 10 * MINUTE))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, exactly30d, at(31 * DAY - 10 * MINUTE - 1 * SECOND))).toBe(false);

    const after30d = at(30 * DAY + 1 * SECOND);
    expect(isSnapshotDue(POSTED_AT, after30d, at(31 * DAY + 1 * SECOND))).toBe(false);
    expect(isSnapshotDue(POSTED_AT, after30d, at(37 * DAY + 1 * SECOND - 10 * MINUTE))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, after30d, at(37 * DAY + 1 * SECOND - 10 * MINUTE - 1 * SECOND))).toBe(false);
  });

  it("90 日ちょうどは間隔 7 日、90 日 + 1 秒は間隔 30 日", () => {
    const exactly90d = at(90 * DAY);
    expect(isSnapshotDue(POSTED_AT, exactly90d, at(97 * DAY - 10 * MINUTE))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, exactly90d, at(97 * DAY - 10 * MINUTE - 1 * SECOND))).toBe(false);

    const after90d = at(90 * DAY + 1 * SECOND);
    expect(isSnapshotDue(POSTED_AT, after90d, at(97 * DAY + 1 * SECOND))).toBe(false);
    expect(isSnapshotDue(POSTED_AT, after90d, at(120 * DAY + 1 * SECOND - 10 * MINUTE))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, after90d, at(120 * DAY + 1 * SECOND - 10 * MINUTE - 1 * SECOND))).toBe(false);
  });

  it("停止後の再開: 前回 20 時間、now は 5 日後 → 対象（間隔は前回時点の 1 時間）。その次は 5 日時点が前回で間隔 1 日", () => {
    expect(isSnapshotDue(POSTED_AT, at(20 * HOUR), at(5 * DAY))).toBe(true);
    expect(snapshotIntervalFor((20 * HOUR) / SECOND)).toBe(HOUR / SECOND);

    const resumedAt = at(5 * DAY);
    expect(snapshotIntervalFor((5 * DAY) / SECOND)).toBe(DAY / SECOND);
    expect(isSnapshotDue(POSTED_AT, resumedAt, at(5 * DAY + 1 * HOUR))).toBe(false);
    expect(isSnapshotDue(POSTED_AT, resumedAt, at(6 * DAY - 10 * MINUTE))).toBe(true);
  });

  it("前回が投稿より前（時計のずれ）でも例外にならず、間隔 1 時間で判定する", () => {
    expect(isSnapshotDue(POSTED_AT, at(-1 * MINUTE), at(49 * MINUTE))).toBe(true);
    expect(isSnapshotDue(POSTED_AT, at(-1 * MINUTE), at(48 * MINUTE))).toBe(false);
  });
});

describe("job", () => {
  it("name は media_snapshot で、shouldRun と rateThreshold は持たない（既定のしきい値）", () => {
    expect(job.name).toBe("media_snapshot");
    expect(job.shouldRun).toBeUndefined();
    expect(job.rateThreshold).toBeUndefined();
    expect(typeof job.run).toBe("function");
  });
});

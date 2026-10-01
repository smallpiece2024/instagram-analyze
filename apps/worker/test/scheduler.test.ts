import { describe, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import type { JobDeps } from "../src/jobs/framework.js";
import type { GroupEntry, GroupName } from "../src/jobs/groups.js";
import { DEFAULT_INTERVAL_MS, dueGroups, runScheduler, type LastStarted } from "../src/jobs/scheduler.js";
import { createLogger, SecretRegistry } from "../src/lib/log.js";

// ---------------------------------------------------------------------------
// dueGroups（設計 2.3 章、9.1 章）
// ---------------------------------------------------------------------------

const CFG = { hourlyMinute: 5, dailyTimeJst: { hour: 5, minute: 30 } };

/** JST 05:30 は UTC 20:30（前日） */
const JST_0530_ON_1002 = new Date("2026-10-01T20:30:00Z");

/** 片方のグループだけを見る（もう片方の fixture の時刻に左右されない） */
const hourlyDue = (now: Date, last: LastStarted, cfg = CFG): boolean => dueGroups(now, last, cfg).includes("hourly");
const dailyDue = (now: Date, last: LastStarted, cfg = CFG): boolean => dueGroups(now, last, cfg).includes("daily");

describe("dueGroups", () => {
  it("last がなければ即実行。両方なら daily → hourly の順", () => {
    expect(dueGroups(new Date("2026-10-01T10:00:00Z"), {}, CFG)).toEqual(["daily", "hourly"]);
    expect(dueGroups(new Date("2026-10-01T10:00:00Z"), { daily: new Date("2026-10-01T09:00:00Z") }, CFG)).toEqual(["hourly"]);
    expect(dueGroups(new Date("2026-10-01T10:00:00Z"), { hourly: new Date("2026-10-01T09:59:00Z") }, CFG)).toEqual(["daily"]);
  });

  describe("hourly", () => {
    /** UTC 10:05 に走った状態（daily は JST 10-01 05:30 に実行済みで、この日の UTC 10〜14 時台は due にならない） */
    const last: LastStarted = { hourly: new Date("2026-10-01T10:05:00Z"), daily: new Date("2026-09-30T20:30:00Z") };

    it("同じ時間帯には 2 回走らない", () => {
      expect(dueGroups(new Date("2026-10-01T10:05:00Z"), last, CFG)).toEqual([]);
      expect(dueGroups(new Date("2026-10-01T10:40:00Z"), last, CFG)).toEqual([]);
      expect(dueGroups(new Date("2026-10-01T10:59:59Z"), last, CFG)).toEqual([]);
    });

    it("次の時間帯で分が hourlyMinute 以降なら走る。未満なら走らない", () => {
      expect(dueGroups(new Date("2026-10-01T11:04:59Z"), last, CFG)).toEqual([]);
      expect(dueGroups(new Date("2026-10-01T11:05:00Z"), last, CFG)).toEqual(["hourly"]);
      expect(dueGroups(new Date("2026-10-01T11:59:00Z"), last, CFG)).toEqual(["hourly"]);
    });

    it("予定の分を過ぎて起動しても、その時間帯の分を 1 回走らせる（再起動や復帰）", () => {
      expect(dueGroups(new Date("2026-10-01T13:47:00Z"), last, CFG)).toEqual(["hourly"]);
      // 走った直後は同じ時間帯なので走らない
      expect(dueGroups(new Date("2026-10-01T13:48:00Z"), { ...last, hourly: new Date("2026-10-01T13:47:00Z") }, CFG)).toEqual([]);
    });

    it("hourlyMinute が 0 なら 0 分ちょうどで走る。59 なら 59 分だけ", () => {
      expect(hourlyDue(new Date("2026-10-01T11:00:00Z"), last, { ...CFG, hourlyMinute: 0 })).toBe(true);
      expect(hourlyDue(new Date("2026-10-01T11:58:59Z"), last, { ...CFG, hourlyMinute: 59 })).toBe(false);
      expect(hourlyDue(new Date("2026-10-01T11:59:00Z"), last, { ...CFG, hourlyMinute: 59 })).toBe(true);
    });

    it("last.hourly が 24 時間以上前の同じ時刻（前日 10:05、今 10:30）でも走る（時間帯は日付を含めて比べる）", () => {
      const yesterday: LastStarted = { ...last, hourly: new Date("2026-10-01T10:05:00Z") };
      expect(hourlyDue(new Date("2026-10-02T10:30:00Z"), yesterday)).toBe(true);
      expect(hourlyDue(new Date("2026-10-02T10:04:00Z"), yesterday)).toBe(false);
    });

    it("last.hourly が未来（時計のずれ）でも、別の時間帯なら走り、その後は同じ時間帯として走らない", () => {
      const future: LastStarted = { ...last, hourly: new Date("2026-10-01T12:05:00Z") };
      expect(hourlyDue(new Date("2026-10-01T11:10:00Z"), future)).toBe(true);
      expect(hourlyDue(new Date("2026-10-01T12:10:00Z"), future)).toBe(false);
    });
  });

  describe("daily（hourly の fixture に左右されないよう daily だけを見る）", () => {
    /** JST 2026-10-01 05:30 に走った状態 */
    const last: LastStarted = { daily: new Date("2026-09-30T20:30:00Z") };

    it("JST 05:29:59 は走らず、05:30:00 で走る", () => {
      expect(dailyDue(new Date("2026-10-01T20:29:59Z"), last)).toBe(false);
      expect(dailyDue(JST_0530_ON_1002, last)).toBe(true);
      expect(dailyDue(new Date("2026-10-01T23:00:00Z"), last)).toBe(true);
    });

    it("JST の日付が変わるのは UTC 15:00。日付が変わっても時刻が 05:30 前なら走らない", () => {
      // JST 10-01 23:59:59（今日は実行済み）
      expect(dailyDue(new Date("2026-10-01T14:59:59Z"), last)).toBe(false);
      // JST 10-02 00:00:00（日付は変わったが 05:30 前）
      expect(dailyDue(new Date("2026-10-01T15:00:00Z"), last)).toBe(false);
      // JST 10-02 05:30:00
      expect(dailyDue(JST_0530_ON_1002, last)).toBe(true);
    });

    it("同じ JST の日に 2 回走らない", () => {
      const ranToday: LastStarted = { daily: JST_0530_ON_1002 };
      expect(dailyDue(new Date("2026-10-01T20:31:00Z"), ranToday)).toBe(false);
      expect(dailyDue(new Date("2026-10-02T14:59:59Z"), ranToday)).toBe(false);
      // 翌日の JST 05:30
      expect(dailyDue(new Date("2026-10-02T20:30:00Z"), ranToday)).toBe(true);
    });

    it("再起動直後に DB から読んだ last.daily が JST の今日なら走らない。昨日なら走る", () => {
      const ranTodayLate: LastStarted = { daily: new Date("2026-10-01T20:31:00Z") }; // JST 10-02 05:31
      expect(dailyDue(new Date("2026-10-02T03:00:00Z"), ranTodayLate)).toBe(false); // JST 10-02 12:00
      const ranYesterday: LastStarted = { daily: new Date("2026-09-30T22:00:00Z") }; // JST 10-01 07:00
      expect(dailyDue(new Date("2026-10-02T03:00:00Z"), ranYesterday)).toBe(true);
    });

    it("dailyTimeJst を変えても同じ規則（00:00 と 23:59）", () => {
      const midnight = { ...CFG, dailyTimeJst: { hour: 0, minute: 0 } };
      expect(dailyDue(new Date("2026-10-01T14:59:59Z"), last, midnight)).toBe(false);
      expect(dailyDue(new Date("2026-10-01T15:00:00Z"), last, midnight)).toBe(true);
      const lateNight = { ...CFG, dailyTimeJst: { hour: 23, minute: 59 } };
      // last が JST 10-01 なら、10-01 23:59 は「今日は実行済み」で走らない
      expect(dailyDue(new Date("2026-10-01T14:59:00Z"), last, lateNight)).toBe(false);
      // last が JST 09-30 なら、10-01 23:58:59 は走らず 23:59:00 で走る
      const ranPreviousDay: LastStarted = { daily: new Date("2026-09-29T20:30:00Z") };
      expect(dailyDue(new Date("2026-10-01T14:58:59Z"), ranPreviousDay, lateNight)).toBe(false);
      expect(dailyDue(new Date("2026-10-01T14:59:00Z"), ranPreviousDay, lateNight)).toBe(true);
    });
  });

  it("両方 due のときは daily → hourly", () => {
    const last: LastStarted = { hourly: new Date("2026-10-01T19:05:00Z"), daily: new Date("2026-09-30T20:30:00Z") };
    expect(dueGroups(JST_0530_ON_1002, last, CFG)).toEqual(["daily", "hourly"]);
  });
});

// ---------------------------------------------------------------------------
// runScheduler（偽の runGroup、短い intervalMs、AbortController）
// ---------------------------------------------------------------------------

function config(): WorkerConfig {
  return {
    databaseUrl: "postgresql://dbuser:dbpass@db.example.supabase.co:5432/postgres",
    supabaseUrl: "https://abcdefghij.supabase.co",
    supabaseServiceRoleKey: "SERVICE_ROLE_KEY_VALUE",
    graphApiVersion: "v25.0",
    metaAppId: "123",
    metaAppSecret: "APP_SECRET_VALUE",
    hourlyMinute: 5,
    dailyTimeJst: { hour: 5, minute: 30 },
    backfillMaxDays: 30,
    backfillHistoryDays: 730,
    rateHardLimit: 90,
    rateSoftLimit: 50,
    logLevel: "debug",
    outputDir: ".local",
    downloadAllowedHosts: ["cdninstagram.com"],
  };
}

/** DB には触らないので `db` は空。`now` は注入 */
function deps(now: () => Date, lines: string[]): JobDeps {
  const secrets = new SecretRegistry();
  return {
    db: undefined as unknown as Db,
    config: config(),
    log: createLogger("debug", secrets, (line) => lines.push(line)),
    secrets,
    now,
  };
}

const EMPTY_GROUPS: Record<GroupName, GroupEntry[]> = { hourly: [], daily: [] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runScheduler", () => {
  it("既定の起床間隔は 30 秒", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(30_000);
  });

  it("due のグループを daily → hourly の順に呼び、lastStarted を更新する。runGroup に signal を渡す。abort で戻る", async () => {
    const calls: GroupName[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const lines: string[] = [];
    const fixed = new Date("2026-10-01T10:00:00Z");
    const controller = new AbortController();
    const lastStarted: LastStarted = {};
    const done = runScheduler(deps(() => fixed, lines), {
      intervalMs: 5,
      signal: controller.signal,
      lastStarted,
      groups: EMPTY_GROUPS,
      runGroup: async (name, _entries, _deps, _runJobs, signal) => {
        calls.push(name);
        signals.push(signal);
        return true;
      },
    });
    await sleep(40);
    controller.abort();
    await done;
    // 時計が止まっているので、1 回走ったあとは同じ時間帯／同じ日として走らない
    expect(calls).toEqual(["daily", "hourly"]);
    expect(lastStarted).toEqual({ daily: fixed, hourly: fixed });
    // グループ内の残りのジョブも停止要求で止められるよう、同じ signal を渡す
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it("時計が進めば次の時間帯で hourly だけが再び走る", async () => {
    const calls: GroupName[] = [];
    let current = new Date("2026-10-01T10:06:00Z"); // JST 10-01 19:06
    const controller = new AbortController();
    // hourly は UTC 10 時台に実行済み、daily は JST 10-01 05:30 に実行済み
    const lastStarted: LastStarted = { hourly: new Date("2026-10-01T10:05:00Z"), daily: new Date("2026-09-30T20:30:00Z") };
    const done = runScheduler(deps(() => current, []), {
      intervalMs: 5,
      signal: controller.signal,
      lastStarted,
      groups: EMPTY_GROUPS,
      runGroup: async (name) => {
        calls.push(name);
        return true;
      },
    });
    await sleep(20);
    expect(calls).toEqual([]);
    current = new Date("2026-10-01T11:05:00Z");
    await sleep(20);
    controller.abort();
    await done;
    expect(calls).toEqual(["hourly"]);
    expect(lastStarted.hourly).toEqual(new Date("2026-10-01T11:05:00Z"));
  });

  it("abort されたら実行中のグループを終えてから戻り、次のグループは始めない", async () => {
    const calls: GroupName[] = [];
    let notifyStarted: (() => void) | undefined;
    let finishGroup: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const controller = new AbortController();
    let returned = false;
    const done = runScheduler(deps(() => new Date("2026-10-01T10:00:00Z"), []), {
      intervalMs: 5,
      signal: controller.signal,
      lastStarted: {},
      groups: EMPTY_GROUPS,
      runGroup: (name) => {
        calls.push(name);
        notifyStarted?.();
        return new Promise<boolean>((resolve) => {
          finishGroup = () => resolve(true);
        });
      },
    }).then(() => {
      returned = true;
    });
    await started;
    expect(calls).toEqual(["daily"]);
    controller.abort();
    await sleep(10);
    // 実行中のグループが終わるまでは戻らない
    expect(returned).toBe(false);
    finishGroup?.();
    await done;
    expect(returned).toBe(true);
    // 停止要求のあとは hourly を始めない
    expect(calls).toEqual(["daily"]);
  });

  it("runGroup が投げても記録して続け、次のグループと次の周回に進む", async () => {
    const calls: GroupName[] = [];
    const lines: string[] = [];
    const controller = new AbortController();
    const done = runScheduler(deps(() => new Date("2026-10-01T10:00:00Z"), lines), {
      intervalMs: 5,
      signal: controller.signal,
      lastStarted: {},
      groups: EMPTY_GROUPS,
      runGroup: async (name) => {
        calls.push(name);
        if (name === "daily") throw new Error("boom https://x/?access_token=SECRET");
        return true;
      },
    });
    await sleep(30);
    controller.abort();
    await done;
    expect(calls).toEqual(["daily", "hourly"]);
    expect(lines.some((l) => l.includes("WARN") && l.includes("group=daily") && l.includes("status=failed") && l.includes("class=unknown"))).toBe(true);
    expect(lines.some((l) => l.includes("DEBUG") && l.includes('error="boom <url>"'))).toBe(true);
    expect(lines.join("\n")).not.toContain("SECRET");
  });

  it("既に abort されていれば何も呼ばずに戻る", async () => {
    const calls: GroupName[] = [];
    const controller = new AbortController();
    controller.abort();
    await runScheduler(deps(() => new Date(), []), {
      intervalMs: 5,
      signal: controller.signal,
      lastStarted: {},
      groups: EMPTY_GROUPS,
      runGroup: async (name) => {
        calls.push(name);
        return true;
      },
    });
    expect(calls).toEqual([]);
  });
});

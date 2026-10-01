/**
 * コンテナ内で常駐するスケジューラ（設計 2.1 章、2.3 章）。
 *
 * - `intervalMs`（既定 30 秒）ごとに起きて `dueGroups` を呼び、実行すべきグループを順に `runGroup` する
 *   （同じプロセス内。別プロセスは起動しない）。グループは同時に走らせない（直列）
 * - 判定は純粋関数 `dueGroups`。「以降」で判定するのは、コンテナの再起動や PC の復帰で予定の分を過ぎていても、
 *   その時間帯（その日）の分を 1 回だけ実行するため
 * - `lastStarted` は起動時に `job_runs` から読み（`commands/schedule.ts`）、以降はこのモジュールがメモリで更新する
 * - `signal` が abort されたら（SIGTERM）、実行中のグループを終えてからループを抜ける（`stop_grace_period` 内）
 */
import type { WorkerConfig } from "../config.js";
import { JST, zonedDate } from "../lib/time.js";
import { describeError, type JobDeps } from "./framework.js";
import { DAILY_JOBS, HOURLY_JOBS, runGroup as defaultRunGroup, type GroupEntry, type GroupName } from "./groups.js";

/** 各グループを最後に開始した時刻。未実行なら undefined */
export interface LastStarted {
  hourly?: Date;
  daily?: Date;
}

export type ScheduleConfig = Pick<WorkerConfig, "hourlyMinute" | "dailyTimeJst">;

/** 既定の起床間隔（ミリ秒） */
export const DEFAULT_INTERVAL_MS = 30_000;

const HOUR_MS = 60 * 60 * 1000;

const JST_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: JST,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

/** JST の壁時計の時と分 */
function jstTime(d: Date): { hour: number; minute: number } {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of JST_TIME_FORMAT.formatToParts(d)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { hour: parts.hour ?? 0, minute: parts.minute ?? 0 };
}

/** 同じ時間帯（UTC の時の区切り。JST と PT は時の区切りが UTC と一致する） */
function sameHour(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / HOUR_MS) === Math.floor(b.getTime() / HOUR_MS);
}

/** hourly: 初回は即実行。それ以降は、分が `hourlyMinute` 以降で、同じ時間帯にまだ実行していない */
function isHourlyDue(now: Date, last: Date | undefined, hourlyMinute: number): boolean {
  if (last === undefined) return true;
  return now.getUTCMinutes() >= hourlyMinute && !sameHour(now, last);
}

/** daily: 初回は即実行。それ以降は、JST の時刻が `dailyTimeJst` 以降で、JST の今日にまだ実行していない */
function isDailyDue(now: Date, last: Date | undefined, dailyTimeJst: { hour: number; minute: number }): boolean {
  if (last === undefined) return true;
  const { hour, minute } = jstTime(now);
  const afterTime = hour > dailyTimeJst.hour || (hour === dailyTimeJst.hour && minute >= dailyTimeJst.minute);
  return afterTime && zonedDate(now, JST) !== zonedDate(last, JST);
}

/**
 * 実行すべきグループ（設計 2.3 章）。両方なら daily → hourly の順。純粋関数
 */
export function dueGroups(now: Date, last: LastStarted, cfg: ScheduleConfig): GroupName[] {
  const due: GroupName[] = [];
  if (isDailyDue(now, last.daily, cfg.dailyTimeJst)) due.push("daily");
  if (isHourlyDue(now, last.hourly, cfg.hourlyMinute)) due.push("hourly");
  return due;
}

export interface SchedulerOptions {
  /** 起床間隔（ミリ秒）。既定 30 秒 */
  intervalMs?: number;
  /** abort されたら、実行中のグループを終えてから戻る */
  signal: AbortSignal;
  /** 起動時の初期値（`job_runs` から）。実行のたびにこのオブジェクトを更新する */
  lastStarted: LastStarted;
  /** テスト用の差し替え */
  runGroup?: typeof defaultRunGroup;
  /** テスト用の差し替え。既定は `HOURLY_JOBS` と `DAILY_JOBS` */
  groups?: Record<GroupName, GroupEntry[]>;
}

/** `ms` 待つ。`signal` が abort されたらすぐに戻る */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 常駐ループ。`signal` が abort されるまで戻らない。グループの例外は記録して続ける（常駐を止めない）
 */
export async function runScheduler(deps: JobDeps, opts: SchedulerOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const runGroup = opts.runGroup ?? defaultRunGroup;
  const groups = opts.groups ?? { hourly: HOURLY_JOBS, daily: DAILY_JOBS };
  const now = deps.now ?? (() => new Date());
  const last = opts.lastStarted;

  while (!opts.signal.aborted) {
    for (const name of dueGroups(now(), last, deps.config)) {
      // 停止要求のあとは新しいグループを始めない（実行中のものは終える）
      if (opts.signal.aborted) break;
      last[name] = now();
      try {
        // signal を渡し、停止要求のあとはグループ内の残りのジョブも始めない（実行中の 1 ジョブは終える）
        await runGroup(name, groups[name], deps, undefined, opts.signal);
      } catch (error) {
        const failure = describeError(error, deps.secrets);
        deps.log.warn({ group: name, status: "failed", error_code: failure.code ?? "none", class: failure.errorClass });
        deps.log.debug({ group: name, error: failure.message });
      }
    }
    await sleepUnlessAborted(intervalMs, opts.signal);
  }
}

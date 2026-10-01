/**
 * `account_backfill` ジョブ（設計 5.3 章、7.2 章、13.2 章）。
 *
 * D−1 から過去へ向かって 1 日ずつ `fetchAccountDay` で取り、API が「2 年」のエラーを返すか D−`config.backfillHistoryDays`
 * （既定 730）に達するまで進める。遡る日数は実行のたびに読み、保存済みの `oldest_date` と「今日 − 日数」の遅い方を下限にする
 * （途中で設定を小さくしても効く。大きくし直すときは `job_state` を消してやり直す）。
 * 進み具合は `job_state`（`BackfillState`）に 1 日ごとに書き、中断しても続きから再開する。
 * 1 回の実行は `config.backfillMaxDays` 日まで。各日の前に使用率が `config.rateSoftLimit` 以上なら
 * `RateLimitExceeded` を投げて止める（書けた分は残り、次回に続く）。
 * 通常の日をすべて終えたら `failed_dates` の `attempts < 3` の日を取り直し、3 回失敗した日は残して `done = true`。
 * 「2 年」のエラーが返ったら、その日は取らずに通常の日の下限をそこで確定する（`finishByHistoryLimit`）。それより新しい
 * 失敗日が取り直せるなら `done` にせず、取り直してから `done` にする。
 * `done` になったら `shouldRun` が false を返し、`job_runs` に行を作らない（Q8）。
 * follower_count と `online_followers` は対象外（設計 5.3 章、13.2 章）。
 *
 * `nextBackfillWindow`、`advanceBackfillState`、`finishByHistoryLimit`、`initialBackfillState` は純粋関数
 */
import { upsertAccountDailyMetrics } from "../db/account-daily.js";
import { getJobState, setJobState } from "../db/job-runs.js";
import { addDays, PT, zonedDate } from "../lib/time.js";
import { fetchAccountDay } from "./account-metrics.js";
import type { JobContext, JobDefinition } from "./framework.js";
import { RateLimitExceeded } from "./rate.js";

export { isHistoryLimitError } from "./account-metrics.js";

const JOB_NAME = "account_backfill";

/** 遡る日数の既定（D−730）。API の保持期間は 2 年（V1）。`WORKER_BACKFILL_HISTORY_DAYS` で短くできる */
export const BACKFILL_HISTORY_DAYS = 730;

/** これより古い日でコード 100 が「2 年」の判定に当たらなかったら `warn`（文言の変更に備える。設計 5.3 章） */
export const BACKFILL_WARN_AFTER_DAYS = 700;

/** 失敗した日を取り直す回数の上限（初回を含む） */
export const BACKFILL_MAX_ATTEMPTS = 3;

export interface BackfillFailedDate {
  date: string;
  attempts: number;
}

/** `job_state.state`（job_name = `account_backfill`） */
export interface BackfillState {
  /** 次に取る日。通常の日をすべて終えると `oldest_date` より前になる */
  next_date: string;
  /** D−730 */
  oldest_date: string;
  done: boolean;
  /** 通常の日として取った日数（失敗した日も含む） */
  days_done: number;
  /** 一部でも失敗した日。取り直しで成功したら消える */
  failed_dates: BackfillFailedDate[];
}

export interface BackfillWindow {
  /** この回に取る日（新しい順）。空なら何もしない */
  dates: string[];
  /** `failed_dates` の取り直しの回か */
  retry: boolean;
  /** 初回は作ったばかりの状態。それ以外は渡したものと同じ */
  state: BackfillState;
}

/** 初回の状態。`next_date` は D−1、`oldest_date` は D−`historyDays`（既定 730） */
export function initialBackfillState(today: string, historyDays: number = BACKFILL_HISTORY_DAYS): BackfillState {
  return {
    next_date: addDays(today, -1),
    oldest_date: addDays(today, -historyDays),
    done: false,
    days_done: 0,
    failed_dates: [],
  };
}

/**
 * 設定の遡る日数を保存済みの状態に効かせる（純粋関数）。`oldest_date` は、保存済みの値と「今日 − historyDays」の遅い方。
 * 設定を小さくすれば下限が新しい日に縮み、`next_date` がそれより古ければ通常の日は終わった扱いになる。
 * 大きくしても過去には広がらない（`job_state` を消してやり直す）。変わらなければ同じオブジェクトを返す
 */
export function applyHistoryDays(state: BackfillState, today: string, historyDays: number): BackfillState {
  const floor = addDays(today, -historyDays);
  return state.oldest_date >= floor ? state : { ...state, oldest_date: floor };
}

function retryable(state: BackfillState): BackfillFailedDate[] {
  return state.failed_dates.filter((f) => f.attempts < BACKFILL_MAX_ATTEMPTS);
}

/** 通常の日（`next_date` から `oldest_date` まで）を終えたか。`YYYY-MM-DD` は文字列のまま比べられる */
function normalDaysDone(state: BackfillState): boolean {
  return state.next_date < state.oldest_date;
}

/**
 * 次に取る日の列を決める（純粋関数）。`historyDays`（既定 730）は `applyHistoryDays` で `oldest_date` に効かせる。
 * - 初回（`state` が undefined）: D−1 から過去へ最大 `maxDays` 日
 * - 通常: `next_date` から過去へ最大 `maxDays` 日（`oldest_date` まで）
 * - 通常の日を終えていれば: `failed_dates` の `attempts < 3` の日を最大 `maxDays` 件（`retry: true`）
 * - `done` か、何も残っていなければ `dates: []`
 * 戻り値の `state` は `oldest_date` が変わっていれば新しいオブジェクト、変わらなければ渡したもの
 */
export function nextBackfillWindow(
  state: BackfillState | undefined,
  today: string,
  maxDays: number,
  historyDays: number = BACKFILL_HISTORY_DAYS,
): BackfillWindow {
  const current = applyHistoryDays(state ?? initialBackfillState(today, historyDays), today, historyDays);
  const limit = Math.max(0, Math.floor(maxDays));
  if (current.done) return { dates: [], retry: false, state: current };
  if (!normalDaysDone(current)) {
    const dates: string[] = [];
    let date = current.next_date;
    while (dates.length < limit && date >= current.oldest_date) {
      dates.push(date);
      date = addDays(date, -1);
    }
    return { dates, retry: false, state: current };
  }
  const dates = retryable(current)
    .slice(0, limit)
    .map((f) => f.date);
  return { dates, retry: dates.length > 0, state: current };
}

/** `done` にしてよいか: 通常の日を終え、取り直せる日が残っていない */
function isExhausted(state: BackfillState): boolean {
  return normalDaysDone(state) && retryable(state).length === 0;
}

/**
 * 1 日を終えたあとの状態（純粋関数）。
 * - 通常の回: `next_date = date − 1`、`days_done + 1`。失敗なら `failed_dates` に加える（既にあれば `attempts + 1`）
 * - 取り直しの回: 成功なら `failed_dates` から消す。失敗なら `attempts + 1`
 * どちらも、通常の日を終えて取り直せる日が残っていなければ `done = true`
 */
export function advanceBackfillState(state: BackfillState, date: string, failed: boolean, retry: boolean): BackfillState {
  let failedDates: BackfillFailedDate[];
  if (failed) {
    const found = state.failed_dates.some((f) => f.date === date);
    failedDates = found
      ? state.failed_dates.map((f) => (f.date === date ? { date, attempts: f.attempts + 1 } : f))
      : [...state.failed_dates, { date, attempts: 1 }];
  } else {
    failedDates = state.failed_dates.filter((f) => f.date !== date);
  }
  const next: BackfillState = {
    ...state,
    next_date: retry ? state.next_date : addDays(date, -1),
    days_done: retry ? state.days_done : state.days_done + 1,
    failed_dates: failedDates,
  };
  return { ...next, done: next.done || isExhausted(next) };
}

/**
 * `date` で「2 年」のエラーが返ったあとの状態（純粋関数）。その日は取らない。
 * - `oldest_date = date + 1`（通常の日の下限をここで確定）、`next_date = date`（通常の日は終わった扱い）
 * - `failed_dates` から `date` 以前の日を除く（取り直しても同じエラーになる）
 * - 取り直せる日（`attempts < 3`）が残っていなければ `done = true`。残っていれば次回（または同じ回の続き）で取り直す
 * 通常の回でも取り直しの回でも同じ
 */
export function finishByHistoryLimit(state: BackfillState, date: string): BackfillState {
  const next: BackfillState = {
    ...state,
    next_date: date,
    oldest_date: addDays(date, 1),
    failed_dates: state.failed_dates.filter((f) => f.date > date),
  };
  return { ...next, done: retryable(next).length === 0 };
}

/** 使用率が `config.rateSoftLimit` 以上なら止める（設計 7.2 章）。`rateThreshold` には設定を載せられないので `run` の中で判定する */
function assertSoftLimit(ctx: JobContext): void {
  const threshold = ctx.config.rateSoftLimit;
  if (ctx.rate.exceeds(threshold)) {
    throw RateLimitExceeded.forUsage(ctx.rate.percent(), threshold, ctx.rate.usage()?.estimated_time_to_regain_access);
  }
}

export const job: JobDefinition = {
  name: JOB_NAME,
  shouldRun: async (ctx) => (await getJobState<BackfillState>(ctx.db, ctx.account.id, JOB_NAME))?.done !== true,
  async run(ctx) {
    const today = zonedDate(ctx.startedAt, PT);
    const stored = await getJobState<BackfillState>(ctx.db, ctx.account.id, JOB_NAME);
    const window = nextBackfillWindow(stored, today, ctx.config.backfillMaxDays, ctx.config.backfillHistoryDays);
    const warnBefore = addDays(today, -BACKFILL_WARN_AFTER_DAYS);
    let state = window.state;
    let processed = 0;
    /** 「2 年」のエラーが返った日。これ以前の日はこの回ではもう取らない */
    let historyLimitDate: string | undefined;

    if (window.dates.length === 0 && !state.done) {
      // 通常の日も取り直しも残っていない（3 回失敗した日だけが残っている）
      state = { ...state, done: true };
      await setJobState(ctx.db, ctx.account.id, JOB_NAME, state);
    }

    for (const date of window.dates) {
      // 2 年のエラーより古い日は取れない（通常の回は残りすべて、取り直しの回は date 以前の日だけ）
      if (historyLimitDate !== undefined && date <= historyLimitDate) continue;
      assertSoftLimit(ctx);
      const day = await fetchAccountDay(ctx, date, { jobName: JOB_NAME, includeOnlineFollowers: false });
      if (day.historyLimit) {
        // その日は取らない。取り直せる失敗日が残っていれば done にせず、取り直しの回ならこの回でも新しい日を続ける
        historyLimitDate = date;
        state = finishByHistoryLimit(state, date);
        await setJobState(ctx.db, ctx.account.id, JOB_NAME, state);
        continue;
      }
      const written = await ctx.db.begin((tx) => upsertAccountDailyMetrics(tx, day.rows));
      ctx.progress.items += written;
      if (day.failed && day.errorCodes.includes(100) && date < warnBefore) {
        ctx.log.warn({ job: JOB_NAME, date, warn: "2 年の判定に失敗した可能性", error_code: 100, class: "fatal" });
      }
      state = advanceBackfillState(state, date, day.failed, window.retry);
      processed += 1;
      await setJobState(ctx.db, ctx.account.id, JOB_NAME, state);
    }

    const exhausted = state.failed_dates.filter((f) => f.attempts >= BACKFILL_MAX_ATTEMPTS).length;
    if (state.done && exhausted > 0) {
      ctx.log.warn({ job: JOB_NAME, warn: "取り直しを使い切った日が残っている", failed_dates: exhausted });
    }
    ctx.log.info({
      job: JOB_NAME,
      days: processed,
      retry: window.retry,
      next_date: state.next_date,
      days_done: state.days_done,
      failed_dates: state.failed_dates.length,
      done: state.done,
      reason: historyLimitDate === undefined ? undefined : "2 年より前",
    });
  },
};

/**
 * `account_daily` ジョブ（設計 5.2 章、13.2 章）。
 *
 * ジョブ開始時刻の PT の日付を D として、D−days〜D−1（既定 4 日。`--days N`）を古い順に `fetchAccountDay` で取り、
 * 1 日分を 1 トランザクションで upsert する。続けて follower_count（直近 30 日。V5）を 1 回取って upsert する。
 * 反映遅延が最大 48 時間あるため毎回取り直して上書きする。失敗した日やグループは `recordFailure`（`partial`）。
 *
 * `online_followers` は `fetchAccountDay` の中で 1 日 1 回取る（設計 13.2 章）
 */
import { upsertAccountDailyMetrics } from "../db/account-daily.js";
import type { AccountDailyMetricRow } from "../db/types.js";
import { addDays, metricDateFromEndTime, PT, zonedDate, zonedMidnightUtc } from "../lib/time.js";
import { fetchAccountDay, toMetricValue, type InsightsResponse } from "./account-metrics.js";
import type { JobContext, JobDefinition } from "./framework.js";

const JOB_NAME = "account_daily";

/** `--days` の既定。daily を 1 日欠かしても、どの日も「閉じてから 48 時間以上後」に 1 回は取り直される（設計 5.2 章） */
export const DEFAULT_DAYS = 4;

export const FOLLOWER_COUNT_METRIC = "follower_count";

/** follower_count の窓の始まり（D−29 の PT 0 時。30 日分）。`now − 30×86400` にしないのは夏時間の切り替えのため */
export const FOLLOWER_COUNT_DAYS_BACK = 29;

/** 2 年より前の日付を `account_daily` が要求してしまったとき（通常は起きない）の失敗の文言 */
const HISTORY_LIMIT_FAILURE = "2 年より前の日付は取得できない";

export interface ToFollowerCountRowsArgs {
  accountId: string;
  body: InsightsResponse | undefined;
  fetchedAt: Date;
  rawResponseId: string | undefined;
}

/**
 * follower_count（time_series）のレスポンスを行にする（純粋関数）。
 * `values[]` の各要素を `(metricDateFromEndTime(end_time), 'follower_count', '', '', value)` に。
 * `value` がない、または数値でなければ null。`end_time` がない、または読めない要素は飛ばす
 */
export function toFollowerCountRows(args: ToFollowerCountRowsArgs): AccountDailyMetricRow[] {
  const data = args.body?.data;
  const item = Array.isArray(data) ? data.find((i) => i?.name === FOLLOWER_COUNT_METRIC) : undefined;
  const values = Array.isArray(item?.values) ? item.values : [];
  const rows: AccountDailyMetricRow[] = [];
  for (const entry of values) {
    if (typeof entry?.end_time !== "string") continue;
    let metricDate: string;
    try {
      metricDate = metricDateFromEndTime(entry.end_time);
    } catch {
      continue;
    }
    rows.push({
      account_id: args.accountId,
      metric_date: metricDate,
      metric: FOLLOWER_COUNT_METRIC,
      breakdown: "",
      breakdown_value: "",
      value: toMetricValue(entry.value),
      fetched_at: args.fetchedAt,
      raw_response_id: args.rawResponseId ?? null,
    });
  }
  return rows;
}

/** `--days` の値。省略時は既定。1 以上の整数でなければ例外（段階 3 の引数の読み取りで弾く想定の二重の防御） */
export function resolveDays(days: number | undefined): number {
  if (days === undefined) return DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1) throw new Error("--days は 1 以上の整数");
  return days;
}

/** follower_count を 1 回取って upsert し、書いた行数を返す。失敗は `recordFailure` して 0 */
async function fetchFollowerCount(ctx: JobContext, today: string): Promise<number> {
  const since = Math.floor(zonedMidnightUtc(addDays(today, -FOLLOWER_COUNT_DAYS_BACK), PT).getTime() / 1000);
  const until = Math.floor(ctx.startedAt.getTime() / 1000);
  const res = await ctx.graph.get<InsightsResponse>(`${ctx.account.ig_user_id}/insights`, {
    metric: FOLLOWER_COUNT_METRIC,
    period: "day",
    since,
    until,
  });
  if (!res.ok) {
    ctx.recordFailure({
      code: res.error?.code,
      errorClass: res.errorClass ?? "unknown",
      message: res.error?.message ?? "不明なエラー",
    });
    return 0;
  }
  const rows = toFollowerCountRows({ accountId: ctx.account.id, body: res.data, fetchedAt: res.fetchedAt, rawResponseId: res.rawResponseId });
  return ctx.db.begin((tx) => upsertAccountDailyMetrics(tx, rows));
}

export const job: JobDefinition = {
  name: JOB_NAME,
  async run(ctx) {
    const days = resolveDays(ctx.options.days);
    // 「今日」は開始時刻から 1 回だけ（設計 5.0 章）
    const today = zonedDate(ctx.startedAt, PT);
    const from = addDays(today, -days);
    const to = addDays(today, -1);

    for (let offset = days; offset >= 1; offset -= 1) {
      const date = addDays(today, -offset);
      const day = await fetchAccountDay(ctx, date, { jobName: JOB_NAME });
      if (day.historyLimit) {
        ctx.recordFailure({ code: 100, errorClass: "fatal", message: HISTORY_LIMIT_FAILURE });
        continue;
      }
      const written = await ctx.db.begin((tx) => upsertAccountDailyMetrics(tx, day.rows));
      ctx.progress.items += written;
    }

    const followerDays = await fetchFollowerCount(ctx, today);
    ctx.progress.items += followerDays;
    ctx.log.info({ job: JOB_NAME, days, from, to, follower_days: followerDays });
  },
};

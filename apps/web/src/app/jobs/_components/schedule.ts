/**
 * 収集スケジュールの定数と、実行結果の表示の段階（R3 設計 3.6 節）。純粋関数だけ。
 *
 * 起動は Supabase の pg_cron が毎時 17 分（UTC）に GitHub Actions の collect.yml を workflow_dispatch で呼ぶ
 * （supabase/migrations/20261003000000_r2_collect_dispatch.sql）。UTC 20 時台（日本時間 5 時台）の回だけ daily のジョブも動く。
 * ジョブの組は apps/worker/src/jobs/groups.ts の HOURLY_JOBS と DAILY_JOBS。どちらかを変えたらここも合わせる。
 */
import type { JobName } from "@/lib/format";

/** 毎時の起動の分（UTC。日本時間でも同じ分） */
export const COLLECT_MINUTE_UTC = 17;

const HOURLY = `毎時 ${COLLECT_MINUTE_UTC} 分ごろ`;
const DAILY = `毎日 5:${COLLECT_MINUTE_UTC} ごろ`;

/** ジョブごとの予定（日本時間）。キーは `JOB_ORDER` と同じ一覧（`parseJob` の許可リスト） */
export const JOB_SCHEDULE = {
  token_check: DAILY,
  profile_daily: DAILY,
  account_daily: DAILY,
  media_sync: `${HOURLY}（5 時台は全件）`,
  media_snapshot: HOURLY,
  video_analysis: HOURLY,
  stories: HOURLY,
  account_backfill: HOURLY,
} as const satisfies Record<JobName, string>;

/** 連続失敗の通知のしきい値（apps/worker/src/jobs/alerts.ts の `STORIES_FAILED_RUNS`。stories だけが対象） */
export const ALERT_FAILED_RUNS = 2;

/** 次の起動の予定時刻（`now` より後の、UTC の分が 17 の時刻） */
export function nextCollectAt(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(COLLECT_MINUTE_UTC);
  if (next.getTime() <= now.getTime()) next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/** 結果の表示の段階（見本の 3 段階と実行中）。CSS の `.status[data-state]` の値 */
export type RunState = "ok" | "warn" | "bad" | "run";

/** `job_runs.status` を見本の段階に寄せる: success → 成功、partial と skipped → 注意、failed → 失敗、running → 実行中 */
export function runState(status: string): { state: RunState; label: string } {
  switch (status) {
    case "success":
      return { state: "ok", label: "成功" };
    case "partial":
    case "skipped":
      return { state: "warn", label: "注意" };
    case "failed":
      return { state: "bad", label: "失敗" };
    default:
      return { state: "run", label: "実行中" };
  }
}

/** データアクセス期限の全長（日。ページトークンのデータアクセス期限は約 90 日） */
export const DATA_ACCESS_SPAN_DAYS = 90;
/** 期限の進み具合の段階: 14 日前から注意、7 日前から重大（3.6 節） */
export const EXPIRY_WARN_DAYS = 14;
export const EXPIRY_BAD_DAYS = 7;

export function expiryState(days: number): RunState {
  if (days < EXPIRY_BAD_DAYS) return "bad";
  if (days < EXPIRY_WARN_DAYS) return "warn";
  return "ok";
}

/** トークンの期限とデータアクセス期限のうち早いほう。どちらもなければ null */
export function earliestExpiry(tokenExpiresAt: Date | null, dataAccessExpiresAt: Date | null): Date | null {
  if (tokenExpiresAt === null) return dataAccessExpiresAt;
  if (dataAccessExpiresAt === null) return tokenExpiresAt;
  return tokenExpiresAt.getTime() <= dataAccessExpiresAt.getTime() ? tokenExpiresAt : dataAccessExpiresAt;
}

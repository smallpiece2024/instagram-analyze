/**
 * ジョブのグループ（設計 1.1 章、6.1 章）。グループの中のジョブは直列に動き、前のジョブが失敗しても次に進む。
 *
 * 実行順（設計 6.1 章）:
 * - hourly（毎時 `WORKER_HOURLY_MINUTE` 分）: `stories` → `media_sync` → `media_snapshot` → `account_backfill`
 *   （ストーリーズは消えるので最優先。投稿一覧を先に同期してから新しい投稿のスナップショットを取る。
 *   バックフィルは余ったレート制限で進める）
 * - daily（JST `WORKER_DAILY_TIME_JST`）: `token_check` → `profile_daily` → `account_daily` → `media_sync --full`
 *   （トークンの状態を先に更新する。残りは独立）
 *
 * 各ジョブは `export const job` だけを出し、ここで順番と options（`media_sync --full`）を決める。
 */
import { job as accountBackfillJob } from "./account-backfill.js";
import { job as accountDailyJob } from "./account-daily.js";
import { describeError, runJobsForActiveAccounts, type JobDefinition, type JobDeps, type JobOptions } from "./framework.js";
import { job as mediaSnapshotJob } from "./media-snapshot.js";
import { job as mediaSyncJob } from "./media-sync.js";
import { job as profileDailyJob } from "./profile-daily.js";
import { job as storiesJob } from "./stories.js";
import { job as tokenCheckJob } from "./token-check.js";

export type GroupName = "hourly" | "daily";

export interface GroupEntry {
  def: JobDefinition;
  /** `media_sync --full` のようにコマンドラインの指定に相当するもの */
  options?: JobOptions;
}

/** hourly グループ（毎時 `WORKER_HOURLY_MINUTE` 分） */
export const HOURLY_JOBS: GroupEntry[] = [
  { def: storiesJob },
  { def: mediaSyncJob },
  { def: mediaSnapshotJob },
  { def: accountBackfillJob },
];

/** daily グループ（JST `WORKER_DAILY_TIME_JST`）。投稿一覧は全ページを読んで消失判定も行う */
export const DAILY_JOBS: GroupEntry[] = [
  { def: tokenCheckJob },
  { def: profileDailyJob },
  { def: accountDailyJob },
  { def: mediaSyncJob, options: { full: true } },
];

/**
 * グループのジョブを順に実行する。各ジョブは `runJobsForActiveAccounts`（全アカウント）で動かし、
 * 途中で失敗しても次に進む。1 つでも `failed`（のアカウントがあるジョブ）があれば false（`partial` と `skipped` は
 * 失敗に数えない。設計 1.1 章）。開始と終了を `info` で 1 行ずつ出す（設計 8.1 章）。
 * `signal` が abort されていれば、次のジョブから先を飛ばして `warn`（`status=aborted remaining=N`）を出す
 * （実行中の 1 ジョブは最後まで走る）。`runJobs` はテスト用の差し替え
 */
export async function runGroup(
  name: GroupName,
  entries: GroupEntry[],
  deps: JobDeps,
  runJobs: typeof runJobsForActiveAccounts = runJobsForActiveAccounts,
  signal?: AbortSignal,
): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  deps.log.info({ group: name, status: "start", jobs: entries.length });
  let failed = 0;
  let aborted = false;
  for (const [index, entry] of entries.entries()) {
    if (signal?.aborted) {
      aborted = true;
      deps.log.warn({ group: name, status: "aborted", remaining: entries.length - index });
      break;
    }
    try {
      if (!(await runJobs(entry.def, deps, entry.options ?? {}))) failed += 1;
    } catch (error) {
      // runJobsForActiveAccounts は例外を投げない設計だが、万一のときも次のジョブに進む
      failed += 1;
      const failure = describeError(error, deps.secrets);
      deps.log.warn({ group: name, job: entry.def.name, status: "failed", error_code: failure.code ?? "none", class: failure.errorClass });
      deps.log.debug({ group: name, job: entry.def.name, error: failure.message });
    }
  }
  deps.log.info({
    group: name,
    status: failed > 0 ? "failed" : aborted ? "aborted" : "success",
    jobs: entries.length,
    failed,
    duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
  });
  return failed === 0;
}

/**
 * 投稿指標のスナップショット（設計 5.5 章、9.1 章）。
 *
 * `FEED` と `REELS` の投稿（`gone_at` が null）のうち、`isSnapshotDue` が true のものを新しい順に処理する。
 * 1 投稿につき `fetchMediaInsights`（API 1〜2 回）→ `media_insight_snapshots` に 1 行（短いトランザクション）。
 * 取得の間隔は前回のスナップショット時点の経過時間で決まり、表には予定を持たない（DB 設計 3.6 章）。
 *
 * ストーリーズは `jobs/stories.ts` が扱う（間隔の規則を使わず毎回 1 行）。
 * `index.ts` への登録は段階 3 で行う。
 */
import { insertSnapshot, listSnapshotCandidates } from "../db/snapshots.js";
import { elapsedSeconds } from "../lib/time.js";
import type { JobDefinition } from "./framework.js";
import { fetchMediaInsights } from "./media-metrics.js";

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/** 実行時刻のゆれの吸収（設計 5.5 章）。前回から「間隔 − 10 分」以上経っていれば対象にする */
export const SNAPSHOT_GRACE_SECONDS = 10 * 60;

/**
 * 前回のスナップショット時点の経過時間（秒）から、次のスナップショットまでの間隔（秒）を決める。
 * 境界は「まで」を含む（≤）: 24 時間ちょうどなら 1 時間、24 時間 + 1 秒なら 1 日。
 *
 * | 前回時点の経過時間 | 間隔 |
 * |---|---|
 * | 24 時間まで | 1 時間 |
 * | 30 日まで | 1 日 |
 * | 90 日まで | 7 日 |
 * | 90 日超 | 30 日 |
 */
export function snapshotIntervalFor(elapsedSecondsAtLast: number): number {
  if (elapsedSecondsAtLast <= 24 * HOUR_SECONDS) return HOUR_SECONDS;
  if (elapsedSecondsAtLast <= 30 * DAY_SECONDS) return DAY_SECONDS;
  if (elapsedSecondsAtLast <= 90 * DAY_SECONDS) return 7 * DAY_SECONDS;
  return 30 * DAY_SECONDS;
}

/**
 * 今回スナップショットを取るべきか（純粋関数）。
 * - `postedAt` が `now` より後（時計のずれ）→ false
 * - スナップショットがない → true（初回の取り込み。F-COL-14）
 * - `lastFetchedAt` が `now` より後（時計のずれ）→ false
 * - それ以外は、前回時点の経過時間で決めた間隔から 10 分を引いた時間が、前回から経っていれば true
 *
 * 間隔を「前回時点」で決めるので、境目をまたいだ直後の取得を落とさない（前回 23 時間なら 24 時間時点で取り、
 * その次は 24 時間時点が前回になって 1 日後）。停止後の再開でも前回の時点で決まる（前回 20 時間、再開が 5 日後
 * なら間隔 1 時間で即対象。その次は 5 日時点が前回になって 1 日後）
 */
export function isSnapshotDue(postedAt: Date, lastFetchedAt: Date | null, now: Date): boolean {
  if (postedAt.getTime() > now.getTime()) return false;
  if (lastFetchedAt === null) return true;
  if (lastFetchedAt.getTime() > now.getTime()) return false;
  const interval = snapshotIntervalFor(elapsedSeconds(postedAt, lastFetchedAt));
  const sinceLastMs = now.getTime() - lastFetchedAt.getTime();
  return sinceLastMs >= (interval - SNAPSHOT_GRACE_SECONDS) * 1000;
}

export const job: JobDefinition = {
  name: "media_snapshot",
  async run(ctx) {
    const candidates = await listSnapshotCandidates(ctx.db, ctx.account.id, ["FEED", "REELS"]);
    // 選定の時刻は 1 回だけ求める（処理中に時間が経っても対象は変わらない）
    const now = ctx.now();
    const due = candidates.filter((m) => isSnapshotDue(m.posted_at, m.last_fetched_at, now));
    let written = 0;

    for (const [index, media] of due.entries()) {
      const result = await fetchMediaInsights(ctx, media);
      // transient（再試行を使い切った）は行を書かず、次回の対象にする。recordFailure は fetchMediaInsights 内で済んでいる
      if (result.rawResponseId === undefined) continue;
      const rawResponseId = result.rawResponseId;
      const inserted = await ctx.db.begin((tx) =>
        insertSnapshot(tx, {
          media_id: media.id,
          fetched_at: result.fetchedAt,
          elapsed_seconds: elapsedSeconds(media.posted_at, result.fetchedAt),
          metrics: result.metrics,
          raw_response_id: rawResponseId,
          job_run_id: ctx.jobRunId,
        }),
      );
      if (inserted) {
        ctx.progress.items += 1;
        written += 1;
      }
      ctx.log.debug({ job: "media_snapshot", progress: `${index + 1}/${due.length}` });
    }

    ctx.log.info({ job: "media_snapshot", candidates: candidates.length, due: due.length, written });
  },
};

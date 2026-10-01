/**
 * レート制限の監視（設計 7.2 章）。
 * 呼び出しごとにヘッダから使用率を更新し、しきい値以上なら `RateLimitExceeded` でジョブを止める。
 */

import { parseRateUsage, type RateLimitHeaders, type RateUsage } from "../lib/graph.js";

export type { RateUsage } from "../lib/graph.js";

export class RateMonitor {
  private current: RateUsage | undefined;

  /** `initial` は直近 1 時間の `job_runs.rate_usage`、またはグループ内の前のジョブの最終値 */
  constructor(initial?: RateUsage) {
    this.current = initial;
  }

  /** ヘッダから読めた使用率で置き換える。ヘッダがない（読めない）ときは前の値を保つ */
  update(headers: RateLimitHeaders): void {
    const usage = parseRateUsage(headers);
    if (usage) this.current = usage;
  }

  /** `job_runs.rate_usage` に入れる値。まだ何も読めていなければ undefined */
  usage(): RateUsage | undefined {
    return this.current;
  }

  /** 3 つの百分率の最大。まだ何も読めていなければ 0 */
  percent(): number {
    const u = this.current;
    return u ? Math.max(u.call_count, u.total_cputime, u.total_time) : 0;
  }

  /** 使用率がしきい値（%）以上か */
  exceeds(threshold: number): boolean {
    return this.percent() >= threshold;
  }
}

/** レート制限でジョブを止めるときに投げる。`message` は固定文言で、`job_runs.error` にそのまま入れられる */
export class RateLimitExceeded extends Error {
  override readonly name = "RateLimitExceeded";

  constructor(
    message: string,
    /** ヘッダの `estimated_time_to_regain_access`（分）。あるときだけ */
    readonly estimatedMinutes?: number,
  ) {
    super(message);
  }

  /** 使用率がしきい値以上だったとき */
  static forUsage(percent: number, threshold: number, estimatedMinutes?: number): RateLimitExceeded {
    return new RateLimitExceeded(
      `レート制限の使用率がしきい値を超えた（使用率 ${percent}%、しきい値 ${threshold}%）`,
      estimatedMinutes,
    );
  }

  /** Graph API がレート制限のエラー（分類 `rate`）を返したとき。`code` がなければ HTTP 429 */
  static forError(code: number | undefined, estimatedMinutes?: number): RateLimitExceeded {
    const label = code === undefined ? "HTTP 429" : `コード ${code}`;
    return new RateLimitExceeded(`レート制限のエラー（${label}）`, estimatedMinutes);
  }
}

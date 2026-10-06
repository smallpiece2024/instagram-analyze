/**
 * `daily-due`: 日次の収集（`run-daily`）を、この回でも動かすべきかを判定し、標準出力に `due=true` か `due=false` の 1 行だけを書く。
 * GitHub Actions では `>> "$GITHUB_OUTPUT"` でそのまま出力にする（ログは標準エラーに出す）。
 *
 * - 日次は JST 05 時台の回（pg_cron が `run_daily=true` を付ける）で動く。その回が GitHub の側で動かなかったとき
 *   （2026-10-06。ランナーが割り当てられず取り消し）、次の毎時の回で補うための判定
 * - `account_daily` が最後に `success` か `partial` で終わった実行の開始から 24 時間以上たっていれば due。記録がなくても due
 * - DB を読めなければ `due=false` を書き、終了コード 1（毎時の収集は止めない。ワークフローは continue-on-error）
 */
import { loadCheckAlertsConfig } from "../config.js";
import { closeDb, connectDb, normalizeDbError, type Db } from "../db/client.js";
import { latestCompletedStartedAt } from "../db/job-runs.js";
import { describeError, processSecrets } from "../jobs/framework.js";
import { createLogger } from "../lib/log.js";

export const COMMAND = "daily-due";

/** 前回の日次の成功からこの時間を過ぎたら、毎時の回でも日次を動かす */
export const DAILY_DUE_HOURS = 24;

/** 判定の純粋関数。前回がなければ due */
export function isDailyDue(lastCompletedAt: Date | undefined, now: Date): boolean {
  if (lastCompletedAt === undefined) return true;
  return now.getTime() - lastCompletedAt.getTime() >= DAILY_DUE_HOURS * 3600 * 1000;
}

/** `index.ts` から呼ぶ入口 */
export async function dailyDue(): Promise<boolean> {
  const config = loadCheckAlertsConfig();
  const secrets = processSecrets;
  secrets.addUrlParts(config.databaseUrl);
  const log = createLogger(config.logLevel, secrets, (line) => console.error(line));
  const out = (due: boolean) => console.log(`due=${due}`);
  let db: Db;
  try {
    db = connectDb(config.databaseUrl, { sslCa: config.databaseSslCa });
  } catch (error) {
    out(false);
    throw new Error(normalizeDbError(error));
  }
  try {
    const last = await latestCompletedStartedAt(db, "account_daily");
    const due = isDailyDue(last, new Date());
    log.info({ command: COMMAND, due, last_daily: last?.toISOString() ?? "none" });
    out(due);
    return true;
  } catch (error) {
    const failure = describeError(error, secrets);
    log.error({ command: COMMAND, error_code: failure.code ?? "none", class: failure.errorClass });
    out(false);
    return false;
  } finally {
    await closeDb(db);
  }
}

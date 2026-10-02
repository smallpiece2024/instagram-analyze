/**
 * `check-alerts --scope hourly|daily`: トークンの期限と `stories` の連続失敗・見送りを調べ、該当があれば終了コード 1
 * （R2 設計 5.2 章。F-SYS-14、NF-REL-03）。GitHub Actions では `run-*` のあとに動かし、失敗メールで知らせる。
 *
 * - 判定は `jobs/alerts.ts` の純関数。ここは DB の読み出しとログだけ
 * - 読むのは `accounts`（active）、`private.credentials` の状態と期限（Vault には触れない）、`job_runs` の `stories` の直近 3 件
 * - ログ: 該当は全件 `WARN alert=…`、最後に必ず `INFO alerts=<n>`（履歴が足りなければ `reason=no_history`）。
 *   DB の失敗は `ERROR error_code=<SQLSTATE か TLS のコード> class=db` で終了コード 1（alert と区別できる）
 * - アカウントは `account=1/N` の連番。ID やユーザー名は出さない
 * - `WORKER_SIMULATE_ALERT=true` なら `alert=simulated` を出して終了コード 1（通知の経路の確認用）
 */
import { parseArgs } from "node:util";
import { loadCheckAlertsConfig, type CheckAlertsConfig } from "../config.js";
import { listActiveAccounts, readCredentialStatus } from "../db/accounts.js";
import { closeDb, connectDb, normalizeDbError, type Db } from "../db/client.js";
import { listRecentRuns } from "../db/job-runs.js";
import type { AccountRow } from "../db/types.js";
import { evaluateAlerts, STORIES_SKIPPED_RUNS, type Alert, type AlertAccount, type AlertScope } from "../jobs/alerts.js";
import { describeError, processSecrets } from "../jobs/framework.js";
import { createLogger, type LogFields, type Logger, type SecretRegistry } from "../lib/log.js";

export const COMMAND = "check-alerts";

/** 引数の不備の固定文言（値は含めない） */
export const SCOPE_ARG_ERROR = "引数が不正（--scope hourly|daily が必須）";

const NO_ERROR_CODE = "none";

export interface CheckAlertsDeps {
  config: Pick<CheckAlertsConfig, "simulateAlert">;
  db: Db;
  log: Logger;
  secrets: SecretRegistry;
  /** テスト用。省略時は `() => new Date()` */
  now?: () => Date;
  /** テスト用。対象のアカウント。省略時は `listActiveAccounts`。結合テストは架空のアカウントに固定する */
  listAccounts?: (db: Db) => Promise<AccountRow[]>;
}

export type ParsedScope = { ok: true; scope: AlertScope } | { ok: false; error: string };

/** `--scope hourly|daily` だけを受け付ける純粋関数。それ以外は固定文言のエラー */
export function parseScope(args: string[]): ParsedScope {
  let scope: string | undefined;
  try {
    ({ values: { scope } } = parseArgs({ args, options: { scope: { type: "string" } }, strict: true, allowPositionals: false }));
  } catch {
    return { ok: false, error: SCOPE_ARG_ERROR };
  }
  if (scope !== "hourly" && scope !== "daily") return { ok: false, error: SCOPE_ARG_ERROR };
  return { ok: true, scope };
}

/** ログの項目に直す純粋関数。`account=1/N` の連番だけで、ID は持ち込まない */
export function alertFields(alert: Alert): LogFields {
  switch (alert.kind) {
    case "simulated":
      return { alert: "simulated" };
    case "token":
      return { alert: "token", account: `${alert.ordinal}/${alert.total}`, days_left: alert.daysLeft, status: alert.status };
    case "stories_failed":
    case "stories_skipped":
      return { alert: alert.kind, account: `${alert.ordinal}/${alert.total}`, runs: alert.runs };
  }
}

/** アカウントごとに credential の状態と `stories` の直近の実行を読む。接続は 2 本なので順に読む */
export async function loadAlertAccounts(db: Db, accounts: AccountRow[]): Promise<AlertAccount[]> {
  const out: AlertAccount[] = [];
  for (const [index, account] of accounts.entries()) {
    const credential = await readCredentialStatus(db, account.id);
    const runs = await listRecentRuns(db, account.id, "stories", STORIES_SKIPPED_RUNS);
    out.push({
      ordinal: index + 1,
      status: account.status,
      credential: credential ? { status: credential.status, dataAccessExpiresAt: credential.data_access_expires_at } : null,
      recentStoriesRuns: runs.map((run) => ({ status: run.status })),
    });
  }
  return out;
}

/** 判定して記録する。該当がなく DB も読めれば true。`deps` はテストで差し替える */
export async function runCheckAlerts(scope: AlertScope, deps: CheckAlertsDeps): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  let accounts: AlertAccount[];
  try {
    const rows = await (deps.listAccounts ?? listActiveAccounts)(deps.db);
    accounts = await loadAlertAccounts(deps.db, rows);
  } catch (error) {
    const failure = describeError(error, deps.secrets);
    deps.log.error({ command: COMMAND, scope, error_code: failure.code ?? NO_ERROR_CODE, class: failure.errorClass });
    deps.log.debug({ command: COMMAND, scope, error: failure.message });
    return false;
  }
  const result = evaluateAlerts({ accounts }, now(), scope, deps.config.simulateAlert);
  for (const alert of result.alerts) deps.log.warn(alertFields(alert));
  deps.log.info({
    command: COMMAND,
    scope,
    accounts: accounts.length,
    alerts: result.alerts.length,
    reason: result.noHistory ? "no_history" : undefined,
  });
  return result.alerts.length === 0;
}

/** `index.ts` から呼ぶ入口。設定を読み、DB につなぎ、閉じる */
export async function checkAlerts(args: string[]): Promise<boolean> {
  const parsed = parseScope(args);
  if (!parsed.ok) throw new Error(parsed.error);
  const config = loadCheckAlertsConfig();
  const secrets = processSecrets;
  secrets.addUrlParts(config.databaseUrl);
  const log = createLogger(config.logLevel, secrets);
  let db: Db;
  try {
    db = connectDb(config.databaseUrl, { sslCa: config.databaseSslCa });
  } catch (error) {
    // 不正な URL は同期的に TypeError（message と input に接続文字列を含みうる）。固定文言だけにする
    throw new Error(normalizeDbError(error));
  }
  try {
    return await runCheckAlerts(parsed.scope, { config, db, log, secrets });
  } finally {
    await closeDb(db);
  }
}

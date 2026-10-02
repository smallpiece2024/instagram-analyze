/**
 * `check-alerts` の判定（R2 設計 5.2 章）。純粋関数で I/O なし。DB の読み出しは `commands/check-alerts.ts` が行う。
 *
 * ジョブの `status` を歪めずに「人が見るべき状態」を終了コードで知らせるためのもの。
 *
 * | 判定 | scope | 条件 |
 * |---|---|---|
 * | `simulated` | 両方 | `simulate` が true（`WORKER_SIMULATE_ALERT=true`） |
 * | `token` | daily のみ | `active` のアカウントで、credential がない、`status <> 'valid'`、または残り日数が 14 日未満（`token_check` と同じ計算。14 日ちょうどは警告しない） |
 * | `stories_failed` | 両方（daily の回も hourly を含む） | `stories` の直近 2 回（`running` を除く）がどちらも `failed`（`partial`／`skipped` は数えない） |
 * | `stories_skipped` | 両方 | `stories` の直近 3 回がすべて `skipped` |
 * | 履歴なし | 両方 | `stories` の記録が 2 回に満たない → 判定しない（`noHistory`） |
 *
 * アカウントは `ordinal/total` の連番で表し、ID やユーザー名は持ち込まない
 */
import { DATA_ACCESS_WARN_DAYS, daysLeft } from "./token-check.js";

export type AlertScope = "hourly" | "daily";

export interface AlertCredential {
  /** `private.credentials.status` */
  status: string;
  dataAccessExpiresAt: Date | null;
}

export interface AlertAccount {
  /** 1 始まりの連番（ログの `account=1/N`） */
  ordinal: number;
  /** `accounts.status`。`active` 以外は判定しない */
  status: string;
  credential: AlertCredential | null;
  /** `stories` の直近の実行。`started_at desc`、最大 3 件。`running` が混じっていても除く */
  recentStoriesRuns: { status: string }[];
}

export interface AlertInput {
  accounts: AlertAccount[];
}

export type Alert =
  | { kind: "simulated" }
  | { kind: "token"; ordinal: number; total: number; daysLeft: number | undefined; status: string }
  | { kind: "stories_failed"; ordinal: number; total: number; runs: number }
  | { kind: "stories_skipped"; ordinal: number; total: number; runs: number };

export interface AlertEvaluation {
  alerts: Alert[];
  /** `stories` の履歴が足りない `active` のアカウントがあり、判定を見送った（`reason=no_history`） */
  noHistory: boolean;
}

/** `stories_failed` に必要な連続回数 */
export const STORIES_FAILED_RUNS = 2;
/** `stories_skipped` に必要な連続回数 */
export const STORIES_SKIPPED_RUNS = 3;
/** credential がないときの `status=` の表示 */
export const NO_CREDENTIAL_STATUS = "none";

function evaluateToken(account: AlertAccount, total: number, now: Date): Alert | undefined {
  const { ordinal, credential } = account;
  if (credential === null) {
    return { kind: "token", ordinal, total, daysLeft: undefined, status: NO_CREDENTIAL_STATUS };
  }
  const left = daysLeft(credential.dataAccessExpiresAt, now);
  if (credential.status !== "valid") {
    return { kind: "token", ordinal, total, daysLeft: left, status: credential.status };
  }
  // 期限が不明（null）はページトークンでは起きないはずなので、分からないまま黙らず警告する（フェイルクローズ。days_left=unknown）
  if (left === undefined || left < DATA_ACCESS_WARN_DAYS) {
    return { kind: "token", ordinal, total, daysLeft: left, status: credential.status };
  }
  return undefined;
}

function evaluateStories(account: AlertAccount, total: number): { alert: Alert | undefined; noHistory: boolean } {
  const { ordinal } = account;
  const runs = account.recentStoriesRuns.filter((run) => run.status !== "running").slice(0, STORIES_SKIPPED_RUNS);
  if (runs.length < STORIES_FAILED_RUNS) return { alert: undefined, noHistory: true };
  if (runs.slice(0, STORIES_FAILED_RUNS).every((run) => run.status === "failed")) {
    return { alert: { kind: "stories_failed", ordinal, total, runs: STORIES_FAILED_RUNS }, noHistory: false };
  }
  if (runs.length >= STORIES_SKIPPED_RUNS && runs.every((run) => run.status === "skipped")) {
    return { alert: { kind: "stories_skipped", ordinal, total, runs: STORIES_SKIPPED_RUNS }, noHistory: false };
  }
  return { alert: undefined, noHistory: false };
}

/**
 * 判定の本体。`now` は残り日数の基準（UTC、切り捨て）。`simulate` が true なら先頭に `simulated` を足す
 * （本物の判定も続けて行う）。入力は変更しない
 */
export function evaluateAlerts(input: AlertInput, now: Date, scope: AlertScope, simulate: boolean): AlertEvaluation {
  const alerts: Alert[] = [];
  let noHistory = false;
  if (simulate) alerts.push({ kind: "simulated" });
  const total = input.accounts.length;
  for (const account of input.accounts) {
    if (account.status !== "active") continue;
    if (scope === "daily") {
      const token = evaluateToken(account, total, now);
      if (token) alerts.push(token);
    }
    const stories = evaluateStories(account, total);
    if (stories.alert) alerts.push(stories.alert);
    if (stories.noHistory) noHistory = true;
  }
  return { alerts, noHistory };
}

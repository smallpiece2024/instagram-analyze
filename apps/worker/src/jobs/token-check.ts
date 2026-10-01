/**
 * `token_check` ジョブ: トークンの期限と状態を確かめて `private.credentials` を更新する（設計 4.2 章、13.2 章）。
 *
 * - `ctx.graph.debugToken()` を 1 回呼ぶ（アプリトークンで。生レスポンスは保存しない）。ジョブはトークンの値に触れない
 * - 結果の判定は純粋関数 `evaluateDebugToken` で行い、`private.credentials` の更新内容（`CredentialPatch`）を返す
 * - `private.credentials.last_error` は固定文言だけ（トークンや Graph のエラー文を入れない）
 * - `transient` と `fatal` は `recordFailure` だけ呼んで戻る。1 件のみなので枠組みの規則（`items` 0 かつ `failures`
 *   1 以上 → `failed`。設計 13.2 章）で `failed` になり、`job_runs.error` にはマスク済みの API の文言、ログの WARN 行には
 *   `error_code=` と `class=` が残る。`is_valid: false` と権限不足は確認が済んだので `success` にして `warn` の行を出す
 * - `index.ts` への登録は段階 3 で行う
 *
 * 条件ごとの振る舞い（設計 4.2 章の表）:
 *
 * | `debug_token` の結果 | `private.credentials` | ジョブ |
 * |---|---|---|
 * | `transient`（再試行後） | 触らない | `failed` |
 * | `fatal`（アプリシークレットの誤りなど） | `status = 'error'`、`last_error`、`last_checked_at` | `failed` |
 * | `is_valid: false`（`data` なしも含む） | `status = 'expired'`、`last_error`、期限、`last_checked_at` | `success`、`warn` |
 * | 必要な権限が足りない | `status = 'insufficient_scope'`、`scopes`、期限、`last_checked_at`、`last_error` | `success`、`warn` |
 * | 有効で権限も足りる | `status = 'valid'`、`scopes`、期限、`last_checked_at`、`last_error = null` | `success`。残り 14 日以下なら `warn` |
 */
import { toCredentialInfo } from "../commands/register-token.js";
import { updateCredentialStatus, type CredentialPatch } from "../db/accounts.js";
import type { JobDefinition } from "./framework.js";
import type { DebugTokenResponse, Tracked } from "./graph-client.js";

/** `is_valid: false` のときの `private.credentials.last_error` */
export const INVALID_TOKEN_ERROR = "トークンが無効（debug_token）";

/** `debug_token` が PAGE／USER 以外の種類を返したときの `private.credentials.last_error` */
export const UNSUPPORTED_TOKEN_TYPE_ERROR = "対応していないトークンの種類（debug_token）";

/** データアクセス期限の残りがこの日数以下なら `warn` の行を出す */
export const DATA_ACCESS_WARN_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TokenCheckOutcome = "transient" | "fatal" | "invalid" | "insufficient_scope" | "valid";

interface Evaluated<O extends TokenCheckOutcome, P> {
  outcome: O;
  /** `updateCredentialStatus` に渡す更新内容。`transient` は触らないので undefined */
  patch: P;
  /** データアクセス期限までの残り日数（切り捨て）。期限が分からなければ undefined */
  daysLeft: number | undefined;
  /** 足りない権限 */
  missing: string[];
}

/** `evaluateDebugToken` の結果。`fatal` の `patch` は `last_error` を必ず持つ（API のエラー文がないときの失敗の文言にもする） */
export type TokenCheckEvaluation =
  | Evaluated<"transient", undefined>
  | Evaluated<"fatal", CredentialPatch & { status: "error"; last_error: string }>
  | Evaluated<"invalid" | "insufficient_scope" | "valid", CredentialPatch>;

/** UNIX 秒を `Date` に。0、undefined、数値でないものは null（期限なし／不明） */
function unixToDate(seconds: unknown): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

/** 残り日数（切り捨て）。期限が分からなければ undefined。過ぎていれば負の値 */
function daysLeft(until: Date | null, now: Date): number | undefined {
  return until ? Math.floor((until.getTime() - now.getTime()) / DAY_MS) : undefined;
}

/**
 * `debug_token` の結果から `private.credentials` の更新内容を決める純粋関数（設計 4.2 章の表）。
 * `now` は `last_checked_at` と残り日数の基準。`last_error` は固定文言だけで、トークンや URL、Graph のエラー文を含めない
 */
export function evaluateDebugToken(res: Tracked<DebugTokenResponse>, now: Date): TokenCheckEvaluation {
  if (!res.ok) {
    if (res.errorClass === "transient") {
      return { outcome: "transient", patch: undefined, daysLeft: undefined, missing: [] };
    }
    const code = res.error?.code;
    return {
      outcome: "fatal",
      patch: { status: "error", last_error: `debug_token に失敗（コード ${code ?? "なし"}）`, last_checked_at: now },
      daysLeft: undefined,
      missing: [],
    };
  }

  const data = res.data?.data;
  if (!data || data.is_valid !== true) {
    const dataAccessExpiresAt = unixToDate(data?.data_access_expires_at);
    return {
      outcome: "invalid",
      patch: {
        status: "expired",
        last_error: INVALID_TOKEN_ERROR,
        expires_at: unixToDate(data?.expires_at),
        data_access_expires_at: dataAccessExpiresAt,
        last_checked_at: now,
      },
      daysLeft: daysLeft(dataAccessExpiresAt, now),
      missing: [],
    };
  }

  const parsed = toCredentialInfo(data);
  if (!parsed) {
    // 登録時に PAGE／USER だったものが別の種類で返ることはないはずなので、設定の誤りとして `error` にする
    return {
      outcome: "fatal",
      patch: { status: "error", last_error: UNSUPPORTED_TOKEN_TYPE_ERROR, last_checked_at: now },
      daysLeft: undefined,
      missing: [],
    };
  }

  const { credential, missing } = parsed;
  const base: CredentialPatch = {
    scopes: credential.scopes,
    expires_at: credential.expires_at,
    data_access_expires_at: credential.data_access_expires_at,
    last_checked_at: now,
  };
  const left = daysLeft(credential.data_access_expires_at, now);
  if (missing.length > 0) {
    return {
      outcome: "insufficient_scope",
      patch: { ...base, status: "insufficient_scope", last_error: `権限が足りない（${missing.join(",")}）` },
      daysLeft: left,
      missing,
    };
  }
  return {
    outcome: "valid",
    patch: { ...base, status: "valid", last_error: null },
    daysLeft: left,
    missing: [],
  };
}

export const job: JobDefinition = {
  name: "token_check",
  async run(ctx) {
    const res = await ctx.graph.debugToken();
    const result = evaluateDebugToken(res, ctx.now());

    // transient と fatal は 1 件のみなので、枠組みの規則で failed になる（例外は投げない）
    if (result.outcome === "transient") {
      ctx.recordFailure({
        code: res.error?.code,
        errorClass: "transient",
        message: res.error?.message ?? "不明なエラー",
      });
      return;
    }
    if (result.outcome === "fatal") {
      await updateCredentialStatus(ctx.db, ctx.account.id, result.patch);
      ctx.recordFailure({
        code: res.error?.code,
        errorClass: res.errorClass ?? "fatal",
        message: res.error?.message ?? result.patch.last_error,
      });
      return;
    }

    await updateCredentialStatus(ctx.db, ctx.account.id, result.patch);
    ctx.progress.items += 1;

    const status = result.patch.status;
    if (result.outcome === "invalid" || result.outcome === "insufficient_scope") {
      ctx.log.warn({
        job: "token_check",
        credential_status: status,
        missing_scopes: result.missing.length > 0 ? result.missing.join(",") : undefined,
        data_access_days_left: result.daysLeft,
      });
      return;
    }
    const fields = { job: "token_check", credential_status: status, data_access_days_left: result.daysLeft };
    if (result.daysLeft !== undefined && result.daysLeft <= DATA_ACCESS_WARN_DAYS) {
      ctx.log.warn({ ...fields, hint: "データアクセス期限が近い。再承認して register-token をやり直す" });
    } else {
      ctx.log.info(fields);
    }
  },
};

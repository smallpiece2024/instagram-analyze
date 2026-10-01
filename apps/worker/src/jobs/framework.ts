/**
 * ジョブ共通の枠組み（設計 1.2 章、1.5 章、1.6 章、4.3 章、8.1 章、10.2 章）。
 *
 * ジョブは `JobDefinition`（名前と実行関数）だけを書き、`runJob` が実行記録、二重起動の防止、認証情報の読み込み、
 * 生レスポンスの保存、レート制限、状態の決定、失効の検出、エラーの隔離、ログを共通に行う。
 *
 * 接続は `max: 2`。`runJob` が `db.reserve()` で 1 本をアドバイザリロック用に固定するので、ジョブが使える接続は
 * 残り 1 本だけになる。**`ctx.db.begin(tx => ...)` の中で `ctx.db`、`ctx.graph.get`、`insertRawResponse`、別の
 * `begin` を使うと、空き接続を待ち続けて止まる（エラーにはならない）**。`begin` の中では渡された `tx` だけを使い、
 * API の呼び出し（生レスポンスの保存を含む）と `job_runs` の更新はトランザクションの外で行うこと。
 *
 * 秘密の一覧はプロセスに 1 つ（`processSecrets`）。`createJobDeps` が設定値を登録し、`runJob` が Vault から読んだ
 * トークンを登録する。`index.ts` のプロセスの保険（`unhandledRejection` など）も同じ一覧でマスクする。
 */
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActiveAccounts, readCredential, updateCredentialStatus } from "../db/accounts.js";
import { closeDb, connectDb, normalizeDbError, type Db, type ReservedSql } from "../db/client.js";
import { failRunningRuns, finishJobRun, latestRateUsage, startJobRun, tryLock, unlock } from "../db/job-runs.js";
import { insertRawResponse } from "../db/raw.js";
import type { AccountRow, JobName, JobStatus } from "../db/types.js";
import type { WorkerConfig } from "../config.js";
import { DownloadError } from "../lib/download.js";
import { GraphClient } from "../lib/graph.js";
import { createLogger, sanitizeForLog, SecretRegistry, type Logger, type LogFields } from "../lib/log.js";
import { AuthError, authErrorMessage, createJobGraphClient, type JobGraphClient } from "./graph-client.js";
import { RateLimitExceeded, RateMonitor } from "./rate.js";

export type { JobName, JobStatus } from "../db/types.js";

/**
 * プロセスに 1 つの秘密の一覧。`createJobDeps` が設定値を、`runJob` が Vault のトークンを登録する。
 * `index.ts` のプロセスの保険はこれで `sanitizeForLog` する（設定を読む前は空で、パターンだけが効く）
 */
export const processSecrets = new SecretRegistry();

/**
 * 一時ディレクトリの接頭辞。各処理の `mkdtemp` は `join(tmpdir(), TMP_DIR_PREFIX + "video-")` のようにこれで始め、
 * `finally` で消す。起動時の掃除（`cleanOldTempDirs`）はこの接頭辞のものだけを対象にする
 */
export const TMP_DIR_PREFIX = "instagram-worker-";

/** 起動時の掃除で消す一時ディレクトリの古さ */
const TMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `runJob` の戻り値。`job_runs.status` の終了時の値 */
export type JobOutcome = Exclude<JobStatus, "running">;

export interface JobDeps {
  db: Db;
  config: WorkerConfig;
  log: Logger;
  secrets: SecretRegistry;
  /** テスト用。省略時はグローバルの `fetch` */
  fetchImpl?: typeof fetch;
  /** テスト用。省略時は `() => new Date()` */
  now?: () => Date;
  /** テスト用。再試行の待ち。省略時は実際に待つ */
  sleep?: (ms: number) => Promise<void>;
  /** テスト用。`runJobsForActiveAccounts` の対象の一覧。省略時は `listActiveAccounts` */
  listAccounts?: (db: Db) => Promise<AccountRow[]>;
}

/** コマンドラインの `--full`、`--days` */
export interface JobOptions {
  full?: boolean;
  days?: number;
}

/**
 * 計数。`items` は書き込めた項目数（`job_runs.items_fetched`）で、ジョブが増やす。
 * `failures` は `ctx.recordFailure` が増やし、`apiCalls` は `ctx.graph` の呼び出しごとに枠組みが増やす（どちらもジョブは読むだけ）
 */
export interface JobProgress {
  items: number;
  readonly failures: number;
  readonly apiCalls: number;
}

interface MutableProgress {
  items: number;
  failures: number;
  apiCalls: number;
}

/** 項目の失敗の分類（`recordFailure`）。`Tracked.errorClass` の `fatal`／`transient` をそのまま渡せる */
export type ItemFailureClass = "fatal" | "transient" | "download" | "db" | "unknown";

/** ジョブが `ctx.recordFailure` に渡す、項目 1 件の失敗 */
export interface ItemFailure {
  /** Graph API のコードや SQLSTATE。なければ省略 */
  code?: number | string;
  errorClass: ItemFailureClass;
  /** 自由文でよい（枠組みが `mask` を通す）。`Tracked.error.message` はマスク済み */
  message: string;
}

/** `shouldRun` に渡す。`job_runs` の行を作る前なので、API は呼べない */
export interface JobPrecheckContext {
  account: AccountRow;
  /** 通常のクエリと `begin` に使う。`begin` の中では `tx` だけを使うこと（ファイル先頭の注意） */
  db: Db;
  config: WorkerConfig;
  log: Logger;
  now: () => Date;
  options: JobOptions;
  /**
   * 文字列から秘密情報を落とす（登録済みの秘密 ＋ パターン）。ジョブが DB（`video_analyses.error` など）や
   * ログに書く自由文はこれを通す。`SecretRegistry` そのものは渡さない
   */
  mask: (text: string) => string;
}

/**
 * `run` に渡す。トークンは `graph` の中にだけあり、ここには載せない。
 *
 * 使い方の規則:
 * - `graph.get` / `graph.pages` は `db.begin` の外で呼ぶ（中で呼ぶと空き接続を待ち続けて止まる）
 * - 項目の行の書き込みは `db.begin(tx => ...)` で短いトランザクションにし、中では `tx` だけを使う
 * - 書けたら `progress.items += 1`。失敗したら `recordFailure({ code, errorClass, message })` を呼ぶ（枠組みが
 *   `progress.failures` を増やし、最後の失敗を `job_runs.error` とログに残す）。`progress.failures` と
 *   `progress.apiCalls` は読み取り用
 * - 「今日」は `startedAt` から 1 回だけ求める（設計 5.0 章）。`now()` は各時点の時刻（`fetched_at` など）
 * - `RateLimitExceeded` と `AuthError` は捕まえずに外へ出す（枠組みが状態を決める）
 * - ジョブが DB（`video_analyses.error` など）やログに書く文字列は `mask` を通す。`graph` が返す `error.message` は
 *   マスク済み
 * - 一時ディレクトリは `mkdtemp(join(tmpdir(), TMP_DIR_PREFIX + "..."))` で作り、`finally` で消す
 */
export interface JobContext extends JobPrecheckContext {
  graph: JobGraphClient;
  rate: RateMonitor;
  progress: JobProgress;
  jobRunId: string;
  startedAt: Date;
  /** 項目 1 件の失敗を記録する（`progress.failures += 1`。最後の失敗が `partial` の理由として残る） */
  recordFailure: (failure: ItemFailure) => void;
}

export interface JobDefinition {
  name: JobName;
  /** 使用率（%）のしきい値。省略時は `config.rateHardLimit`。`account_backfill` は `config.rateSoftLimit` を使う */
  rateThreshold?: number;
  /** false を返すと `job_runs` に行を作らずに終わる（`account_backfill` の完了後など） */
  shouldRun?: (ctx: JobPrecheckContext) => Promise<boolean>;
  run: (ctx: JobContext) => Promise<void>;
}

/** ジョブが止まった理由。`none` は最後まで走った */
export type StopReason = "none" | "rate" | "auth" | "error";

/** ログの `class=` に出す分類。例外の分類に加えて、項目の失敗（`ItemFailureClass`）も含む */
export type ErrorClass = "rate" | "auth" | "db" | "download" | "unknown" | ItemFailureClass;

export interface ErrorSummary {
  /** マスク済み。`job_runs.error` とログの `debug` にそのまま入れられる */
  message: string;
  /** Graph API のコード、SQLSTATE、postgres.js や Node.js のエラーコード。なければ undefined */
  code: string | undefined;
  errorClass: ErrorClass;
}

/** 二重起動で見送ったときの `job_runs.error` */
export const LOCKED_ERROR = "同じジョブが実行中";
/** 認証情報がないときの `job_runs.error` */
export const NO_CREDENTIAL_ERROR = "認証情報がない";
/** 枠組みの外で起きた例外（Error でないものが投げられたなど） */
const UNKNOWN_ERROR = "不明なエラー";
/** `error_code=` はエラーの行に常に出す（8.1 章）。コードがない例外は `none` */
const NO_ERROR_CODE = "none";

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * ジョブの状態（設計 1.5 章）。上から順に判定する。
 * - `failed`: `auth` で止まった（件数に関係なく）、予期しない例外で止まった、何も書き込めずに失敗した
 * - `skipped`: 何も書き込む前にレート制限で止まった
 * - `partial`: 1 件以上書き込めたが、失敗した項目がある、またはレート制限で途中で止まった
 * - `success`: それ以外
 */
export function deriveJobStatus(p: JobProgress, stop: StopReason): JobOutcome {
  if (stop === "auth" || stop === "error") return "failed";
  if (p.items === 0 && p.failures > 0) return "failed";
  if (stop === "rate") return p.items === 0 ? "skipped" : "partial";
  if (p.failures > 0) return "partial";
  return "success";
}

/** 文字列の `code` だけを扱う（`DOMException` の `code: 20` などを Graph のコードと紛れさせない）。形が不正なら出さない */
function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  const code = e.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

function isPostgresError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "PostgresError";
}

/**
 * 例外を記録用の形にする。参照するのは `message` と `code`、`name` だけ（`stack`、`cause`、`query`、`parameters`、
 * `new URL()` の `input` は見ない）。DB のエラーは `normalizeDbError` の固定文言、Graph 系は固定文言、
 * それ以外は `sanitizeForLog(message)`
 */
export function describeError(e: unknown, secrets: SecretRegistry): ErrorSummary {
  if (e instanceof RateLimitExceeded) {
    const regain = e.estimatedMinutes !== undefined && e.estimatedMinutes > 0 ? `（回復見込み ${e.estimatedMinutes} 分）` : "";
    return { message: sanitizeForLog(e.message + regain, secrets), code: undefined, errorClass: "rate" };
  }
  if (e instanceof AuthError) {
    return { message: sanitizeForLog(e.message, secrets), code: String(e.code), errorClass: "auth" };
  }
  if (e instanceof DownloadError) {
    return { message: sanitizeForLog(e.message, secrets), code: undefined, errorClass: "download" };
  }
  const code = errorCode(e);
  if (isPostgresError(e)) {
    return { message: normalizeDbError(e), code, errorClass: "db" };
  }
  if (code !== undefined) {
    const normalized = normalizeDbError(e);
    if (normalized.startsWith("DB 接続に失敗")) {
      return { message: normalized, code, errorClass: "db" };
    }
  }
  const message = e instanceof Error ? e.message : UNKNOWN_ERROR;
  return { message: sanitizeForLog(message, secrets), code, errorClass: "unknown" };
}

/**
 * 設定から `JobDeps` を作る。`processSecrets` にアプリシークレット、サービスロールキー、接続文字列と Supabase の
 * URL の各部分、`extra.secretsToAdd` を登録し、Logger と接続プールを作る。接続文字列が不正なら固定文言の `Error`
 */
export function createJobDeps(
  config: WorkerConfig,
  extra: { secretsToAdd?: (string | undefined)[]; fetchImpl?: typeof fetch; now?: () => Date } = {},
): JobDeps {
  const secrets = processSecrets;
  secrets.add(config.metaAppSecret);
  secrets.add(config.supabaseServiceRoleKey);
  secrets.addUrlParts(config.databaseUrl);
  secrets.addUrlParts(config.supabaseUrl);
  for (const value of extra.secretsToAdd ?? []) secrets.add(value);

  const log = createLogger(config.logLevel, secrets);
  let db: Db;
  try {
    db = connectDb(config.databaseUrl);
  } catch (error) {
    // 不正な URL は同期的に TypeError（message と input に接続文字列を含みうる）。固定文言だけにする
    throw new Error(normalizeDbError(error));
  }
  return { db, config, log, secrets, fetchImpl: extra.fetchImpl, now: extra.now };
}

/** `JobDeps` を閉じる（`createJobDeps` と対） */
export async function closeJobDeps(deps: JobDeps): Promise<void> {
  await closeDb(deps.db);
}

/**
 * `root`（既定は `os.tmpdir()`）配下の `TMP_DIR_PREFIX` で始まる**ディレクトリ**（シンボリックリンクは対象外）で、
 * 更新時刻が 1 日以上前のものを消す。消した数を返す。失敗は無視する（他のプロセスが使っている、権限がない、など）
 */
export async function cleanOldTempDirs(root: string = tmpdir(), now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(TMP_DIR_PREFIX)) continue;
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || now - info.mtimeMs < TMP_DIR_MAX_AGE_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 無視する
    }
  }
  return removed;
}

interface RunState {
  stop: StopReason;
  /** 例外（`stop !== 'none'`）か、例外なしのときの最後の項目の失敗 */
  failure: ErrorSummary | undefined;
  rate: RateMonitor | undefined;
}

/**
 * 1 アカウント分のジョブを実行する（設計 1.6 章）。例外は外に投げない。枠組み自体の失敗も `failed` にして
 * 記録を試み、記録にも失敗したらログだけを出す。
 * `accountLabel` はログの `account=` に出す連番（`1/2` など。`runJobsForActiveAccounts` が渡す）。
 * 内部の uuid や Instagram の ID はログに出さない
 */
export async function runJob(
  def: JobDefinition,
  deps: JobDeps,
  account: AccountRow,
  options: JobOptions = {},
  accountLabel?: string,
): Promise<JobOutcome> {
  const { db, config, log, secrets } = deps;
  const now = deps.now ?? (() => new Date());
  const mask = (text: string): string => sanitizeForLog(text, secrets);
  const startedAt = now();
  const progress: MutableProgress = { items: 0, failures: 0, apiCalls: 0 };
  const base: LogFields = { job: def.name, account: accountLabel };
  let lastItemFailure: ErrorSummary | undefined;
  const recordFailure = (failure: ItemFailure): void => {
    progress.failures += 1;
    lastItemFailure = {
      message: mask(failure.message),
      code: failure.code === undefined ? undefined : mask(String(failure.code)),
      errorClass: failure.errorClass,
    };
  };

  let conn: ReservedSql;
  try {
    conn = await db.reserve();
  } catch (error) {
    logFailure(log, base, describeError(error, secrets), "failed", progress, startedAt, now(), undefined);
    return "failed";
  }

  let locked = false;
  let jobRunId: string | undefined;
  const state: RunState = { stop: "none", failure: undefined, rate: undefined };
  try {
    locked = await tryLock(conn, def.name, account.id);
    if (!locked) {
      await startJobRun(db, def.name, account.id, { status: "skipped", error: LOCKED_ERROR });
      log.warn({ ...base, status: "skipped", items: 0, calls: 0, failures: 0, error: LOCKED_ERROR });
      return "skipped";
    }
    await failRunningRuns(db, def.name, account.id);

    const pre: JobPrecheckContext = { account, db, config, log, now, options, mask };
    if (def.shouldRun && !(await def.shouldRun(pre))) {
      log.debug({ ...base, status: "skipped", reason: "shouldRun" });
      return "skipped";
    }

    jobRunId = await startJobRun(db, def.name, account.id);
    log.debug({ ...base, status: "running" });

    const credential = await readCredential(db, account.id);
    if (!credential) {
      state.stop = "error";
      state.failure = { message: NO_CREDENTIAL_ERROR, code: undefined, errorClass: "auth" };
    } else {
      // 読んだ直後に登録する（この先で例外が出ても登録済みであるように）
      secrets.add(credential.token);
      const graphClient = new GraphClient(credential.token, config.graphApiVersion, 200, deps.fetchImpl);
      const rate = new RateMonitor(
        await latestRateUsage(db, new Date(startedAt.getTime() - ONE_HOUR_MS), startedAt),
      );
      state.rate = rate;
      const runId = jobRunId;
      const graph = createJobGraphClient({
        graph: graphClient,
        rate,
        rateThreshold: def.rateThreshold ?? config.rateHardLimit,
        // debug_token 用。metaAppSecret は processSecrets に登録済みなので、ログに出ても `123|***` になる
        appToken: `${config.metaAppId}|${config.metaAppSecret}`,
        persistRaw: (row) =>
          insertRawResponse(db, {
            account_id: account.id,
            job_run_id: runId,
            endpoint: row.endpoint,
            params: row.params,
            api_version: config.graphApiVersion,
            fetched_at: row.fetchedAt,
            http_status: row.httpStatus,
            body: row.body,
          }),
        onApiCall: () => {
          progress.apiCalls += 1;
        },
        onAuthError: async (code) => {
          try {
            await updateCredentialStatus(db, account.id, {
              status: code === 190 ? "expired" : "insufficient_scope",
              last_error: authErrorMessage(code),
              last_checked_at: now(),
            });
          } catch (error) {
            // 更新に失敗しても AuthError は投げられる（graph-client 側）。ここでは記録だけ
            const failure = describeError(error, secrets);
            log.warn({
              ...base,
              error: "認証情報の状態の更新に失敗",
              detail: failure.message,
              error_code: failure.code ?? NO_ERROR_CODE,
              class: failure.errorClass,
            });
          }
        },
        sleep: deps.sleep,
        now,
        maskText: mask,
      });
      const ctx: JobContext = { ...pre, graph, rate, progress, jobRunId, startedAt, recordFailure };
      try {
        await def.run(ctx);
      } catch (error) {
        state.failure = describeError(error, secrets);
        state.stop = error instanceof RateLimitExceeded ? "rate" : error instanceof AuthError ? "auth" : "error";
      }
      // 例外なしで項目の失敗があれば、最後の失敗を partial（または failed）の理由にする
      if (state.stop === "none" && lastItemFailure) state.failure = lastItemFailure;
    }

    const status = deriveJobStatus(progress, state.stop);
    await finishJobRun(db, jobRunId, {
      status,
      items_fetched: progress.items,
      api_calls: progress.apiCalls,
      error: state.failure?.message ?? null,
      // 観測していない初期値（直近の job_runs から引き継いだもの）は書き戻さない
      rate_usage: progress.apiCalls > 0 ? (state.rate?.usage() ?? null) : null,
    });
    const finishedAt = now();
    if (state.failure) {
      logFailure(log, base, state.failure, status, progress, startedAt, finishedAt, state.rate);
    } else {
      log.info({ ...base, ...outcomeFields(status, progress, startedAt, finishedAt, state.rate) });
    }
    return status;
  } catch (error) {
    // 枠組み自体の失敗（job_runs の insert、認証情報の読み込み、finishJobRun など）
    const failure = describeError(error, secrets);
    logFailure(log, base, failure, "failed", progress, startedAt, now(), state.rate);
    if (jobRunId !== undefined) {
      try {
        await finishJobRun(db, jobRunId, {
          status: "failed",
          items_fetched: progress.items,
          api_calls: progress.apiCalls,
          error: failure.message,
          rate_usage: progress.apiCalls > 0 ? (state.rate?.usage() ?? null) : null,
        });
      } catch {
        // 記録に失敗したらログだけ（上で出している）
      }
    }
    return "failed";
  } finally {
    if (locked) {
      try {
        await unlock(conn, def.name, account.id);
      } catch (error) {
        // 接続が切れていればロックは自動で外れる。接続はプールに返す（作り直しはしない）
        const failure = describeError(error, secrets);
        log.warn({
          ...base,
          error: "ロックの解放に失敗",
          detail: failure.message,
          error_code: failure.code ?? NO_ERROR_CODE,
          class: failure.errorClass,
        });
      }
    }
    conn.release();
  }
}

function outcomeFields(
  status: JobOutcome,
  progress: JobProgress,
  startedAt: Date,
  finishedAt: Date,
  rate: RateMonitor | undefined,
): LogFields {
  return {
    status,
    items: progress.items,
    calls: progress.apiCalls,
    failures: progress.failures,
    duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    rate: rate ? `${rate.percent()}%` : undefined,
  };
}

/** 失敗時のログ（8.1 章）。`warn` に `error_code=` と `class=`、`debug` にマスク済みの全文 */
function logFailure(
  log: Logger,
  base: LogFields,
  failure: ErrorSummary,
  status: JobOutcome,
  progress: JobProgress,
  startedAt: Date,
  finishedAt: Date,
  rate: RateMonitor | undefined,
): void {
  log.warn({
    ...base,
    ...outcomeFields(status, progress, startedAt, finishedAt, rate),
    error_code: failure.code ?? NO_ERROR_CODE,
    class: failure.errorClass,
  });
  log.debug({ ...base, error: failure.message });
}

/**
 * `accounts.status = 'active'` のすべてのアカウントでジョブを順に実行する（ログの `account=` は `1/2` のような連番）。
 * `failed` のアカウントがなければ true（`partial` と `skipped` は true。設計 1.1 章「1 つでも `failed` があれば終了コード 1」。
 * アカウントがなければ `warn` を出して true）
 */
export async function runJobsForActiveAccounts(
  def: JobDefinition,
  deps: JobDeps,
  options: JobOptions = {},
): Promise<boolean> {
  let accounts: AccountRow[];
  try {
    accounts = await (deps.listAccounts ?? listActiveAccounts)(deps.db);
  } catch (error) {
    const failure = describeError(error, deps.secrets);
    deps.log.warn({ job: def.name, status: "failed", error_code: failure.code ?? NO_ERROR_CODE, class: failure.errorClass });
    deps.log.debug({ job: def.name, error: failure.message });
    return false;
  }
  if (accounts.length === 0) {
    deps.log.warn({ job: def.name, status: "skipped", error: "active なアカウントがない（register-token で登録する）" });
    return true;
  }
  let allOk = true;
  for (const [index, account] of accounts.entries()) {
    const outcome = await runJob(def, deps, account, options, `${index + 1}/${accounts.length}`);
    if (outcome === "failed") allOk = false;
  }
  return allOk;
}

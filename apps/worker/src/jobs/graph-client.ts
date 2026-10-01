/**
 * ジョブ用の Graph API クライアント（設計 1.2〜1.4 章、7.2 章、10.2 章）。
 *
 * `lib/graph.ts` の `GraphClient` を包み、呼び出しごとに次を共通に行う。
 * - レート制限の監視: 呼び出しの前にしきい値を確かめ、呼び出しの後にヘッダで使用率を更新する
 * - 生レスポンスの保存: `params` は `stripSecretParams`、`body` は `stripVolatileFields` を通してから
 *   `persistRaw`（`raw_api_responses` への自動コミットの insert）に渡す。エラー応答も保存する
 * - 再試行: `transient` だけを合計 `MAX_ATTEMPTS` 回試す。待ち時間は `backoffDelay`
 * - 分類ごとの振る舞い: `rate` と `auth` は投げる、`transient`（使い切り）と `fatal` は返す
 *
 * トークンは `GraphClient` の中にだけあり、このモジュールの引数、戻り値、例外には現れない。
 */
import {
  backoffDelay,
  classifyGraphError,
  MAX_ATTEMPTS,
  sleep as defaultSleep,
  type GraphClient,
  type GraphError,
  type GraphParams,
} from "../lib/graph.js";
import { sanitizeForLog, SecretRegistry } from "../lib/log.js";
import { RateLimitExceeded, type RateMonitor } from "./rate.js";

/** Graph API がトークン無効（190）または権限不足（10、200〜299）を返したときに投げる。`message` は固定文言 */
export class AuthError extends Error {
  override readonly name = "AuthError";

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** `AuthError.message` と `private.credentials.last_error` に入れる固定文言（設計 1.2 章、4.3 章） */
export function authErrorMessage(code: number): string {
  return code === 190 ? "トークンが無効（コード 190）" : `権限が足りない（コード ${code}）`;
}

/** `JobGraphClient.get` の戻り値。例外にならなかった呼び出しの結果（成功、`transient` の使い切り、`fatal`） */
export interface Tracked<T> {
  ok: boolean;
  /** HTTP ステータス。レスポンスなし（ネットワーク失敗）は 0 */
  status: number;
  data: T | undefined;
  /** 許可リストのキーだけを持ち、`message` はマスク済み（`sanitizeGraphError`）。そのままログや DB に入れてよい */
  error: GraphError | undefined;
  /** `ok: false` のときだけ。`transient` は再試行を使い切った、`fatal` は再試行しない失敗 */
  errorClass: "transient" | "fatal" | undefined;
  /** 最後の試行で保存した `raw_api_responses.id`。`persist: false` またはレスポンスなしのときは undefined */
  rawResponseId: string | undefined;
  /** 最後の試行のリクエスト直前の時刻 */
  fetchedAt: Date;
}

/** ページングのあるレスポンスの形 */
export interface Page<T> {
  data: T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    /** URL。使わない（有無だけを見る）。保存時は `<omitted>` になる */
    next?: string;
    previous?: string;
  };
}

export interface JobGraphClient {
  /**
   * GET を 1 回（`transient` なら最大 `MAX_ATTEMPTS` 回）行う。
   * `rate` は `RateLimitExceeded`、`auth` は `AuthError` を投げる。それ以外は `Tracked` を返す。
   * `db.begin` の中から呼ばないこと（生レスポンスの保存が空き接続を待ち続ける）
   */
  get<T>(path: string, params?: GraphParams, opts?: { persist?: boolean }): Promise<Tracked<T>>;
  /**
   * `after` を渡しながらページを順に取る。各ページを yield し、`ok` でないページを yield したら止まる。
   * `paging.next` がない、`cursors.after` がない、`data` が空、のいずれかでも止まる（設計 11.1 章 P8）
   */
  pages<T>(path: string, params?: GraphParams): AsyncIterable<Tracked<Page<T>>>;
}

/** `persistRaw` に渡す行。`account_id`、`job_run_id`、`api_version` は枠組みが補う */
export interface PersistRawInput {
  endpoint: string;
  params: Record<string, unknown>;
  fetchedAt: Date;
  httpStatus: number;
  body: unknown;
}

export interface JobGraphClientDeps {
  graph: GraphClient;
  rate: RateMonitor;
  /** 使用率（%）がこれ以上なら呼び出しの前に `RateLimitExceeded` を投げる */
  rateThreshold: number;
  /** 生レスポンスを保存して id を返す。`params` と `body` は加工済み */
  persistRaw: (row: PersistRawInput) => Promise<string>;
  /** 呼び出しごと（再試行も 1 回と数える） */
  onApiCall: () => void;
  /** `auth` の応答を受けたとき、`AuthError` を投げる前に呼ぶ（`private.credentials` の更新）。失敗（reject）しても `AuthError` は投げる */
  onAuthError: (code: number) => Promise<void>;
  /** テスト用。省略時は実際に待つ */
  sleep?: (ms: number) => Promise<void>;
  /** テスト用。`backoffDelay` の乱数 */
  random?: () => number;
  /** テスト用。`fetchedAt` の時刻 */
  now?: () => Date;
  /**
   * エラー応答の `error.message` を保存と戻り値に使う前に通すマスク。枠組みは `sanitizeForLog`（登録済みの秘密 ＋
   * パターン）を渡す。省略時はパターンだけ（URL、`access_token=`、`Bearer`、10 桁以上の数字）
   */
  maskText?: (text: string) => string;
}

const OMITTED = "<omitted>";

/** `raw_api_responses.params` から常に除くキー */
const SECRET_PARAM_KEYS: ReadonlySet<string> = new Set(["access_token", "input_token", "appsecret_proof"]);

/** `raw_api_responses.body` で値を `<omitted>` にするキー（どの深さでも） */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "media_url",
  "thumbnail_url",
  "profile_picture_url",
]);

/** `paging` の直下で値を `<omitted>` にするキー（URL にトークンが含まれる） */
const PAGING_URL_KEYS: ReadonlySet<string> = new Set(["next", "previous"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * クエリのパラメータから秘密のキー（`access_token`、`input_token`、`appsecret_proof`）と `undefined` の値を除く。
 * 純粋関数。入力は変更しない
 */
export function stripSecretParams(params: GraphParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SECRET_PARAM_KEYS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * レスポンス本文から期限付き URL とトークンを落とす。JSON 全体を再帰的に走査し、
 * キーが `access_token`、`media_url`、`thumbnail_url`、`profile_picture_url` の値と、`paging` 直下の `next` と
 * `previous` を `"<omitted>"` にする。`paging.cursors` は残す。配列と入れ子にも効く。純粋関数。入力は変更しない
 */
export function stripVolatileFields(body: unknown): unknown {
  return stripValue(body, false);
}

function stripValue(value: unknown, underPaging: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => stripValue(item, underPaging));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const omit = VOLATILE_KEYS.has(key) || (underPaging && PAGING_URL_KEYS.has(key));
    if (omit && item !== null && item !== undefined) {
      out[key] = OMITTED;
      continue;
    }
    out[key] = stripValue(item, key === "paging");
  }
  return out;
}

/** 登録済みの秘密がないときのマスク（パターンだけ） */
const NO_SECRETS = new SecretRegistry();

/**
 * 保存と戻り値（`Tracked.error`）に使うエラー。許可リストのキー（`message`、`type`、`code`、`error_subcode`、
 * `fbtrace_id`）だけで組み立て、`error_user_msg` などの自由文は落とす。`message` は API が返した自由文なので、
 * URL やトークンの形が含まれても残らないようにマスクする。
 * `isUnsupportedMetricError` や `isHistoryLimitError` の部分一致（「does not support」「available for the last 2 years」）
 * は URL や 10 桁の数字を含まないので、マスク後の `message` でも判定できる
 */
function sanitizeGraphError(
  error: GraphError | undefined,
  maskText: (text: string) => string,
): GraphError | undefined {
  if (!error) return undefined;
  const out: GraphError = { message: maskText(error.message) };
  if (typeof error.type === "string") out.type = error.type;
  if (typeof error.code === "number") out.code = error.code;
  if (typeof error.error_subcode === "number") out.error_subcode = error.error_subcode;
  if (typeof error.fbtrace_id === "string") out.fbtrace_id = error.fbtrace_id;
  return out;
}

export function createJobGraphClient(deps: JobGraphClientDeps): JobGraphClient {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());
  const maskText = deps.maskText ?? ((text: string) => sanitizeForLog(text, NO_SECRETS));

  function estimatedMinutes(): number | undefined {
    return deps.rate.usage()?.estimated_time_to_regain_access;
  }

  async function get<T>(path: string, params: GraphParams = {}, opts: { persist?: boolean } = {}): Promise<Tracked<T>> {
    const persist = opts.persist !== false;
    const safeParams = stripSecretParams(params);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (deps.rate.exceeds(deps.rateThreshold)) {
        throw RateLimitExceeded.forUsage(deps.rate.percent(), deps.rateThreshold, estimatedMinutes());
      }

      const fetchedAt = now();
      const res = await deps.graph.get<T>(path, params);
      deps.onApiCall();
      deps.rate.update(res.rateLimit);
      // 保存にも戻り値にも、許可リストのキーだけでマスク済みのエラーを使う（出所でマスクする）
      const safeError = sanitizeGraphError(res.error, maskText);

      let rawResponseId: string | undefined;
      if (persist && res.status !== 0) {
        rawResponseId = await deps.persistRaw({
          endpoint: path,
          params: safeParams,
          fetchedAt,
          httpStatus: res.status,
          body: stripVolatileFields(res.ok ? res.data : { error: safeError }),
        });
      }

      if (res.ok) {
        return { ok: true, status: res.status, data: res.data, error: undefined, errorClass: undefined, rawResponseId, fetchedAt };
      }

      const errorClass = classifyGraphError(res.status, res.error);
      if (errorClass === "rate") {
        throw RateLimitExceeded.forError(res.error?.code, estimatedMinutes());
      }
      if (errorClass === "auth") {
        // 分類が auth になるのはコードがあるときだけ
        const code = res.error?.code ?? 0;
        try {
          await deps.onAuthError(code);
        } catch {
          // private.credentials の更新に失敗しても AuthError は投げる（失敗の記録は枠組み側の onAuthError が行う）
        }
        throw new AuthError(code, authErrorMessage(code));
      }
      if (errorClass === "fatal") {
        return { ok: false, status: res.status, data: undefined, error: safeError, errorClass, rawResponseId, fetchedAt };
      }
      // transient
      if (attempt < MAX_ATTEMPTS) {
        // 直前の応答のヘッダでしきい値を超えていれば、待たずに止める
        if (deps.rate.exceeds(deps.rateThreshold)) {
          throw RateLimitExceeded.forUsage(deps.rate.percent(), deps.rateThreshold, estimatedMinutes());
        }
        await sleep(backoffDelay(attempt, random));
        continue;
      }
      return { ok: false, status: res.status, data: undefined, error: safeError, errorClass, rawResponseId, fetchedAt };
    }
    // ループは必ず return か throw で抜ける
    throw new Error("再試行の制御が不正");
  }

  async function* pages<T>(path: string, params: GraphParams = {}): AsyncGenerator<Tracked<Page<T>>, void, undefined> {
    let after: string | undefined;
    for (;;) {
      const page = await get<Page<T>>(path, after === undefined ? params : { ...params, after });
      yield page;
      if (!page.ok || !page.data) return;
      const data = page.data.data;
      if (!Array.isArray(data) || data.length === 0) return;
      const paging = page.data.paging;
      // 最終ページでも cursors.after は付くので、paging.next の有無で終わりを判断する（P8）。URL 自体は使わない
      if (!paging?.next) return;
      const next = paging.cursors?.after;
      // 同じカーソルが返り続けたときに無限に回らないための保険
      if (!next || next === after) return;
      after = next;
    }
  }

  return { get, pages };
}

/**
 * サーバー側の環境変数（設計 1.2 章、2.2 章。R2 設計 2.2 章、4.2 章）。
 *
 * - `process.env` を読むのはこのモジュールの `readEnv` だけ（データアクセス層に閉じる。例外は `src/proxy.ts` と
 *   `src/lib/auth-env.ts` の `readAuthEnv`。ログインの変数は段 2 の変数が未設定でも読めるよう分けている）
 * - 呼び出し側は `connection()`（`src/lib/dynamic.ts`）の後に、関数の中で呼ぶ（ビルド時に値が焼き込まれないため）
 * - 欠落と書式の不備は変数名だけを `missing` に入れて返す。値、`new URL()` の例外（`input` に値が入る）は外に出さない
 * - TLS はフェイルクローズ: `DATABASE_URL` のホストがローカル以外で `DATABASE_SSL_CA` がなければ不備。
 *   PEM は `\n` のリテラルを改行に正規化し、`-----BEGIN CERTIFICATE-----` で始まることを検査する（値は出さない）
 */
import "server-only";

export type DatabasePoolMode = "session" | "transaction";

export interface WebEnv {
  databaseUrl: string;
  /** 共有プーラーのトランザクションモード（`:6543`）は `transaction`（プリペアドステートメント不可）。既定 `session` */
  databasePoolMode: DatabasePoolMode;
  /** 正規化済みの CA 証明書（PEM）。ローカルの DB だけ undefined（平文） */
  databaseSslCa: string | undefined;
  metaAppId: string;
  metaAppSecret: string;
  graphApiVersion: string;
  /** オリジンだけ（例 `http://localhost:3000`）。パスと末尾のスラッシュはない */
  appUrl: string;
  /** 指定があれば、候補の数にかかわらずこの Instagram アカウントの数値 ID に一致するページだけを登録する。未設定なら undefined */
  targetIgUserId: string | undefined;
}

/** `missing` は変数名だけ。値を含めない */
export type EnvResult = { ok: true; env: WebEnv } | { ok: false; missing: string[] };

export const DEFAULT_GRAPH_API_VERSION = "v25.0";

const GRAPH_API_VERSION_PATTERN = /^v\d+\.\d+$/;
/** Meta の数値 ID（アプリ ID、Instagram アカウント ID） */
const NUMERIC_ID_PATTERN = /^\d{1,40}$/;
const DB_PROTOCOLS: readonly string[] = ["postgres:", "postgresql:"];
const HTTP_PROTOCOLS: readonly string[] = ["http:", "https:"];
/** 平文で接続してよい DB のホスト（R2 設計 2.2 章） */
const LOCAL_DB_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "host.docker.internal"];
const PEM_HEADER = "-----BEGIN CERTIFICATE-----";

type Source = Record<string, string | undefined>;

/** 空文字と空白だけは未設定として扱う */
function nonEmpty(source: Source, name: string): string | undefined {
  const value = source[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `new URL()` で読め、許可したプロトコルのときだけ返す。例外は捕まえて外に出さない */
function parseUrl(value: string | undefined, protocols: readonly string[]): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** `DATABASE_URL` のホストが平文で接続してよいローカルか */
export function isLocalDbHost(hostname: string): boolean {
  return LOCAL_DB_HOSTS.includes(hostname.toLowerCase());
}

/**
 * 環境変数から受け取った PEM を正規化する。`\n` のリテラル（2 文字）を改行にし、前後の空白を落とす。
 * `-----BEGIN CERTIFICATE-----` で始まらなければ undefined（不備）。値はエラーに出さない
 */
export function normalizePem(raw: string): string | undefined {
  const normalized = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  return normalized.startsWith(PEM_HEADER) ? normalized : undefined;
}

/**
 * 環境変数を読んで検証する。不備があれば `ok: false` と変数名の一覧。
 * `source` はテスト用の注入（既定は `process.env`）
 */
export function readEnv(source: Source = process.env): EnvResult {
  const missing: string[] = [];

  const databaseUrlRaw = nonEmpty(source, "DATABASE_URL");
  const databaseUrl = parseUrl(databaseUrlRaw, DB_PROTOCOLS);
  if (databaseUrl === undefined) missing.push("DATABASE_URL");

  const poolModeRaw = nonEmpty(source, "DATABASE_POOL_MODE") ?? "session";
  const databasePoolMode: DatabasePoolMode | undefined =
    poolModeRaw === "session" || poolModeRaw === "transaction" ? poolModeRaw : undefined;
  if (databasePoolMode === undefined) missing.push("DATABASE_POOL_MODE");

  const sslCaRaw = nonEmpty(source, "DATABASE_SSL_CA");
  let databaseSslCa: string | undefined;
  if (sslCaRaw !== undefined) {
    databaseSslCa = normalizePem(sslCaRaw);
    if (databaseSslCa === undefined) missing.push("DATABASE_SSL_CA");
  } else if (databaseUrl !== undefined && !isLocalDbHost(databaseUrl.hostname)) {
    // フェイルクローズ: ローカル以外は CA がなければ接続しない
    missing.push("DATABASE_SSL_CA");
  }

  const metaAppId = nonEmpty(source, "META_APP_ID");
  if (metaAppId === undefined || !NUMERIC_ID_PATTERN.test(metaAppId)) missing.push("META_APP_ID");

  const metaAppSecret = nonEmpty(source, "META_APP_SECRET");
  if (metaAppSecret === undefined) missing.push("META_APP_SECRET");

  const graphApiVersion = nonEmpty(source, "META_GRAPH_API_VERSION") ?? DEFAULT_GRAPH_API_VERSION;
  if (!GRAPH_API_VERSION_PATTERN.test(graphApiVersion)) missing.push("META_GRAPH_API_VERSION");

  const appUrlRaw = nonEmpty(source, "APP_URL");
  const appUrl = parseUrl(appUrlRaw, HTTP_PROTOCOLS);
  // オリジンだけを許す（パス、クエリ、末尾のスラッシュがあると `origin` と一致しない）
  if (appUrl === undefined || appUrl.origin !== appUrlRaw) missing.push("APP_URL");

  const targetIgUserId = nonEmpty(source, "META_TARGET_IG_USER_ID");
  if (targetIgUserId !== undefined && !NUMERIC_ID_PATTERN.test(targetIgUserId)) missing.push("META_TARGET_IG_USER_ID");

  if (
    missing.length > 0 ||
    databaseUrlRaw === undefined ||
    databasePoolMode === undefined ||
    metaAppId === undefined ||
    metaAppSecret === undefined ||
    appUrlRaw === undefined
  ) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    env: {
      databaseUrl: databaseUrlRaw,
      databasePoolMode,
      databaseSslCa,
      metaAppId,
      metaAppSecret,
      graphApiVersion,
      appUrl: appUrlRaw,
      targetIgUserId,
    },
  };
}

/** 設定不足の固定文言（設計 2.5 章 `config_missing`）。変数名だけを含む */
export function configMissingReason(missing: readonly string[]): string {
  return `設定が足りません（${missing.join("、")}）`;
}

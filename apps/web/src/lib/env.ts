/**
 * サーバー側の環境変数（設計 1.2 章、2.2 章）。
 *
 * - `process.env` を読むのはこのモジュールの `readEnv` だけ（データアクセス層に閉じる）
 * - 呼び出し側は `connection()`（`src/lib/dynamic.ts`）の後に、関数の中で呼ぶ（ビルド時に値が焼き込まれないため）
 * - 欠落と書式の不備は変数名だけを `missing` に入れて返す。値、`new URL()` の例外（`input` に値が入る）は外に出さない
 */
import "server-only";

export interface WebEnv {
  databaseUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
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

/**
 * 環境変数を読んで検証する。不備があれば `ok: false` と変数名の一覧。
 * `source` はテスト用の注入（既定は `process.env`）
 */
export function readEnv(source: Source = process.env): EnvResult {
  const missing: string[] = [];

  const databaseUrl = nonEmpty(source, "DATABASE_URL");
  if (parseUrl(databaseUrl, DB_PROTOCOLS) === undefined) missing.push("DATABASE_URL");

  const supabaseUrlRaw = nonEmpty(source, "SUPABASE_URL");
  const supabaseUrl = parseUrl(supabaseUrlRaw, HTTP_PROTOCOLS);
  if (supabaseUrl === undefined) missing.push("SUPABASE_URL");

  const supabaseServiceRoleKey = nonEmpty(source, "SUPABASE_SERVICE_ROLE_KEY");
  if (supabaseServiceRoleKey === undefined) missing.push("SUPABASE_SERVICE_ROLE_KEY");

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
    databaseUrl === undefined ||
    supabaseUrlRaw === undefined ||
    supabaseServiceRoleKey === undefined ||
    metaAppId === undefined ||
    metaAppSecret === undefined ||
    appUrlRaw === undefined
  ) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    env: {
      databaseUrl,
      // 末尾のスラッシュを落として `${supabaseUrl}/storage/v1/...` と連結できる形にそろえる
      supabaseUrl: supabaseUrlRaw.replace(/\/+$/, ""),
      supabaseServiceRoleKey,
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

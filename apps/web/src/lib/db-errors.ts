/**
 * DB のエラーを固定文言にする（設計 1.2 章。R2 設計 2.2 章）。ワーカーの `apps/worker/src/db/client.ts` の `normalizeDbError` と同じ方針。
 *
 * `message`、`stack`、`cause`、`query`、`parameters`、`input` は参照しない。ホスト名、ユーザー名、接続文字列を含まない。
 * 純粋関数（`server-only` なし）。
 */

/** データアクセス層の戻り値。例外を投げずにこれで返す */
export type QueryResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/** 接続と認証の失敗を表す SQLSTATE のクラス（先頭 2 文字）。08: connection_exception、28: invalid_authorization_specification */
const CONNECTION_SQLSTATE_CLASSES = ["08", "28"];
/** 接続の失敗として扱う個別の SQLSTATE。3D000: DB がない、53300: 接続数の上限、57P01〜03: サーバの停止 */
const CONNECTION_SQLSTATES = new Set(["3D000", "53300", "57P01", "57P02", "57P03"]);
const PERMISSION_SQLSTATE = "42501";
/** postgres.js と Node.js のソケット、URL の接続エラーのコード */
const CONNECTION_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "SASL_SIGNATURE_MISMATCH",
  "AUTH_TYPE_NOT_IMPLEMENTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_INVALID_URL",
]);
/** Node.js の TLS 証明書の検証エラー（OpenSSL のコード）。CA が違う、期限切れ、ホスト名の不一致など */
const CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_CHAIN_TOO_LONG",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** `code` が英大文字・数字・下線だけの短い文字列のときだけ返す。それ以外は出力に乗せない */
function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  const code = (e as { code: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

/** postgres.js の `PostgresError`（`name` で見分ける。`code` は SQLSTATE） */
function isSqlState(e: unknown, code: string): boolean {
  if (!/^[0-9A-Z]{5}$/.test(code)) return false;
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "PostgresError";
}

/** TLS 証明書の検証エラーか（`DATABASE_SSL_CA` が違う、期限切れ、ホスト名の不一致） */
export function isCertificateErrorCode(code: string): boolean {
  return CERTIFICATE_CODES.has(code) || code.startsWith("CERT_");
}

/**
 * - `DB 接続に失敗（SQLSTATE 28P01）`: 認証と接続の失敗（Postgres から返った SQLSTATE）
 * - `DB の権限がない（SQLSTATE 42501）`
 * - `DB エラー（SQLSTATE 23505）`: その他の Postgres のエラー
 * - `DB 接続に失敗（TLS 証明書の検証: SELF_SIGNED_CERT_IN_CHAIN）`: 証明書の検証エラー（CA の設定を疑う）
 * - `DB 接続に失敗（ECONNREFUSED）`: postgres.js、ソケット、その他の TLS、URL の接続エラー
 * - `DB エラー（UNDEFINED_VALUE）`: その他のコードつきのエラー
 * - `DB エラー`: コードがない、または形が不正
 */
export function describeDbError(e: unknown): string {
  const code = errorCode(e);
  if (code === undefined) return "DB エラー";
  if (isSqlState(e, code)) {
    if (code === PERMISSION_SQLSTATE) return `DB の権限がない（SQLSTATE ${code}）`;
    if (CONNECTION_SQLSTATES.has(code) || CONNECTION_SQLSTATE_CLASSES.includes(code.slice(0, 2))) {
      return `DB 接続に失敗（SQLSTATE ${code}）`;
    }
    return `DB エラー（SQLSTATE ${code}）`;
  }
  if (isCertificateErrorCode(code)) return `DB 接続に失敗（TLS 証明書の検証: ${code}）`;
  if (CONNECTION_CODES.has(code) || code.startsWith("ERR_TLS_")) {
    return `DB 接続に失敗（${code}）`;
  }
  return `DB エラー（${code}）`;
}

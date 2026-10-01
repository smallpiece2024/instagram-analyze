/**
 * postgres.js の接続（設計 3.2 章、3.5 章）と、DB エラーの固定文言化（設計 1.2 章、10.5 章）。
 *
 * - 接続は `max: 2`。アドバイザリロック用に `reserve()` で 1 本を固定し、ジョブのクエリと `begin` に
 *   もう 1 本を使う。`begin` の中では渡された `tx` だけを使い、`db` を使わないこと（空き接続がなく
 *   コミットを待ち続ける）。`reserve()` した接続は `idle_timeout` で閉じられない（`open` に戻った接続だけが対象）
 * - `date`（oid 1082）は `YYYY-MM-DD` の文字列のまま読み書きする。既定の `Date`（UTC 0 時）への
 *   変換は日本時間に直すと日付がずれる
 * - 接続文字列（パスワード、ユーザー名、ホスト）は呼び出し側（framework）が秘密の一覧に登録する。
 *   このモジュールはログを出さず、例外のメッセージも組み立てない
 */
import postgres from "postgres";

/** `date` 列を文字列のまま扱う。`serialize` も素通しにして、`new Date('YYYY-MM-DD')` の UTC 解釈を避ける */
const DATE_AS_STRING: postgres.PostgresType<string> = {
  to: 1082,
  from: [1082],
  serialize: (value) => value,
  parse: (value: string) => value,
};

const TYPES = { date: DATE_AS_STRING };

/** 接続プール（`max: 2`） */
export type Db = postgres.Sql<{ date: string }>;
/** `db.begin(tx => ...)` の中で使う接続。トランザクションの中ではこれだけを使う */
export type Tx = postgres.TransactionSql<{ date: string }>;
/** `db.reserve()` が返す 1 本固定の接続。アドバイザリロックに使う。使い終わったら `release()` */
export type ReservedSql = postgres.ReservedSql<{ date: string }>;

export interface ConnectDbOptions {
  /** 接続のタイムアウト（秒）。既定 10。テストで短くするためのもの */
  connectTimeoutSeconds?: number;
}

/**
 * 接続プールを作る。実際の接続は最初のクエリで開く（postgres.js は遅延接続）。
 * `url` の検証はしない。不正な URL は最初のクエリで失敗し、`normalizeDbError` で固定文言になる
 */
export function connectDb(url: string, options: ConnectDbOptions = {}): Db {
  return postgres(url, {
    max: 2,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: 30,
    onnotice: () => {},
    types: TYPES,
    connection: { application_name: "instagram-analyze-worker" },
  });
}

/** 実行中のクエリを待ってから閉じる。5 秒で打ち切る */
export async function closeDb(db: Db): Promise<void> {
  await db.end({ timeout: 5 });
}

/**
 * jsonb 列に入れる値を作る。`undefined` は null にする（postgres.js は `undefined` を受け付けない）。
 * `Db`、`Tx`、`ReservedSql` のどれでも渡せる
 */
export function jsonb(sql: Pick<Db, "json">, value: unknown): postgres.Parameter {
  return sql.json((value === undefined ? null : value) as postgres.JSONValue);
}

/** 接続と認証の失敗を表す SQLSTATE のクラス（先頭 2 文字）。08: connection_exception、28: invalid_authorization_specification */
const CONNECTION_SQLSTATE_CLASSES = ["08", "28"];
/** 接続の失敗として扱う個別の SQLSTATE。3D000: DB がない、53300: 接続数の上限、57P01〜03: サーバの停止 */
const CONNECTION_SQLSTATES = new Set(["3D000", "53300", "57P01", "57P02", "57P03"]);
const PERMISSION_SQLSTATE = "42501";
/** postgres.js と Node.js のソケット、TLS の接続エラーのコード */
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
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
]);

/** `code` が英大文字・数字・下線だけの短い文字列のときだけ返す。それ以外は出力に乗せない */
function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  const code = e.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

function isSqlState(e: unknown, code: string): boolean {
  if (!/^[0-9A-Z]{5}$/.test(code)) return false;
  return e instanceof postgres.PostgresError || (e as { name?: unknown }).name === "PostgresError";
}

/**
 * DB のエラーを固定文言にする（設計 1.2 章）。
 * `message`、`stack`、`cause`、`query`、`parameters` は参照しない。ホスト名やユーザー名を含まない。
 *
 * - `DB 接続に失敗（SQLSTATE 28P01）`: 認証と接続の失敗（Postgres から返った SQLSTATE）
 * - `DB の権限がない（SQLSTATE 42501）`
 * - `DB エラー（SQLSTATE 23505）`: その他の Postgres のエラー
 * - `DB 接続に失敗（ECONNREFUSED）`: postgres.js、ソケット、TLS の接続エラー
 * - `DB エラー（UNDEFINED_VALUE）`: その他のコードつきのエラー
 * - `DB エラー`: コードがない、または形が不正
 */
export function normalizeDbError(e: unknown): string {
  const code = errorCode(e);
  if (code === undefined) return "DB エラー";
  if (isSqlState(e, code)) {
    if (code === PERMISSION_SQLSTATE) return `DB の権限がない（SQLSTATE ${code}）`;
    if (CONNECTION_SQLSTATES.has(code) || CONNECTION_SQLSTATE_CLASSES.includes(code.slice(0, 2))) {
      return `DB 接続に失敗（SQLSTATE ${code}）`;
    }
    return `DB エラー（SQLSTATE ${code}）`;
  }
  if (CONNECTION_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("CERT_")) {
    return `DB 接続に失敗（${code}）`;
  }
  return `DB エラー（${code}）`;
}

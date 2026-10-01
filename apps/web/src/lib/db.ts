/**
 * postgres.js の接続（設計 1.2 章）。
 *
 * - `max: 3`、`idle_timeout: 20`、`connect_timeout: 10`、`application_name: 'instagram-analyze-web'`、`onnotice` 抑止、`debug` なし
 * - `date`（oid 1082）は `YYYY-MM-DD` の文字列のまま読み書きする（ワーカーの `db/client.ts` と同じ。`Date` にすると日本時間で日付がずれる）
 * - `bigint`、`numeric` は postgres.js の既定どおり文字列。表示で `Number()` にする
 * - `next dev` の HMR でモジュールが再評価されてもプールが増えないよう、`globalThis` に接続文字列ごとに 1 本だけ保持する
 * - このモジュールはログを出さず、例外のメッセージも組み立てない。失敗は呼び出し側が `describeDbError` で固定文言にする
 */
import "server-only";
import postgres from "postgres";

const DATE_AS_STRING: postgres.PostgresType<string> = {
  to: 1082,
  from: [1082],
  serialize: (value) => value,
  parse: (value: string) => value,
};

const TYPES = { date: DATE_AS_STRING };

/** 接続プール */
export type Db = postgres.Sql<{ date: string }>;
/** `db.begin(tx => ...)` の中で使う接続。トランザクションの中ではこれだけを使う */
export type Tx = postgres.TransactionSql<{ date: string }>;

const POOLS_KEY = Symbol.for("instagram-analyze.web.db-pools");

type GlobalWithPools = typeof globalThis & { [POOLS_KEY]?: Map<string, Db> };

function pools(): Map<string, Db> {
  const g = globalThis as GlobalWithPools;
  let map = g[POOLS_KEY];
  if (!map) {
    map = new Map<string, Db>();
    g[POOLS_KEY] = map;
  }
  return map;
}

/**
 * 接続プールを返す。同じ接続文字列には同じプールを返す。
 * 実際の接続は最初のクエリで開く（postgres.js は遅延接続）。`databaseUrl` の検証は `readEnv` が済ませている
 */
export function getDb(databaseUrl: string): Db {
  const map = pools();
  const existing = map.get(databaseUrl);
  if (existing) return existing;
  const db = postgres(databaseUrl, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    types: TYPES,
    connection: { application_name: "instagram-analyze-web" },
  });
  map.set(databaseUrl, db);
  return db;
}

/** `getDb` で作ったプールをすべて閉じて登録から外す（テストの後始末用）。5 秒で打ち切る */
export async function closeAllDb(): Promise<void> {
  const map = pools();
  const all = [...map.values()];
  map.clear();
  await Promise.all(all.map((db) => db.end({ timeout: 5 })));
}

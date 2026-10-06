/**
 * DB の読み出しの共通部分（R3 設計 4.5 節）。環境変数を検査し、例外は `describeDbError` の固定文言にして
 * `QueryResult` で返す。各クエリのモジュールはこれを使う（同じ関数を写さない）
 */
import "server-only";
import { dbFromEnv, type Db } from "@/lib/db";
import { describeDbError, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";

export async function runQuery<T>(fn: (db: Db) => Promise<T>): Promise<QueryResult<T>> {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    return { ok: true, data: await fn(dbFromEnv(env.env)) };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
}

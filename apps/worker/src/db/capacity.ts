/**
 * 上限の警告のための読み出し（課題 ia-6ui。マイグレーション `20261121000000_capacity_alerts.sql`）。
 *
 * - `readCapacity`: `private.capacity_snapshot()`（今の DB と Storage の容量）
 * - `latestRunDurationSeconds`: `public.collect_run_durations`（収集 1 回の所要）の最新の回
 *
 * どちらも全アカウントの合計で、アカウントの ID は扱わない
 */
import type { Db, Tx } from "./client.js";

export interface Capacity {
  /** `pg_database_size`（バイト）。ディスクの使用量より小さい近似値（WAL とシステムの領域を含まない） */
  dbBytes: number;
  /** `storage.objects` の大きさの合計（バイト） */
  storageBytes: number;
  /** `storage.objects` の件数 */
  storageObjects: number;
}

/** 今の容量。bigint は文字列で返るので number に直す（上限の 100 GB でも安全な整数の範囲） */
export async function readCapacity(db: Db | Tx): Promise<Capacity> {
  const rows = await db<{ db_bytes: string; storage_bytes: string; storage_objects: number }[]>`
    select db_bytes, storage_bytes, storage_objects from private.capacity_snapshot()
  `;
  const row = rows[0];
  if (!row) throw new Error("capacity_snapshot が行を返さなかった");
  return { dbBytes: Number(row.db_bytes), storageBytes: Number(row.storage_bytes), storageObjects: row.storage_objects };
}

/** 最新の回（収集 1 回）の所要（秒）。直近 35 日に終わった実行がなければ `undefined` */
export async function latestRunDurationSeconds(db: Db | Tx): Promise<number | undefined> {
  const rows = await db<{ seconds: number }[]>`
    select duration_seconds::float8 as seconds
    from public.collect_run_durations
    order by began_at desc
    limit 1
  `;
  return rows[0]?.seconds;
}

/**
 * `media_insight_snapshots`（設計 3.4 章、5.5 章、5.6 章、10.2 章。DB 設計 3.6 章）。
 *
 * - `listSnapshotCandidates`: スナップショットの対象になりうる投稿と、前回のスナップショットの時刻。
 *   取るかどうかの判定（`isSnapshotDue`）は `jobs/media-snapshot.ts` の純粋関数で行う
 * - `insertSnapshot`: 1 行入れる。一意制約 (media_id, fetched_at) に当たれば何もせず false
 * - 1 メディア分の行は `db.begin(tx => insertSnapshot(tx, ...))` の短いトランザクションで書く。
 *   `begin` の中では API を呼ばない（`max: 2`。`jobs/framework.ts` の注意）
 */
import { jsonb, type Db, type Tx } from "./client.js";
import type { MediaMetrics, MediaProductType, MediaType } from "./types.js";

export interface SnapshotCandidate {
  /** Instagram のメディア ID */
  id: string;
  media_type: MediaType;
  media_product_type: MediaProductType;
  posted_at: Date;
  /** 前回のスナップショットの時刻（`max(fetched_at)`）。1 つもなければ null。null だけの行も「前回」になる */
  last_fetched_at: Date | null;
}

export interface SnapshotInsert {
  media_id: string;
  /** 内訳なしのリクエスト直前の時刻（`Tracked.fetchedAt`） */
  fetched_at: Date;
  /** `elapsedSeconds(posted_at, fetched_at)` */
  elapsed_seconds: number;
  metrics: MediaMetrics;
  /** 生レスポンス（bigint の文字列）。結べるものがなければ null */
  raw_response_id: string | null;
  /** `ctx.jobRunId` */
  job_run_id: string;
}

/**
 * `gone_at` が null で `media_product_type` が `productTypes` のいずれかの投稿を、`posted_at` の新しい順に返す。
 * `last_fetched_at` はそのメディアのスナップショットの `max(fetched_at)`（なければ null）。
 * `productTypes` が空なら何も返さない
 */
export async function listSnapshotCandidates(
  db: Db,
  accountId: string,
  productTypes: MediaProductType[],
): Promise<SnapshotCandidate[]> {
  if (productTypes.length === 0) return [];
  const rows = await db<SnapshotCandidate[]>`
    select m.id, m.media_type, m.media_product_type, m.posted_at, s.last_fetched_at
    from public.media m
    left join lateral (
      select max(fetched_at) as last_fetched_at
      from public.media_insight_snapshots
      where media_id = m.id
    ) s on true
    where m.account_id = ${accountId}
      and m.media_product_type = any(${productTypes}::text[])
      and m.gone_at is null
    order by m.posted_at desc, m.id
  `;
  return [...rows];
}

/**
 * スナップショットを 1 行入れる。(media_id, fetched_at) が既にあれば何もせず false（F-COL-20）。
 * `tx` だけを使う（`db.begin` の中で呼ぶ）
 */
export async function insertSnapshot(tx: Tx, row: SnapshotInsert): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    insert into public.media_insight_snapshots
      (media_id, fetched_at, elapsed_seconds, metrics, raw_response_id, job_run_id)
    values
      (${row.media_id}, ${row.fetched_at}, ${row.elapsed_seconds}, ${jsonb(tx, row.metrics)},
       ${row.raw_response_id}, ${row.job_run_id})
    on conflict (media_id, fetched_at) do nothing
    returning id
  `;
  return rows.length > 0;
}

/** そのメディアのスナップショットの行数（テスト用） */
export async function countSnapshots(db: Db, mediaId: string): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from public.media_insight_snapshots where media_id = ${mediaId}
  `;
  return row?.n ?? 0;
}

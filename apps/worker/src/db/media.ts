/**
 * `media`（設計 3.4 章、5.4 章、5.6 章、10.2 章）。投稿（`FEED`、`REELS`）とストーリーズ（`STORY`）の両方が使う。
 *
 * - `upsertMedia` は 1 ページ分の行を 1 文で upsert する。`db.begin(tx => upsertMedia(tx, ...))` で呼ぶ
 * - `setThumbnailPath` はトランザクションの外（Storage への保存が済んでから）で呼ぶ
 * - `markGone` は一覧を全ページ失敗なく読み切ったときだけ呼ぶ（呼び出し側の責任。設計 5.4 章、5.6 章）
 * - この層はログを出さず、例外のメッセージも組み立てない。DB の失敗は呼び出し側（枠組み）が `normalizeDbError` にする
 */
import type { Db, Tx } from "./client.js";
import type { MediaProductType, MediaType } from "./types.js";

/** `upsertMedia` に渡す 1 行。`thumbnail_path`、`first_seen_at`、`gone_at` と 3 つのフラグは含めない（upsert が決める） */
export interface MediaUpsert {
  id: string;
  account_id: string;
  media_type: MediaType;
  media_product_type: MediaProductType;
  posted_at: Date;
  caption: string | null;
  /** 投稿の URL。`media.permalink` 列に入れてよい（署名付き URL ではない） */
  permalink: string | null;
  /** ストーリーズが消える予定の時刻。投稿は null */
  expires_at: Date | null;
}

export interface UpsertMediaResult {
  /** 今回 insert された（初めて見た）ID。渡した順 */
  inserted: string[];
  /**
   * `thumbnail_path` が null の ID（insert、update を問わない）。サムネイルの保存対象で、前回までに保存に失敗した
   * 行の再試行もこれで拾う（一覧にある行しか元 URL が分からないので、別に DB を引く必要はない）。渡した順
   */
  missingThumbnail: string[];
}

export interface MarkGoneArgs {
  accountId: string;
  /** 対象の `media_product_type`。投稿は `['FEED', 'REELS']`、ストーリーズは `['STORY']` */
  productTypes: MediaProductType[];
  /** 今回の一覧にあった ID。これに**ない**行が対象。空なら対象の種類の行すべてが対象 */
  seenIds: string[];
  /** `gone_at` に入れる時刻 */
  now: Date;
  /** 指定すると `expires_at` がこれより後の行だけを対象にする（ストーリーズの「消える 10 分以上前」の判定） */
  onlyExpiresAfter?: Date;
}

interface UpsertReturning {
  id: string;
  inserted: boolean;
  thumbnail_path: string | null;
}

/** insert する列。`gone_at`、`thumbnail_path`、フラグは既定（null）のまま */
const INSERT_COLUMNS = [
  "id",
  "account_id",
  "media_type",
  "media_product_type",
  "posted_at",
  "caption",
  "permalink",
  "expires_at",
  "first_seen_at",
  "last_synced_at",
] as const;

/**
 * `id` で upsert する。
 * - insert: 全列。`first_seen_at = last_synced_at = now`、`gone_at` は null、`thumbnail_path` とフラグは null
 * - update: `caption`、`permalink`、`media_type`、`media_product_type`、`expires_at`、`last_synced_at = now`、
 *   `gone_at = null`（一覧に戻ってきた投稿）。`first_seen_at`、`thumbnail_path`、`account_id`、フラグは触らない
 *
 * 同じ `id` が複数あれば最初の 1 つだけを使う（1 文の中で同じ行を 2 回更新できないため）。
 * 空の配列なら何もしない。`inserted` は `xmax = 0`（insert された行）で判定する
 */
export async function upsertMedia(tx: Tx, rows: MediaUpsert[], now: Date): Promise<UpsertMediaResult> {
  const unique = new Map<string, MediaUpsert>();
  for (const row of rows) {
    if (!unique.has(row.id)) unique.set(row.id, row);
  }
  if (unique.size === 0) return { inserted: [], missingThumbnail: [] };

  const values = [...unique.values()].map((r) => ({
    id: r.id,
    account_id: r.account_id,
    media_type: r.media_type,
    media_product_type: r.media_product_type,
    posted_at: r.posted_at,
    caption: r.caption,
    permalink: r.permalink,
    expires_at: r.expires_at,
    first_seen_at: now,
    last_synced_at: now,
  }));
  const returned = await tx<UpsertReturning[]>`
    insert into public.media ${tx(values, ...INSERT_COLUMNS)}
    on conflict (id) do update set
      media_type = excluded.media_type,
      media_product_type = excluded.media_product_type,
      caption = excluded.caption,
      permalink = excluded.permalink,
      expires_at = excluded.expires_at,
      last_synced_at = excluded.last_synced_at,
      gone_at = null
    returning id, (xmax = 0) as inserted, thumbnail_path
  `;
  // returning の順序は保証されないので、渡した順に並べ直す
  const byId = new Map(returned.map((r) => [r.id, r] as const));
  const inserted: string[] = [];
  const missingThumbnail: string[] = [];
  for (const id of unique.keys()) {
    const r = byId.get(id);
    if (!r) continue;
    if (r.inserted) inserted.push(id);
    if (r.thumbnail_path === null) missingThumbnail.push(id);
  }
  return { inserted, missingThumbnail };
}

/** サムネイルを Storage に保存できたあとに `thumbnail_path` を入れる。トランザクションの外で呼ぶ */
export async function setThumbnailPath(db: Db, mediaId: string, path: string): Promise<void> {
  await db`update public.media set thumbnail_path = ${path} where id = ${mediaId}`;
}

/**
 * 一覧になかった行に `gone_at = now` を入れ、更新した行数を返す。
 * 対象は、そのアカウントの `productTypes` の行で、`gone_at` が null で、`seenIds` に含まれないもの。
 * `onlyExpiresAfter` があれば `expires_at > onlyExpiresAfter` の行だけ（`expires_at` が null の行は対象外）
 */
export async function markGone(tx: Tx, args: MarkGoneArgs): Promise<number> {
  const result = await tx`
    update public.media set gone_at = ${args.now}
    where account_id = ${args.accountId}
      and media_product_type = any(${args.productTypes}::text[])
      and gone_at is null
      and id <> all(${args.seenIds}::text[])
      ${args.onlyExpiresAfter ? tx`and expires_at > ${args.onlyExpiresAfter}` : tx``}
  `;
  return result.count;
}

/**
 * そのアカウントの `productTypes` のうち `gone_at` が null の行数。`media_sync --full` が一覧が空だったときに、
 * 消失判定を見送るかどうかの判断に使う（API の一時的な異常で全投稿を消失扱いにしないため）
 */
export async function countActiveMedia(db: Db, accountId: string, productTypes: MediaProductType[]): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from public.media
    where account_id = ${accountId} and media_product_type = any(${productTypes}::text[]) and gone_at is null
  `;
  return row?.n ?? 0;
}

/** そのアカウントの `productTypes` の ID をすべて返す（`gone_at` の有無を問わない）。差分同期の `shouldContinuePaging` 用 */
export async function listMediaIds(db: Db, accountId: string, productTypes: MediaProductType[]): Promise<Set<string>> {
  const rows = await db<{ id: string }[]>`
    select id from public.media
    where account_id = ${accountId} and media_product_type = any(${productTypes}::text[])
  `;
  return new Set(rows.map((r) => r.id));
}

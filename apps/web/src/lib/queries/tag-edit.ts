/**
 * タグの編集（`/tags/edit`）と投稿詳細のタグの表示の読み書き（R5 設計 6.2 節）。編集画面の SQL はすべてここに置く（S3）。
 *
 * - どの文も対象のアカウント（`getTargetAccount()` の id。フォームからは受け取らない）の行だけに効くように絞る（S4）
 *   - `tag_axes`: `where id = $axis and account_id = $acc`
 *   - `tag_values` には `account_id` がないので `tag_axes` を通して絞る（update は `from`、delete は `using`、insert は `select … from tag_axes`）
 *   - `media_tags`: delete と upsert とも `account_id = $acc`。ストーリーズの投稿には書かない（確認事項 Q3）
 * - 0 行に効いたとき（別のアカウントの id、消された id）は `not_found` を返す（画面は汎用の固定の文言）
 * - 失敗は例外を投げずに結果で返す。SQLSTATE だけを返し、DB のエラー文は返さない（S9）。ログはここでは出さない
 * - 件数の上限（軸 10、値 50）は DB の制約ではなく、ここの insert の条件で検査する（5.1 (5)。上限の値は呼び出し側が渡す）
 */
import "server-only";
import { dbFromEnv, type Db, type Tx } from "@/lib/db";
import { describeDbError, errorCode, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";
import { signWithSession } from "@/lib/queries/media";

/* ------------------------------------------------------------------
 * 書き込みの結果
 * ------------------------------------------------------------------ */

/**
 * - `not_found`: 0 行に効いた（別のアカウント、消された id、ストーリーズ、上限に達した insert）
 * - `db`: DB のエラー。`sqlstate` は Postgres の SQLSTATE（5 文字）のときだけ
 */
export type TagWriteResult = { ok: true } | { ok: false; kind: "not_found" } | { ok: false; kind: "db"; sqlstate: string | undefined };

/** postgres.js の `PostgresError` の SQLSTATE。それ以外（接続のエラーなど）は undefined */
export function sqlStateOf(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || (e as { name?: unknown }).name !== "PostgresError") return undefined;
  const code = errorCode(e);
  return code !== undefined && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** トランザクションの中で 0 行と分かったときに投げ、ロールバックさせる */
class NotFound extends Error {}

async function write(run: () => Promise<boolean>): Promise<TagWriteResult> {
  try {
    return (await run()) ? { ok: true } : { ok: false, kind: "not_found" };
  } catch (e) {
    if (e instanceof NotFound) return { ok: false, kind: "not_found" };
    return { ok: false, kind: "db", sqlstate: sqlStateOf(e) };
  }
}

/* ------------------------------------------------------------------
 * 並び順（T11）
 * ------------------------------------------------------------------ */

export interface OrderRow {
  id: string;
  sort_order: number;
}

/**
 * 「上へ」「下へ」で書き換える行（純粋。`rows` は `sort_order, id` の順に並んだ同じ親の行）。
 * - 対象がなければ undefined（0 行）
 * - 先頭の「上へ」、末尾の「下へ」は空（何も変えない）
 * - 隣と `sort_order` が違えば 2 行の値を入れ替える
 * - 隣と同じ値（同順位。足すときの競合でできうる）なら入れ替えた後の並びで 0 から振り直し、値が変わる行だけを返す
 */
export function planMove(rows: readonly OrderRow[], id: string, direction: "up" | "down"): OrderRow[] | undefined {
  const index = rows.findIndex((r) => r.id === id);
  if (index < 0) return undefined;
  const neighborIndex = direction === "up" ? index - 1 : index + 1;
  const target = rows[index];
  const neighbor = rows[neighborIndex];
  if (target === undefined || neighbor === undefined) return [];
  if (target.sort_order !== neighbor.sort_order) {
    return [
      { id: target.id, sort_order: neighbor.sort_order },
      { id: neighbor.id, sort_order: target.sort_order },
    ];
  }
  const reordered = [...rows];
  reordered[index] = neighbor;
  reordered[neighborIndex] = target;
  return reordered
    .map((r, i) => ({ id: r.id, sort_order: i }))
    .filter((r, i) => reordered[i]?.sort_order !== r.sort_order);
}

/* ------------------------------------------------------------------
 * 軸
 * ------------------------------------------------------------------ */

/** 軸を足す。並び順はそのアカウントの最大値 + 1（なければ 0）。軸が `maxAxes` 個あれば足さない（`not_found`） */
export function createAxis(db: Db, accountId: string, name: string, maxAxes: number): Promise<TagWriteResult> {
  return write(async () => {
    const rows = await db`
      insert into public.tag_axes (account_id, name, sort_order)
      select ${accountId}::uuid, ${name}, coalesce(max(a.sort_order) + 1, 0)
      from public.tag_axes a
      where a.account_id = ${accountId}
      having count(*) < ${maxAxes}
      returning id
    `;
    return rows.length === 1;
  });
}

export function renameAxis(db: Db, accountId: string, axisId: string, name: string): Promise<TagWriteResult> {
  return write(async () => {
    const rows = await db`
      update public.tag_axes set name = ${name}
      where id = ${axisId}::bigint and account_id = ${accountId}
      returning id
    `;
    return rows.length === 1;
  });
}

/** 軸を消す。値と投稿への対応もカスケードで消える（D2）。確認の表示を経たかは呼び出し側が確かめる（S10） */
export function deleteAxis(db: Db, accountId: string, axisId: string): Promise<TagWriteResult> {
  return write(async () => {
    const rows = await db`
      delete from public.tag_axes
      where id = ${axisId}::bigint and account_id = ${accountId}
      returning id
    `;
    return rows.length === 1;
  });
}

/** 軸を隣と入れ替える（1 トランザクション） */
export function moveAxis(db: Db, accountId: string, axisId: string, direction: "up" | "down"): Promise<TagWriteResult> {
  return write(() =>
    db.begin(async (tx) => {
      const rows = await tx<OrderRow[]>`
        select id::text as id, sort_order
        from public.tag_axes
        where account_id = ${accountId}
        order by tag_axes.sort_order, tag_axes.id
        for update
      `;
      const plan = planMove(rows, axisId, direction);
      if (plan === undefined) throw new NotFound();
      for (const p of plan) {
        const updated = await tx`
          update public.tag_axes set sort_order = ${p.sort_order}
          where id = ${p.id}::bigint and account_id = ${accountId}
          returning id
        `;
        if (updated.length !== 1) throw new NotFound();
      }
      return true;
    }),
  );
}

/* ------------------------------------------------------------------
 * 値
 * ------------------------------------------------------------------ */

/** 値を足す。並び順はその軸の最大値 + 1（なければ 0）。軸が別のアカウントか、値が `maxValues` 個あれば足さない（`not_found`） */
export function createValue(
  db: Db,
  accountId: string,
  axisId: string,
  name: string,
  maxValues: number,
): Promise<TagWriteResult> {
  return write(async () => {
    const rows = await db`
      insert into public.tag_values (axis_id, name, sort_order)
      select a.id, ${name},
        coalesce((select max(v.sort_order) + 1 from public.tag_values v where v.axis_id = a.id), 0)
      from public.tag_axes a
      where a.id = ${axisId}::bigint and a.account_id = ${accountId}
        and (select count(*) from public.tag_values v where v.axis_id = a.id) < ${maxValues}
      returning id
    `;
    return rows.length === 1;
  });
}

export function renameValue(db: Db, accountId: string, valueId: string, name: string): Promise<TagWriteResult> {
  return write(async () => {
    const rows = await db`
      update public.tag_values v set name = ${name}
      from public.tag_axes a
      where v.axis_id = a.id and a.account_id = ${accountId} and v.id = ${valueId}::bigint
      returning v.id
    `;
    return rows.length === 1;
  });
}

/** 値を消す。投稿に付いていれば DB が 23503 で拒む（`media_tags` の外部キーが no action） */
export function deleteValue(db: Db, accountId: string, valueId: string): Promise<TagWriteResult> {
  return write(async () => {
    const rows = await db`
      delete from public.tag_values v
      using public.tag_axes a
      where v.axis_id = a.id and a.account_id = ${accountId} and v.id = ${valueId}::bigint
      returning v.id
    `;
    return rows.length === 1;
  });
}

/** 値を同じ軸の隣と入れ替える（1 トランザクション） */
export function moveValue(db: Db, accountId: string, valueId: string, direction: "up" | "down"): Promise<TagWriteResult> {
  return write(() =>
    db.begin(async (tx) => {
      const [owner] = await tx<{ axis_id: string }[]>`
        select v.axis_id::text as axis_id
        from public.tag_values v
        join public.tag_axes a on a.id = v.axis_id
        where v.id = ${valueId}::bigint and a.account_id = ${accountId}
      `;
      if (owner === undefined) throw new NotFound();
      const rows = await tx<OrderRow[]>`
        select v.id::text as id, v.sort_order
        from public.tag_values v
        where v.axis_id = ${owner.axis_id}::bigint
        order by v.sort_order, v.id
        for update
      `;
      const plan = planMove(rows, valueId, direction);
      if (plan === undefined) throw new NotFound();
      for (const p of plan) {
        const updated = await tx`
          update public.tag_values v set sort_order = ${p.sort_order}
          from public.tag_axes a
          where v.axis_id = a.id and a.account_id = ${accountId} and v.id = ${p.id}::bigint
          returning v.id
        `;
        if (updated.length !== 1) throw new NotFound();
      }
      return true;
    }),
  );
}

/* ------------------------------------------------------------------
 * 投稿へのタグ付け
 * ------------------------------------------------------------------ */

async function setOneTag(tx: Tx, accountId: string, mediaId: string, axisId: string, valueId: string | null): Promise<void> {
  if (valueId === null) {
    await tx`
      delete from public.media_tags
      where media_id = ${mediaId} and axis_id = ${axisId}::bigint and account_id = ${accountId}
    `;
    return;
  }
  // 軸と値の組、軸とアカウントの組は複合の外部キーが検査する（合わなければ 23503）
  await tx`
    insert into public.media_tags (media_id, account_id, axis_id, value_id)
    values (${mediaId}, ${accountId}::uuid, ${axisId}::bigint, ${valueId}::bigint)
    on conflict (media_id, axis_id) do update set value_id = excluded.value_id
    where media_tags.account_id = ${accountId}
  `;
}

/**
 * 投稿 1 件の軸ごとのタグを 1 トランザクションで入れ替える。`valueId` が null の軸は外す。
 * 投稿が対象のアカウントのもので、ストーリーズでないときだけ書く（違えば `not_found`）
 */
export function setMediaTags(
  db: Db,
  accountId: string,
  mediaId: string,
  entries: readonly { axisId: string; valueId: string | null }[],
): Promise<TagWriteResult> {
  return write(() =>
    db.begin(async (tx) => {
      const media = await tx`
        select 1 from public.media
        where id = ${mediaId} and account_id = ${accountId} and media_product_type <> 'STORY'
      `;
      if (media.length !== 1) throw new NotFound();
      for (const e of entries) {
        await setOneTag(tx, accountId, mediaId, e.axisId, e.valueId);
      }
      return true;
    }),
  );
}

/* ------------------------------------------------------------------
 * 読み出し（編集画面）
 * ------------------------------------------------------------------ */

export interface TagValueItem {
  id: string;
  name: string;
  sort_order: number;
  /** この値が付いている投稿の数 */
  media_count: number;
}

export interface TagAxisItem {
  id: string;
  name: string;
  sort_order: number;
  /** この軸のタグが付いている投稿の数 */
  tagged_count: number;
  /** 並び順（`sort_order`、同じなら id） */
  values: TagValueItem[];
}

/** 対象のアカウントの軸と値（並び順）と件数 */
export async function getTagEditor(accountId: string): Promise<QueryResult<TagAxisItem[]>> {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = dbFromEnv(env.env);
    const [axes, values] = await Promise.all([
      db<Omit<TagAxisItem, "values">[]>`
        select a.id::text as id, a.name, a.sort_order,
          (select count(*)::int from public.media_tags t where t.axis_id = a.id and t.account_id = a.account_id) as tagged_count
        from public.tag_axes a
        where a.account_id = ${accountId}
        order by a.sort_order, a.id
      `,
      db<(TagValueItem & { axis_id: string })[]>`
        select v.id::text as id, v.axis_id::text as axis_id, v.name, v.sort_order,
          (select count(*)::int from public.media_tags t
            where t.value_id = v.id and t.axis_id = v.axis_id and t.account_id = a.account_id) as media_count
        from public.tag_values v
        join public.tag_axes a on a.id = v.axis_id
        where a.account_id = ${accountId}
        order by v.axis_id, v.sort_order, v.id
      `,
    ]);
    const data: TagAxisItem[] = axes.map((a) => ({
      id: a.id,
      name: a.name,
      sort_order: a.sort_order,
      tagged_count: a.tagged_count,
      values: values
        .filter((v) => v.axis_id === a.id)
        .map((v) => ({ id: v.id, name: v.name, sort_order: v.sort_order, media_count: v.media_count })),
    }));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
}

export interface TagMediaRow {
  media_id: string;
  /** `public.media_kind()` の値（ストーリーズは入らない） */
  kind: string;
  posted_at: Date;
  caption: string | null;
  thumbnail_path: string | null;
  gone_at: Date | null;
  /** 軸の id → 値の id */
  tags: Record<string, string>;
}

export interface TagMediaRowWithThumbnail extends TagMediaRow {
  thumbnail_url: string | null;
}

export interface TagMediaPage {
  page: number;
  pageCount: number;
  total: number;
  items: TagMediaRowWithThumbnail[];
}

/**
 * 投稿へのタグ付けの表の 1 ページ（ストーリーズを除く、新しい順）。`missingAxisId`（検査済みの軸の id）があれば、
 * その軸のタグがない投稿だけ。サムネイルはログインした本人のセッションで署名する（失敗しても表は返す）
 */
export async function getTagMediaPage(
  accountId: string,
  params: { page: number; pageSize: number; missingAxisId: string | undefined },
): Promise<QueryResult<TagMediaPage>> {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  const page = Number.isSafeInteger(params.page) && params.page >= 1 ? params.page : 1;
  const pageSize = Math.max(1, Math.floor(params.pageSize));
  try {
    const db = dbFromEnv(env.env);
    const missing =
      params.missingAxisId === undefined
        ? db``
        : db`and not exists (
            select 1 from public.media_tags t
            where t.media_id = m.id and t.axis_id = ${params.missingAxisId}::bigint and t.account_id = ${accountId}
          )`;
    const [rows, counts] = await Promise.all([
      db<TagMediaRow[]>`
        select m.id as media_id, public.media_kind(m.media_product_type, m.media_type) as kind,
          m.posted_at, m.caption, m.thumbnail_path, m.gone_at,
          coalesce((
            select jsonb_object_agg(t.axis_id::text, t.value_id::text)
            from public.media_tags t
            where t.media_id = m.id and t.account_id = ${accountId}
          ), '{}'::jsonb) as tags
        from public.media m
        where m.account_id = ${accountId} and m.media_product_type <> 'STORY'
          ${missing}
        order by m.posted_at desc, m.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `,
      db<{ total: number }[]>`
        select count(*)::int as total
        from public.media m
        where m.account_id = ${accountId} and m.media_product_type <> 'STORY'
          ${missing}
      `,
    ]);
    const total = counts[0]?.total ?? 0;
    const paths = rows.map((r) => r.thumbnail_path).filter((p): p is string => typeof p === "string");
    const signed = paths.length > 0 ? await signWithSession(paths) : new Map<string, string>();
    const items = rows.map((r) => ({
      ...r,
      tags: r.tags ?? {},
      thumbnail_url: r.thumbnail_path === null ? null : (signed.get(r.thumbnail_path) ?? null),
    }));
    return { ok: true, data: { page, pageCount: Math.max(1, Math.ceil(total / pageSize)), total, items } };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
}

/* ------------------------------------------------------------------
 * 読み出し（投稿詳細）
 * ------------------------------------------------------------------ */

export interface MediaTagLabel {
  axis_name: string;
  value_name: string;
}

export interface MediaTagSummary {
  /** 軸の並び順 */
  tags: MediaTagLabel[];
  /** 編集画面の表（新しい順、ストーリーズを除く）で、この投稿の前にある投稿の数。ページの計算に使う */
  position: number;
}

/** 投稿 1 件に付いているタグ（軸の並び順）と、編集画面の表での位置。投稿が対象のアカウントのものでなければ空と 0 */
export async function getMediaTagSummary(accountId: string, mediaId: string): Promise<QueryResult<MediaTagSummary>> {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = dbFromEnv(env.env);
    const [tags, positions] = await Promise.all([
      db<MediaTagLabel[]>`
        select a.name as axis_name, v.name as value_name
        from public.media_tags t
        join public.tag_axes a on a.id = t.axis_id and a.account_id = t.account_id
        join public.tag_values v on v.id = t.value_id and v.axis_id = t.axis_id
        where t.media_id = ${mediaId} and t.account_id = ${accountId}
        order by a.sort_order, a.id
      `,
      db<{ position: number }[]>`
        select count(*)::int as position
        from public.media x
        join public.media m
          on m.account_id = x.account_id and m.media_product_type <> 'STORY'
          and (m.posted_at, m.id) > (x.posted_at, x.id)
        where x.id = ${mediaId} and x.account_id = ${accountId}
      `,
    ]);
    return { ok: true, data: { tags: [...tags], position: positions[0]?.position ?? 0 } };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
}

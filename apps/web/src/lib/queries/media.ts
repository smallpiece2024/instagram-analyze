/**
 * 投稿一覧（`/media`）と投稿の CSV（`/export/media`）の読み出し（R3 設計 3.3 節、4.5 節、7 章）。
 *
 * - 元は `public.media_list_metrics`（ストーリーズを除く 1 投稿 1 行。指標は最新のスナップショット）
 * - すべての関数は第 1 引数に対象のアカウントの `accountId` を取る（4.1 節）
 * - 並べ替えはキー → 列名の固定の対応表で列名を決め、postgres.js の識別子ヘルパーで埋める。向きは 2 値の分岐で書く
 * - `numeric` は postgres.js では文字列になるので、SQL で `float8` にして数で返す
 * - 基準値（`tfoot`）は行と同じ各投稿の最新の値で、全投稿から計算する（3.1 節「比較の値」）
 */
import "server-only";
import { cache } from "react";
import { dbFromEnv, type Db } from "@/lib/db";
import { describeDbError, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";
import { PAGE_SIZE } from "@/lib/format";
import type { MediaCsvRow } from "@/lib/csv";
import type { ErDenominator, SortOrder } from "@/lib/params";
import { readAuthEnv } from "@/lib/auth-env";
import { signThumbnailUrls, THUMBNAIL_BUCKET } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/* ------------------------------------------------------------------
 * 並べ替え
 * ------------------------------------------------------------------ */

/** 並べ替えのキー → 下の行のクエリの列名（3.3 節の表）。キーは URL の `sort` の許可リストを兼ねる */
const SORT_COLUMNS = {
  posted: "posted_at",
  reach: "reach",
  views: "views",
  likes: "likes",
  saved: "saved",
  save_rate: "save_rate",
  share_rate: "share_rate",
  er: "er",
  profile_visits: "profile_visits",
} as const;

export type MediaSortKey = keyof typeof SORT_COLUMNS;
export const MEDIA_SORT_KEYS = Object.keys(SORT_COLUMNS) as MediaSortKey[];

/** `nulls last` で並べ、同じ値は `posted_at desc, media_id desc` で順を固定する */
function orderBy(db: Db, sort: MediaSortKey, order: SortOrder) {
  const column = db(SORT_COLUMNS[sort] ?? SORT_COLUMNS.posted);
  return order === "asc"
    ? db`order by ${column} asc nulls last, posted_at desc, media_id desc`
    : db`order by ${column} desc nulls last, posted_at desc, media_id desc`;
}

/**
 * ER の式（分母の切り替え。3.1 節）。リーチはビューの `er`、閲覧数は閲覧数、フォロワー数は投稿時のフォロワー数で割る。
 * 分母が 0 なら null
 */
function erExpression(db: Db, er: ErDenominator) {
  switch (er) {
    case "views":
      return db`(likes + comments + saved + shares) / nullif(views, 0)`;
    case "followers":
      return db`(likes + comments + saved + shares) / nullif(followers_at_post, 0)`;
    case "reach":
      return db`er`;
  }
}

/* ------------------------------------------------------------------
 * 一覧
 * ------------------------------------------------------------------ */

export interface MediaListParams {
  sort: MediaSortKey;
  order: SortOrder;
  /** 1 以上の整数（`parsePageNumber` で検査済み） */
  page: number;
  er: ErDenominator;
}

export interface MediaListRow {
  media_id: string;
  /** `public.media_kind()` の値 */
  kind: string;
  posted_at: Date;
  /** 投稿から今までの時間（時間） */
  elapsed_hours: number;
  caption: string | null;
  thumbnail_path: string | null;
  is_collab: boolean | null;
  is_trial_reel: boolean | null;
  is_boosted: boolean | null;
  gone_at: Date | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  profile_visits: number | null;
  followers_at_post: number | null;
  save_rate: number | null;
  share_rate: number | null;
  /** 選んだ分母の ER */
  er: number | null;
  /** 閲覧数の定義が変わった日（`metric_definitions`）より前の投稿 */
  views_before_change: boolean;
}

/** 1 ページ分の投稿（サムネイルの署名なし） */
export const listMedia = cache(
  async (accountId: string, params: MediaListParams): Promise<QueryResult<MediaListRow[]>> => {
    await markDynamic();
    const env = readEnv();
    if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
    const page = Number.isSafeInteger(params.page) && params.page >= 1 ? params.page : 1;
    try {
      const db = dbFromEnv(env.env);
      const rows = await db<MediaListRow[]>`
        with r as (
          select
            media_id, kind, posted_at,
            (extract(epoch from (now() - posted_at)) / 3600)::float8 as elapsed_hours,
            caption, thumbnail_path, is_collab, is_trial_reel, is_boosted, gone_at,
            reach::float8 as reach, views::float8 as views, likes::float8 as likes,
            comments::float8 as comments, saved::float8 as saved, shares::float8 as shares,
            profile_visits::float8 as profile_visits, followers_at_post::float8 as followers_at_post,
            save_rate::float8 as save_rate, share_rate::float8 as share_rate,
            (${erExpression(db, params.er)})::float8 as er,
            coalesce(posted_date_pt < (
              select min(d.available_from) from public.metric_definitions d where d.metric = 'views'
            ), false) as views_before_change
          from public.media_list_metrics
          where account_id = ${accountId}
        )
        select * from r
        ${orderBy(db, params.sort, params.order)}
        limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}
      `;
      return { ok: true, data: [...rows] };
    } catch (e) {
      return { ok: false, reason: describeDbError(e) };
    }
  },
);

export interface MediaCount {
  total: number;
  /** 最新のスナップショットの取得時刻の最大（最終更新）。なければ null */
  last_fetched_at: Date | null;
}

/** 総件数と最終更新 */
export const countMedia = cache(async (accountId: string): Promise<QueryResult<MediaCount>> => {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = dbFromEnv(env.env);
    const [row] = await db<MediaCount[]>`
      select count(*)::int as total, max(latest_fetched_at) as last_fetched_at
      from public.media_list_metrics
      where account_id = ${accountId}
    `;
    return { ok: true, data: { total: row?.total ?? 0, last_fetched_at: row?.last_fetched_at ?? null } };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
});

/* ------------------------------------------------------------------
 * 基準値（tfoot）
 * ------------------------------------------------------------------ */

/** 基準値を出す列（一覧の数値の列と同じ） */
export const BASELINE_METRICS = [
  "reach",
  "views",
  "likes",
  "saved",
  "save_rate",
  "share_rate",
  "er",
  "profile_visits",
] as const;
export type BaselineMetric = (typeof BASELINE_METRICS)[number];

export interface BaselineStats {
  /** その指標で値のある投稿の数 */
  n: number;
  mean: number | null;
  q25: number | null;
  median: number | null;
  q75: number | null;
}

export type MediaBaseline = Record<BaselineMetric, BaselineStats>;

/** `tfoot` の基準値。全投稿（削除済みを含む）の最新の値の平均と分位（`percentile_cont`）と、指標ごとの n */
export const getMediaBaseline = cache(
  async (accountId: string, er: ErDenominator): Promise<QueryResult<MediaBaseline>> => {
    await markDynamic();
    const env = readEnv();
    if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
    try {
      const db = dbFromEnv(env.env);
      const parts = BASELINE_METRICS.map((m) => {
        const c = db(m);
        return db`
          count(${c})::int as ${db(`${m}_n`)},
          avg(${c})::float8 as ${db(`${m}_mean`)},
          (percentile_cont(0.25) within group (order by ${c}))::float8 as ${db(`${m}_q25`)},
          (percentile_cont(0.5) within group (order by ${c}))::float8 as ${db(`${m}_median`)},
          (percentile_cont(0.75) within group (order by ${c}))::float8 as ${db(`${m}_q75`)}
        `;
      });
      const [first, ...rest] = parts;
      if (first === undefined) return { ok: false, reason: "DB エラー" };
      const columns = rest.reduce((acc, p) => db`${acc}, ${p}`, first);
      const [row] = await db<Record<string, number | null>[]>`
        with r as (
          select
            reach::float8 as reach, views::float8 as views, likes::float8 as likes, saved::float8 as saved,
            save_rate::float8 as save_rate, share_rate::float8 as share_rate,
            (${erExpression(db, er)})::float8 as er,
            profile_visits::float8 as profile_visits
          from public.media_list_metrics
          where account_id = ${accountId}
        )
        select ${columns} from r
      `;
      const pick = (key: string): number | null => {
        const v = row?.[key];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      const baseline = Object.fromEntries(
        BASELINE_METRICS.map((m) => [
          m,
          {
            n: pick(`${m}_n`) ?? 0,
            mean: pick(`${m}_mean`),
            q25: pick(`${m}_q25`),
            median: pick(`${m}_median`),
            q75: pick(`${m}_q75`),
          },
        ]),
      ) as MediaBaseline;
      return { ok: true, data: baseline };
    } catch (e) {
      return { ok: false, reason: describeDbError(e) };
    }
  },
);

/* ------------------------------------------------------------------
 * 画面の 1 ページ分（一覧、総件数、基準値、サムネイルの署名）
 * ------------------------------------------------------------------ */

export interface MediaListRowWithThumbnail extends MediaListRow {
  /** 署名付き URL（1 時間）。署名できなければ null */
  thumbnail_url: string | null;
}

export interface MediaPage {
  page: number;
  /** 総ページ数（投稿が 0 件でも 1） */
  pageCount: number;
  total: number;
  last_fetched_at: Date | null;
  items: MediaListRowWithThumbnail[];
  baseline: MediaBaseline;
}

/** 投稿一覧の 1 ページ。3 つのクエリを並べて読み、1 ページ分の投稿に署名付き URL を付ける。署名に失敗してもページは返す */
export const getMediaPage = cache(
  async (accountId: string, params: MediaListParams): Promise<QueryResult<MediaPage>> => {
    const [list, count, baseline] = await Promise.all([
      listMedia(accountId, params),
      countMedia(accountId),
      getMediaBaseline(accountId, params.er),
    ]);
    if (!list.ok) return list;
    if (!count.ok) return count;
    if (!baseline.ok) return baseline;
    const paths = list.data.map((m) => m.thumbnail_path).filter((p): p is string => typeof p === "string");
    const signed = paths.length > 0 ? await signWithSession(paths) : new Map<string, string>();
    const items = list.data.map((m) => ({
      ...m,
      thumbnail_url: m.thumbnail_path === null ? null : (signed.get(m.thumbnail_path) ?? null),
    }));
    return {
      ok: true,
      data: {
        page: params.page,
        pageCount: Math.max(1, Math.ceil(count.data.total / PAGE_SIZE)),
        total: count.data.total,
        last_fetched_at: count.data.last_fetched_at,
        items,
        baseline: baseline.data,
      },
    };
  },
);

/**
 * ログインした本人のセッションで署名付き URL を作る（R2 設計 3.3 章）。認証の設定がない、クライアントを作れない、
 * 署名に失敗したときは空（画像なし）。例外を投げない
 */
async function signWithSession(paths: readonly string[]): Promise<Map<string, string>> {
  const authEnv = readAuthEnv();
  if (!authEnv.ok) return new Map<string, string>();
  try {
    const supabase = await createSupabaseServerClient(authEnv.env);
    return await signThumbnailUrls(supabase.storage.from(THUMBNAIL_BUCKET), authEnv.env.supabaseUrl, paths);
  } catch {
    return new Map<string, string>();
  }
}

/* ------------------------------------------------------------------
 * CSV（7 章）
 * ------------------------------------------------------------------ */

/**
 * 投稿の CSV の全行（ページで切らない。特殊な投稿の除外は効かせない）。並びは一覧と同じ（ER はビューの値 = 分母リーチ）。
 * 列は `MEDIA_CSV_COLUMNS` の行の形に SQL で詰め替える（`select *` で出さない。`thumbnail_path`、`account_id` は読まない）
 */
export async function listMediaCsvRows(
  accountId: string,
  params: { sort: MediaSortKey; order: SortOrder },
): Promise<QueryResult<MediaCsvRow[]>> {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = dbFromEnv(env.env);
    const rows = await db<MediaCsvRow[]>`
      with r as (
        select
          media_id, kind, posted_at, caption, permalink, is_collab, is_trial_reel, is_boosted, gone_at,
          latest_fetched_at, elapsed_latest,
          reach::float8 as reach, views::float8 as views, likes::float8 as likes, comments::float8 as comments,
          saved::float8 as saved, shares::float8 as shares, profile_visits::float8 as profile_visits,
          follows::float8 as follows, avg_watch_time_ms::float8 as avg_watch_time_ms, skip_rate::float8 as skip_rate,
          er::float8 as er, save_rate::float8 as save_rate, share_rate::float8 as share_rate,
          like_rate::float8 as like_rate, comment_rate::float8 as comment_rate,
          profile_visit_rate::float8 as profile_visit_rate, follow_conversion_rate::float8 as follow_conversion_rate,
          views_per_reach::float8 as views_per_reach, reach_7d::float8 as reach_7d, elapsed_7d,
          followers_at_post::float8 as followers_at_post, reach_rate::float8 as reach_rate
        from public.media_list_metrics
        where account_id = ${accountId}
      )
      select
        media_id, kind, posted_at as posted_at_jst, caption, permalink, is_collab, is_trial_reel, is_boosted,
        gone_at as gone_at_jst, latest_fetched_at as latest_fetched_at_jst,
        (elapsed_latest / 3600.0)::float8 as elapsed_latest_hours,
        reach, views, likes, comments, saved, shares, profile_visits, follows, avg_watch_time_ms, skip_rate,
        er, save_rate, share_rate, like_rate, comment_rate, profile_visit_rate, follow_conversion_rate,
        views_per_reach, reach_7d, (elapsed_7d / 3600.0)::float8 as elapsed_7d_hours, followers_at_post, reach_rate
      from r
      ${orderBy(db, params.sort, params.order)}
    `;
    return { ok: true, data: [...rows] };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
}

/* ------------------------------------------------------------------
 * 表示の手伝い（純粋関数）
 * ------------------------------------------------------------------ */

/** 題名の文字数 */
export const TITLE_LENGTH = 40;

/**
 * 投稿の題名（キャプションの 1 行目の先頭 40 文字）。`Array.from` で文字（コードポイント）単位に切り、サロゲートペアを割らない。
 * キャプションがない、または 1 行目が空なら null（画面で「（キャプションなし）」）
 */
export function mediaTitle(caption: string | null | undefined): string | null {
  if (typeof caption !== "string") return null;
  const firstLine = (caption.split(/\r\n|\r|\n/)[0] ?? "").trim();
  if (firstLine === "") return null;
  return Array.from(firstLine).slice(0, TITLE_LENGTH).join("");
}

/**
 * レポート `/report` の読み出し（R6 設計 6.1 節）。概要や期間比較と共通の集計は `period-summary.ts` を使い、ここには
 * レポートにだけ要るものを置く。
 *
 * - すべての関数は `(accountId, from, to)` の形で、SQL に `account_id = ${accountId}` を必ず付ける（4.1 節）
 * - 月の境目: 投稿は `posted_date_jst`（日本時間の投稿日）の暦月、ストーリーズは `story_day_jst` の暦月。
 *   日次指標（`metric_date`）とフォロワー数（`captured_on`）は `period-summary.ts` の関数が受ける
 * - `media_list_metrics` はストーリーズを含まない。ストーリーズは `story_list_metrics`
 * - Σの比は、分子と分母がどれも null でない投稿だけで計算する（3.2 節「合計の比の欠損」）。形は `RatioOfSums`／`PostSum`
 * - `numeric` と `bigint` は postgres.js では文字列になるので、SQL で `float8`／`int` にして数で返す
 */
import "server-only";
import { cache } from "react";
import type { Db } from "@/lib/db";
import type { QueryResult } from "@/lib/db-errors";
import type { RatioOfSums } from "@/lib/metrics";
import type { Ymd } from "@/lib/period";
import { postSumFrom, ratioOfSumsFrom } from "@/lib/report";
import type { TagAxis, TagPostRow, TagValue } from "@/lib/tags";
import type { ShareFlag } from "./media";
import { POST_KINDS, type PostKind, type PostSum } from "./period-summary";
import { runQuery } from "./run";

function isPostKind(v: string): v is PostKind {
  return (POST_KINDS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------
 * 5 節: 投稿の種類ごとのまとめ
 * ------------------------------------------------------------------ */

/** 1 種類の集計（フィード、カルーセル、リール）。0 件の種類も 0 件の行で返す（固定の構成） */
export interface KindSummaryRow {
  kind: PostKind;
  posts: number;
  reach: PostSum;
  views: PostSum;
  /** ER（分母リーチ数）: Σ(いいね + コメント + 保存 + シェア) ÷ Σリーチ数。5 つがどれもある投稿だけ */
  er: RatioOfSums;
  /** 保存率: Σ保存 ÷ Σリーチ数 */
  saveRate: RatioOfSums;
  /** シェア率: Σシェア ÷ Σリーチ数 */
  shareRate: RatioOfSums;
  /** プロフィール訪問の合計。値のある投稿だけ（リールは API にないので null） */
  profileVisits: PostSum;
}

interface KindSummarySqlRow {
  kind: string;
  posts: number;
  reach_n: number;
  reach_sum: number | null;
  views_n: number;
  views_sum: number | null;
  er_n: number;
  er_num: number | null;
  er_den: number | null;
  save_n: number;
  save_num: number | null;
  save_den: number | null;
  share_n: number;
  share_num: number | null;
  share_den: number | null;
  pv_n: number;
  pv_sum: number | null;
}

function emptyKind(kind: PostKind): KindSummaryRow {
  const none: PostSum = { sum: null, used: 0, total: 0 };
  const noRatio: RatioOfSums = { value: null, used: 0, total: 0 };
  return { kind, posts: 0, reach: none, views: none, er: noRatio, saveRate: noRatio, shareRate: noRatio, profileVisits: none };
}

/** 反応の 4 指標とリーチ数がどれも null でない条件 */
function erPresent(db: Db) {
  return db`likes is not null and comments is not null and saved is not null and shares is not null and reach is not null`;
}

/** その月（`posted_date_jst` の暦月）の投稿を種類ごとに集計する。3 種類を固定の順で返す */
export const getKindSummary = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<KindSummaryRow[]>> =>
    runQuery(async (db) => {
      const rows = await db<KindSummarySqlRow[]>`
        select
          kind,
          count(*)::int as posts,
          count(reach)::int as reach_n,
          sum(reach)::float8 as reach_sum,
          count(views)::int as views_n,
          sum(views)::float8 as views_sum,
          (count(*) filter (where ${erPresent(db)}))::int as er_n,
          sum(likes + comments + saved + shares) filter (where ${erPresent(db)})::float8 as er_num,
          sum(reach) filter (where ${erPresent(db)})::float8 as er_den,
          (count(*) filter (where saved is not null and reach is not null))::int as save_n,
          sum(saved) filter (where saved is not null and reach is not null)::float8 as save_num,
          sum(reach) filter (where saved is not null and reach is not null)::float8 as save_den,
          (count(*) filter (where shares is not null and reach is not null))::int as share_n,
          sum(shares) filter (where shares is not null and reach is not null)::float8 as share_num,
          sum(reach) filter (where shares is not null and reach is not null)::float8 as share_den,
          count(profile_visits)::int as pv_n,
          sum(profile_visits)::float8 as pv_sum
        from public.media_list_metrics
        where account_id = ${accountId}
          and posted_date_jst between ${from}::date and ${to}::date
        group by kind
      `;
      const byKind = new Map<string, KindSummarySqlRow>(rows.map((r) => [r.kind, r]));
      return POST_KINDS.map((kind) => {
        const r = byKind.get(kind);
        if (!r || !isPostKind(r.kind)) return emptyKind(kind);
        return {
          kind,
          posts: r.posts,
          reach: postSumFrom(r.reach_sum, r.reach_n, r.posts),
          views: postSumFrom(r.views_sum, r.views_n, r.posts),
          er: ratioOfSumsFrom(r.er_num, r.er_den, r.er_n, r.posts),
          saveRate: ratioOfSumsFrom(r.save_num, r.save_den, r.save_n, r.posts),
          shareRate: ratioOfSumsFrom(r.share_num, r.share_den, r.share_n, r.posts),
          profileVisits: postSumFrom(r.pv_sum, r.pv_n, r.posts),
        };
      });
    }),
);

/** ストーリーズの集計（5 節の 4 行目）。8 節のファネルは `getMonthFunnel` */
export interface StorySummary {
  /** その月（`story_day_jst` の暦月）のストーリーズの件数 */
  posts: number;
  views: PostSum;
  /** 離脱（タップで閉じた数）の合計 */
  tapExit: PostSum;
  /** 離脱率: Σ離脱 ÷ Σ閲覧数。どちらもある行だけ */
  exitRate: RatioOfSums;
}

interface StorySummarySqlRow {
  posts: number;
  views_n: number;
  views_sum: number | null;
  exit_n: number;
  exit_sum: number | null;
  rate_n: number;
  rate_num: number | null;
  rate_den: number | null;
}

export const getStorySummary = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<StorySummary>> =>
    runQuery(async (db) => {
      const [r] = await db<StorySummarySqlRow[]>`
        select
          count(*)::int as posts,
          count(views)::int as views_n,
          sum(views)::float8 as views_sum,
          count(tap_exit)::int as exit_n,
          sum(tap_exit)::float8 as exit_sum,
          (count(*) filter (where tap_exit is not null and views is not null))::int as rate_n,
          sum(tap_exit) filter (where tap_exit is not null and views is not null)::float8 as rate_num,
          sum(views) filter (where tap_exit is not null and views is not null)::float8 as rate_den
        from public.story_list_metrics
        where account_id = ${accountId}
          and story_day_jst between ${from}::date and ${to}::date
      `;
      const posts = r?.posts ?? 0;
      return {
        posts,
        views: postSumFrom(r?.views_sum ?? null, r?.views_n ?? 0, posts),
        tapExit: postSumFrom(r?.exit_sum ?? null, r?.exit_n ?? 0, posts),
        exitRate: ratioOfSumsFrom(r?.rate_num ?? null, r?.rate_den ?? null, r?.rate_n ?? 0, posts),
      };
    }),
);

/* ------------------------------------------------------------------
 * 6 節: よかった投稿、課題のある投稿
 * ------------------------------------------------------------------ */

/** その月の投稿 1 件（`media_list_metrics` に `media_outlier_flags` を left join した行） */
export interface HighlightRow {
  media_id: string;
  kind: PostKind;
  posted_at: Date;
  caption: string | null;
  thumbnail_path: string | null;
  gone_at: Date | null;
  /** 最新のスナップショットの経過時間（秒）。画面で日に直す */
  elapsed_latest: number | null;
  reach: number | null;
  share_rate: number | null;
  share_flag: ShareFlag | null;
  /** 比較対象の件数。判定の行がなければ null */
  peer_n: number | null;
}

/**
 * その月（`posted_date_jst` の暦月）の投稿（ストーリーズを除く）と印。上位・下位の選び方は `lib/report.ts` の `splitHighlights`。
 * 結合は `media_id` と `account_id` の両方（D15）
 */
export const getMonthHighlights = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<HighlightRow[]>> =>
    runQuery(async (db) => {
      const rows = await db<(Omit<HighlightRow, "kind"> & { kind: string })[]>`
        select
          l.media_id, l.kind, l.posted_at, l.caption, l.thumbnail_path, l.gone_at,
          l.elapsed_latest::float8 as elapsed_latest,
          l.reach::float8 as reach,
          l.share_rate::float8 as share_rate,
          f.share_flag,
          f.peer_n::int as peer_n
        from public.media_list_metrics l
        left join public.media_outlier_flags f
          on f.media_id = l.media_id and f.account_id = l.account_id
        where l.account_id = ${accountId}
          and l.posted_date_jst between ${from}::date and ${to}::date
        order by l.share_rate desc nulls last, l.posted_at desc, l.media_id
      `;
      return rows.filter((r): r is HighlightRow => isPostKind(r.kind)).map((r) => ({ ...r }));
    }),
);

/* ------------------------------------------------------------------
 * 8 節: ファネル
 * ------------------------------------------------------------------ */

export interface MonthFunnel {
  /** 投稿（フィードとカルーセル。リールはプロフィール訪問が API にない）。3 つがそろう投稿だけを足す（T16） */
  posts: { reach: PostSum; profileVisits: PostSum; follows: PostSum };
  /** ストーリーズ。閲覧数・離脱・次への 3 つがそろう行だけを足す */
  stories: { views: PostSum; tapExit: PostSum; swipeForward: PostSum };
}

interface PostFunnelSqlRow {
  total: number;
  used: number;
  reach_sum: number | null;
  pv_sum: number | null;
  follows_sum: number | null;
}

export const getMonthFunnel = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<MonthFunnel>> =>
    runQuery(async (db) => {
      const present = db`reach is not null and profile_visits is not null and follows is not null`;
      const [p] = await db<PostFunnelSqlRow[]>`
        select
          count(*)::int as total,
          (count(*) filter (where ${present}))::int as used,
          sum(reach) filter (where ${present})::float8 as reach_sum,
          sum(profile_visits) filter (where ${present})::float8 as pv_sum,
          sum(follows) filter (where ${present})::float8 as follows_sum
        from public.media_list_metrics
        where account_id = ${accountId}
          and kind in ('feed', 'carousel')
          and posted_date_jst between ${from}::date and ${to}::date
      `;
      const storyPresent = db`views is not null and tap_exit is not null and swipe_forward is not null`;
      const [s] = await db<{ total: number; used: number; views_sum: number | null; exit_sum: number | null; swipe_sum: number | null }[]>`
        select
          count(*)::int as total,
          (count(*) filter (where ${storyPresent}))::int as used,
          sum(views) filter (where ${storyPresent})::float8 as views_sum,
          sum(tap_exit) filter (where ${storyPresent})::float8 as exit_sum,
          sum(swipe_forward) filter (where ${storyPresent})::float8 as swipe_sum
        from public.story_list_metrics
        where account_id = ${accountId}
          and story_day_jst between ${from}::date and ${to}::date
      `;
      const pt = p?.total ?? 0;
      const pu = p?.used ?? 0;
      const st = s?.total ?? 0;
      const su = s?.used ?? 0;
      return {
        posts: {
          reach: postSumFrom(p?.reach_sum ?? null, pu, pt),
          profileVisits: postSumFrom(p?.pv_sum ?? null, pu, pt),
          follows: postSumFrom(p?.follows_sum ?? null, pu, pt),
        },
        stories: {
          views: postSumFrom(s?.views_sum ?? null, su, st),
          tapExit: postSumFrom(s?.exit_sum ?? null, su, st),
          swipeForward: postSumFrom(s?.swipe_sum ?? null, su, st),
        },
      };
    }),
);

/* ------------------------------------------------------------------
 * 7 節: タグ別の比較（暦月）
 * ------------------------------------------------------------------ */

/** 軸ごとの、その月の投稿 1 行（`value_id` は軸ごとの値。付いていなければ null = 「タグなし」） */
export interface TagMonthlyRow extends TagPostRow {
  axis_id: string;
}

export interface TagMonthlyData {
  /** 対象のアカウントの軸（並び順）。0 件ならタグの編集へのリンクだけを出す */
  axes: TagAxis[];
  /** 軸 id → 値（並び順。投稿が 0 件の値を含む） */
  values: Record<string, TagValue[]>;
  /** 軸 × その月の投稿。軸が 0 件なら空 */
  rows: TagMonthlyRow[];
}

/**
 * `getTagAnalysis`（過去 365 日固定）の SQL を暦月に置き換え、全部の軸を一度に返す。
 * 軸の条件は `on` 句に置く（`where` に置くと「タグなし」の投稿が落ちる）。軸ごとに投稿は重ならない（主キーが `(media_id, axis_id)`）
 */
export const getTagMonthly = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<TagMonthlyData>> =>
    runQuery(async (db) => {
      const axes = await db<TagAxis[]>`
        select a.id::text as id, a.name, a.sort_order
        from public.tag_axes a
        where a.account_id = ${accountId}
        order by a.sort_order, a.id
      `;
      if (axes.length === 0) return { axes: [], values: {}, rows: [] };
      const values = await db<(TagValue & { axis_id: string })[]>`
        select v.id::text as id, v.name, v.sort_order, v.axis_id::text as axis_id
        from public.tag_values v
        join public.tag_axes a on a.id = v.axis_id
        where a.account_id = ${accountId}
        order by v.sort_order, v.id
      `;
      const rows = await db<(Omit<TagMonthlyRow, "kind"> & { kind: string })[]>`
        select
          a.id::text as axis_id,
          l.media_id, l.kind, l.posted_at, l.caption,
          (extract(epoch from (now() - l.posted_at)) / 3600)::float8 as elapsed_hours,
          l.reach::float8 as reach, l.views::float8 as views, l.er::float8 as er,
          l.save_rate::float8 as save_rate, l.share_rate::float8 as share_rate, l.reach_rate::float8 as reach_rate,
          t.value_id::text as value_id
        from public.media_list_metrics l
        cross join public.tag_axes a
        left join public.media_tags t
          on t.media_id = l.media_id and t.axis_id = a.id and t.account_id = ${accountId}
        where l.account_id = ${accountId}
          and a.account_id = ${accountId}
          and l.posted_date_jst between ${from}::date and ${to}::date
        order by a.sort_order, a.id, l.posted_at desc, l.media_id desc
      `;
      const byAxis: Record<string, TagValue[]> = {};
      for (const a of axes) byAxis[a.id] = [];
      for (const v of values) {
        const { axis_id, ...value } = v;
        (byAxis[axis_id] ??= []).push(value);
      }
      return {
        axes: axes.map((a) => ({ ...a })),
        values: byAxis,
        rows: rows.filter((r): r is TagMonthlyRow => isPostKind(r.kind)).map((r) => ({ ...r })),
      };
    }),
);

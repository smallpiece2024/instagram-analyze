/**
 * 概要（`/`）と期間比較（`/compare`）で共通の期間集計（R3 設計 3.2 節、3.5 節、4.5 節、6 章）。
 *
 * - 日次指標（`account_daily_wide`）の日付は米国太平洋時間。期間の起点は今日ではなく、`reach` のある最新の日
 * - フォロワー数（`profile_daily.captured_on`）は日本時間の日付だが、同じ日付の値として期間に当てる（6 章）
 * - 投稿単位の値（`media_list_metrics`）は、投稿日時の日本時間の日付（`posted_date_jst`）が期間に入る投稿を数える。
 *   値は各投稿の最新の値（3.1 節「比較の値」）。ストーリーズはビューに入らないので含まない
 * - 合計の比は、分子と分母に使う指標がどれも null でない投稿だけで計算する（3.2 節「合計の比の欠損」）
 * - `bigint` と `numeric` は postgres.js では文字列になるので、SQL で `float8`／`int` にして数で返す
 * - すべての関数は `accountId` を第 1 引数に取り、SQL で `account_id = ${accountId}` を付ける（4.1 節）
 */
import "server-only";
import { cache } from "react";
import type { Db } from "@/lib/db";
import type { QueryResult } from "@/lib/db-errors";
import { ratio, type MediaKind, type RatioOfSums } from "@/lib/metrics";
import { addDays, diffDays, periodLength, type Ymd } from "@/lib/period";
import { runQuery } from "./run";

/** 純増の端の記録として使える、指定の日からの最大の日数（3.2 節「純増の端の記録」） */
export const FOLLOWER_EDGE_MAX_DAYS = 1;

/** `media_list_metrics` に入る投稿の種類（ストーリーズを除く） */
export const POST_KINDS = ["feed", "carousel", "reel"] as const satisfies readonly MediaKind[];
export type PostKind = (typeof POST_KINDS)[number];

/* ------------------------------------------------------------------
 * 日次指標の範囲
 * ------------------------------------------------------------------ */

export interface DailyRange {
  /** `reach` のある最初の日（データの始まり。太平洋時間の日付） */
  start: Ymd;
  /** `reach` のある最新の日（期間の終わりの起点。太平洋時間の日付） */
  end: Ymd;
}

/**
 * 日次指標がそろっている範囲。最新の日に `follower_count` の行しかない日（`reach` が null）は含めない。
 * 日次指標が 1 日もなければ null
 */
export const getDailyRange = cache(async (accountId: string): Promise<QueryResult<DailyRange | null>> =>
  runQuery(async (db) => {
    const [row] = await db<{ start: Ymd | null; end: Ymd | null }[]>`
      select
        min(metric_date) filter (where reach is not null) as start,
        max(metric_date) filter (where reach is not null) as "end"
      from public.account_daily_wide
      where account_id = ${accountId}
    `;
    return row?.start != null && row.end != null ? { start: row.start, end: row.end } : null;
  }),
);

/* ------------------------------------------------------------------
 * 日次の推移と期間の合計
 * ------------------------------------------------------------------ */

export interface DailyPoint {
  /** 太平洋時間の日付 */
  metric_date: Ymd;
  reach: number | null;
  views: number | null;
  accounts_engaged: number | null;
  total_interactions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  reach_follower: number | null;
  reach_non_follower: number | null;
  views_follower: number | null;
  views_non_follower: number | null;
}

/** 期間（両端を含む）の日次指標。行のない日（欠け）は返らない。日付の古い順 */
export const getDailySeries = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<DailyPoint[]>> =>
    runQuery(async (db) => {
      const rows = await db<DailyPoint[]>`
        select
          metric_date,
          reach::float8 as reach,
          views::float8 as views,
          accounts_engaged::float8 as accounts_engaged,
          total_interactions::float8 as total_interactions,
          likes::float8 as likes,
          comments::float8 as comments,
          shares::float8 as shares,
          saved::float8 as saved,
          reach_follower::float8 as reach_follower,
          reach_non_follower::float8 as reach_non_follower,
          views_follower::float8 as views_follower,
          views_non_follower::float8 as views_non_follower
        from public.account_daily_wide
        where account_id = ${accountId}
          and metric_date between ${from}::date and ${to}::date
        order by metric_date
      `;
      return [...rows];
    }),
);

/** 日別の値の合計と、値のあった日数 */
export interface DailySum {
  /** 値のある日の合計。1 日もなければ null */
  sum: number | null;
  /** 値のある日数（「30 日中 28 日分」の 28） */
  days: number;
}

export interface DailyTotals {
  /** 期間の日数（「30 日中 28 日分」の 30） */
  periodDays: number;
  /** 日別リーチ数の合計（期間の重複を除いた人数ではない） */
  reach: DailySum;
  /** 日別閲覧数の合計 */
  views: DailySum;
  /**
   * 非フォロワーリーチ比率（Σ非フォロワーのリーチ数 ÷ Σリーチ数）。内訳と合計がともにある日だけで計算する。
   * `used` はその日数、`total` は期間の日数
   */
  nonFollowerReachRate: RatioOfSums;
  /**
   * アカウント全体の ER（Σ（いいね + コメント + 保存 + シェア）÷ Σリーチ数）。4 指標とリーチ数がそろう日だけで計算する。
   * 日次の反応にストーリーズへの反応が含まれるかは未確認（2026-10-06）
   */
  er: RatioOfSums;
  /** アカウント全体の保存率（Σ保存 ÷ Σリーチ数）。保存とリーチ数がそろう日だけで計算する */
  saveRate: RatioOfSums;
  /** アカウント全体のシェア率（Σシェア ÷ Σリーチ数）。シェアとリーチ数がそろう日だけで計算する */
  shareRate: RatioOfSums;
}

/** 期間（両端を含む）の日次指標の合計 */
export const getDailyTotals = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<DailyTotals>> =>
    runQuery(async (db) => {
      const erDayPresent = db`reach is not null and likes is not null and comments is not null and saved is not null and shares is not null`;
      const [row] = await db<
        {
          reach_sum: number | null;
          reach_days: number;
          views_sum: number | null;
          views_days: number;
          nf_num: number | null;
          nf_den: number | null;
          nf_days: number;
          er_num: number | null;
          er_den: number | null;
          er_days: number;
          save_num: number | null;
          save_den: number | null;
          save_days: number;
          share_num: number | null;
          share_den: number | null;
          share_days: number;
        }[]
      >`
        select
          sum(reach)::float8 as reach_sum,
          count(reach)::int as reach_days,
          sum(views)::float8 as views_sum,
          count(views)::int as views_days,
          sum(reach_non_follower) filter (where reach is not null and reach_non_follower is not null)::float8 as nf_num,
          sum(reach) filter (where reach is not null and reach_non_follower is not null)::float8 as nf_den,
          (count(*) filter (where reach is not null and reach_non_follower is not null))::int as nf_days,
          sum(likes + comments + saved + shares) filter (where ${erDayPresent})::float8 as er_num,
          sum(reach) filter (where ${erDayPresent})::float8 as er_den,
          (count(*) filter (where ${erDayPresent}))::int as er_days,
          sum(saved) filter (where reach is not null and saved is not null)::float8 as save_num,
          sum(reach) filter (where reach is not null and saved is not null)::float8 as save_den,
          (count(*) filter (where reach is not null and saved is not null))::int as save_days,
          sum(shares) filter (where reach is not null and shares is not null)::float8 as share_num,
          sum(reach) filter (where reach is not null and shares is not null)::float8 as share_den,
          (count(*) filter (where reach is not null and shares is not null))::int as share_days
        from public.account_daily_wide
        where account_id = ${accountId}
          and metric_date between ${from}::date and ${to}::date
      `;
      const periodDays = periodLength({ from, to });
      const nfDays = row?.nf_days ?? 0;
      const erDays = row?.er_days ?? 0;
      const saveDays = row?.save_days ?? 0;
      const shareDays = row?.share_days ?? 0;
      return {
        periodDays,
        reach: { sum: row?.reach_sum ?? null, days: row?.reach_days ?? 0 },
        views: { sum: row?.views_sum ?? null, days: row?.views_days ?? 0 },
        nonFollowerReachRate: {
          value: nfDays === 0 ? null : ratio(row?.nf_num, row?.nf_den),
          used: nfDays,
          total: periodDays,
        },
        er: { value: erDays === 0 ? null : ratio(row?.er_num, row?.er_den), used: erDays, total: periodDays },
        saveRate: { value: saveDays === 0 ? null : ratio(row?.save_num, row?.save_den), used: saveDays, total: periodDays },
        shareRate: { value: shareDays === 0 ? null : ratio(row?.share_num, row?.share_den), used: shareDays, total: periodDays },
      };
    }),
);

/* ------------------------------------------------------------------
 * フォロワー数（profile_daily。日本時間の日付）
 * ------------------------------------------------------------------ */

export interface FollowerPoint {
  /** 記録した日（日本時間の日付） */
  captured_on: Ymd;
  followers_count: number | null;
}

/** 期間（両端を含む）のフォロワー数の記録。日付の古い順 */
export const getFollowerSeries = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<FollowerPoint[]>> =>
    runQuery(async (db) => {
      const rows = await db<FollowerPoint[]>`
        select captured_on, followers_count
        from public.profile_daily
        where account_id = ${accountId}
          and captured_on between ${from}::date and ${to}::date
        order by captured_on
      `;
      return [...rows];
    }),
);

export interface FollowerRecord {
  captured_on: Ymd;
  followers_count: number;
}

export interface FollowerChange {
  /** 期間の終わりの日以前で最も新しい記録。終わりの日から 1 日を超えて離れていれば null */
  end: FollowerRecord | null;
  /** 期間の始まりの前日以前で最も新しい記録。前日から 1 日を超えて離れていれば null */
  start: FollowerRecord | null;
  /** 純増（end − start）。どちらかが null なら null */
  net: number | null;
  /** 最初の記録の日（「記録は 2026-09-xx から」）。記録がなければ null */
  firstCapturedOn: Ymd | null;
  /** 最新の記録（「現在 n」）。期間に関係なく全体で最も新しいもの */
  latest: FollowerRecord | null;
}

/**
 * フォロワー純増の端の記録（3.2 節「純増の端の記録」）。`followers_count` が null の記録は使わない。
 * 日次指標の `follower_count`（新規フォロワー。直近 30 日のみ）は使わない
 */
export const getFollowerChange = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<FollowerChange>> =>
    runQuery(async (db) => {
      const startTarget = addDays(from, -1);
      const [row] = await db<
        {
          end_on: Ymd | null;
          end_count: number | null;
          start_on: Ymd | null;
          start_count: number | null;
          first_on: Ymd | null;
          latest_on: Ymd | null;
          latest_count: number | null;
        }[]
      >`
        with recs as (
          select captured_on, followers_count
          from public.profile_daily
          where account_id = ${accountId}
            and followers_count is not null
        ),
        e as (select captured_on, followers_count from recs where captured_on <= ${to}::date order by captured_on desc limit 1),
        s as (select captured_on, followers_count from recs where captured_on <= ${startTarget}::date order by captured_on desc limit 1),
        l as (select captured_on, followers_count from recs order by captured_on desc limit 1)
        select
          (select captured_on from e) as end_on,
          (select followers_count from e) as end_count,
          (select captured_on from s) as start_on,
          (select followers_count from s) as start_count,
          (select min(captured_on) from recs) as first_on,
          (select captured_on from l) as latest_on,
          (select followers_count from l) as latest_count
      `;
      const record = (on: Ymd | null | undefined, count: number | null | undefined): FollowerRecord | null =>
        on != null && count != null ? { captured_on: on, followers_count: count } : null;
      const near = (r: FollowerRecord | null, target: Ymd): FollowerRecord | null =>
        r !== null && diffDays(r.captured_on, target) <= FOLLOWER_EDGE_MAX_DAYS ? r : null;
      const end = near(record(row?.end_on, row?.end_count), to);
      const start = near(record(row?.start_on, row?.start_count), startTarget);
      return {
        end,
        start,
        net: end !== null && start !== null ? end.followers_count - start.followers_count : null,
        firstCapturedOn: row?.first_on ?? null,
        latest: record(row?.latest_on, row?.latest_count),
      };
    }),
);

/* ------------------------------------------------------------------
 * 投稿単位の値（期間中に投稿した投稿。各投稿の最新の値）
 * ------------------------------------------------------------------ */

/** 値のある投稿だけの合計 */
export interface PostSum {
  /** 値のある投稿の合計。1 件もなければ null */
  sum: number | null;
  /** 計算に使った件数（「n 件中 m 件」の m） */
  used: number;
  /** 期間中の投稿の件数（「n 件中 m 件」の n） */
  total: number;
}

export interface KindTotals {
  posts: number;
  reach: PostSum;
  saved: PostSum;
}

export interface PostTotals {
  /** 期間中の投稿の件数（ストーリーズを除く） */
  posts: number;
  /** 種類ごとの内訳。0 件の種類も 0 で返す（凡例から消さない。3.2 節） */
  byKind: Record<PostKind, KindTotals>;
  /** ER（分母リーチ数）: Σ(いいね + コメント + 保存 + シェア) ÷ Σリーチ数。5 つがどれもある投稿だけ */
  er: RatioOfSums;
  /** ER（分母閲覧数）: Σ(いいね + コメント + 保存 + シェア) ÷ Σ閲覧数。5 つがどれもある投稿だけ */
  erByViews: RatioOfSums;
  /** 反応の合計（いいね + コメント + 保存 + シェア）。4 つがどれもある投稿だけ。分母フォロワー数の ER に使う */
  interactions: PostSum;
  /** 保存率: Σ保存 ÷ Σリーチ数 */
  saveRate: RatioOfSums;
  /** シェア率: Σシェア ÷ Σリーチ数 */
  shareRate: RatioOfSums;
  /** プロフィール訪問（参考）の合計。値のある投稿だけ（リールは API にない） */
  profileVisits: PostSum;
}

interface KindRow {
  kind: string;
  posts: number;
  reach_n: number;
  reach_sum: number | null;
  saved_n: number;
  saved_sum: number | null;
  er_n: number;
  er_num: number | null;
  er_den: number | null;
  erv_n: number;
  erv_num: number | null;
  erv_den: number | null;
  int_n: number;
  int_sum: number | null;
  save_n: number;
  save_num: number | null;
  save_den: number | null;
  share_n: number;
  share_num: number | null;
  share_den: number | null;
  pv_n: number;
  pv_sum: number | null;
}

function isPostKind(v: string): v is PostKind {
  return (POST_KINDS as readonly string[]).includes(v);
}

/** null を 0 として足す（合計の積み上げ用。最後に件数 0 なら null に戻す） */
function add(a: number, b: number | null): number {
  return b === null ? a : a + b;
}

/**
 * 期間（両端を含む。日本時間の日付）に投稿した投稿の集計。
 * 特殊な投稿の除外の設定（8 章の `opts`）はまだないので引数に持たない
 */
export const getPostTotals = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<PostTotals>> =>
    runQuery(async (db) => {
      const rows = await db<KindRow[]>`
        select
          kind,
          count(*)::int as posts,
          count(reach)::int as reach_n,
          sum(reach)::float8 as reach_sum,
          count(saved)::int as saved_n,
          sum(saved)::float8 as saved_sum,
          (count(*) filter (where ${allPresent(db, "reach")}))::int as er_n,
          sum(likes + comments + saved + shares) filter (where ${allPresent(db, "reach")})::float8 as er_num,
          sum(reach) filter (where ${allPresent(db, "reach")})::float8 as er_den,
          (count(*) filter (where ${allPresent(db, "views")}))::int as erv_n,
          sum(likes + comments + saved + shares) filter (where ${allPresent(db, "views")})::float8 as erv_num,
          sum(views) filter (where ${allPresent(db, "views")})::float8 as erv_den,
          (count(*) filter (where ${allPresent(db)}))::int as int_n,
          sum(likes + comments + saved + shares) filter (where ${allPresent(db)})::float8 as int_sum,
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
      return buildPostTotals([...rows]);
    }),
);

/** 反応の 4 指標（と分母）がどれも null でない条件 */
function allPresent(db: Db, denominator?: "reach" | "views") {
  const base = db`likes is not null and comments is not null and saved is not null and shares is not null`;
  if (denominator === "reach") return db`${base} and reach is not null`;
  if (denominator === "views") return db`${base} and views is not null`;
  return base;
}

function buildPostTotals(rows: KindRow[]): PostTotals {
  const emptyKind = (): KindTotals => ({ posts: 0, reach: { sum: null, used: 0, total: 0 }, saved: { sum: null, used: 0, total: 0 } });
  const byKind: Record<PostKind, KindTotals> = { feed: emptyKind(), carousel: emptyKind(), reel: emptyKind() };
  const t = {
    posts: 0,
    erN: 0, erNum: 0, erDen: 0,
    ervN: 0, ervNum: 0, ervDen: 0,
    intN: 0, intSum: 0,
    saveN: 0, saveNum: 0, saveDen: 0,
    shareN: 0, shareNum: 0, shareDen: 0,
    pvN: 0, pvSum: 0,
  };
  for (const r of rows) {
    if (isPostKind(r.kind)) {
      byKind[r.kind] = {
        posts: r.posts,
        reach: { sum: r.reach_n === 0 ? null : r.reach_sum, used: r.reach_n, total: r.posts },
        saved: { sum: r.saved_n === 0 ? null : r.saved_sum, used: r.saved_n, total: r.posts },
      };
    }
    t.posts += r.posts;
    t.erN += r.er_n;
    t.erNum = add(t.erNum, r.er_num);
    t.erDen = add(t.erDen, r.er_den);
    t.ervN += r.erv_n;
    t.ervNum = add(t.ervNum, r.erv_num);
    t.ervDen = add(t.ervDen, r.erv_den);
    t.intN += r.int_n;
    t.intSum = add(t.intSum, r.int_sum);
    t.saveN += r.save_n;
    t.saveNum = add(t.saveNum, r.save_num);
    t.saveDen = add(t.saveDen, r.save_den);
    t.shareN += r.share_n;
    t.shareNum = add(t.shareNum, r.share_num);
    t.shareDen = add(t.shareDen, r.share_den);
    t.pvN += r.pv_n;
    t.pvSum = add(t.pvSum, r.pv_sum);
  }
  const ros = (used: number, num: number, den: number): RatioOfSums => ({
    value: used === 0 ? null : ratio(num, den),
    used,
    total: t.posts,
  });
  return {
    posts: t.posts,
    byKind,
    er: ros(t.erN, t.erNum, t.erDen),
    erByViews: ros(t.ervN, t.ervNum, t.ervDen),
    interactions: { sum: t.intN === 0 ? null : t.intSum, used: t.intN, total: t.posts },
    saveRate: ros(t.saveN, t.saveNum, t.saveDen),
    shareRate: ros(t.shareN, t.shareNum, t.shareDen),
    profileVisits: { sum: t.pvN === 0 ? null : t.pvSum, used: t.pvN, total: t.posts },
  };
}

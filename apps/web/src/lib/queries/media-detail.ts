/**
 * 投稿詳細（`/media/[id]`）の読み出し（R3 設計 3.4 節、4.5 節）。
 *
 * - すべての関数は `accountId` を第 1 引数に取り、SQL で `account_id = ${accountId}` を付ける（4.1 節）
 * - 比較は常に各投稿の最新の値（`horizon = 'latest'`）どうし。比較相手は同じ種類で、この投稿自身を除く（3.1 節「比較の値」）
 * - リーチ率だけは定義どおり 7 日時点（`media_list_metrics.reach_rate`）で比べる
 * - `within_tolerance` はリーチ数の伸び方のグラフの点にだけ使い、帯グラフの分位には使わない
 * - `numeric` と `bigint` は postgres.js では文字列になるので、SQL で `float8`／`int` にして数で返す
 */
import "server-only";
import { cache } from "react";
import { readAuthEnv } from "@/lib/auth-env";
import type { QueryResult } from "@/lib/db-errors";
import type { MediaKind } from "@/lib/metrics";
import { signThumbnailUrls, THUMBNAIL_BUCKET } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runQuery } from "./run";

/* ------------------------------------------------------------------
 * 投稿 1 件
 * ------------------------------------------------------------------ */

/** 投稿 1 件（`media_list_metrics` の 1 行）。指標は最新のスナップショットの値 */
export interface MediaDetail {
  media_id: string;
  account_id: string;
  /** ストーリーズはビューに入らないので来ない */
  kind: MediaKind;
  media_type: string;
  media_product_type: string;
  posted_at: Date;
  caption: string | null;
  permalink: string | null;
  thumbnail_path: string | null;
  is_collab: boolean | null;
  is_trial_reel: boolean | null;
  is_boosted: boolean | null;
  gone_at: Date | null;
  /** 最新のスナップショットの取得時刻。スナップショットがなければ null */
  latest_fetched_at: Date | null;
  /** 最新のスナップショットの経過秒数 */
  elapsed_latest: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  profile_visits: number | null;
  follows: number | null;
  avg_watch_time_ms: number | null;
  /** 0〜1 */
  skip_rate: number | null;
  er: number | null;
  save_rate: number | null;
  share_rate: number | null;
  like_rate: number | null;
  profile_visit_rate: number | null;
  follow_conversion_rate: number | null;
  /** 7 日時点（許容幅内）のリーチ数 */
  reach_7d: number | null;
  /** 投稿前 3 日以内の記録のフォロワー数 */
  followers_at_post: number | null;
  reach_rate: number | null;
}

/**
 * 投稿 1 件。対象のアカウントのものでない、ストーリーズ、存在しないなら null（呼び出し側で `notFound()`）。
 * キャプションは画面に出すので読む（ログには出さない）
 */
export const getMedia = cache(async (accountId: string, id: string): Promise<QueryResult<MediaDetail | null>> =>
  runQuery(async (db) => {
    const rows = await db<MediaDetail[]>`
      select
        media_id, account_id, kind, media_type, media_product_type, posted_at, caption, permalink, thumbnail_path,
        is_collab, is_trial_reel, is_boosted, gone_at,
        latest_fetched_at, elapsed_latest::float8 as elapsed_latest,
        reach::float8 as reach, views::float8 as views, likes::float8 as likes, comments::float8 as comments,
        saved::float8 as saved, shares::float8 as shares, profile_visits::float8 as profile_visits,
        follows::float8 as follows, avg_watch_time_ms::float8 as avg_watch_time_ms, skip_rate::float8 as skip_rate,
        er::float8 as er, save_rate::float8 as save_rate, share_rate::float8 as share_rate, like_rate::float8 as like_rate,
        profile_visit_rate::float8 as profile_visit_rate, follow_conversion_rate::float8 as follow_conversion_rate,
        reach_7d::float8 as reach_7d, followers_at_post::float8 as followers_at_post, reach_rate::float8 as reach_rate
      from public.media_list_metrics
      where account_id = ${accountId} and media_id = ${id}
    `;
    const row = rows[0];
    return row === undefined ? null : { ...row };
  }),
);

/**
 * サムネイルの署名付き URL（一覧と同じ `signThumbnailUrls`。本人のセッションで 1 時間）。
 * パスがない、認証の設定がない、署名に失敗したときは null。例外を投げない
 */
export async function signMediaThumbnail(path: string | null): Promise<string | null> {
  if (path === null) return null;
  const authEnv = readAuthEnv();
  if (!authEnv.ok) return null;
  try {
    const supabase = await createSupabaseServerClient(authEnv.env);
    const signed = await signThumbnailUrls(supabase.storage.from(THUMBNAIL_BUCKET), authEnv.env.supabaseUrl, [path]);
    return signed.get(path) ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------
 * 経過時間の区分ごとの値（リーチ数の伸び方）
 * ------------------------------------------------------------------ */

/** リーチ数の伸び方の X 軸の区分（等間隔に置く）。ビューの `horizon` の値と同じ */
export const GROWTH_HORIZONS = ["1h", "3h", "6h", "24h", "3d", "7d", "30d", "90d"] as const;
export type GrowthHorizon = (typeof GROWTH_HORIZONS)[number];

export interface MediaHorizonPoint {
  horizon: GrowthHorizon;
  horizon_seconds: number;
  /** 実際の経過秒数（その区分に当てたスナップショット） */
  elapsed_seconds: number;
  /** 実際の経過時間が区分 + 許容幅に入るか。偽ならグラフに点を描かない */
  within_tolerance: boolean;
  reach: number | null;
}

/**
 * この投稿の区分ごとの値。まだ到達していない区分は行がない（ビューが行を作らない）。
 * 並びは区分の短い順
 */
export const getMediaHorizons = cache(async (accountId: string, id: string): Promise<QueryResult<MediaHorizonPoint[]>> =>
  runQuery(async (db) => {
    const rows = await db<MediaHorizonPoint[]>`
      select
        horizon, horizon_seconds::int as horizon_seconds, elapsed_seconds::int as elapsed_seconds,
        within_tolerance, reach::float8 as reach
      from public.media_horizon_metrics
      where account_id = ${accountId} and media_id = ${id} and horizon <> 'latest'
      order by horizon_seconds
    `;
    return rows.filter((r) => (GROWTH_HORIZONS as readonly string[]).includes(r.horizon)).map((r) => ({ ...r }));
  }),
);

/** 区分ごとの比較相手のリーチ数の分布（許容内の値だけ）。n は値のある比較相手の数 */
export interface PeerHorizonStats {
  horizon: GrowthHorizon;
  n: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
}

/**
 * 同じ種類の自分を除く投稿の、区分ごとのリーチ数の 25%、中央値、75%。
 * グラフに点として描ける（`within_tolerance` が真の）値だけから作る（3.4 節）。値のない区分は返さない
 */
export const getPeerHorizonStats = cache(
  async (accountId: string, kind: MediaKind, excludeId: string): Promise<QueryResult<PeerHorizonStats[]>> =>
    runQuery(async (db) => {
      const rows = await db<(PeerHorizonStats & { horizon_seconds: number })[]>`
        select
          horizon,
          min(horizon_seconds)::int as horizon_seconds,
          count(reach)::int as n,
          percentile_cont(0.25) within group (order by reach)::float8 as p25,
          percentile_cont(0.5) within group (order by reach)::float8 as median,
          percentile_cont(0.75) within group (order by reach)::float8 as p75
        from public.media_horizon_metrics
        where account_id = ${accountId} and kind = ${kind} and media_id <> ${excludeId}
          and horizon <> 'latest' and within_tolerance
        group by horizon
        order by min(horizon_seconds)
      `;
      return rows
        .filter((r) => (GROWTH_HORIZONS as readonly string[]).includes(r.horizon))
        .map(({ horizon, n, p25, median, p75 }) => ({ horizon, n, p25, median, p75 }));
    }),
);

/* ------------------------------------------------------------------
 * 比較相手の分布（帯グラフ）
 * ------------------------------------------------------------------ */

/** 帯グラフで比べる指標。平均視聴時間は秒に直した値（`avg_watch_time_s`） */
export const PEER_METRICS = [
  "reach",
  "views",
  "likes",
  "saved",
  "shares",
  "profile_visits",
  "follows",
  "avg_watch_time_s",
  "reach_rate",
  "save_rate",
  "share_rate",
  "like_rate",
  "er",
  "retention_rate",
  "skip_rate",
  "profile_visit_rate",
  "follow_conversion_rate",
] as const;
export type PeerMetric = (typeof PEER_METRICS)[number];

/** 1 指標の分布。n は自分を含めない、その指標で値のある比較相手の数 */
export interface MetricPeerStats {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
}

export interface PeerStatsResult {
  stats: Record<PeerMetric, MetricPeerStats>;
  /** 最新のリーチ数がこの投稿より大きい比較相手の数（順位 = これ + 1）。この投稿のリーチ数がなければ null */
  reachGreater: number | null;
}

const EMPTY_STATS: MetricPeerStats = { n: 0, min: null, max: null, mean: null, p25: null, median: null, p75: null };

/**
 * 同じ種類の自分を除く投稿の、最新の値の分位と最小・最大と指標ごとの n（3.1 節「基準値」）。
 * 指標を縦に並べ直して（`values` の lateral）指標ごとに集計する。`count` と `percentile_cont` は null を飛ばす。
 * リーチ率は 7 日時点の値（`media_list_metrics.reach_rate`）で計算する
 */
export const getPeerStats = cache(
  async (accountId: string, kind: MediaKind, excludeId: string): Promise<QueryResult<PeerStatsResult>> =>
    runQuery(async (db) => {
      const [rows, rank] = await Promise.all([
        db<({ metric: PeerMetric } & MetricPeerStats)[]>`
          with v as (
            select x.metric, x.value
            from public.media_horizon_metrics h
            cross join lateral (values
              ('reach', h.reach::float8),
              ('views', h.views::float8),
              ('likes', h.likes::float8),
              ('saved', h.saved::float8),
              ('shares', h.shares::float8),
              ('profile_visits', h.profile_visits::float8),
              ('follows', h.follows::float8),
              ('avg_watch_time_s', (h.avg_watch_time_ms / 1000)::float8),
              ('save_rate', h.save_rate::float8),
              ('share_rate', h.share_rate::float8),
              ('like_rate', h.like_rate::float8),
              ('er', h.er::float8),
              ('skip_rate', h.skip_rate::float8),
              ('profile_visit_rate', h.profile_visit_rate::float8),
              ('follow_conversion_rate', h.follow_conversion_rate::float8)
            ) as x(metric, value)
            where h.account_id = ${accountId} and h.kind = ${kind} and h.media_id <> ${excludeId}
              and h.horizon = 'latest'
            union all
            select 'reach_rate', l.reach_rate::float8
            from public.media_list_metrics l
            where l.account_id = ${accountId} and l.kind = ${kind} and l.media_id <> ${excludeId}
            union all
            -- 視聴維持率（R4）。動画の投稿だけがビューにあり、同じ種類で値のある投稿と比べる
            select 'retention_rate', f.retention_rate::float8
            from public.media_video_features f
            where f.account_id = ${accountId} and public.media_kind(f.media_product_type, f.media_type) = ${kind}
              and f.media_id <> ${excludeId}
          )
          select
            metric,
            count(value)::int as n,
            min(value) as min,
            max(value) as max,
            avg(value) as mean,
            percentile_cont(0.25) within group (order by value) as p25,
            percentile_cont(0.5) within group (order by value) as median,
            percentile_cont(0.75) within group (order by value) as p75
          from v
          group by metric
        `,
        db<{ greater: number | null }[]>`
          select (
            select count(*)::int
            from public.media_horizon_metrics h
            where h.account_id = ${accountId} and h.kind = ${kind} and h.media_id <> ${excludeId}
              and h.horizon = 'latest' and h.reach > s.reach
          ) as greater
          from public.media_horizon_metrics s
          where s.account_id = ${accountId} and s.media_id = ${excludeId} and s.horizon = 'latest'
            and s.reach is not null
        `,
      ]);
      const stats = Object.fromEntries(PEER_METRICS.map((m) => [m, { ...EMPTY_STATS }])) as Record<
        PeerMetric,
        MetricPeerStats
      >;
      for (const r of rows) {
        if (!(PEER_METRICS as readonly string[]).includes(r.metric)) continue;
        stats[r.metric] = { n: r.n, min: r.min, max: r.max, mean: r.mean, p25: r.p25, median: r.median, p75: r.p75 };
      }
      return { stats, reachGreater: rank[0]?.greater ?? null };
    }),
);

/* ------------------------------------------------------------------
 * 動画の特徴量（R4 設計 6.1 節。カットのタイムラインと視聴維持率）
 * ------------------------------------------------------------------ */

/** `media_video_features` の 1 行と画面変化の時刻。`error` 列は読まない */
export interface VideoFeatures {
  /** 今の条件の解析の状態。null はまだ解析していない */
  analysis_status: string | null;
  duration_ms: number | null;
  cut_count: number | null;
  avg_scene_ms: number | null;
  first_cut_ms: number | null;
  cuts_in_first_3s: number | null;
  retention_rate: number | null;
  /** 画面変化の時刻（ミリ秒、`seq` の順）。`success` でなければ空 */
  cut_times_ms: number[];
}

/**
 * 動画の投稿（リールとフィード動画）の特徴量。ビューに行がない（動画でない、対象のアカウントのものでない）なら null。
 * 値はビューのものをそのまま使い、画面で計算し直さない
 */
export const getVideoFeatures = cache(async (accountId: string, id: string): Promise<QueryResult<VideoFeatures | null>> =>
  runQuery(async (db) => {
    const rows = await db<VideoFeatures[]>`
      select
        f.analysis_status, f.duration_ms, f.cut_count, f.avg_scene_ms, f.first_cut_ms, f.cuts_in_first_3s,
        f.retention_rate::float8 as retention_rate,
        coalesce(
          (
            select array_agg(c.at_ms order by c.seq)
            from public.video_cuts c
            where c.analysis_id = f.analysis_id and f.analysis_status = 'success'
          ),
          '{}'::integer[]
        ) as cut_times_ms
      from public.media_video_features f
      where f.account_id = ${accountId} and f.media_id = ${id}
    `;
    const row = rows[0];
    return row === undefined ? null : { ...row, cut_times_ms: [...row.cut_times_ms] };
  }),
);

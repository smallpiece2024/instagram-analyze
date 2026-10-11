/**
 * リール分析（`/reels`）の読み出し（R4 設計 6.2 節）。
 *
 * - 期間は過去 1 年間（365 日）の固定。対象はリールだけ
 * - 指標は `media_list_metrics`（最新の値。リーチ率は 7 日時点）、動画の特徴量は `media_video_features`（今の条件の解析だけ）
 * - `error` 列は読まない。`numeric` と `bigint` は SQL で `float8`／`int` にして数で返す
 * - 計算（順位相関、分位）は `lib/reels.ts` で行う（件数が数十件なので、並べ替えのたびにページ全体を計算し直す）
 */
import "server-only";
import { cache } from "react";
import type { QueryResult } from "@/lib/db-errors";
import type { MediaKind } from "@/lib/metrics";
import type { ReelRow } from "@/lib/reels";
import { runQuery } from "./run";

/** 期間の日数（要件 4.5 章） */
export const REELS_PERIOD_DAYS = 365;

export interface ReelsData {
  rows: ReelRow[];
  /** 最新のスナップショットの取得時刻の最大（最終更新）。なければ null */
  last_fetched_at: Date | null;
}

/** 期間内のリール（投稿日時の新しい順） */
export const getReels = cache(async (accountId: string): Promise<QueryResult<ReelsData>> =>
  runQuery(async (db) => {
    const rows = await db<(ReelRow & { latest_fetched_at: Date | null })[]>`
      select
        l.media_id, l.posted_at, l.caption, l.thumbnail_path, l.gone_at, l.latest_fetched_at,
        (extract(epoch from (now() - l.posted_at)) / 3600)::float8 as elapsed_hours,
        char_length(coalesce(l.caption, ''))::int as caption_chars,
        f.analysis_status,
        f.duration_ms, f.cut_count, f.avg_scene_ms, f.first_cut_ms, f.cuts_in_first_3s, f.cuts_in_last_3s,
        l.reach::float8 as reach, l.views::float8 as views, l.avg_watch_time_ms::float8 as avg_watch_time_ms,
        f.retention_rate::float8 as retention_rate, l.skip_rate::float8 as skip_rate,
        l.share_rate::float8 as share_rate, l.save_rate::float8 as save_rate, l.reach_rate::float8 as reach_rate,
        f.text_status, f.text_segmenter_current, f.first_text_ms, f.has_text_in_first_3s,
        f.text_coverage_ratio::float8 as text_coverage_ratio, f.total_text_chars
      from public.media_list_metrics l
      left join public.media_video_features f on f.media_id = l.media_id
      where l.account_id = ${accountId}
        and l.kind = 'reel'
        and l.posted_at >= now() - make_interval(days => ${REELS_PERIOD_DAYS})
      order by l.posted_at desc, l.media_id desc
    `;
    let last: Date | null = null;
    const out: ReelRow[] = rows.map(({ latest_fetched_at, ...r }) => {
      if (latest_fetched_at !== null && (last === null || latest_fetched_at.getTime() > last.getTime())) {
        last = latest_fetched_at;
      }
      return { ...r };
    });
    return { rows: out, last_fetched_at: last };
  }),
);

/* ------------------------------------------------------------------
 * 文字で探す（R4.1 設計 6.3 節）
 * ------------------------------------------------------------------ */

/** 結果の投稿の上限と、投稿ごとに出す区間の数 */
export const TEXT_SEARCH_LIMIT = 50;
export const TEXT_SEARCH_SEGMENTS_PER_MEDIA = 3;

export interface TextSearchSegment {
  seq: number;
  start_ms: number;
  text: string;
}

/** 一致した投稿 1 件（サムネイル、題名、投稿日と、一致した区間を `start_ms` の昇順で 3 つまで） */
export interface TextSearchHit {
  media_id: string;
  kind: MediaKind;
  posted_at: Date;
  caption: string | null;
  thumbnail_path: string | null;
  gone_at: Date | null;
  /** この投稿で一致した区間の数 */
  match_count: number;
  segments: TextSearchSegment[];
}

export interface TextSearchData {
  hits: TextSearchHit[];
  /** 一致した投稿の数（上限を超えた分を含む） */
  total: number;
}

/**
 * 自分のアカウントのリールとフィード動画の、今の条件で文字の解析が済んでいる区間を `text_norm ilike` で引く。
 * `pattern` は `lib/text-search.ts` の `likePattern`（正規化 → 長さ → エスケープ済み）。SQL では正規化しない。
 * 並びは投稿日の新しい順、上限 50 件。期間は限らない。`words` と `error` は読まない
 */
export const searchTextSegments = cache(async (accountId: string, pattern: string): Promise<QueryResult<TextSearchData>> =>
  runQuery(async (db) => {
    const rows = await db<(TextSearchHit & { total: number })[]>`
      select
        l.media_id, l.kind, l.posted_at, l.caption, l.thumbnail_path, l.gone_at,
        m.match_count, m.segments,
        count(*) over ()::int as total
      from public.media_video_features f
      join public.media_list_metrics l on l.media_id = f.media_id and l.account_id = f.account_id
      cross join lateral (
        select
          count(*)::int as match_count,
          coalesce(
            json_agg(json_build_object('seq', s.seq, 'start_ms', s.start_ms, 'text', s.text) order by s.start_ms, s.seq)
              filter (where s.rn <= ${TEXT_SEARCH_SEGMENTS_PER_MEDIA}),
            '[]'::json
          ) as segments
        from (
          select s.seq, s.start_ms, s.text, row_number() over (order by s.start_ms, s.seq) as rn
          from public.video_text_segments s
          where s.analysis_id = f.text_analysis_id and s.text_norm ilike ${pattern} escape '\\'
        ) s
      ) m
      where f.account_id = ${accountId} and f.text_status = 'success' and f.text_segmenter_current and m.match_count > 0
      order by l.posted_at desc, l.media_id desc
      limit ${TEXT_SEARCH_LIMIT}
    `;
    const total = rows[0]?.total ?? 0;
    const hits: TextSearchHit[] = rows.map((r) => ({
      media_id: r.media_id,
      kind: r.kind,
      posted_at: r.posted_at,
      caption: r.caption,
      thumbnail_path: r.thumbnail_path,
      gone_at: r.gone_at,
      match_count: r.match_count,
      segments: r.segments.map((s) => ({ seq: s.seq, start_ms: s.start_ms, text: s.text })),
    }));
    return { hits, total };
  }),
);

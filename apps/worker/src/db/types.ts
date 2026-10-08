/**
 * 12 表の行の型（設計 3.5 章）。列名は DB のスネークケースのまま変換しない。
 *
 * 型の対応:
 * - `bigint` の ID 列（`job_runs.id`、`raw_api_responses.id`、`media_insight_snapshots.id`、`video_analyses.id`
 *   と、それらを参照する FK）→ `string`（postgres.js の既定。四則演算はしない）
 * - `bigint` と `numeric` の計測値（`account_daily_metrics.value`、`video_analyses.scene_threshold`、`fps`、
 *   `bitrate`、`file_size`、`video_cuts.scene_score`）→ `number`。postgres.js は文字列で返すので、
 *   `db/*.ts` の読み出しで `Number()` に変換する。書くときは数値を渡す（設計 10.2 章の型に合わせる）
 * - `timestamptz` → `Date`
 * - `date` → `YYYY-MM-DD` の文字列（`db/client.ts` で `Date` への変換を外している）
 * - `jsonb` → 具体的な型か `Record<string, unknown>`
 * - `text[]` → `string[]`
 * - null 許容の列 → `| null`
 */
import type { RateUsage } from "../lib/graph.js";

/** `accounts.status` */
export type AccountStatus = "active" | "paused" | "disconnected";
/** `private.credentials.status` */
export type CredentialStatus = "valid" | "expired" | "insufficient_scope" | "error";
/** `private.credentials.token_type` */
export type TokenType = "PAGE" | "USER";
/** `media.media_type` */
export type MediaType = "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
/** `media.media_product_type` */
export type MediaProductType = "FEED" | "REELS" | "STORY";
/** `video_analyses.status` */
export type VideoAnalysisStatus = "success" | "no_video_url" | "failed";
/** `metric_definitions.scope` */
export type MetricScope = "account_daily" | "media";
/** `metric_definitions.unit` */
export type MetricUnit = "count" | "ms" | "percent";

/** `job_runs.job_name`（設計 1.1 章） */
export type JobName =
  | "token_check"
  | "profile_daily"
  | "account_daily"
  | "audience_demographics"
  | "account_backfill"
  | "media_sync"
  | "media_snapshot"
  | "stories"
  | "video_analysis";

/** `job_runs.status` */
export type JobStatus = "running" | "success" | "partial" | "failed" | "skipped";

/** `public.accounts` */
export interface AccountRow {
  id: string;
  ig_user_id: string;
  username: string | null;
  name: string | null;
  fb_page_id: string | null;
  status: AccountStatus;
  created_at: Date;
  updated_at: Date;
}

/** `private.credentials`。トークン本体は Vault にあり、ここには `token_secret_id` だけ */
export interface CredentialRow {
  account_id: string;
  token_type: TokenType;
  token_secret_id: string;
  expires_at: Date | null;
  data_access_expires_at: Date | null;
  scopes: string[] | null;
  status: CredentialStatus;
  last_checked_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

/** `public.profile_daily` */
export interface ProfileDailyRow {
  account_id: string;
  /** 日本時間の日付（`YYYY-MM-DD`） */
  captured_on: string;
  captured_at: Date;
  followers_count: number | null;
  follows_count: number | null;
  media_count: number | null;
  raw_response_id: string | null;
}

/** `public.account_daily_metrics` */
export interface AccountDailyMetricRow {
  account_id: string;
  /** API の日付（米国太平洋時間の 0 時区切り。`YYYY-MM-DD`） */
  metric_date: string;
  metric: string;
  /** 内訳の種類。内訳なしは空文字 */
  breakdown: string;
  /** 内訳の値。内訳なしは空文字 */
  breakdown_value: string;
  /** bigint 列。null は欠損。読み出しでは `Number()` に変換する */
  value: number | null;
  fetched_at: Date;
  raw_response_id: string | null;
}

/** `public.media` */
export interface MediaRow {
  id: string;
  account_id: string;
  media_type: MediaType;
  media_product_type: MediaProductType;
  posted_at: Date;
  caption: string | null;
  permalink: string | null;
  thumbnail_path: string | null;
  expires_at: Date | null;
  is_collab: boolean | null;
  is_trial_reel: boolean | null;
  is_boosted: boolean | null;
  first_seen_at: Date;
  last_synced_at: Date;
  gone_at: Date | null;
}

/** 指標の値。null は「取れるはずが取れなかった（欠損）」 */
export type MediaMetricValue = number | null;

/**
 * `media_insight_snapshots.metrics`。キーがない: その種類では取れない指標、null: 欠損、数値: 値。
 * 内訳のある指標（`navigation`、`profile_activity`）は入れ子にする
 */
export type MediaMetrics = Record<string, MediaMetricValue | Record<string, MediaMetricValue>>;

/** `public.media_insight_snapshots` */
export interface MediaInsightSnapshotRow {
  id: string;
  media_id: string;
  fetched_at: Date;
  elapsed_seconds: number;
  metrics: MediaMetrics;
  raw_response_id: string | null;
  job_run_id: string | null;
}

/** `public.raw_api_responses` */
export interface RawApiResponseRow {
  id: string;
  account_id: string | null;
  job_run_id: string | null;
  endpoint: string;
  params: Record<string, unknown>;
  api_version: string;
  fetched_at: Date;
  http_status: number;
  body: unknown;
}

/** `public.job_runs` */
export interface JobRunRow {
  id: string;
  job_name: JobName;
  account_id: string | null;
  started_at: Date;
  finished_at: Date | null;
  status: JobStatus;
  items_fetched: number | null;
  api_calls: number | null;
  error: string | null;
  rate_usage: RateUsage | null;
}

/** `public.job_state` */
export interface JobStateRow {
  account_id: string;
  job_name: JobName;
  state: Record<string, unknown>;
  updated_at: Date;
}

/** `public.metric_definitions` */
export interface MetricDefinitionRow {
  scope: MetricScope;
  metric: string;
  label_ja: string;
  description: string | null;
  unit: MetricUnit;
  breakdowns: string[] | null;
  media_product_types: MediaProductType[] | null;
  available_from: string | null;
  deprecated_on: string | null;
  successor: string | null;
}

/** `public.video_analyses` */
export interface VideoAnalysisRow {
  id: string;
  media_id: string;
  analyzer_version: string;
  /** numeric(4, 3) 列。読み出しでは `Number()` に変換する */
  scene_threshold: number;
  status: VideoAnalysisStatus;
  error: string | null;
  analyzed_at: Date;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  /** numeric(8, 3) 列。読み出しでは `Number()` に変換する */
  fps: number | null;
  /** bigint 列。読み出しでは `Number()` に変換する */
  bitrate: number | null;
  /** bigint 列。読み出しでは `Number()` に変換する */
  file_size: number | null;
  has_audio: boolean | null;
  cut_count: number | null;
  avg_scene_ms: number | null;
  first_cut_ms: number | null;
  cuts_in_first_3s: number | null;
  /** 最後 3 秒のカット数（R4 で追加。R1 のストーリーズの行はマイグレーションで video_cuts から埋めた） */
  cuts_in_last_3s: number | null;
  /** 同じ条件で書いた回数（R4。挿入で 1、同じ条件の上書きごとに 1 増える。DB が数える） */
  attempt_count: number;
}

/** `public.video_cuts` */
export interface VideoCutRow {
  analysis_id: string;
  seq: number;
  at_ms: number;
  /** numeric(5, 4) 列。読み出しでは `Number()` に変換する */
  scene_score: number | null;
}

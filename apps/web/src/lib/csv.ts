/**
 * CSV の組み立て（R3 設計 7.2 節、7.3 節）。`server-only` なし（純粋関数）。
 *
 * - UTF-8、先頭に BOM、改行は CRLF、区切りはカンマ。引用は RFC 4180
 * - 数式の注入を防ぐ処理は「文字列の列」だけに行う。数値の列は値の形ではなく列の定義で判定する
 * - 列はコードで列挙する（ビューの全列を出さない）。`thumbnail_path`、`account_id`、署名付き URL は入れない
 */
import { formatJstCompactDate, formatJstSeconds } from "./format";

export const CSV_BOM = "﻿";
export const CSV_EOL = "\r\n";

/** 列の種類。text だけが数式の注入の対象 */
export type CsvColumnKind = "text" | "number" | "boolean" | "datetime" | "date";

export type CsvCell = string | number | boolean | Date | null | undefined;

export interface CsvColumn<Row> {
  header: string;
  kind: CsvColumnKind;
  value: (row: Row) => CsvCell;
}

/** 先頭の空白（半角、全角、タブ、CR、LF）を飛ばした最初の文字がこれなら、値の先頭に `'` を付ける */
const FORMULA_START = /^[ 　\t\r\n]*[=+\-@\t\r\n＝＋－＠]/;

/** 数式として解釈されうる文字列の先頭に `'` を付ける */
export function neutralizeFormula(s: string): string {
  return FORMULA_START.test(s) ? `'${s}` : s;
}

/** カンマ、ダブルクォート、CR、LF を含むなら囲み、中のダブルクォートを重ねる */
export function quoteCsvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 1 つのセルを文字列にする。欠損と「取れない」はどちらも空欄 */
export function csvCell(kind: CsvColumnKind, v: CsvCell): string {
  if (v === null || v === undefined) return "";
  switch (kind) {
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
      return Number.isFinite(n) ? String(n) : "";
    }
    case "boolean":
      return typeof v === "boolean" ? (v ? "true" : "false") : "";
    case "datetime":
      return v instanceof Date ? formatJstSeconds(v) : "";
    case "date":
      return typeof v === "string" ? quoteCsvField(v) : "";
    case "text":
      return quoteCsvField(neutralizeFormula(String(v)));
  }
}

/** 見出しと行から CSV の文字列を作る（BOM 付き、各行の終わりに CRLF） */
export function toCsv<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  const lines = [columns.map((c) => quoteCsvField(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.kind, c.value(row))).join(","));
  return CSV_BOM + lines.join(CSV_EOL) + CSV_EOL;
}

/** ファイル名。`instagram-media-20261005.csv`（出力した日、日本時間） */
export function csvFileName(kind: "media" | "daily", now: Date): string {
  return `instagram-${kind}-${formatJstCompactDate(now)}.csv`;
}

/* ------------------------------------------------------------------
 * 列の定義（7.3 節）。行の型は CSV の列名に合わせ、ビューの行からの詰め替えは Route Handler で行う
 * ------------------------------------------------------------------ */

/** 投稿の CSV の 1 行（`media_list_metrics` から詰め替える。`_jst` の列は Date で渡す） */
export interface MediaCsvRow {
  media_id: string;
  kind: string;
  posted_at_jst: Date | null;
  caption: string | null;
  permalink: string | null;
  is_collab: boolean | null;
  is_trial_reel: boolean | null;
  is_boosted: boolean | null;
  gone_at_jst: Date | null;
  latest_fetched_at_jst: Date | null;
  elapsed_latest_hours: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  profile_visits: number | null;
  follows: number | null;
  avg_watch_time_ms: number | null;
  skip_rate: number | null;
  er: number | null;
  save_rate: number | null;
  share_rate: number | null;
  like_rate: number | null;
  comment_rate: number | null;
  profile_visit_rate: number | null;
  follow_conversion_rate: number | null;
  views_per_reach: number | null;
  reach_7d: number | null;
  elapsed_7d_hours: number | null;
  followers_at_post: number | null;
  reach_rate: number | null;
}

/** 日次の CSV の 1 行（`account_daily_wide` に `profile_daily` を日付で付けたもの） */
export interface DailyCsvRow {
  metric_date_pt: string;
  reach: number | null;
  reach_follower: number | null;
  reach_non_follower: number | null;
  views: number | null;
  views_follower: number | null;
  views_non_follower: number | null;
  accounts_engaged: number | null;
  total_interactions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  new_followers: number | null;
  followers_count_jst_day: number | null;
  fetched_at_jst: Date | null;
}

function columnsOf<Row>(spec: readonly (readonly [keyof Row & string, CsvColumnKind])[]): CsvColumn<Row>[] {
  return spec.map(([key, kind]) => ({ header: key, kind, value: (row: Row) => row[key] as CsvCell }));
}

export const MEDIA_CSV_COLUMNS: readonly CsvColumn<MediaCsvRow>[] = columnsOf<MediaCsvRow>([
  ["media_id", "text"],
  ["kind", "text"],
  ["posted_at_jst", "datetime"],
  ["caption", "text"],
  ["permalink", "text"],
  ["is_collab", "boolean"],
  ["is_trial_reel", "boolean"],
  ["is_boosted", "boolean"],
  ["gone_at_jst", "datetime"],
  ["latest_fetched_at_jst", "datetime"],
  ["elapsed_latest_hours", "number"],
  ["reach", "number"],
  ["views", "number"],
  ["likes", "number"],
  ["comments", "number"],
  ["saved", "number"],
  ["shares", "number"],
  ["profile_visits", "number"],
  ["follows", "number"],
  ["avg_watch_time_ms", "number"],
  ["skip_rate", "number"],
  ["er", "number"],
  ["save_rate", "number"],
  ["share_rate", "number"],
  ["like_rate", "number"],
  ["comment_rate", "number"],
  ["profile_visit_rate", "number"],
  ["follow_conversion_rate", "number"],
  ["views_per_reach", "number"],
  ["reach_7d", "number"],
  ["elapsed_7d_hours", "number"],
  ["followers_at_post", "number"],
  ["reach_rate", "number"],
]);

export const DAILY_CSV_COLUMNS: readonly CsvColumn<DailyCsvRow>[] = columnsOf<DailyCsvRow>([
  ["metric_date_pt", "date"],
  ["reach", "number"],
  ["reach_follower", "number"],
  ["reach_non_follower", "number"],
  ["views", "number"],
  ["views_follower", "number"],
  ["views_non_follower", "number"],
  ["accounts_engaged", "number"],
  ["total_interactions", "number"],
  ["likes", "number"],
  ["comments", "number"],
  ["shares", "number"],
  ["saved", "number"],
  ["new_followers", "number"],
  ["followers_count_jst_day", "number"],
  ["fetched_at_jst", "datetime"],
]);

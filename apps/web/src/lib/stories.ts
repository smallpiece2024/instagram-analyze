/**
 * ストーリーズ（`/stories`）の計算（R5 設計 6.3 節、見本 `render.js` の `S.stories`）。`server-only` なし（純粋関数）。
 *
 * - 値は `story_list_metrics`（確定値 = 消える前の最後の取得）。行は `lib/queries/stories.ts` が返す
 * - 期間内の行（`in_range`）で、件数、中央値、合計、一覧、閲覧率の推移、操作の内訳を作る
 * - 離脱ファネルのまとまりの判定は、期間で絞る前の行（期間の前から続くまとまりの行を含む）で行う（確認事項 Q10、T7）
 * - データの状況で比べ方を切り替えない（1 件目の閲覧が null か 0 でも、ほかのまとまりに切り替えない。T15）
 */
import { formatCount, formatJst, formatPercent, PAGE_SIZE } from "./format";
import { MISSING_REASON_TEXT, NO_FOLLOWERS_AT_POST_TEXT, percentileCont, type Missing } from "./metrics";
import {
  parseOrder,
  parseSort,
  parseStoryRange,
  DEFAULT_STORY_RANGE,
  type ParamValue,
  type SortOrder,
  type StoryRange,
} from "./params";

/** `story_list_metrics` の 1 行（画面で使う列だけ。`numeric` は SQL で `float8` にして数で受ける） */
export interface StoryRow {
  media_id: string;
  posted_at: Date;
  /** `IMAGE` か `VIDEO` */
  media_type: string;
  thumbnail_path: string | null;
  gone_at: Date | null;
  metrics_fetched_at: Date | null;
  views: number | null;
  reach: number | null;
  tap_forward: number | null;
  tap_back: number | null;
  tap_exit: number | null;
  swipe_forward: number | null;
  link_clicks: number | null;
  replies: number | null;
  followers_at_post: number | null;
  view_rate: number | null;
  exit_rate: number | null;
  /** 期間内か（`posted_at >= now() - range 日`）。false の行は、期間の前から続くまとまりの行（ファネル用） */
  in_range: boolean;
}

/* ------------------------------------------------------------------
 * 入力
 * ------------------------------------------------------------------ */

export const STORY_SORT_KEYS = [
  "posted",
  "views",
  "view_rate",
  "exit_rate",
  "tap_forward",
  "tap_back",
  "swipe_forward",
  "link_clicks",
  "replies",
] as const;
export type StorySortKey = (typeof STORY_SORT_KEYS)[number];
export const DEFAULT_STORY_SORT: StorySortKey = "posted";

export interface StoriesParams {
  range: StoryRange;
  sort: StorySortKey;
  dir: SortOrder;
}

/** `range`、`sort`、`dir` の検査。不正な値（配列を含む）は既定に戻す */
export function parseStoriesParams(sp: Readonly<Record<string, ParamValue>>): StoriesParams {
  return {
    range: parseStoryRange(sp.range),
    sort: parseSort(sp.sort, STORY_SORT_KEYS, DEFAULT_STORY_SORT),
    dir: parseOrder(sp.dir),
  };
}

/** URL に出すクエリ。既定の値は出さない */
export function storiesQuery(p: StoriesParams): Record<string, string | undefined> {
  return {
    range: p.range === DEFAULT_STORY_RANGE ? undefined : String(p.range),
    sort: p.sort === DEFAULT_STORY_SORT ? undefined : p.sort,
    dir: p.dir === "desc" ? undefined : p.dir,
  };
}

/** 期間の文言（「過去 30 日」） */
export function storyRangeLabel(range: StoryRange): string {
  return `過去 ${range} 日`;
}

/* ------------------------------------------------------------------
 * 表示の手伝い
 * ------------------------------------------------------------------ */

/** 種類（`VIDEO` は動画、ほかは画像） */
export function storyKindLabel(mediaType: string): string {
  return mediaType === "VIDEO" ? "動画" : "画像";
}

/** JST の `M/D HH:mm`（操作の内訳の行、ファネルの見出し） */
export function storyLabel(d: Date): string {
  const s = formatJst(d);
  const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(s);
  return m ? `${Number(m[1])}/${Number(m[2])} ${m[3]}` : s;
}

/** JST の `M/D`（閲覧率の推移の横軸） */
export function storyDateLabel(d: Date): string {
  return storyLabel(d).split(" ")[0] ?? "";
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function missingOf(reason: Missing["reason"], text: string | null = MISSING_REASON_TEXT[reason]): Missing {
  return { reason, text };
}

/**
 * 閲覧率の「—」の判定。値があれば null。
 * 投稿時のフォロワー数の記録がない（または 0）なら no_baseline_data（R3 の文言）、閲覧が null なら missing
 */
export function viewRateMissing(row: Pick<StoryRow, "view_rate" | "followers_at_post">): Missing | null {
  if (finite(row.view_rate)) return null;
  if (row.followers_at_post == null || row.followers_at_post === 0) {
    return missingOf("no_baseline_data", NO_FOLLOWERS_AT_POST_TEXT);
  }
  return missingOf("missing");
}

/** 離脱率の「—」の判定。値があれば null。閲覧が 0 なら no_baseline_data（0% と書かない）、ほかは missing */
export function exitRateMissing(row: Pick<StoryRow, "exit_rate" | "views">): Missing | null {
  if (finite(row.exit_rate)) return null;
  if (row.views === 0) return missingOf("no_baseline_data");
  return missingOf("missing");
}

/** 生の値の「—」の判定（null は取得の失敗） */
export function countMissing(v: number | null): Missing | null {
  return finite(v) ? null : missingOf("missing");
}

/* ------------------------------------------------------------------
 * 期間全体の指標
 * ------------------------------------------------------------------ */

export interface ValueWithN {
  value: number | null;
  /** 計算に使った件数（値のあるものだけ） */
  n: number;
}

/** 中央値（DB の `percentile_cont` と同じ線形補間）。null と有限でない値は数えない */
export function medianWithN(values: readonly (number | null)[]): ValueWithN {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return { value: percentileCont(sorted, 0.5), n: sorted.length };
}

/** 合計。null は数えない。値が 1 件もなければ null */
export function sumWithN(values: readonly (number | null)[]): ValueWithN {
  const vs = values.filter(finite);
  return { value: vs.length === 0 ? null : vs.reduce((a, v) => a + v, 0), n: vs.length };
}

export interface StorySummary {
  count: number;
  viewRate: ValueWithN;
  exitRate: ValueWithN;
  linkClicks: ValueWithN;
  replies: ValueWithN;
}

export function storySummary(rows: readonly StoryRow[]): StorySummary {
  return {
    count: rows.length,
    viewRate: medianWithN(rows.map((r) => r.view_rate)),
    exitRate: medianWithN(rows.map((r) => r.exit_rate)),
    linkClicks: sumWithN(rows.map((r) => r.link_clicks)),
    replies: sumWithN(rows.map((r) => r.replies)),
  };
}

/* ------------------------------------------------------------------
 * 並べ替えとページ送り
 * ------------------------------------------------------------------ */

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortValue(row: StoryRow, key: StorySortKey): number | null {
  if (key === "posted") return row.posted_at.getTime();
  const v = row[key];
  return finite(v) ? v : null;
}

/** 一覧の並べ替え。値のないものは向きによらず最後。同じ値は投稿日時の新しい順、`media_id` の降順（R4 と同じ。T16） */
export function sortStories(rows: readonly StoryRow[], key: StorySortKey, dir: SortOrder): StoryRow[] {
  return rows.slice().sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va !== null && vb !== null && va !== vb) return dir === "asc" ? va - vb : vb - va;
    if (va === null && vb !== null) return 1;
    if (va !== null && vb === null) return -1;
    const t = b.posted_at.getTime() - a.posted_at.getTime();
    return t !== 0 ? t : compareId(b.media_id, a.media_id);
  });
}

export interface StoryPage {
  pageRows: StoryRow[];
  currentPage: number;
  /** 0 件でも 1 */
  pageCount: number;
}

/** 一覧の 1 ページ分（R4 の一覧と同じ PAGE_SIZE 件）。範囲外の page は最後のページに丸める */
export function paginateStories(rows: readonly StoryRow[], sort: StorySortKey, dir: SortOrder, page: number): StoryPage {
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), pageCount);
  const pageRows = sortStories(rows, sort, dir).slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  return { pageRows, currentPage, pageCount };
}

/* ------------------------------------------------------------------
 * 閲覧率の推移、操作の内訳
 * ------------------------------------------------------------------ */

/** 投稿日時、さらに id の古い順 */
export function byPostedAsc<T extends Pick<StoryRow, "posted_at" | "media_id">>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => {
    const t = a.posted_at.getTime() - b.posted_at.getTime();
    return t !== 0 ? t : compareId(a.media_id, b.media_id);
  });
}

export interface StoryTrend {
  labels: string[];
  values: (number | null)[];
  tips: string[];
}

/** 閲覧率の推移。横軸は投稿の順（古い順）、ラベルは M/D */
export function storyTrend(rows: readonly StoryRow[]): StoryTrend {
  const asc = byPostedAsc(rows);
  return {
    labels: asc.map((r) => storyDateLabel(r.posted_at)),
    values: asc.map((r) => (finite(r.view_rate) ? r.view_rate : null)),
    tips: asc.map((r) => `${storyLabel(r.posted_at)} 閲覧率: ${formatPercent(r.view_rate, 1)}`),
  };
}

/** 操作の内訳の区分（見本の順と色の濃さ） */
export const STORY_OPS = [
  { key: "tap_forward", label: "次へ", heat: 90 },
  { key: "tap_back", label: "戻る", heat: 65 },
  { key: "tap_exit", label: "離脱", heat: 45 },
  { key: "swipe_forward", label: "次のアカウントへ", heat: 25 },
] as const;

/** 操作の内訳に出す件数 */
export const STORY_OPS_RECENT = 10;

export interface StoryOpsRow {
  label: string;
  /** `STORY_OPS` の順。どれかが null（取得の失敗）なら分母が分からないので全部 null（棒を描かず「—」） */
  values: (number | null)[];
}

/** 直近 10 件（10 件未満ならあるだけ）。新しい順。割合の分母は 4 つの合計（合計 0 の行は部品が「—」を書く） */
export function storyOps(rows: readonly StoryRow[]): StoryOpsRow[] {
  return byPostedAsc(rows)
    .reverse()
    .slice(0, STORY_OPS_RECENT)
    .map((r) => {
      const values = STORY_OPS.map((o) => r[o.key]);
      return { label: storyLabel(r.posted_at), values: values.every(finite) ? values : values.map(() => null) };
    });
}

/* ------------------------------------------------------------------
 * まとまりと離脱ファネル（T7）
 * ------------------------------------------------------------------ */

/** 前の 1 件からこれ以上空いたら別のまとまり（6 時間ちょうどは別。見本の `>= 6 * 36e5`） */
export const STORY_GROUP_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * まとまりの判定。入力を投稿日時、さらに id の古い順に並べ直し、前の 1 件との差が 6 時間以上なら別のまとまりにする
 * （同時刻は同じまとまり）。各まとまりは古い順、まとまりの並びも古い順
 */
export function groupStories<T extends Pick<StoryRow, "posted_at" | "media_id">>(rows: readonly T[]): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  let prev: T | undefined;
  for (const r of byPostedAsc(rows)) {
    if (prev !== undefined && r.posted_at.getTime() - prev.posted_at.getTime() >= STORY_GROUP_GAP_MS) {
      groups.push(cur);
      cur = [];
    }
    cur.push(r);
    prev = r;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

export interface StoryFunnel {
  /** 1 件目の投稿日時（M/D HH:mm） */
  startLabel: string;
  count: number;
  labels: string[];
  /** 2 件目以降 ÷ 1 件目の閲覧（1 件目は 1）。1 件目の閲覧が null か 0 なら全部 null（「—」） */
  values: (number | null)[];
  tips: string[];
}

/**
 * 離脱ファネルに出すまとまり（確認事項 Q10）: 2 件以上で、期間内の行を 1 件以上含むまとまりのうち最も新しいもの 1 つ。
 * 1 件目が期間の外でも 1 件目から描く。なければ null。1 件目の閲覧が null か 0 でも、ほかのまとまりに切り替えない
 */
export function storyFunnel(rows: readonly StoryRow[]): StoryFunnel | null {
  const candidates = groupStories(rows).filter((g) => g.length >= 2 && g.some((r) => r.in_range));
  const g = candidates[candidates.length - 1];
  if (g === undefined) return null;
  const first = g[0] as StoryRow;
  const v0 = first.views;
  const usable = finite(v0) && v0 > 0;
  const values = g.map((r) => (usable && finite(r.views) ? r.views / (v0 as number) : null));
  return {
    startLabel: storyLabel(first.posted_at),
    count: g.length,
    labels: g.map((_, i) => `${i + 1} 件目`),
    values,
    tips: g.map((r, i) => `${i + 1} 件目: ${formatPercent(values[i], 0)}（閲覧 ${formatCount(r.views)}）`),
  };
}

/* ------------------------------------------------------------------
 * 画面全体
 * ------------------------------------------------------------------ */

export interface StoriesView {
  /** 期間内の行（投稿日時の古い順） */
  rows: StoryRow[];
  summary: StorySummary;
  trend: StoryTrend;
  ops: StoryOpsRow[];
  funnel: StoryFunnel | null;
}

/** `rows` は期間内の行と、期間の前から続くまとまりの行（`in_range = false`） */
export function buildStoriesView(all: readonly StoryRow[]): StoriesView {
  const rows = byPostedAsc(all.filter((r) => r.in_range));
  return {
    rows,
    summary: storySummary(rows),
    trend: storyTrend(rows),
    ops: storyOps(rows),
    funnel: storyFunnel(all),
  };
}

/**
 * タグ分析（`/tags`）の計算（R5 設計 6.1 節）。`server-only` なし（純粋関数）。
 *
 * - 入力の行は DB の読み出し（`queries/tags.ts`）の形。ここでは DB を使わない
 * - 中央値と帯は `percentile_cont` と同じ線形補間（`percentileCont`）。n は列ごとに数える（R3 3.1 節）
 * - 件数が数百件なので、ページのたびに計算し直す
 */
import { buildHref, type Query } from "@/components/href";
import type { StripPoint } from "@/components/charts/Strip";
import { formatValue, mediaTitle, type ValueFormat } from "./format";
import { KIND_LABEL, percentileCont } from "./metrics";
import { TAG_METRICS, type KindFilter, type TagMetric } from "./params";

/* ------------------------------------------------------------------
 * 行の形
 * ------------------------------------------------------------------ */

/** タグ分析の投稿の種類（ストーリーズを除く） */
export const POST_KINDS = ["feed", "carousel", "reel"] as const;
export type PostKind = (typeof POST_KINDS)[number];

/** 期間内の投稿 1 件（`media_list_metrics` に選んだ軸の `media_tags` を left join した行） */
export interface TagPostRow {
  media_id: string;
  kind: PostKind;
  posted_at: Date;
  caption: string | null;
  /** 投稿から今までの時間（時間） */
  elapsed_hours: number | null;
  reach: number | null;
  views: number | null;
  er: number | null;
  save_rate: number | null;
  share_rate: number | null;
  reach_rate: number | null;
  /** 選んだ軸の値の id（bigint を文字列で）。付いていなければ null（「タグなし」） */
  value_id: string | null;
}

/** タグの軸（並び順の `sort_order`、同じなら id） */
export interface TagAxis {
  id: string;
  name: string;
  sort_order: number;
}

/** タグの値 */
export interface TagValue {
  id: string;
  name: string;
  sort_order: number;
}

/** ハッシュタグを使った投稿 1 件（1 投稿 1 タグ 1 行） */
export interface HashtagPostRow {
  tag: string;
  media_id: string;
  kind: PostKind;
  posted_at: Date;
  reach: number | null;
  views: number | null;
  er: number | null;
  save_rate: number | null;
  share_rate: number | null;
  reach_rate: number | null;
}

/* ------------------------------------------------------------------
 * 指標と選択の文言
 * ------------------------------------------------------------------ */

export const TAG_METRIC_LABEL: Record<TagMetric, string> = {
  reach: "リーチ",
  views: "閲覧数",
  er: "ER",
  save_rate: "保存率",
  share_rate: "シェア率",
  reach_rate: "リーチ率",
};

export const TAG_METRIC_FORMAT: Record<TagMetric, ValueFormat> = {
  reach: "count",
  views: "count",
  er: "percent",
  save_rate: "percent",
  share_rate: "percent",
  reach_rate: "percent",
};

/** 表の中央値の列の順（経過日数の後） */
export const TAG_COLUMNS: readonly TagMetric[] = ["reach", "views", "er", "save_rate", "share_rate", "reach_rate"];

export const KIND_FILTER_LABEL: Record<KindFilter, string> = {
  all: "すべて",
  reel: KIND_LABEL.reel,
  feed: KIND_LABEL.feed,
  carousel: KIND_LABEL.carousel,
};

/** 選択肢の文言（件数つき）。`リーチ率（2 件）` */
export function optionLabel(label: string, count: number): string {
  return `${label}（${count} 件）`;
}

function fin(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function metricValue(row: Pick<TagPostRow, TagMetric>, m: TagMetric): number | null {
  const v = row[m];
  return fin(v) ? v : null;
}

/* ------------------------------------------------------------------
 * クエリ
 * ------------------------------------------------------------------ */

export interface TagsParams {
  /** 選んだ軸の id。軸が 0 件なら undefined */
  axis: string | undefined;
  kind: KindFilter;
  m: TagMetric;
}

/** URL に出すクエリ。既定の値（最初の軸、`all`、`reach`）は出さない */
export function tagsQuery(p: TagsParams, firstAxisId: string | undefined): Query {
  return {
    axis: p.axis === undefined || p.axis === firstAxisId ? undefined : p.axis,
    kind: p.kind === "all" ? undefined : p.kind,
    m: p.m === "reach" ? undefined : p.m,
  };
}

/** 選択のリンク（ほかの選択は保つ） */
export function tagsHref(p: TagsParams, firstAxisId: string | undefined, overrides: Partial<TagsParams>): string {
  return buildHref("/tags", tagsQuery({ ...p, ...overrides }, firstAxisId));
}

/* ------------------------------------------------------------------
 * 集計
 * ------------------------------------------------------------------ */

function compareIdNumeric(a: string, b: string): number {
  // id は bigint の文字列（`^\d+$`）。桁数、文字の順で比べれば数の順になる
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 軸と値の並び: `sort_order`、同じなら id の順 */
export function sortByOrder<T extends { id: string; sort_order: number }>(items: readonly T[]): T[] {
  return items.slice().sort((a, b) => (a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : compareIdNumeric(a.id, b.id)));
}

/** `kind` の絞り込み（`all` は全部） */
export function filterKind<T extends { kind: PostKind }>(rows: readonly T[], kind: KindFilter): T[] {
  return kind === "all" ? rows.slice() : rows.filter((r) => r.kind === kind);
}

/** 中央値と、その値のある件数 */
export interface MedianCell {
  n: number;
  value: number | null;
}

export function medianCell(values: readonly (number | null | undefined)[]): MedianCell {
  const sorted = values.filter(fin).sort((a, b) => a - b);
  return { n: sorted.length, value: percentileCont(sorted, 0.5) };
}

/** 比較の表の 1 行 */
export interface TagGroupRow {
  /** 値の id。「タグなし」と種類の行は null */
  id: string | null;
  /** 行の名前（利用者の文字。JSX の子として出す） */
  label: string;
  n: number;
  /** 種類ごとの件数 */
  kindCounts: Record<PostKind, number>;
  /** 経過日数の中央値（時間で持つ。表示は日に切り捨て） */
  elapsedHours: MedianCell;
  medians: Record<TagMetric, MedianCell>;
  /** 選んだ指標の投稿ごとの点 */
  points: StripPoint[];
}

export const UNTAGGED_LABEL = "タグなし";

function mediaHref(id: string): string {
  return `/media/${encodeURIComponent(id)}`;
}

export function groupRow(id: string | null, label: string, members: readonly TagPostRow[], m: TagMetric): TagGroupRow {
  const kindCounts: Record<PostKind, number> = { feed: 0, carousel: 0, reel: 0 };
  for (const r of members) kindCounts[r.kind] += 1;
  const medians = Object.fromEntries(
    TAG_METRICS.map((k) => [k, medianCell(members.map((r) => metricValue(r, k)))]),
  ) as Record<TagMetric, MedianCell>;
  const points: StripPoint[] = [];
  for (const r of members) {
    const v = metricValue(r, m);
    if (v === null) continue;
    points.push({
      value: v,
      href: mediaHref(r.media_id),
      tip: `${mediaTitle(r.caption)}: ${formatValue(v, TAG_METRIC_FORMAT[m])}`,
    });
  }
  return {
    id,
    label,
    n: members.length,
    kindCounts,
    elapsedHours: medianCell(members.map((r) => r.elapsed_hours)),
    medians,
    points,
  };
}

/**
 * タグごとの比較の行。値の並び（`sort_order`、id）で、投稿が 0 件の値の行も出す。最後に「タグなし」。
 * `rows` は `kind` で絞った後の行。値の一覧にない value_id（読み出しの間に足された値）の投稿は、どの行にも入れない
 */
export function tagGroupRows(rows: readonly TagPostRow[], values: readonly TagValue[], m: TagMetric): TagGroupRow[] {
  const byValue = new Map<string, TagPostRow[]>();
  const untagged: TagPostRow[] = [];
  for (const r of rows) {
    if (r.value_id === null) {
      untagged.push(r);
      continue;
    }
    const list = byValue.get(r.value_id);
    if (list) list.push(r);
    else byValue.set(r.value_id, [r]);
  }
  return [
    ...sortByOrder(values).map((v) => groupRow(v.id, v.name, byValue.get(v.id) ?? [], m)),
    groupRow(null, UNTAGGED_LABEL, untagged, m),
  ];
}

/** 種類ごとの比較の行（フィード、カルーセル、リール）。`kind` の選択には従わない */
export function kindGroupRows(rows: readonly TagPostRow[], m: TagMetric): TagGroupRow[] {
  return POST_KINDS.map((k) => groupRow(null, KIND_LABEL[k], rows.filter((r) => r.kind === k), m));
}

/* ------------------------------------------------------------------
 * ハッシュタグ（F-UI-32）
 * ------------------------------------------------------------------ */

export const HASHTAG_LIMIT = 30;
/** 3 件未満の行は薄く（R3 の n の決まり） */
export const HASHTAG_FAINT_MIN = 3;

export interface HashtagRow {
  tag: string;
  /** 使った投稿の件数 */
  n: number;
  /** 選んだ指標の中央値 */
  metric: MedianCell;
  reach: MedianCell;
  saveRate: MedianCell;
  lastUsedAt: Date;
}

export interface HashtagTable {
  rows: HashtagRow[];
  /** 上位 `HASHTAG_LIMIT` 行の外の行数 */
  rest: number;
}

/** 件数の多い順、同数は選んだ指標の中央値の高い順（値なしは後ろ）、さらにタグの文字列の順 */
export function compareHashtagRows(a: HashtagRow, b: HashtagRow): number {
  if (a.n !== b.n) return b.n - a.n;
  const va = a.metric.value;
  const vb = b.metric.value;
  if (va !== null && vb !== null && va !== vb) return vb - va;
  if (va === null && vb !== null) return 1;
  if (va !== null && vb === null) return -1;
  return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
}

/** ハッシュタグごとの行。`rows` は `kind` で絞った後の行（1 投稿 1 タグ 1 行） */
export function hashtagTable(rows: readonly HashtagPostRow[], m: TagMetric, limit: number = HASHTAG_LIMIT): HashtagTable {
  const byTag = new Map<string, HashtagPostRow[]>();
  for (const r of rows) {
    const list = byTag.get(r.tag);
    if (list) list.push(r);
    else byTag.set(r.tag, [r]);
  }
  const all: HashtagRow[] = [];
  for (const [tag, members] of byTag) {
    const last = new Date(Math.max(...members.map((r) => r.posted_at.getTime())));
    all.push({
      tag,
      n: new Set(members.map((r) => r.media_id)).size,
      metric: medianCell(members.map((r) => metricValue(r, m))),
      reach: medianCell(members.map((r) => r.reach)),
      saveRate: medianCell(members.map((r) => r.save_rate)),
      lastUsedAt: last,
    });
  }
  all.sort(compareHashtagRows);
  return { rows: all.slice(0, limit), rest: Math.max(0, all.length - limit) };
}

/* ------------------------------------------------------------------
 * 画面全体
 * ------------------------------------------------------------------ */

export interface TagsView {
  /** 期間内で `kind` に合う投稿の数（見出しの n） */
  total: number;
  /** そのうち選んだ軸の値がある投稿の数（見出しの m） */
  tagged: number;
  /** `kind` ごとの投稿の数（種類の選択の文言） */
  kindCounts: Record<KindFilter, number>;
  /** 指標ごとの、値がある投稿の数（指標の選択の文言。`kind` で絞った後） */
  metricCounts: Record<TagMetric, number>;
  /** `kind` で絞った全投稿の、選んだ指標の中央値（帯グラフの灰色の線） */
  overall: number | null;
  tagRows: TagGroupRow[];
  kindRows: TagGroupRow[];
  hashtags: HashtagTable;
}

export function buildTagsView(
  rows: readonly TagPostRow[],
  values: readonly TagValue[],
  hashtagRows: readonly HashtagPostRow[],
  kind: KindFilter,
  m: TagMetric,
): TagsView {
  const filtered = filterKind(rows, kind);
  return {
    total: filtered.length,
    tagged: filtered.filter((r) => r.value_id !== null).length,
    kindCounts: {
      all: rows.length,
      reel: rows.filter((r) => r.kind === "reel").length,
      feed: rows.filter((r) => r.kind === "feed").length,
      carousel: rows.filter((r) => r.kind === "carousel").length,
    },
    metricCounts: Object.fromEntries(
      TAG_METRICS.map((k) => [k, filtered.filter((r) => metricValue(r, k) !== null).length]),
    ) as Record<TagMetric, number>,
    overall: medianCell(filtered.map((r) => metricValue(r, m))).value,
    tagRows: tagGroupRows(filtered, values, m),
    kindRows: kindGroupRows(rows, m),
    hashtags: hashtagTable(filterKind(hashtagRows, kind), m),
  };
}

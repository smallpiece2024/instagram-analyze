/**
 * レポート `/report` の純粋関数（R6 設計 6.1 節、T10、T11、T16、U11）。
 * DB は読まず、`lib/queries/report.ts` が返した値を画面の形にする。`server-only` なし（単体テストで直接呼ぶ）。
 *
 * - 6 節「よかった投稿 3 件、課題のある投稿 3 件」の選び方（T10）
 * - 8 節のファネルの率（前段比と 1 段目に対する割合。前段が 0 か null なら null）
 * - 5 節の率（Σの比。分子と分母がそろう投稿だけ。`RatioOfSums`／`PostSum` の形に直す）
 * - 経過日数（秒 → 日、切り捨て）
 */

import { ratio, type RatioOfSums } from "./metrics";
import type { PostSum } from "./queries/period-summary";

/* ------------------------------------------------------------------
 * 6 節: 上位と下位の選び方（T10）
 * ------------------------------------------------------------------ */

/** 上位と下位の件数の上限 */
export const HIGHLIGHT_LIMIT = 3;

/** 選ぶのに要る列。`share_rate` が null の投稿は選ばれない */
export interface HighlightCandidate {
  media_id: string;
  posted_at: Date;
  share_rate: number | null;
}

/** 上位・下位の件数（T10）。n はシェア率が null でない投稿の数。上位は `ceil(n/2)`、下位は `floor(n/2)` を 3 で止める（重ならない） */
export function highlightCounts(n: number): { top: number; bottom: number } {
  const count = Math.max(0, Math.floor(n));
  return { top: Math.min(HIGHLIGHT_LIMIT, Math.ceil(count / 2)), bottom: Math.min(HIGHLIGHT_LIMIT, Math.floor(count / 2)) };
}

/** 並び: シェア率の高い順 → 投稿日時の新しい順 → `media_id` の昇順（同値の順を固定する） */
export function compareHighlights(a: HighlightCandidate, b: HighlightCandidate): number {
  const ra = a.share_rate ?? Number.NEGATIVE_INFINITY;
  const rb = b.share_rate ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  const ta = a.posted_at.getTime();
  const tb = b.posted_at.getTime();
  if (ta !== tb) return tb - ta;
  return a.media_id < b.media_id ? -1 : a.media_id > b.media_id ? 1 : 0;
}

/**
 * その月の投稿から上位（よかった投稿）と下位（課題のある投稿）を選ぶ（T10）。
 * シェア率が null の投稿は数にも入れず選ばない。`top` はシェア率の高い順、`bottom` はシェア率の低い順（課題の大きいものから）
 */
export function splitHighlights<T extends HighlightCandidate>(rows: readonly T[]): { top: T[]; bottom: T[] } {
  const sorted = rows.filter((r) => r.share_rate !== null && Number.isFinite(r.share_rate)).sort(compareHighlights);
  const { top, bottom } = highlightCounts(sorted.length);
  return {
    top: sorted.slice(0, top),
    bottom: bottom === 0 ? [] : sorted.slice(sorted.length - bottom).reverse(),
  };
}

/* ------------------------------------------------------------------
 * 5 節: Σの比と合計の形
 * ------------------------------------------------------------------ */

/** SQL の `sum … filter` と `count … filter` から `RatioOfSums` を作る。使えた投稿が 0 件か分母の合計が 0 なら値は null */
export function ratioOfSumsFrom(numerator: number | null, denominator: number | null, used: number, total: number): RatioOfSums {
  return { value: used === 0 ? null : ratio(numerator, denominator), used, total };
}

/** SQL の `sum` と `count` から `PostSum` を作る。値のある投稿が 0 件なら合計は null */
export function postSumFrom(sum: number | null, used: number, total: number): PostSum {
  return { sum: used === 0 ? null : sum, used, total };
}

/* ------------------------------------------------------------------
 * 8 節: ファネル
 * ------------------------------------------------------------------ */

export interface FunnelStageInput {
  label: string;
  /** その段の合計（値のそろう投稿だけ） */
  sum: PostSum;
}

export interface FunnelStage {
  label: string;
  value: number | null;
  /** 計算に使った件数と全件数（「n 件中 m 件」） */
  used: number;
  total: number;
  /** 前段比（この段 ÷ 前段）。1 段目、前段が 0 か null、この段が null なら null */
  stepRate: number | null;
  /** 1 段目に対する割合（横棒の長さ）。1 段目は 1。1 段目が 0 か null なら null（棒を描かない） */
  shareOfFirst: number | null;
}

/** ファネルの段ごとの率。前段が 0 なら「—」になるように null（0% と書かない） */
export function funnelStages(stages: readonly FunnelStageInput[]): FunnelStage[] {
  const first = stages[0]?.sum.sum ?? null;
  return stages.map((s, i) => {
    const prev = i === 0 ? null : (stages[i - 1]?.sum.sum ?? null);
    return {
      label: s.label,
      value: s.sum.sum,
      used: s.sum.used,
      total: s.sum.total,
      stepRate: i === 0 ? null : ratio(s.sum.sum, prev),
      shareOfFirst: i === 0 ? (first === null || first <= 0 ? null : 1) : ratio(s.sum.sum, first),
    };
  });
}

/* ------------------------------------------------------------------
 * 経過日数
 * ------------------------------------------------------------------ */

const DAY_SECONDS = 24 * 60 * 60;

/** 秒 → 日（切り捨て。負は 0）。null や有限でない値は null（画面は「—」） */
export function elapsedDays(seconds: number | null | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return Math.floor(Math.max(0, seconds) / DAY_SECONDS);
}

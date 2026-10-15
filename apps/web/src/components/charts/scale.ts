/**
 * グラフの目盛と形の計算（見本 `doc/design-lab/v3/render.js` の `niceMax`、`ticks`、`barV` を移したもの）。
 * どの入力でも `NaN` や `Infinity` を SVG に出さないように、座標は `coord` を通して文字列にする。
 */

/** 有限の数だけを残す */
export function finiteValues(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/** 目盛の上端（1、2、2.5、5、10 × 10 のべき）。0 以下や有限でない値は 1 */
export function niceMax(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * p;
}

/** 0〜max を count 等分した目盛 */
export function ticks(min: number, max: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + ((max - min) * i) / count);
  return out;
}

/** Y 軸の範囲。値がない、全部同じ値（幅 0）でも上端 > 下端にする */
export function yDomain(values: readonly number[], opts: { min?: number; max?: number; headroom?: number } = {}): {
  min: number;
  max: number;
} {
  const min = opts.min ?? 0;
  const top = values.length ? Math.max(...values) : min;
  let max = opts.max ?? niceMax((top - min) * (opts.headroom ?? 1.08)) + min;
  if (!(max > min)) max = min + 1;
  return { min, max };
}

/**
 * 0 を起点にしない Y 軸の範囲（水準の折れ線。フォロワー数など。2026-10-13 のユーザーの指示）。
 * 刻みは範囲の 1/3 を切りのよい値に丸め（`niceMax`）、最小値の下と最大値の上に刻み 1 つ分の余裕を取って刻みの倍数にそろえる。
 * 値が全部 0 以上なら下限は 0 を下回らない。値がない、全部同じ値でも上端 > 下端。目盛は `step` の倍数に置く
 */
export function niceDomain(values: readonly number[]): { min: number; max: number; step: number } {
  if (values.length === 0) return { min: 0, max: 1, step: 0.25 };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const range = hi - lo;
  const step = range > 0 ? niceMax(range / 3) : niceMax(Math.max(1, Math.abs(lo) * 0.01));
  const eps = step * 1e-9;
  let min = Math.floor(lo / step) * step;
  if (min >= lo - eps) min -= step;
  let max = Math.ceil(hi / step) * step;
  if (max <= hi + eps) max += step;
  if (lo >= 0 && min < 0) min = 0;
  if (!(max > min)) max = min + step;
  return { min, max, step };
}

/** 座標を小数 1 桁の文字列に。有限でなければ 0 */
export function coord(v: number): string {
  return Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : "0";
}

/** 縦棒（上端だけ角丸）のパス */
export function barVPath(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, h, w / 2));
  return `M${coord(x)} ${coord(y + h)}v-${coord(h - r)}a${coord(r)} ${coord(r)} 0 0 1 ${coord(r)} -${coord(r)}h${coord(w - 2 * r)}a${coord(r)} ${coord(r)} 0 0 1 ${coord(r)} ${coord(r)}v${coord(h - r)}z`;
}

/** X 軸のラベルの間引きの間隔（ラベル 1 つに `minGap` px を取る） */
export function labelStep(count: number, innerWidth: number, minGap: number): number {
  if (count <= 0) return 1;
  return Math.max(1, Math.ceil(count / Math.max(2, Math.floor(innerWidth / minGap))));
}

/** 折れ線の点の半径（px）。縁（`.chart-dot` の 1.5px）込みで直径 9.5px */
export const DOT_RADIUS = 4;

/**
 * 点を描くのに要る X の間隔（px）。点の直径 9.5px に、点と点の間に線が見える分（約 4 割）を足した値。これより狭いと
 * 点の縁が線を隠して数珠に見えるので、点を描かずヒントの透明な点だけ置く。
 * 760px（概要の PC）: 9 日 79px、32 日 22px は描く。92 日 7.7px は描かない。340px（スマートフォン）: 9 日 32px は描く。32 日 9px は描かない
 */
export const DOT_MIN_SLOT = 16;

/** 点を描けるか（X の間隔が `DOT_MIN_SLOT` 以上） */
export function dotsFit(slot: number): boolean {
  return Number.isFinite(slot) && slot >= DOT_MIN_SLOT;
}

/** null で区切った連続区間（折れ線は欠けた日をまたいで線を結ばない） */
export function segments<T>(items: readonly (T | null)[]): { start: number; items: T[] }[] {
  const out: { start: number; items: T[] }[] = [];
  let cur: { start: number; items: T[] } | null = null;
  items.forEach((it, i) => {
    if (it === null) {
      cur = null;
      return;
    }
    if (cur === null) {
      cur = { start: i, items: [] };
      out.push(cur);
    }
    cur.items.push(it);
  });
  return out;
}

/**
 * つながった点の並びを、薄く描く部分と通常の部分に分ける（件数が少ない区分を薄く描くため）。
 * 2 点の間は、どちらかの点が薄く描く index なら薄くする。分けた並びは境目の点を共有する。
 * 1 点だけの並びはその点の状態になる
 */
export function dimRuns<T extends { i: number }>(
  items: readonly T[],
  dim: ReadonlySet<number>,
): { dim: boolean; items: T[] }[] {
  const first = items[0];
  if (first === undefined) return [];
  if (items.length === 1) return [{ dim: dim.has(first.i), items: [first] }];
  const out: { dim: boolean; items: T[] }[] = [];
  for (let k = 1; k < items.length; k++) {
    const a = items[k - 1] as T;
    const b = items[k] as T;
    const d = dim.has(a.i) || dim.has(b.i);
    const last = out[out.length - 1];
    if (last && last.dim === d) last.items.push(b);
    else out.push({ dim: d, items: [a, b] });
  }
  return out;
}

/**
 * `--heat` を面の色に混ぜた色（見本の `color-mix(in oklab, var(--heat) p%, var(--color-surface))`）。
 * p は 0〜100 に丸める（有限でなければ 0）。ヒートマップと、ストーリーズの操作の内訳の色に使う
 */
export function heatColor(percent: number): string {
  const p = Number.isFinite(percent) ? Math.round(Math.min(100, Math.max(0, percent))) : 0;
  return `color-mix(in oklab, var(--heat) ${p}%, var(--color-surface))`;
}

/** 投稿の印（▲）のヒントを出す透明な四角の一辺（px）。▲ は幅 6px と小さく、カーソルを合わせにくい */
export const MARKER_HIT = 18;

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

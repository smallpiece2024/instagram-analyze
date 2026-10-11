/**
 * 「AI・OCR の利用状況」（`/jobs`。R4.1 設計 6.4 節）の定数と計算。`server-only` なし（純粋関数）。
 *
 * - 無料枠と単価は Google Cloud Vision の料金（確認日 2026-10-11、出典 cloud.google.com/vision/pricing）。
 *   DOCUMENT_TEXT_DETECTION は月 1,000 ユニットまで無料、それ以降 1,000 ユニットあたり $1.50（〜500 万ユニット）
 * - 画面の 1,000 はワーカーの月の上限（`WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT`）とは別の値で、片方を変えても同期しない
 * - 月の境目は UTC（ワーカーの月の上限と同じ。ビュー `ocr_monthly_usage` の `month_utc`）
 */

/** 月の無料枠（ユニット）。確認日 2026-10-11、出典 cloud.google.com/vision/pricing */
export const VISION_FREE_UNITS_PER_MONTH = 1000;
/** 無料枠を超えた分の単価（1,000 ユニットあたり USD）。確認日 2026-10-11、出典 cloud.google.com/vision/pricing */
export const VISION_USD_PER_1000_UNITS = 1.5;
/** 月ごとの表に出す月数 */
export const USAGE_MONTHS = 12;
/** 残りがこれより少なければ注意を出す（ユニット） */
export const FREE_UNITS_WARN_BELOW = 100;

/** ビュー `ocr_monthly_usage` の 1 行（`month` は `YYYY-MM`。UTC） */
export interface OcrMonthRow {
  month: string;
  requests: number;
  failed_requests: number;
  images: number;
  units: number;
  videos: number;
}

/** 今月の無料枠の残り（ユニット）。0 を下回らない */
export function remainingFreeUnits(units: number): number {
  return Math.max(0, VISION_FREE_UNITS_PER_MONTH - Math.max(0, units));
}

/** 推定費用（USD） = max(units − 1,000, 0) ÷ 1,000 × $1.50 */
export function estimatedCostUsd(units: number): number {
  return (Math.max(0, units - VISION_FREE_UNITS_PER_MONTH) / 1000) * VISION_USD_PER_1000_UNITS;
}

/** `$0.00` の形 */
export function formatUsd(v: number): string {
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

/** UTC の `YYYY-MM` */
export function monthKeyUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `now` を含む月から `count` か月さかのぼった月の `YYYY-MM`（新しい順） */
export function recentMonthKeys(now: Date, count = USAGE_MONTHS): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(monthKeyUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}

function emptyMonth(month: string): OcrMonthRow {
  return { month, requests: 0, failed_requests: 0, images: 0, units: 0, videos: 0 };
}

/** 直近 `count` か月の行（新しい順）。利用が 0 の月は 0 の行で補う。範囲外の行は捨てる */
export function fillMonths(rows: readonly OcrMonthRow[], now: Date, count = USAGE_MONTHS): OcrMonthRow[] {
  const byMonth = new Map(rows.map((r) => [r.month, r] as const));
  return recentMonthKeys(now, count).map((m) => {
    const r = byMonth.get(m);
    return r === undefined ? emptyMonth(m) : { ...r };
  });
}

/** 今月（UTC）の行。なければ 0 の行 */
export function currentMonthUsage(rows: readonly OcrMonthRow[], now: Date): OcrMonthRow {
  const key = monthKeyUtc(now);
  const r = rows.find((x) => x.month === key);
  return r === undefined ? emptyMonth(key) : { ...r };
}

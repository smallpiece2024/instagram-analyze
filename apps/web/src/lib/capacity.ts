/**
 * 「上限」（`/jobs`。課題 ia-6ui）の定数と計算。`server-only` なし（純粋関数）。
 *
 * - DB と Storage の上限は Supabase の Pro プランに含まれる量（確認日 2026-11-21、出典 supabase.com/pricing）
 * - DB の値は `pg_database_size`。ディスクの使用量（WAL などを含む）より小さい近似値
 * - `capacity_daily.captured_on` は UTC の日付。日ごとの表（収集の所要とレート制限）の日の区切りは JST
 *   （`/jobs` のほかの時刻の表示 `formatJst` と同じ）
 */
import { usagePercent, type RateUsage } from "@/lib/format";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * DB の上限（バイト）。Pro プランに含まれる量。ワーカーの警告の既定（`WORKER_DB_SIZE_LIMIT_MB`、
 * `WORKER_STORAGE_SIZE_LIMIT_MB`）と同じ値。8 割で警告
 */
export const DB_LIMIT_BYTES = 8 * GB;
/** Storage の上限（バイト）。Pro プランに含まれる量。ワーカーの警告の既定と同じ値。8 割で警告 */
export const STORAGE_LIMIT_BYTES = 100 * GB;
/** 使用率がこれ以上なら警告 */
export const WARN_RATIO = 0.8;
/** 収集 1 回の所要がこれを超えた日があれば警告（秒。GitHub Actions のジョブの制限時間は 30 分） */
export const RUN_DURATION_WARN_SECONDS = 900;
/** 増分を比べる相手までの日数 */
export const GROWTH_DAYS = 30;
/** 日ごとの表に出す日数 */
export const DAILY_DAYS = 14;

/** 表 `capacity_daily` の 1 行（`captured_on` は UTC の `YYYY-MM-DD`） */
export interface CapacityDailyRow {
  captured_on: string;
  db_bytes: number;
  storage_bytes: number;
  storage_objects: number;
}

/** ビュー `collect_run_durations` の 1 行（収集 1 回） */
export interface RunDurationRow {
  began_at: Date;
  duration_seconds: number;
}

/** `job_runs` の `rate_usage` のある 1 行 */
export interface RateUsageRow {
  started_at: Date;
  rate_usage: RateUsage;
}

/** 使用率（0〜）。上限が正でない、値が有限でないときは 0 */
export function usageRatio(bytes: number, limitBytes: number): number {
  if (!Number.isFinite(bytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return 0;
  return Math.max(0, bytes) / limitBytes;
}

/** 使用率が 8 割以上か */
export function isOverWarnRatio(bytes: number, limitBytes: number): boolean {
  return usageRatio(bytes, limitBytes) >= WARN_RATIO;
}

/** バイトの表示。1 GB 未満は `52.0 MB`、以上は `1.25 GB`（1 GB = 1,024 MB） */
export function formatBytes(bytes: number): string {
  const v = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  return v < GB ? `${(v / MB).toFixed(1)} MB` : `${(v / GB).toFixed(2)} GB`;
}

/** バイトの差の表示。`+3.2 MB`、`-1.0 MB`、`±0.0 MB` */
export function formatSignedBytes(diff: number): string {
  const v = Number.isFinite(diff) ? diff : 0;
  const body = formatBytes(Math.abs(v));
  if (body === "0.0 MB") return "±0.0 MB";
  return `${v > 0 ? "+" : "-"}${body}`;
}

function ymdToUtcMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`);
}

export interface CapacityGrowth {
  /** 最新の行 */
  latest: CapacityDailyRow;
  /** 比べる相手。行が 1 つだけなら null */
  base: CapacityDailyRow | null;
  /** 最新の行と相手の間の日数。相手がなければ null */
  days: number | null;
  dbDiff: number | null;
  storageDiff: number | null;
}

/**
 * 最新の行と、その `days` 日前以前でいちばん新しい行（なければいちばん古い行）との差。
 * 行がなければ null。行が 1 つだけなら相手は null
 */
export function capacityGrowth(rows: readonly CapacityDailyRow[], days = GROWTH_DAYS): CapacityGrowth | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => (a.captured_on < b.captured_on ? 1 : a.captured_on > b.captured_on ? -1 : 0));
  const latest = sorted[0];
  const others = sorted.slice(1);
  if (others.length === 0) return { latest, base: null, days: null, dbDiff: null, storageDiff: null };
  const latestMs = ymdToUtcMs(latest.captured_on);
  const base =
    others.find((r) => latestMs - ymdToUtcMs(r.captured_on) >= days * DAY_MS) ?? others[others.length - 1];
  return {
    latest,
    base,
    days: Math.round((latestMs - ymdToUtcMs(base.captured_on)) / DAY_MS),
    dbDiff: latest.db_bytes - base.db_bytes,
    storageDiff: latest.storage_bytes - base.storage_bytes,
  };
}

/** 中央値。偶数個なら中の 2 つの平均。空なら null */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** JST の `YYYY-MM-DD` */
export function jstDateKey(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `now` を含む日から `count` 日さかのぼった JST の日付（新しい順） */
export function recentJstDateKeys(now: Date, count = DAILY_DAYS): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(jstDateKey(new Date(now.getTime() - i * DAY_MS)));
  return out;
}

/** 日ごとの表の 1 行（`date` は JST の `YYYY-MM-DD`） */
export interface DailyLimitRow {
  date: string;
  /** 収集の回数 */
  runs: number;
  /** 所要の最大（秒）。収集がなければ null */
  maxSeconds: number | null;
  /** 所要の中央値（秒）。収集がなければ null */
  medianSeconds: number | null;
  /** レート制限の使用率の最大（百分率）。値がなければ null */
  maxUsage: number | null;
}

/** 直近 `count` 日（JST。新しい順）の日ごとの集計。収集のない日も行を出す。範囲外の行は捨てる */
export function dailyLimits(
  runs: readonly RunDurationRow[],
  rates: readonly RateUsageRow[],
  now: Date,
  count = DAILY_DAYS,
): DailyLimitRow[] {
  const durations = new Map<string, number[]>();
  for (const r of runs) {
    if (!Number.isFinite(r.duration_seconds)) continue;
    const key = jstDateKey(r.began_at);
    const list = durations.get(key);
    if (list === undefined) durations.set(key, [r.duration_seconds]);
    else list.push(r.duration_seconds);
  }
  const usage = new Map<string, number>();
  for (const r of rates) {
    const p = usagePercent(r.rate_usage);
    if (p === undefined) continue;
    const key = jstDateKey(r.started_at);
    const cur = usage.get(key);
    if (cur === undefined || p > cur) usage.set(key, p);
  }
  return recentJstDateKeys(now, count).map((date) => {
    const list = durations.get(date) ?? [];
    return {
      date,
      runs: list.length,
      maxSeconds: list.length === 0 ? null : Math.max(...list),
      medianSeconds: median(list),
      maxUsage: usage.get(date) ?? null,
    };
  });
}

/** 所要の最大が `RUN_DURATION_WARN_SECONDS` を超えた日（新しい順のまま） */
export function slowDays(rows: readonly DailyLimitRow[]): DailyLimitRow[] {
  return rows.filter((r) => r.maxSeconds !== null && r.maxSeconds > RUN_DURATION_WARN_SECONDS);
}

/**
 * 画面の表示に使う純粋関数（設計 1.3 章、1.6〜1.8 章、4.1 章）。`server-only` なし。
 * DB の行の型のうち画面が使う部分もここに置く（ワーカーの `db/types.ts` と同じ列名）。
 */

/** `job_runs.job_name`。並びは実行順（設計 1.1 章） */
export const JOB_ORDER = [
  "token_check",
  "profile_daily",
  "account_daily",
  "media_sync",
  "media_snapshot",
  "video_analysis",
  "stories",
  "account_backfill",
] as const;
export type JobName = (typeof JOB_ORDER)[number];

/** `job_runs.status` */
export type JobStatus = "running" | "success" | "partial" | "failed" | "skipped";
/** `private.credentials.status` */
export type CredentialStatus = "valid" | "expired" | "insufficient_scope" | "error";
/** `accounts.status` */
export type AccountStatus = "active" | "paused" | "disconnected";

/** `job_runs.rate_usage`（ワーカーの `RateUsage` と同じ形。各値は百分率） */
export interface RateUsage {
  call_count: number;
  total_cputime: number;
  total_time: number;
  /** アクセスが回復するまでの見込み（分）。ヘッダにあるときだけ */
  estimated_time_to_regain_access?: number;
}

/** 指標の値。null は欠損 */
export type MediaMetricValue = number | null;
/** `media_insight_snapshots.metrics`。キーがない: その種類では取れない、null: 欠損、数値: 値。内訳は入れ子 */
export type MediaMetrics = Record<string, MediaMetricValue | Record<string, MediaMetricValue>>;

/** 収集に必要な権限（`pages_show_list` は接続時の `me/accounts` にだけ要る） */
export const REQUIRED_SCOPES: readonly string[] = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_read_engagement",
];

/** データアクセス期限の残りがこの日数以下なら再接続を促す（ワーカーの `token_check` と同じ） */
export const DATA_ACCESS_WARN_DAYS = 14;

/** 投稿一覧とリールの一覧の 1 ページの件数（2026-10-06 にユーザーが 50 件から 10 件に変えた） */
export const PAGE_SIZE = 10;

/** 値がないときの表示 */
export const EMPTY = "—";

const DAY_MS = 24 * 60 * 60 * 1000;

const JST_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const NUMBER_FORMATTER = new Intl.NumberFormat("ja-JP");

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/** JST の `YYYY-MM-DD HH:mm`。null や不正な日時は `—` */
export function formatJst(d: Date | null | undefined): string {
  if (!isValidDate(d)) return EMPTY;
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of JST_FORMATTER.formatToParts(d)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const pad = (v: string | undefined, n: number) => (v ?? "").padStart(n, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)} ${pad(parts.hour, 2)}:${pad(parts.minute, 2)}`;
}

/** 整数の表示（3 桁区切り）。null は `—` */
export function formatCount(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return EMPTY;
  const value = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(value) ? NUMBER_FORMATTER.format(value) : EMPTY;
}

/** 期限までの残り日数（切り捨て。過ぎていれば負）。期限が分からなければ undefined */
export function daysLeft(until: Date | null | undefined, now: Date): number | undefined {
  if (!isValidDate(until)) return undefined;
  return Math.floor((until.getTime() - now.getTime()) / DAY_MS);
}

/** 再接続が必要か（設計 1.6 章）。認証情報がない、`valid` でない、残り 14 日以下なら true */
export function needsReconnect(input: {
  credential_status: string | null | undefined;
  data_access_expires_at: Date | null | undefined;
  now: Date;
}): boolean {
  if (input.credential_status !== "valid") return true;
  const left = daysLeft(input.data_access_expires_at, input.now);
  return left !== undefined && left <= DATA_ACCESS_WARN_DAYS;
}

/** 必要な権限のうち足りないもの */
export function missingScopes(scopes: readonly string[] | null | undefined): string[] {
  const have = new Set(scopes ?? []);
  return REQUIRED_SCOPES.filter((s) => !have.has(s));
}

/**
 * 指標の 1 セルの表示（設計 1.8 章）。
 * `metrics` が null（スナップショットなし）→「未取得」、キーなし →「—」、null →「欠損」、数値 → 値、内訳のオブジェクト →「—」
 */
export function metricCell(metrics: unknown, key: string): string {
  if (metrics === null || metrics === undefined || typeof metrics !== "object" || Array.isArray(metrics)) {
    return "未取得";
  }
  if (!Object.hasOwn(metrics, key)) return EMPTY;
  const value = (metrics as Record<string, unknown>)[key];
  if (value === null) return "欠損";
  if (typeof value === "number" && Number.isFinite(value)) return NUMBER_FORMATTER.format(value);
  return EMPTY;
}

/** レート制限の使用率（3 つの百分率の最大。ワーカーの `RateMonitor.percent` と同じ）。null は undefined */
export function usagePercent(u: RateUsage | null | undefined): number | undefined {
  if (!u || typeof u !== "object") return undefined;
  const values = [u.call_count, u.total_cputime, u.total_time].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  return values.length === 0 ? undefined : Math.max(...values);
}

/** 所要時間の表示。`N 秒`、`M 分 S 秒`、`H 時間 M 分`。負は `0 秒` */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
  return `${Math.floor(total / 3600)} 時間 ${Math.floor((total % 3600) / 60)} 分`;
}

/** 投稿からの経過の表示（設計 1.1 章）。`投稿後 N 分／時間／日`。null は `—` */
export function elapsedLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return EMPTY;
  const s = Math.max(0, seconds);
  if (s < 3600) return `投稿後 ${Math.floor(s / 60)} 分`;
  if (s < DAY_MS / 1000) return `投稿後 ${Math.floor(s / 3600)} 時間`;
  return `投稿後 ${Math.floor(s / (DAY_MS / 1000))} 日`;
}

/** `permalink` をリンクにしてよいか（`https://www.instagram.com/` 始まりだけ） */
export function isInstagramPermalink(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://www.instagram.com/");
}

export function jobStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "実行中";
    case "success":
      return "成功";
    case "partial":
      return "一部失敗";
    case "failed":
      return "失敗";
    case "skipped":
      return "見送り";
    default:
      return status;
  }
}

export function credentialStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "valid":
      return "有効";
    case "expired":
      return "期限切れ";
    case "insufficient_scope":
      return "権限不足";
    case "error":
      return "エラー";
    case null:
    case undefined:
      return "未接続";
    default:
      return status;
  }
}

export function accountStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "active":
      return "収集中";
    case "paused":
      return "停止";
    case "disconnected":
      return "接続解除";
    default:
      return status ?? EMPTY;
  }
}

export function tokenTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case "PAGE":
      return "ページトークン";
    case "USER":
      return "ユーザートークン";
    default:
      return EMPTY;
  }
}

/** 収集ログの 1 行の表示（設計 1.7 章） */
export interface JobRowView {
  statusLabel: string;
  durationLabel: string;
  /** `partial`、`failed`、`skipped` のときだけ。理由の記録がなければ固定文言 */
  errorText: string | null;
  /** 長い文は `<details>` で折りたたむ */
  errorIsLong: boolean;
  usageLabel: string;
}

/** `errorIsLong` の境目（文字数） */
export const ERROR_FOLD_LENGTH = 60;

export function jobRowView(
  row: {
    status: string;
    started_at: Date;
    finished_at: Date | null;
    error: string | null;
    rate_usage: RateUsage | null;
  },
  now: Date,
): JobRowView {
  let statusLabel: string;
  let durationLabel: string;
  let errorText: string | null;
  if (row.status === "running") {
    const minutes = Math.max(0, Math.floor((now.getTime() - row.started_at.getTime()) / 60_000));
    statusLabel = `実行中（開始から ${minutes} 分）`;
    durationLabel = EMPTY;
    errorText = null;
  } else {
    statusLabel = jobStatusLabel(row.status);
    durationLabel = isValidDate(row.finished_at)
      ? formatDuration(row.finished_at.getTime() - row.started_at.getTime())
      : EMPTY;
    errorText = row.status === "success" ? null : (row.error ?? "（理由の記録なし）");
  }
  const percent = usagePercent(row.rate_usage);
  let usageLabel = percent === undefined ? EMPTY : `使用率 ${percent}%`;
  const regain = row.rate_usage?.estimated_time_to_regain_access;
  if (typeof regain === "number" && Number.isFinite(regain)) usageLabel += `（回復見込み ${regain} 分）`;
  return {
    statusLabel,
    durationLabel,
    errorText,
    errorIsLong: errorText !== null && errorText.length > ERROR_FOLD_LENGTH,
    usageLabel,
  };
}

/* ------------------------------------------------------------------
 * R3 の分析画面の書式（R3 設計 3.1 節、6 章、7.2 節）
 * ------------------------------------------------------------------ */

/** 値の書式の種類。グラフや表の部品に関数ではなく種類を渡す（Server Component の props を単純に保つ） */
export type ValueFormat = "count" | "percent" | "seconds" | "decimal";

/** 率（0〜1）を % で。null や有限でない値は `—`。桁は既定 1 */
export function formatPercent(v: number | null | undefined, digits = 1): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return EMPTY;
  return `${(v * 100).toFixed(digits)}%`;
}

/** 秒（小数 1 桁）。`12.3 秒`。null は `—` */
export function formatSeconds(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return EMPTY;
  return `${Math.round(v * 10) / 10} 秒`;
}

/** 小数（倍率など）。既定 2 桁。null は `—` */
export function formatDecimal(v: number | null | undefined, digits = 2): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return EMPTY;
  return v.toFixed(digits);
}

/** 種類に応じた書式 */
export function formatValue(v: number | null | undefined, format: ValueFormat): string {
  switch (format) {
    case "count":
      return typeof v === "number" ? formatCount(Math.round(v)) : EMPTY;
    case "percent":
      return formatPercent(v);
    case "seconds":
      return formatSeconds(v);
    case "decimal":
      return formatDecimal(v);
  }
}

/** グラフの目盛の書式。率は % の整数、1 万以上は「万」、ほかは 3 桁区切り */
export function formatAxis(v: number, format: ValueFormat): string {
  if (!Number.isFinite(v)) return "";
  if (format === "percent") return formatPercent(v, Math.abs(v) < 0.1 && v !== 0 ? 1 : 0);
  if (format === "seconds") return `${Math.round(v * 10) / 10}`;
  if (format === "decimal") return formatDecimal(v, 1);
  if (Math.abs(v) >= 10000) return `${Math.round((v / 10000) * 10) / 10}万`;
  return formatCount(Math.round(v));
}

/** 増減率（件数の前期間比）の表示。`+12.3%`、`-4.0%`、`±0.0%` */
export function formatSignedPercent(rate: number): string {
  if (!Number.isFinite(rate)) return EMPTY;
  const v = rate * 100;
  if (Math.abs(v) < 0.05) return "±0.0%";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** ポイント差（率の前期間比）の表示。差は 0〜1 の単位で受け取る。`+1.0 pt` */
export function formatSignedPt(diff: number): string {
  if (!Number.isFinite(diff)) return EMPTY;
  const v = diff * 100;
  if (Math.abs(v) < 0.05) return "±0.0 pt";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} pt`;
}

/** 人数などの差。`+12`、`-3`、`±0` */
export function formatSignedCount(diff: number): string {
  if (!Number.isFinite(diff)) return EMPTY;
  const r = Math.round(diff);
  if (r === 0) return "±0";
  return `${r > 0 ? "+" : "-"}${NUMBER_FORMATTER.format(Math.abs(r))}`;
}

/** `YYYY-MM-DD` を `M/D` に（グラフの X 軸）。形が違えばそのまま */
export function formatDateShort(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${Number(m[2])}/${Number(m[3])}` : ymd;
}

const JST_SECONDS_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function jstParts(d: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of JST_SECONDS_FORMATTER.formatToParts(d)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const pad = (v: string | undefined, n: number) => (v ?? "").padStart(n, "0");
  return {
    year: pad(parts.year, 4),
    month: pad(parts.month, 2),
    day: pad(parts.day, 2),
    hour: pad(parts.hour, 2),
    minute: pad(parts.minute, 2),
    second: pad(parts.second, 2),
  };
}

/** JST の `YYYY-MM-DD HH:mm:ss`（CSV の `_jst` の列）。null や不正な日時は空文字 */
export function formatJstSeconds(d: Date | null | undefined): string {
  if (!isValidDate(d)) return "";
  const p = jstParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** JST の `YYYYMMDD`（CSV のファイル名） */
export function formatJstCompactDate(d: Date): string {
  const p = jstParts(d);
  return `${p.year}${p.month}${p.day}`;
}

/** 最終更新の表示（F-UI-26）。`最終更新 2026-10-05 08:30`。値がなければ `最終更新 —` */
export function lastUpdatedLabel(d: Date | null | undefined): string {
  return `最終更新 ${formatJst(d)}`;
}

/** 投稿からの経過日数（時間で受け取り、日に切り捨て。負は 0）。`12 日`。null は `—`（投稿一覧） */
export function formatElapsedDays(hours: number | null | undefined): string {
  if (typeof hours !== "number" || !Number.isFinite(hours)) return EMPTY;
  return `${Math.floor(Math.max(0, hours) / 24)} 日`;
}

/** 投稿からの経過日数。`投稿から 12 日`。数え方は `formatElapsedDays` と同じ。null は `—`（投稿詳細） */
export function elapsedDaysLabel(hours: number | null | undefined): string {
  const days = formatElapsedDays(hours);
  return days === EMPTY ? EMPTY : `投稿から ${days}`;
}

/** 投稿の題名の最大の文字数（R3 設計 3.3 節） */
export const TITLE_MAX_CHARS = 40;

/**
 * 投稿の題名（投稿一覧と投稿詳細）。キャプションの、空白と句読点だけではない最初の行の先頭 40 文字（絵文字だけの行は題名にする）。
 * 「.」だけの行（キャプションの頭で行を空けて見せる書き方）や空行は飛ばす。
 * `Array.from` で文字（コードポイント）単位に切り、サロゲートペアを割らない。
 * キャプションがない、またはそういう行がなければ「（キャプションなし）」
 */
export function mediaTitle(caption: string | null | undefined): string {
  const lines = typeof caption === "string" ? caption.split(/\r\n|\r|\n/) : [];
  const first = lines.map((l) => l.trim()).find((l) => /[^\s\p{P}]/u.test(l)) ?? "";
  if (first === "") return "（キャプションなし）";
  return Array.from(first).slice(0, TITLE_MAX_CHARS).join("");
}

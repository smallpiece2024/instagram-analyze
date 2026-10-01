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

/** 投稿一覧の 1 ページの件数 */
export const PAGE_SIZE = 50;
/** `?page=` の上限 */
export const MAX_PAGE = 100_000;

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

/** `?page=` を 1 以上の整数にする。数字以外、0、配列は 1。数字列なら桁数にかかわらず上限 `MAX_PAGE` に丸める */
export function parsePage(value: string | string[] | undefined): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return 1;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return MAX_PAGE;
  if (n < 1) return 1;
  return Math.min(n, MAX_PAGE);
}

/** `?job=` が 7 つのジョブ名の 1 つならそれ、未知と配列は undefined（無視） */
export function parseJobFilter(value: string | string[] | undefined): JobName | undefined {
  if (typeof value !== "string") return undefined;
  return (JOB_ORDER as readonly string[]).includes(value) ? (value as JobName) : undefined;
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

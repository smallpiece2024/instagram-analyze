/**
 * `check-alerts` の判定（R2 設計 5.2 章、R6 設計 4 章）。純粋関数で I/O なし。DB の読み出しは `commands/check-alerts.ts` が行う。
 *
 * ジョブの `status` を歪めずに「人が見るべき状態」を終了コードで知らせるためのもの。
 *
 * | 判定 | scope | 条件 |
 * |---|---|---|
 * | `simulated` | 両方 | `simulate` が true（`WORKER_SIMULATE_ALERT=true`） |
 * | `token` | daily のみ | `active` のアカウントで、credential がない、`status <> 'valid'`、または残り日数が 14 日未満（`token_check` と同じ計算。14 日ちょうどは警告しない） |
 * | `stories_failed` | 両方（daily の回も hourly を含む） | `stories` の直近 2 回（`running` を除く）がどちらも `failed`（`partial`／`skipped` は数えない） |
 * | `stories_skipped` | 両方 | `stories` の直近 3 回がすべて `skipped` |
 * | `ocr_monthly_cap` | daily のみ | 今月（UTC）の Vision のユニットか本数が上限以上（`>=`。R4.1 設計 3.3 節） |
 * | `non_follower_reach_drop` | daily のみ | 非フォロワーリーチ比率が「直近 7 日」で「その前 28 日」より 10 pt 以上低い（R6 設計 4.1 節。Q9）。整数の交差乗算で判定 |
 * | `follower_drop` | daily のみ | `profile_daily` のフォロワー数が前日比で 10 人以上かつ 1% 以上減った（Q11） |
 * | 履歴なし | 両方 | `stories` の記録が 2 回に満たない、比率の使えた日数が足りない、フォロワーの前日の記録がない → 判定しない（`noHistory`、`noHistoryKinds`） |
 * | 投稿なし | daily | 直近 7 日に投稿（ストーリーズを除く）がなければ比率の低下は判定しない（`noPosts`） |
 *
 * アカウントは `ordinal/total` の連番で表し、ID やユーザー名は持ち込まない。`Alert` に率、pt、フォロワーの人数（絶対数）を
 * 持たせない（公開リポジトリの GitHub Actions のログに出るため。R6 設計 S1）
 */
import { DATA_ACCESS_WARN_DAYS, daysLeft } from "./token-check.js";

export type AlertScope = "hourly" | "daily";

export interface AlertCredential {
  /** `private.credentials.status` */
  status: string;
  dataAccessExpiresAt: Date | null;
}

/** 合計は整数（日次指標の値の和）。率は持たない（S1） */
export interface RatioWindow {
  /** Σ非フォロワーリーチ */
  numerator: number;
  /** Σリーチ */
  denominator: number;
  /** 使えた日数（両方の値がある日） */
  days: number;
}

export interface FollowerRecord {
  /** YYYY-MM-DD（日本時間の日付） */
  capturedOn: string;
  count: number;
}

export interface AlertAccount {
  /** 1 始まりの連番（ログの `account=1/N`） */
  ordinal: number;
  /** `accounts.status`。`active` 以外は判定しない */
  status: string;
  credential: AlertCredential | null;
  /** `stories` の直近の実行。`started_at desc`、最大 3 件。`running` が混じっていても除く */
  recentStoriesRuns: { status: string }[];
  /** 今月（UTC）の Vision の利用（`ocr_usage` の合計）。読んでいなければ省略（判定しない） */
  ocrMonthly?: { units: number; videos: number };
  /** 非フォロワーリーチ比率の直近 7 日と基準 28 日、直近 7 日の投稿数。daily だけ読む。読んでいなければ判定しない */
  nonFollowerReach?: { recent: RatioWindow; base: RatioWindow; recentPosts: number };
  /** フォロワー数の記録の新しい順 2 件（null の記録は除いた後）。1 件なら previous は null。隣接（前日）の検査は純関数で行う */
  followers?: { latest: FollowerRecord; previous: FollowerRecord | null };
}

export interface AlertInput {
  accounts: AlertAccount[];
  /** `ocr_monthly_cap` の上限（`WorkerConfig` の 2 つ）。省略時は判定しない */
  ocrLimits?: { unitLimit: number; maxVideos: number };
}

/** 率や pt、人数を持たない（公開ログに出るため。S1） */
export type Alert =
  | { kind: "simulated" }
  | { kind: "token"; ordinal: number; total: number; daysLeft: number | undefined; status: string }
  | { kind: "stories_failed"; ordinal: number; total: number; runs: number }
  | { kind: "stories_skipped"; ordinal: number; total: number; runs: number }
  | { kind: "ocr_monthly_cap"; ordinal: number; total: number; units: number; videos: number }
  | { kind: "non_follower_reach_drop"; ordinal: number; total: number; recentDays: number; baseDays: number }
  | { kind: "follower_drop"; ordinal: number; total: number };

/** 履歴が足りず見送った判定の種類（固定の語。ログの `no_history=<kinds>`） */
export type NoHistoryKind = "stories" | "non_follower_reach_drop" | "follower_drop";

export interface AlertEvaluation {
  alerts: Alert[];
  /** 履歴が足りず判定を見送った判定があった（`stories` に加えて 2 種類も立てる。`reason=no_history`） */
  noHistory: boolean;
  /** 見送った判定の種類（固定の語。ログの `no_history=<kinds>`。判定の順に並べ、重複はない） */
  noHistoryKinds: NoHistoryKind[];
  /** 直近 7 日に投稿がなく `non_follower_reach_drop` を見送った（ログの `no_posts=non_follower_reach_drop`） */
  noPosts: boolean;
}

/** `stories_failed` に必要な連続回数 */
export const STORIES_FAILED_RUNS = 2;
/** `stories_skipped` に必要な連続回数 */
export const STORIES_SKIPPED_RUNS = 3;
/** credential がないときの `status=` の表示 */
export const NO_CREDENTIAL_STATUS = "none";

// しきい値（R6 設計 Q9〜Q11）
/** 非フォロワーリーチ比率の低下（基準 − 直近）の pt */
export const NON_FOLLOWER_REACH_DROP_PT = 10;
/** 直近の窓の日数（`latest − 6` 〜 `latest`） */
export const NON_FOLLOWER_REACH_RECENT_DAYS = 7;
/** 基準の窓の日数（`latest − 34` 〜 `latest − 7`） */
export const NON_FOLLOWER_REACH_BASE_DAYS = 28;
/** 直近の窓で使えた日数がこれ未満なら `no_history` */
export const NON_FOLLOWER_REACH_MIN_RECENT_DAYS = 5;
/** 基準の窓で使えた日数がこれ未満なら `no_history` */
export const NON_FOLLOWER_REACH_MIN_BASE_DAYS = 20;
/** フォロワーの前日比の減りの人数（以上） */
export const FOLLOWER_DROP_MIN_COUNT = 10;
/** フォロワーの前日比の減りの率（% 以上） */
export const FOLLOWER_DROP_MIN_PERCENT = 1;

/** `noHistoryKinds` の並び（判定の順） */
const NO_HISTORY_KIND_ORDER: readonly NoHistoryKind[] = ["non_follower_reach_drop", "follower_drop", "stories"];

function evaluateToken(account: AlertAccount, total: number, now: Date): Alert | undefined {
  const { ordinal, credential } = account;
  if (credential === null) {
    return { kind: "token", ordinal, total, daysLeft: undefined, status: NO_CREDENTIAL_STATUS };
  }
  const left = daysLeft(credential.dataAccessExpiresAt, now);
  if (credential.status !== "valid") {
    return { kind: "token", ordinal, total, daysLeft: left, status: credential.status };
  }
  // 期限が不明（null）はページトークンでは起きないはずなので、分からないまま黙らず警告する（フェイルクローズ。days_left=unknown）
  if (left === undefined || left < DATA_ACCESS_WARN_DAYS) {
    return { kind: "token", ordinal, total, daysLeft: left, status: credential.status };
  }
  return undefined;
}

/** 月のユニットか本数が上限以上（`>=`）なら `ocr_monthly_cap`（R4.1 設計 3.3 節。`daily` だけ） */
function evaluateOcrMonthlyCap(account: AlertAccount, total: number, limits: AlertInput["ocrLimits"]): Alert | undefined {
  if (!limits || !account.ocrMonthly) return undefined;
  const { units, videos } = account.ocrMonthly;
  if (units >= limits.unitLimit || videos >= limits.maxVideos) {
    return { kind: "ocr_monthly_cap", ordinal: account.ordinal, total, units, videos };
  }
  return undefined;
}

function evaluateStories(account: AlertAccount, total: number): { alert: Alert | undefined; noHistory: boolean } {
  const { ordinal } = account;
  const runs = account.recentStoriesRuns.filter((run) => run.status !== "running").slice(0, STORIES_SKIPPED_RUNS);
  if (runs.length < STORIES_FAILED_RUNS) return { alert: undefined, noHistory: true };
  if (runs.slice(0, STORIES_FAILED_RUNS).every((run) => run.status === "failed")) {
    return { alert: { kind: "stories_failed", ordinal, total, runs: STORIES_FAILED_RUNS }, noHistory: false };
  }
  if (runs.length >= STORIES_SKIPPED_RUNS && runs.every((run) => run.status === "skipped")) {
    return { alert: { kind: "stories_skipped", ordinal, total, runs: STORIES_SKIPPED_RUNS }, noHistory: false };
  }
  return { alert: undefined, noHistory: false };
}

/** 低下の 2 種類の判定の結果。`skipped` は見送った理由（なければ undefined） */
interface DropEvaluation {
  alert: Alert | undefined;
  skipped: "no_history" | "no_posts" | undefined;
}

const NOT_EVALUATED: DropEvaluation = { alert: undefined, skipped: undefined };

/**
 * 非フォロワーリーチ比率の低下（R6 設計 4.1 節）。`daily` だけ。入力が省略されていれば判定しない。
 *
 * - `no_history`: 直近の使えた日数が 5 日未満、基準の使えた日数が 20 日未満、どちらかの分母が 0（Q10）
 * - `no_posts`: 直近 7 日に投稿がない（投稿がない週の低下は推薦の兆候ではない。Q9）。履歴の検査のあとに見る
 * - 条件: 基準の比率 − 直近の比率 ≥ 10 pt。浮動小数で割ると境目が不安定なので、分子と分母を整数のまま
 *   `BigInt` で交差乗算して比べる（T4）: `(baseNum × recentDen − recentNum × baseDen) × 100 ≥ baseDen × recentDen × pt`
 */
function evaluateNonFollowerReachDrop(account: AlertAccount, total: number): DropEvaluation {
  const signal = account.nonFollowerReach;
  if (!signal) return NOT_EVALUATED;
  const { recent, base, recentPosts } = signal;
  if (
    recent.days < NON_FOLLOWER_REACH_MIN_RECENT_DAYS ||
    base.days < NON_FOLLOWER_REACH_MIN_BASE_DAYS ||
    recent.denominator === 0 ||
    base.denominator === 0
  ) {
    return { alert: undefined, skipped: "no_history" };
  }
  if (recentPosts === 0) return { alert: undefined, skipped: "no_posts" };
  const recentNum = BigInt(recent.numerator);
  const recentDen = BigInt(recent.denominator);
  const baseNum = BigInt(base.numerator);
  const baseDen = BigInt(base.denominator);
  const dropScaled = (baseNum * recentDen - recentNum * baseDen) * 100n;
  const threshold = baseDen * recentDen * BigInt(NON_FOLLOWER_REACH_DROP_PT);
  if (dropScaled >= threshold) {
    return {
      alert: { kind: "non_follower_reach_drop", ordinal: account.ordinal, total, recentDays: recent.days, baseDays: base.days },
      skipped: undefined,
    };
  }
  return NOT_EVALUATED;
}

/** `YYYY-MM-DD` を UTC の日数（エポックからの日）に直す。形が崩れていれば NaN（前日の判定が偽になり `no_history`） */
function utcDayNumber(date: string): number {
  const [y, m, d] = date.split("-").map((part) => Number(part));
  if (y === undefined || m === undefined || d === undefined) return Number.NaN;
  return Date.UTC(y, m - 1, d) / (24 * 60 * 60 * 1000);
}

/**
 * フォロワーの急減（R6 設計 4.1 節）。`daily` だけ。入力が省略されていれば判定しない。
 *
 * - `no_history`: `previous` がない、`previous` が前日でない（`captured_on` の日数差がちょうど 1 でない）、`previous = 0`
 * - 条件: `previous − latest ≥ 10` かつ `(previous − latest) × 100 ≥ previous × 1`（1% 以上。整数で判定。Q11）
 */
function evaluateFollowerDrop(account: AlertAccount, total: number): DropEvaluation {
  const signal = account.followers;
  if (!signal) return NOT_EVALUATED;
  const { latest, previous } = signal;
  if (previous === null || previous.count === 0) return { alert: undefined, skipped: "no_history" };
  if (utcDayNumber(latest.capturedOn) - utcDayNumber(previous.capturedOn) !== 1) {
    return { alert: undefined, skipped: "no_history" };
  }
  const drop = BigInt(previous.count) - BigInt(latest.count);
  if (drop >= BigInt(FOLLOWER_DROP_MIN_COUNT) && drop * 100n >= BigInt(previous.count) * BigInt(FOLLOWER_DROP_MIN_PERCENT)) {
    return { alert: { kind: "follower_drop", ordinal: account.ordinal, total }, skipped: undefined };
  }
  return NOT_EVALUATED;
}

/**
 * 判定の本体。`now` は残り日数の基準（UTC、切り捨て）。`simulate` が true なら先頭に `simulated` を足す
 * （本物の判定も続けて行う）。入力は変更しない
 */
export function evaluateAlerts(input: AlertInput, now: Date, scope: AlertScope, simulate: boolean): AlertEvaluation {
  const alerts: Alert[] = [];
  const noHistoryKinds = new Set<NoHistoryKind>();
  let noPosts = false;
  if (simulate) alerts.push({ kind: "simulated" });
  const total = input.accounts.length;
  for (const account of input.accounts) {
    if (account.status !== "active") continue;
    if (scope === "daily") {
      const token = evaluateToken(account, total, now);
      if (token) alerts.push(token);
      const ocr = evaluateOcrMonthlyCap(account, total, input.ocrLimits);
      if (ocr) alerts.push(ocr);
      const reach = evaluateNonFollowerReachDrop(account, total);
      if (reach.alert) alerts.push(reach.alert);
      if (reach.skipped === "no_history") noHistoryKinds.add("non_follower_reach_drop");
      if (reach.skipped === "no_posts") noPosts = true;
      const followers = evaluateFollowerDrop(account, total);
      if (followers.alert) alerts.push(followers.alert);
      if (followers.skipped === "no_history") noHistoryKinds.add("follower_drop");
    }
    const stories = evaluateStories(account, total);
    if (stories.alert) alerts.push(stories.alert);
    if (stories.noHistory) noHistoryKinds.add("stories");
  }
  return {
    alerts,
    noHistory: noHistoryKinds.size > 0,
    noHistoryKinds: NO_HISTORY_KIND_ORDER.filter((kind) => noHistoryKinds.has(kind)),
    noPosts,
  };
}

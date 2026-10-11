/**
 * 環境変数から設定を読み込む。`process.env` を読むのはこのファイルだけ（設計 10.5 章）。
 *
 * - 秘密情報（トークン、アプリシークレット、接続文字列、サービスロールキー）はログに出さないこと（NF-SEC-06）
 * - 書式が不正なときは、変数名だけを示して例外を投げる。値は例外のメッセージに入れない（設計 2.3 章、11.3 章）
 * - Vision の鍵（`GCP_VISION_KEY_JSON`／`GCP_VISION_KEY_FILE`）だけは例外にせず `visionKey.ok = false` で返す（R4.1 設計 3.8 節）
 */
import { readFileSync } from "node:fs";

export const DEFAULT_GRAPH_API_VERSION = "v25.0";

/** video_analysis の 1 回の本数の上限の既定値（R4 設計 3.2 節） */
export const DEFAULT_VIDEO_MAX_PER_RUN = 5;
/** video_analysis の時間の予算の既定値（8 分。R4 設計 3.2 節） */
export const DEFAULT_VIDEO_BUDGET_MS = 8 * 60 * 1000;

/** video_text が 1 回に OCR する本数の既定値（R4.1 設計 3.2 節。0 なら候補を数えるだけ） */
export const DEFAULT_VIDEO_TEXT_MAX_PER_RUN = 5;
/** video_text の時間の予算の既定値（8 分。R4.1 設計 3.2 節） */
export const DEFAULT_VIDEO_TEXT_BUDGET_MS = 8 * 60 * 1000;
/** video_text が 1 回に使うユニットの上限の既定値（R4.1 設計 3.2 節） */
export const DEFAULT_VIDEO_TEXT_MAX_UNITS_PER_RUN = 200;
/** video_text の月のユニットの上限の既定値（R4.1 設計 3.3 節。Vision の無料枠） */
export const DEFAULT_VIDEO_TEXT_MONTHLY_UNIT_LIMIT = 1000;
/** 月のユニットの上限に設定できる最大値。無料枠と同じにして、打ち間違いで有料の領域に入らない（R4.1 設計 3.3 節） */
export const VIDEO_TEXT_MONTHLY_UNIT_LIMIT_MAX = 1000;
/** video_text の月の本数の上限の既定値（R4.1 設計 3.3 節） */
export const DEFAULT_VIDEO_TEXT_MONTHLY_MAX_VIDEOS = 30;

/** Google のサービスアカウントの鍵に書かれているべき token_uri。これ以外の鍵は使わない（R4.1 設計 3.8 節） */
export const GOOGLE_OAUTH_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** 動画とサムネイルのダウンロードを許可するホスト（後方一致）。設計 3.7 章。環境変数にしない */
export const DOWNLOAD_ALLOWED_HOSTS: readonly string[] = ["cdninstagram.com", "fbcdn.net"];

export type LogLevel = "info" | "debug";

/**
 * Vision API のサービスアカウントの鍵（R4.1 設計 3.8 節）。
 * `missing` は変数がない、`invalid` は読めないか形が合わない。どちらでも起動は失敗させない（Vision は任意の機能）。
 * 値（`privateKey`）はログや例外に出さない。ジョブの枠組みがマスクの対象に加える
 */
export type VisionKey =
  | { ok: true; key: { clientEmail: string; privateKey: string } }
  | { ok: false; reason: "missing" | "invalid" };

/** `DATABASE_SSL_CA` なしで接続してよい（平文のまま）ホスト。これ以外は CA が必須（R2 設計 2.2 章のフェイルクローズ） */
export const LOCAL_DB_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "host.docker.internal"];

/** 収集ジョブとスケジューラが使う設定（設計 10.2 章、11.3 章） */
export interface WorkerConfig {
  databaseUrl: string;
  /** DB の TLS に使う CA 証明書（PEM）。ローカルのホストでは省略可。値はログや例外に出さない（R2 設計 2.2 章） */
  databaseSslCa?: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  graphApiVersion: string;
  metaAppId: string;
  metaAppSecret: string;
  /** 毎時何分に hourly グループを動かすか（0〜59） */
  hourlyMinute: number;
  /** daily グループを動かす日本時間の時刻 */
  dailyTimeJst: { hour: number; minute: number };
  /** account_backfill が 1 回の実行で進める日数 */
  backfillMaxDays: number;
  /** account_backfill が遡る日数（1〜730）。既定は API の上限の 2 年。開設して間もないアカウントでは短くする */
  backfillHistoryDays: number;
  /** レート制限の使用率（%）がこれ以上ならすべてのジョブを止める */
  rateHardLimit: number;
  /** レート制限の使用率（%）がこれ以上なら account_backfill を進めない */
  rateSoftLimit: number;
  logLevel: LogLevel;
  /** 検証結果などのローカル出力先（Git 管理外） */
  outputDir: string;
  downloadAllowedHosts: string[];
  /** video_analysis が 1 回の実行で解析する本数の上限（R4 設計 3.2 節） */
  videoMaxPerRun: number;
  /** video_analysis の時間の予算（ミリ秒）。ジョブの開始からの経過がこれを超えたら新しい 1 本を始めない（R4 設計 3.2 節） */
  videoBudgetMs: number;
  /** video_text が 1 回に OCR する本数の上限（0〜100）。0 なら候補を数えて info を出すだけ（R4.1 設計 3.2 節） */
  videoTextMaxPerRun: number;
  /** video_text の時間の予算（ミリ秒）。超えていたら新しい 1 本を始めず、失敗した要求の再送もしない（R4.1 設計 3.2 節） */
  videoTextBudgetMs: number;
  /** video_text が 1 回に使うユニットの上限（1〜1,000。R4.1 設計 3.2 節） */
  videoTextMaxUnitsPerRun: number;
  /** video_text の月（UTC の暦月）のユニットの上限（0〜1,000。R4.1 設計 3.3 節） */
  videoTextMonthlyUnitLimit: number;
  /** video_text の月（UTC の暦月）の本数の上限（0〜1,000。R4.1 設計 3.3 節） */
  videoTextMonthlyMaxVideos: number;
  /** Vision API の鍵。ない・形が不正でも起動は失敗させない（R4.1 設計 3.8 節） */
  visionKey: VisionKey;
}

/** `register-token` コマンドの設定。`.env` のトークンを読むのはこのコマンドと `verify-api` だけ（設計 4.1 章） */
export interface RegisterTokenConfig extends WorkerConfig {
  accessToken: string;
  igUserId: string;
}

/** `verify-api` の設定（R0 から）。ユーザートークンでも動くよう、IG_USER_ID とアプリの ID は任意 */
export interface MetaConfig {
  accessToken: string;
  graphApiVersion: string;
  /** 省略時は /me/accounts から接続済みの Instagram アカウントを探す */
  igUserId: string | undefined;
  /** debug_token でトークンの種類と期限を調べるために使う（任意） */
  appId: string | undefined;
  appSecret: string | undefined;
}

/** `verify-api` の設定に、DB と Storage の確認（設計 11.1 章 P6）用の任意項目を加えたもの */
export interface VerifyConfig extends MetaConfig {
  databaseUrl: string | undefined;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
}

/**
 * `check-alerts` の設定（R2 設計 5.2 章）。DB を読むだけなので、Meta と Storage の変数は要らない
 * （GitHub Actions ではこのステップに `DATABASE_URL`、`DATABASE_SSL_CA`、`WORKER_SIMULATE_ALERT` だけを渡す）
 */
export interface CheckAlertsConfig {
  databaseUrl: string;
  databaseSslCa: string | undefined;
  logLevel: LogLevel;
  /** `WORKER_SIMULATE_ALERT=true` のとき true。`alert=simulated` を出して終了コード 1 にする */
  simulateAlert: boolean;
}

type Env = Record<string, string | undefined>;

/** 設定の不備。メッセージには変数名だけを含め、値を含めない */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (!value) {
    throw new ConfigError(`環境変数 ${name} が設定されていません。.env.example を参照してください`);
  }
  return value;
}

function integerInRange(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(`環境変数 ${name} の書式が不正です（${min}〜${max} の整数）`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ConfigError(`環境変数 ${name} の書式が不正です（${min}〜${max} の整数）`);
  }
  return value;
}

function dailyTime(env: Env, name: string, fallback: { hour: number; minute: number }): { hour: number; minute: number } {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!match) {
    throw new ConfigError(`環境変数 ${name} の書式が不正です（HH:MM、00:00〜23:59）`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function logLevel(env: Env, name: string): LogLevel {
  const raw = optional(env, name) ?? "info";
  if (raw !== "info" && raw !== "debug") {
    throw new ConfigError(`環境変数 ${name} の書式が不正です（info か debug）`);
  }
  return raw;
}

/** Graph API のバージョン（`v25.0` の形）。省略時は既定 */
function graphApiVersion(env: Env): string {
  const raw = optional(env, "META_GRAPH_API_VERSION");
  if (raw === undefined) return DEFAULT_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(raw)) {
    throw new ConfigError("環境変数 META_GRAPH_API_VERSION の書式が不正です（v<数字>.<数字> の形）");
  }
  return raw;
}

/**
 * 必須の URL。`new URL()` で読めなければ `ConfigError`。
 * `URL` の例外（`ERR_INVALID_URL`）は `input` に値を持つので外に出さない
 */
function requiredUrl(env: Env, name: string): string {
  const value = required(env, name);
  try {
    new URL(value);
  } catch {
    throw new ConfigError(`環境変数 ${name} の書式が不正です（URL）`);
  }
  return value;
}

/** `true`／`false`（省略時は false）。それ以外は `ConfigError` */
function booleanFlag(env: Env, name: string): boolean {
  const raw = optional(env, name);
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  throw new ConfigError(`環境変数 ${name} の書式が不正です（true か false）`);
}

const PEM_CERTIFICATE_HEADER = "-----BEGIN CERTIFICATE-----";

/** `DATABASE_URL` のホスト名。`requiredUrl` で検証済みの URL を渡す */
function databaseHost(databaseUrl: string): string {
  return new URL(databaseUrl).hostname;
}

/**
 * `DATABASE_SSL_CA`（PEM）。環境変数の入力経路で改行が `\n` のリテラルになることがあるので改行に正規化し、
 * `-----BEGIN CERTIFICATE-----` で始まることを検査する（値は例外に入れない）。
 * フェイルクローズ: `DATABASE_URL` のホストが `LOCAL_DB_HOSTS` 以外なのに未設定なら `ConfigError`（R2 設計 2.2 章）
 */
function databaseSslCa(env: Env, databaseUrl: string): string | undefined {
  const raw = optional(env, "DATABASE_SSL_CA");
  if (raw === undefined) {
    if (LOCAL_DB_HOSTS.includes(databaseHost(databaseUrl))) return undefined;
    throw new ConfigError(
      "環境変数 DATABASE_SSL_CA が設定されていません（DATABASE_URL のホストがローカル以外のときは必須。Supabase の CA 証明書を PEM で渡す）",
    );
  }
  const pem = raw.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim();
  if (!pem.startsWith(PEM_CERTIFICATE_HEADER)) {
    throw new ConfigError("環境変数 DATABASE_SSL_CA の書式が不正です（PEM の証明書。-----BEGIN CERTIFICATE----- で始まる）");
  }
  return pem;
}

const PEM_PRIVATE_KEY_HEADER = "-----BEGIN PRIVATE KEY-----";
/** サービスアカウントの client_email の形（`<名前>@<プロジェクト>.iam.gserviceaccount.com`） */
const SERVICE_ACCOUNT_EMAIL_PATTERN = /@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

/** 鍵のファイルを読む関数。テストで差し替える */
export type ReadTextFile = (path: string) => string;

function readTextFileSync(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * 鍵の JSON（サービスアカウントの鍵ファイルの中身）を検査して、使う 2 つの値だけを取り出す。
 * `JSON.parse` の例外は入力の断片を含むので捨てる。`token_uri` は定数と一致することだけを見て値は持たない
 */
function parseVisionKey(json: string): VisionKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid" };
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record["client_email"];
  const privateKey = record["private_key"];
  const tokenUri = record["token_uri"];
  if (typeof clientEmail !== "string" || !SERVICE_ACCOUNT_EMAIL_PATTERN.test(clientEmail)) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof privateKey !== "string" || !privateKey.startsWith(PEM_PRIVATE_KEY_HEADER)) {
    return { ok: false, reason: "invalid" };
  }
  if (tokenUri !== GOOGLE_OAUTH_TOKEN_URI) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, key: { clientEmail, privateKey } };
}

/**
 * Vision API の鍵（R4.1 設計 3.8 節）。`GCP_VISION_KEY_JSON` があれば JSON として読み、なければ
 * `GCP_VISION_KEY_FILE` のファイルを読む（`process.env` とこのファイルを読むのは `config.ts` だけ）。
 * ファイルの読み込みの例外はパスを含むので捨てて `invalid` にする。どの場合も例外を投げない（起動を失敗させない）
 */
export function loadVisionKey(env: Env = process.env, readFile: ReadTextFile = readTextFileSync): VisionKey {
  const inline = optional(env, "GCP_VISION_KEY_JSON");
  if (inline !== undefined) return parseVisionKey(inline);
  const path = optional(env, "GCP_VISION_KEY_FILE");
  if (path === undefined) return { ok: false, reason: "missing" };
  let json: string;
  try {
    json = readFile(path);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  return parseVisionKey(json);
}

/** 検証結果などのローカル出力先（Git 管理外） */
export function outputDir(env: Env = process.env): string {
  return optional(env, "WORKER_OUTPUT_DIR") ?? ".local";
}

/** 収集ジョブとスケジューラの設定。必須の変数がない、または書式が不正なら `ConfigError` */
export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const rateHardLimit = integerInRange(env, "WORKER_RATE_HARD_LIMIT", 90, 1, 100);
  const rateSoftLimit = integerInRange(env, "WORKER_RATE_SOFT_LIMIT", 50, 1, 100);
  if (rateSoftLimit > rateHardLimit) {
    throw new ConfigError("環境変数 WORKER_RATE_SOFT_LIMIT は WORKER_RATE_HARD_LIMIT 以下にしてください");
  }
  const databaseUrl = requiredUrl(env, "DATABASE_URL");
  return {
    databaseUrl,
    databaseSslCa: databaseSslCa(env, databaseUrl),
    supabaseUrl: requiredUrl(env, "SUPABASE_URL"),
    supabaseServiceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    graphApiVersion: graphApiVersion(env),
    metaAppId: required(env, "META_APP_ID"),
    metaAppSecret: required(env, "META_APP_SECRET"),
    hourlyMinute: integerInRange(env, "WORKER_HOURLY_MINUTE", 5, 0, 59),
    dailyTimeJst: dailyTime(env, "WORKER_DAILY_TIME_JST", { hour: 5, minute: 30 }),
    backfillMaxDays: integerInRange(env, "WORKER_BACKFILL_MAX_DAYS", 30, 1, 730),
    backfillHistoryDays: integerInRange(env, "WORKER_BACKFILL_HISTORY_DAYS", 730, 1, 730),
    rateHardLimit,
    rateSoftLimit,
    logLevel: logLevel(env, "WORKER_LOG_LEVEL"),
    outputDir: outputDir(env),
    downloadAllowedHosts: [...DOWNLOAD_ALLOWED_HOSTS],
    videoMaxPerRun: integerInRange(env, "WORKER_VIDEO_MAX_PER_RUN", DEFAULT_VIDEO_MAX_PER_RUN, 1, 100),
    videoBudgetMs: integerInRange(env, "WORKER_VIDEO_BUDGET_MS", DEFAULT_VIDEO_BUDGET_MS, 0, 30 * 60 * 1000),
    // R4.1: 本数の下限は 0（本番で一時的に止める）。月のユニットの上限の範囲は無料枠まで（有料の領域に入らない）
    videoTextMaxPerRun: integerInRange(env, "WORKER_VIDEO_TEXT_MAX_PER_RUN", DEFAULT_VIDEO_TEXT_MAX_PER_RUN, 0, 100),
    videoTextBudgetMs: integerInRange(env, "WORKER_VIDEO_TEXT_BUDGET_MS", DEFAULT_VIDEO_TEXT_BUDGET_MS, 0, 30 * 60 * 1000),
    videoTextMaxUnitsPerRun: integerInRange(env, "WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN", DEFAULT_VIDEO_TEXT_MAX_UNITS_PER_RUN, 1, 1000),
    videoTextMonthlyUnitLimit: integerInRange(
      env,
      "WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT",
      DEFAULT_VIDEO_TEXT_MONTHLY_UNIT_LIMIT,
      0,
      VIDEO_TEXT_MONTHLY_UNIT_LIMIT_MAX,
    ),
    videoTextMonthlyMaxVideos: integerInRange(env, "WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS", DEFAULT_VIDEO_TEXT_MONTHLY_MAX_VIDEOS, 0, 1000),
    visionKey: loadVisionKey(env),
  };
}

/** `register-token` の設定。ワーカーの設定に加えて、`.env` のトークンと Instagram アカウントの ID が要る */
export function loadRegisterTokenConfig(env: Env = process.env): RegisterTokenConfig {
  return {
    ...loadWorkerConfig(env),
    accessToken: required(env, "META_ACCESS_TOKEN"),
    igUserId: required(env, "IG_USER_ID"),
  };
}

/** `verify-api` の設定（R0 から） */
export function loadMetaConfig(env: Env = process.env): MetaConfig {
  const accessToken = optional(env, "META_ACCESS_TOKEN");
  if (!accessToken) {
    throw new ConfigError(
      "環境変数 META_ACCESS_TOKEN が設定されていません。README の「Meta API の検証」を参照してください。",
    );
  }
  return {
    accessToken,
    graphApiVersion: graphApiVersion(env),
    igUserId: optional(env, "IG_USER_ID"),
    appId: optional(env, "META_APP_ID"),
    appSecret: optional(env, "META_APP_SECRET"),
  };
}

/** `check-alerts` の設定。`DATABASE_URL`（と、ローカル以外なら `DATABASE_SSL_CA`）が必須 */
export function loadCheckAlertsConfig(env: Env = process.env): CheckAlertsConfig {
  const databaseUrl = requiredUrl(env, "DATABASE_URL");
  return {
    databaseUrl,
    databaseSslCa: databaseSslCa(env, databaseUrl),
    logLevel: logLevel(env, "WORKER_LOG_LEVEL"),
    simulateAlert: booleanFlag(env, "WORKER_SIMULATE_ALERT"),
  };
}

/** `verify-api` の設定。DB と Storage の項目は任意で、なければその検証を見送る */
export function loadVerifyConfig(env: Env = process.env): VerifyConfig {
  return {
    ...loadMetaConfig(env),
    databaseUrl: optional(env, "DATABASE_URL"),
    supabaseUrl: optional(env, "SUPABASE_URL"),
    supabaseServiceRoleKey: optional(env, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}

/**
 * CI（GitHub Actions など）で動いているか。`CI` か `GITHUB_ACTIONS` が空でなければ true。
 * `video-tune` は公開ログに投稿の情報が出るので CI では動かさない（R4 設計 4.1 節）
 */
export function isCiEnvironment(env: Env = process.env): boolean {
  return optional(env, "CI") !== undefined || optional(env, "GITHUB_ACTIONS") !== undefined;
}

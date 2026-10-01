import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOWNLOAD_ALLOWED_HOSTS,
  loadVerifyConfig,
  outputDir,
  type MetaConfig,
  type VerifyConfig,
} from "../config.js";
import { closeDb, connectDb, normalizeDbError } from "../db/client.js";
import { stripVolatileFields } from "../jobs/graph-client.js";
import { DownloadError, downloadToFile, type DownloadLimits } from "../lib/download.js";
import { detectSceneChanges, probeVideo } from "../lib/ffmpeg.js";
import {
  formatGraphError,
  GraphClient,
  parseCdnExpiry,
  type GraphError,
  type GraphParams,
  type GraphResponse,
  type RateLimitHeaders,
} from "../lib/graph.js";
import { sanitizeForLog, SecretRegistry } from "../lib/log.js";
import { addDays, metricDateFromEndTime, pacificDayRange, PT, zonedDate, zonedMidnightUtc } from "../lib/time.js";

/**
 * Meta API の未確認事項を実機で検証する（要件定義 F-COL-00）。
 *
 * - 詳細（API のレスポンスを含む）は .local/api-verification/*.json に保存する（Git 管理外）。
 *   書く前に `stripVolatileFields`（期限付き URL、`paging.next`、`access_token` を落とす）と、
 *   トークン・アプリシークレット・サービスロールキーのマスクを通す
 * - 要約（*.md）には ID、ユーザー名、指標の値などの取得データを含めない（NF-SEC-07）。
 *   `note` と `request` は `sanitizeForLog` を通してから保持・表示する（Graph API のエラー文経由の ID と URL を落とす）。
 *   要約はそのまま doc/ に転記できる内容にする
 * - R0 の項目に加えて、R1 の設計書 11.1 章の確認項目 P1〜P12（セクション名 `R1-P1` …）を行う
 */

type Status = "ok" | "ng" | "info" | "skip";

interface CheckResult {
  section: string;
  name: string;
  status: Status;
  /** 要約に載せる説明。取得データ（ID、値、キャプションなど）を含めないこと */
  note: string;
  request?: string;
  response?: unknown;
}

const STATUS_LABEL: Record<Status, string> = { ok: "OK", ng: "NG", info: "情報", skip: "未検証" };

class Recorder {
  readonly results: CheckResult[] = [];
  private lastRateLimit: RateLimitHeaders | undefined;

  constructor(private readonly secrets: SecretRegistry) {}

  /** `note` と `request` は秘密の一覧とパターン（URL、10 桁以上の数字）でマスクしてから保持する */
  add(result: CheckResult): void {
    const clean: CheckResult = { ...result, note: sanitizeForLog(result.note, this.secrets) };
    if (result.request !== undefined) clean.request = sanitizeForLog(result.request, this.secrets);
    this.results.push(clean);
    console.log(`[${STATUS_LABEL[clean.status]}] ${clean.section} / ${clean.name}: ${clean.note}`);
  }

  track(res: GraphResponse): void {
    if (res.rateLimit.businessUseCaseUsage || res.rateLimit.appUsage) {
      this.lastRateLimit = res.rateLimit;
    }
  }

  get rateLimit(): RateLimitHeaders | undefined {
    return this.lastRateLimit;
  }
}

interface InsightValue {
  value?: unknown;
  end_time?: string;
}

interface InsightItem {
  name: string;
  period?: string;
  values?: InsightValue[];
  total_value?: {
    value?: number;
    breakdowns?: { dimension_keys?: string[]; results?: unknown[] }[];
  };
}

interface InsightsResponse {
  data?: InsightItem[];
}

interface MediaItem {
  id: string;
  media_type?: string;
  media_product_type?: string;
  timestamp?: string;
  media_url?: string;
  thumbnail_url?: string;
}

interface GraphPaging {
  cursors?: { before?: string; after?: string };
  next?: string;
  previous?: string;
}

const DAY = 86_400;
const nowSec = (): number => Math.floor(Date.now() / 1000);

export async function verifyApi(): Promise<boolean> {
  const config = loadVerifyConfig();
  const graph = new GraphClient(config.accessToken, config.graphApiVersion);

  // 要約と標準出力のマスク: トークン類、Instagram の ID、接続先（DB と Storage）のユーザー名・パスワード・ホスト名
  const secrets = new SecretRegistry();
  secrets.add(config.accessToken);
  secrets.add(config.appSecret);
  secrets.add(config.supabaseServiceRoleKey);
  secrets.add(config.igUserId);
  secrets.addUrlParts(config.databaseUrl);
  secrets.addUrlParts(config.supabaseUrl);
  // 詳細 JSON のマスク: ID やホスト名は残し、秘密の値だけを落とす
  const fileSecrets = new SecretRegistry();
  fileSecrets.add(config.accessToken);
  fileSecrets.add(config.appSecret);
  fileSecrets.add(config.supabaseServiceRoleKey);

  const rec = new Recorder(secrets);
  const startedAt = new Date();

  console.log(`Graph API バージョン: ${config.graphApiVersion}`);
  console.log("");

  await checkToken(graph, config, rec);
  const igUserId = await resolveIgUser(graph, config, rec);

  if (igUserId) {
    await checkProfile(graph, igUserId, rec);
    await checkAccountInsights(graph, igUserId, rec);
    await checkDateRange(graph, igUserId, rec);
    await checkDemographics(graph, igUserId, rec);
    const media = await checkMediaList(graph, igUserId, rec);
    await checkMediaFields(graph, media, rec);
    await checkMediaInsights(graph, media, rec);
    await checkCarouselChildren(graph, media, rec);
    await checkReelDownload(graph, media, rec);
    await checkStories(graph, igUserId, rec);
    await verifyR1Items(graph, config, igUserId, media, rec);
  }
  recordRateLimit(rec);

  const files = await writeOutputs(config, rec, startedAt, fileSecrets);
  console.log("");
  console.log(`詳細: ${files.json}`);
  console.log(`要約: ${files.markdown}`);
  return !rec.results.some((r) => r.section === "前提" && r.status === "ng");
}

// ---------------------------------------------------------------------------
// トークンとアカウント
// ---------------------------------------------------------------------------

async function checkToken(graph: GraphClient, config: MetaConfig, rec: Recorder): Promise<void> {
  const section = "トークン";
  if (config.appId && config.appSecret) {
    const res = await graph.get<{
      data?: {
        type?: string;
        is_valid?: boolean;
        expires_at?: number;
        data_access_expires_at?: number;
        scopes?: string[];
      };
    }>(
      "debug_token",
      { input_token: config.accessToken },
      `${config.appId}|${config.appSecret}`,
    );
    rec.track(res);
    const info = res.data?.data;
    if (!res.ok || !info) {
      rec.add({ section, name: "debug_token", status: "ng", note: formatGraphError(res.error) });
      return;
    }
    const expires =
      info.expires_at === 0
        ? "期限なし"
        : info.expires_at
          ? `あと約 ${((info.expires_at - nowSec()) / 3600).toFixed(1)} 時間`
          : "不明";
    const dataAccess = info.data_access_expires_at
      ? `あと約 ${((info.data_access_expires_at - nowSec()) / DAY).toFixed(0)} 日`
      : "不明";
    rec.add({
      section,
      name: "debug_token",
      status: info.is_valid ? "ok" : "ng",
      note: `種類 ${info.type ?? "不明"}、有効期限 ${expires}、データアクセス期限 ${dataAccess}、権限 ${(info.scopes ?? []).join(", ")}`,
    });
    return;
  }

  const res = await graph.get<{ data?: { permission: string; status: string }[] }>(
    "me/permissions",
  );
  rec.track(res);
  if (!res.ok) {
    rec.add({
      section,
      name: "me/permissions",
      status: "info",
      note: `取得できず（ページトークンの場合は正常）: ${formatGraphError(res.error)}。META_APP_ID と META_APP_SECRET を設定すると debug_token で詳しく調べられる`,
    });
    return;
  }
  const granted = (res.data?.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
  rec.add({ section, name: "me/permissions", status: "ok", note: `付与済みの権限: ${granted.join(", ")}` });
}

async function resolveIgUser(
  graph: GraphClient,
  config: MetaConfig,
  rec: Recorder,
): Promise<string | undefined> {
  const section = "前提";
  if (config.igUserId) {
    rec.add({ section, name: "Instagram アカウント", status: "ok", note: "IG_USER_ID の指定を使用" });
    return config.igUserId;
  }
  const res = await graph.get<{
    data?: { id: string; instagram_business_account?: { id: string } }[];
  }>("me/accounts", { fields: "id,instagram_business_account{id,username}", limit: 100 });
  rec.track(res);
  if (!res.ok) {
    rec.add({
      section,
      name: "me/accounts",
      status: "ng",
      note: `${formatGraphError(res.error)}。IG_USER_ID を指定するか、pages_show_list 権限を付けたユーザートークンを使う`,
    });
    return undefined;
  }
  const pages = res.data?.data ?? [];
  const linked = pages.filter((p) => p.instagram_business_account?.id);
  const first = linked[0]?.instagram_business_account?.id;
  rec.add({
    section,
    name: "me/accounts",
    status: first ? "ok" : "ng",
    note: first
      ? `Facebook ページ ${pages.length} 件のうち Instagram 接続済み ${linked.length} 件。先頭のアカウントで検証する`
      : "Instagram プロアカウントに接続された Facebook ページが見つからない",
    response: res.data,
  });
  return first;
}

async function checkProfile(graph: GraphClient, igUserId: string, rec: Recorder): Promise<void> {
  const fields = [
    "id",
    "username",
    "name",
    "biography",
    "website",
    "followers_count",
    "follows_count",
    "media_count",
    "profile_picture_url",
  ];
  const res = await graph.get<Record<string, unknown>>(igUserId, { fields: fields.join(",") });
  rec.track(res);
  if (!res.ok || !res.data) {
    rec.add({ section: "プロフィール", name: "IG User", status: "ng", note: formatGraphError(res.error) });
    return;
  }
  const data = res.data;
  const missing = fields.filter((f) => data[f] === undefined);
  rec.add({
    section: "プロフィール",
    name: "IG User",
    status: "ok",
    note: missing.length
      ? `取得できたフィールド: ${fields.filter((f) => !missing.includes(f)).join(", ")}。返らなかったフィールド: ${missing.join(", ")}`
      : `すべて取得できた: ${fields.join(", ")}`,
    request: graph.describe(igUserId, { fields: fields.join(",") }),
    response: data,
  });
}

// ---------------------------------------------------------------------------
// アカウントのインサイト
// ---------------------------------------------------------------------------

interface MetricSpec {
  metric: string;
  breakdown?: string;
}

const ACCOUNT_METRICS: MetricSpec[] = [
  { metric: "reach" },
  { metric: "reach", breakdown: "follow_type" },
  { metric: "reach", breakdown: "media_product_type" },
  { metric: "views" },
  { metric: "views", breakdown: "follower_type" },
  { metric: "views", breakdown: "follow_type" },
  { metric: "views", breakdown: "media_product_type" },
  { metric: "accounts_engaged" },
  { metric: "total_interactions" },
  { metric: "total_interactions", breakdown: "media_product_type" },
  { metric: "likes" },
  { metric: "comments" },
  { metric: "shares" },
  { metric: "saves" },
  { metric: "replies" },
  { metric: "reposts" },
  { metric: "follows_and_unfollows", breakdown: "follow_type" },
  { metric: "profile_links_taps", breakdown: "contact_button_type" },
];

function specLabel(spec: MetricSpec): string {
  return spec.breakdown ? `${spec.metric}（breakdown=${spec.breakdown}）` : spec.metric;
}

async function checkAccountInsights(
  graph: GraphClient,
  igUserId: string,
  rec: Recorder,
): Promise<void> {
  const section = "アカウント指標";
  const since = nowSec() - 2 * DAY;
  const until = nowSec() - DAY;

  for (const spec of ACCOUNT_METRICS) {
    const params: GraphParams = {
      metric: spec.metric,
      period: "day",
      metric_type: "total_value",
      breakdown: spec.breakdown,
      since,
      until,
    };
    const path = `${igUserId}/insights`;
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    const item = res.data?.data?.[0];
    rec.add({
      section,
      name: specLabel(spec),
      status: res.ok && item ? "ok" : "ng",
      note: res.ok
        ? item
          ? "取得できた（metric_type=total_value、period=day）"
          : "エラーはないが data が空"
        : formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.data,
    });
  }

  // 要件定義の未確認事項: follower_count と online_followers
  for (const [metric, params] of [
    ["follower_count", { metric: "follower_count", period: "day", since: nowSec() - 30 * DAY, until: nowSec() }],
    ["online_followers", { metric: "online_followers", period: "lifetime", since: nowSec() - 2 * DAY, until: nowSec() - DAY }],
  ] as const) {
    const path = `${igUserId}/insights`;
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    const values = res.data?.data?.[0]?.values ?? [];
    // online_followers は値が「時間帯 → 人数」のオブジェクト。空オブジェクトなら実質取得できていない
    const emptyObjects = values.filter(
      (v) => v.value !== null && typeof v.value === "object" && Object.keys(v.value).length === 0,
    ).length;
    const usable = values.length > 0 && emptyObjects < values.length;
    rec.add({
      section,
      name: metric,
      status: res.ok && usable ? "ok" : "ng",
      note: res.ok
        ? usable
          ? `取得できた（値の件数 ${values.length}）`
          : values.length > 0
            ? "エラーはないが値の中身が空"
            : "エラーはないが値が空"
        : formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.data,
    });
  }
}

/** since〜until の最大幅、保持期間、日付の区切りのタイムゾーンを調べる */
async function checkDateRange(graph: GraphClient, igUserId: string, rec: Recorder): Promise<void> {
  const section = "期間とタイムゾーン";
  const path = `${igUserId}/insights`;
  const endTimes = new Set<string>();

  for (const days of [30, 31, 60, 90, 91]) {
    const params: GraphParams = {
      metric: "reach",
      period: "day",
      metric_type: "time_series",
      since: nowSec() - days * DAY,
      until: nowSec(),
    };
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    const values = res.data?.data?.[0]?.values ?? [];
    for (const v of values) {
      const time = v.end_time?.slice(10);
      if (time) endTimes.add(time);
    }
    rec.add({
      section,
      name: `reach time_series の範囲 ${days} 日`,
      status: res.ok ? "ok" : "ng",
      note: res.ok ? `受け付けられた（返った日数 ${values.length}）` : formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.data,
    });
  }

  // 保持期間: 過去のどこまで遡れるか（30 日幅の窓を過去へずらして確かめる）
  for (const [metric, endDaysAgo] of [
    ["reach", 91],
    ["reach", 180],
    ["reach", 365],
    ["reach", 540],
    ["reach", 700],
    ["reach", 760],
    ["follower_count", 31],
    ["follower_count", 90],
  ] as const) {
    const params: GraphParams = {
      metric,
      period: "day",
      metric_type: metric === "reach" ? "time_series" : undefined,
      since: nowSec() - (endDaysAgo + 29) * DAY,
      until: nowSec() - endDaysAgo * DAY,
    };
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    const values = res.data?.data?.[0]?.values ?? [];
    const nonZero = values.filter((v) => typeof v.value === "number" && v.value !== 0).length;
    rec.add({
      section,
      name: `${metric} の ${endDaysAgo}〜${endDaysAgo + 29} 日前`,
      status: "info",
      note: res.ok
        ? `返った日数 ${values.length}、うち値が 0 でない日数 ${nonZero}`
        : formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.data,
    });
  }

  // total_value の指標を過去の 1 日分だけ取れるか（初回接続時のバックフィルの可否）
  for (const spec of [
    { metric: "views" },
    { metric: "reach", breakdown: "follow_type" },
    { metric: "accounts_engaged" },
    { metric: "total_interactions" },
    { metric: "follows_and_unfollows", breakdown: "follow_type" },
    { metric: "profile_links_taps", breakdown: "contact_button_type" },
  ] as MetricSpec[]) {
    const params: GraphParams = {
      metric: spec.metric,
      period: "day",
      metric_type: "total_value",
      breakdown: spec.breakdown,
      since: nowSec() - 181 * DAY,
      until: nowSec() - 180 * DAY,
    };
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    const total = res.data?.data?.[0]?.total_value;
    rec.add({
      section,
      name: `${specLabel(spec)} の 180 日前の 1 日分`,
      status: "info",
      note: res.ok
        ? total
          ? `取得できた（値が 0 でない: ${total.value ? "はい" : "いいえ"}）`
          : "エラーはないが total_value が空"
        : formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.data,
    });
  }

  // total_value しかない指標（views など）は期間の合計しか返らないため、日次にするには 1 日ずつ取得が必要か確かめる
  for (const days of [1, 30]) {
    const params: GraphParams = {
      metric: "views",
      period: "day",
      metric_type: "total_value",
      since: nowSec() - days * DAY,
      until: nowSec(),
    };
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    const item = res.data?.data?.[0];
    rec.add({
      section,
      name: `views total_value の範囲 ${days} 日`,
      status: res.ok ? "ok" : "ng",
      note: res.ok
        ? item?.values
          ? `日別の values が返った（${item.values.length} 件）`
          : "期間の合計値だけが返った（日次にするには 1 日ずつ取得が必要）"
        : formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.data,
    });
  }

  rec.add({
    section,
    name: "日付の区切り",
    status: endTimes.size > 0 ? "info" : "skip",
    note:
      endTimes.size > 0
        ? `time_series の end_time の時刻部分: ${[...endTimes].join(", ")}（例: T07:00:00+0000 なら米国太平洋夏時間の 0 時区切り）`
        : "time_series の値が得られず判定できない",
  });
}

async function checkDemographics(graph: GraphClient, igUserId: string, rec: Recorder): Promise<void> {
  const section = "属性";
  const path = `${igUserId}/insights`;
  for (const metric of ["follower_demographics", "engaged_audience_demographics"]) {
    for (const breakdown of ["age", "gender", "country", "city"]) {
      const params: GraphParams = {
        metric,
        period: "lifetime",
        timeframe: "this_month",
        metric_type: "total_value",
        breakdown,
      };
      const res = await graph.get<InsightsResponse>(path, params);
      rec.track(res);
      const results = res.data?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
      rec.add({
        section,
        name: `${metric}（${breakdown}）`,
        status: res.ok && results.length > 0 ? "ok" : "ng",
        note: res.ok
          ? results.length > 0
            ? `取得できた（区分の数 ${results.length}）`
            : "エラーはないが結果が空"
          : formatGraphError(res.error),
        request: graph.describe(path, params),
        response: res.data,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// メディア
// ---------------------------------------------------------------------------

interface MediaSamples {
  all: MediaItem[];
  reel: MediaItem | undefined;
  image: MediaItem | undefined;
  carousel: MediaItem | undefined;
  feedVideo: MediaItem | undefined;
}

async function checkMediaList(graph: GraphClient, igUserId: string, rec: Recorder): Promise<MediaSamples> {
  const fields =
    "id,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count,caption";
  const path = `${igUserId}/media`;
  const res = await graph.get<{ data?: MediaItem[]; paging?: { next?: string } }>(path, { fields, limit: 50 });
  rec.track(res);
  const all = res.data?.data ?? [];
  const types = [...new Set(all.map((m) => `${m.media_product_type}/${m.media_type}`))];
  rec.add({
    section: "メディア",
    name: "メディア一覧",
    status: res.ok ? "ok" : "ng",
    note: res.ok
      ? `取得できた。含まれる種類: ${types.join(", ") || "なし"}。次ページ ${res.data?.paging?.next ? "あり" : "なし"}`
      : formatGraphError(res.error),
    request: graph.describe(path, { fields, limit: 50 }),
    // URL 自体は保存時に落ちるので、許可リストの確認用にホスト名だけを別のキーで残す
    response: res.data
      ? {
          ...res.data,
          mediaUrlHosts: uniqueFullHosts(all.map((m) => m.media_url)),
          thumbnailUrlHosts: uniqueFullHosts(all.map((m) => m.thumbnail_url)),
        }
      : undefined,
  });
  return {
    all,
    reel: all.find((m) => m.media_product_type === "REELS"),
    image: all.find((m) => m.media_product_type === "FEED" && m.media_type === "IMAGE"),
    carousel: all.find((m) => m.media_type === "CAROUSEL_ALBUM"),
    feedVideo: all.find((m) => m.media_product_type === "FEED" && m.media_type === "VIDEO"),
  };
}

/** R0 で確かめた追加フィールド。`is_shared_to_feed` は R1-P7 に移した */
const EXTRA_MEDIA_FIELDS = [
  "view_count",
  "saved_count",
  "shares_count",
  "reposts_count",
  "total_like_count",
  "total_comments_count",
  "total_views_count",
  "is_ai_generated",
  "media_audio_type",
  "alt_text",
  "shortcode",
];

/** 値そのものではなく、型と形（配列の件数、オブジェクトのキー名）だけを説明する */
function describeValueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `配列 ${value.length} 件`;
  if (typeof value === "object") {
    return `オブジェクト（キー: ${Object.keys(value).join(", ") || "なし"}）`;
  }
  return typeof value;
}

/** メディアのフィールドを 1 つずつ `fields=id,<field>` で試す（R0 の追加フィールドと R1-P7 で共用） */
async function checkFieldsOneByOne(
  graph: GraphClient,
  mediaId: string,
  label: string,
  section: string,
  fields: string[],
  rec: Recorder,
): Promise<void> {
  for (const field of fields) {
    const params: GraphParams = { fields: `id,${field}` };
    const res = await graph.get<Record<string, unknown>>(mediaId, params);
    rec.track(res);
    const value = res.data?.[field];
    rec.add({
      section,
      name: `${field}（${label}）`,
      status: res.ok && value !== undefined ? "ok" : "ng",
      note: res.ok
        ? value !== undefined
          ? `取得できた（${describeValueShape(value)}）`
          : "エラーはないが値が返らない"
        : formatGraphError(res.error),
      request: graph.describe(mediaId, params),
      response: res.data ?? res.error,
    });
  }
}

async function checkMediaFields(graph: GraphClient, media: MediaSamples, rec: Recorder): Promise<void> {
  const target = media.reel ?? media.all[0];
  if (!target) {
    rec.add({ section: "メディアのフィールド", name: "追加フィールド", status: "skip", note: "投稿がない" });
    return;
  }
  const label = target === media.reel ? "リール" : "投稿";
  await checkFieldsOneByOne(graph, target.id, label, "メディアのフィールド", EXTRA_MEDIA_FIELDS, rec);
}

const COMMON_MEDIA_METRICS: MetricSpec[] = [
  { metric: "views" },
  { metric: "reach" },
  { metric: "likes" },
  { metric: "comments" },
  { metric: "shares" },
  { metric: "saved" },
  { metric: "reposts" },
  { metric: "total_interactions" },
  { metric: "profile_visits" },
  { metric: "profile_activity", breakdown: "action_type" },
  { metric: "follows" },
  { metric: "facebook_views" },
];

const REEL_METRICS: MetricSpec[] = [
  ...COMMON_MEDIA_METRICS,
  { metric: "ig_reels_avg_watch_time" },
  { metric: "ig_reels_video_view_total_time" },
  { metric: "reels_skip_rate" },
  { metric: "crossposted_views" },
];

async function checkInsightsOneByOne(
  graph: GraphClient,
  mediaId: string,
  section: string,
  specs: MetricSpec[],
  rec: Recorder,
): Promise<string[]> {
  const available: string[] = [];
  const path = `${mediaId}/insights`;
  for (const spec of specs) {
    const params: GraphParams = { metric: spec.metric, breakdown: spec.breakdown };
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    const ok = res.ok && (res.data?.data?.length ?? 0) > 0;
    if (ok && !spec.breakdown) available.push(spec.metric);
    rec.add({
      section,
      name: specLabel(spec),
      status: ok ? "ok" : "ng",
      note: res.ok ? (ok ? "取得できた" : "エラーはないが data が空") : formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.data,
    });
  }
  return available;
}

/** 取得できた指標をまとめて 1 回で取れるか（収集時のリクエスト数に効く） */
async function checkBatchInsights(
  graph: GraphClient,
  mediaId: string,
  section: string,
  metrics: string[],
  rec: Recorder,
): Promise<void> {
  if (metrics.length === 0) return;
  const path = `${mediaId}/insights`;
  const params: GraphParams = { metric: metrics.join(",") };
  const res = await graph.get<InsightsResponse>(path, params);
  rec.track(res);
  rec.add({
    section,
    name: "複数指標の一括取得",
    status: res.ok ? "ok" : "ng",
    note: res.ok
      ? `${metrics.length} 指標を 1 回のリクエストで取得できた`
      : formatGraphError(res.error),
    request: graph.describe(path, params),
    response: res.data,
  });
}

async function checkMediaInsights(graph: GraphClient, media: MediaSamples, rec: Recorder): Promise<void> {
  const targets: [string, MediaItem | undefined, MetricSpec[]][] = [
    ["リールの指標", media.reel, REEL_METRICS],
    ["フィード画像の指標", media.image, COMMON_MEDIA_METRICS],
    ["カルーセルの指標", media.carousel, COMMON_MEDIA_METRICS],
    ["フィード動画の指標", media.feedVideo, COMMON_MEDIA_METRICS],
  ];
  for (const [section, item, specs] of targets) {
    if (!item) {
      rec.add({ section, name: "-", status: "skip", note: "直近 50 件に該当する投稿がない" });
      continue;
    }
    const available = await checkInsightsOneByOne(graph, item.id, section, specs, rec);
    await checkBatchInsights(graph, item.id, section, available, rec);
  }
}

async function checkCarouselChildren(graph: GraphClient, media: MediaSamples, rec: Recorder): Promise<void> {
  const section = "カルーセルの子メディア";
  if (!media.carousel) {
    rec.add({ section, name: "-", status: "skip", note: "直近 50 件にカルーセルがない" });
    return;
  }
  const res = await graph.get<{ data?: MediaItem[] }>(`${media.carousel.id}/children`, {
    fields: "id,media_type,media_url",
  });
  rec.track(res);
  const child = res.data?.data?.[0];
  rec.add({
    section,
    name: "子メディア一覧",
    status: res.ok && child ? "ok" : "ng",
    note: res.ok ? "取得できた" : formatGraphError(res.error),
    response: res.data,
  });
  if (!child) return;
  const insights = await graph.get<InsightsResponse>(`${child.id}/insights`, { metric: "reach" });
  rec.track(insights);
  rec.add({
    section,
    name: "子メディアの reach",
    status: "info",
    note: insights.ok ? "取得できた（ドキュメントの記載と異なる）" : `取得できない: ${formatGraphError(insights.error)}`,
    response: insights.data,
  });
}

/** リールの動画ファイルを取得して解析できるか（R4 の前提） */
async function checkReelDownload(graph: GraphClient, media: MediaSamples, rec: Recorder): Promise<void> {
  const section = "リールの動画ファイル";
  if (!media.reel) {
    rec.add({ section, name: "-", status: "skip", note: "直近 50 件にリールがない" });
    return;
  }
  const res = await graph.get<MediaItem>(media.reel.id, { fields: "id,media_url" });
  rec.track(res);
  const mediaUrl = res.data?.media_url;
  if (!mediaUrl) {
    rec.add({
      section,
      name: "media_url",
      status: "ng",
      note: res.ok ? "media_url が返らない（著作権の判定などの可能性）" : formatGraphError(res.error),
    });
    return;
  }
  const expiry = parseCdnExpiry(mediaUrl);
  rec.add({
    section,
    name: "media_url の有効期限",
    status: "info",
    note: expiry
      ? `URL の oe パラメータから読み取った期限: 取得からあと約 ${((expiry.getTime() - Date.now()) / 3_600_000).toFixed(1)} 時間（ホスト末尾 ${hostTail(mediaUrl)}）`
      : `URL から有効期限を読み取れない（ホスト末尾 ${hostTail(mediaUrl)}）`,
  });
  await downloadAndAnalyzeVideo(mediaUrl, section, "verify-reel-", rec);
}

/** 設計 3.7 章の制限（許可ホスト、200MB、60 秒）。収集ジョブと同じ `downloadToFile` を使う */
const DOWNLOAD_LIMITS: DownloadLimits = {
  maxBytes: 200 * 1024 * 1024,
  timeoutMs: 60_000,
  allowedHosts: [...DOWNLOAD_ALLOWED_HOSTS],
};

/**
 * 動画を一時ファイルに落として ffprobe とシーン検出を行う（R0 のリールと R1-P2 のストーリーズで共用）。
 * ダウンロードの失敗は `DownloadError` の固定文言だけを記録する（URL を含まない）
 */
async function downloadAndAnalyzeVideo(url: string, section: string, tmpPrefix: string, rec: Recorder): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), tmpPrefix));
  try {
    const file = join(dir, "video.mp4");
    const started = Date.now();
    let downloaded: { bytes: number; contentType: string | undefined };
    try {
      downloaded = await downloadToFile(url, file, DOWNLOAD_LIMITS);
    } catch (error) {
      rec.add({
        section,
        name: "ダウンロード",
        status: "ng",
        note: error instanceof DownloadError ? error.message : "ダウンロードに失敗",
      });
      return;
    }
    rec.add({
      section,
      name: "ダウンロード",
      status: "ok",
      note: `成功（Content-Type ${downloaded.contentType ?? "不明"}、${(downloaded.bytes / 1_048_576).toFixed(1)} MB、${(
        (Date.now() - started) / 1000
      ).toFixed(1)} 秒）`,
    });

    const analyzeStarted = Date.now();
    const probe = await probeVideo(file);
    const cuts = await detectSceneChanges(file);
    rec.add({
      section,
      name: "ffprobe とシーン検出",
      status: "ok",
      note: `解析に成功（${((Date.now() - analyzeStarted) / 1000).toFixed(1)} 秒）。長さとカットの値は詳細 JSON に記録`,
      response: { probe, cutTimesMs: cuts },
    });
  } catch (error) {
    // ffmpeg の失敗。メッセージは stderr の末尾（一時ファイルのパス）だけで、URL は含まない
    rec.add({ section, name: "ffprobe とシーン検出", status: "ng", note: errorSummary(error) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ストーリーズ
// ---------------------------------------------------------------------------

const STORY_METRICS: MetricSpec[] = [
  { metric: "views" },
  { metric: "reach" },
  { metric: "replies" },
  { metric: "shares" },
  { metric: "reposts" },
  { metric: "total_interactions" },
  { metric: "profile_visits" },
  { metric: "profile_activity", breakdown: "action_type" },
  { metric: "follows" },
  { metric: "navigation", breakdown: "story_navigation_action_type" },
  { metric: "link_clicks" },
];

async function checkStories(graph: GraphClient, igUserId: string, rec: Recorder): Promise<void> {
  const section = "ストーリーズ";
  const res = await graph.get<{ data?: MediaItem[] }>(`${igUserId}/stories`, {
    fields: "id,media_type,media_product_type,timestamp,media_url",
  });
  rec.track(res);
  if (!res.ok) {
    rec.add({ section, name: "ストーリーズ一覧", status: "ng", note: formatGraphError(res.error) });
    return;
  }
  const story = res.data?.data?.[0];
  if (!story) {
    rec.add({
      section,
      name: "ストーリーズ一覧",
      status: "skip",
      note: "公開中のストーリーズがない。ストーリーズを投稿してから 24 時間以内に再実行すると検証できる",
    });
    return;
  }
  rec.add({ section, name: "ストーリーズ一覧", status: "ok", note: "取得できた", response: res.data });
  const available = await checkInsightsOneByOne(graph, story.id, section, STORY_METRICS, rec);
  await checkBatchInsights(graph, story.id, section, available, rec);
}

// ---------------------------------------------------------------------------
// R1 の設計書 11.1 章の確認項目（P1〜P12）
// ---------------------------------------------------------------------------

const R1_SECTION = {
  p1: "R1-P1 アカウント日次指標の一括取得",
  p2: "R1-P2 動画ストーリーズ",
  p3: "R1-P3 1 日分の since/until と end_time",
  p4: "R1-P4 内訳の 0 の区分",
  p5: "R1-P5 内訳つき指標と内訳なし指標の同居",
  p6: "R1-P6 DB と Storage",
  p7: "R1-P7 コラボ・お試しリール・ブーストの判定フィールド",
  p8: "R1-P8 ストーリーズのページング",
  p9: "R1-P9 カルーセルの親の media_url",
  p10: "R1-P10 2 年超のエラーと古い投稿",
  p11: "R1-P11 Authorization: Bearer ヘッダ",
  p12: "R1-P12 レート制限のエラーコード",
} as const;

/** R1 の確認項目を順に行う。各項目は独立して失敗できる（例外は ng の行にして次へ進む） */
async function verifyR1Items(
  graph: GraphClient,
  config: VerifyConfig,
  igUserId: string,
  media: MediaSamples,
  rec: Recorder,
): Promise<void> {
  const today = zonedDate(new Date(), PT);

  const samples =
    (await runR1Check(rec, R1_SECTION.p1, () =>
      checkR1AccountMetricGroups(graph, igUserId, addDays(today, -2), rec),
    )) ?? [];
  const stories = await runR1Check(rec, R1_SECTION.p2, () => checkR1VideoStory(graph, igUserId, rec));
  await runR1Check(rec, R1_SECTION.p3, () => checkR1DayRange(graph, igUserId, addDays(today, -3), rec));
  await runR1Check(rec, R1_SECTION.p4, async () => checkR1BreakdownZeros(samples, rec));
  await runR1Check(rec, R1_SECTION.p5, () => checkR1MixedBreakdown(graph, media, stories, rec));
  // DB の例外は固定文言（SQLSTATE か接続エラーのコードだけ）にする。メッセージは接続先を含みうる
  await runR1Check(rec, R1_SECTION.p6, () => checkR1DbAndStorage(config, rec), normalizeDbError);
  await runR1Check(rec, R1_SECTION.p7, () => checkR1MediaFlagFields(graph, media, rec));
  await runR1Check(rec, R1_SECTION.p8, async () => checkR1StoriesPaging(stories, rec));
  await runR1Check(rec, R1_SECTION.p9, async () => checkR1CarouselParentUrl(media, rec));
  await runR1Check(rec, R1_SECTION.p10, () => checkR1HistoryLimits(graph, igUserId, today, rec));
  await runR1Check(rec, R1_SECTION.p11, () => checkR1BearerHeader(graph, config, igUserId, rec));
  rec.add({
    section: R1_SECTION.p12,
    name: "Business Use Case のレート制限のコード",
    status: "info",
    note: "意図的には当てられない。バックフィル中に rate で止まった job_runs の記録でコードを確かめる（設計 1.4 章の 80000〜80009 の範囲を確定する）",
  });
}

/** 1 つの確認項目を独立して実行する。例外は ng の行（固定文言）にして次へ進む */
async function runR1Check<T>(
  rec: Recorder,
  section: string,
  run: () => Promise<T>,
  describeError: (error: unknown) => string = errorSummary,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    rec.add({ section, name: "例外", status: "ng", note: `処理を中断した: ${describeError(error)}` });
    return undefined;
  }
}

/** 例外のメッセージ。URL を含みうるものは固定文言にする（stack、cause は参照しない） */
function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "不明なエラー";
  return /https?:\/\//i.test(message) ? "エラーメッセージに URL が含まれるため省略" : message;
}

/** ホスト名の末尾 2 ラベル（例 cdninstagram.com、fbcdn.net）。許可リストの確定に使う。完全なホスト名は response にだけ入れる */
export function hostTail(url: string | undefined): string {
  const host = fullHost(url);
  if (!host) return "なし";
  return host.split(".").slice(-2).join(".");
}

function fullHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function uniqueHostTails(urls: (string | undefined)[]): string {
  const tails = [...new Set(urls.filter((u) => u !== undefined).map(hostTail))];
  return tails.join(", ") || "なし";
}

/** 完全なホスト名の一覧（詳細 JSON 用。`media_url` などのキー名を使わず、URL 自体も残さない） */
function uniqueFullHosts(urls: (string | undefined)[]): string[] {
  return [...new Set(urls.map(fullHost).filter((h): h is string => h !== undefined))];
}

function utcIso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// --- P1: アカウント日次指標の複数指標の一括取得（設計 5.2 章の 4 グループ） ---

interface AccountMetricGroup {
  breakdown?: string;
  metrics: string[];
}

const R1_ACCOUNT_METRIC_GROUPS: AccountMetricGroup[] = [
  {
    metrics: [
      "reach",
      "views",
      "accounts_engaged",
      "total_interactions",
      "likes",
      "comments",
      "shares",
      "saves",
      "replies",
      "reposts",
      "follows_and_unfollows",
      "profile_links_taps",
    ],
  },
  { breakdown: "follow_type", metrics: ["reach", "views", "follows_and_unfollows"] },
  { breakdown: "media_product_type", metrics: ["reach", "views", "total_interactions"] },
  { breakdown: "contact_button_type", metrics: ["profile_links_taps"] },
];

/** 内訳つきのレスポンス（P4 で 0 の区分を見るために P1 から渡す） */
interface BreakdownSample {
  breakdown: string;
  data: InsightsResponse;
}

async function checkR1AccountMetricGroups(
  graph: GraphClient,
  igUserId: string,
  date: string,
  rec: Recorder,
): Promise<BreakdownSample[]> {
  const section = R1_SECTION.p1;
  const path = `${igUserId}/insights`;
  const { since, until } = pacificDayRange(date);
  const samples: BreakdownSample[] = [];
  rec.add({
    section,
    name: "対象の日",
    status: "info",
    note: `PT の D−2（${date}）。since = PT 0 時（UTC ${utcIso(since)}）、until = 翌日 PT 0 時 − 1 秒（UTC ${utcIso(until)}）`,
  });

  for (const group of R1_ACCOUNT_METRIC_GROUPS) {
    const label = group.breakdown ? `breakdown=${group.breakdown}` : "内訳なし";
    const name = `${label}（${group.metrics.length} 指標を 1 リクエスト）`;
    const params: GraphParams = {
      metric: group.metrics.join(","),
      period: "day",
      metric_type: "total_value",
      breakdown: group.breakdown,
      since,
      until,
    };
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    if (res.ok) {
      const returned = (res.data?.data ?? []).map((item) => item.name);
      const missing = group.metrics.filter((m) => !returned.includes(m));
      if (group.breakdown && res.data) samples.push({ breakdown: group.breakdown, data: res.data });
      rec.add({
        section,
        name,
        status: missing.length === 0 ? "ok" : "info",
        note: `返った指標 ${returned.length} / 要求 ${group.metrics.length}${
          missing.length ? `。返らなかった指標: ${missing.join(", ")}` : ""
        }`,
        request: graph.describe(path, params),
        response: res.data,
      });
      continue;
    }
    rec.add({
      section,
      name,
      status: "ng",
      note: formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.error,
    });

    // まとめて取れなかったグループは 1 指標ずつ試し、単独でも取れない指標を特定する
    const failed: string[] = [];
    for (const metric of group.metrics) {
      const single: GraphParams = { ...params, metric };
      const one = await graph.get<InsightsResponse>(path, single);
      rec.track(one);
      const got = one.ok && (one.data?.data?.length ?? 0) > 0;
      if (!got) failed.push(metric);
      else if (group.breakdown && one.data) samples.push({ breakdown: group.breakdown, data: one.data });
      rec.add({
        section,
        name: `${label} / ${metric}（単独）`,
        status: got ? "ok" : "ng",
        note: one.ok ? (got ? "取得できた" : "エラーはないが data が空") : formatGraphError(one.error),
        request: graph.describe(path, single),
        response: one.data ?? one.error,
      });
    }
    rec.add({
      section,
      name: `${label} の結論`,
      status: "info",
      note: failed.length
        ? `単独でも取れない指標: ${failed.join(", ")}（このグループから外す）`
        : "すべての指標が単独では取れる（まとめ方の問題。このグループは 1 指標 1 リクエストにする）",
    });
  }
  return samples;
}

// --- P4: 内訳つきレスポンスに値が 0 の区分が含まれるか ---

interface BreakdownResult {
  dimension_values?: string[];
  value?: number;
}

function checkR1BreakdownZeros(samples: BreakdownSample[], rec: Recorder): void {
  const section = R1_SECTION.p4;
  if (samples.length === 0) {
    rec.add({ section, name: "-", status: "skip", note: "P1 で内訳つきのレスポンスが得られなかった" });
    return;
  }
  for (const sample of samples) {
    for (const item of sample.data.data ?? []) {
      const results = (item.total_value?.breakdowns?.[0]?.results ?? []) as BreakdownResult[];
      const zeros = results.filter((r) => r.value === 0).length;
      const dims = results.map((r) => (r.dimension_values ?? []).join("/"));
      rec.add({
        section,
        name: `${item.name}（breakdown=${sample.breakdown}）`,
        status: "info",
        note: `results ${results.length} 件、value が 0 の区分 ${zeros} 件。区分: ${dims.join(", ") || "なし"}。total_value.value ${
          item.total_value?.value !== undefined ? "あり" : "なし"
        }`,
      });
    }
  }
}

// --- P2: 動画ストーリーズのダウンロードと解析、URL のホスト名（P5、P8 でも一覧を使う） ---

interface StoriesList {
  items: MediaItem[];
  paging: GraphPaging | undefined;
}

async function checkR1VideoStory(
  graph: GraphClient,
  igUserId: string,
  rec: Recorder,
): Promise<StoriesList | undefined> {
  const section = R1_SECTION.p2;
  const path = `${igUserId}/stories`;
  const params: GraphParams = { fields: "id,media_type,media_product_type,timestamp,media_url,thumbnail_url" };
  const res = await graph.get<{ data?: MediaItem[]; paging?: GraphPaging }>(path, params);
  rec.track(res);
  if (!res.ok) {
    rec.add({
      section,
      name: "ストーリーズ一覧",
      status: "ng",
      note: formatGraphError(res.error),
      request: graph.describe(path, params),
      response: res.error,
    });
    return undefined;
  }
  const items = res.data?.data ?? [];
  const list: StoriesList = { items, paging: res.data?.paging };
  if (items.length === 0) {
    rec.add({
      section,
      name: "ストーリーズ一覧",
      status: "skip",
      note: "公開中のストーリーズがない。動画ストーリーズを投稿してから 24 時間以内に再実行する",
      request: graph.describe(path, params),
    });
    return list;
  }
  const videos = items.filter((m) => m.media_type === "VIDEO");
  const images = items.filter((m) => m.media_type === "IMAGE");
  rec.add({
    section,
    name: "ストーリーズ一覧",
    status: "ok",
    note: `公開中 ${items.length} 件（VIDEO ${videos.length}、IMAGE ${images.length}）。media_url のホスト末尾: ${uniqueHostTails(
      items.map((m) => m.media_url),
    )}。thumbnail_url のホスト末尾: ${uniqueHostTails(items.map((m) => m.thumbnail_url))}。thumbnail_url がある件数 ${
      items.filter((m) => m.thumbnail_url).length
    }`,
    request: graph.describe(path, params),
    // URL 自体は保存時に落ちるので、許可リストの確認用にホスト名だけを別のキーで残す
    response: {
      ...res.data,
      mediaUrlHosts: uniqueFullHosts(items.map((m) => m.media_url)),
      thumbnailUrlHosts: uniqueFullHosts(items.map((m) => m.thumbnail_url)),
    },
  });

  const video = videos[0];
  if (!video) {
    rec.add({
      section,
      name: "動画のダウンロードと解析",
      status: "skip",
      note: "画像ストーリーズしかない。動画ストーリーズを投稿してから再実行する",
    });
    return list;
  }
  const expiry = parseCdnExpiry(video.media_url ?? "");
  rec.add({
    section,
    name: "動画ストーリーズの URL",
    status: video.media_url ? "ok" : "ng",
    note: `media_url ${video.media_url ? `あり（ホスト末尾 ${hostTail(video.media_url)}）` : "なし"}、thumbnail_url ${
      video.thumbnail_url ? `あり（ホスト末尾 ${hostTail(video.thumbnail_url)}）` : "なし"
    }${
      expiry
        ? `。media_url の oe から読んだ期限: 取得からあと約 ${((expiry.getTime() - Date.now()) / 3_600_000).toFixed(1)} 時間`
        : ""
    }`,
  });
  if (video.media_url) {
    await downloadAndAnalyzeVideo(video.media_url, section, "verify-story-", rec);
  }
  return list;
}

// --- P3: 1 日分の since/until の指定と end_time の対応 ---

/** end_time を PT の日付にし、対象日との関係（同日、翌日、前日）を添える。時刻の文字列は値ではないので note に出してよい */
export function describeEndTime(endTime: string | undefined, targetDate: string): string {
  if (!endTime) return "end_time なし";
  let ptDate: string;
  try {
    ptDate = metricDateFromEndTime(endTime);
  } catch {
    return `${endTime}（解釈できない）`;
  }
  const relation =
    ptDate === targetDate
      ? "対象日と同日"
      : ptDate === addDays(targetDate, 1)
        ? "対象日の翌日"
        : ptDate === addDays(targetDate, -1)
          ? "対象日の前日"
          : "対象日と離れている";
  return `${endTime}（PT ${ptDate}、${relation}）`;
}

async function checkR1DayRange(graph: GraphClient, igUserId: string, date: string, rec: Recorder): Promise<void> {
  const section = R1_SECTION.p3;
  const path = `${igUserId}/insights`;
  // (a)(b) は収集ジョブと同じ pacificDayRange。(c)(d) はその比較対象
  const range = pacificDayRange(date);
  const dayStart = range.since;
  const nextStart = Math.floor(zonedMidnightUtc(addDays(date, 1), PT).getTime() / 1000);
  rec.add({
    section,
    name: "対象の日",
    status: "info",
    note: `PT の D−3（${date}）。PT 0 時 = UTC ${utcIso(dayStart)}、翌日 PT 0 時 = UTC ${utcIso(nextStart)}（差 ${
      nextStart - dayStart
    } 秒）`,
  });

  // (e) since = until = 当日 PT 12 時 は 2026-10-01 の実機確認で 0 件と分かったので外した
  const cases: { label: string; metricType: "total_value" | "time_series"; since: number; until: number }[] = [
    { label: "(a) total_value、pacificDayRange（until = 翌日 PT 0 時 − 1 秒）", metricType: "total_value", since: range.since, until: range.until },
    { label: "(b) time_series、pacificDayRange（until = 翌日 PT 0 時 − 1 秒）", metricType: "time_series", since: range.since, until: range.until },
    { label: "(c) time_series、until = 翌日 PT 0 時ちょうど", metricType: "time_series", since: dayStart, until: nextStart },
    { label: "(d) time_series、until = since + 86399", metricType: "time_series", since: dayStart, until: dayStart + 86_399 },
  ];

  let totalValue: number | undefined;
  let seriesB: InsightValue[] | undefined;
  for (const c of cases) {
    const params: GraphParams = { metric: "reach", period: "day", metric_type: c.metricType, since: c.since, until: c.until };
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    const item = res.data?.data?.[0];
    if (!res.ok) {
      rec.add({ section, name: c.label, status: "ng", note: formatGraphError(res.error), request: graph.describe(path, params), response: res.error });
      continue;
    }
    if (c.metricType === "total_value") {
      totalValue = item?.total_value?.value;
      rec.add({
        section,
        name: c.label,
        status: totalValue !== undefined ? "ok" : "ng",
        note: totalValue !== undefined ? "total_value が返った" : "エラーはないが total_value.value がない",
        request: graph.describe(path, params),
        response: res.data,
      });
      continue;
    }
    const values = item?.values ?? [];
    if (c.label.startsWith("(b)")) seriesB = values;
    const matchIndexes = values
      .map((v, i) => (totalValue !== undefined && v.value === totalValue ? i + 1 : undefined))
      .filter((n): n is number => n !== undefined);
    rec.add({
      section,
      name: c.label,
      status: values.length === 1 ? "ok" : "info",
      note: `values ${values.length} 件。end_time: ${values.map((v) => describeEndTime(v.end_time, date)).join("、") || "なし"}${
        totalValue !== undefined
          ? `。(a) の total_value と一致する要素: ${matchIndexes.length ? matchIndexes.map((n) => `${n} 件目`).join(", ") : "なし"}`
          : ""
      }`,
      request: graph.describe(path, params),
      response: res.data,
    });
  }

  // 結論: pacificDayRange で 1 日分だけ返るか、metricDateFromEndTime（end_time の PT 日付 = 指標の日付）が合うか
  const endOfB = seriesB?.[0]?.end_time;
  let endDate: string | undefined;
  try {
    endDate = endOfB ? metricDateFromEndTime(endOfB) : undefined;
  } catch {
    endDate = undefined;
  }
  const rule =
    endDate === undefined
      ? "end_time が得られず metricDateFromEndTime の判定はできない"
      : endDate === date
        ? "metricDateFromEndTime(end_time) = 対象日（実装どおり）"
        : addDays(endDate, -1) === date
          ? "metricDateFromEndTime(end_time) が対象日の翌日になる（実装と異なる。前日に直す）"
          : `metricDateFromEndTime(end_time)（${endDate}）が対象日（${date}）とも翌日とも一致しない`;
  rec.add({
    section,
    name: "結論",
    status: endDate === undefined ? "skip" : "info",
    note: `(b) で 1 日分だけ返る: ${seriesB?.length === 1 ? "はい" : "いいえ"}。${rule}`,
  });
}

// --- P5: 内訳つき指標を内訳なし指標と同じリクエストに入れられるか ---

function describeInsightShape(item: InsightItem): string {
  const parts: string[] = [];
  if (item.values) parts.push(`values ${item.values.length} 件`);
  if (item.total_value) {
    const breakdowns = item.total_value.breakdowns ?? [];
    parts.push(
      breakdowns.length
        ? `total_value（breakdowns ${breakdowns.length} 組、results ${breakdowns[0]?.results?.length ?? 0} 区分）`
        : "total_value（内訳なし）",
    );
  }
  return parts.join("、") || "values も total_value もなし";
}

async function checkR1MixedBreakdown(
  graph: GraphClient,
  media: MediaSamples,
  stories: StoriesList | undefined,
  rec: Recorder,
): Promise<void> {
  const section = R1_SECTION.p5;
  const feed = media.all.find((m) => m.media_product_type === "FEED");
  const targets: { label: string; item: MediaItem | undefined; params: GraphParams; skipNote: string }[] = [
    {
      label: "フィード投稿",
      item: feed,
      params: { metric: "views,reach,profile_activity", breakdown: "action_type" },
      skipNote: "直近 50 件にフィード投稿がない",
    },
    {
      label: "ストーリーズ",
      item: stories?.items[0],
      params: { metric: "views,reach,navigation", breakdown: "story_navigation_action_type" },
      skipNote: "公開中のストーリーズがない",
    },
  ];
  for (const t of targets) {
    const name = `${t.label}: metric=${t.params["metric"]}&breakdown=${t.params["breakdown"]}`;
    if (!t.item) {
      rec.add({ section, name, status: "skip", note: t.skipNote });
      continue;
    }
    const path = `${t.item.id}/insights`;
    const res = await graph.get<InsightsResponse>(path, t.params);
    rec.track(res);
    if (!res.ok) {
      rec.add({
        section,
        name,
        status: "ng",
        note: `${formatGraphError(res.error)}（設計 5.5 章、5.6 章のとおり内訳つきは別リクエストにする）`,
        request: graph.describe(path, t.params),
        response: res.error,
      });
      continue;
    }
    const shapes = (res.data?.data ?? []).map((item) => `${item.name}: ${describeInsightShape(item)}`);
    rec.add({
      section,
      name,
      status: "ok",
      note: `1 リクエストで取得できた。返った指標の形: ${shapes.join("; ") || "data が空"}`,
      request: graph.describe(path, t.params),
      response: res.data,
    });
  }
}

// --- P6: DB（postgres ロール、サーバーログの設定、Vault）と Storage ---

async function checkR1DbAndStorage(config: VerifyConfig, rec: Recorder): Promise<void> {
  const section = R1_SECTION.p6;
  if (config.databaseUrl) {
    await checkR1Database(config.databaseUrl, section, rec);
  } else {
    rec.add({ section, name: "DB", status: "skip", note: "DATABASE_URL が未設定" });
  }
  if (config.supabaseUrl && config.supabaseServiceRoleKey) {
    await checkR1Storage(config.supabaseUrl, config.supabaseServiceRoleKey, section, rec);
  } else {
    rec.add({ section, name: "Storage", status: "skip", note: "SUPABASE_URL か SUPABASE_SERVICE_ROLE_KEY が未設定" });
  }
}

interface DbStepResult {
  status?: Status;
  note: string;
  response?: unknown;
}

async function checkR1Database(databaseUrl: string, section: string, rec: Recorder): Promise<void> {
  // 収集ジョブと同じ接続設定（db/client.ts）。接続文字列はログに出さない
  const sql = connectDb(databaseUrl);

  /** 1 つの SQL の確認。失敗は `normalizeDbError` の固定文言（SQLSTATE か接続エラーのコード）だけを記録する */
  const step = async (name: string, run: () => Promise<DbStepResult>): Promise<boolean> => {
    try {
      const r = await run();
      rec.add({ section, name, status: r.status ?? "ok", note: r.note, response: r.response });
      return true;
    } catch (error) {
      rec.add({ section, name, status: "ng", note: normalizeDbError(error) });
      return false;
    }
  };

  try {
    // ロール名は出さず、設計 3.1 章の前提（postgres ロール）に合うかだけを記す
    const connected = await step("DB: 接続（current_user が postgres か）", async () => {
      const [row] = await sql<{ current_user: string }[]>`select current_user`;
      return { note: row?.current_user === "postgres" ? "接続できた。はい" : "接続できた。いいえ" };
    });
    if (!connected) return;

    await step("DB: スーパーユーザーか", async () => {
      const [row] = await sql<{ rolsuper: boolean }[]>`select rolsuper from pg_roles where rolname = current_user`;
      return { status: "info", note: `rolsuper = ${row?.rolsuper ?? "不明"}` };
    });

    for (const setting of ["log_statement", "log_parameter_max_length_on_error", "log_min_error_statement"]) {
      await step(`DB: 設定 ${setting}`, async () => {
        const [row] = await sql<{ value: string | null }[]>`select current_setting(${setting}, true) as value`;
        return { status: "info", note: `${setting} = ${row?.value ?? "（取得できない）"}` };
      });
    }

    await step("DB: vault.secrets の索引", async () => {
      const rows = await sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes
        where schemaname = 'vault' and tablename = 'secrets'
        order by indexname`;
      const nameIdx = rows.find((r) => r.indexname === "secrets_name_idx");
      const summary = rows.map((r) => `${r.indexname}（${/\bunique\b/i.test(r.indexdef) ? "一意" : "一意でない"}）`).join(", ");
      return {
        status: "info",
        note: `secrets_name_idx ${nameIdx ? (/\bunique\b/i.test(nameIdx.indexdef) ? "あり（一意）" : "あり（一意でない）") : "なし"}。索引の一覧: ${
          summary || "なし"
        }`,
        response: rows,
      };
    });

    // Vault の往復: 作成 → 復号 → 更新 → 復号 → 削除。秘密の値は乱数で、note には出さない
    const name = `verify-p6-${randomUUID()}`;
    const secret1 = `verify-p6-secret-${randomUUID()}`;
    const secret2 = `verify-p6-secret-${randomUUID()}`;
    let secretId: string | undefined;
    try {
      await step("Vault: create_secret", async () => {
        const [row] = await sql<{ id: string }[]>`
          select vault.create_secret(${secret1}, ${name}, 'verify-api P6 の往復確認（残っていれば削除してよい）') as id`;
        secretId = row?.id;
        return { status: secretId ? "ok" : "ng", note: secretId ? "作成できた" : "エラーはないが id が返らない" };
      });
      const id = secretId;
      if (id) {
        await step("Vault: decrypted_secrets で復号", async () => {
          const [row] = await sql<{ decrypted_secret: string | null }[]>`
            select decrypted_secret from vault.decrypted_secrets where id = ${id}`;
          const match = row?.decrypted_secret === secret1;
          return { status: match ? "ok" : "ng", note: match ? "復号した値が一致" : row ? "復号した値が一致しない" : "行が見つからない" };
        });
        await step("Vault: update_secret と再復号", async () => {
          await sql`select vault.update_secret(${id}, ${secret2})`;
          const [row] = await sql<{ decrypted_secret: string | null }[]>`
            select decrypted_secret from vault.decrypted_secrets where id = ${id}`;
          const match = row?.decrypted_secret === secret2;
          return { status: match ? "ok" : "ng", note: match ? "更新後の復号した値が一致" : "更新後の値が一致しない" };
        });
      }
    } finally {
      await step("Vault: 削除", async () => {
        const result = await sql`delete from vault.secrets where name = ${name}`;
        // 作成に失敗していれば削除対象がないのが正常
        const status: Status = result.count === 1 ? "ok" : secretId ? "ng" : "info";
        return { status, note: `削除した行数 ${result.count}${secretId ? "" : "（作成できていないため対象なし）"}` };
      });
    }

    // 設計 3.5 章: db/client.ts の types 設定で date が YYYY-MM-DD の文字列で返ること（既定では Date（UTC 0 時）になる）
    await step("DB: date 型の変換（db/client.ts の types 設定）", async () => {
      const [row] = await sql<{ d: unknown }[]>`select '2026-10-01'::date as d`;
      const v = row?.d;
      const ok = v === "2026-10-01";
      const kind = v instanceof Date ? `Date（${v.toISOString()}）` : `${typeof v}（${typeof v === "string" ? v : "値の表示を省略"}）`;
      return {
        status: ok ? "ok" : "ng",
        note: `select '2026-10-01'::date の JS での型: ${kind}${ok ? "" : "（文字列 2026-10-01 を期待）"}`,
      };
    });
  } finally {
    try {
      await closeDb(sql);
    } catch {
      // 切断の失敗は検証結果に影響しない
    }
  }
}

async function checkR1Storage(supabaseUrl: string, serviceRoleKey: string, section: string, rec: Recorder): Promise<void> {
  const base = supabaseUrl.replace(/\/+$/, "");
  const objectPath = `thumbnails/verify/p6-${randomUUID()}.txt`;
  const authHeaders = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };
  const body = "verify-p6";

  /** Storage REST を 1 回呼ぶ。接続の失敗はホスト名を含みうるので固定文言にする */
  const call = async (
    name: string,
    method: "POST" | "GET" | "DELETE",
    path: string,
    extra?: { body?: string; headers?: Record<string, string> },
  ): Promise<Response | undefined> => {
    try {
      return await fetch(`${base}/storage/v1/object/${path}`, {
        method,
        headers: { ...authHeaders, ...extra?.headers },
        body: extra?.body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      rec.add({
        section,
        name,
        status: "ng",
        note: `Storage への接続に失敗（${error instanceof Error ? error.name : "不明"}。ホスト名を含みうるためメッセージは省略）`,
      });
      return undefined;
    }
  };

  const uploadHeaders = { "x-upsert": "true", "Content-Type": "text/plain" };
  const uploads = [
    ["Storage: アップロード", "1 回目"],
    ["Storage: 上書き", "2 回目（同じパスに x-upsert: true）"],
  ] as const;
  // 1 回目のアップロード以降で例外になっても、finally の DELETE でオブジェクトを残さない
  let uploaded = false;
  try {
    for (const [name, label] of uploads) {
      const res = await call(name, "POST", objectPath, { body, headers: uploadHeaders });
      if (!res) return;
      if (res.ok) uploaded = true;
      rec.add({
        section,
        name,
        status: res.ok ? "ok" : "ng",
        note: `${label}: HTTP ${res.status}`,
        response: { status: res.status, body: await res.text().catch(() => "") },
      });
    }

    const read = await call("Storage: 読み出し", "GET", `authenticated/${objectPath}`);
    if (read) {
      const text = await read.text().catch(() => "");
      const match = read.ok && text === body;
      rec.add({
        section,
        name: "Storage: 読み出し",
        status: match ? "ok" : "ng",
        note: `authenticated 経由: HTTP ${read.status}、本文が一致: ${match ? "はい" : "いいえ"}`,
        response: { status: read.status, body: read.ok ? undefined : text },
      });
    }
  } finally {
    const del = await call("Storage: 削除", "DELETE", objectPath);
    if (del) {
      rec.add({
        section,
        name: "Storage: 削除",
        // アップロードできていなければ 404 が正常
        status: del.ok ? "ok" : uploaded ? "ng" : "info",
        note: `HTTP ${del.status}${uploaded ? "" : "（アップロードできていないため対象なし）"}`,
        response: { status: del.status, body: await del.text().catch(() => "") },
      });
    }
  }
}

// --- P7: コラボ、お試しリール、ブーストを判定できるフィールド ---

const R1_MEDIA_FLAG_FIELDS = [
  "boost_ads_list",
  "boost_eligibility_info",
  "is_shared_to_feed",
  "owner",
  "username",
  "is_comment_enabled",
  "copyright_check_information",
  "legacy_instagram_media_id",
  "collaborators",
  "is_trial",
];

async function checkR1MediaFlagFields(graph: GraphClient, media: MediaSamples, rec: Recorder): Promise<void> {
  const section = R1_SECTION.p7;
  const target = media.reel ?? media.all[0];
  if (!target) {
    rec.add({ section, name: "-", status: "skip", note: "投稿がない" });
    return;
  }
  const label = target === media.reel ? "リール" : "投稿";
  await checkFieldsOneByOne(graph, target.id, label, section, R1_MEDIA_FLAG_FIELDS, rec);
}

// --- P8: ストーリーズ一覧のページング ---

function checkR1StoriesPaging(stories: StoriesList | undefined, rec: Recorder): void {
  const section = R1_SECTION.p8;
  if (!stories) {
    rec.add({ section, name: "paging", status: "skip", note: "P2 でストーリーズ一覧を取得できなかった" });
    return;
  }
  const paging = stories.paging;
  rec.add({
    section,
    name: "paging",
    status: stories.items.length === 0 ? "skip" : "info",
    note: `一覧 ${stories.items.length} 件。paging ${paging ? "あり" : "なし"}、cursors.after ${paging?.cursors?.after ? "あり" : "なし"}、next ${
      paging?.next ? "あり" : "なし"
    }${stories.items.length === 0 ? "（一覧が空なので判定できない）" : ""}`,
    response: paging ? { keys: Object.keys(paging), cursorKeys: Object.keys(paging.cursors ?? {}) } : undefined,
  });
}

// --- P9: カルーセルの親に media_url が返るか（サムネイルの元） ---

function checkR1CarouselParentUrl(media: MediaSamples, rec: Recorder): void {
  const section = R1_SECTION.p9;
  const carousel = media.carousel;
  if (!carousel) {
    rec.add({ section, name: "-", status: "skip", note: "直近 50 件にカルーセルがない。カルーセルを投稿してから再実行する" });
    return;
  }
  rec.add({
    section,
    name: "親の media_url と thumbnail_url",
    status: carousel.media_url ? "ok" : "info",
    note: `media_url ${carousel.media_url ? `あり（ホスト末尾 ${hostTail(carousel.media_url)}）` : "なし"}、thumbnail_url ${
      carousel.thumbnail_url ? `あり（ホスト末尾 ${hostTail(carousel.thumbnail_url)}）` : "なし"
    }。${carousel.media_url ? "親の media_url をサムネイルの元に使える" : "children の先頭の media_url を使う（1 件につき 1 リクエスト増）"}`,
    // URL 自体は保存時に落ちるので、ホスト名だけを別のキーで残す
    response: {
      media_type: carousel.media_type,
      media_product_type: carousel.media_product_type,
      mediaUrlHost: fullHost(carousel.media_url),
      thumbnailUrlHost: fullHost(carousel.thumbnail_url),
    },
  });
}

// --- P10: 2 年超の日付のエラーと、最も古い投稿の指標 ---

/** エラーの code、error_subcode、type、メッセージ（API の定型文なので note に出してよい） */
function describeGraphErrorDetail(error: GraphError | undefined): string {
  if (!error) return "エラーの詳細なし";
  return `code=${error.code ?? "なし"}、error_subcode=${error.error_subcode ?? "なし"}、type=${error.type ?? "なし"}、message=${error.message}`;
}

async function checkR1HistoryLimits(graph: GraphClient, igUserId: string, today: string, rec: Recorder): Promise<void> {
  const section = R1_SECTION.p10;
  const path = `${igUserId}/insights`;
  const date = addDays(today, -800);
  const { since, until } = pacificDayRange(date);
  for (const metric of ["reach", "views"]) {
    const params: GraphParams = { metric, period: "day", metric_type: "total_value", since, until };
    const res = await graph.get<InsightsResponse>(path, params);
    rec.track(res);
    rec.add({
      section,
      name: `${metric} の D−800（${date}）の 1 日分`,
      status: "info",
      note: res.ok ? "エラーにならず取得できた（2 年の制限に当たらない）" : describeGraphErrorDetail(res.error),
      request: graph.describe(path, params),
      response: res.data ?? res.error,
    });
  }

  const oldest = await findOldestMedia(graph, igUserId, section, rec);
  if (!oldest) return;
  const insightsPath = `${oldest.id}/insights`;
  const params: GraphParams = { metric: "views,reach" };
  const res = await graph.get<InsightsResponse>(insightsPath, params);
  rec.track(res);
  rec.add({
    section,
    name: "最も古い投稿の insights?metric=views,reach",
    status: res.ok ? "ok" : "ng",
    note: res.ok
      ? `取得できた（返った指標 ${(res.data?.data ?? []).map((i) => i.name).join(", ") || "なし"}）`
      : describeGraphErrorDetail(res.error),
    request: graph.describe(insightsPath, params),
    response: res.data ?? res.error,
  });
}

/** メディア一覧を limit=100 で最大 15 ページ追い、最も古い投稿を探す。note には年月だけを出す */
async function findOldestMedia(
  graph: GraphClient,
  igUserId: string,
  section: string,
  rec: Recorder,
): Promise<MediaItem | undefined> {
  const path = `${igUserId}/media`;
  const fields = "id,media_type,media_product_type,timestamp";
  const maxPages = 15;
  let after: string | undefined;
  let pages = 0;
  let total = 0;
  let oldest: MediaItem | undefined;
  let hasMore = false;
  let failed = false;
  const types = new Map<string, number>();

  while (pages < maxPages) {
    const params: GraphParams = { fields, limit: 100, after };
    const res = await graph.get<{ data?: MediaItem[]; paging?: GraphPaging }>(path, params);
    rec.track(res);
    if (!res.ok) {
      rec.add({
        section,
        name: `メディア一覧 ${pages + 1} ページ目`,
        status: "ng",
        note: formatGraphError(res.error),
        request: graph.describe(path, { fields, limit: 100, after: after ? "<cursor>" : undefined }),
        response: res.error,
      });
      failed = true;
      break;
    }
    pages++;
    const items = res.data?.data ?? [];
    total += items.length;
    for (const item of items) {
      const key = `${item.media_product_type}/${item.media_type}`;
      types.set(key, (types.get(key) ?? 0) + 1);
      if (item.timestamp && (!oldest?.timestamp || item.timestamp < oldest.timestamp)) oldest = item;
    }
    // 次ページの有無は paging.next の存在で見るが、URL は使わない（トークンが含まれる）。カーソルだけを使う
    after = res.data?.paging?.cursors?.after;
    hasMore = Boolean(res.data?.paging?.next) && Boolean(after) && items.length > 0;
    if (!hasMore) break;
  }

  // `+0000` の形は環境によって解釈が揺れるので `+00:00` にそろえる（lib/time.ts の metricDateFromEndTime と同じ）
  const oldestAt = oldest?.timestamp ? new Date(oldest.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : undefined;
  const ageDays =
    oldestAt && !Number.isNaN(oldestAt.getTime()) ? Math.floor((Date.now() - oldestAt.getTime()) / 86_400_000) : undefined;
  rec.add({
    section,
    name: "メディア一覧の全ページ",
    status: failed ? "ng" : "info",
    // 年月と種類別の件数は詳細 JSON にだけ残す
    note: `${pages} ページ、${total} 件${hasMore ? `（${maxPages} ページで打ち切り。さらに古い投稿がある）` : "（最後まで読んだ）"}。最も古い投稿: ${
      oldest ? `約 ${ageDays ?? "?"} 日前（2 年超: ${ageDays !== undefined && ageDays > 730 ? "はい" : "いいえ"}）` : "なし"
    }`,
    response: {
      pages,
      total,
      reachedEnd: !hasMore && !failed,
      types: Object.fromEntries(types),
      oldestMonth: oldest?.timestamp?.slice(0, 7),
      oldestType: oldest ? `${oldest.media_product_type}/${oldest.media_type}` : undefined,
      oldest,
    },
  });
  return oldest;
}

// --- P11: access_token をクエリでなく Authorization: Bearer ヘッダで送る ---

async function checkR1BearerHeader(
  graph: GraphClient,
  config: MetaConfig,
  igUserId: string,
  rec: Recorder,
): Promise<void> {
  const section = R1_SECTION.p11;
  const name = "クエリに access_token を付けず Bearer ヘッダだけで GET {ig_user_id}?fields=id";
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${encodeURIComponent(igUserId)}?fields=id`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    rec.add({ section, name, status: "ng", note: `接続に失敗（${error instanceof Error ? error.name : "不明"}）` });
    return;
  }
  const body = (await res.json().catch(() => undefined)) as { id?: string; error?: GraphError } | undefined;
  const matched = body?.id === igUserId;
  rec.add({
    section,
    name,
    status: res.ok && !body?.error && matched ? "ok" : "ng",
    note: `HTTP ${res.status}、エラー ${body?.error ? formatGraphError(body.error) : "なし"}、id が IG_USER_ID と一致: ${matched ? "はい" : "いいえ"}`,
    request: graph.describe(igUserId, { fields: "id" }),
    response: body,
  });
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

/** レート制限ヘッダから、ID を除いた使用率だけを取り出す */
function usagePercentages(header: unknown): string {
  if (!header || typeof header !== "object") return "ヘッダなし";
  const collect = (obj: Record<string, unknown>): string =>
    ["call_count", "total_cputime", "total_time"]
      .filter((k) => typeof obj[k] === "number")
      .map((k) => `${k} ${obj[k]}%`)
      .join("、");
  const direct = collect(header as Record<string, unknown>);
  if (direct) return direct;
  const nested = Object.values(header as Record<string, unknown>).flatMap((v) =>
    Array.isArray(v) ? v : [],
  );
  const first = nested[0];
  return first && typeof first === "object" ? collect(first as Record<string, unknown>) : "形式不明";
}

function recordRateLimit(rec: Recorder): void {
  const limit = rec.rateLimit;
  rec.add({
    section: "レート制限",
    name: "最後のレスポンスのヘッダ",
    status: limit ? "info" : "skip",
    note: limit
      ? `X-Business-Use-Case-Usage: ${usagePercentages(limit.businessUseCaseUsage)}／X-App-Usage: ${usagePercentages(limit.appUsage)}`
      : "レート制限のヘッダが得られなかった",
  });
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function writeOutputs(
  config: MetaConfig,
  rec: Recorder,
  startedAt: Date,
  fileSecrets: SecretRegistry,
): Promise<{ json: string; markdown: string }> {
  const dir = join(outputDir(), "api-verification");
  await mkdir(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const json = join(dir, `verify-api-${stamp}.json`);
  const markdown = join(dir, `verify-api-${stamp}.md`);

  // 詳細 JSON: 各 response から期限付き URL、paging.next/previous、access_token を落とし（収集ジョブの生レスポンスと同じ）、
  // 文字列化した全体からトークン・アプリシークレット・サービスロールキーをマスクする
  const results = rec.results.map((r) =>
    r.response === undefined ? r : { ...r, response: stripVolatileFields(r.response) },
  );
  const text = JSON.stringify(
    { executedAt: startedAt.toISOString(), graphApiVersion: config.graphApiVersion, results },
    null,
    2,
  );
  await writeFile(json, fileSecrets.mask(text));

  const lines = [
    "# Meta API 検証結果（要約）",
    "",
    `- 実行日時: ${startedAt.toISOString()}`,
    `- Graph API バージョン: ${config.graphApiVersion}`,
    "- この要約には ID や指標の値を含めていない。詳細は同じフォルダの JSON（Git 管理外）を参照",
    "",
  ];
  let currentSection = "";
  for (const r of rec.results) {
    if (r.section !== currentSection) {
      currentSection = r.section;
      lines.push(`## ${currentSection}`, "", "| 項目 | 結果 | 内容 |", "|---|---|---|");
    }
    lines.push(`| ${escapeCell(r.name)} | ${STATUS_LABEL[r.status]} | ${escapeCell(r.note)} |`);
    const next = rec.results[rec.results.indexOf(r) + 1];
    if (!next || next.section !== currentSection) lines.push("");
  }
  await writeFile(markdown, lines.join("\n"));
  return { json, markdown };
}

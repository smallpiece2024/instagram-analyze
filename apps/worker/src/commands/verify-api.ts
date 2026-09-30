import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { loadMetaConfig, outputDir, type MetaConfig } from "../config.js";
import { detectSceneChanges, probeVideo } from "../lib/ffmpeg.js";
import {
  formatGraphError,
  GraphClient,
  parseCdnExpiry,
  type GraphParams,
  type GraphResponse,
  type RateLimitHeaders,
} from "../lib/graph.js";

/**
 * Meta API の未確認事項を実機で検証する（要件定義 F-COL-00）。
 *
 * - 詳細（API のレスポンスを含む）は .local/api-verification/*.json に保存する（Git 管理外）
 * - 要約（*.md）には ID、ユーザー名、指標の値などの取得データを含めない（NF-SEC-07）。
 *   要約はそのまま doc/ に転記できる内容にする
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

  add(result: CheckResult): void {
    this.results.push(result);
    console.log(`[${STATUS_LABEL[result.status]}] ${result.section} / ${result.name}: ${result.note}`);
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
}

const DAY = 86_400;
const nowSec = (): number => Math.floor(Date.now() / 1000);

export async function verifyApi(): Promise<boolean> {
  const config = loadMetaConfig();
  const graph = new GraphClient(config.accessToken, config.graphApiVersion);
  const rec = new Recorder();
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
  }
  recordRateLimit(rec);

  const files = await writeOutputs(config, rec, startedAt);
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
    response: res.data,
  });
  return {
    all,
    reel: all.find((m) => m.media_product_type === "REELS"),
    image: all.find((m) => m.media_product_type === "FEED" && m.media_type === "IMAGE"),
    carousel: all.find((m) => m.media_type === "CAROUSEL_ALBUM"),
    feedVideo: all.find((m) => m.media_product_type === "FEED" && m.media_type === "VIDEO"),
  };
}

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
  "is_shared_to_feed",
];

async function checkMediaFields(graph: GraphClient, media: MediaSamples, rec: Recorder): Promise<void> {
  const target = media.reel ?? media.all[0];
  if (!target) {
    rec.add({ section: "メディアのフィールド", name: "追加フィールド", status: "skip", note: "投稿がない" });
    return;
  }
  const label = target === media.reel ? "リール" : "投稿";
  for (const field of EXTRA_MEDIA_FIELDS) {
    const res = await graph.get<Record<string, unknown>>(target.id, { fields: `id,${field}` });
    rec.track(res);
    rec.add({
      section: "メディアのフィールド",
      name: `${field}（${label}）`,
      status: res.ok && res.data?.[field] !== undefined ? "ok" : "ng",
      note: res.ok
        ? res.data?.[field] !== undefined
          ? "取得できた"
          : "エラーはないが値が返らない"
        : formatGraphError(res.error),
      request: graph.describe(target.id, { fields: `id,${field}` }),
      response: res.data,
    });
  }
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
      ? `URL の oe パラメータから読み取った期限: 取得からあと約 ${((expiry.getTime() - Date.now()) / 3_600_000).toFixed(1)} 時間`
      : "URL から有効期限を読み取れない",
  });

  const dir = await mkdtemp(join(tmpdir(), "verify-reel-"));
  try {
    const file = join(dir, "reel.mp4");
    const started = Date.now();
    const download = await fetch(mediaUrl);
    if (!download.ok || !download.body) {
      rec.add({ section, name: "ダウンロード", status: "ng", note: `HTTP ${download.status}` });
      return;
    }
    await pipeline(
      Readable.fromWeb(download.body as unknown as WebReadableStream<Uint8Array>),
      createWriteStream(file),
    );
    const size = (await stat(file)).size;
    const downloadSec = (Date.now() - started) / 1000;
    rec.add({
      section,
      name: "ダウンロード",
      status: "ok",
      note: `成功（Content-Type ${download.headers.get("content-type") ?? "不明"}、${(size / 1_048_576).toFixed(1)} MB、${downloadSec.toFixed(1)} 秒）`,
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
    rec.add({ section, name: "ダウンロードと解析", status: "ng", note: String(error) });
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
): Promise<{ json: string; markdown: string }> {
  const dir = join(outputDir(), "api-verification");
  await mkdir(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const json = join(dir, `verify-api-${stamp}.json`);
  const markdown = join(dir, `verify-api-${stamp}.md`);

  await writeFile(
    json,
    JSON.stringify(
      { executedAt: startedAt.toISOString(), graphApiVersion: config.graphApiVersion, results: rec.results },
      null,
      2,
    ),
  );

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

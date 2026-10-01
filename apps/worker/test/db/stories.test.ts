/**
 * `jobs/stories.ts` の結合テスト（設計 9.2 章の「各ジョブの書き込み経路」「秘密の非混入」の行）。
 * 本物の DB（ローカル Supabase）と偽の `fetch`（Graph API、CDN、Storage）、偽の `resize`（入力をコピー）、
 * 偽の `probe`／`detect`（ホストに ffmpeg がない）で `runJob(job)` を動かす。
 * 架空のアカウントを作り、終了時に消す（CASCADE で media、スナップショット、video_analyses、job_runs も消える）。
 * メディア ID は `media.id` が全体で一意なので、実行ごとの乱数を含めて他のテストと衝突しないようにする。
 * Storage は偽の `fetch` なので実物にオブジェクトは残らない
 */
import { copyFile, stat } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import { countSnapshots } from "../../src/db/snapshots.js";
import type { AccountRow, JobRunRow, MediaInsightSnapshotRow, MediaRow } from "../../src/db/types.js";
import { getVideoAnalysis } from "../../src/db/video.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import type { Page } from "../../src/jobs/graph-client.js";
import { MEDIA_METRICS_BY_TYPE } from "../../src/jobs/media-metrics.js";
import type { MediaListItem } from "../../src/jobs/media-sync.js";
import {
  createStoriesJob,
  EMPTY_LIST_WARNING,
  INVALID_STORY_ITEM_ERROR,
  NO_VIDEO_URL_WARNING,
  NOT_STORY_WARNING,
  STORIES_LIST_FIELDS,
} from "../../src/jobs/stories.js";
import { DEFAULT_SCENE_THRESHOLD, type VideoProbe } from "../../src/lib/ffmpeg.js";
import type { GraphError } from "../../src/lib/graph.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";
import { ANALYZER_VERSION } from "../../src/lib/video-analysis.js";
import { storagePath } from "../../src/storage/thumbnails.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 架空の Instagram アカウント ID（先頭 6 桁が 0） */
function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 実行ごとの乱数。メディア ID に含めて、他のテストファイル（並列）の行と衝突しないようにする */
const RUN = Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
let mediaSeq = 0;

/** 架空のメディア ID（先頭 3 桁が 0。16 桁） */
function fakeMediaId(): string {
  mediaSeq += 1;
  return `000${RUN}${String(mediaSeq).padStart(4, "0")}`;
}

const FAKE_TOKEN = `FAKE_VAULT_TOKEN_${RUN}`;
const SERVICE_ROLE_KEY = "FAKE_SERVICE_ROLE_KEY_FOR_STORIES_TEST";
const IMAGE_BYTES = new TextEncoder().encode("FAKE-JPEG-SOURCE");
const VIDEO_BYTES = new TextEncoder().encode("FAKE-MP4-VIDEO-BYTES");

const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

const PROBE: VideoProbe = {
  durationMs: 12_000,
  width: 1080,
  height: 1920,
  fps: 30,
  bitrate: 3_000_000,
  fileSize: 4_500_000,
  hasAudio: true,
};
const DETECTED_CUTS = [4200, 1500, 20_000];

const STORY_PLAIN = MEDIA_METRICS_BY_TYPE.STORY.plain;
const STORY_VALUES: Record<string, number> = {
  views: 120,
  reach: 100,
  replies: 2,
  shares: 1,
  reposts: 0,
  total_interactions: 3,
  profile_visits: 4,
  follows: 1,
  link_clicks: 0,
};
const NAVIGATION = { TAP_FORWARD: 60, TAP_BACK: 5, TAP_EXIT: 10, SWIPE_FORWARD: 3 };
const PROFILE_ACTIVITY = { BIO_LINK_CLICKED: 1 };
const EXPECTED_METRICS = {
  ...STORY_VALUES,
  navigation: { tap_forward: 60, tap_back: 5, tap_exit: 10, swipe_forward: 3 },
  profile_activity: { bio_link_clicked: 1 },
};

function cdnImageUrl(name: string): string {
  return `https://scontent-nrt1-1.cdninstagram.com/v/t51/${name}.jpg?_nc_ht=x&oe=68F0A1B2&oh=abc`;
}

function cdnVideoUrl(name: string): string {
  return `https://scontent-nrt1-1.cdninstagram.com/v/t50/${name}.mp4?_nc_ht=x&oe=68F0A1B2&oh=abc`;
}

/** Graph API の `timestamp` の形（`+0000`） */
function graphTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+0000");
}

function imageStory(id: string, postedAt: Date, over: Partial<MediaListItem> = {}): MediaListItem {
  return {
    id,
    media_type: "IMAGE",
    media_product_type: "STORY",
    timestamp: graphTimestamp(postedAt),
    permalink: `https://www.instagram.com/stories/fake_user/${id}/`,
    media_url: cdnImageUrl(id),
    ...over,
  };
}

function videoStory(id: string, postedAt: Date, over: Partial<MediaListItem> = {}): MediaListItem {
  return {
    id,
    media_type: "VIDEO",
    media_product_type: "STORY",
    timestamp: graphTimestamp(postedAt),
    permalink: `https://www.instagram.com/stories/fake_user/${id}/`,
    thumbnail_url: cdnImageUrl(`${id}-thumb`),
    ...over,
  };
}

/** 1 ページ。`hasNext` なら `paging.next`（トークン入りの URL。使われない）と `cursors.after = A1` を付ける（P8） */
function listPage(data: MediaListItem[], hasNext = false): Page<MediaListItem> {
  return {
    data,
    paging: {
      cursors: { before: "B0", after: "A1" },
      ...(hasNext ? { next: `https://graph.facebook.com/v25.0/x/stories?access_token=${FAKE_TOKEN}&after=A1` } : {}),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function graphErrorResponse(error: GraphError, status = 400): Response {
  return jsonResponse({ error }, status);
}

function serverErrorResponse(status: number): Response {
  return new Response(`<html>${status}</html>`, { status, headers: { "content-type": "text/html" } });
}

function plainBody(metric: string | undefined, values: Record<string, number>): unknown {
  return {
    data: (metric ?? "").split(",").map((name) => ({
      name,
      period: "lifetime",
      values: [{ value: values[name] ?? 0 }],
      title: name,
      description: "",
      id: `x/insights/${name}/lifetime`,
    })),
  };
}

function breakdownBody(metric: string, dimension: string, results: Record<string, number>): unknown {
  return {
    data: [
      {
        name: metric,
        period: "lifetime",
        total_value: {
          breakdowns: [
            { dimension_keys: [dimension], results: Object.entries(results).map(([k, v]) => ({ dimension_values: [k], value: v })) },
          ],
        },
        title: metric,
        description: "",
        id: `x/insights/${metric}/lifetime`,
      },
    ],
  };
}

interface InsightRequest {
  metric: string | undefined;
  breakdown: string | undefined;
}

type InsightResponder = (req: InsightRequest) => Response;

const storyInsights: InsightResponder = (req) => {
  if (req.breakdown === "story_navigation_action_type") return jsonResponse(breakdownBody("navigation", req.breakdown, NAVIGATION));
  if (req.breakdown === "action_type") return jsonResponse(breakdownBody("profile_activity", req.breakdown, PROFILE_ACTIVITY));
  return jsonResponse(plainBody(req.metric, STORY_VALUES));
};

const serverError: InsightResponder = () => serverErrorResponse(502);

function toUrl(input: string | URL | Request): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
}

describe.skipIf(!TEST_DATABASE_URL)("jobs/stories（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let deps: JobDeps;
  const createdAccountIds: string[] = [];
  const lines: string[] = [];

  // 偽の fetch の状態（テストごとに beforeEach で戻す）
  /** `after` パラメータ（最初のページは ""）→ 一覧の応答 */
  let storiesPages: Record<string, () => Response> = {};
  const insightResponders = new Map<string, InsightResponder>();
  let cdnStatus = 200;
  let storageStatus = 200;
  const graphRequests: URL[] = [];
  const cdnDownloads: string[] = [];
  const storageCalls: { method: string; path: string }[] = [];
  const probeCalls: string[] = [];
  const detectCalls: { path: string; threshold: number | undefined }[] = [];
  let fileBytesAtProbe: number | undefined;

  const config: WorkerConfig = {
    databaseUrl: url,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: SERVICE_ROLE_KEY,
    graphApiVersion: "v25.0",
    metaAppId: "0",
    metaAppSecret: "FAKE_APP_SECRET",
    hourlyMinute: 5,
    dailyTimeJst: { hour: 5, minute: 30 },
    backfillMaxDays: 30,
    backfillHistoryDays: 730,
    rateHardLimit: 90,
    rateSoftLimit: 50,
    logLevel: "debug",
    outputDir: ".local",
    downloadAllowedHosts: ["cdninstagram.com", "fbcdn.net"],
  };

  const STORAGE_PREFIX = "/storage/v1/object/thumbnails/";

  const fetchImpl: typeof fetch = async (input, init) => {
    const target = toUrl(input);
    if (target.hostname === "graph.facebook.com") {
      graphRequests.push(target);
      const [, , id = "", kind] = target.pathname.split("/");
      if (kind === "stories") {
        const reply = storiesPages[target.searchParams.get("after") ?? ""];
        return reply ? reply() : graphErrorResponse({ message: "一覧の用意がない", code: 999_999 });
      }
      if (kind === "insights") {
        const responder = insightResponders.get(id) ?? storyInsights;
        return responder({
          metric: target.searchParams.get("metric") ?? undefined,
          breakdown: target.searchParams.get("breakdown") ?? undefined,
        });
      }
      return graphErrorResponse({ message: "想定しないパス", code: 999_999 });
    }
    if (target.hostname.endsWith(".cdninstagram.com")) {
      cdnDownloads.push(target.pathname);
      if (cdnStatus !== 200) return new Response("ng", { status: cdnStatus });
      const isVideo = target.pathname.endsWith(".mp4");
      return new Response(isVideo ? VIDEO_BYTES : IMAGE_BYTES, {
        status: 200,
        headers: { "content-type": isVideo ? "video/mp4" : "image/jpeg" },
      });
    }
    if (target.pathname.startsWith(STORAGE_PREFIX)) {
      storageCalls.push({ method: init?.method ?? "GET", path: target.pathname.slice(STORAGE_PREFIX.length) });
      return new Response(JSON.stringify({ Key: "x" }), { status: storageStatus, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected", { status: 500 });
  };

  const job = createStoriesJob({
    fetchImpl,
    resize: (input, output) => copyFile(input, output),
    probe: async (filePath) => {
      probeCalls.push(filePath);
      fileBytesAtProbe = (await stat(filePath)).size;
      return PROBE;
    },
    detect: async (filePath, threshold) => {
      detectCalls.push({ path: filePath, threshold });
      return DETECTED_CUTS;
    },
  });

  /** 1 ページだけの一覧を用意する */
  function setList(items: MediaListItem[]): void {
    storiesPages = { "": () => jsonResponse(listPage(items)) };
  }

  async function newAccount(): Promise<AccountRow> {
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_user" }));
    createdAccountIds.push(account.id);
    await db.begin((tx) => upsertCredential(tx, account.id, FAKE_TOKEN, CREDENTIAL));
    return account;
  }

  async function mediaRows(accountId: string): Promise<MediaRow[]> {
    return [...(await db<MediaRow[]>`select * from public.media where account_id = ${accountId} order by id`)];
  }

  async function mediaRow(id: string): Promise<MediaRow | undefined> {
    return (await db<MediaRow[]>`select * from public.media where id = ${id}`)[0];
  }

  async function snapshotsOf(mediaId: string): Promise<MediaInsightSnapshotRow[]> {
    return [
      ...(await db<MediaInsightSnapshotRow[]>`
        select * from public.media_insight_snapshots where media_id = ${mediaId} order by fetched_at, id
      `),
    ];
  }

  async function lastRun(accountId: string): Promise<JobRunRow | undefined> {
    return (
      await db<JobRunRow[]>`
        select * from public.job_runs where account_id = ${accountId} and job_name = 'stories' order by id desc limit 1
      `
    )[0];
  }

  async function countAnalyses(mediaId: string): Promise<number> {
    const [row] = await db<{ n: number }[]>`select count(*)::int as n from public.video_analyses where media_id = ${mediaId}`;
    return row?.n ?? -1;
  }

  function logText(): string {
    return lines.join("\n");
  }

  function run(account: AccountRow, now: Date): ReturnType<typeof runJob> {
    return runJob(job, { ...deps, now: () => now }, account);
  }

  /** ログと job_runs.error に、URL、メディア ID、アカウントの ID が出ていないこと */
  async function expectNoLeak(account: AccountRow, mediaIds: string[]): Promise<void> {
    const text = logText();
    expect(text).not.toContain("://");
    expect(text).not.toContain("cdninstagram.com");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(account.id);
    expect(text).not.toContain(account.id.slice(0, 8));
    expect(text).not.toContain(account.ig_user_id);
    for (const id of mediaIds) expect(text).not.toContain(id);
    const error = (await lastRun(account.id))?.error ?? "";
    expect(error).not.toContain("://");
    expect(error).not.toMatch(/\d{10,}/);
  }

  beforeAll(async () => {
    db = connectDb(url);
    const secrets = new SecretRegistry();
    secrets.add(config.metaAppSecret);
    secrets.add(config.supabaseServiceRoleKey);
    secrets.addUrlParts(config.databaseUrl);
    secrets.addUrlParts(config.supabaseUrl);
    const log = createLogger("debug", secrets, (line) => lines.push(line));
    deps = { db, config, log, secrets, fetchImpl, sleep: async () => {} };
  });

  beforeEach(() => {
    storiesPages = {};
    insightResponders.clear();
    cdnStatus = 200;
    storageStatus = 200;
    graphRequests.length = 0;
    cdnDownloads.length = 0;
    storageCalls.length = 0;
    probeCalls.length = 0;
    detectCalls.length = 0;
    fileBytesAtProbe = undefined;
    lines.length = 0;
  });

  afterAll(async () => {
    for (const id of createdAccountIds) {
      await db`delete from public.accounts where id = ${id}`;
      const [media] = await db<{ n: number }[]>`select count(*)::int as n from public.media where account_id = ${id}`;
      expect(media?.n).toBe(0);
      const [runs] = await db<{ n: number }[]>`select count(*)::int as n from public.job_runs where account_id = ${id}`;
      expect(runs?.n).toBe(0);
    }
    await closeDb(db);
  });

  // -------------------------------------------------------------------------
  // 主な流れ: 画像 1 ＋ 動画 1 を、T0 → +1h → +3h → +4h の 4 回
  // -------------------------------------------------------------------------

  let account: AccountRow;
  const T0 = new Date();
  const imageId = fakeMediaId();
  const videoId = fakeMediaId();
  const imagePostedAt = new Date(T0.getTime() - 2 * HOUR_MS);
  const videoPostedAt = new Date(T0.getTime() - 1 * HOUR_MS);

  it("1 回目（T0）: media 2 行（STORY、expires_at = posted_at + 24h）、サムネイル 2、スナップショット 2（内訳の入れ子、job_run_id）、動画は media_url なし → no_video_url で failures 0", async () => {
    account = await newAccount();
    setList([videoStory(videoId, videoPostedAt), imageStory(imageId, imagePostedAt)]);

    expect(await run(account, T0)).toBe("success");
    const jobRun = await lastRun(account.id);
    expect(jobRun?.status).toBe("success");
    expect(jobRun?.items_fetched).toBe(2);
    // 一覧 1 ＋ 1 枚あたり 3（内訳なし、navigation、profile_activity）× 2
    expect(jobRun?.api_calls).toBe(7);
    expect(jobRun?.error).toBeNull();

    // 一覧のリクエスト: fields は設計 5.6 章の 8 項目。URL にトークンを載せない
    const list = graphRequests[0];
    expect(list?.pathname).toBe(`/v25.0/${account.ig_user_id}/stories`);
    expect(list?.searchParams.get("fields")).toBe(STORIES_LIST_FIELDS);
    for (const u of graphRequests) expect(u.searchParams.has("access_token")).toBe(false);
    const insightPaths = graphRequests.slice(1).map((u) => `${u.pathname.replace("/v25.0/", "")}?${u.searchParams.toString()}`);
    expect(insightPaths).toEqual([
      `${videoId}/insights?metric=${encodeURIComponent(STORY_PLAIN.join(","))}`,
      `${videoId}/insights?metric=navigation&breakdown=story_navigation_action_type&metric_type=total_value`,
      `${videoId}/insights?metric=profile_activity&breakdown=action_type&metric_type=total_value`,
      `${imageId}/insights?metric=${encodeURIComponent(STORY_PLAIN.join(","))}`,
      `${imageId}/insights?metric=navigation&breakdown=story_navigation_action_type&metric_type=total_value`,
      `${imageId}/insights?metric=profile_activity&breakdown=action_type&metric_type=total_value`,
    ]);

    // media
    const rows = await mediaRows(account.id);
    expect(rows.map((r) => r.id).sort()).toEqual([imageId, videoId].sort());
    const image = await mediaRow(imageId);
    expect(image?.media_product_type).toBe("STORY");
    expect(image?.media_type).toBe("IMAGE");
    expect(image?.posted_at).toEqual(new Date(Math.floor(imagePostedAt.getTime() / 1000) * 1000));
    expect(image?.expires_at).toEqual(new Date((image?.posted_at.getTime() ?? 0) + DAY_MS));
    expect(image?.gone_at).toBeNull();
    expect(image?.first_seen_at).toEqual(T0);
    expect(image?.thumbnail_path).toBe(storagePath(account.id, imageId));
    const video = await mediaRow(videoId);
    expect(video?.media_type).toBe("VIDEO");
    expect(video?.expires_at).toEqual(new Date((video?.posted_at.getTime() ?? 0) + DAY_MS));
    expect(video?.thumbnail_path).toBe(storagePath(account.id, videoId));
    // 行に URL が入らない
    expect(JSON.stringify(rows)).not.toContain("cdninstagram.com");

    // サムネイル: 画像は media_url、動画は thumbnail_url。Storage に 2 回 POST。動画本体はダウンロードしない
    expect(cdnDownloads.sort()).toEqual([`/v/t51/${imageId}.jpg`, `/v/t51/${videoId}-thumb.jpg`].sort());
    expect(storageCalls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(storageCalls.map((c) => c.path).sort()).toEqual(
      [storagePath(account.id, imageId), storagePath(account.id, videoId)].sort(),
    );

    // スナップショット
    const [imageSnap] = await snapshotsOf(imageId);
    expect(imageSnap?.metrics).toEqual(EXPECTED_METRICS);
    expect(imageSnap?.fetched_at).toEqual(T0);
    expect(imageSnap?.elapsed_seconds).toBe(2 * 60 * 60);
    expect(imageSnap?.job_run_id).toBe(jobRun?.id);
    expect(imageSnap?.raw_response_id).toMatch(/^\d+$/);
    const [videoSnap] = await snapshotsOf(videoId);
    expect(videoSnap?.metrics).toEqual(EXPECTED_METRICS);
    expect(videoSnap?.elapsed_seconds).toBe(60 * 60);
    expect(videoSnap?.job_run_id).toBe(jobRun?.id);

    // 動画解析: media_url がないので no_video_url。probe と detect は呼ばれない
    expect(probeCalls).toEqual([]);
    expect(detectCalls).toEqual([]);
    const analysis = await getVideoAnalysis(db, videoId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD);
    expect(analysis?.row.status).toBe("no_video_url");
    expect(analysis?.row.error).toBeNull();
    expect(analysis?.row.analyzed_at).toEqual(T0);
    expect(analysis?.row.duration_ms).toBeNull();
    expect(analysis?.cuts).toEqual([]);
    expect(await countAnalyses(imageId)).toBe(0);

    expect(logText()).toMatch(new RegExp(`WARN {2}job=stories error="${NO_VIDEO_URL_WARNING}"$`, "m"));
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=2 new=2 gone=0 thumbnails=2 snapshots=2 videos_analyzed=0 no_video_url=1$/m);
    expect(logText()).toMatch(/DEBUG job=stories progress=2\/2$/m);
    expect(logText()).toMatch(/INFO {2}job=stories status=success items=2 calls=7 failures=0/m);
    await expectNoLeak(account, [imageId, videoId]);
  }, 20_000);

  it("2 回目（+1h）: media は 2 行のまま、サムネイルは保存し直さない、スナップショットが 4 行、no_video_url は 3 時間未満なので再試行しない", async () => {
    const T1 = new Date(T0.getTime() + 1 * HOUR_MS);
    setList([videoStory(videoId, videoPostedAt), imageStory(imageId, imagePostedAt)]);

    expect(await run(account, T1)).toBe("success");
    const jobRun = await lastRun(account.id);
    expect(jobRun?.items_fetched).toBe(2);
    expect(jobRun?.api_calls).toBe(7);

    expect(await mediaRows(account.id)).toHaveLength(2);
    expect((await mediaRow(imageId))?.first_seen_at).toEqual(T0);
    expect((await mediaRow(imageId))?.last_synced_at).toEqual(T1);
    expect(cdnDownloads).toEqual([]);
    expect(storageCalls).toEqual([]);

    expect(await countSnapshots(db, imageId)).toBe(2);
    expect(await countSnapshots(db, videoId)).toBe(2);
    expect((await snapshotsOf(imageId)).map((s) => s.fetched_at)).toEqual([T0, T1]);

    expect(probeCalls).toEqual([]);
    expect(await countAnalyses(videoId)).toBe(1);
    const analysis = await getVideoAnalysis(db, videoId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD);
    expect(analysis?.row.status).toBe("no_video_url");
    expect(analysis?.row.analyzed_at).toEqual(T0);
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=2 new=0 gone=0 thumbnails=0 snapshots=2 videos_analyzed=0 no_video_url=0$/m);
    expect(logText()).not.toContain(NO_VIDEO_URL_WARNING);
    await expectNoLeak(account, [imageId, videoId]);
  }, 20_000);

  it("3 回目（+3h）: 動画に media_url が付いたので再試行 → ダウンロード、偽 probe/detect で success と video_cuts。一覧から外れた画像（expires_at が 10 分以上先）に gone_at が入る", async () => {
    const T3 = new Date(T0.getTime() + 3 * HOUR_MS);
    setList([videoStory(videoId, videoPostedAt, { media_url: cdnVideoUrl(videoId) })]);

    expect(await run(account, T3)).toBe("success");
    const jobRun = await lastRun(account.id);
    expect(jobRun?.status).toBe("success");
    expect(jobRun?.items_fetched).toBe(1);
    expect(jobRun?.api_calls).toBe(4);

    // 消失: 画像は expires_at（T0 + 22h）が T3 + 10 分より先なので gone
    const image = await mediaRow(imageId);
    expect(image?.gone_at).toEqual(T3);
    expect((await mediaRow(videoId))?.gone_at).toBeNull();
    expect(await mediaRows(account.id)).toHaveLength(2);

    // 動画: 本体を 1 回ダウンロードし、一時ファイルを probe と detect に渡し、終了後に消えている
    expect(cdnDownloads).toEqual([`/v/t50/${videoId}.mp4`]);
    expect(probeCalls).toHaveLength(1);
    expect(detectCalls).toHaveLength(1);
    expect(detectCalls[0]?.path).toBe(probeCalls[0]);
    expect(detectCalls[0]?.threshold).toBe(DEFAULT_SCENE_THRESHOLD);
    expect(fileBytesAtProbe).toBe(VIDEO_BYTES.byteLength);
    await expect(stat(probeCalls[0] ?? "")).rejects.toThrow();

    expect(await countAnalyses(videoId)).toBe(1);
    const analysis = await getVideoAnalysis(db, videoId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD);
    expect(analysis?.row).toMatchObject({
      status: "success",
      error: null,
      analyzed_at: T3,
      analyzer_version: ANALYZER_VERSION,
      scene_threshold: DEFAULT_SCENE_THRESHOLD,
      duration_ms: 12_000,
      width: 1080,
      height: 1920,
      fps: 30,
      bitrate: 3_000_000,
      file_size: 4_500_000,
      has_audio: true,
      cut_count: 2,
      avg_scene_ms: 4000,
      first_cut_ms: 1500,
      cuts_in_first_3s: 1,
    });
    expect(analysis?.cuts.map((c) => [c.seq, c.at_ms, c.scene_score])).toEqual([
      [1, 1500, null],
      [2, 4200, null],
    ]);

    expect(await countSnapshots(db, videoId)).toBe(3);
    expect(await countSnapshots(db, imageId)).toBe(2);
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=1 new=0 gone=1 thumbnails=0 snapshots=1 videos_analyzed=1 no_video_url=0$/m);
    await expectNoLeak(account, [imageId, videoId]);
  }, 20_000);

  it("4 回目（+4h）: success は再解析しない（ダウンロードも probe もなし）。video_analyses は 1 行のまま、スナップショットだけ増える", async () => {
    const T4 = new Date(T0.getTime() + 4 * HOUR_MS);
    setList([videoStory(videoId, videoPostedAt, { media_url: cdnVideoUrl(videoId) })]);

    expect(await run(account, T4)).toBe("success");
    expect(cdnDownloads).toEqual([]);
    expect(probeCalls).toEqual([]);
    expect(detectCalls).toEqual([]);
    expect(await countAnalyses(videoId)).toBe(1);
    expect((await getVideoAnalysis(db, videoId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row.analyzed_at).toEqual(
      new Date(T0.getTime() + 3 * HOUR_MS),
    );
    expect(await countSnapshots(db, videoId)).toBe(4);
    expect((await mediaRow(imageId))?.gone_at).toEqual(new Date(T0.getTime() + 3 * HOUR_MS));
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=1 new=0 gone=0 thumbnails=0 snapshots=1 videos_analyzed=0 no_video_url=0$/m);
  }, 20_000);

  // -------------------------------------------------------------------------
  // 消失判定の余裕と保護
  // -------------------------------------------------------------------------

  it("一覧が空で、expires_at が 10 分以上先のものが残っていれば消失判定を見送る（warn、success）。残っていなければ消失判定する", async () => {
    const other = await newAccount();
    const now = new Date();
    const soonId = fakeMediaId();
    const freshId = fakeMediaId();
    const soonPostedAt = new Date(now.getTime() - DAY_MS + 5 * MINUTE_MS); // あと 5 分で消える
    const freshPostedAt = new Date(now.getTime() - 1 * HOUR_MS);
    setList([imageStory(soonId, soonPostedAt), imageStory(freshId, freshPostedAt)]);
    expect(await run(other, now)).toBe("success");
    expect((await lastRun(other.id))?.items_fetched).toBe(2);

    // 空の一覧: fresh（10 分以上先）が残っているので見送る。soon は数えない（known=1）
    const t1 = new Date(now.getTime() + 1 * MINUTE_MS);
    setList([]);
    lines.length = 0;
    expect(await run(other, t1)).toBe("success");
    let jobRun = await lastRun(other.id);
    expect(jobRun?.status).toBe("success");
    expect(jobRun?.items_fetched).toBe(0);
    expect(jobRun?.api_calls).toBe(1);
    expect(jobRun?.error).toBeNull();
    expect((await mediaRow(soonId))?.gone_at).toBeNull();
    expect((await mediaRow(freshId))?.gone_at).toBeNull();
    // 文言は空白を含まないので引用符で囲まれない
    expect(logText()).toMatch(new RegExp(`WARN {2}job=stories error=${EMPTY_LIST_WARNING} known=1$`, "m"));
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=0 new=0 gone=0 thumbnails=0 snapshots=0 videos_analyzed=0 no_video_url=0$/m);
    expect(logText()).toMatch(/INFO {2}job=stories status=success items=0 calls=1 failures=0/m);

    // 空でない一覧: fresh は 10 分以上先なので gone、soon は 10 分以内なので gone にしない
    const t2 = new Date(now.getTime() + 2 * MINUTE_MS);
    const newId = fakeMediaId();
    setList([imageStory(newId, new Date(now.getTime() - 30 * MINUTE_MS))]);
    lines.length = 0;
    expect(await run(other, t2)).toBe("success");
    expect((await mediaRow(soonId))?.gone_at).toBeNull();
    expect((await mediaRow(freshId))?.gone_at).toEqual(t2);
    expect((await mediaRow(newId))?.gone_at).toBeNull();
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=1 new=1 gone=1 thumbnails=1 snapshots=1 videos_analyzed=0 no_video_url=0$/m);

    // 空の一覧: newId（10 分以上先）が残っているので見送る。newId を手で gone にしてから空の一覧を流すと、
    // 残りは soon（10 分以内）だけなので見送らずに消失判定し、soon には gone_at が入らない（warn なし、gone=0）
    const t3 = new Date(now.getTime() + 3 * MINUTE_MS);
    setList([]);
    lines.length = 0;
    expect(await run(other, t3)).toBe("success");
    expect(logText()).toMatch(new RegExp(`WARN {2}job=stories error=${EMPTY_LIST_WARNING} known=1$`, "m"));
    expect((await mediaRow(newId))?.gone_at).toBeNull();
    await db`update public.media set gone_at = ${t3} where id = ${newId}`;
    const t4 = new Date(now.getTime() + 4 * MINUTE_MS);
    lines.length = 0;
    expect(await run(other, t4)).toBe("success");
    expect(logText()).not.toContain(EMPTY_LIST_WARNING);
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=0 new=0 gone=0 thumbnails=0 snapshots=0 videos_analyzed=0 no_video_url=0$/m);
    expect((await mediaRow(soonId))?.gone_at).toBeNull();
  }, 30_000);

  it("既存のストーリーズの項目が読めないときは、その ID を seenIds に入れるので gone_at が入らない", async () => {
    const other = await newAccount();
    const now = new Date();
    const existingId = fakeMediaId();
    const newId = fakeMediaId();
    setList([imageStory(existingId, new Date(now.getTime() - 1 * HOUR_MS))]);
    expect(await run(other, now)).toBe("success");

    const later = new Date(now.getTime() + 1 * HOUR_MS);
    setList([
      imageStory(existingId, new Date(now.getTime() - 1 * HOUR_MS), { timestamp: "nonsense" }),
      imageStory(newId, new Date(now.getTime() - 30 * MINUTE_MS)),
    ]);
    lines.length = 0;
    expect(await run(other, later)).toBe("partial");
    const jobRun = await lastRun(other.id);
    expect(jobRun?.items_fetched).toBe(1);
    expect(jobRun?.error).toBe(INVALID_STORY_ITEM_ERROR);
    expect((await mediaRow(existingId))?.gone_at).toBeNull();
    expect((await mediaRow(existingId))?.last_synced_at).toEqual(now);
    expect((await mediaRow(newId))?.gone_at).toBeNull();
    expect(await countSnapshots(db, existingId)).toBe(1);
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=1 new=1 gone=0 thumbnails=1 snapshots=1 videos_analyzed=0 no_video_url=0$/m);
    await expectNoLeak(other, [existingId, newId]);
  }, 20_000);

  it("2 ページ目が失敗したら、1 ページ目の枚のスナップショットは書き、markGone は呼ばない（partial）", async () => {
    const other = await newAccount();
    const now = new Date();
    const olderId = fakeMediaId();
    const pageOneId = fakeMediaId();
    setList([imageStory(olderId, new Date(now.getTime() - 2 * HOUR_MS))]);
    expect(await run(other, new Date(now.getTime() - 1 * HOUR_MS))).toBe("success");

    storiesPages = {
      "": () => jsonResponse(listPage([imageStory(pageOneId, new Date(now.getTime() - 30 * MINUTE_MS))], true)),
      A1: () => serverErrorResponse(500),
    };
    lines.length = 0;
    expect(await run(other, now)).toBe("partial");
    const jobRun = await lastRun(other.id);
    expect(jobRun?.status).toBe("partial");
    expect(jobRun?.items_fetched).toBe(1);
    // 1 ページ目 1 ＋ 2 ページ目 3（再試行）＋ 指標 3
    expect(jobRun?.api_calls).toBe(7);
    expect(jobRun?.error).toBe("HTTP 500");
    expect(graphRequests.filter((u) => u.pathname.endsWith("/stories") && u.searchParams.get("after") === "A1")).toHaveLength(3);

    expect(await countSnapshots(db, pageOneId)).toBe(1);
    expect((await mediaRow(pageOneId))?.thumbnail_path).toBe(storagePath(other.id, pageOneId));
    // 一覧に出なかった older は expires_at が 10 分以上先だが、消失判定をしていないので gone_at は null のまま
    expect((await mediaRow(olderId))?.gone_at).toBeNull();
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=1 new=1 gone=0 thumbnails=1 snapshots=1 videos_analyzed=0 no_video_url=0$/m);
    expect(logText()).toMatch(/WARN {2}job=stories status=partial items=1 calls=7 failures=1 .* error_code=none class=transient$/m);
    await expectNoLeak(other, [olderId, pageOneId]);
  }, 20_000);

  it("now を固定して 2 回流すと、2 回目は insertSnapshot が false で行数が変わらない（success、items 0）", async () => {
    const other = await newAccount();
    const now = new Date();
    const id = fakeMediaId();
    setList([imageStory(id, new Date(now.getTime() - 1 * HOUR_MS))]);
    expect(await run(other, now)).toBe("success");
    expect((await lastRun(other.id))?.items_fetched).toBe(1);
    expect(await countSnapshots(db, id)).toBe(1);

    lines.length = 0;
    expect(await run(other, now)).toBe("success");
    const jobRun = await lastRun(other.id);
    expect(jobRun?.status).toBe("success");
    expect(jobRun?.items_fetched).toBe(0);
    expect(jobRun?.api_calls).toBe(4);
    expect(await countSnapshots(db, id)).toBe(1);
    expect(await mediaRows(other.id)).toHaveLength(1);
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=1 new=0 gone=0 thumbnails=0 snapshots=0 videos_analyzed=0 no_video_url=0$/m);
  }, 20_000);

  it("no_video_url が 3 時間後に再び no_video_url なら analyzed_at だけ進み、行は 1 つのまま、失敗に数えない", async () => {
    const other = await newAccount();
    const now = new Date();
    const vId = fakeMediaId();
    const postedAt = new Date(now.getTime() - 1 * HOUR_MS);
    setList([videoStory(vId, postedAt)]);
    expect(await run(other, now)).toBe("success");
    expect((await getVideoAnalysis(db, vId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row.analyzed_at).toEqual(now);

    const later = new Date(now.getTime() + 3 * HOUR_MS);
    setList([videoStory(vId, postedAt)]);
    lines.length = 0;
    cdnDownloads.length = 0; // 1 回目のサムネイルのダウンロードを除く
    expect(await run(other, later)).toBe("success");
    const jobRun = await lastRun(other.id);
    expect(jobRun?.items_fetched).toBe(1);
    expect(jobRun?.error).toBeNull();
    expect(cdnDownloads).toEqual([]);
    expect(probeCalls).toEqual([]);
    expect(await countAnalyses(vId)).toBe(1);
    const analysis = await getVideoAnalysis(db, vId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD);
    expect(analysis?.row.status).toBe("no_video_url");
    expect(analysis?.row.analyzed_at).toEqual(later);
    expect(analysis?.row.error).toBeNull();
    expect(logText()).toMatch(new RegExp(`WARN {2}job=stories error="${NO_VIDEO_URL_WARNING}"$`, "m"));
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=1 new=0 gone=0 thumbnails=0 snapshots=1 videos_analyzed=0 no_video_url=1$/m);
    expect(logText()).toMatch(/INFO {2}job=stories status=success items=1 calls=4 failures=0/m);
  }, 20_000);

  // -------------------------------------------------------------------------
  // 失敗の経路
  // -------------------------------------------------------------------------

  it("一覧の取得が最初から失敗（HTTP 500 を 3 回）→ failed。media に行を書かず、消失判定もしない", async () => {
    const other = await newAccount();
    const now = new Date();
    const existingId = fakeMediaId();
    setList([imageStory(existingId, new Date(now.getTime() - 1 * HOUR_MS))]);
    expect(await run(other, now)).toBe("success");

    storiesPages = { "": () => serverErrorResponse(500) };
    lines.length = 0;
    const later = new Date(now.getTime() + 1 * HOUR_MS);
    expect(await run(other, later)).toBe("failed");
    const jobRun = await lastRun(other.id);
    expect(jobRun?.status).toBe("failed");
    expect(jobRun?.items_fetched).toBe(0);
    expect(jobRun?.api_calls).toBe(3);
    expect(jobRun?.error).toBe("HTTP 500");
    expect(await mediaRows(other.id)).toHaveLength(1);
    expect((await mediaRow(existingId))?.gone_at).toBeNull();
    expect((await mediaRow(existingId))?.last_synced_at).toEqual(now);
    expect(logText()).toMatch(/WARN {2}job=stories status=failed items=0 calls=3 failures=1 .* error_code=none class=transient$/m);
    expect(logText()).not.toMatch(/INFO {2}job=stories pages=/);
    await expectNoLeak(other, [existingId]);
  }, 20_000);

  it("指標が transient（再試行を使い切った）な枚は行を書かず、他の枚は書けるので partial。次回も一覧にあれば取り直す", async () => {
    const other = await newAccount();
    const now = new Date();
    const okId = fakeMediaId();
    const downId = fakeMediaId();
    setList([imageStory(okId, new Date(now.getTime() - 1 * HOUR_MS)), imageStory(downId, new Date(now.getTime() - 2 * HOUR_MS))]);
    insightResponders.set(downId, serverError);

    expect(await run(other, now)).toBe("partial");
    const jobRun = await lastRun(other.id);
    expect(jobRun?.status).toBe("partial");
    expect(jobRun?.items_fetched).toBe(1);
    // 一覧 1 ＋ ok 3 ＋ down 3（再試行）
    expect(jobRun?.api_calls).toBe(7);
    expect(jobRun?.error).toBe("HTTP 502");
    expect(await countSnapshots(db, okId)).toBe(1);
    expect(await countSnapshots(db, downId)).toBe(0);
    expect(await mediaRows(other.id)).toHaveLength(2);
    expect(logText()).toMatch(/WARN {2}job=stories status=partial items=1 calls=7 failures=1 .* error_code=none class=transient$/m);
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=2 new=2 gone=0 thumbnails=2 snapshots=1 videos_analyzed=0 no_video_url=0$/m);
    await expectNoLeak(other, [okId, downId]);
  }, 20_000);

  it("動画のダウンロードが HTTP 404 → video_analyses が failed（error は固定文言）、class=download で partial。サムネイルの 404 も失敗に数える", async () => {
    const other = await newAccount();
    const now = new Date();
    const vId = fakeMediaId();
    setList([videoStory(vId, new Date(now.getTime() - 1 * HOUR_MS), { media_url: cdnVideoUrl(vId) })]);
    cdnStatus = 404;

    expect(await run(other, now)).toBe("partial");
    const jobRun = await lastRun(other.id);
    expect(jobRun?.status).toBe("partial");
    expect(jobRun?.items_fetched).toBe(1);
    // サムネイル（thumbnail_url の 404）と動画（media_url の 404）で 2 件の失敗。最後の失敗が error に残る
    expect(jobRun?.error).toBe("HTTP 404");
    expect((await mediaRow(vId))?.thumbnail_path).toBeNull();
    const analysis = await getVideoAnalysis(db, vId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD);
    expect(analysis?.row.status).toBe("failed");
    expect(analysis?.row.error).toBe("HTTP 404");
    expect(analysis?.row.analyzed_at).toEqual(now);
    expect(analysis?.cuts).toEqual([]);
    expect(probeCalls).toEqual([]);
    expect(logText()).toMatch(/WARN {2}job=stories status=partial items=1 calls=4 failures=2 .* error_code=none class=download$/m);
    expect(logText()).toMatch(/INFO {2}job=stories pages=1 stories=1 new=1 gone=0 thumbnails=0 snapshots=1 videos_analyzed=0 no_video_url=0$/m);

    // 3 時間後に再試行して success になる
    cdnStatus = 200;
    lines.length = 0;
    const later = new Date(now.getTime() + 3 * HOUR_MS);
    setList([videoStory(vId, new Date(now.getTime() - 1 * HOUR_MS), { media_url: cdnVideoUrl(vId) })]);
    expect(await run(other, later)).toBe("success");
    expect(probeCalls).toHaveLength(1);
    expect((await getVideoAnalysis(db, vId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row.status).toBe("success");
    expect((await mediaRow(vId))?.thumbnail_path).toBe(storagePath(other.id, vId));
    expect(await countAnalyses(vId)).toBe(1);
    await expectNoLeak(other, [vId]);
  }, 20_000);

  it("STORY でない項目は warn して無視し、読めない項目は失敗に数える（他の枚は書けるので partial）", async () => {
    const other = await newAccount();
    const now = new Date();
    const okId = fakeMediaId();
    const feedId = fakeMediaId();
    const badId = fakeMediaId();
    setList([
      imageStory(okId, new Date(now.getTime() - 1 * HOUR_MS)),
      imageStory(feedId, new Date(now.getTime() - 1 * HOUR_MS), { media_product_type: "FEED" }),
      imageStory(badId, new Date(now.getTime() - 1 * HOUR_MS), { timestamp: "nonsense" }),
    ]);

    expect(await run(other, now)).toBe("partial");
    const jobRun = await lastRun(other.id);
    expect(jobRun?.items_fetched).toBe(1);
    expect(jobRun?.api_calls).toBe(4);
    expect(jobRun?.error).toBe(INVALID_STORY_ITEM_ERROR);
    expect((await mediaRows(other.id)).map((r) => r.id)).toEqual([okId]);
    expect(logText()).toMatch(new RegExp(`WARN {2}job=stories error="${NOT_STORY_WARNING}" count=1$`, "m"));
    expect(logText()).toMatch(/WARN {2}job=stories status=partial items=1 calls=4 failures=1 .* error_code=none class=fatal$/m);
    await expectNoLeak(other, [okId, feedId, badId]);
  }, 20_000);
});

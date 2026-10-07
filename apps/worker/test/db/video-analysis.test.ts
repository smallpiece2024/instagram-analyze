/**
 * R4 の `video_analysis` ジョブ、`listVideoAnalysisCandidates`、ビュー `media_video_features` の結合テスト
 * （R4 設計 7 章の「結合」「DB」の行）。本物の DB（ローカル Supabase）と偽の `fetch`（Graph API、CDN）、
 * 偽の `probe`／`detect`／ffmpeg の有無で `runJob(job)` を動かす。架空のアカウントを作り、終了時に消す
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import type { AccountRow, JobRunRow } from "../../src/db/types.js";
import { getVideoAnalysis, listVideoAnalysisCandidates, writeVideoAnalysis } from "../../src/db/video.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import {
  createVideoAnalysisJob,
  GAVE_UP_WARNING,
  INVALID_MEDIA_ID_ERROR,
  mediaFetchFailedError,
  NO_FFMPEG_ERROR,
  NO_VIDEO_URL_WARNING,
  NOT_VIDEO_ERROR,
  VIDEO_MAX_ATTEMPTS,
} from "../../src/jobs/video-analysis.js";
import { DEFAULT_SCENE_THRESHOLD, type VideoProbe } from "../../src/lib/ffmpeg.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";
import { ANALYZER_VERSION, failedAnalysisRow } from "../../src/lib/video-analysis.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const HOUR_MS = 60 * 60 * 1000;

const RUN = Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
let mediaSeq = 0;
/** 架空のメディア ID（先頭 3 桁が 0。16 桁） */
function fakeMediaId(): string {
  mediaSeq += 1;
  return `000${RUN}${String(mediaSeq).padStart(4, "0")}`;
}
function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

const FAKE_TOKEN = `FAKE_VAULT_TOKEN_VA_${RUN}`;
const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights"],
  status: "valid",
};
const PROBE: VideoProbe = { durationMs: 12_000, width: 1080, height: 1920, fps: 30, bitrate: 1, fileSize: 1, hasAudio: true };
const T0 = new Date("2026-10-07T03:00:00Z");

function cdnVideoUrl(id: string): string {
  return `https://scontent-nrt1-1.cdninstagram.com/v/t50/${id}.mp4?oe=68F0A1B2&oh=abc`;
}

type GraphReply =
  | { kind: "video" }
  | { kind: "no_url" }
  | { kind: "image" }
  | { kind: "transient" }
  | { kind: "fatal" }
  /** media_url は返るが CDN が 404（解析が failed になる） */
  | { kind: "cdn_missing" };

describe.skipIf(!TEST_DATABASE_URL)("jobs/video-analysis（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let deps: JobDeps;
  const createdAccountIds: string[] = [];
  const lines: string[] = [];
  const replies = new Map<string, GraphReply>();
  const graphPaths: string[] = [];
  let detectCalls = 0;
  let toolsOk = true;
  /** detect が呼ばれた後に呼ぶ（時間の予算のテストで時計を進める） */
  let onDetect: (() => void) | undefined;

  const config: WorkerConfig = {
    databaseUrl: url,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: "FAKE_SERVICE_ROLE_KEY_FOR_VA_TEST",
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
    videoMaxPerRun: 5,
    videoBudgetMs: 480_000,
  };

  const fetchImpl: typeof fetch = async (input) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.hostname === "graph.facebook.com") {
      const id = target.pathname.split("/")[2] ?? "";
      graphPaths.push(id);
      const reply = replies.get(id) ?? { kind: "video" };
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (reply.kind === "transient") return new Response("<html>502</html>", { status: 502 });
      if (reply.kind === "fatal") {
        return json({ error: { message: `Object with ID '${id}' does not exist`, code: 100, type: "GraphMethodException" } }, 400);
      }
      if (reply.kind === "image") return json({ id, media_type: "IMAGE", media_url: cdnVideoUrl(id) });
      if (reply.kind === "no_url") return json({ id, media_type: "VIDEO" });
      if (reply.kind === "cdn_missing") {
        return json({ id, media_type: "VIDEO", media_url: cdnVideoUrl(`missing-${id}`) });
      }
      return json({ id, media_type: "VIDEO", media_url: cdnVideoUrl(id) });
    }
    if (target.hostname.endsWith(".cdninstagram.com")) {
      if (target.pathname.includes("/missing-")) return new Response("ng", { status: 404 });
      return new Response(new TextEncoder().encode("FAKE-MP4"), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    return new Response("unexpected", { status: 500 });
  };

  const job = createVideoAnalysisJob({
    fetchImpl,
    toolsAvailable: async () => toolsOk,
    probe: async () => PROBE,
    detect: async () => {
      detectCalls += 1;
      onDetect?.();
      return [
        { atMs: 1500, score: 0.412345 },
        { atMs: 4200, score: 0.9 },
      ];
    },
  });

  async function newAccount(): Promise<AccountRow> {
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_user" }));
    createdAccountIds.push(account.id);
    await db.begin((tx) => upsertCredential(tx, account.id, FAKE_TOKEN, CREDENTIAL));
    return account;
  }

  async function insertMedia(
    accountId: string,
    over: { type?: string; product?: string; postedAt?: Date; gone?: boolean } = {},
  ): Promise<string> {
    const id = fakeMediaId();
    const postedAt = over.postedAt ?? new Date(T0.getTime() - mediaSeq * HOUR_MS);
    const product = over.product ?? "REELS";
    const expiresAt = product === "STORY" ? new Date(postedAt.getTime() + 24 * HOUR_MS) : null;
    await db`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, expires_at, gone_at)
      values (${id}, ${accountId}, ${over.type ?? "VIDEO"}, ${product}, ${postedAt}, ${expiresAt}, ${over.gone ? T0 : null})
    `;
    return id;
  }

  async function presetFailed(mediaId: string, analyzedAt: Date, attempts: number, threshold = DEFAULT_SCENE_THRESHOLD): Promise<void> {
    for (let i = 0; i < attempts; i += 1) {
      await db.begin((tx) => writeVideoAnalysis(tx, failedAnalysisRow(mediaId, threshold, "HTTP 404", analyzedAt), []));
    }
  }

  async function lastRun(accountId: string): Promise<JobRunRow | undefined> {
    return (
      await db<JobRunRow[]>`
        select * from public.job_runs where account_id = ${accountId} and job_name = 'video_analysis' order by id desc limit 1
      `
    )[0];
  }

  function run(account: AccountRow, now: Date | (() => Date), over: Partial<WorkerConfig> = {}): ReturnType<typeof runJob> {
    const nowFn = typeof now === "function" ? now : () => now;
    return runJob(job, { ...deps, config: { ...config, ...over }, now: nowFn }, account);
  }

  function logText(): string {
    return lines.join("\n");
  }

  function expectNoLeak(account: AccountRow, mediaIds: string[]): void {
    const text = logText();
    expect(text).not.toContain("://");
    expect(text).not.toContain("cdninstagram.com");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(account.ig_user_id);
    for (const id of mediaIds) expect(text).not.toContain(id);
  }

  beforeAll(async () => {
    db = connectDb(url);
    const secrets = new SecretRegistry();
    secrets.add(config.metaAppSecret);
    secrets.addUrlParts(config.databaseUrl);
    const log = createLogger("debug", secrets, (line) => lines.push(line));
    deps = { db, config, log, secrets, fetchImpl, sleep: async () => {} };
  });

  beforeEach(() => {
    replies.clear();
    graphPaths.length = 0;
    detectCalls = 0;
    toolsOk = true;
    onDetect = undefined;
    lines.length = 0;
  });

  afterAll(async () => {
    for (const id of createdAccountIds) await db`delete from public.accounts where id = ${id}`;
    await closeDb(db);
  });

  it("listVideoAnalysisCandidates: リールとフィード動画だけ、gone_at なし、3 時間、打ち切り、新しい順", async () => {
    const account = await newAccount();
    const reelNew = await insertMedia(account.id, { postedAt: new Date(T0.getTime() - 1 * HOUR_MS) });
    const feedVideo = await insertMedia(account.id, { product: "FEED", postedAt: new Date(T0.getTime() - 2 * HOUR_MS) });
    await insertMedia(account.id, { product: "STORY", postedAt: new Date(T0.getTime() - 3 * HOUR_MS) });
    await insertMedia(account.id, { type: "IMAGE", product: "FEED", postedAt: new Date(T0.getTime() - 4 * HOUR_MS) });
    await insertMedia(account.id, { type: "CAROUSEL_ALBUM", product: "FEED", postedAt: new Date(T0.getTime() - 5 * HOUR_MS) });
    await insertMedia(account.id, { gone: true, postedAt: new Date(T0.getTime() - 6 * HOUR_MS) });
    const retryDue = await insertMedia(account.id, { postedAt: new Date(T0.getTime() - 7 * HOUR_MS) });
    await presetFailed(retryDue, new Date(T0.getTime() - 3 * HOUR_MS), 1); // ちょうど 3 時間前は対象
    const retryNotDue = await insertMedia(account.id, { postedAt: new Date(T0.getTime() - 8 * HOUR_MS) });
    await presetFailed(retryNotDue, new Date(T0.getTime() - 3 * HOUR_MS + 1000), 1);
    const gaveUp = await insertMedia(account.id, { postedAt: new Date(T0.getTime() - 9 * HOUR_MS) });
    await presetFailed(gaveUp, new Date(T0.getTime() - 10 * HOUR_MS), VIDEO_MAX_ATTEMPTS);
    const almost = await insertMedia(account.id, { postedAt: new Date(T0.getTime() - 10 * HOUR_MS) });
    await presetFailed(almost, new Date(T0.getTime() - 10 * HOUR_MS), VIDEO_MAX_ATTEMPTS - 1);
    const done = await insertMedia(account.id, { postedAt: new Date(T0.getTime() - 11 * HOUR_MS) });
    await db.begin((tx) =>
      writeVideoAnalysis(tx, { ...failedAnalysisRow(done, DEFAULT_SCENE_THRESHOLD, "x", T0), status: "success", error: null }, []),
    );
    // 古い条件（しきい値 0.4）の success は今の条件の判定に使わない
    const otherCondition = await insertMedia(account.id, { postedAt: new Date(T0.getTime() - 12 * HOUR_MS) });
    await db.begin((tx) =>
      writeVideoAnalysis(tx, { ...failedAnalysisRow(otherCondition, 0.4, "x", T0), status: "success", error: null }, []),
    );

    const rows = await listVideoAnalysisCandidates(db, {
      accountId: account.id,
      analyzerVersion: ANALYZER_VERSION,
      sceneThreshold: DEFAULT_SCENE_THRESHOLD,
      maxAttempts: VIDEO_MAX_ATTEMPTS,
      now: T0,
      retryAfterHours: 3,
    });
    expect(rows.map((r) => r.id)).toEqual([reelNew, feedVideo, retryDue, almost, otherCondition]);
  });

  it("本数の上限: 3 本のうち 2 本を解析し、残りは skipped_by_limit。success は items、点数は scene_score に入り、ログに ID と URL がない", async () => {
    const account = await newAccount();
    const ids = [await insertMedia(account.id), await insertMedia(account.id), await insertMedia(account.id)];
    expect(await run(account, T0, { videoMaxPerRun: 2 })).toBe("success");
    const runRow = await lastRun(account.id);
    expect(runRow?.items_fetched).toBe(2);
    expect(detectCalls).toBe(2);
    expect(graphPaths).toEqual([ids[0], ids[1]]);
    const stored = await getVideoAnalysis(db, ids[0] ?? "", ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD);
    expect(stored?.row.status).toBe("success");
    expect(stored?.row.attempt_count).toBe(1);
    expect(stored?.cuts.map((c) => [c.at_ms, c.scene_score])).toEqual([
      [1500, 0.4123],
      [4200, 0.9],
    ]);
    expect(await getVideoAnalysis(db, ids[2] ?? "", ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD)).toBeUndefined();
    expect(logText()).toMatch(
      /INFO  job=video_analysis candidates=3 analyzed=2 no_video_url=0 failed=0 skipped_by_limit=1 skipped_by_budget=0$/m,
    );
    expectNoLeak(account, ids);
  });

  it("時間の予算: 経過が予算を超えていたら新しい 1 本を始めない（残りは skipped_by_budget で次の回）", async () => {
    const account = await newAccount();
    const ids = [await insertMedia(account.id), await insertMedia(account.id)];
    let tick = 0;
    const now = (): Date => new Date(T0.getTime() + (tick++) * 1000);
    expect(await run(account, now, { videoBudgetMs: 0 })).toBe("success");
    expect(detectCalls).toBe(0);
    expect(graphPaths).toEqual([]);
    expect(logText()).toMatch(/candidates=2 analyzed=0 no_video_url=0 failed=0 skipped_by_limit=0 skipped_by_budget=2$/m);
    expect(await getVideoAnalysis(db, ids[0] ?? "", ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD)).toBeUndefined();
  });

  it("media_url の取り直しの各場合: ない → no_video_url（warn のみ）、VIDEO でない → failed、transient → 行なし、fatal → failed（固定文言）", async () => {
    const account = await newAccount();
    const noUrl = await insertMedia(account.id);
    const image = await insertMedia(account.id);
    const transient = await insertMedia(account.id);
    const fatal = await insertMedia(account.id);
    replies.set(noUrl, { kind: "no_url" });
    replies.set(image, { kind: "image" });
    replies.set(transient, { kind: "transient" });
    replies.set(fatal, { kind: "fatal" });

    expect(await run(account, T0)).toBe("failed"); // 書けた success が 0 で失敗がある
    const get = (id: string) => getVideoAnalysis(db, id, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD);
    expect((await get(noUrl))?.row.status).toBe("no_video_url");
    expect((await get(image))?.row).toMatchObject({ status: "failed", error: NOT_VIDEO_ERROR, attempt_count: 1 });
    expect(await get(transient)).toBeUndefined();
    expect((await get(fatal))?.row).toMatchObject({ status: "failed", error: mediaFetchFailedError(100) });
    expect(detectCalls).toBe(0);
    const runRow = await lastRun(account.id);
    expect(runRow?.error).toBe(mediaFetchFailedError(100));
    expect(logText()).toMatch(new RegExp(`WARN {2}job=video_analysis error="${NO_VIDEO_URL_WARNING}"$`, "m"));
    expect(logText()).toMatch(/candidates=4 analyzed=0 no_video_url=1 failed=3 skipped_by_limit=0 skipped_by_budget=0$/m);
    expectNoLeak(account, [noUrl, image, transient, fatal]);
    expect(runRow?.error ?? "").not.toContain("does not exist");
  });

  it("ffmpeg がない回は行を書かず、ダウンロードも API も呼ばず、recordFailure を 1 回だけ（attempt_count は増えない）", async () => {
    const account = await newAccount();
    const a = await insertMedia(account.id);
    const b = await insertMedia(account.id);
    await presetFailed(b, new Date(T0.getTime() - 4 * HOUR_MS), 1);
    toolsOk = false;
    expect(await run(account, T0)).toBe("failed");
    const runRow = await lastRun(account.id);
    expect(runRow?.error).toBe(NO_FFMPEG_ERROR);
    expect(runRow?.items_fetched).toBe(0);
    expect(graphPaths).toEqual([]);
    expect(await getVideoAnalysis(db, a, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD)).toBeUndefined();
    expect((await getVideoAnalysis(db, b, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row.attempt_count).toBe(1);
  });

  it("打ち切り: 書いた結果 attempt_count が上限に達した回に warn を 1 行だけ出し、次の回からは選ばれない", async () => {
    const account = await newAccount();
    const id = await insertMedia(account.id);
    await presetFailed(id, new Date(T0.getTime() - 4 * HOUR_MS), VIDEO_MAX_ATTEMPTS - 1);
    replies.set(id, { kind: "no_url" });
    expect(await run(account, T0)).toBe("success");
    expect((await getVideoAnalysis(db, id, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row.attempt_count).toBe(VIDEO_MAX_ATTEMPTS);
    expect(logText().split("\n").filter((l) => l.includes(GAVE_UP_WARNING))).toHaveLength(1);

    lines.length = 0;
    graphPaths.length = 0;
    expect(await run(account, new Date(T0.getTime() + 4 * HOUR_MS))).toBe("success");
    expect(graphPaths).toEqual([]);
    expect(logText()).not.toContain(GAVE_UP_WARNING);
    expect(logText()).toMatch(/candidates=0 analyzed=0/m);
  });

  it("listVideoAnalysisCandidates: 別のアカウントのリールは入らない", async () => {
    const account = await newAccount();
    const other = await newAccount();
    const mine = await insertMedia(account.id);
    const theirs = await insertMedia(other.id);
    const query = {
      analyzerVersion: ANALYZER_VERSION,
      sceneThreshold: DEFAULT_SCENE_THRESHOLD,
      maxAttempts: VIDEO_MAX_ATTEMPTS,
      now: T0,
      retryAfterHours: 3,
    };
    expect((await listVideoAnalysisCandidates(db, { ...query, accountId: account.id })).map((r) => r.id)).toEqual([mine]);
    expect((await listVideoAnalysisCandidates(db, { ...query, accountId: other.id })).map((r) => r.id)).toEqual([theirs]);
  });

  it("listVideoAnalysisCandidates: 投稿日時が同じなら m.id の順。no_video_url（attempt_count 4）は 3 時間後にまた選ばれる", async () => {
    const account = await newAccount();
    const postedAt = new Date(T0.getTime() - 2 * HOUR_MS);
    const first = await insertMedia(account.id, { postedAt });
    const second = await insertMedia(account.id, { postedAt });
    const noUrl = await insertMedia(account.id, { postedAt: new Date(T0.getTime() - 5 * HOUR_MS) });
    for (let i = 0; i < VIDEO_MAX_ATTEMPTS - 1; i += 1) {
      await db.begin((tx) =>
        writeVideoAnalysis(
          tx,
          { ...failedAnalysisRow(noUrl, DEFAULT_SCENE_THRESHOLD, "x", new Date(T0.getTime() - 3 * HOUR_MS)), status: "no_video_url", error: null },
          [],
        ),
      );
    }
    expect((await getVideoAnalysis(db, noUrl, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row).toMatchObject({
      status: "no_video_url",
      attempt_count: VIDEO_MAX_ATTEMPTS - 1,
    });
    const rows = await listVideoAnalysisCandidates(db, {
      accountId: account.id,
      analyzerVersion: ANALYZER_VERSION,
      sceneThreshold: DEFAULT_SCENE_THRESHOLD,
      maxAttempts: VIDEO_MAX_ATTEMPTS,
      now: T0,
      retryAfterHours: 3,
    });
    // ID は同じ桁数の数字なので、文字列の順と数の順が一致する
    expect(rows.map((r) => r.id)).toEqual([[first, second].sort(), noUrl].flat());
  });

  it("時間の予算: 1 本目の後に予算を超えたら残りを始めない（analyzed=1、skipped_by_budget=2）", async () => {
    const account = await newAccount();
    const ids = [await insertMedia(account.id), await insertMedia(account.id), await insertMedia(account.id)];
    const budget = 60_000;
    let clock = T0;
    onDetect = () => {
      clock = new Date(T0.getTime() + budget + 1);
    };
    expect(await run(account, () => clock, { videoBudgetMs: budget })).toBe("success");
    expect(detectCalls).toBe(1);
    expect(graphPaths).toEqual([ids[0]]);
    expect(logText()).toMatch(/candidates=3 analyzed=1 no_video_url=0 failed=0 skipped_by_limit=0 skipped_by_budget=2$/m);
    expect(await getVideoAnalysis(db, ids[1] ?? "", ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD)).toBeUndefined();
  });

  it("時間の予算: 経過がちょうど予算と同じなら新しい 1 本を始める", async () => {
    const account = await newAccount();
    await insertMedia(account.id);
    await insertMedia(account.id);
    const budget = 60_000;
    let calls = 0;
    // 最初の呼び出し（startedAt）だけ T0、以降はちょうど予算だけ進んだ時刻
    const now = (): Date => (calls++ === 0 ? T0 : new Date(T0.getTime() + budget));
    expect(await run(account, now, { videoBudgetMs: budget })).toBe("success");
    expect(detectCalls).toBe(2);
    expect(logText()).toMatch(/candidates=2 analyzed=2 no_video_url=0 failed=0 skipped_by_limit=0 skipped_by_budget=0$/m);
  });

  it("本数の上限: transient で終わった 1 本も上限に数える", async () => {
    const account = await newAccount();
    const ids = [await insertMedia(account.id), await insertMedia(account.id)];
    replies.set(ids[0] ?? "", { kind: "transient" });
    expect(await run(account, T0, { videoMaxPerRun: 1 })).toBe("failed");
    expect(graphPaths.filter((id) => id === ids[1])).toEqual([]);
    expect(detectCalls).toBe(0);
    expect(logText()).toMatch(/candidates=2 analyzed=0 no_video_url=0 failed=1 skipped_by_limit=1 skipped_by_budget=0$/m);
  });

  it("打ち切りの warn: fatal、NOT_VIDEO、解析の failed のそれぞれで 5 回目に 1 行ずつ", async () => {
    const account = await newAccount();
    const fatal = await insertMedia(account.id);
    const image = await insertMedia(account.id);
    const broken = await insertMedia(account.id);
    for (const id of [fatal, image, broken]) await presetFailed(id, new Date(T0.getTime() - 4 * HOUR_MS), VIDEO_MAX_ATTEMPTS - 1);
    replies.set(fatal, { kind: "fatal" });
    replies.set(image, { kind: "image" });
    replies.set(broken, { kind: "cdn_missing" });
    expect(await run(account, T0)).toBe("failed");
    for (const id of [fatal, image, broken]) {
      expect((await getVideoAnalysis(db, id, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row).toMatchObject({
        status: "failed",
        attempt_count: VIDEO_MAX_ATTEMPTS,
      });
    }
    expect((await getVideoAnalysis(db, broken, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row.error).toBe("HTTP 404");
    expect(detectCalls).toBe(0);
    expect(logText().split("\n").filter((l) => l.includes(GAVE_UP_WARNING))).toHaveLength(3);
    expect(logText()).toMatch(/candidates=3 analyzed=0 no_video_url=0 failed=3 skipped_by_limit=0 skipped_by_budget=0$/m);
    expectNoLeak(account, [fatal, image, broken]);
  });

  it("打ち切りの warn: success で attempt_count が 5 以上になっても出ない", async () => {
    const account = await newAccount();
    const id = await insertMedia(account.id);
    await presetFailed(id, new Date(T0.getTime() - 4 * HOUR_MS), VIDEO_MAX_ATTEMPTS - 1);
    expect(await run(account, T0)).toBe("success");
    expect((await getVideoAnalysis(db, id, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row).toMatchObject({
      status: "success",
      attempt_count: VIDEO_MAX_ATTEMPTS,
    });
    expect(logText()).not.toContain(GAVE_UP_WARNING);
  });

  it("候補の ID がメディア ID の形でなければ API を呼ばず、recordFailure を 1 回（行は書かない）", async () => {
    const account = await newAccount();
    // DB の制約では防げない形の ID（数字以外を含む）。架空
    const badId = `X${RUN}${String((mediaSeq += 1)).padStart(4, "0")}`;
    await db`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at)
      values (${badId}, ${account.id}, 'VIDEO', 'REELS', ${new Date(T0.getTime() - HOUR_MS)})
    `;
    expect(await run(account, T0)).toBe("failed");
    expect(graphPaths).toEqual([]);
    expect(detectCalls).toBe(0);
    expect((await lastRun(account.id))?.error).toBe(INVALID_MEDIA_ID_ERROR);
    expect(logText()).toMatch(/status=failed items=0 calls=0 failures=1/m);
    expect(logText()).toMatch(/candidates=1 analyzed=0 no_video_url=0 failed=1 skipped_by_limit=0 skipped_by_budget=0$/m);
    expect(await getVideoAnalysis(db, badId, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD)).toBeUndefined();
  });

  describe("media_video_features（R4 設計 5.2 節）", () => {
    async function featureRows(accountId: string) {
      return db<{ media_id: string; analysis_status: string | null; cut_count: number | null; retention_rate: string | null }[]>`
        select media_id, analysis_status, cut_count, retention_rate
        from public.media_video_features where account_id = ${accountId} order by media_id
      `;
    }

    it("動画だけで 1 投稿 1 行、今の条件の行だけを使う（古い条件の success と今の条件の failed なら failed で特徴量は null）", async () => {
      const account = await newAccount();
      const reel = await insertMedia(account.id);
      const fresh = await insertMedia(account.id);
      await insertMedia(account.id, { product: "STORY" });
      await insertMedia(account.id, { type: "IMAGE", product: "FEED" });
      await db.begin((tx) =>
        writeVideoAnalysis(tx, { ...failedAnalysisRow(reel, 0.4, "x", T0), status: "success", error: null, cut_count: 3 }, []),
      );
      await db.begin((tx) => writeVideoAnalysis(tx, failedAnalysisRow(reel, DEFAULT_SCENE_THRESHOLD, "HTTP 404", T0), []));
      const rows = await featureRows(account.id);
      expect(rows.map((r) => r.media_id)).toEqual([reel, fresh].sort());
      const byId = new Map(rows.map((r) => [r.media_id, r]));
      expect(byId.get(reel)).toMatchObject({ analysis_status: "failed", cut_count: null });
      expect(byId.get(fresh)).toMatchObject({ analysis_status: null, cut_count: null });
    });

    it("retention_rate = 最新の平均視聴時間 ÷ 長さ（1 超えもそのまま）、長さが 0 なら null", async () => {
      const account = await newAccount();
      const reel = await insertMedia(account.id);
      const zero = await insertMedia(account.id);
      for (const [id, duration] of [
        [reel, 4000],
        [zero, 0],
      ] as const) {
        await db.begin((tx) =>
          writeVideoAnalysis(
            tx,
            { ...failedAnalysisRow(id, DEFAULT_SCENE_THRESHOLD, "x", T0), status: "success", error: null, duration_ms: duration },
            [],
          ),
        );
        await db`
          insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
          values (${id}, ${T0}, 3600, ${db.json({ ig_reels_avg_watch_time: 6000 })})
        `;
      }
      const byId = new Map((await featureRows(account.id)).map((r) => [r.media_id, r]));
      expect(Number(byId.get(reel)?.retention_rate)).toBeCloseTo(1.5, 10);
      expect(byId.get(zero)?.retention_rate).toBeNull();
      const [dataset] = await db<{ retention_rate: string | null }[]>`
        select retention_rate from public.media_analysis_dataset where media_id = ${reel}
      `;
      expect(Number(dataset?.retention_rate)).toBeCloseTo(1.5, 10);
    });

    it("cuts_in_last_3s を 0 以外の値で両方のビューから読める", async () => {
      const account = await newAccount();
      const reel = await insertMedia(account.id);
      await db.begin((tx) =>
        writeVideoAnalysis(
          tx,
          {
            ...failedAnalysisRow(reel, DEFAULT_SCENE_THRESHOLD, "x", T0),
            status: "success",
            error: null,
            duration_ms: 10_000,
            cut_count: 3,
            cuts_in_first_3s: 1,
            cuts_in_last_3s: 2,
          },
          [],
        ),
      );
      const [feature] = await db<{ cuts_in_last_3s: number | null; cuts_in_first_3s: number | null }[]>`
        select cuts_in_last_3s, cuts_in_first_3s from public.media_video_features where media_id = ${reel}
      `;
      expect(feature).toEqual({ cuts_in_last_3s: 2, cuts_in_first_3s: 1 });
      const [dataset] = await db<{ cuts_in_last_3s: number | null; cuts_in_first_3s: number | null }[]>`
        select cuts_in_last_3s, cuts_in_first_3s from public.media_analysis_dataset where media_id = ${reel}
      `;
      expect(dataset).toEqual({ cuts_in_last_3s: 2, cuts_in_first_3s: 1 });
    });
  });

  describe("マイグレーション 20261007000000 の cuts_in_last_3s の埋め戻し", () => {
    const MIGRATION_PATH = fileURLToPath(
      new URL("../../../../supabase/migrations/20261007000000_r4_video.sql", import.meta.url),
    );

    /** マイグレーションの update 文をファイルからそのまま取り出す（式を 2 か所に書かないため） */
    async function backfillSql(): Promise<string> {
      const text = await readFile(MIGRATION_PATH, "utf8");
      const match = /^update public\.video_analyses va\s+set cuts_in_last_3s[\s\S]*?;/m.exec(text);
      if (!match) throw new Error("マイグレーションに cuts_in_last_3s の update が見つからない");
      return match[0];
    }

    /** トランザクションを巻き戻すための目印 */
    class Rollback extends Error {}

    it("読むだけ: テスト以外の行で、success かつ長さありは video_cuts の最後 3 秒の件数と一致し、それ以外は null", async () => {
      // 並列に動く他のテストは success の行を cuts_in_last_3s なしで書くことがあるので、架空のアカウント
      // （ig_user_id が 000000 で始まる）の行は除く。手元の DB の本物の行（R1 のストーリーズ、R4 のリール）を確かめる
      const [row] = await db<{ checked: number; mismatched: number; not_null_others: number }[]>`
        with target as (
          select va.*
          from public.video_analyses va
          join public.media m on m.id = va.media_id
          join public.accounts a on a.id = m.account_id
          where a.ig_user_id not like '000000%'
        )
        select
          count(*) filter (where status = 'success' and duration_ms is not null)::int as checked,
          count(*) filter (
            where status = 'success' and duration_ms is not null
              and cuts_in_last_3s is distinct from (
                select count(*)::int from public.video_cuts c
                where c.analysis_id = target.id and c.at_ms > target.duration_ms - 3000
              )
          )::int as mismatched,
          count(*) filter (
            where (status <> 'success' or duration_ms is null) and cuts_in_last_3s is not null
          )::int as not_null_others
        from target
      `;
      expect(row?.mismatched).toBe(0);
      expect(row?.not_null_others).toBe(0);
    });

    it("書いて確かめる: マイグレーションの update をそのまま流すと、境目は含めず、カット 0 本は 0、success 以外と長さ null は null（巻き戻す）", async () => {
      const account = await newAccount();
      const [withCuts, noCuts, failed, noDuration] = [
        await insertMedia(account.id),
        await insertMedia(account.id),
        await insertMedia(account.id),
        await insertMedia(account.id),
      ];
      const success = (id: string, duration: number | null) => ({
        ...failedAnalysisRow(id, DEFAULT_SCENE_THRESHOLD, "x", T0),
        status: "success" as const,
        error: null,
        duration_ms: duration,
      });
      // cuts_in_last_3s は null のまま書く（R4 の前の行の形）。7000 は境目ちょうど（10000 − 3000）なので数えない
      await db.begin((tx) =>
        writeVideoAnalysis(tx, success(withCuts, 10_000), [6999, 7000, 7001, 9500].map((at, i) => ({ seq: i + 1, at_ms: at, scene_score: null }))),
      );
      await db.begin((tx) => writeVideoAnalysis(tx, success(noCuts, 10_000), []));
      await db.begin((tx) =>
        writeVideoAnalysis(tx, failedAnalysisRow(failed, DEFAULT_SCENE_THRESHOLD, "HTTP 404", T0), [{ seq: 1, at_ms: 9000, scene_score: null }]),
      );
      await db.begin((tx) => writeVideoAnalysis(tx, success(noDuration, null), [{ seq: 1, at_ms: 9000, scene_score: null }]));

      const ids = [withCuts, noCuts, failed, noDuration];
      const sql = await backfillSql();
      let after: Map<string, number | null> | undefined;
      // update は全行に掛かるので、トランザクションの中で流して結果を読み、巻き戻す（本物の行は変えない）
      await expect(
        db.begin(async (tx) => {
          await tx.unsafe(sql);
          const rows = await tx<{ media_id: string; cuts_in_last_3s: number | null }[]>`
            select media_id, cuts_in_last_3s from public.video_analyses where media_id in ${tx(ids)}
          `;
          after = new Map(rows.map((r) => [r.media_id, r.cuts_in_last_3s]));
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(after?.get(withCuts)).toBe(2);
      expect(after?.get(noCuts)).toBe(0);
      expect(after?.get(failed)).toBeNull();
      expect(after?.get(noDuration)).toBeNull();
      // 巻き戻ったので null のまま
      expect((await getVideoAnalysis(db, withCuts, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD))?.row.cuts_in_last_3s).toBeNull();
    });
  });
});

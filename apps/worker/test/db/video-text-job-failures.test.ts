/**
 * R4.1 の `video_text` ジョブの失敗の場合（設計 3.6 節の表、8 章「単体（ジョブ）」の残り）。
 * `test/db/video-text-job.test.ts` と同じ枠組み（本物の DB、偽の `fetch`、偽の ffmpeg）に、進められる時計と、
 * Graph API の取り直しの応答・ffmpeg の振る舞いを本ごとに差し替える仕組みを足したもの。Vision のユニットは使わない。
 * 架空のアカウントを作り、終了時に消す
 */
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import type { AccountRow } from "../../src/db/types.js";
import { writeVideoAnalysis } from "../../src/db/video.js";
import { getVideoTextAnalysis, IN_PROGRESS_ERROR, listStoredFrames } from "../../src/db/video-text.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import { mediaFetchFailedError, NO_VIDEO_URL_WARNING, NOT_VIDEO_ERROR } from "../../src/jobs/video-analysis.js";
import {
  createVideoTextJob,
  CUTS_MISSING_WARNING,
  ffmpegFailedError,
  FRAME_EXTRACT_ERROR,
  FRAME_EXTRACT_TIMEOUT_ERROR,
  FRAME_EXTRACT_TOO_LONG_ERROR,
  IMAGE_TOO_LARGE_ERROR,
  TEXT_GAVE_UP_WARNING,
  unreadableFramesError,
  USAGE_WRITE_ERROR,
} from "../../src/jobs/video-text.js";
import { CommandError, DEFAULT_SCENE_THRESHOLD } from "../../src/lib/ffmpeg.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";
import { failedAnalysisRow } from "../../src/lib/video-analysis.js";
import {
  FRAME_EXTRACT_TIMEOUT_MS,
  FRAME_INTERVAL_MS,
  OCR_METHOD,
  OCR_VERSION,
  TEXT_ANALYZER_VERSION,
  VIDEO_TEXT_EXTRACT_BUDGET_MS,
  VIDEO_TEXT_MAX_ATTEMPTS,
} from "../../src/lib/video-text.js";
import { authFailedError, requestFailedError } from "../../src/lib/vision-client.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const RUN = Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
let mediaSeq = 0;
function fakeMediaId(): string {
  mediaSeq += 1;
  return `000${RUN}${String(mediaSeq).padStart(4, "0")}`;
}
function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

const FAKE_TOKEN = `FAKE_VAULT_TOKEN_VTF_${RUN}`;
const VISION_TOKEN = `ya29.FAKE_VISION_TOKEN_${RUN}`;
const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights"],
  status: "valid",
};
const T0 = new Date("2026-10-11T03:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CONDITION = { ocrMethod: OCR_METHOD, ocrVersion: OCR_VERSION, frameIntervalMs: FRAME_INTERVAL_MS, analyzerVersion: TEXT_ANALYZER_VERSION };

function cdnVideoUrl(id: string): string {
  return `https://scontent-nrt1-1.cdninstagram.com/v/t50/${id}.mp4?oe=68F0A1B2&oh=abc`;
}

/** テロップ 1 行（720×1280 の上 1/4、中央）の `fullTextAnnotation` */
function captionAnnotation(text = "ランチ営業中"): unknown {
  return {
    pages: [
      {
        width: 720,
        height: 1280,
        blocks: [
          {
            paragraphs: [
              {
                words: [
                  {
                    confidence: 0.99,
                    property: { detectedLanguages: [{ languageCode: "ja" }] },
                    boundingBox: { vertices: [{ x: 200, y: 300 }, { x: 520, y: 300 }, { x: 520, y: 345 }, { x: 200, y: 345 }] },
                    symbols: Array.from(text).map((t, i, all) => ({ text: t, ...(i === all.length - 1 ? { property: { detectedBreak: { type: "LINE_BREAK" } } } : {}) })),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    text: `${text}\n`,
  };
}

/** Graph API の取り直しの応答の種類（省略は VIDEO と media_url） */
type GraphReply = "no_url" | "image" | "transient" | "fatal";
type VisionReply = { status: number; body?: unknown } | { perImage: (index: number) => unknown } | { throwTimeout: true };
type ExtractBehavior = (atMs: number, output: string) => Promise<void>;

const defaultExtract: ExtractBehavior = async (atMs, output) => {
  await writeFile(output, `JPEG-${atMs}`);
};

describe.skipIf(!TEST_DATABASE_URL)("jobs/video-text（失敗の場合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let deps: JobDeps;
  const createdAccountIds: string[] = [];
  const lines: string[] = [];
  const graphPaths: string[] = [];
  const graphReplies = new Map<string, GraphReply>();
  let clock = T0;
  let cdnCalls = 0;
  let tokenCalls = 0;
  let visionCalls: number[] = [];
  let visionReplies: VisionReply[] = [];
  /** `images:annotate` の 1 要求ごとに時計を進める量 */
  let visionDelayMs = 0;
  let extractCalls = 0;
  let extractTimeouts: (number | undefined)[] = [];
  /** フレーム 1 枚の取り出しごとに時計を進める量 */
  let extractDelayMs = 0;
  let extractBehavior: ExtractBehavior = defaultExtract;

  const config: WorkerConfig = {
    databaseUrl: url,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: "FAKE_SERVICE_ROLE_KEY_FOR_VTF_TEST",
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
    videoTextMaxPerRun: 5,
    videoTextBudgetMs: 480_000,
    videoTextMaxUnitsPerRun: 200,
    videoTextMonthlyUnitLimit: 1000,
    videoTextMonthlyMaxVideos: 30,
    visionKey: { ok: true, key: { clientEmail: "worker@fake-project.iam.gserviceaccount.com", privateKey: PEM } },
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.hostname === "graph.facebook.com") {
      const id = target.pathname.split("/")[2] ?? "";
      graphPaths.push(id);
      const reply = graphReplies.get(id);
      if (reply === "transient") return new Response("<html>502</html>", { status: 502 });
      if (reply === "fatal") {
        return json({ error: { message: `Object with ID '${id}' does not exist`, code: 100, type: "GraphMethodException" } }, 400);
      }
      if (reply === "image") return json({ id, media_type: "IMAGE", media_url: cdnVideoUrl(id) });
      if (reply === "no_url") return json({ id, media_type: "VIDEO" });
      return json({ id, media_type: "VIDEO", media_url: cdnVideoUrl(id) });
    }
    if (target.hostname.endsWith(".cdninstagram.com")) {
      cdnCalls += 1;
      return new Response(new TextEncoder().encode("FAKE-MP4"), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    if (target.hostname === "oauth2.googleapis.com") {
      tokenCalls += 1;
      return json({ access_token: VISION_TOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    if (target.hostname === "vision.googleapis.com") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { requests: unknown[] };
      const count = body.requests.length;
      visionCalls.push(count);
      clock = new Date(clock.getTime() + visionDelayMs);
      const reply = visionReplies.shift() ?? { perImage: () => ({ fullTextAnnotation: captionAnnotation() }) };
      if ("throwTimeout" in reply) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if ("perImage" in reply) return json({ responses: Array.from({ length: count }, (_, i) => reply.perImage(i)) });
      return json(reply.body ?? {}, reply.status);
    }
    return new Response("unexpected", { status: 500 });
  };

  const job = createVideoTextJob({
    fetchImpl,
    toolsAvailable: async () => true,
    extractFrame: async (_input, atMs, output, timeoutMs) => {
      extractCalls += 1;
      extractTimeouts.push(timeoutMs);
      clock = new Date(clock.getTime() + extractDelayMs);
      await extractBehavior(atMs, output);
    },
    sleep: async () => {},
  });

  async function newAccount(): Promise<AccountRow> {
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_user" }));
    createdAccountIds.push(account.id);
    await db.begin((tx) => upsertCredential(tx, account.id, FAKE_TOKEN, CREDENTIAL));
    return account;
  }

  /** リールと今の条件の success のカットの解析（長さとカットを指定）。先に入れた方が新しい。戻り値はメディア ID */
  async function insertVideo(accountId: string, durationMs: number, cuts: number[] = []): Promise<string> {
    const id = fakeMediaId();
    const postedAt = new Date(T0.getTime() - mediaSeq * HOUR_MS);
    await db`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, expires_at, gone_at)
      values (${id}, ${accountId}, 'VIDEO', 'REELS', ${postedAt}, null, null)
    `;
    await db.begin((tx) =>
      writeVideoAnalysis(
        tx,
        { ...failedAnalysisRow(id, DEFAULT_SCENE_THRESHOLD, "x", T0), status: "success", error: null, duration_ms: durationMs },
        cuts.map((atMs, i) => ({ seq: i + 1, at_ms: atMs, scene_score: null })),
      ),
    );
    return id;
  }

  async function usageRows(accountId: string): Promise<{ media_id: string | null; units: number; image_count: number; http_status: number | null; ok: boolean }[]> {
    return db`select media_id, units, image_count, http_status, ok from public.ocr_usage where account_id = ${accountId} order by id`;
  }

  /** 時計を `now` に合わせて 1 回動かす（偽の fetch と ffmpeg が時計を進められる） */
  function run(account: AccountRow, over: Partial<WorkerConfig> = {}, now: Date = T0): ReturnType<typeof runJob> {
    clock = now;
    return runJob(job, { ...deps, config: { ...config, ...over }, now: () => clock }, account);
  }

  function logText(): string {
    return lines.join("\n");
  }

  function expectNoLeak(account: AccountRow, mediaIds: string[]): void {
    const text = logText();
    expect(text).not.toContain("://");
    expect(text).not.toContain("cdninstagram.com");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(VISION_TOKEN);
    expect(text).not.toContain("ランチ営業中");
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
    graphPaths.length = 0;
    graphReplies.clear();
    clock = T0;
    cdnCalls = 0;
    tokenCalls = 0;
    visionCalls = [];
    visionReplies = [];
    visionDelayMs = 0;
    extractCalls = 0;
    extractTimeouts = [];
    extractDelayMs = 0;
    extractBehavior = defaultExtract;
    lines.length = 0;
  });

  afterAll(async () => {
    for (const id of createdAccountIds) await db`delete from public.accounts where id = ${id}`;
    await closeDb(db);
  });

  it("予算（時間）を超えた後は再送せず、残りの本は skipped_by_budget", async () => {
    const account = await newAccount();
    const a = await insertVideo(account.id, 2000); // 2 枚（新しい方）
    const b = await insertVideo(account.id, 2000);
    visionReplies = [{ status: 503 }, { status: 503 }, { status: 503 }];
    visionDelayMs = config.videoTextBudgetMs + 1; // 最初の要求の往復で予算を超える
    expect(await run(account)).toBe("failed");
    expect(visionCalls).toEqual([2]);
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toMatchObject({ status: "failed", error: requestFailedError(503), units_used: 2, attempt_count: 1 });
    expect(await getVideoTextAnalysis(db, b, CONDITION)).toBeUndefined();
    expect((await usageRows(account.id)).map((r) => [r.units, r.http_status, r.ok])).toEqual([[2, 503, false]]);
    expect(logText()).toMatch(/failed=1 requests=1 units=2 .*skipped_by_budget=1/);
    expectNoLeak(account, [a, b]);
  });

  it("取り出しの制限時間: 1 枚には 15 秒を渡し、制限時間切れ（CommandError の code null）なら failed。全体が 3 分を超えたら残りを取り出さず failed", async () => {
    const account = await newAccount();
    const a = await insertVideo(account.id, 2000);
    extractBehavior = async () => {
      throw new CommandError("ffmpeg", null, "killed by timeout");
    };
    expect(await run(account)).toBe("failed");
    expect(FRAME_EXTRACT_TIMEOUT_MS).toBe(15_000);
    expect(extractTimeouts).toEqual([FRAME_EXTRACT_TIMEOUT_MS]);
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toMatchObject({ status: "failed", error: FRAME_EXTRACT_TIMEOUT_ERROR, attempt_count: 1, units_used: 0 });
    expect(visionCalls).toEqual([]);

    // a は 3 時間待つので候補にならない。b の 1 枚目の後で全体の制限（3 分）を超える
    const b = await insertVideo(account.id, 2000);
    extractBehavior = defaultExtract;
    extractDelayMs = VIDEO_TEXT_EXTRACT_BUDGET_MS + 1;
    extractCalls = 0;
    expect(await run(account)).toBe("failed");
    expect(extractCalls).toBe(1);
    expect(await getVideoTextAnalysis(db, b, CONDITION)).toMatchObject({ status: "failed", error: FRAME_EXTRACT_TOO_LONG_ERROR, units_used: 0 });
    expect(visionCalls).toEqual([]);
    expectNoLeak(account, [a, b]);
  });

  it("出力ファイルがない: 末尾でない時刻は failed（フレームを取り出せない）、末尾の時刻は計画から外して success。ffmpeg の終了コードの失敗も同じ", async () => {
    const account = await newAccount();
    const a = await insertVideo(account.id, 3000); // 計画 0, 1000, 2000
    extractBehavior = async (atMs, output) => {
      if (atMs !== 0) await writeFile(output, `JPEG-${atMs}`);
    };
    expect(await run(account)).toBe("failed");
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toMatchObject({ status: "failed", error: FRAME_EXTRACT_ERROR, planned_frame_count: 3, units_used: 0 });
    expect(visionCalls).toEqual([]);

    const b = await insertVideo(account.id, 3000);
    extractBehavior = async (atMs, output) => {
      if (atMs !== 2000) await writeFile(output, `JPEG-${atMs}`); // 末尾（2000 + 1000 >= 3000）は出力なし
    };
    expect(await run(account)).toBe("success");
    const row = await getVideoTextAnalysis(db, b, CONDITION);
    expect(row).toMatchObject({ status: "success", planned_frame_count: 2, ocr_frame_count: 2, units_used: 2 });
    expect((await listStoredFrames(db, row?.id ?? "")).map((f) => f.at_ms)).toEqual([0, 1000]);
    expect(visionCalls).toEqual([2]);

    const c = await insertVideo(account.id, 3000);
    extractBehavior = async (atMs, output) => {
      if (atMs === 2000) throw new CommandError("ffmpeg", 1, "stderr secret");
      await writeFile(output, `JPEG-${atMs}`);
    };
    expect(await run(account)).toBe("success");
    expect(await getVideoTextAnalysis(db, c, CONDITION)).toMatchObject({ status: "success", planned_frame_count: 2, ocr_frame_count: 2 });

    const d = await insertVideo(account.id, 3000);
    extractBehavior = async (atMs, output) => {
      if (atMs === 1000) throw new CommandError("ffmpeg", 1, "stderr secret");
      await writeFile(output, `JPEG-${atMs}`);
    };
    expect(await run(account)).toBe("failed");
    expect(await getVideoTextAnalysis(db, d, CONDITION)).toMatchObject({ status: "failed", error: ffmpegFailedError(1) });
    expect(logText()).not.toContain("stderr secret");
    expectNoLeak(account, [a, b, c, d]);
  });

  it("打ち切り: attempt_count が 5 に達した回に warn が 1 行だけ出て、次の回から候補にならない", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 2000);
    visionReplies = [{ perImage: (i) => (i === 0 ? { error: { code: 3, message: "Bad image data." } } : { fullTextAnnotation: captionAnnotation() }) }];
    expect(await run(account)).toBe("failed");
    expect(logText()).not.toContain(TEXT_GAVE_UP_WARNING);
    const first = await getVideoTextAnalysis(db, id, CONDITION);
    expect(first).toMatchObject({ status: "failed", error: unreadableFramesError(1), attempt_count: 1, ocr_frame_count: 1 });

    await db`update public.video_text_analyses set attempt_count = ${VIDEO_TEXT_MAX_ATTEMPTS - 1} where id = ${first?.id ?? ""}`;
    lines.length = 0;
    visionCalls = [];
    visionReplies = [{ perImage: () => ({ error: { code: 3, message: "Bad image data." } }) }];
    const later = new Date(T0.getTime() + 3 * HOUR_MS);
    expect(await run(account, {}, later)).toBe("failed");
    expect(visionCalls).toEqual([1]); // 足りない 1 枚だけ
    expect(await getVideoTextAnalysis(db, id, CONDITION)).toMatchObject({ status: "failed", attempt_count: VIDEO_TEXT_MAX_ATTEMPTS });
    expect(logText().split(TEXT_GAVE_UP_WARNING)).toHaveLength(2);
    expect(logText()).not.toContain("Bad image data");

    lines.length = 0;
    expect(await run(account, {}, new Date(later.getTime() + 3 * HOUR_MS))).toBe("success");
    expect(logText()).toMatch(/candidates=0 /);
    expect(logText()).not.toContain(TEXT_GAVE_UP_WARNING);
    expectNoLeak(account, [id]);
  });

  it("media_url の取り直し: ない → no_video_url（warn）、VIDEO でない → failed、transient → 取り掛かりの記録のまま、fatal → failed（固定文言）。ダウンロードしない", async () => {
    const account = await newAccount();
    const noUrl = await insertVideo(account.id, 2000);
    const image = await insertVideo(account.id, 2000);
    const transient = await insertVideo(account.id, 2000);
    const fatal = await insertVideo(account.id, 2000);
    graphReplies.set(noUrl, "no_url");
    graphReplies.set(image, "image");
    graphReplies.set(transient, "transient");
    graphReplies.set(fatal, "fatal");
    expect(await run(account)).toBe("failed");
    expect(tokenCalls).toBe(1);
    expect(cdnCalls).toBe(0);
    expect(extractCalls).toBe(0);
    expect(visionCalls).toEqual([]);
    expect(await getVideoTextAnalysis(db, noUrl, CONDITION)).toMatchObject({ status: "no_video_url", error: null, attempt_count: 1 });
    expect(await getVideoTextAnalysis(db, image, CONDITION)).toMatchObject({ status: "failed", error: NOT_VIDEO_ERROR, attempt_count: 1 });
    expect(await getVideoTextAnalysis(db, transient, CONDITION)).toMatchObject({ status: "failed", error: IN_PROGRESS_ERROR, attempt_count: 1 });
    expect(await getVideoTextAnalysis(db, fatal, CONDITION)).toMatchObject({ status: "failed", error: mediaFetchFailedError(100), attempt_count: 1 });
    expect(logText().split(NO_VIDEO_URL_WARNING)).toHaveLength(2);
    expect(logText()).toMatch(/candidates=4 processed=0 resegmented=0 no_video_url=1 failed=3 requests=0 units=0/);
    expect(logText()).not.toContain("does not exist");
    expectNoLeak(account, [noUrl, image, transient, fatal]);

    // transient の本は 3 時間後に再び選ばれ、取り直せれば success（attempt_count 2）
    graphReplies.delete(transient);
    await run(account, {}, new Date(T0.getTime() + 3 * HOUR_MS));
    expect(await getVideoTextAnalysis(db, transient, CONDITION)).toMatchObject({ status: "success", attempt_count: 2, units_used: 2 });
  });

  it("ocr_usage の書き込みに失敗したら以後の要求を送らず、この本は failed（利用記録を書けない）でこの回を終える", async () => {
    const account = await newAccount();
    const a = await insertVideo(account.id, 10_000); // 10 枚 → 8 枚と 2 枚の 2 要求
    const b = await insertVideo(account.id, 2000);
    // このアカウントの ocr_usage への insert だけを check 制約で拒む（終わったら外す）
    const constraint = `test_vt_block_usage_${RUN}`;
    await db.unsafe(`alter table public.ocr_usage add constraint ${constraint} check (account_id <> '${account.id}'::uuid)`);
    try {
      expect(await run(account)).toBe("failed");
    } finally {
      await db.unsafe(`alter table public.ocr_usage drop constraint if exists ${constraint}`);
    }
    expect(visionCalls).toEqual([8]);
    const row = await getVideoTextAnalysis(db, a, CONDITION);
    expect(row).toMatchObject({ status: "failed", error: USAGE_WRITE_ERROR, attempt_count: 1, units_used: 0 });
    expect(await listStoredFrames(db, row?.id ?? "")).toEqual([]);
    expect(await usageRows(account.id)).toEqual([]);
    expect(await getVideoTextAnalysis(db, b, CONDITION)).toBeUndefined();
    expect(logText()).toContain(USAGE_WRITE_ERROR);
    // ログの requests と units は「記録したユニット」なので、記録できなかった要求は数えない（設計 3.7 節）
    expect(logText()).toMatch(/failed=1 requests=0 units=0 /);
    expectNoLeak(account, [a, b]);
  });

  it("images:annotate の 401 は auth で行を取り掛かりの記録のまま終え、残りの本を始めない。ocr_usage は units 0 の 1 行", async () => {
    const account = await newAccount();
    const a = await insertVideo(account.id, 2000);
    const b = await insertVideo(account.id, 2000);
    visionReplies = [{ status: 401, body: { error: { code: 401, message: "secret detail" } } }];
    expect(await run(account)).toBe("failed");
    expect(visionCalls).toEqual([2]);
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toMatchObject({ status: "failed", error: IN_PROGRESS_ERROR, attempt_count: 1, units_used: 0 });
    expect(await getVideoTextAnalysis(db, b, CONDITION)).toBeUndefined();
    expect(await usageRows(account.id)).toEqual([{ media_id: a, units: 0, image_count: 2, http_status: 401, ok: false }]);
    expect(logText()).toContain(authFailedError(401));
    expect(logText()).not.toContain("secret detail");
    expectNoLeak(account, [a, b]);
  });

  it("制限時間切れは再送せず failed（http_status null、units は枚数）。400 は fatal で failed。どちらもこの回は続く", async () => {
    const account = await newAccount();
    const a = await insertVideo(account.id, 2000);
    const b = await insertVideo(account.id, 3000);
    visionReplies = [{ throwTimeout: true }, { status: 400, body: { error: { code: 400, message: "secret detail" } } }];
    expect(await run(account)).toBe("failed");
    expect(visionCalls).toEqual([2, 3]);
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toMatchObject({ status: "failed", error: requestFailedError(undefined), units_used: 2, attempt_count: 1 });
    expect(await getVideoTextAnalysis(db, b, CONDITION)).toMatchObject({ status: "failed", error: requestFailedError(400), units_used: 3, attempt_count: 1 });
    expect((await usageRows(account.id)).map((r) => [r.units, r.http_status, r.ok])).toEqual([
      [2, null, false],
      [3, 400, false],
    ]);
    expect(logText()).not.toContain("secret detail");
    expect(logText()).toMatch(/failed=2 requests=2 units=5 /);
    expectNoLeak(account, [a, b]);
  });

  it("本数の上限: 上限に達した残りは skipped_by_limit。(b) 再区間化は本数に数えない", async () => {
    const account = await newAccount();
    const old = await insertVideo(account.id, 2000); // いちばん新しい。先に success にして (b) にする
    expect(await run(account)).toBe("success");
    const row = await getVideoTextAnalysis(db, old, CONDITION);
    await db`update public.video_text_analyses set segmenter_version = '0' where id = ${row?.id ?? ""}`;
    const a = await insertVideo(account.id, 2000);
    const b = await insertVideo(account.id, 2000);
    lines.length = 0;
    visionCalls = [];
    expect(await run(account, { videoTextMaxPerRun: 1 })).toBe("success");
    expect(visionCalls).toEqual([2]);
    expect(await getVideoTextAnalysis(db, old, CONDITION)).toMatchObject({ status: "success", attempt_count: 1 });
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toMatchObject({ status: "success" });
    expect(await getVideoTextAnalysis(db, b, CONDITION)).toBeUndefined();
    expect(logText()).toMatch(/candidates=3 processed=1 resegmented=1 .*skipped_by_limit=1 /);
  });

  it("足りないフレームが 0 枚なら取り直しもダウンロードも送信もせず、区間化だけで success（attempt_count は増える）", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 2000);
    expect(await run(account)).toBe("success");
    const row = await getVideoTextAnalysis(db, id, CONDITION);
    await db`
      update public.video_text_analyses set status = 'failed', error = 'x', analyzed_at = ${new Date(T0.getTime() - 4 * HOUR_MS)}
      where id = ${row?.id ?? ""}
    `;
    graphPaths.length = 0;
    cdnCalls = 0;
    tokenCalls = 0;
    visionCalls = [];
    extractCalls = 0;
    expect(await run(account)).toBe("success");
    expect(graphPaths).toEqual([]);
    expect(cdnCalls).toBe(0);
    expect(tokenCalls).toBe(0);
    expect(extractCalls).toBe(0);
    expect(visionCalls).toEqual([]);
    expect(await getVideoTextAnalysis(db, id, CONDITION)).toMatchObject({ status: "success", error: null, attempt_count: 2, units_used: 2, ocr_frame_count: 2, segment_count: 1 });
    expect(await usageRows(account.id)).toHaveLength(1);
  });

  it("1 枚で本文の上限を超えるフレームがあれば送らず failed（画像が大きすぎる）", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 1000); // 1 枚
    extractBehavior = async (_atMs, output) => {
      await writeFile(output, Buffer.alloc(7 * 1024 * 1024, 1));
    };
    expect(await run(account)).toBe("failed");
    expect(visionCalls).toEqual([]);
    expect(await getVideoTextAnalysis(db, id, CONDITION)).toMatchObject({ status: "failed", error: IMAGE_TOO_LARGE_ERROR, units_used: 0 });
    expect(await usageRows(account.id)).toEqual([]);
  });

  it("再試行の計画: 元のカットの解析が消えていれば（set null）今の条件で作り直して warn し、計画にないフレームを消して足りない分だけ送る", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 4000, [1500]); // 計画 5 枚: 0, 1000, 1600(cut), 2000, 3000
    visionReplies = [{ perImage: (i) => (i === 0 ? { error: { code: 3 } } : { fullTextAnnotation: captionAnnotation() }) }];
    expect(await run(account)).toBe("failed");
    expect(await getVideoTextAnalysis(db, id, CONDITION)).toMatchObject({ status: "failed", planned_frame_count: 5, ocr_frame_count: 4, units_used: 5 });

    // カットの解析を消す（文字の行の video_analysis_id は set null）→ カットなしで今の条件の解析を入れ直す
    await db`delete from public.video_analyses where media_id = ${id}`;
    await db.begin((tx) =>
      writeVideoAnalysis(tx, { ...failedAnalysisRow(id, DEFAULT_SCENE_THRESHOLD, "x", T0), status: "success", error: null, duration_ms: 4000 }, []),
    );
    lines.length = 0;
    visionCalls = [];
    extractCalls = 0;
    expect(await run(account, {}, new Date(T0.getTime() + 3 * HOUR_MS))).toBe("success");
    expect(logText().split(CUTS_MISSING_WARNING)).toHaveLength(2);
    // 新しい計画は 0, 1000, 2000, 3000。保存済みの 1000, 2000, 3000 は送らず、計画にない 1600 は消え、0 だけ送る
    expect(visionCalls).toEqual([1]);
    expect(extractCalls).toBe(1);
    const row = await getVideoTextAnalysis(db, id, CONDITION);
    expect(row).toMatchObject({ status: "success", attempt_count: 2, planned_frame_count: 4, ocr_frame_count: 4, units_used: 6 });
    expect((await listStoredFrames(db, row?.id ?? "")).map((f) => f.at_ms)).toEqual([0, 1000, 2000, 3000]);
    expectNoLeak(account, [id]);
  });
});

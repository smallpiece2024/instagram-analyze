/**
 * R4.1 の `video_text` ジョブと `db/video-text.ts` の結合テスト（設計 8 章の「単体（ジョブ）」「結合」の行）。
 * 本物の DB（ローカル Supabase）と偽の `fetch`（Graph API、CDN、Google のトークンと `images:annotate`）、偽の ffmpeg で
 * `runJob(job)` を動かす。Vision のユニットは使わない。架空のアカウントを作り、終了時に消す
 */
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import type { AccountRow, JobRunRow } from "../../src/db/types.js";
import { writeVideoAnalysis } from "../../src/db/video.js";
import { getVideoTextAnalysis, IN_PROGRESS_ERROR, listStoredFrames } from "../../src/db/video-text.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import { NO_FFMPEG_ERROR } from "../../src/jobs/video-analysis.js";
import {
  createVideoTextJob,
  MONTHLY_CAP_WARNING,
  NO_VISION_KEY_ERROR,
  UNIT_LIMIT_WARNING,
  unreadableFramesError,
} from "../../src/jobs/video-text.js";
import { DEFAULT_SCENE_THRESHOLD } from "../../src/lib/ffmpeg.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";
import { ANALYZER_VERSION, failedAnalysisRow } from "../../src/lib/video-analysis.js";
import { FRAME_INTERVAL_MS, OCR_METHOD, OCR_VERSION, SEGMENTER_VERSION, TEXT_ANALYZER_VERSION } from "../../src/lib/video-text.js";
import { authFailedError } from "../../src/lib/vision-client.js";

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

const FAKE_TOKEN = `FAKE_VAULT_TOKEN_VT_${RUN}`;
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

type VisionReply = { status: number; body?: unknown } | { perImage: (index: number) => unknown };

describe.skipIf(!TEST_DATABASE_URL)("jobs/video-text（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let deps: JobDeps;
  const createdAccountIds: string[] = [];
  const lines: string[] = [];
  const graphPaths: string[] = [];
  let cdnCalls = 0;
  let tokenCalls = 0;
  let tokenStatus = 200;
  let visionCalls: number[] = [];
  /** `images:annotate` の応答の列。尽きたら成功（全枚テロップあり） */
  let visionReplies: VisionReply[] = [];
  let extractCalls = 0;
  let toolsOk = true;

  const config: WorkerConfig = {
    databaseUrl: url,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: "FAKE_SERVICE_ROLE_KEY_FOR_VT_TEST",
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
      return json({ id, media_type: "VIDEO", media_url: cdnVideoUrl(id) });
    }
    if (target.hostname.endsWith(".cdninstagram.com")) {
      cdnCalls += 1;
      return new Response(new TextEncoder().encode("FAKE-MP4"), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    if (target.hostname === "oauth2.googleapis.com") {
      tokenCalls += 1;
      if (tokenStatus !== 200) return json({ error: "invalid_grant" }, tokenStatus);
      return json({ access_token: VISION_TOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    if (target.hostname === "vision.googleapis.com") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { requests: unknown[] };
      const count = body.requests.length;
      visionCalls.push(count);
      const reply = visionReplies.shift() ?? { perImage: () => ({ fullTextAnnotation: captionAnnotation() }) };
      if ("perImage" in reply) return json({ responses: Array.from({ length: count }, (_, i) => reply.perImage(i)) });
      return json(reply.body ?? {}, reply.status);
    }
    return new Response("unexpected", { status: 500 });
  };

  const job = createVideoTextJob({
    fetchImpl,
    toolsAvailable: async () => toolsOk,
    extractFrame: async (_input, atMs, output) => {
      extractCalls += 1;
      await writeFile(output, `JPEG-${atMs}`);
    },
    sleep: async () => {},
  });

  async function newAccount(): Promise<AccountRow> {
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_user" }));
    createdAccountIds.push(account.id);
    await db.begin((tx) => upsertCredential(tx, account.id, FAKE_TOKEN, CREDENTIAL));
    return account;
  }

  /** リールと今の条件の success のカットの解析（長さとカットを指定）。戻り値はメディア ID */
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

  async function lastRun(accountId: string): Promise<JobRunRow | undefined> {
    return (await db<JobRunRow[]>`select * from public.job_runs where account_id = ${accountId} and job_name = 'video_text' order by id desc limit 1`)[0];
  }

  async function usageRows(accountId: string): Promise<{ media_id: string | null; units: number; image_count: number; http_status: number | null; ok: boolean }[]> {
    return db`select media_id, units, image_count, http_status, ok from public.ocr_usage where account_id = ${accountId} order by id`;
  }

  function run(account: AccountRow, over: Partial<WorkerConfig> = {}, now: Date = T0): ReturnType<typeof runJob> {
    return runJob(job, { ...deps, config: { ...config, ...over }, now: () => now }, account);
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
    cdnCalls = 0;
    tokenCalls = 0;
    tokenStatus = 200;
    visionCalls = [];
    visionReplies = [];
    extractCalls = 0;
    toolsOk = true;
    lines.length = 0;
  });

  afterAll(async () => {
    for (const id of createdAccountIds) await db`delete from public.accounts where id = ${id}`;
    await closeDb(db);
  });

  it("MAX_PER_RUN = 0: 候補を数えるだけで fetch も ffmpeg も呼ばず、行も失敗も記録しない", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 3000);
    expect(await run(account, { videoTextMaxPerRun: 0 })).toBe("success");
    expect(graphPaths).toEqual([]);
    expect(tokenCalls).toBe(0);
    expect(extractCalls).toBe(0);
    expect(await getVideoTextAnalysis(db, id, CONDITION)).toBeUndefined();
    expect(logText()).toMatch(/job=video_text candidates=1 processed=0 .*units=0 month_units=0/);
    expectNoLeak(account, [id]);
  });

  it("鍵がない・形が不正・ffmpeg がない回は行を書かず recordFailure 1 回で終わる（ダウンロードもトークンも呼ばない）", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 3000);
    // 何も書けずに失敗した回は枠組みが failed にする（items 0、failures 1）
    expect(await run(account, { visionKey: { ok: false, reason: "missing" } })).toBe("failed");
    expect(logText()).toContain(NO_VISION_KEY_ERROR);
    expect(await run(account, { visionKey: { ok: false, reason: "invalid" } })).toBe("failed");
    toolsOk = false;
    expect(await run(account)).toBe("failed");
    expect(logText()).toContain(NO_FFMPEG_ERROR);
    expect(tokenCalls).toBe(0);
    expect(cdnCalls).toBe(0);
    expect(await getVideoTextAnalysis(db, id, CONDITION)).toBeUndefined();
  });

  it("成功の流れ: 計画どおりの枚数を取り出して送り、フレーム・ocr_usage・区間・特徴量が入る。ログに ID、URL、トークン、文字がない", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 4000, [1500]); // 計画: 0, 1000, 1600(cut), 2000, 3000 の 5 枚（1600 と 2000 は 400 ms 離れている）
    expect(await run(account)).toBe("success");
    expect((await lastRun(account.id))?.items_fetched).toBe(1);
    expect(graphPaths).toEqual([id]);
    expect(cdnCalls).toBe(1);
    expect(tokenCalls).toBe(1);
    expect(extractCalls).toBe(5);
    expect(visionCalls).toEqual([5]);
    const row = await getVideoTextAnalysis(db, id, CONDITION);
    expect(row).toMatchObject({
      status: "success",
      error: null,
      attempt_count: 1,
      segmenter_version: SEGMENTER_VERSION,
      duration_ms: 4000,
      image_width: 720,
      image_height: 1280,
      planned_frame_count: 5,
      ocr_frame_count: 5,
      units_used: 5,
      first_text_ms: 0,
      has_text_in_first_3s: true,
      text_coverage_ratio: 1,
      total_text_chars: 6,
      segment_count: 1,
      max_chars_per_frame: 6,
      avg_chars_per_frame: 6,
    });
    const frames = await listStoredFrames(db, row?.id ?? "");
    expect(frames.map((f) => [f.at_ms, f.source, f.error_code])).toEqual([
      [0, "interval", null],
      [1000, "interval", null],
      [1600, "cut", null],
      [2000, "interval", null],
      [3000, "interval", null],
    ]);
    const segments = await db<{ seq: number; text: string; start_ms: number; end_ms: number; is_caption_like: boolean }[]>`
      select seq, text, start_ms, end_ms, is_caption_like from public.video_text_segments where analysis_id = ${row?.id ?? ""} order by seq
    `;
    expect(segments).toEqual([{ seq: 1, text: "ランチ営業中", start_ms: 0, end_ms: 4000, is_caption_like: true }]);
    expect(await usageRows(account.id)).toEqual([{ media_id: id, units: 5, image_count: 5, http_status: 200, ok: true }]);
    expect(logText()).toMatch(/job=video_text candidates=1 processed=1 resegmented=0 no_video_url=0 failed=0 requests=1 units=5 month_units=5/);
    expectNoLeak(account, [id]);
  });

  it("1 回のユニットの上限: 計画だけで超える本は warn して飛ばし、累計で超えたら残りを始めない。行は書かない", async () => {
    const account = await newAccount();
    const big = await insertVideo(account.id, 12_000); // 12 枚（いちばん新しい）
    const small1 = await insertVideo(account.id, 3000); // 3 枚
    const small2 = await insertVideo(account.id, 3000); // 3 枚（いちばん古い）
    // 上限 5: big は 12 > 5 で warn して飛ばす → small1 (3) → small2 は累計 6 > 5 で残りを始めない
    expect(await run(account, { videoTextMaxUnitsPerRun: 5 })).toBe("success");
    expect(await getVideoTextAnalysis(db, big, CONDITION)).toBeUndefined();
    expect(await getVideoTextAnalysis(db, small1, CONDITION)).toMatchObject({ status: "success", units_used: 3 });
    expect(await getVideoTextAnalysis(db, small2, CONDITION)).toBeUndefined();
    expect(logText().split(UNIT_LIMIT_WARNING)).toHaveLength(2);
    expect(logText()).toMatch(/processed=1 .*units=3 .*skipped_by_unit_limit=2/);
    expect((await lastRun(account.id))?.status).toBe("success");
  });

  it("月の上限（ユニット、本数）: 境界で次の回に回し、warn は 1 回だけ、recordFailure なし。(b) の本は上限に関わらず処理する", async () => {
    const account = await newAccount();
    const a = await insertVideo(account.id, 3000);
    const b = await insertVideo(account.id, 3000);
    // 今月に 998 ユニット使った記録 → a の 3 枚で 1001 > 1000
    await db`
      insert into public.ocr_usage (account_id, media_id, ocr_method, ocr_version, requested_at, image_count, units, http_status, ok)
      values (${account.id}, null, ${OCR_METHOD}, ${OCR_VERSION}, ${T0}, 998, 998, 200, true)
    `;
    expect(await run(account)).toBe("success");
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toBeUndefined();
    expect(await getVideoTextAnalysis(db, b, CONDITION)).toBeUndefined();
    expect(logText().split(MONTHLY_CAP_WARNING)).toHaveLength(2);
    expect(logText()).toMatch(/skipped_by_monthly_cap=2/);
    expect((await lastRun(account.id))?.status).toBe("success");
    // 本数の上限: 今月 1 本（b）を送っていて上限 1 → 始めない。上限 2 なら新しい a だけ（997 + 3 = 1000 は上限以内。次の b は超える）
    await db`update public.ocr_usage set media_id = ${b}, units = 997, image_count = 997 where account_id = ${account.id}`;
    lines.length = 0;
    expect(await run(account, { videoTextMonthlyMaxVideos: 1 })).toBe("success");
    expect(logText()).toMatch(/skipped_by_monthly_cap=2/);
    lines.length = 0;
    expect(await run(account, { videoTextMonthlyMaxVideos: 2 })).toBe("success");
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toMatchObject({ status: "success", units_used: 3 });
    expect(await getVideoTextAnalysis(db, b, CONDITION)).toBeUndefined();
    expect(logText()).toMatch(/processed=1 .*month_units=1000 .*skipped_by_monthly_cap=1/);
  });

  it("トークンの 401 は auth で recordFailure し、ダウンロードせず行も書かない", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 3000);
    tokenStatus = 401;
    expect(await run(account)).toBe("failed");
    expect(cdnCalls).toBe(0);
    expect(await getVideoTextAnalysis(db, id, CONDITION)).toBeUndefined();
    expect(logText()).toContain(authFailedError(401));
    expectNoLeak(account, [id]);
  });

  it("429 → 429 → 成功で ocr_usage が 3 行、units の合計は枚数。1 枚ごとの error は failed とフレームの保存、再試行は足りない分だけ送る", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 4000); // 4 枚
    visionReplies = [{ status: 429, body: { error: { code: 429, message: "quota secret" } } }, { status: 429 }];
    expect(await run(account)).toBe("success");
    expect(visionCalls).toEqual([4, 4, 4]);
    expect((await usageRows(account.id)).map((r) => [r.units, r.http_status, r.ok])).toEqual([
      [0, 429, false],
      [0, 429, false],
      [4, 200, true],
    ]);
    expect(await getVideoTextAnalysis(db, id, CONDITION)).toMatchObject({ status: "success", units_used: 4, attempt_count: 1 });
    expect(logText()).not.toContain("quota secret");

    // 1 枚ごとの error: 2 枚目だけ失敗 → failed、フレームは 4 行（1 行は error_code）。3 時間後の再試行は 1 枚だけ送る
    const second = await insertVideo(account.id, 4000);
    visionReplies = [{ perImage: (i) => (i === 1 ? { error: { code: 3, message: "Bad image data." } } : { fullTextAnnotation: captionAnnotation() }) }];
    lines.length = 0;
    visionCalls = [];
    expect(await run(account)).toBe("failed");
    const failed = await getVideoTextAnalysis(db, second, CONDITION);
    expect(failed).toMatchObject({ status: "failed", error: unreadableFramesError(1), attempt_count: 1, ocr_frame_count: 3, units_used: 4, planned_frame_count: 4 });
    const frames = await listStoredFrames(db, failed?.id ?? "");
    expect(frames.map((f) => f.error_code)).toEqual([null, 3, null, null]);
    expect(logText()).not.toContain("Bad image data");
    lines.length = 0;
    visionCalls = [];
    extractCalls = 0;
    expect(await run(account, {}, new Date(T0.getTime() + 3 * HOUR_MS))).toBe("success");
    expect(visionCalls).toEqual([1]);
    expect(extractCalls).toBe(1);
    expect(await getVideoTextAnalysis(db, second, CONDITION)).toMatchObject({ status: "success", attempt_count: 2, ocr_frame_count: 4, units_used: 5, planned_frame_count: 4 });
    expectNoLeak(account, [id, second]);
  });

  it("5xx は 2 回再送してだめなら failed（取り掛かりの記録の文言は上書きされる）。2 本続けて transient ならこの回を終える", async () => {
    const account = await newAccount();
    const a = await insertVideo(account.id, 2000);
    const b = await insertVideo(account.id, 2000);
    const c = await insertVideo(account.id, 2000);
    visionReplies = Array.from({ length: 6 }, () => ({ status: 503 }));
    expect(await run(account)).toBe("failed");
    expect(visionCalls).toEqual([2, 2, 2, 2, 2, 2]);
    // 新しい順 a, b が failed（取り掛かりの文言は上書き済み）、c は始めない
    expect(await getVideoTextAnalysis(db, a, CONDITION)).toMatchObject({ status: "failed", units_used: 6, attempt_count: 1 });
    expect((await getVideoTextAnalysis(db, b, CONDITION))?.error).not.toBe(IN_PROGRESS_ERROR);
    expect(await getVideoTextAnalysis(db, c, CONDITION)).toBeUndefined();
    expect(logText()).toMatch(/failed=2/);
  });

  it("(b) 再区間化: success で segmenter_version が古い行は、fetch を呼ばず区間と特徴量を計算し直し、units_used と attempt_count は変わらない", async () => {
    const account = await newAccount();
    const id = await insertVideo(account.id, 3000);
    expect(await run(account)).toBe("success");
    const before = await getVideoTextAnalysis(db, id, CONDITION);
    await db`update public.video_text_analyses set segmenter_version = '0', first_text_ms = 999, attempt_count = 3 where id = ${before?.id ?? ""}`;
    await db`delete from public.video_text_segments where analysis_id = ${before?.id ?? ""}`;
    graphPaths.length = 0;
    visionCalls = [];
    lines.length = 0;
    expect(await run(account)).toBe("success");
    expect(graphPaths).toEqual([]);
    expect(visionCalls).toEqual([]);
    expect(cdnCalls).toBe(1);
    const after = await getVideoTextAnalysis(db, id, CONDITION);
    expect(after).toMatchObject({ status: "success", segmenter_version: SEGMENTER_VERSION, first_text_ms: 0, units_used: 3, attempt_count: 3, segment_count: 1 });
    const [count] = await db<{ n: number }[]>`select count(*)::int as n from public.video_text_segments where analysis_id = ${after?.id ?? ""}`;
    expect(count?.n).toBe(1);
    expect((await usageRows(account.id)).length).toBe(1);
    expect(logText()).toMatch(/processed=0 resegmented=1 /);
    expect((await lastRun(account.id))?.items_fetched).toBe(0);
  });
});

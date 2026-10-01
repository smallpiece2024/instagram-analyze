import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertAccount } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import { getVideoAnalysis, latestAnalysis, upsertVideoAnalysis, type VideoAnalysisInsert } from "../../src/db/video.js";
import { ANALYZER_VERSION } from "../../src/lib/video-analysis.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** 架空の Instagram アカウント ID（実在しない。先頭 6 桁が 0） */
function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 架空のメディア ID（実在しない。先頭 8 桁が 0） */
function fakeMediaId(): string {
  return "00000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

const THRESHOLD = 0.3;
const OTHER_THRESHOLD = 0.4;

function successRow(mediaId: string, overrides: Partial<VideoAnalysisInsert> = {}): VideoAnalysisInsert {
  return {
    media_id: mediaId,
    analyzer_version: ANALYZER_VERSION,
    scene_threshold: THRESHOLD,
    status: "success",
    error: null,
    analyzed_at: new Date("2026-10-01T12:00:00Z"),
    duration_ms: 15_000,
    width: 1080,
    height: 1920,
    fps: 29.97,
    bitrate: 4_500_000,
    file_size: 8_437_500,
    has_audio: true,
    cut_count: 3,
    avg_scene_ms: 3750,
    first_cut_ms: 1500,
    cuts_in_first_3s: 1,
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)("db/video（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let accountId: string;
  const mediaId = fakeMediaId();

  async function countAnalyses(id: string): Promise<number | undefined> {
    const [row] = await db<{ n: number }[]>`
      select count(*)::int as n from public.video_analyses where media_id = ${id}
    `;
    return row?.n;
  }

  async function countCuts(analysisId: string): Promise<number | undefined> {
    const [row] = await db<{ n: number }[]>`
      select count(*)::int as n from public.video_cuts where analysis_id = ${analysisId}
    `;
    return row?.n;
  }

  async function insertMedia(id: string): Promise<void> {
    const postedAt = new Date("2026-10-01T10:00:00Z");
    const expiresAt = new Date(postedAt.getTime() + 24 * 60 * 60 * 1000);
    await db`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, expires_at)
      values (${id}, ${accountId}, 'VIDEO', 'STORY', ${postedAt}, ${expiresAt})
    `;
  }

  beforeAll(async () => {
    db = connectDb(url);
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    accountId = account.id;
    await insertMedia(mediaId);
  });

  afterAll(async () => {
    await db`delete from public.accounts where id = ${accountId}`;
    // accounts → media → video_analyses → video_cuts と CASCADE で消える
    expect(await countAnalyses(mediaId)).toBe(0);
    await closeDb(db);
  });

  it("同じキーで 2 回 upsert しても video_analyses は 1 行で、id は変わらず、video_cuts が置き換わる（3 本 → 2 本）", async () => {
    const first = await db.begin((tx) =>
      upsertVideoAnalysis(tx, successRow(mediaId), [
        { seq: 1, at_ms: 1500, scene_score: null },
        { seq: 2, at_ms: 4200, scene_score: 0.4567 },
        { seq: 3, at_ms: 9000, scene_score: null },
      ]),
    );
    expect(typeof first).toBe("string");
    expect(first).toMatch(/^\d+$/);
    expect(await countAnalyses(mediaId)).toBe(1);
    expect(await countCuts(first)).toBe(3);

    const second = await db.begin((tx) =>
      upsertVideoAnalysis(
        tx,
        successRow(mediaId, {
          analyzed_at: new Date("2026-10-01T15:00:00Z"),
          cut_count: 2,
          avg_scene_ms: 5000,
          first_cut_ms: 2000,
          cuts_in_first_3s: 1,
          fps: 30,
        }),
        [
          { seq: 1, at_ms: 2000, scene_score: null },
          { seq: 2, at_ms: 8000, scene_score: null },
        ],
      ),
    );
    expect(second).toBe(first);
    expect(await countAnalyses(mediaId)).toBe(1);
    expect(await countCuts(first)).toBe(2);

    const stored = await getVideoAnalysis(db, mediaId, ANALYZER_VERSION, THRESHOLD);
    expect(stored?.row.id).toBe(first);
    expect(stored?.row.analyzed_at).toEqual(new Date("2026-10-01T15:00:00Z"));
    expect(stored?.row.cut_count).toBe(2);
    expect(stored?.row.avg_scene_ms).toBe(5000);
    expect(stored?.row.first_cut_ms).toBe(2000);
    expect(stored?.row.fps).toBe(30);
    expect(stored?.cuts).toEqual([
      { analysis_id: first, seq: 1, at_ms: 2000, scene_score: null },
      { analysis_id: first, seq: 2, at_ms: 8000, scene_score: null },
    ]);
  });

  it("latestAnalysis は status と analyzed_at を返し、なければ undefined", async () => {
    const analyzedAt = new Date("2026-10-01T16:00:00Z");
    await db.begin((tx) =>
      upsertVideoAnalysis(tx, successRow(mediaId, { status: "failed", error: "HTTP 404", analyzed_at: analyzedAt }), []),
    );
    const latest = await latestAnalysis(db, mediaId, ANALYZER_VERSION, THRESHOLD);
    expect(latest).toEqual({ status: "failed", analyzed_at: analyzedAt });

    expect(await latestAnalysis(db, mediaId, "999", THRESHOLD)).toBeUndefined();
    expect(await latestAnalysis(db, mediaId, ANALYZER_VERSION, 0.9)).toBeUndefined();
    expect(await latestAnalysis(db, fakeMediaId(), ANALYZER_VERSION, THRESHOLD)).toBeUndefined();
  });

  it("getVideoAnalysis で numeric と bigint の列が number で返る（fps、scene_threshold、bitrate、file_size、scene_score）", async () => {
    const id = await db.begin((tx) =>
      upsertVideoAnalysis(tx, successRow(mediaId), [
        { seq: 1, at_ms: 1500, scene_score: 0.4567 },
        { seq: 2, at_ms: 4200, scene_score: null },
        { seq: 3, at_ms: 9000, scene_score: 1 },
      ]),
    );
    const stored = await getVideoAnalysis(db, mediaId, ANALYZER_VERSION, THRESHOLD);
    expect(stored).toBeDefined();
    const row = stored?.row;
    expect(row?.id).toBe(id);
    expect(typeof row?.id).toBe("string");
    expect(row?.scene_threshold).toBe(0.3);
    expect(typeof row?.scene_threshold).toBe("number");
    expect(row?.fps).toBe(29.97);
    expect(typeof row?.fps).toBe("number");
    expect(row?.bitrate).toBe(4_500_000);
    expect(typeof row?.bitrate).toBe("number");
    expect(row?.file_size).toBe(8_437_500);
    expect(typeof row?.file_size).toBe("number");
    expect(row?.duration_ms).toBe(15_000);
    expect(row?.width).toBe(1080);
    expect(row?.height).toBe(1920);
    expect(row?.has_audio).toBe(true);
    expect(row?.status).toBe("success");
    expect(row?.error).toBeNull();
    expect(row?.media_id).toBe(mediaId);
    expect(row?.analyzer_version).toBe(ANALYZER_VERSION);

    expect(stored?.cuts).toEqual([
      { analysis_id: id, seq: 1, at_ms: 1500, scene_score: 0.4567 },
      { analysis_id: id, seq: 2, at_ms: 4200, scene_score: null },
      { analysis_id: id, seq: 3, at_ms: 9000, scene_score: 1 },
    ]);
    expect(typeof stored?.cuts[0]?.scene_score).toBe("number");
    expect(typeof stored?.cuts[0]?.analysis_id).toBe("string");
  });

  it("しきい値が違えば別の行になり、カットも別に持つ", async () => {
    const base = await db.begin((tx) =>
      upsertVideoAnalysis(tx, successRow(mediaId), [{ seq: 1, at_ms: 1500, scene_score: null }]),
    );
    const other = await db.begin((tx) =>
      upsertVideoAnalysis(
        tx,
        successRow(mediaId, { scene_threshold: OTHER_THRESHOLD, cut_count: 2, avg_scene_ms: 5000 }),
        [
          { seq: 1, at_ms: 1500, scene_score: null },
          { seq: 2, at_ms: 7000, scene_score: null },
        ],
      ),
    );
    expect(other).not.toBe(base);
    expect(await countAnalyses(mediaId)).toBe(2);
    expect(await countCuts(base)).toBe(1);
    expect(await countCuts(other)).toBe(2);

    const stored = await getVideoAnalysis(db, mediaId, ANALYZER_VERSION, OTHER_THRESHOLD);
    expect(stored?.row.id).toBe(other);
    expect(stored?.row.scene_threshold).toBe(OTHER_THRESHOLD);
    expect(stored?.row.cut_count).toBe(2);
    expect(stored?.cuts.map((c) => c.at_ms)).toEqual([1500, 7000]);

    // 0.3 の行は影響を受けない
    const original = await getVideoAnalysis(db, mediaId, ANALYZER_VERSION, THRESHOLD);
    expect(original?.row.id).toBe(base);
    expect(original?.cuts.map((c) => c.at_ms)).toEqual([1500]);
  });

  it("no_video_url と failed の行（計測値が null、カットなし）を書けて、カットは消える", async () => {
    const id = await db.begin((tx) =>
      upsertVideoAnalysis(tx, successRow(mediaId), [{ seq: 1, at_ms: 1500, scene_score: null }]),
    );
    expect(await countCuts(id)).toBe(1);

    const nullRow: VideoAnalysisInsert = {
      media_id: mediaId,
      analyzer_version: ANALYZER_VERSION,
      scene_threshold: THRESHOLD,
      status: "no_video_url",
      error: null,
      analyzed_at: new Date("2026-10-01T17:00:00Z"),
      duration_ms: null,
      width: null,
      height: null,
      fps: null,
      bitrate: null,
      file_size: null,
      has_audio: null,
      cut_count: null,
      avg_scene_ms: null,
      first_cut_ms: null,
      cuts_in_first_3s: null,
    };
    const again = await db.begin((tx) => upsertVideoAnalysis(tx, nullRow, []));
    expect(again).toBe(id);
    expect(await countCuts(id)).toBe(0);

    const stored = await getVideoAnalysis(db, mediaId, ANALYZER_VERSION, THRESHOLD);
    expect(stored?.row).toEqual({ id, ...nullRow });
    expect(stored?.cuts).toEqual([]);

    await db.begin((tx) => upsertVideoAnalysis(tx, { ...nullRow, status: "failed", error: "タイムアウト" }, []));
    const failed = await getVideoAnalysis(db, mediaId, ANALYZER_VERSION, THRESHOLD);
    expect(failed?.row.status).toBe("failed");
    expect(failed?.row.error).toBe("タイムアウト");
  });

  it("トランザクションがロールバックされると video_analyses も video_cuts も変わらない", async () => {
    const victim = fakeMediaId();
    await insertMedia(victim);
    const error = await db
      .begin(async (tx) => {
        await upsertVideoAnalysis(tx, successRow(victim), [{ seq: 1, at_ms: 1500, scene_score: null }]);
        throw new Error("意図的に失敗させる");
      })
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(await countAnalyses(victim)).toBe(0);
    expect(await getVideoAnalysis(db, victim, ANALYZER_VERSION, THRESHOLD)).toBeUndefined();
  });

  it("media を消すと video_analyses と video_cuts も消える", async () => {
    const victim = fakeMediaId();
    await insertMedia(victim);
    const id = await db.begin((tx) =>
      upsertVideoAnalysis(tx, successRow(victim), [{ seq: 1, at_ms: 1500, scene_score: null }]),
    );
    expect(await countCuts(id)).toBe(1);
    await db`delete from public.media where id = ${victim}`;
    expect(await countAnalyses(victim)).toBe(0);
    expect(await countCuts(id)).toBe(0);
  });
});

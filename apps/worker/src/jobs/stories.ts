/**
 * ストーリーズ（`stories`。設計 5.6 章、13.1 章 P2・P5・P8、13.2 章、13.3 章）。
 * hourly グループの先頭。24 時間で消えるので、一覧 → 消失判定 → サムネイル → 指標 → 動画解析を毎時行う。
 *
 * 流れ:
 * 1. 一覧: `ctx.graph.pages` で `{ig_user_id}/stories` を読み、`STORY` の項目を `media` に upsert（1 ページ 1 トランザクション）。
 *    失敗したページで止め、最初のページから失敗なら何も書かずに終わる（`items 0`、`failures ≥ 1` → `failed`）
 * 2. 消失: 全ページを失敗なく読み切ったときだけ、`expires_at` が 10 分以上先なのに一覧にないストーリーズ（手で削除）に
 *    `gone_at` を入れる（`markGone` の `onlyExpiresAfter`）。消える 10 分前以降のものは一覧になくても正常。
 *    読めなかった項目の `id` も `seenIds` に入れる（一覧にはあった）。一覧が空なのに `gone_at` が入る行が残っていれば
 *    `warn` だけ出して見送る（`EMPTY_LIST_WARNING`）
 * 3. サムネイル: `thumbnail_path` が null の項目を `saveItemThumbnail`（`media-sync.ts`）で保存
 * 4. 指標: 一覧にある**すべて**のストーリーズについて毎回 `media_insight_snapshots` に 1 行（5.5 章の間隔の規則は使わない。
 *    実行ごとに 1 行で、確定値は消える前の最後の行）。`transient` は行を書かず、`fatal` は null の行
 * 5. 動画解析: `media_type = 'VIDEO'` で、同じ解析条件（`ANALYZER_VERSION`、`DEFAULT_SCENE_THRESHOLD`）の結果が `success`
 *    でないものを `analyzeAndStore`（`jobs/video-store.ts`。解析 → 1 本 1 トランザクションの書き込み → `failed` なら
 *    `recordFailure`）。`failed` と `no_video_url` は 3 時間後に再試行（`isAnalysisRetryDue`）。打ち切り（`attempt_count`）は
 *    掛けない（24 時間で一覧から消える。R4 設計 3.6 節）。`media_url` が返らない（P2）ときは `no_video_url` を記録するだけで
 *    失敗に数えない
 *
 * - `items_fetched` はスナップショットを書いた枚数。ログに `videos_analyzed=` と `no_video_url=` も出す
 * - API の呼び出し（`ctx.graph`）、ダウンロード、Storage は `ctx.db.begin` の外で行う（`max: 2`。`framework.ts` の注意）
 * - `RateLimitExceeded` と `AuthError` は捕まえず枠組みに任せる
 * - 署名付き URL（`media_url`、`thumbnail_url`）は DB、ログ、例外に入れない。`video_analyses.error` は固定文言か `ctx.mask` 済み
 * - `export const job` のほかに、テストで `fetch`、`resize`、`probe`、`detect` を差し替えるための `createStoriesJob` を出す
 */
import { markGone, upsertMedia, type MediaUpsert } from "../db/media.js";
import { insertSnapshot, listSnapshotCandidates } from "../db/snapshots.js";
import type { MediaProductType } from "../db/types.js";
import { latestAnalysis } from "../db/video.js";
import { DEFAULT_SCENE_THRESHOLD } from "../lib/ffmpeg.js";
import { elapsedSeconds, storyExpiresAt } from "../lib/time.js";
import { ANALYZER_VERSION, isAnalysisRetryDue, type VideoAnalysisDeps } from "../lib/video-analysis.js";
import type { SaveThumbnailDeps } from "../storage/thumbnails.js";
import type { JobContext, JobDefinition } from "./framework.js";
import type { Tracked } from "./graph-client.js";
import { fetchMediaInsights } from "./media-metrics.js";
import { isMediaId, saveItemThumbnail, toMediaRow, type MediaListItem } from "./media-sync.js";
import { analyzeAndStore } from "./video-store.js";

// R1 から stories.ts が出していた動画の定数と関数（R4 で video-store.ts に移した。既存の import のために出し直す）
export { VIDEO_ANALYSIS_FAILED_ERROR, VIDEO_DOWNLOAD_TIMEOUT_MS, VIDEO_MAX_BYTES, videoDownloadLimits } from "./video-store.js";

/** 一覧の `fields`（設計 5.6 章） */
export const STORIES_LIST_FIELDS = "id,media_type,media_product_type,timestamp,caption,permalink,media_url,thumbnail_url";
/** このジョブが扱う種類 */
export const STORY_PRODUCT_TYPES: readonly MediaProductType[] = ["STORY"];
/** 消失判定の余裕。`expires_at` がこれより先なのに一覧にないものだけを「手で削除」とみなす（設計 5.6 章） */
export const GONE_GRACE_MS = 10 * 60 * 1000;

/** 一覧の項目を行にできなかったときの `recordFailure` の文言 */
export const INVALID_STORY_ITEM_ERROR = "ストーリーズの項目を読めない（ID、種類、日時のいずれかが不正）";
/** 一覧に `STORY` でない項目があったときの `warn` の文言（失敗には数えない） */
export const NOT_STORY_WARNING = "ストーリーズの一覧に STORY 以外の項目があった（無視した）";
/** 動画ストーリーズに `media_url` が返らなかったときの `warn` の文言（P2。失敗には数えない） */
export const NO_VIDEO_URL_WARNING = "動画ストーリーズに media_url が返らなかった（no_video_url を記録した）";
/**
 * 一覧が空（HTTP 200 の `data: []`）なのに、`expires_at` が 10 分以上先のストーリーズが残っているときに消失判定を
 * 見送る `warn` の文言（API の一時的な異常で全部を消失扱いにしないため。`media_sync` と同じ保護）。失敗には数えない
 */
export const EMPTY_LIST_WARNING = "一覧が空のため消失判定を見送った";
const UNKNOWN_ERROR = "不明なエラー";

/** テスト用の差し替え。`fetchImpl` はサムネイルと動画のダウンロード、Storage に使う（Graph API は `JobDeps.fetchImpl`） */
export type StoriesDeps = SaveThumbnailDeps & VideoAnalysisDeps;

/** 一覧の 1 項目を行にしたもの。元 URL は `item` にしかない（行には入れない） */
export interface StoryEntry {
  row: MediaUpsert;
  item: MediaListItem;
}

export interface StoryItemPartition {
  /** `STORY` で、行にできた項目。一覧の順。同じ ID は最初の 1 つだけ */
  stories: StoryEntry[];
  /** `media_product_type` が `STORY` でない項目の数（無視して `warn`） */
  notStory: number;
  /** 行にできなかった項目の数（`recordFailure`） */
  invalid: number;
  /**
   * 行にできなかった項目のうち、`id` がメディア ID の形（`isMediaId`。数字 1〜40 桁）のもの。一覧にはあったので、
   * 消失判定の `seenIds` に入れて `gone_at` を誤って入れないようにする（形が合わない `id` は入れない）
   */
  invalidIds: string[];
}

/**
 * 一覧の項目を振り分ける純粋関数。
 * - `media_product_type` が文字列で `STORY` でない → `notStory`（投稿一覧は `media_sync` が扱うので無視する）
 * - `toMediaRow` が undefined（ID、種類、日時が不正。`media_product_type` がないものも含む）→ `invalid`。
 *   `id` がメディア ID の形なら `invalidIds` にも入れる
 * - それ以外 → `stories`（`expires_at = posted_at + 24h` は `toMediaRow` が埋める）。同じ ID は最初の 1 つだけ
 */
export function partitionStoryItems(items: MediaListItem[], accountId: string): StoryItemPartition {
  const stories: StoryEntry[] = [];
  const seen = new Set<string>();
  const invalidIds: string[] = [];
  let notStory = 0;
  let invalid = 0;
  for (const item of items) {
    if (typeof item.media_product_type === "string" && item.media_product_type !== "STORY") {
      notStory += 1;
      continue;
    }
    const row = toMediaRow(item, accountId);
    if (!row) {
      invalid += 1;
      if (isMediaId(item.id)) invalidIds.push(item.id);
      continue;
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    stories.push({ row, item });
  }
  return { stories, notStory, invalid, invalidIds };
}

/** 空文字と文字列以外は undefined にする（API の JSON なので型を確かめる） */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `ok: false` の `Tracked` を `recordFailure` に渡す */
function recordTrackedFailure(ctx: JobContext, res: Tracked<unknown>): void {
  ctx.recordFailure({
    code: res.error?.code,
    errorClass: res.errorClass ?? "unknown",
    message: res.error?.message ?? UNKNOWN_ERROR,
  });
}

/**
 * 消えていない（`gone_at` が null）ストーリーズのうち、`expires_at`（`posted_at + 24h`）が `after` より先のものの数。
 * 一覧が空だったときに、消失判定で `gone_at` が入る行が残っているかを見る。自然に期限が切れた行は数えない
 * （数えると、ストーリーズがない時間帯に毎時 `warn` が出続ける）
 */
async function countStoriesExpiringAfter(ctx: JobContext, after: Date): Promise<number> {
  const candidates = await listSnapshotCandidates(ctx.db, ctx.account.id, [...STORY_PRODUCT_TYPES]);
  return candidates.filter((m) => storyExpiresAt(m.posted_at).getTime() > after.getTime()).length;
}

/** `stories` のジョブ定義を作る。`deps` はテスト用（省略時は本物の `fetch`、ffmpeg、ffprobe） */
export function createStoriesJob(deps: StoriesDeps = {}): JobDefinition {
  return {
    name: "stories",
    run: async (ctx) => {
      const accountId = ctx.account.id;
      const productTypes = [...STORY_PRODUCT_TYPES];

      // 1. 一覧
      /** 今回の一覧にあったストーリーズ。ID → 行と項目。一覧の順（新しい順） */
      const listed = new Map<string, StoryEntry>();
      /** `thumbnail_path` が null の ID（upsert の戻り）。サムネイルの保存対象 */
      const missingThumbnail = new Set<string>();
      /** 読めなかったが一覧にはあった ID。消失判定の `seenIds` に足す */
      const invalidIds: string[] = [];
      let newCount = 0;
      let pages = 0;
      let notStory = 0;
      let allPagesOk = true;

      for await (const page of ctx.graph.pages<MediaListItem>(`${ctx.account.ig_user_id}/stories`, {
        fields: STORIES_LIST_FIELDS,
      })) {
        if (!page.ok || !page.data) {
          recordTrackedFailure(ctx, page);
          allPagesOk = false;
          break;
        }
        pages += 1;
        const items = Array.isArray(page.data.data) ? page.data.data : [];
        const part = partitionStoryItems(items, accountId);
        for (let i = 0; i < part.invalid; i += 1) {
          ctx.recordFailure({ errorClass: "fatal", message: INVALID_STORY_ITEM_ERROR });
        }
        invalidIds.push(...part.invalidIds);
        notStory += part.notStory;
        const fresh = part.stories.filter((entry) => !listed.has(entry.row.id));
        if (fresh.length === 0) continue;
        const result = await ctx.db.begin((tx) =>
          upsertMedia(
            tx,
            fresh.map((entry) => entry.row),
            ctx.now(),
          ),
        );
        newCount += result.inserted.length;
        for (const entry of fresh) listed.set(entry.row.id, entry);
        for (const id of result.missingThumbnail) missingThumbnail.add(id);
      }
      // 最初のページから失敗したら何も書いていない（items 0、failures ≥ 1 → failed）
      if (pages === 0) return;
      if (notStory > 0) ctx.log.warn({ job: "stories", error: NOT_STORY_WARNING, count: notStory });

      // 2. 消失（全ページを失敗なく読み切ったときだけ）。読めなかった項目の ID も一覧にはあったので seenIds に入れる
      let gone = 0;
      if (allPagesOk) {
        const now = ctx.now();
        const onlyExpiresAfter = new Date(now.getTime() + GONE_GRACE_MS);
        const seenIds = [...listed.keys(), ...invalidIds];
        // 一覧が空なのに gone_at が入る行が残っていれば、API の一時的な異常とみなして見送る（空自体は正常なので失敗にしない）
        const remaining = seenIds.length === 0 ? await countStoriesExpiringAfter(ctx, onlyExpiresAfter) : 0;
        if (remaining > 0) {
          ctx.log.warn({ job: "stories", error: EMPTY_LIST_WARNING, known: remaining });
        } else {
          gone = await ctx.db.begin((tx) => markGone(tx, { accountId, productTypes, seenIds, now, onlyExpiresAfter }));
        }
      }

      // 3. サムネイル（Storage への保存はトランザクションの外。失敗は saveItemThumbnail が recordFailure する）
      let thumbnails = 0;
      for (const id of missingThumbnail) {
        const entry = listed.get(id);
        if (!entry) continue;
        if (await saveItemThumbnail(ctx, entry.item, deps)) thumbnails += 1;
      }

      // 4. 指標（一覧のすべてのストーリーズに毎回 1 行）
      let snapshots = 0;
      let index = 0;
      for (const [id, entry] of listed) {
        index += 1;
        const result = await fetchMediaInsights(ctx, { id, media_product_type: "STORY" }, { job: "stories" });
        // transient（再試行を使い切った）は行を書かない。recordFailure は fetchMediaInsights の中で済んでいる
        if (result.rawResponseId === undefined) continue;
        const rawResponseId = result.rawResponseId;
        const inserted = await ctx.db.begin((tx) =>
          insertSnapshot(tx, {
            media_id: id,
            fetched_at: result.fetchedAt,
            elapsed_seconds: elapsedSeconds(entry.row.posted_at, result.fetchedAt),
            metrics: result.metrics,
            raw_response_id: rawResponseId,
            job_run_id: ctx.jobRunId,
          }),
        );
        if (inserted) {
          ctx.progress.items += 1;
          snapshots += 1;
        }
        ctx.log.debug({ job: "stories", progress: `${index}/${listed.size}` });
      }

      // 5. 動画解析（1 本につき、ダウンロードと ffmpeg はトランザクションの外、行の書き込みは 1 トランザクション）
      let videosAnalyzed = 0;
      let noVideoUrl = 0;
      for (const [id, entry] of listed) {
        if (entry.row.media_type !== "VIDEO") continue;
        const latest = await latestAnalysis(ctx.db, id, ANALYZER_VERSION, DEFAULT_SCENE_THRESHOLD);
        if (!isAnalysisRetryDue(latest, ctx.now())) continue;
        // failed の recordFailure は analyzeAndStore の中で済んでいる
        const { status } = await analyzeAndStore(ctx, { mediaId: id, videoUrl: nonEmptyString(entry.item.media_url) }, deps);
        if (status === "success") {
          videosAnalyzed += 1;
        } else if (status === "no_video_url") {
          noVideoUrl += 1;
          ctx.log.warn({ job: "stories", error: NO_VIDEO_URL_WARNING });
        }
      }

      ctx.log.info({
        job: "stories",
        pages,
        stories: listed.size,
        new: newCount,
        gone,
        thumbnails,
        snapshots,
        videos_analyzed: videosAnalyzed,
        no_video_url: noVideoUrl,
      });
    },
  };
}

export const job: JobDefinition = createStoriesJob();

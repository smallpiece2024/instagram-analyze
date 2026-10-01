/**
 * 投稿一覧の同期（`media_sync`。設計 5.4 章、13.1 章 P7〜P9、13.3 章）。
 *
 * 流れ: 既知の ID を読む → `ctx.graph.pages` で 1 ページずつ読み、行に変換して短いトランザクションで upsert →
 * `--full` で全ページ成功なら `markGone` → サムネイル未保存の項目を Storage に保存（トランザクションの外）。
 *
 * - 差分（既定）: 新しい ID が 1 つもないページで止める（`shouldContinuePaging`）。消失判定はしない
 * - `--full`: 全ページを読む。1 ページでも失敗したら `markGone` を呼ばず `partial`。全ページ成功でも、一覧が空なのに
 *   `gone_at` が null の投稿が残っていれば API の一時的な異常とみなして見送る（`warn` と `recordFailure`。何も書けて
 *   いないので枠組みの規則では `failed`）
 * - サムネイルの元 URL（`thumbnailSource`）: `IMAGE` と `CAROUSEL_ALBUM` は `media_url`、`VIDEO` は `thumbnail_url`。
 *   カルーセルの親に `media_url` がなければ `{id}/children` の子から選ぶ（1 リクエスト増。P9）。失敗しても行は残し、
 *   次回の一覧にあれば再試行する（`upsertMedia` が update でも `thumbnail_path` が null の ID を返す）
 * - 読めない項目（`toMediaRow` が undefined）は `recordFailure` して飛ばすが、`id` の形が正しければ「一覧にあった」
 *   として `seenIds` に入れ、既存の行を誤って消失扱いにしない。`id` の形（`MEDIA_ID_PATTERN`）は Graph のパスと
 *   Storage のパスに埋め込む前の多層防御
 * - `is_collab`、`is_trial_reel`、`is_boosted` は判定できるフィールドがないので null のまま（P7）
 * - 署名付き URL（`media_url`、`thumbnail_url`）は DB、ログ、例外に入れない。失敗の文言は固定
 * - `RateLimitExceeded` と `AuthError` は捕まえず枠組みに任せる。`ctx.db.begin` の中では API を呼ばない
 *
 * `export const job` のほかに、テストで `fetch` と縮小を差し替えるための `createMediaSyncJob` を出す。
 * ストーリーズ（担当 D）は `parseGraphTimestamp`、`toMediaRow`（`STORY` なら `expires_at` も埋める）、
 * `thumbnailSource`、`saveItemThumbnail` を再利用できる
 */
import {
  countActiveMedia,
  listMediaIds,
  markGone,
  setThumbnailPath,
  upsertMedia,
  type MediaUpsert,
} from "../db/media.js";
import type { MediaProductType, MediaType } from "../db/types.js";
import { DownloadError } from "../lib/download.js";
import { storyExpiresAt } from "../lib/time.js";
import {
  saveThumbnail,
  storageConfigFrom,
  storagePath,
  thumbnailDownloadLimits,
  type SaveThumbnailDeps,
} from "../storage/thumbnails.js";
import type { JobContext, JobDefinition } from "./framework.js";
import type { Page, Tracked } from "./graph-client.js";

/** 一覧の `fields`（設計 5.4 章） */
export const MEDIA_LIST_FIELDS = "id,media_type,media_product_type,timestamp,caption,permalink,thumbnail_url,media_url";
/** 1 ページの件数 */
export const MEDIA_PAGE_LIMIT = 50;
/** このジョブが扱う種類。ストーリーズは `stories` ジョブ */
export const POST_PRODUCT_TYPES: readonly MediaProductType[] = ["FEED", "REELS"];
/** カルーセルの子を引くときの `fields` */
export const CHILDREN_FIELDS = "media_type,media_url,thumbnail_url";

/** 一覧の項目を行にできなかったときの `recordFailure` の文言 */
export const INVALID_ITEM_ERROR = "投稿の項目を読めない（ID、種類、日時のいずれかが不正）";
/** サムネイルの元 URL が見つからなかったときの `recordFailure` の文言 */
export const NO_THUMBNAIL_SOURCE_ERROR = "サムネイルの元 URL がない";
/** `--full` で一覧が空なのに `gone_at` が null の投稿が残っているとき、消失判定を見送る文言（`warn` と `recordFailure`） */
export const EMPTY_LIST_ERROR = "一覧が空のため消失判定を見送った";
const UNKNOWN_ERROR = "不明なエラー";

/** `GET {ig_user_id}/media` と `{ig_user_id}/stories` の 1 項目。API の JSON なので、値は使う前に型を確かめる */
export interface MediaListItem {
  id: string;
  media_type?: string;
  media_product_type?: string;
  /** `2026-09-28T12:34:56+0000` の形 */
  timestamp?: string;
  caption?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
}

/** `GET {media_id}/children` の 1 項目 */
export interface MediaChildItem {
  id?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
}

/** テスト用の差し替え（`saveThumbnail` に渡す） */
export type MediaSyncDeps = SaveThumbnailDeps;

/** Instagram のメディア ID の形（数字だけ。実機は 17〜18 桁）。Graph のパスと Storage のパスに埋め込む前に確かめる */
export const MEDIA_ID_PATTERN = /^\d{1,40}$/;

/** `MEDIA_ID_PATTERN` に合う文字列か */
export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_ID_PATTERN.test(value);
}

const GRAPH_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/;
const MEDIA_TYPES: ReadonlySet<string> = new Set<MediaType>(["IMAGE", "VIDEO", "CAROUSEL_ALBUM"]);
const PRODUCT_TYPES: ReadonlySet<string> = new Set<MediaProductType>(["FEED", "REELS", "STORY"]);

/**
 * Graph API の `timestamp`（`2026-09-28T12:34:56+0000`）を `Date` にする。`+0000` は `new Date()` が受けないので
 * `+00:00` に直す。ISO 8601 の形でない、オフセットがない、存在しない日時は `RangeError`（メッセージに入力を含めない）
 */
export function parseGraphTimestamp(s: string): Date {
  if (!GRAPH_TIMESTAMP.test(s)) throw new RangeError("日時の書式が不正（ISO 8601 とタイムゾーンのオフセットが必要）");
  const normalized = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) throw new RangeError("存在しない日時");
  return d;
}

function isMediaType(value: unknown): value is MediaType {
  return typeof value === "string" && MEDIA_TYPES.has(value);
}

function isProductType(value: unknown): value is MediaProductType {
  return typeof value === "string" && PRODUCT_TYPES.has(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 一覧の項目を `media` の行にする。`id` が `MEDIA_ID_PATTERN` に合わない、`media_type` と `media_product_type` が
 * 許容値でない、`timestamp` が読めない項目は undefined（呼び出し側が `recordFailure`）。`caption` と `permalink` が
 * なければ null。`STORY` なら `expires_at = posted_at + 24 時間`（設計 5.6 章）、投稿なら null
 */
export function toMediaRow(item: MediaListItem, accountId: string): MediaUpsert | undefined {
  if (!isMediaId(item.id)) return undefined;
  if (!isMediaType(item.media_type) || !isProductType(item.media_product_type)) return undefined;
  if (typeof item.timestamp !== "string") return undefined;
  let postedAt: Date;
  try {
    postedAt = parseGraphTimestamp(item.timestamp);
  } catch {
    return undefined;
  }
  return {
    id: item.id,
    account_id: accountId,
    media_type: item.media_type,
    media_product_type: item.media_product_type,
    posted_at: postedAt,
    caption: optionalString(item.caption),
    permalink: optionalString(item.permalink),
    expires_at: item.media_product_type === "STORY" ? storyExpiresAt(postedAt) : null,
  };
}

/**
 * サムネイルの元 URL。`IMAGE` と `CAROUSEL_ALBUM` は `media_url`、`VIDEO` は `thumbnail_url`。
 * なければ undefined（カルーセルは呼び出し側が `children` を引く。動画は `media_url` に落とさない）
 */
export function thumbnailSource(item: Pick<MediaListItem, "media_type" | "media_url" | "thumbnail_url">): string | undefined {
  let url: string | undefined;
  switch (item.media_type) {
    case "IMAGE":
    case "CAROUSEL_ALBUM":
      url = item.media_url;
      break;
    case "VIDEO":
      url = item.thumbnail_url;
      break;
    default:
      return undefined;
  }
  return typeof url === "string" && url !== "" ? url : undefined;
}

/** カルーセルの子の一覧から、元 URL のある最初の子の URL（`thumbnailSource` の規則）。なければ undefined */
export function childThumbnailSource(children: Page<MediaChildItem> | undefined): string | undefined {
  if (!children || !Array.isArray(children.data)) return undefined;
  for (const child of children.data) {
    const url = thumbnailSource(child);
    if (url !== undefined) return url;
  }
  return undefined;
}

/** 差分同期を次のページへ進めるか。新しい ID が 1 つもなければ false。空ページは false */
export function shouldContinuePaging(pageIds: string[], knownIds: Set<string>): boolean {
  return pageIds.some((id) => !knownIds.has(id));
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
 * 1 項目のサムネイルを保存して `thumbnail_path` を入れる。保存できたら true。
 * 元 URL がないカルーセルは `{id}/children` を引く（`rate` と `auth` は投げる）。元 URL がない、ダウンロード・縮小・
 * アップロードに失敗、は `recordFailure` して false（行は残り、次回に再試行する）。`setThumbnailPath` の DB の失敗は
 * 投げる（枠組みが `db` として記録する。Storage のオブジェクトは次回の上書きで整合する）
 */
export async function saveItemThumbnail(
  ctx: JobContext,
  item: MediaListItem,
  deps: MediaSyncDeps = {},
): Promise<boolean> {
  let source = thumbnailSource(item);
  if (source === undefined && item.media_type === "CAROUSEL_ALBUM") {
    const children = await ctx.graph.get<Page<MediaChildItem>>(`${item.id}/children`, { fields: CHILDREN_FIELDS });
    if (!children.ok) {
      recordTrackedFailure(ctx, children);
      return false;
    }
    source = childThumbnailSource(children.data);
  }
  if (source === undefined) {
    ctx.recordFailure({ errorClass: "fatal", message: NO_THUMBNAIL_SOURCE_ERROR });
    return false;
  }
  const path = storagePath(ctx.account.id, item.id);
  try {
    await saveThumbnail(
      storageConfigFrom(ctx.config),
      source,
      path,
      thumbnailDownloadLimits(ctx.config.downloadAllowedHosts),
      deps,
    );
  } catch (error) {
    // `saveThumbnail` の例外はすべて固定文言（URL やパスを含まない）
    ctx.recordFailure({
      errorClass: error instanceof DownloadError ? "download" : "unknown",
      message: error instanceof Error ? error.message : UNKNOWN_ERROR,
    });
    return false;
  }
  await setThumbnailPath(ctx.db, item.id, path);
  return true;
}

/** `media_sync` のジョブ定義を作る。`deps` はテスト用（省略時は本物の `fetch` と ffmpeg） */
export function createMediaSyncJob(deps: MediaSyncDeps = {}): JobDefinition {
  return {
    name: "media_sync",
    run: async (ctx) => {
      const accountId = ctx.account.id;
      const full = ctx.options.full === true;
      const productTypes = [...POST_PRODUCT_TYPES];
      const known = await listMediaIds(ctx.db, accountId, productTypes);

      /** 今回の一覧にあった項目（元 URL はここにしかない）。一覧の順（新しい順） */
      const listed = new Map<string, MediaListItem>();
      const seenIds: string[] = [];
      const missingThumbnail = new Set<string>();
      let newCount = 0;
      let pages = 0;
      let allPagesOk = true;

      for await (const page of ctx.graph.pages<MediaListItem>(`${ctx.account.ig_user_id}/media`, {
        fields: MEDIA_LIST_FIELDS,
        limit: MEDIA_PAGE_LIMIT,
      })) {
        if (!page.ok || !page.data) {
          recordTrackedFailure(ctx, page);
          allPagesOk = false;
          break;
        }
        pages += 1;
        const items = Array.isArray(page.data.data) ? page.data.data : [];
        const rows: MediaUpsert[] = [];
        for (const item of items) {
          const row = toMediaRow(item, accountId);
          if (!row) {
            ctx.recordFailure({ errorClass: "fatal", message: INVALID_ITEM_ERROR });
            // 一覧にはあったので、id の形が正しければ消失扱いにしない（形が不正なら seenIds にも入れない）
            if (isMediaId(item.id)) seenIds.push(item.id);
            continue;
          }
          rows.push(row);
          listed.set(row.id, item);
        }
        if (rows.length > 0) {
          const result = await ctx.db.begin((tx) => upsertMedia(tx, rows, ctx.now()));
          ctx.progress.items += rows.length;
          newCount += result.inserted.length;
          for (const id of result.missingThumbnail) missingThumbnail.add(id);
          for (const row of rows) seenIds.push(row.id);
        }
        if (!full && !shouldContinuePaging(rows.map((r) => r.id), known)) break;
      }

      let gone = 0;
      if (full && allPagesOk) {
        // 一覧が空なのに消えていない投稿が残っていれば、API の一時的な異常とみなして消失判定を見送る
        // （全投稿を消失扱いにしない）。何も書けていないので、枠組みの規則（13.2 章）では failed になる
        const active = seenIds.length === 0 ? await countActiveMedia(ctx.db, accountId, productTypes) : 0;
        if (active > 0) {
          ctx.log.warn({ job: "media_sync", error: EMPTY_LIST_ERROR, known: active });
          ctx.recordFailure({ errorClass: "unknown", message: EMPTY_LIST_ERROR });
        } else {
          gone = await ctx.db.begin((tx) => markGone(tx, { accountId, productTypes, seenIds, now: ctx.now() }));
        }
      }

      // サムネイル: 今回の一覧にあり thumbnail_path が null のもの（upsertMedia が insert・update を問わず返すので、
      // 前回までに失敗した項目の再試行も含む）。一覧の順（新しい順）
      let thumbnails = 0;
      for (const [id, item] of listed) {
        if (!missingThumbnail.has(id)) continue;
        if (await saveItemThumbnail(ctx, item, deps)) thumbnails += 1;
      }

      ctx.log.info({ job: "media_sync", mode: full ? "full" : "diff", pages, new: newCount, gone, thumbnails });
    },
  };
}

export const job: JobDefinition = createMediaSyncJob();

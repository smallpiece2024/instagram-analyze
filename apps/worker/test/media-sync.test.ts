/**
 * `jobs/media-sync.ts` の純粋関数と、`storage/thumbnails.ts`、`lib/ffmpeg.ts` の純粋関数（設計 9.1 章）。
 * DB、API、ffmpeg に触らない。ジョブの流れは `test/db/media.test.ts`（結合）で確かめる
 */
import { describe, expect, it } from "vitest";
import { resizeImageArgs, THUMBNAIL_WIDTH } from "../src/lib/ffmpeg.js";
import {
  CHILDREN_FIELDS,
  childThumbnailSource,
  isMediaId,
  MEDIA_ID_PATTERN,
  MEDIA_LIST_FIELDS,
  MEDIA_PAGE_LIMIT,
  parseGraphTimestamp,
  POST_PRODUCT_TYPES,
  shouldContinuePaging,
  thumbnailSource,
  toMediaRow,
  type MediaListItem,
} from "../src/jobs/media-sync.js";
import {
  storageConfigFrom,
  storagePath,
  THUMBNAIL_DOWNLOAD_TIMEOUT_MS,
  THUMBNAIL_SOURCE_MAX_BYTES,
  thumbnailDownloadLimits,
} from "../src/storage/thumbnails.js";

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const CDN = "https://scontent-nrt1-1.cdninstagram.com/v/t51/a.jpg?_nc_ht=x&oe=68F0A1B2&oh=abc";
const CDN_THUMB = "https://scontent-nrt1-1.cdninstagram.com/v/t51/thumb.jpg?oe=1&oh=2";

function item(over: Partial<MediaListItem> = {}): MediaListItem {
  return {
    id: "000000000000001",
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: "2026-09-28T12:34:56+0000",
    caption: "キャプション",
    permalink: "https://www.instagram.com/p/XXXX/",
    media_url: CDN,
    ...over,
  };
}

describe("parseGraphTimestamp", () => {
  it("+0000 の形を UTC の Date にする", () => {
    expect(parseGraphTimestamp("2026-09-28T12:34:56+0000").toISOString()).toBe("2026-09-28T12:34:56.000Z");
  });

  it("+0900 などのオフセットと、Z、+00:00、ミリ秒つきも受ける", () => {
    expect(parseGraphTimestamp("2026-09-28T21:34:56+0900").toISOString()).toBe("2026-09-28T12:34:56.000Z");
    expect(parseGraphTimestamp("2026-09-28T05:34:56-0700").toISOString()).toBe("2026-09-28T12:34:56.000Z");
    expect(parseGraphTimestamp("2026-09-28T12:34:56Z").toISOString()).toBe("2026-09-28T12:34:56.000Z");
    expect(parseGraphTimestamp("2026-09-28T12:34:56+00:00").toISOString()).toBe("2026-09-28T12:34:56.000Z");
    expect(parseGraphTimestamp("2026-09-28T12:34:56.123+0000").toISOString()).toBe("2026-09-28T12:34:56.123Z");
  });

  it("オフセットなし、ISO でない形、存在しない日時は RangeError で、メッセージに入力を含めない", () => {
    for (const bad of ["2026-09-28T12:34:56", "2026-09-28", "Mon Sep 28 2026", "", "2026-13-45T00:00:00+0000", "1759062896"]) {
      let caught: unknown;
      try {
        parseGraphTimestamp(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught, bad).toBeInstanceOf(RangeError);
      if (bad !== "") expect((caught as RangeError).message).not.toContain(bad);
    }
  });
});

describe("toMediaRow", () => {
  it("一覧の項目から media の行へ。投稿は expires_at が null", () => {
    expect(toMediaRow(item(), ACCOUNT_ID)).toEqual({
      id: "000000000000001",
      account_id: ACCOUNT_ID,
      media_type: "IMAGE",
      media_product_type: "FEED",
      posted_at: new Date("2026-09-28T12:34:56Z"),
      caption: "キャプション",
      permalink: "https://www.instagram.com/p/XXXX/",
      expires_at: null,
    });
    const reel = toMediaRow(item({ media_type: "VIDEO", media_product_type: "REELS" }), ACCOUNT_ID);
    expect(reel?.media_type).toBe("VIDEO");
    expect(reel?.media_product_type).toBe("REELS");
    expect(toMediaRow(item({ media_type: "CAROUSEL_ALBUM" }), ACCOUNT_ID)?.media_type).toBe("CAROUSEL_ALBUM");
  });

  it("行に URL（media_url、thumbnail_url）を含めない", () => {
    const row = toMediaRow(item({ thumbnail_url: CDN_THUMB }), ACCOUNT_ID);
    expect(JSON.stringify(row)).not.toContain("cdninstagram.com");
  });

  it("caption と permalink がなければ null。空のキャプションは空文字のまま", () => {
    const row = toMediaRow(item({ caption: undefined, permalink: undefined }), ACCOUNT_ID);
    expect(row?.caption).toBeNull();
    expect(row?.permalink).toBeNull();
    expect(toMediaRow(item({ caption: "" }), ACCOUNT_ID)?.caption).toBe("");
  });

  it("STORY は expires_at が posted_at の 24 時間後", () => {
    const row = toMediaRow(item({ media_product_type: "STORY" }), ACCOUNT_ID);
    expect(row?.expires_at).toEqual(new Date("2026-09-29T12:34:56Z"));
  });

  it("種類が許容値でない、timestamp が読めない、id がない項目は undefined", () => {
    expect(toMediaRow(item({ media_type: "AD" }), ACCOUNT_ID)).toBeUndefined();
    expect(toMediaRow(item({ media_type: undefined }), ACCOUNT_ID)).toBeUndefined();
    expect(toMediaRow(item({ media_product_type: "ADS" }), ACCOUNT_ID)).toBeUndefined();
    expect(toMediaRow(item({ media_product_type: undefined }), ACCOUNT_ID)).toBeUndefined();
    expect(toMediaRow(item({ timestamp: "2026-09-28T12:34:56" }), ACCOUNT_ID)).toBeUndefined();
    expect(toMediaRow(item({ timestamp: "nonsense" }), ACCOUNT_ID)).toBeUndefined();
    expect(toMediaRow(item({ timestamp: undefined }), ACCOUNT_ID)).toBeUndefined();
    expect(toMediaRow(item({ id: "" }), ACCOUNT_ID)).toBeUndefined();
    expect(toMediaRow({ ...item(), id: 123 as unknown as string }, ACCOUNT_ID)).toBeUndefined();
  });

  it("id は数字だけ（1〜40 桁）。パスに埋め込めない形は undefined", () => {
    expect(toMediaRow(item({ id: "1" }), ACCOUNT_ID)?.id).toBe("1");
    expect(toMediaRow(item({ id: "1".repeat(40) }), ACCOUNT_ID)?.id).toBe("1".repeat(40));
    for (const bad of ["abc", "../evil", "1/2", "17841400000000001?x=1", " 1", "1".repeat(41), "１２３"]) {
      expect(toMediaRow(item({ id: bad }), ACCOUNT_ID), bad).toBeUndefined();
    }
  });
});

describe("isMediaId", () => {
  it("数字だけの 1〜40 桁の文字列だけ true", () => {
    expect(isMediaId("17841400000000001")).toBe(true);
    expect(isMediaId("0")).toBe(true);
    expect(isMediaId("")).toBe(false);
    expect(isMediaId("abc")).toBe(false);
    expect(isMediaId("../evil")).toBe(false);
    expect(isMediaId("1".repeat(41))).toBe(false);
    expect(isMediaId(123)).toBe(false);
    expect(isMediaId(undefined)).toBe(false);
    expect(MEDIA_ID_PATTERN.source).toBe("^\\d{1,40}$");
  });
});

describe("thumbnailSource", () => {
  it("IMAGE は media_url、VIDEO は thumbnail_url（media_url には落とさない）、CAROUSEL_ALBUM は親の media_url", () => {
    expect(thumbnailSource(item())).toBe(CDN);
    expect(thumbnailSource(item({ media_type: "VIDEO", media_url: CDN, thumbnail_url: CDN_THUMB }))).toBe(CDN_THUMB);
    expect(thumbnailSource(item({ media_type: "VIDEO", media_url: CDN, thumbnail_url: undefined }))).toBeUndefined();
    expect(thumbnailSource(item({ media_type: "CAROUSEL_ALBUM" }))).toBe(CDN);
  });

  it("カルーセルの media_url がなければ undefined（呼び出し側が children を引く）。空文字と未知の種類も undefined", () => {
    expect(thumbnailSource(item({ media_type: "CAROUSEL_ALBUM", media_url: undefined }))).toBeUndefined();
    expect(thumbnailSource(item({ media_url: "" }))).toBeUndefined();
    expect(thumbnailSource(item({ media_type: "AD" }))).toBeUndefined();
    expect(thumbnailSource({})).toBeUndefined();
  });
});

describe("childThumbnailSource", () => {
  it("元 URL のある最初の子の URL（画像は media_url、動画は thumbnail_url）", () => {
    expect(childThumbnailSource({ data: [{ id: "c1", media_type: "IMAGE", media_url: CDN }] })).toBe(CDN);
    expect(
      childThumbnailSource({
        data: [
          { id: "c1", media_type: "VIDEO", media_url: "https://scontent.cdninstagram.com/v.mp4", thumbnail_url: CDN_THUMB },
          { id: "c2", media_type: "IMAGE", media_url: CDN },
        ],
      }),
    ).toBe(CDN_THUMB);
    expect(
      childThumbnailSource({ data: [{ id: "c1", media_type: "VIDEO" }, { id: "c2", media_type: "IMAGE", media_url: CDN }] }),
    ).toBe(CDN);
  });

  it("子がない、data が配列でない、undefined なら undefined", () => {
    expect(childThumbnailSource({ data: [] })).toBeUndefined();
    expect(childThumbnailSource({ data: [{ id: "c1", media_type: "VIDEO" }] })).toBeUndefined();
    expect(childThumbnailSource({ data: "x" as unknown as [] })).toBeUndefined();
    expect(childThumbnailSource(undefined)).toBeUndefined();
  });
});

describe("shouldContinuePaging", () => {
  const known = new Set(["a", "b", "c"]);

  it("全部既知なら false", () => {
    expect(shouldContinuePaging(["a", "b"], known)).toBe(false);
    expect(shouldContinuePaging(["c"], known)).toBe(false);
  });

  it("1 つでも新規なら true。既知が空なら true", () => {
    expect(shouldContinuePaging(["a", "b", "d"], known)).toBe(true);
    expect(shouldContinuePaging(["d"], new Set())).toBe(true);
  });

  it("空ページは false", () => {
    expect(shouldContinuePaging([], known)).toBe(false);
    expect(shouldContinuePaging([], new Set())).toBe(false);
  });
});

describe("storage/thumbnails の純粋関数", () => {
  it("storagePath は {account_id}/{media_id}.jpg", () => {
    expect(storagePath(ACCOUNT_ID, "000000000000001")).toBe(`${ACCOUNT_ID}/000000000000001.jpg`);
  });

  it("thumbnailDownloadLimits は 20MB、60 秒、渡した許可ホスト", () => {
    expect(thumbnailDownloadLimits(["cdninstagram.com", "fbcdn.net"])).toEqual({
      maxBytes: 20 * 1024 * 1024,
      timeoutMs: 60_000,
      allowedHosts: ["cdninstagram.com", "fbcdn.net"],
    });
    expect(THUMBNAIL_SOURCE_MAX_BYTES).toBeLessThan(200 * 1024 * 1024);
    expect(THUMBNAIL_DOWNLOAD_TIMEOUT_MS).toBe(60_000);
  });

  it("storageConfigFrom は WorkerConfig の URL とキーを使い、バケットは thumbnails", () => {
    expect(storageConfigFrom({ supabaseUrl: "http://127.0.0.1:54321", supabaseServiceRoleKey: "KEY" })).toEqual({
      url: "http://127.0.0.1:54321",
      serviceRoleKey: "KEY",
      bucket: "thumbnails",
    });
  });
});

describe("resizeImageArgs", () => {
  it("設計 3.6 章の ffmpeg の引数（幅 320、縦横比を保つ、1 枚だけ、品質 4）", () => {
    expect(resizeImageArgs("/tmp/in", "/tmp/out.jpg")).toEqual([
      "-hide_banner",
      "-y",
      "-i",
      "/tmp/in",
      "-vf",
      "scale=320:-2",
      "-frames:v",
      "1",
      "-q:v",
      "4",
      "/tmp/out.jpg",
    ]);
    expect(THUMBNAIL_WIDTH).toBe(320);
  });

  it("幅を変えられる", () => {
    expect(resizeImageArgs("in", "out.jpg", 160)).toContain("scale=160:-2");
  });
});

describe("定数", () => {
  it("一覧の fields は設計 5.4 章の 8 項目、limit は 50、対象は FEED と REELS", () => {
    expect(MEDIA_LIST_FIELDS.split(",")).toEqual([
      "id",
      "media_type",
      "media_product_type",
      "timestamp",
      "caption",
      "permalink",
      "thumbnail_url",
      "media_url",
    ]);
    expect(MEDIA_PAGE_LIMIT).toBe(50);
    expect(POST_PRODUCT_TYPES).toEqual(["FEED", "REELS"]);
    expect(CHILDREN_FIELDS.split(",")).toEqual(["media_type", "media_url", "thumbnail_url"]);
  });
});

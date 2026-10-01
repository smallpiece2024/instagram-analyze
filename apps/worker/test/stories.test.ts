/**
 * `jobs/stories.ts` の純粋関数と定数（設計 9.1 章）。DB、API、ffmpeg に触らない。
 * ジョブの流れは `test/db/stories.test.ts`（結合）で確かめる
 */
import { describe, expect, it } from "vitest";
import type { MediaListItem } from "../src/jobs/media-sync.js";
import {
  createStoriesJob,
  EMPTY_LIST_WARNING,
  GONE_GRACE_MS,
  job,
  partitionStoryItems,
  STORIES_LIST_FIELDS,
  STORY_PRODUCT_TYPES,
  VIDEO_DOWNLOAD_TIMEOUT_MS,
  VIDEO_MAX_BYTES,
  videoDownloadLimits,
} from "../src/jobs/stories.js";

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const CDN_IMAGE = "https://scontent-nrt1-1.cdninstagram.com/v/t51/a.jpg?_nc_ht=x&oe=68F0A1B2&oh=abc";
const CDN_VIDEO = "https://scontent-nrt1-1.cdninstagram.com/v/t50/a.mp4?_nc_ht=x&oe=68F0A1B2&oh=abc";

function item(over: Partial<MediaListItem> = {}): MediaListItem {
  return {
    id: "000000000000001",
    media_type: "IMAGE",
    media_product_type: "STORY",
    timestamp: "2026-09-28T12:34:56+0000",
    permalink: "https://www.instagram.com/stories/x/000000000000001/",
    media_url: CDN_IMAGE,
    ...over,
  };
}

describe("partitionStoryItems", () => {
  it("STORY の項目を行にし、expires_at は posted_at + 24 時間。行に URL を含めず、item は元のまま", () => {
    const image = item();
    const video = item({ id: "000000000000002", media_type: "VIDEO", media_url: CDN_VIDEO, thumbnail_url: CDN_IMAGE });
    const part = partitionStoryItems([image, video], ACCOUNT_ID);
    expect(part.notStory).toBe(0);
    expect(part.invalid).toBe(0);
    expect(part.invalidIds).toEqual([]);
    expect(part.stories.map((s) => s.row.id)).toEqual(["000000000000001", "000000000000002"]);
    expect(part.stories[0]?.row).toEqual({
      id: "000000000000001",
      account_id: ACCOUNT_ID,
      media_type: "IMAGE",
      media_product_type: "STORY",
      posted_at: new Date("2026-09-28T12:34:56Z"),
      caption: null,
      permalink: "https://www.instagram.com/stories/x/000000000000001/",
      expires_at: new Date("2026-09-29T12:34:56Z"),
    });
    expect(JSON.stringify(part.stories.map((s) => s.row))).not.toContain("cdninstagram.com");
    expect(part.stories[1]?.item).toBe(video);
    expect(part.stories[1]?.row.media_type).toBe("VIDEO");
  });

  it("STORY でない項目（FEED、REELS）は notStory に数えて行にしない", () => {
    const part = partitionStoryItems(
      [item({ media_product_type: "FEED" }), item({ id: "000000000000002" }), item({ id: "000000000000003", media_product_type: "REELS" })],
      ACCOUNT_ID,
    );
    expect(part.notStory).toBe(2);
    expect(part.invalid).toBe(0);
    expect(part.invalidIds).toEqual([]);
    expect(part.stories.map((s) => s.row.id)).toEqual(["000000000000002"]);
  });

  it("読めない項目（timestamp が不正、種類がない、id が空）は invalid に数え、id がメディア ID の形なら invalidIds に入れる", () => {
    const part = partitionStoryItems(
      [
        item({ timestamp: "2026-09-28T12:34:56" }),
        item({ id: "000000000000002", media_product_type: undefined }),
        item({ id: "000000000000003", media_type: "AD" }),
        item({ id: "" }),
        item({ id: "not-a-media-id", timestamp: "nonsense" }),
        item({ id: "1".repeat(41), timestamp: "nonsense" }),
        item({ id: "000000000000005" }),
      ],
      ACCOUNT_ID,
    );
    expect(part.invalid).toBe(6);
    expect(part.notStory).toBe(0);
    expect(part.invalidIds).toEqual(["000000000000001", "000000000000002", "000000000000003"]);
    expect(part.stories.map((s) => s.row.id)).toEqual(["000000000000005"]);
  });

  it("同じ ID は最初の 1 つだけ。空の一覧は空", () => {
    const part = partitionStoryItems([item({ caption: "first" }), item({ caption: "second" })], ACCOUNT_ID);
    expect(part.stories).toHaveLength(1);
    expect(part.stories[0]?.row.caption).toBe("first");
    expect(partitionStoryItems([], ACCOUNT_ID)).toEqual({ stories: [], notStory: 0, invalid: 0, invalidIds: [] });
  });
});

describe("videoDownloadLimits", () => {
  it("200MB、60 秒、渡した許可ホスト（設計 3.7 章、13.3 章）", () => {
    expect(videoDownloadLimits(["cdninstagram.com", "fbcdn.net"])).toEqual({
      maxBytes: 200 * 1024 * 1024,
      timeoutMs: 60_000,
      allowedHosts: ["cdninstagram.com", "fbcdn.net"],
    });
    expect(VIDEO_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(VIDEO_DOWNLOAD_TIMEOUT_MS).toBe(60_000);
  });
});

describe("createStoriesJob と定数", () => {
  it("createStoriesJob は name が stories の JobDefinition を返し、job も同じ", () => {
    const created = createStoriesJob();
    expect(created.name).toBe("stories");
    expect(typeof created.run).toBe("function");
    expect(created.shouldRun).toBeUndefined();
    expect(created.rateThreshold).toBeUndefined();
    expect(job.name).toBe("stories");
    expect(createStoriesJob({ fetchImpl: async () => new Response("x") }).name).toBe("stories");
  });

  it("一覧の fields は設計 5.6 章の 8 項目、対象は STORY、消失判定の余裕は 10 分", () => {
    expect(STORIES_LIST_FIELDS.split(",")).toEqual([
      "id",
      "media_type",
      "media_product_type",
      "timestamp",
      "caption",
      "permalink",
      "media_url",
      "thumbnail_url",
    ]);
    expect(STORY_PRODUCT_TYPES).toEqual(["STORY"]);
    expect(GONE_GRACE_MS).toBe(10 * 60 * 1000);
    expect(EMPTY_LIST_WARNING).toBe("一覧が空のため消失判定を見送った");
  });
});

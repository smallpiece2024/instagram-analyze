/**
 * `db/media.ts` と `jobs/media-sync.ts` の結合テスト（設計 9.2 章の「各 upsert」「db/media.ts」「jobs/media-sync.ts」
 * 「各ジョブの書き込み経路」の行）。本物の DB（ローカル Supabase）と偽の `fetch`（Graph API、CDN、Storage）、
 * 偽の `resize`（入力をそのままコピー）で動かす。架空のアカウントを作り、終了時に消す（CASCADE で media も消える）。
 * メディア ID は `media.id` が全体で一意なので、実行ごとの乱数を含めて他のテストと衝突しないようにする
 */
import { copyFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import {
  countActiveMedia,
  listMediaIds,
  markGone,
  setThumbnailPath,
  upsertMedia,
  type MediaUpsert,
} from "../../src/db/media.js";
import type { AccountRow, JobRunRow, MediaRow } from "../../src/db/types.js";
import { runJob, type JobDeps, type JobOptions } from "../../src/jobs/framework.js";
import type { Page } from "../../src/jobs/graph-client.js";
import {
  createMediaSyncJob,
  EMPTY_LIST_ERROR,
  INVALID_ITEM_ERROR,
  job as defaultJob,
  NO_THUMBNAIL_SOURCE_ERROR,
  type MediaListItem,
} from "../../src/jobs/media-sync.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";
import { storagePath } from "../../src/storage/thumbnails.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

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
const SERVICE_ROLE_KEY = "FAKE_SERVICE_ROLE_KEY_FOR_MEDIA_TEST";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SOURCE_BYTES = new TextEncoder().encode("FAKE-JPEG-SOURCE");

const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

function cdnUrl(name: string): string {
  return `https://scontent-nrt1-1.cdninstagram.com/v/t51/${name}.jpg?_nc_ht=x&oe=68F0A1B2&oh=abc`;
}

function listItem(id: string, over: Partial<MediaListItem> = {}): MediaListItem {
  return {
    id,
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: "2026-09-28T12:34:56+0000",
    caption: `caption ${id}`,
    permalink: `https://www.instagram.com/p/${id}/`,
    media_url: cdnUrl(id),
    ...over,
  };
}

function listPage(data: MediaListItem[], hasNext: boolean): Page<MediaListItem> {
  return {
    data,
    paging: {
      cursors: { before: "B0", after: "A1" },
      ...(hasNext ? { next: `https://graph.facebook.com/v25.0/x/media?access_token=${FAKE_TOKEN}&after=A1` } : {}),
    },
  };
}

function upsertRow(id: string, accountId: string, over: Partial<MediaUpsert> = {}): MediaUpsert {
  return {
    id,
    account_id: accountId,
    media_type: "IMAGE",
    media_product_type: "FEED",
    posted_at: new Date("2026-09-28T12:34:56Z"),
    caption: "c",
    permalink: null,
    expires_at: null,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function graphError(code: number, message: string): Response {
  return jsonResponse({ error: { message, type: "GraphMethodException", code, error_subcode: 33 } }, 400);
}

function toUrl(input: string | URL | Request): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
}

describe.skipIf(!TEST_DATABASE_URL)("db/media と jobs/media-sync（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let dbAccount: AccountRow;
  let deps: JobDeps;
  const createdAccountIds: string[] = [];
  const lines: string[] = [];

  // 偽の fetch の状態（テストごとに beforeEach で戻す）
  let mediaPages: Record<string, () => Response> = {};
  let childrenReplies: Record<string, () => Response> = {};
  let downloadStatus = 200;
  let storageStatus = 200;
  const storageCalls: { method: string; path: string }[] = [];
  const downloads: string[] = [];

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
    videoMaxPerRun: 5,
    videoBudgetMs: 480_000,
  };

  const STORAGE_PREFIX = "/storage/v1/object/thumbnails/";

  const fetchImpl: typeof fetch = async (input, init) => {
    const target = toUrl(input);
    if (target.hostname === "graph.facebook.com") {
      const [, , id = "", kind] = target.pathname.split("/");
      if (kind === "media") {
        const reply = mediaPages[target.searchParams.get("after") ?? ""];
        return reply ? reply() : graphError(999_999, "ページの用意がない");
      }
      if (kind === "children") {
        const reply = childrenReplies[id];
        return reply ? reply() : graphError(999_999, "children の用意がない");
      }
      return graphError(999_999, "想定しないパス");
    }
    if (target.hostname.endsWith(".cdninstagram.com")) {
      downloads.push(target.pathname);
      return downloadStatus === 200
        ? new Response(SOURCE_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } })
        : new Response("ng", { status: downloadStatus });
    }
    if (target.pathname.startsWith(STORAGE_PREFIX)) {
      storageCalls.push({ method: init?.method ?? "GET", path: target.pathname.slice(STORAGE_PREFIX.length) });
      return new Response(JSON.stringify({ Key: "x" }), { status: storageStatus, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected", { status: 500 });
  };

  const job = createMediaSyncJob({ fetchImpl, resize: (input, output) => copyFile(input, output) });

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

  async function lastRun(accountId: string): Promise<JobRunRow | undefined> {
    return (
      await db<JobRunRow[]>`
        select * from public.job_runs where account_id = ${accountId} and job_name = 'media_sync' order by id desc limit 1
      `
    )[0];
  }

  function logText(): string {
    return lines.join("\n");
  }

  function run(account: AccountRow, options: JobOptions = {}): ReturnType<typeof runJob> {
    return runJob(job, deps, account, options);
  }

  beforeAll(async () => {
    db = connectDb(url);
    dbAccount = await newAccount();
    const secrets = new SecretRegistry();
    secrets.add(config.metaAppSecret);
    secrets.add(config.supabaseServiceRoleKey);
    secrets.addUrlParts(config.databaseUrl);
    secrets.addUrlParts(config.supabaseUrl);
    const log = createLogger("debug", secrets, (line) => lines.push(line));
    deps = { db, config, log, secrets, fetchImpl, sleep: async () => {} };
  });

  beforeEach(() => {
    mediaPages = {};
    childrenReplies = {};
    downloadStatus = 200;
    storageStatus = 200;
    storageCalls.length = 0;
    downloads.length = 0;
    lines.length = 0;
  });

  afterAll(async () => {
    for (const id of createdAccountIds) {
      await db`delete from public.accounts where id = ${id}`;
      const [media] = await db<{ n: number }[]>`select count(*)::int as n from public.media where account_id = ${id}`;
      expect(media?.n).toBe(0);
    }
    await closeDb(db);
  });

  describe("db/media", () => {
    it("upsertMedia を同じ入力で 2 回: 行数不変、inserted は 1 回目だけ、first_seen_at と thumbnail_path を保ち、gone_at は null に戻り、last_synced_at と caption が更新される", async () => {
      const a = fakeMediaId();
      const b = fakeMediaId();
      const t1 = new Date("2026-10-01T00:00:00Z");
      const t2 = new Date("2026-10-01T01:00:00Z");
      const rowA = upsertRow(a, dbAccount.id, { permalink: "https://www.instagram.com/p/A/" });
      const rowB = upsertRow(b, dbAccount.id, { media_type: "VIDEO", media_product_type: "REELS", caption: null });

      const first = await db.begin((tx) => upsertMedia(tx, [rowA, rowB], t1));
      expect(first).toEqual({ inserted: [a, b], missingThumbnail: [a, b] });

      const pathA = storagePath(dbAccount.id, a);
      await setThumbnailPath(db, a, pathA);
      await db`update public.media set gone_at = now() where id = ${b}`;

      const second = await db.begin((tx) =>
        upsertMedia(tx, [{ ...rowA, caption: "changed", media_type: "CAROUSEL_ALBUM" }, rowB], t2),
      );
      expect(second).toEqual({ inserted: [], missingThumbnail: [b] });

      const afterA = await mediaRow(a);
      expect(afterA?.first_seen_at).toEqual(t1);
      expect(afterA?.last_synced_at).toEqual(t2);
      expect(afterA?.thumbnail_path).toBe(pathA);
      expect(afterA?.caption).toBe("changed");
      expect(afterA?.media_type).toBe("CAROUSEL_ALBUM");
      expect(afterA?.permalink).toBe("https://www.instagram.com/p/A/");
      expect(afterA?.gone_at).toBeNull();
      expect(afterA?.expires_at).toBeNull();
      expect(afterA?.is_collab).toBeNull();
      expect(afterA?.is_trial_reel).toBeNull();
      expect(afterA?.is_boosted).toBeNull();

      const afterB = await mediaRow(b);
      expect(afterB?.gone_at).toBeNull();
      expect(afterB?.thumbnail_path).toBeNull();
      expect(afterB?.caption).toBeNull();
      expect(afterB?.first_seen_at).toEqual(t1);
      expect(afterB?.last_synced_at).toEqual(t2);

      const [count] = await db<{ n: number }[]>`select count(*)::int as n from public.media where id in (${a}, ${b})`;
      expect(count?.n).toBe(2);
    });

    it("upsertMedia: 同じ id の重複は最初の 1 つを使い、空配列なら何もしない。STORY の expires_at も入る", async () => {
      const c = fakeMediaId();
      const expires = new Date("2026-09-29T12:34:56Z");
      const result = await db.begin((tx) =>
        upsertMedia(
          tx,
          [
            upsertRow(c, dbAccount.id, { media_product_type: "STORY", expires_at: expires, caption: "first" }),
            upsertRow(c, dbAccount.id, { caption: "second" }),
          ],
          new Date(),
        ),
      );
      expect(result).toEqual({ inserted: [c], missingThumbnail: [c] });
      const row = await mediaRow(c);
      expect(row?.caption).toBe("first");
      expect(row?.media_product_type).toBe("STORY");
      expect(row?.expires_at).toEqual(expires);

      expect(await db.begin((tx) => upsertMedia(tx, [], new Date()))).toEqual({ inserted: [], missingThumbnail: [] });
    });

    it("markGone は seenIds にない行だけを対象にし、productTypes で絞れる。2 回目は 0", async () => {
      const account = await newAccount();
      const [feed1, feed2, reel, story] = [fakeMediaId(), fakeMediaId(), fakeMediaId(), fakeMediaId()];
      await db.begin((tx) =>
        upsertMedia(
          tx,
          [
            upsertRow(feed1, account.id),
            upsertRow(feed2, account.id),
            upsertRow(reel, account.id, { media_type: "VIDEO", media_product_type: "REELS" }),
            upsertRow(story, account.id, { media_product_type: "STORY", expires_at: new Date(Date.now() + 23 * HOUR_MS) }),
          ],
          new Date(),
        ),
      );
      const now = new Date("2026-10-01T10:00:00Z");
      const count = await db.begin((tx) =>
        markGone(tx, { accountId: account.id, productTypes: ["FEED", "REELS"], seenIds: [feed1], now }),
      );
      expect(count).toBe(2);
      expect((await mediaRow(feed1))?.gone_at).toBeNull();
      expect((await mediaRow(feed2))?.gone_at).toEqual(now);
      expect((await mediaRow(reel))?.gone_at).toEqual(now);
      expect((await mediaRow(story))?.gone_at).toBeNull();

      // 既に gone の行は数えない
      expect(
        await db.begin((tx) => markGone(tx, { accountId: account.id, productTypes: ["FEED", "REELS"], seenIds: [feed1], now })),
      ).toBe(0);
      // 他のアカウントの行は触らない
      expect((await mediaRows(dbAccount.id)).every((r) => r.gone_at === null)).toBe(true);
      // seenIds が空なら対象の種類の行すべて
      expect(await db.begin((tx) => markGone(tx, { accountId: account.id, productTypes: ["FEED"], seenIds: [], now }))).toBe(1);
      expect((await mediaRow(feed1))?.gone_at).toEqual(now);
    });

    it("markGone の onlyExpiresAfter は expires_at がそれより後の行だけを対象にする（expires_at が null の行は対象外）", async () => {
      const account = await newAccount();
      const base = new Date("2026-10-01T10:00:00Z");
      const [fresh, expiring, expired, feed] = [fakeMediaId(), fakeMediaId(), fakeMediaId(), fakeMediaId()];
      await db.begin((tx) =>
        upsertMedia(
          tx,
          [
            upsertRow(fresh, account.id, { media_product_type: "STORY", expires_at: new Date(base.getTime() + 2 * HOUR_MS) }),
            upsertRow(expiring, account.id, { media_product_type: "STORY", expires_at: new Date(base.getTime() + 5 * MINUTE_MS) }),
            upsertRow(expired, account.id, { media_product_type: "STORY", expires_at: new Date(base.getTime() - HOUR_MS) }),
            upsertRow(feed, account.id),
          ],
          base,
        ),
      );
      const count = await db.begin((tx) =>
        markGone(tx, {
          accountId: account.id,
          productTypes: ["STORY"],
          seenIds: [],
          now: base,
          onlyExpiresAfter: new Date(base.getTime() + 10 * MINUTE_MS),
        }),
      );
      expect(count).toBe(1);
      expect((await mediaRow(fresh))?.gone_at).toEqual(base);
      expect((await mediaRow(expiring))?.gone_at).toBeNull();
      expect((await mediaRow(expired))?.gone_at).toBeNull();
      expect((await mediaRow(feed))?.gone_at).toBeNull();
    });

    it("listMediaIds は gone_at の有無を問わず productTypes で絞る。countActiveMedia は gone_at が null の行だけを数える", async () => {
      const account = await newAccount();
      const [newer, older, saved, gone, story] = [fakeMediaId(), fakeMediaId(), fakeMediaId(), fakeMediaId(), fakeMediaId()];
      await db.begin((tx) =>
        upsertMedia(
          tx,
          [
            upsertRow(older, account.id, { posted_at: new Date("2026-09-01T00:00:00Z") }),
            upsertRow(newer, account.id, { media_type: "VIDEO", media_product_type: "REELS", posted_at: new Date("2026-09-02T00:00:00Z") }),
            upsertRow(saved, account.id, { posted_at: new Date("2026-09-03T00:00:00Z") }),
            upsertRow(gone, account.id, { posted_at: new Date("2026-09-04T00:00:00Z") }),
            upsertRow(story, account.id, { media_product_type: "STORY", posted_at: new Date("2026-09-05T00:00:00Z") }),
          ],
          new Date(),
        ),
      );
      await setThumbnailPath(db, saved, storagePath(account.id, saved));
      await db`update public.media set gone_at = now() where id = ${gone}`;

      expect(await listMediaIds(db, account.id, ["FEED", "REELS"])).toEqual(new Set([older, newer, saved, gone]));
      expect(await listMediaIds(db, account.id, ["STORY"])).toEqual(new Set([story]));
      expect(await listMediaIds(db, account.id, ["FEED"])).toEqual(new Set([older, saved, gone]));

      // countActiveMedia は gone_at が null の行だけを数える
      expect(await countActiveMedia(db, account.id, ["FEED", "REELS"])).toBe(3);
      expect(await countActiveMedia(db, account.id, ["STORY"])).toBe(1);
      expect(await countActiveMedia(db, dbAccount.id, ["STORY", "FEED", "REELS"])).toBeGreaterThan(0);
      expect(await countActiveMedia(db, account.id, ["FEED"])).toBe(2);
    });
  });

  describe("jobs/media-sync", () => {
    it("export const job は media_sync", () => {
      expect(defaultJob.name).toBe("media_sync");
      expect(job.name).toBe("media_sync");
    });

    it(
      "2 ページ（paging.next あり → なし）で全件入り、サムネイルを保存する。同じ応答の 2 回目は差分モードで 1 ページ目で止まり、行数は変わらない",
      async () => {
        const account = await newAccount();
        const [p1, p2, p3, p4] = [fakeMediaId(), fakeMediaId(), fakeMediaId(), fakeMediaId()];
        mediaPages = {
          "": () =>
            jsonResponse(
              listPage(
                [
                  listItem(p1),
                  listItem(p2, {
                    media_type: "VIDEO",
                    media_product_type: "REELS",
                    media_url: cdnUrl(`${p2}-video`),
                    thumbnail_url: cdnUrl(`${p2}-thumb`),
                  }),
                  listItem(p3, { media_type: "CAROUSEL_ALBUM" }),
                ],
                true,
              ),
            ),
          A1: () => jsonResponse(listPage([listItem(p4, { media_type: "CAROUSEL_ALBUM", media_url: undefined, caption: undefined })], false)),
        };
        childrenReplies = {
          [p4]: () =>
            jsonResponse({
              data: [
                { id: `${p4}-c1`, media_type: "VIDEO", media_url: cdnUrl(`${p4}-c1-video`), thumbnail_url: cdnUrl(`${p4}-c1-thumb`) },
                { id: `${p4}-c2`, media_type: "IMAGE", media_url: cdnUrl(`${p4}-c2`) },
              ],
            }),
        };

        expect(await run(account)).toBe("success");
        let last = await lastRun(account.id);
        expect(last?.status).toBe("success");
        expect(last?.items_fetched).toBe(4);
        expect(last?.api_calls).toBe(3);
        expect(last?.error).toBeNull();

        const rows = await mediaRows(account.id);
        expect(rows.map((r) => r.id).sort()).toEqual([p1, p2, p3, p4].sort());
        for (const row of rows) {
          expect(row.thumbnail_path).toBe(storagePath(account.id, row.id));
          expect(row.posted_at).toEqual(new Date("2026-09-28T12:34:56Z"));
          expect(row.gone_at).toBeNull();
          expect(row.expires_at).toBeNull();
          expect(row.first_seen_at).toBeInstanceOf(Date);
          expect(row.last_synced_at).toBeInstanceOf(Date);
        }
        const reel = rows.find((r) => r.id === p2);
        expect(reel?.media_type).toBe("VIDEO");
        expect(reel?.media_product_type).toBe("REELS");
        expect(reel?.caption).toBe(`caption ${p2}`);
        expect(reel?.permalink).toBe(`https://www.instagram.com/p/${p2}/`);
        expect(rows.find((r) => r.id === p4)?.caption).toBeNull();

        // ダウンロードは画像の media_url、動画の thumbnail_url、カルーセルの先頭の子（動画なら thumbnail_url）
        expect(downloads.sort()).toEqual(
          [`/v/t51/${p1}.jpg`, `/v/t51/${p2}-thumb.jpg`, `/v/t51/${p3}.jpg`, `/v/t51/${p4}-c1-thumb.jpg`].sort(),
        );
        expect(storageCalls.map((c) => c.method)).toEqual(["POST", "POST", "POST", "POST"]);
        expect(storageCalls.map((c) => c.path).sort()).toEqual([p1, p2, p3, p4].map((id) => storagePath(account.id, id)).sort());
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=diff pages=2 new=4 gone=0 thumbnails=4$/m);
        expect(logText()).toMatch(/INFO {2}job=media_sync status=success items=4 calls=3 failures=0/m);

        // 生レスポンスに署名付き URL と paging.next のトークンが残らない
        const raw = await db<{ text: string }[]>`
          select body::text || ' ' || params::text as text from public.raw_api_responses where account_id = ${account.id}
        `;
        expect(raw).toHaveLength(3);
        for (const r of raw) {
          expect(r.text).not.toContain("cdninstagram.com");
          expect(r.text).not.toContain("access_token=");
          expect(r.text).not.toContain(FAKE_TOKEN);
        }

        // 2 回目（差分）: 1 ページ目が全部既知なので 2 ページ目を読まない。サムネイルは保存済みなので触らない
        lines.length = 0;
        expect(await run(account)).toBe("success");
        last = await lastRun(account.id);
        expect(last?.items_fetched).toBe(3);
        expect(last?.api_calls).toBe(1);
        expect(storageCalls).toHaveLength(4);
        expect(downloads).toHaveLength(4);
        expect(await mediaRows(account.id)).toHaveLength(4);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=diff pages=1 new=0 gone=0 thumbnails=0$/m);

        // --full: 全ページを読む。行数は変わらず、消えた投稿もない
        lines.length = 0;
        expect(await run(account, { full: true })).toBe("success");
        last = await lastRun(account.id);
        expect(last?.items_fetched).toBe(4);
        expect(last?.api_calls).toBe(2);
        expect(await mediaRows(account.id)).toHaveLength(4);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=full pages=2 new=0 gone=0 thumbnails=0$/m);
      },
      30_000,
    );

    it(
      "--full で途中のページが fatal なら markGone せず partial。全ページ成功なら一覧にない FEED に gone_at が入り、戻すと null に戻る。差分モードは消失判定をしない",
      async () => {
        const account = await newAccount();
        const old = fakeMediaId();
        const q1 = fakeMediaId();
        await db.begin((tx) => upsertMedia(tx, [upsertRow(old, account.id)], new Date()));
        await setThumbnailPath(db, old, storagePath(account.id, old));

        mediaPages = {
          "": () => jsonResponse(listPage([listItem(q1)], true)),
          A1: () => graphError(100, "Unsupported get request. Object does not exist"),
        };
        expect(await run(account, { full: true })).toBe("partial");
        let last = await lastRun(account.id);
        expect(last?.status).toBe("partial");
        expect(last?.items_fetched).toBe(1);
        expect(last?.api_calls).toBe(2);
        expect(last?.error).toBe("Unsupported get request. Object does not exist");
        expect((await mediaRow(old))?.gone_at).toBeNull();
        expect((await mediaRow(q1))?.thumbnail_path).toBe(storagePath(account.id, q1));
        expect(logText()).toMatch(/WARN {2}job=media_sync status=partial items=1 calls=2 failures=1 .* error_code=100 class=fatal$/m);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=full pages=1 new=1 gone=0 thumbnails=1$/m);

        // 全ページ成功: 一覧にない old に gone_at
        lines.length = 0;
        mediaPages = { "": () => jsonResponse(listPage([listItem(q1)], false)) };
        expect(await run(account, { full: true })).toBe("success");
        expect((await mediaRow(old))?.gone_at).toBeInstanceOf(Date);
        expect((await mediaRow(q1))?.gone_at).toBeNull();
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=full pages=1 new=0 gone=1 thumbnails=0$/m);

        // 一覧に戻れば upsert で null に戻る（行数は変わらない）
        lines.length = 0;
        mediaPages = { "": () => jsonResponse(listPage([listItem(q1), listItem(old)], false)) };
        expect(await run(account, { full: true })).toBe("success");
        expect((await mediaRow(old))?.gone_at).toBeNull();
        expect(await mediaRows(account.id)).toHaveLength(2);
        last = await lastRun(account.id);
        expect(last?.items_fetched).toBe(2);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=full pages=1 new=0 gone=0 thumbnails=0$/m);

        // 差分モードでは一覧にない old を消失にしない
        mediaPages = { "": () => jsonResponse(listPage([listItem(q1)], false)) };
        expect(await run(account)).toBe("success");
        expect((await mediaRow(old))?.gone_at).toBeNull();
      },
      30_000,
    );

    it(
      "サムネイルの保存に失敗しても行は残り partial（class=download）。次回に再試行して保存される。Storage の失敗も partial で、error とログに URL やキーが残らない",
      async () => {
        const account = await newAccount();
        const r1 = fakeMediaId();
        mediaPages = { "": () => jsonResponse(listPage([listItem(r1)], false)) };

        downloadStatus = 404;
        expect(await run(account)).toBe("partial");
        let last = await lastRun(account.id);
        expect(last?.status).toBe("partial");
        expect(last?.items_fetched).toBe(1);
        expect(last?.error).toBe("HTTP 404");
        expect((await mediaRow(r1))?.thumbnail_path).toBeNull();
        expect(storageCalls).toHaveLength(0);
        expect(logText()).toMatch(/WARN {2}job=media_sync status=partial items=1 calls=1 failures=1 .* error_code=none class=download$/m);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=diff pages=1 new=1 gone=0 thumbnails=0$/m);

        // 次回: 一覧は全部既知だが、未保存の項目を再試行する
        lines.length = 0;
        downloadStatus = 200;
        expect(await run(account)).toBe("success");
        expect((await mediaRow(r1))?.thumbnail_path).toBe(storagePath(account.id, r1));
        expect(storageCalls).toEqual([{ method: "POST", path: storagePath(account.id, r1) }]);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=diff pages=1 new=0 gone=0 thumbnails=1$/m);

        // Storage の失敗
        lines.length = 0;
        const r2 = fakeMediaId();
        mediaPages = { "": () => jsonResponse(listPage([listItem(r2), listItem(r1)], false)) };
        storageStatus = 500;
        expect(await run(account)).toBe("partial");
        last = await lastRun(account.id);
        expect(last?.error).toBe("Storage へのアップロードに失敗（HTTP 500）");
        expect((await mediaRow(r2))?.thumbnail_path).toBeNull();
        expect((await mediaRow(r1))?.thumbnail_path).toBe(storagePath(account.id, r1));
        expect(logText()).toMatch(/WARN {2}job=media_sync status=partial items=2 calls=1 failures=1 .* error_code=none class=unknown$/m);

        for (const text of [last?.error ?? "", logText()]) {
          expect(text).not.toContain("cdninstagram.com");
          expect(text).not.toContain("://");
          expect(text).not.toContain(SERVICE_ROLE_KEY);
          expect(text).not.toContain(r2);
          expect(text).not.toContain(account.id);
        }

        // 復旧後は保存される
        storageStatus = 200;
        expect(await run(account)).toBe("success");
        expect((await mediaRow(r2))?.thumbnail_path).toBe(storagePath(account.id, r2));
      },
      30_000,
    );

    it(
      "読めない項目（不正な種類や日時）は recordFailure で飛ばして他の行は書く。元 URL のないカルーセル（children も空）と動画は fatal で記録し、行は残る",
      async () => {
        const account = await newAccount();
        const good = fakeMediaId();
        const carousel = fakeMediaId();
        const video = fakeMediaId();
        mediaPages = {
          "": () =>
            jsonResponse(
              listPage(
                [
                  listItem(fakeMediaId(), { media_type: "AD" }),
                  listItem(good),
                  listItem(fakeMediaId(), { timestamp: "nonsense" }),
                  listItem(carousel, { media_type: "CAROUSEL_ALBUM", media_url: undefined }),
                  listItem(video, { media_type: "VIDEO", media_product_type: "REELS", thumbnail_url: undefined }),
                ],
                false,
              ),
            ),
        };
        childrenReplies = { [carousel]: () => jsonResponse({ data: [] }) };

        expect(await run(account)).toBe("partial");
        const last = await lastRun(account.id);
        expect(last?.items_fetched).toBe(3);
        expect(last?.api_calls).toBe(2);
        expect(last?.error).toBe(NO_THUMBNAIL_SOURCE_ERROR);
        const rows = await mediaRows(account.id);
        expect(rows.map((r) => r.id).sort()).toEqual([good, carousel, video].sort());
        expect(rows.find((r) => r.id === good)?.thumbnail_path).toBe(storagePath(account.id, good));
        expect(rows.find((r) => r.id === carousel)?.thumbnail_path).toBeNull();
        expect(rows.find((r) => r.id === video)?.thumbnail_path).toBeNull();
        expect(logText()).toMatch(/WARN {2}job=media_sync status=partial items=3 calls=2 failures=4 .* error_code=none class=fatal$/m);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=diff pages=1 new=3 gone=0 thumbnails=1$/m);
        expect(INVALID_ITEM_ERROR).not.toBe("");
      },
      30_000,
    );

    it(
      "--full で一覧が空なのに gone_at が null の投稿が残っていれば markGone を見送り、warn（known=件数）と recordFailure で記録する（何も書けないので failed）。残っていなければ見送らない",
      async () => {
        const account = await newAccount();
        const old = fakeMediaId();
        await db.begin((tx) => upsertMedia(tx, [upsertRow(old, account.id)], new Date()));
        mediaPages = { "": () => jsonResponse(listPage([], false)) };

        expect(await run(account, { full: true })).toBe("failed");
        const last = await lastRun(account.id);
        expect(last?.status).toBe("failed");
        expect(last?.items_fetched).toBe(0);
        expect(last?.api_calls).toBe(1);
        expect(last?.error).toBe(EMPTY_LIST_ERROR);
        expect((await mediaRow(old))?.gone_at).toBeNull();
        expect(logText()).toMatch(/WARN {2}job=media_sync error=一覧が空のため消失判定を見送った known=1$/m);
        expect(logText()).toMatch(/WARN {2}job=media_sync status=failed items=0 calls=1 failures=1 .* error_code=none class=unknown$/m);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=full pages=1 new=0 gone=0 thumbnails=0$/m);

        // 差分モードは消失判定をしないので、空の一覧でも見送りにならない
        lines.length = 0;
        expect(await run(account)).toBe("success");
        expect(logText()).not.toContain(EMPTY_LIST_ERROR);
        expect((await mediaRow(old))?.gone_at).toBeNull();

        // 消えていない投稿が残っていなければ（全部 gone 済み）見送らず success
        await db`update public.media set gone_at = now() where id = ${old}`;
        lines.length = 0;
        expect(await run(account, { full: true })).toBe("success");
        expect(logText()).not.toContain(EMPTY_LIST_ERROR);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=full pages=1 new=0 gone=0 thumbnails=0$/m);
      },
      30_000,
    );

    it(
      "--full で有効な項目と読めない項目（既存の投稿）が混在しても、読めない項目は一覧にあったものとして既存の投稿に gone_at が入らない。id の形が不正な項目は飛ばす",
      async () => {
        const account = await newAccount();
        const existing = fakeMediaId();
        const absent = fakeMediaId();
        await db.begin((tx) => upsertMedia(tx, [upsertRow(existing, account.id), upsertRow(absent, account.id)], new Date()));
        const fresh = fakeMediaId();
        mediaPages = {
          "": () =>
            jsonResponse(
              listPage(
                [
                  listItem(fresh),
                  listItem(existing, { media_type: "AD" }),
                  listItem("../evil"),
                  listItem(""),
                  listItem("17841400000000001?x=1"),
                ],
                false,
              ),
            ),
        };

        expect(await run(account, { full: true })).toBe("partial");
        const last = await lastRun(account.id);
        expect(last?.items_fetched).toBe(1);
        expect(last?.api_calls).toBe(1);
        expect(last?.error).toBe(INVALID_ITEM_ERROR);
        // 読めなかったが一覧にはあった既存の投稿は消失扱いにしない。一覧になかった投稿は消失
        expect((await mediaRow(existing))?.gone_at).toBeNull();
        expect((await mediaRow(existing))?.media_type).toBe("IMAGE");
        expect((await mediaRow(absent))?.gone_at).toBeInstanceOf(Date);
        expect((await mediaRow(fresh))?.gone_at).toBeNull();
        expect((await mediaRow(fresh))?.thumbnail_path).toBe(storagePath(account.id, fresh));
        expect(await mediaRows(account.id)).toHaveLength(3);
        expect(logText()).toMatch(/WARN {2}job=media_sync status=partial items=1 calls=1 failures=4 .* error_code=none class=fatal$/m);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=full pages=1 new=1 gone=1 thumbnails=1$/m);
        expect(logText()).not.toContain("evil");
        expect(storageCalls).toEqual([{ method: "POST", path: storagePath(account.id, fresh) }]);
      },
      30_000,
    );

    it(
      "差分モードで 1 ページ目が全部読めない項目なら、新規 0 として 2 ページ目を読まずに止まる（何も書けないので failed）。--full なら 2 ページ目も読む",
      async () => {
        const account = await newAccount();
        const second = fakeMediaId();
        mediaPages = {
          "": () =>
            jsonResponse(
              listPage([listItem(fakeMediaId(), { media_type: "AD" }), listItem(fakeMediaId(), { timestamp: "nonsense" })], true),
            ),
          A1: () => jsonResponse(listPage([listItem(second)], false)),
        };

        expect(await run(account)).toBe("failed");
        let last = await lastRun(account.id);
        expect(last?.status).toBe("failed");
        expect(last?.items_fetched).toBe(0);
        expect(last?.api_calls).toBe(1);
        expect(last?.error).toBe(INVALID_ITEM_ERROR);
        expect(await mediaRows(account.id)).toHaveLength(0);
        expect(logText()).toMatch(/WARN {2}job=media_sync status=failed items=0 calls=1 failures=2 .* error_code=none class=fatal$/m);
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=diff pages=1 new=0 gone=0 thumbnails=0$/m);

        lines.length = 0;
        expect(await run(account, { full: true })).toBe("partial");
        last = await lastRun(account.id);
        expect(last?.items_fetched).toBe(1);
        expect(last?.api_calls).toBe(2);
        expect((await mediaRow(second))?.gone_at).toBeNull();
        expect((await mediaRow(second))?.thumbnail_path).toBe(storagePath(account.id, second));
        expect(logText()).toMatch(/INFO {2}job=media_sync mode=full pages=2 new=1 gone=0 thumbnails=1$/m);
      },
      30_000,
    );

    it("最初のページから失敗したら failed（何も書けていない）", async () => {
      const account = await newAccount();
      mediaPages = { "": () => graphError(100, "Invalid parameter") };
      expect(await run(account)).toBe("failed");
      const last = await lastRun(account.id);
      expect(last?.status).toBe("failed");
      expect(last?.items_fetched).toBe(0);
      expect(last?.api_calls).toBe(1);
      expect(last?.error).toBe("Invalid parameter");
      expect(await mediaRows(account.id)).toHaveLength(0);
      expect(logText()).toMatch(/WARN {2}job=media_sync status=failed items=0 calls=1 failures=1 .* error_code=100 class=fatal$/m);
    });

    it("レート制限のエラーは捕まえずに枠組みへ渡す（1 ページ目で当たれば skipped、消失判定もしない）", async () => {
      const account = await newAccount();
      const old = fakeMediaId();
      await db.begin((tx) => upsertMedia(tx, [upsertRow(old, account.id)], new Date()));
      mediaPages = { "": () => jsonResponse({ error: { message: "Application request limit reached", code: 4 } }, 400) };
      expect(await run(account, { full: true })).toBe("skipped");
      const last = await lastRun(account.id);
      expect(last?.status).toBe("skipped");
      expect(last?.error).toBe("レート制限のエラー（コード 4）");
      expect((await mediaRow(old))?.gone_at).toBeNull();
    });
  });
});

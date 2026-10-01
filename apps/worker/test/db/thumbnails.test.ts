/**
 * `storage/thumbnails.ts` の結合テスト（設計 9.2 章の「storage/thumbnails.ts」の行）。ローカル Supabase の Storage に
 * 本物の `fetch` でアップロードし、同じパスへの上書き、`authenticated` 経由の読み出し、削除を確かめる。
 * `TEST_DATABASE_URL` があるとき（ローカル Supabase が動いているとき）だけ動く。作ったオブジェクトは後始末で消す。
 *
 * URL は `TEST_SUPABASE_URL`（既定 `http://127.0.0.1:54321`）、キーは `TEST_SUPABASE_SERVICE_ROLE_KEY`
 * （既定は Supabase CLI の既定の service_role キー。ローカル専用の公知の値で、`supabase status` の SERVICE_ROLE_KEY）
 */
import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  deleteObject,
  saveThumbnail,
  StorageError,
  storagePath,
  THUMBNAIL_CONTENT_TYPE,
  thumbnailDownloadLimits,
  uploadObject,
  type StorageConfig,
} from "../../src/storage/thumbnails.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SUPABASE_URL = process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:54321";
const LOCAL_DEFAULT_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_DEFAULT_SERVICE_ROLE_KEY;

const encoder = new TextEncoder();

/** 架空のアカウント ID（Storage のパスの先頭。DB の accounts には入れない） */
const FAKE_ACCOUNT_ID = randomUUID();

function fakeMediaId(): string {
  return "000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

function toUrl(input: string | URL | Request): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
}

describe.skipIf(!TEST_DATABASE_URL)("storage/thumbnails（結合、ローカル Supabase の Storage）", () => {
  const cfg: StorageConfig = { url: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, bucket: "thumbnails" };
  const createdPaths: string[] = [];

  /** `authenticated` 経由で読む（画面側と同じ経路）。本文は呼び出し側が消費する */
  async function readObject(path: string): Promise<Response> {
    return fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/thumbnails/${path}`, {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY },
      signal: AbortSignal.timeout(15_000),
    });
  }

  afterAll(async () => {
    for (const path of createdPaths) {
      await deleteObject(cfg, path).catch(() => undefined);
    }
  });

  it("uploadObject → 同じパスに上書き → authenticated で読める → deleteObject で消える", async () => {
    const path = storagePath(FAKE_ACCOUNT_ID, fakeMediaId());
    createdPaths.push(path);

    await uploadObject(cfg, path, encoder.encode("thumb-1"), THUMBNAIL_CONTENT_TYPE);
    await uploadObject(cfg, path, encoder.encode("thumb-2"), THUMBNAIL_CONTENT_TYPE);

    const res = await readObject(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("thumb-2");
    expect(res.headers.get("content-type")).toContain("image/jpeg");

    await deleteObject(cfg, path);
    const gone = await readObject(path);
    expect(gone.ok).toBe(false);
    await gone.text();

    // 2 回目の削除は固定文言で失敗する（キーや URL を含まない）
    let caught: unknown;
    try {
      await deleteObject(cfg, path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).message).toMatch(/^Storage からの削除に失敗（HTTP \d{3}）$/);
    expect((caught as StorageError).message).not.toContain(SERVICE_ROLE_KEY);
  });

  it("saveThumbnail: 偽のダウンロードと偽の resize（コピー）で本物の Storage に保存され、authenticated で読める", async () => {
    const path = storagePath(FAKE_ACCOUNT_ID, fakeMediaId());
    createdPaths.push(path);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (toUrl(input).hostname.endsWith(".cdninstagram.com")) {
        return new Response(encoder.encode("SOURCE-FROM-CDN"), { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return fetch(input, init);
    };
    await saveThumbnail(
      cfg,
      "https://scontent-nrt1-1.cdninstagram.com/v/t51/a.jpg?oe=68F0A1B2&oh=abc",
      path,
      thumbnailDownloadLimits(["cdninstagram.com"]),
      { fetchImpl, resize: (input, output) => copyFile(input, output) },
    );

    const res = await readObject(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SOURCE-FROM-CDN");
    expect(res.headers.get("content-type")).toContain("image/jpeg");

    await deleteObject(cfg, path);
  });

  it("キーが違えばアップロードは固定文言で失敗し、キーや URL を含まない", async () => {
    const path = storagePath(FAKE_ACCOUNT_ID, fakeMediaId());
    createdPaths.push(path);
    let caught: unknown;
    try {
      await uploadObject({ ...cfg, serviceRoleKey: "WRONG_KEY_abcdefghijklmnop" }, path, encoder.encode("x"), THUMBNAIL_CONTENT_TYPE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).message).toMatch(/^Storage へのアップロードに失敗（HTTP \d{3}）$/);
    expect((caught as StorageError).message).not.toContain("WRONG_KEY");
    expect((caught as StorageError).message).not.toContain("://");
    const res = await readObject(path);
    expect(res.ok).toBe(false);
    await res.text();
  });
});

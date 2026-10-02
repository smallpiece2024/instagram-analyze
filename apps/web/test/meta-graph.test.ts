/**
 * `src/lib/meta-graph.ts` の単体テスト。偽の `fetch`（応答キュー）で、ページングの境界と応答の形の異常を確かめる。
 * 正常系の URL・本文・ヘッダは `test/meta-connect.test.ts` が通しで確かめる。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { appSecretProof, debugToken, exchangeCode, getPageToken, listPages } from "../src/lib/meta-graph";

type Reply = () => Response;

interface Call {
  url: URL;
  method: string;
  body: string | undefined;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const ok = (body: unknown): Reply => () => jsonResponse(body);

describe("meta-graph", () => {
  const replies: Reply[] = [];
  const calls: Call[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    const reply = replies.shift();
    if (!reply) return jsonResponse({ error: { message: "応答の用意がない", code: 999_999 } }, { status: 400 });
    return reply();
  };

  const options = { graphApiVersion: "v25.0", appSecret: "APP_SECRET_FOR_PROOF", fetchImpl };

  beforeEach(() => {
    replies.length = 0;
    calls.length = 0;
  });

  describe("listPages", () => {
    it("paging.next があっても cursors.after がなければ 1 ページで止める", async () => {
      replies.push(ok({ data: [{ id: "1" }], paging: { next: "https://graph.facebook.com/next" } }));
      expect(await listPages("USER_TOKEN", options)).toEqual({ ok: true, data: [{ id: "1" }] });
      expect(calls).toHaveLength(1);
    });

    it("cursors.after が空文字でも止める", async () => {
      replies.push(ok({ data: [{ id: "1" }], paging: { cursors: { after: "" }, next: "https://graph.facebook.com/next" } }));
      expect(await listPages("USER_TOKEN", options)).toEqual({ ok: true, data: [{ id: "1" }] });
      expect(calls).toHaveLength(1);
    });

    it("next がなければ after があっても止める", async () => {
      replies.push(ok({ data: [{ id: "1" }], paging: { cursors: { after: "A" } } }));
      expect(await listPages("USER_TOKEN", options)).toEqual({ ok: true, data: [{ id: "1" }] });
      expect(calls).toHaveLength(1);
    });

    it("2 ページ目は after を付けて読み、data を連結する", async () => {
      replies.push(
        ok({ data: [{ id: "1" }], paging: { cursors: { after: "A1" }, next: "https://graph.facebook.com/next" } }),
        ok({ data: [{ id: "2" }, { id: "3" }] }),
      );
      expect(await listPages("USER_TOKEN", options)).toEqual({ ok: true, data: [{ id: "1" }, { id: "2" }, { id: "3" }] });
      expect(calls).toHaveLength(2);
      expect(calls[0].url.searchParams.has("after")).toBe(false);
      expect(calls[1].url.searchParams.get("after")).toBe("A1");
    });

    it("2 ページ目の data が配列でなければ失敗（status 200、code なし）", async () => {
      replies.push(
        ok({ data: [{ id: "1" }], paging: { cursors: { after: "A1" }, next: "https://graph.facebook.com/next" } }),
        ok({ data: "broken" }),
      );
      expect(await listPages("USER_TOKEN", options)).toEqual({ ok: false, status: 200 });
    });

    it("1 ページ目の本文が配列や null なら失敗", async () => {
      replies.push(ok([]));
      expect(await listPages("USER_TOKEN", options)).toEqual({ ok: false, status: 200 });
      replies.push(ok(null));
      expect(await listPages("USER_TOKEN", options)).toEqual({ ok: false, status: 200 });
    });
  });

  describe("call の異常系（exchangeCode で確かめる）", () => {
    const input = { appId: "123456", appSecret: "SECRET", redirectUri: "http://localhost:3000/api/meta/callback", code: "CODE" };

    it("非 2xx で JSON でない本文は status だけ（code なし）", async () => {
      replies.push(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
      expect(await exchangeCode(input, options)).toEqual({ ok: false, status: 502 });
    });

    it("非 2xx で error 本文はコードつき", async () => {
      replies.push(() => jsonResponse({ error: { message: "x", code: 100 } }, { status: 400 }));
      expect(await exchangeCode(input, options)).toEqual({ ok: false, status: 400, code: 100 });
    });

    it("2xx でも error があれば失敗（code が数値でなければ undefined）", async () => {
      replies.push(ok({ error: { message: "x", code: "100" } }));
      expect(await exchangeCode(input, options)).toEqual({ ok: false, status: 200, code: undefined });
      replies.push(ok({ error: "x" }));
      expect(await exchangeCode(input, options)).toEqual({ ok: false, status: 200, code: undefined });
    });

    it("2xx で JSON でない本文は status だけ", async () => {
      replies.push(() => new Response("not json", { status: 200 }));
      expect(await exchangeCode(input, options)).toEqual({ ok: false, status: 200 });
    });

    it("fetch が例外を投げたら status 0（例外は外に出さない）", async () => {
      replies.push(() => {
        throw new TypeError("fetch failed");
      });
      expect(await exchangeCode(input, options)).toEqual({ ok: false, status: 0 });
    });

    it("POST の本文に client_secret と code を入れ、URL のクエリには何も付けない", async () => {
      replies.push(ok({ access_token: "T" }));
      expect(await exchangeCode(input, options)).toEqual({ ok: true, data: { access_token: "T" } });
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url.search).toBe("");
      expect(new URLSearchParams(calls[0].body).get("client_secret")).toBe("SECRET");
      expect(new URLSearchParams(calls[0].body).get("code")).toBe("CODE");
    });
  });

  describe("getPageToken / debugToken", () => {
    it("getPageToken は access_token が文字列のときだけ ok", async () => {
      replies.push(ok({ id: "1" }));
      expect(await getPageToken("1", "USER_TOKEN", options)).toEqual({ ok: false, status: 200 });
      replies.push(ok({ id: "1", access_token: "" }));
      expect(await getPageToken("1", "USER_TOKEN", options)).toEqual({ ok: false, status: 200 });
      replies.push(ok({ id: "1", access_token: "PAGE" }));
      expect(await getPageToken("1", "USER_TOKEN", options)).toEqual({ ok: true, data: "PAGE" });
    });

    it("debugToken は data.data がオブジェクトのときだけ ok", async () => {
      replies.push(ok({}));
      expect(await debugToken("PAGE", "APP", options)).toEqual({ ok: false, status: 200 });
      replies.push(ok({ data: [] }));
      expect(await debugToken("PAGE", "APP", options)).toEqual({ ok: false, status: 200 });
      replies.push(ok({ data: { is_valid: true, type: "PAGE" } }));
      expect(await debugToken("PAGE", "APP", options)).toEqual({ ok: true, data: { is_valid: true, type: "PAGE" } });
    });
  });
});

describe("appsecret_proof（R2 設計 Q6、10.1 章）", () => {
  const SECRET = "APP_SECRET_FOR_PROOF";
  const expected = (token: string) => createHmac("sha256", SECRET).update(token).digest("hex");

  it("既知のベクトル: HMAC-SHA256(key = app_secret, message = token) の 16 進", () => {
    // key "key"、message "The quick brown fox jumps over the lazy dog" の HMAC-SHA256（RFC の例として広く使われる値）
    expect(appSecretProof("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
    expect(appSecretProof(SECRET, "T")).toBe(expected("T"));
    expect(appSecretProof(SECRET, "T")).toMatch(/^[0-9a-f]{64}$/);
  });

  const replies: Reply[] = [];
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    const reply = replies.shift();
    return reply ? reply() : jsonResponse({ error: { message: "応答の用意がない", code: 999_999 } }, { status: 400 });
  };
  const options = { graphApiVersion: "v25.0", appSecret: SECRET, fetchImpl };

  beforeEach(() => {
    replies.length = 0;
    calls.length = 0;
  });

  it("me/accounts と {page_id} はユーザートークン、debug_token はアプリトークンで計算し、交換には付けない", async () => {
    replies.push(ok({ data: [] }), ok({ access_token: "PAGE_T" }), ok({ data: { is_valid: true } }), ok({ access_token: "S" }));
    await listPages("USER_T", options);
    await getPageToken("123", "USER_T", options);
    await debugToken("PAGE_T", `123456|${SECRET}`, options);
    await exchangeCode({ appId: "123456", appSecret: SECRET, redirectUri: "http://localhost:3000/api/meta/callback", code: "CODE" }, options);
    expect(calls[0].url.searchParams.get("appsecret_proof")).toBe(expected("USER_T"));
    expect(calls[1].url.searchParams.get("appsecret_proof")).toBe(expected("USER_T"));
    expect(calls[2].url.searchParams.get("appsecret_proof")).toBe(expected(`123456|${SECRET}`));
    expect(calls[3].url.searchParams.has("appsecret_proof")).toBe(false);
    for (const call of calls) expect(call.url.toString()).not.toContain(SECRET.slice(0, 8));
  });
});

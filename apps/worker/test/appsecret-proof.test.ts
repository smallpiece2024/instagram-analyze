/**
 * `appsecret_proof`（R2 設計 5.6 章 Q6、10.1 章）: 既知のベクトル、呼び出しごとの計算元、`params` に残らない、ログでマスク。
 * 偽の `fetch` で URL を捕まえる。API には触らない
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stripSecretParams } from "../src/jobs/graph-client.js";
import { appSecretProof, GraphClient } from "../src/lib/graph.js";
import { sanitizeForLog, SecretRegistry } from "../src/lib/log.js";

const APP_SECRET = "secret";
const PAGE_TOKEN = "EAAPAGETOKEN0123456789abcdef";
const APP_TOKEN = `123456|${APP_SECRET}`;

function hmacHex(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

/** 呼び出しの URL と Authorization を記録する偽の fetch */
function capture(): { fetchImpl: typeof fetch; calls: { url: URL; authorization: string | undefined }[] } {
  const calls: { url: URL; authorization: string | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") ?? undefined });
    return new Response(JSON.stringify({ data: { is_valid: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

describe("appSecretProof", () => {
  it("既知のベクトル: key=secret、message=token の HMAC-SHA256 の 16 進（Node の crypto と一致）", () => {
    const expected = hmacHex("secret", "token");
    expect(appSecretProof("secret", "token")).toBe(expected);
    expect(appSecretProof("secret", "token")).toMatch(/^[0-9a-f]{64}$/);
    // 鍵と message を取り違えていない
    expect(appSecretProof("secret", "token")).not.toBe(hmacHex("token", "secret"));
  });
});

describe("GraphClient と appsecret_proof", () => {
  it("通常の呼び出しはページトークンで計算した proof をクエリに付け、トークン自体は URL に載せない", async () => {
    const { fetchImpl, calls } = capture();
    const client = new GraphClient(PAGE_TOKEN, "v25.0", 0, fetchImpl, 30_000, APP_SECRET);
    await client.get("me/media", { fields: "id", limit: 50 });
    const call = calls[0];
    expect(call?.url.searchParams.get("appsecret_proof")).toBe(hmacHex(APP_SECRET, PAGE_TOKEN));
    expect(call?.url.searchParams.get("fields")).toBe("id");
    expect(call?.url.searchParams.has("access_token")).toBe(false);
    expect(call?.url.href).not.toContain(PAGE_TOKEN);
    expect(call?.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
  });

  it("debug_token はアプリトークン（app_id|app_secret）で計算する。input_token はページトークンのまま", async () => {
    const { fetchImpl, calls } = capture();
    const client = new GraphClient(PAGE_TOKEN, "v25.0", 0, fetchImpl, 30_000, APP_SECRET);
    await client.debugToken(APP_TOKEN);
    const call = calls[0];
    expect(call?.url.pathname).toBe("/v25.0/debug_token");
    expect(call?.url.searchParams.get("appsecret_proof")).toBe(hmacHex(APP_SECRET, APP_TOKEN));
    expect(call?.url.searchParams.get("appsecret_proof")).not.toBe(hmacHex(APP_SECRET, PAGE_TOKEN));
    expect(call?.url.searchParams.get("input_token")).toBe(PAGE_TOKEN);
    expect(call?.authorization).toBe(`Bearer ${APP_TOKEN}`);
  });

  it("tokenOverride があればそのトークンで計算する", async () => {
    const { fetchImpl, calls } = capture();
    const client = new GraphClient(PAGE_TOKEN, "v25.0", 0, fetchImpl, 30_000, APP_SECRET);
    await client.get("me", {}, "OTHER_TOKEN");
    expect(calls[0]?.url.searchParams.get("appsecret_proof")).toBe(hmacHex(APP_SECRET, "OTHER_TOKEN"));
  });

  it("appSecret を渡さなければ付けない（verify-api で META_APP_SECRET を省略したとき）", async () => {
    const { fetchImpl, calls } = capture();
    const client = new GraphClient(PAGE_TOKEN, "v25.0", 0, fetchImpl);
    await client.get("me");
    expect(calls[0]?.url.searchParams.has("appsecret_proof")).toBe(false);
  });

  it("params に appsecret_proof があっても自分の計算で上書きする（呼び出し側の値を信用しない）", async () => {
    const { fetchImpl, calls } = capture();
    const client = new GraphClient(PAGE_TOKEN, "v25.0", 0, fetchImpl, 30_000, APP_SECRET);
    await client.get("me", { appsecret_proof: "bogus" });
    expect(calls[0]?.url.searchParams.get("appsecret_proof")).toBe(hmacHex(APP_SECRET, PAGE_TOKEN));
  });

  it("describe（記録用の表記）には proof もトークンも入らない", () => {
    const client = new GraphClient(PAGE_TOKEN, "v25.0", 0, fetch, 30_000, APP_SECRET);
    const text = client.describe("me/media", { fields: "id" });
    expect(text).toBe("me/media?fields=id");
    expect(text).not.toContain("appsecret_proof");
  });
});

describe("appsecret_proof の非混入", () => {
  it("stripSecretParams は appsecret_proof を落とす（raw_api_responses.params に残らない）", () => {
    expect(stripSecretParams({ fields: "id", appsecret_proof: hmacHex(APP_SECRET, PAGE_TOKEN), input_token: "x", access_token: "y" })).toEqual({
      fields: "id",
    });
  });

  it("sanitizeForLog は appsecret_proof= と JSON の値をマスクする", () => {
    const proof = hmacHex(APP_SECRET, PAGE_TOKEN);
    const secrets = new SecretRegistry();
    expect(sanitizeForLog(`GET me/media?fields=id&appsecret_proof=${proof}&limit=50`, secrets)).toBe(
      "GET me/media?fields=id&appsecret_proof=***&limit=50",
    );
    expect(sanitizeForLog(`{"appsecret_proof":"${proof}","fields":"id"}`, secrets)).toBe('{"appsecret_proof":"***","fields":"id"}');
    expect(sanitizeForLog(`appsecret_proof=${proof}`, secrets)).not.toContain(proof);
  });
});

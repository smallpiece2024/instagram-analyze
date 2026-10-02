import { describe, expect, it } from "vitest";
import { configMissingReason, DEFAULT_GRAPH_API_VERSION, isLocalDbHost, normalizePem, readEnv } from "@/lib/env";

/** 検証に通る一式。秘密の値は、結果に混入していないことを確かめる目印にする */
const VALID: Record<string, string> = {
  DATABASE_URL: "postgresql://postgres:db-secret-value@127.0.0.1:54322/postgres",
  META_APP_ID: "123456789012345",
  META_APP_SECRET: "meta-secret-value",
  META_GRAPH_API_VERSION: "v25.0",
  APP_URL: "http://localhost:3000",
};

const SECRETS = ["db-secret-value", "meta-secret-value"];

function withEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...VALID, ...overrides };
}

describe("readEnv", () => {
  it("一式そろえば ok。プールモードは既定の session、CA はローカルなので undefined、任意の変数は undefined", () => {
    const result = readEnv(withEnv({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env).toEqual({
      databaseUrl: VALID.DATABASE_URL,
      databasePoolMode: "session",
      databaseSslCa: undefined,
      metaAppId: VALID.META_APP_ID,
      metaAppSecret: VALID.META_APP_SECRET,
      graphApiVersion: "v25.0",
      appUrl: "http://localhost:3000",
      targetIgUserId: undefined,
    });
  });

  it("各変数の欠落は missing に名前だけ。結果に値を含まない", () => {
    for (const name of Object.keys(VALID)) {
      if (name === "META_GRAPH_API_VERSION") continue; // 既定値がある
      const result = readEnv(withEnv({ [name]: undefined }));
      expect(result).toEqual({ ok: false, missing: [name] });
      const text = JSON.stringify(result);
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
  });

  it("複数の不備は変数の定義順に並ぶ。固定文言は変数名だけ", () => {
    const result = readEnv(withEnv({ DATABASE_URL: undefined, META_APP_SECRET: undefined, APP_URL: undefined }));
    expect(result).toEqual({ ok: false, missing: ["DATABASE_URL", "META_APP_SECRET", "APP_URL"] });
    if (result.ok) return;
    expect(configMissingReason(result.missing)).toBe("設定が足りません（DATABASE_URL、META_APP_SECRET、APP_URL）");
  });

  it("空白だけは未設定として扱う", () => {
    expect(readEnv(withEnv({ META_APP_SECRET: "   " }))).toEqual({
      ok: false,
      missing: ["META_APP_SECRET"],
    });
    expect(readEnv(withEnv({ DATABASE_URL: "\t\n" }))).toEqual({ ok: false, missing: ["DATABASE_URL"] });
  });

  it("DATABASE_URL は postgres(ql): で new URL() に読めること。不正な値は結果に出ない", () => {
    expect(readEnv(withEnv({ DATABASE_URL: "http://127.0.0.1:54322/postgres" }))).toEqual({
      ok: false,
      missing: ["DATABASE_URL"],
    });
    const bad = readEnv(withEnv({ DATABASE_URL: "postgresql://postgres:bad-secret@[broken/postgres" }));
    expect(bad).toEqual({ ok: false, missing: ["DATABASE_URL"] });
    expect(JSON.stringify(bad)).not.toContain("bad-secret");
    expect(readEnv(withEnv({ DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:54322/postgres" })).ok).toBe(true);
  });

  it("APP_URL はオリジンだけ。末尾のスラッシュ、パス、クエリ、スキームなしは不備", () => {
    for (const value of ["http://localhost:3000/", "http://localhost:3000/app", "http://localhost:3000?x=1", "localhost:3000"]) {
      expect(readEnv(withEnv({ APP_URL: value }))).toEqual({ ok: false, missing: ["APP_URL"] });
    }
    expect(readEnv(withEnv({ APP_URL: "https://example.com" })).ok).toBe(true);
    expect(readEnv(withEnv({ APP_URL: "http://127.0.0.1:3000" })).ok).toBe(true);
  });

  it("META_GRAPH_API_VERSION は v<数字>.<数字>。空は既定", () => {
    expect(readEnv(withEnv({ META_GRAPH_API_VERSION: "v25" }))).toEqual({ ok: false, missing: ["META_GRAPH_API_VERSION"] });
    expect(readEnv(withEnv({ META_GRAPH_API_VERSION: "25.0" }))).toEqual({ ok: false, missing: ["META_GRAPH_API_VERSION"] });
    const empty = readEnv(withEnv({ META_GRAPH_API_VERSION: "" }));
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.env.graphApiVersion).toBe(DEFAULT_GRAPH_API_VERSION);
    const absent = readEnv(withEnv({ META_GRAPH_API_VERSION: undefined }));
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.env.graphApiVersion).toBe(DEFAULT_GRAPH_API_VERSION);
    const v26 = readEnv(withEnv({ META_GRAPH_API_VERSION: "v26.1" }));
    expect(v26.ok).toBe(true);
    if (v26.ok) expect(v26.env.graphApiVersion).toBe("v26.1");
  });

  it("META_APP_ID は数字列", () => {
    expect(readEnv(withEnv({ META_APP_ID: "abc123" }))).toEqual({ ok: false, missing: ["META_APP_ID"] });
    expect(readEnv(withEnv({ META_APP_ID: "123 456" }))).toEqual({ ok: false, missing: ["META_APP_ID"] });
    expect(readEnv(withEnv({ META_APP_ID: "1".repeat(41) }))).toEqual({ ok: false, missing: ["META_APP_ID"] });
    expect(readEnv(withEnv({ META_APP_ID: "1" })).ok).toBe(true);
  });

  it("META_TARGET_IG_USER_ID は任意。数字以外は不備、空は undefined", () => {
    expect(readEnv(withEnv({ META_TARGET_IG_USER_ID: "user_name" }))).toEqual({
      ok: false,
      missing: ["META_TARGET_IG_USER_ID"],
    });
    const empty = readEnv(withEnv({ META_TARGET_IG_USER_ID: "" }));
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.env.targetIgUserId).toBeUndefined();
    const set = readEnv(withEnv({ META_TARGET_IG_USER_ID: "17841400000000000" }));
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.env.targetIgUserId).toBe("17841400000000000");
  });

  it("source を渡さなければ process.env を読む（この環境では不備があっても例外にならない）", () => {
    const result = readEnv();
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("readEnv: DATABASE_POOL_MODE と DATABASE_SSL_CA（R2 設計 2.2 章、10.1 章）", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIBpem-body-secret\n-----END CERTIFICATE-----";
  const REMOTE = "postgresql://web_app.ref:pw-secret-value@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require";

  it("DATABASE_POOL_MODE: 未設定 → session、transaction → transaction、不正値 → missing（値を含まない）", () => {
    const unset = readEnv(withEnv({ DATABASE_POOL_MODE: undefined }));
    expect(unset.ok && unset.env.databasePoolMode).toBe("session");
    const tx = readEnv(withEnv({ DATABASE_POOL_MODE: "transaction" }));
    expect(tx.ok && tx.env.databasePoolMode).toBe("transaction");
    const bad = readEnv(withEnv({ DATABASE_POOL_MODE: "pooled-secret" }));
    expect(bad).toEqual({ ok: false, missing: ["DATABASE_POOL_MODE"] });
    expect(JSON.stringify(bad)).not.toContain("pooled-secret");
  });

  it("DATABASE_SSL_CA あり → 正規化した PEM（\n のリテラルを改行に戻す。CRLF も LF に）", () => {
    // `\n` の 2 文字（バックスラッシュと n）で渡されたものを改行に戻す（環境変数の入力経路で起きる）
    const escaped = PEM.replace(/\n/g, "\\n");
    expect(escaped).not.toContain("\n");
    const literal = readEnv(withEnv({ DATABASE_SSL_CA: escaped }));
    expect(literal.ok && literal.env.databaseSslCa).toBe(PEM);
    const crlf = readEnv(withEnv({ DATABASE_SSL_CA: `${PEM.replace(/\n/g, "\r\n")}\r\n` }));
    expect(crlf.ok && crlf.env.databaseSslCa).toBe(PEM);
  });

  it("なし＋ローカルのホスト → ok で databaseSslCa は undefined", () => {
    for (const host of ["127.0.0.1", "localhost", "host.docker.internal"]) {
      const r = readEnv(withEnv({ DATABASE_URL: `postgresql://web_app:web_app_local@${host}:54322/postgres` }));
      expect(r.ok).toBe(true);
      expect(r.ok && r.env.databaseSslCa).toBeUndefined();
    }
  });

  it("なし＋それ以外のホスト → missing DATABASE_SSL_CA（フェイルクローズ。接続文字列の値を含まない）", () => {
    const r = readEnv(withEnv({ DATABASE_URL: REMOTE }));
    expect(r).toEqual({ ok: false, missing: ["DATABASE_SSL_CA"] });
    expect(JSON.stringify(r)).not.toContain("pw-secret-value");
  });

  it("あり＋リモート → ok（URL の ?sslmode= は残るが db.ts が ssl を明示するので使われない）", () => {
    const r = readEnv(withEnv({ DATABASE_URL: REMOTE, DATABASE_SSL_CA: PEM, DATABASE_POOL_MODE: "transaction" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.databaseSslCa).toBe(PEM);
    expect(r.env.databasePoolMode).toBe("transaction");
  });

  it("PEM の先頭が -----BEGIN CERTIFICATE----- でなければ missing（値を含まない）", () => {
    const r = readEnv(withEnv({ DATABASE_SSL_CA: "garbage-ca-secret-value" }));
    expect(r).toEqual({ ok: false, missing: ["DATABASE_SSL_CA"] });
    expect(JSON.stringify(r)).not.toContain("garbage-ca-secret-value");
    expect(normalizePem("MIIB\n-----BEGIN CERTIFICATE-----")).toBeUndefined();
    expect(normalizePem("  -----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----  ")).toBe(
      "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----",
    );
  });

  it("isLocalDbHost は大文字小文字を無視し、それ以外のホストは false", () => {
    expect(isLocalDbHost("LOCALHOST")).toBe(true);
    expect(isLocalDbHost("127.0.0.1")).toBe(true);
    expect(isLocalDbHost("db.example.supabase.co")).toBe(false);
    expect(isLocalDbHost("127.0.0.1.evil.example")).toBe(false);
  });
});

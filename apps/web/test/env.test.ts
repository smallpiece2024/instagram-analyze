import { describe, expect, it } from "vitest";
import { configMissingReason, DEFAULT_GRAPH_API_VERSION, readEnv } from "@/lib/env";

/** 検証に通る一式。秘密の値は、結果に混入していないことを確かめる目印にする */
const VALID: Record<string, string> = {
  DATABASE_URL: "postgresql://postgres:db-secret-value@127.0.0.1:54322/postgres",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
  META_APP_ID: "123456789012345",
  META_APP_SECRET: "meta-secret-value",
  META_GRAPH_API_VERSION: "v25.0",
  APP_URL: "http://localhost:3000",
};

const SECRETS = ["db-secret-value", "service-role-secret-value", "meta-secret-value"];

function withEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...VALID, ...overrides };
}

describe("readEnv", () => {
  it("一式そろえば ok。末尾のスラッシュは落とし、任意の変数は undefined", () => {
    const result = readEnv(withEnv({ SUPABASE_URL: "http://127.0.0.1:54321/" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env).toEqual({
      databaseUrl: VALID.DATABASE_URL,
      supabaseUrl: "http://127.0.0.1:54321",
      supabaseServiceRoleKey: VALID.SUPABASE_SERVICE_ROLE_KEY,
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
    expect(readEnv(withEnv({ SUPABASE_SERVICE_ROLE_KEY: "   " }))).toEqual({
      ok: false,
      missing: ["SUPABASE_SERVICE_ROLE_KEY"],
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

  it("SUPABASE_URL は http(s) だけ", () => {
    expect(readEnv(withEnv({ SUPABASE_URL: "ftp://127.0.0.1" }))).toEqual({ ok: false, missing: ["SUPABASE_URL"] });
    expect(readEnv(withEnv({ SUPABASE_URL: "not a url" }))).toEqual({ ok: false, missing: ["SUPABASE_URL"] });
    expect(readEnv(withEnv({ SUPABASE_URL: "https://example.supabase.co" })).ok).toBe(true);
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

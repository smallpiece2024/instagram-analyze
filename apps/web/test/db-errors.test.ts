import { describe, expect, it } from "vitest";
import { describeDbError } from "@/lib/db-errors";

/** postgres.js の PostgresError と同じ形（name と SQLSTATE の code）の偽物 */
function fakePostgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "PostgresError", code });
}

describe("describeDbError", () => {
  it("接続と認証の失敗を SQLSTATE つきの固定文言にする", () => {
    expect(describeDbError(fakePostgresError("28P01", 'password authentication failed for user "postgres"'))).toBe(
      "DB 接続に失敗（SQLSTATE 28P01）",
    );
    expect(describeDbError(fakePostgresError("28000", "no pg_hba.conf entry for host"))).toBe("DB 接続に失敗（SQLSTATE 28000）");
    expect(describeDbError(fakePostgresError("08006", "connection failure"))).toBe("DB 接続に失敗（SQLSTATE 08006）");
    expect(describeDbError(fakePostgresError("3D000", 'database "x" does not exist'))).toBe("DB 接続に失敗（SQLSTATE 3D000）");
    expect(describeDbError(fakePostgresError("53300", "too many connections"))).toBe("DB 接続に失敗（SQLSTATE 53300）");
    expect(describeDbError(fakePostgresError("57P01", "terminating connection"))).toBe("DB 接続に失敗（SQLSTATE 57P01）");
  });

  it("権限の失敗とその他の Postgres エラー", () => {
    expect(describeDbError(fakePostgresError("42501", "permission denied for schema vault"))).toBe(
      "DB の権限がない（SQLSTATE 42501）",
    );
    expect(describeDbError(fakePostgresError("23505", "duplicate key value"))).toBe("DB エラー（SQLSTATE 23505）");
    expect(describeDbError(fakePostgresError("42P01", "relation does not exist"))).toBe("DB エラー（SQLSTATE 42P01）");
  });

  it("postgres.js と Node.js のソケット、TLS の接続エラーのコード", () => {
    expect(describeDbError(Object.assign(new Error("write CONNECT_TIMEOUT 127.0.0.1:54322"), { code: "CONNECT_TIMEOUT" }))).toBe(
      "DB 接続に失敗（CONNECT_TIMEOUT）",
    );
    expect(describeDbError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }))).toBe(
      "DB 接続に失敗（ECONNREFUSED）",
    );
    expect(describeDbError(Object.assign(new Error("getaddrinfo ENOTFOUND db.example.supabase.co"), { code: "ENOTFOUND" }))).toBe(
      "DB 接続に失敗（ENOTFOUND）",
    );
    expect(describeDbError(Object.assign(new Error("self signed certificate"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }))).toBe(
      "DB 接続に失敗（SELF_SIGNED_CERT_IN_CHAIN）",
    );
    expect(describeDbError(Object.assign(new Error("Hostname/IP does not match"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))).toBe(
      "DB 接続に失敗（ERR_TLS_CERT_ALTNAME_INVALID）",
    );
  });

  it("new URL() の失敗（ERR_INVALID_URL）は input を含めない", () => {
    let caught: unknown;
    try {
      new URL("postgresql://postgres:secret-value@[bad-host/db");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const text = describeDbError(caught);
    expect(text).toBe("DB 接続に失敗（ERR_INVALID_URL）");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("bad-host");
  });

  it("その他のコードつきのエラーは DB エラー（コード）", () => {
    expect(describeDbError(Object.assign(new Error("Undefined values are not allowed"), { code: "UNDEFINED_VALUE" }))).toBe(
      "DB エラー（UNDEFINED_VALUE）",
    );
    // code は PostgresError でなければ SQLSTATE として扱わない
    expect(describeDbError(Object.assign(new Error("canceled"), { code: "57014" }))).toBe("DB エラー（57014）");
  });

  it("コードがない、または形が不正なら DB エラー だけ", () => {
    expect(describeDbError(new Error("boom"))).toBe("DB エラー");
    expect(describeDbError(undefined)).toBe("DB エラー");
    expect(describeDbError(null)).toBe("DB エラー");
    expect(describeDbError("postgresql://postgres:secret@127.0.0.1:54322/postgres")).toBe("DB エラー");
    expect(describeDbError({ code: 42 })).toBe("DB エラー");
    expect(describeDbError({ code: "postgresql://postgres:secret@host/db" })).toBe("DB エラー");
    expect(describeDbError({ code: "x".repeat(41) })).toBe("DB エラー");
  });

  it("message、stack、cause、query、parameters、ホスト、ユーザー名を含まない", () => {
    const error = Object.assign(
      new Error('password authentication failed for user "postgres.abcdefghij" at db.abcdefghij.supabase.co'),
      {
        name: "PostgresError",
        code: "28P01",
        query: "select vault.create_secret('SECRET_TOKEN')",
        parameters: ["SECRET_TOKEN"],
        cause: new Error("secret cause"),
      },
    );
    const text = describeDbError(error);
    expect(text).toBe("DB 接続に失敗（SQLSTATE 28P01）");
    expect(text).not.toContain("postgres.abcdefghij");
    expect(text).not.toContain("supabase.co");
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("secret cause");
  });
});

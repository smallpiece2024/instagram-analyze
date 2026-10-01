import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, connectDb, normalizeDbError, type Db } from "../../src/db/client.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** postgres.js の PostgresError と同じ形（name と SQLSTATE の code）の偽物 */
function fakePostgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "PostgresError", code });
}

describe("normalizeDbError", () => {
  it("接続と認証の失敗を SQLSTATE つきの固定文言にする", () => {
    expect(normalizeDbError(fakePostgresError("28P01", 'password authentication failed for user "postgres"'))).toBe(
      "DB 接続に失敗（SQLSTATE 28P01）",
    );
    expect(normalizeDbError(fakePostgresError("28000", "no pg_hba.conf entry for host"))).toBe(
      "DB 接続に失敗（SQLSTATE 28000）",
    );
    expect(normalizeDbError(fakePostgresError("08006", "connection failure"))).toBe("DB 接続に失敗（SQLSTATE 08006）");
    expect(normalizeDbError(fakePostgresError("3D000", 'database "x" does not exist'))).toBe(
      "DB 接続に失敗（SQLSTATE 3D000）",
    );
    expect(normalizeDbError(fakePostgresError("53300", "too many connections"))).toBe("DB 接続に失敗（SQLSTATE 53300）");
  });

  it("権限の失敗とその他の Postgres エラー", () => {
    expect(normalizeDbError(fakePostgresError("42501", "permission denied for schema vault"))).toBe(
      "DB の権限がない（SQLSTATE 42501）",
    );
    expect(normalizeDbError(fakePostgresError("23505", "duplicate key value"))).toBe("DB エラー（SQLSTATE 23505）");
    expect(normalizeDbError(fakePostgresError("42P01", "relation does not exist"))).toBe("DB エラー（SQLSTATE 42P01）");
  });

  it("postgres.js と Node.js のソケットの接続エラーのコード", () => {
    expect(normalizeDbError(Object.assign(new Error("write CONNECT_TIMEOUT 127.0.0.1:54322"), { code: "CONNECT_TIMEOUT" }))).toBe(
      "DB 接続に失敗（CONNECT_TIMEOUT）",
    );
    expect(normalizeDbError(Object.assign(new Error("write CONNECTION_CLOSED 127.0.0.1:54322"), { code: "CONNECTION_CLOSED" }))).toBe(
      "DB 接続に失敗（CONNECTION_CLOSED）",
    );
    expect(normalizeDbError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }))).toBe(
      "DB 接続に失敗（ECONNREFUSED）",
    );
    expect(normalizeDbError(Object.assign(new Error("getaddrinfo ENOTFOUND db.example.supabase.co"), { code: "ENOTFOUND" }))).toBe(
      "DB 接続に失敗（ENOTFOUND）",
    );
    expect(normalizeDbError(Object.assign(new Error("self signed certificate"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }))).toBe(
      "DB 接続に失敗（SELF_SIGNED_CERT_IN_CHAIN）",
    );
    expect(normalizeDbError(Object.assign(new Error("Hostname/IP does not match"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))).toBe(
      "DB 接続に失敗（ERR_TLS_CERT_ALTNAME_INVALID）",
    );
  });

  it("その他のコードつきのエラーは DB エラー（コード）", () => {
    expect(normalizeDbError(Object.assign(new Error("Undefined values are not allowed"), { code: "UNDEFINED_VALUE" }))).toBe(
      "DB エラー（UNDEFINED_VALUE）",
    );
    // code は PostgresError でなければ SQLSTATE として扱わない
    expect(normalizeDbError(Object.assign(new Error("canceled"), { code: "57014" }))).toBe("DB エラー（57014）");
  });

  it("コードがない、または形が不正なら DB エラー だけ", () => {
    expect(normalizeDbError(new Error("boom"))).toBe("DB エラー");
    expect(normalizeDbError(undefined)).toBe("DB エラー");
    expect(normalizeDbError(null)).toBe("DB エラー");
    expect(normalizeDbError("postgresql://postgres:secret@127.0.0.1:54322/postgres")).toBe("DB エラー");
    expect(normalizeDbError({ code: 42 })).toBe("DB エラー");
    expect(normalizeDbError({ code: "postgresql://postgres:secret@host/db" })).toBe("DB エラー");
    expect(normalizeDbError({ code: "x".repeat(41) })).toBe("DB エラー");
  });

  it("message、stack、cause、query、parameters、ホスト、ユーザー名を含まない", () => {
    const error = Object.assign(
      new Error('password authentication failed for user "postgres.abcdefghij" at db.abcdefghij.supabase.co'),
      {
        name: "PostgresError",
        code: "28P01",
        cause: new Error("secret cause"),
        query: "select vault.create_secret($1, $2)",
        parameters: ["SECRET_TOKEN", "ig-token-x"],
      },
    );
    const text = normalizeDbError(error);
    expect(text).toBe("DB 接続に失敗（SQLSTATE 28P01）");
    expect(text).not.toContain("postgres.abcdefghij");
    expect(text).not.toContain("supabase.co");
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("vault.create_secret");
    expect(text).not.toContain("secret cause");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("db/client（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;

  beforeAll(() => {
    db = connectDb(url);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  it("date は YYYY-MM-DD の文字列で返る", async () => {
    const [row] = await db<{ d: unknown }[]>`select '2026-10-01'::date as d`;
    expect(row?.d).toBe("2026-10-01");
  });

  it("date の文字列をそのまま書いて読める（UTC への変換で日付がずれない）", async () => {
    const [row] = await db<{ d: unknown; next: unknown }[]>`
      select ${"2026-10-01"}::date as d, ${"2026-10-01"}::date + 1 as next
    `;
    expect(row?.d).toBe("2026-10-01");
    expect(row?.next).toBe("2026-10-02");
  });

  it("bigint は文字列で返る", async () => {
    const [row] = await db<{ n: unknown; big: unknown }[]>`
      select 1::bigint as n, 9007199254740993::bigint as big
    `;
    expect(row?.n).toBe("1");
    expect(row?.big).toBe("9007199254740993");
  });

  it("jsonb はオブジェクトで返る", async () => {
    const [row] = await db<{ j: unknown }[]>`select '{"a":1,"b":[1,2],"c":null}'::jsonb as j`;
    expect(row?.j).toEqual({ a: 1, b: [1, 2], c: null });
  });

  it("numeric は文字列で返る（変換は呼び出し側）", async () => {
    const [row] = await db<{ x: unknown }[]>`select 1.5::numeric as x`;
    expect(row?.x).toBe("1.5");
  });

  it("timestamptz は Date で返り、integer は number で返る", async () => {
    const [row] = await db<{ t: unknown; i: unknown; b: unknown }[]>`
      select '2026-10-01T00:00:00Z'::timestamptz as t, 7::integer as i, true as b
    `;
    expect(row?.t).toBeInstanceOf(Date);
    expect((row?.t as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(row?.i).toBe(7);
    expect(row?.b).toBe(true);
  });

  it("text[] は string[] で返る", async () => {
    const [row] = await db<{ a: unknown }[]>`select ${["instagram_basic", "pages_read_engagement"]}::text[] as a`;
    expect(row?.a).toEqual(["instagram_basic", "pages_read_engagement"]);
  });

  it("存在しないポートへの接続の失敗が固定文言になり、ホストやユーザー名を含まない", async () => {
    const bad = new URL(url);
    bad.port = "1";
    const badDb = connectDb(bad.href, { connectTimeoutSeconds: 2 });
    try {
      const text = await badDb`select 1`.then(
        () => "接続できてしまった",
        (error: unknown) => normalizeDbError(error),
      );
      expect(text).toMatch(/^DB 接続に失敗（[A-Z_]+）$/);
      expect(text).not.toContain(bad.hostname);
      expect(text).not.toContain(bad.username);
      expect(text).not.toContain("postgresql://");
      expect(text).not.toContain("://");
    } finally {
      await closeDb(badDb);
    }
  });

  it("間違ったパスワードでの失敗が SQLSTATE 28P01 の固定文言になる", async () => {
    const bad = new URL(url);
    bad.password = "wrong-password";
    const badDb = connectDb(bad.href, { connectTimeoutSeconds: 5 });
    try {
      const text = await badDb`select 1`.then(
        () => "接続できてしまった",
        (error: unknown) => normalizeDbError(error),
      );
      expect(text).toBe("DB 接続に失敗（SQLSTATE 28P01）");
      expect(text).not.toContain(bad.username);
    } finally {
      await closeDb(badDb);
    }
  });
});

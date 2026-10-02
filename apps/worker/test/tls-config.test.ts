/**
 * TLS の設定（R2 設計 2.2 章、10.1 章）: `DATABASE_SSL_CA` の読み込みとフェイルクローズ、`connectDb` の `ssl`、
 * 証明書エラーの固定文言。実際の接続はしない（postgres.js は遅延接続）
 */
import { describe, expect, it } from "vitest";
import { ConfigError, LOCAL_DB_HOSTS, loadCheckAlertsConfig, loadWorkerConfig } from "../src/config.js";
import { closeDb, connectDb, isTlsCode, normalizeDbError, sslOptions } from "../src/db/client.js";

/** 架空の PEM（形だけ。本物の証明書ではない） */
const PEM = ["-----BEGIN CERTIFICATE-----", "MIIBfakeCERTIFICATEbody0123456789", "abcdefghij", "-----END CERTIFICATE-----"].join("\n");

const CLOUD_URL = "postgresql://postgres.abcdefghijklmnop:pw-secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";

const BASE = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  META_APP_ID: "123",
  META_APP_SECRET: "app-secret",
} as const;

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...BASE, DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", ...overrides };
}

function expectConfigError(fn: () => unknown, name: string, ...absent: string[]): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const message = (caught as ConfigError).message;
  expect(message).toContain(name);
  for (const value of absent) expect(message).not.toContain(value);
}

describe("DATABASE_SSL_CA（config）", () => {
  it("ローカルのホストは CA なしで読める（databaseSslCa は undefined）", () => {
    expect(LOCAL_DB_HOSTS).toEqual(["127.0.0.1", "localhost", "host.docker.internal"]);
    for (const host of LOCAL_DB_HOSTS) {
      const config = loadWorkerConfig(env({ DATABASE_URL: `postgresql://postgres:postgres@${host}:54322/postgres` }));
      expect(config.databaseSslCa).toBeUndefined();
    }
  });

  it("ローカル以外のホストで CA がなければ ConfigError（フェイルクローズ。ホスト名とパスワードを含まない）", () => {
    expectConfigError(() => loadWorkerConfig(env({ DATABASE_URL: CLOUD_URL })), "DATABASE_SSL_CA", "pooler.supabase.com", "pw-secret", "abcdefghijklmnop");
    expectConfigError(() => loadCheckAlertsConfig({ DATABASE_URL: CLOUD_URL }), "DATABASE_SSL_CA", "pooler.supabase.com", "pw-secret");
    // 127.0.0.1 に似せたホストも対象
    expectConfigError(() => loadWorkerConfig(env({ DATABASE_URL: "postgresql://u:p@127.0.0.1.example.com:5432/db" })), "DATABASE_SSL_CA");
  });

  it("CA があればそのまま読める（ローカルでもクラウドでも）", () => {
    expect(loadWorkerConfig(env({ DATABASE_URL: CLOUD_URL, DATABASE_SSL_CA: PEM })).databaseSslCa).toBe(PEM);
    expect(loadWorkerConfig(env({ DATABASE_SSL_CA: PEM })).databaseSslCa).toBe(PEM);
    expect(loadCheckAlertsConfig({ DATABASE_URL: CLOUD_URL, DATABASE_SSL_CA: PEM }).databaseSslCa).toBe(PEM);
  });

  it("\\n のリテラルと CRLF を改行に正規化し、前後の空白を落とす", () => {
    const literal = PEM.replace(/\n/g, "\\n");
    expect(literal).not.toContain("\n");
    expect(loadWorkerConfig(env({ DATABASE_SSL_CA: literal })).databaseSslCa).toBe(PEM);
    expect(loadWorkerConfig(env({ DATABASE_SSL_CA: PEM.replace(/\n/g, "\r\n") })).databaseSslCa).toBe(PEM);
    expect(loadWorkerConfig(env({ DATABASE_SSL_CA: `  ${PEM}\n\n` })).databaseSslCa).toBe(PEM);
  });

  it("PEM の先頭が -----BEGIN CERTIFICATE----- でなければ ConfigError（値を含まない）", () => {
    for (const bad of ["not-a-certificate-value", "-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----", "MIIBfakeCERTIFICATEbody"]) {
      expectConfigError(() => loadWorkerConfig(env({ DATABASE_SSL_CA: bad })), "DATABASE_SSL_CA", "not-a-certificate-value", "PRIVATE KEY", "MIIBfake");
    }
  });

  it("空文字は未設定と同じ", () => {
    expect(loadWorkerConfig(env({ DATABASE_SSL_CA: "" })).databaseSslCa).toBeUndefined();
    expectConfigError(() => loadWorkerConfig(env({ DATABASE_URL: CLOUD_URL, DATABASE_SSL_CA: "  " })), "DATABASE_SSL_CA");
  });
});

describe("loadCheckAlertsConfig", () => {
  it("DATABASE_URL だけで読める。Meta と Storage の変数は要らない", () => {
    expect(loadCheckAlertsConfig({ DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" })).toEqual({
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      databaseSslCa: undefined,
      logLevel: "info",
      simulateAlert: false,
    });
    expectConfigError(() => loadCheckAlertsConfig({}), "DATABASE_URL");
  });

  it("WORKER_SIMULATE_ALERT は true／false（省略は false）。それ以外は ConfigError（値を含まない）", () => {
    const url = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    expect(loadCheckAlertsConfig({ DATABASE_URL: url, WORKER_SIMULATE_ALERT: "true" }).simulateAlert).toBe(true);
    expect(loadCheckAlertsConfig({ DATABASE_URL: url, WORKER_SIMULATE_ALERT: "false" }).simulateAlert).toBe(false);
    expect(loadCheckAlertsConfig({ DATABASE_URL: url, WORKER_SIMULATE_ALERT: "" }).simulateAlert).toBe(false);
    expectConfigError(() => loadCheckAlertsConfig({ DATABASE_URL: url, WORKER_SIMULATE_ALERT: "yes-please" }), "WORKER_SIMULATE_ALERT", "yes-please");
  });
});

describe("connectDb の ssl", () => {
  function sslOf(db: unknown): unknown {
    return (db as { options: { ssl: unknown } }).options.ssl;
  }

  it("sslOptions: CA があれば { ca: [pem], rejectUnauthorized: true }、なければ false", () => {
    expect(sslOptions(PEM)).toEqual({ ca: [PEM], rejectUnauthorized: true });
    expect(sslOptions(undefined)).toBe(false);
  });

  it("CA ありは verify-full 相当の ssl を渡す", async () => {
    const db = connectDb(CLOUD_URL, { sslCa: PEM });
    try {
      expect(sslOf(db)).toEqual({ ca: [PEM], rejectUnauthorized: true });
    } finally {
      await closeDb(db);
    }
  });

  it("CA なしは ssl を付けない（ローカルの平文）", async () => {
    const db = connectDb("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    try {
      expect(sslOf(db)).toBe(false);
    } finally {
      await closeDb(db);
    }
  });

  it("URL の ?sslmode=require は無視する（postgres.js では検証なしになるため）", async () => {
    const plain = connectDb("postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=require");
    const withCa = connectDb(`${CLOUD_URL}?sslmode=require`, { sslCa: PEM });
    try {
      expect(sslOf(plain)).toBe(false);
      expect(sslOf(withCa)).toEqual({ ca: [PEM], rejectUnauthorized: true });
    } finally {
      await closeDb(plain);
      await closeDb(withCa);
    }
  });
});

describe("normalizeDbError（証明書・TLS）", () => {
  it("不正な CA、チェーン不一致、ホスト名不一致は固定文言（ホスト名を含まない）", () => {
    const cases: [string, string][] = [
      ["ERR_OSSL_PEM_NO_START_LINE", "error:0480006C:PEM routines::no start line"],
      ["UNABLE_TO_GET_ISSUER_CERT", "unable to get issuer certificate for aws-0-ap-northeast-1.pooler.supabase.com"],
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"],
      ["SELF_SIGNED_CERT_IN_CHAIN", "self signed certificate in certificate chain"],
      ["HOSTNAME_MISMATCH", "Host: aws-0-ap-northeast-1.pooler.supabase.com is not in the cert's list"],
      ["ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames: Host: aws-0-ap-northeast-1.pooler.supabase.com"],
      ["ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number"],
      ["CERT_HAS_EXPIRED", "certificate has expired"],
      ["EPROTO", "write EPROTO 140234:error:0A000410:SSL routines:ssl3_read_bytes"],
    ];
    for (const [code, message] of cases) {
      const text = normalizeDbError(Object.assign(new Error(message), { code }));
      expect(text).toBe(`DB 接続に失敗（${code}）`);
      expect(text).not.toContain("supabase.com");
    }
  });

  it("isTlsCode は TLS と OpenSSL の接頭辞だけ", () => {
    expect(isTlsCode("ERR_TLS_CERT_ALTNAME_INVALID")).toBe(true);
    expect(isTlsCode("ERR_OSSL_PEM_NO_START_LINE")).toBe(true);
    expect(isTlsCode("CERT_UNTRUSTED")).toBe(true);
    expect(isTlsCode("ECONNREFUSED")).toBe(false);
    expect(isTlsCode("28P01")).toBe(false);
  });
});

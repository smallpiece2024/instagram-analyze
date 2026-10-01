import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, type WorkerConfig } from "../src/config.js";
import {
  cleanOldTempDirs,
  closeJobDeps,
  createJobDeps,
  deriveJobStatus,
  describeError,
  processSecrets,
  TMP_DIR_PREFIX,
  type JobProgress,
  type StopReason,
} from "../src/jobs/framework.js";
import { AuthError } from "../src/jobs/graph-client.js";
import { RateLimitExceeded } from "../src/jobs/rate.js";
import { DownloadError } from "../src/lib/download.js";
import { SecretRegistry } from "../src/lib/log.js";

// ---------------------------------------------------------------------------
// deriveJobStatus（設計 1.5 章、9.1 章）
// ---------------------------------------------------------------------------

describe("deriveJobStatus", () => {
  const progress = (items: number, failures: number): JobProgress => ({ items, failures, apiCalls: 0 });

  it.each<[number, number, StopReason, string]>([
    [0, 0, "none", "success"],
    [5, 0, "none", "success"],
    [5, 1, "none", "partial"],
    [0, 3, "none", "failed"],
    [0, 0, "rate", "skipped"],
    [1, 0, "rate", "partial"],
    [3, 2, "rate", "partial"],
    [0, 2, "rate", "failed"],
    [0, 0, "auth", "failed"],
    [10, 0, "auth", "failed"],
    [0, 0, "error", "failed"],
    [10, 0, "error", "failed"],
    [10, 5, "error", "failed"],
  ])("items=%i failures=%i stop=%s → %s", (items, failures, stop, expected) => {
    expect(deriveJobStatus(progress(items, failures), stop)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// describeError
// ---------------------------------------------------------------------------

describe("describeError", () => {
  const secrets = new SecretRegistry();
  secrets.add("SECRET_TOKEN");
  secrets.addUrlParts("postgresql://dbuser:dbpass@db.example.supabase.co:5432/postgres");

  it("PostgresError 風のオブジェクトは normalizeDbError の固定文言。query、parameters、ホスト、ユーザー名を含まない", () => {
    const error = Object.assign(new Error('password authentication failed for user "dbuser" at db.example.supabase.co'), {
      name: "PostgresError",
      code: "28P01",
      query: "select vault.create_secret($1, $2)",
      parameters: ["SECRET_TOKEN", "ig-token-x"],
    });
    expect(describeError(error, secrets)).toEqual({
      message: "DB 接続に失敗（SQLSTATE 28P01）",
      code: "28P01",
      errorClass: "db",
    });
    expect(describeError(Object.assign(new Error("permission denied"), { name: "PostgresError", code: "42501" }), secrets)).toEqual({
      message: "DB の権限がない（SQLSTATE 42501）",
      code: "42501",
      errorClass: "db",
    });
    expect(describeError(Object.assign(new Error("dup"), { name: "PostgresError", code: "23505" }), secrets)).toEqual({
      message: "DB エラー（SQLSTATE 23505）",
      code: "23505",
      errorClass: "db",
    });
  });

  it("code のない PostgresError 風のオブジェクトは DB エラー（class は db）", () => {
    const error = Object.assign(new Error("something at db.example.supabase.co"), { name: "PostgresError" });
    expect(describeError(error, secrets)).toEqual({ message: "DB エラー", code: undefined, errorClass: "db" });
  });

  it("接続のコード（ECONNREFUSED など）を持つ Error は DB 接続の固定文言。host:port を含まない", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54322"), { code: "ECONNREFUSED" });
    expect(describeError(error, secrets)).toEqual({
      message: "DB 接続に失敗（ECONNREFUSED）",
      code: "ECONNREFUSED",
      errorClass: "db",
    });
    const timeout = Object.assign(new Error("write CONNECT_TIMEOUT db.example.supabase.co:5432"), { code: "CONNECT_TIMEOUT" });
    const described = describeError(timeout, secrets);
    expect(described.message).toBe("DB 接続に失敗（CONNECT_TIMEOUT）");
    expect(described.errorClass).toBe("db");
  });

  it("RateLimitExceeded と AuthError は固定文言。AuthError の code は文字列", () => {
    expect(describeError(RateLimitExceeded.forError(4), secrets)).toEqual({
      message: "レート制限のエラー（コード 4）",
      code: undefined,
      errorClass: "rate",
    });
    expect(describeError(RateLimitExceeded.forUsage(95, 90), secrets)).toEqual({
      message: "レート制限の使用率がしきい値を超えた（使用率 95%、しきい値 90%）",
      code: undefined,
      errorClass: "rate",
    });
    expect(describeError(new AuthError(190, "トークンが無効（コード 190）"), secrets)).toEqual({
      message: "トークンが無効（コード 190）",
      code: "190",
      errorClass: "auth",
    });
    expect(describeError(new AuthError(200, "権限が足りない（コード 200）"), secrets)).toEqual({
      message: "権限が足りない（コード 200）",
      code: "200",
      errorClass: "auth",
    });
  });

  it("RateLimitExceeded に回復見込み（分）があれば付ける。0 や未指定なら付けない（設計 7.2 章）", () => {
    expect(describeError(RateLimitExceeded.forError(4, 5), secrets).message).toBe("レート制限のエラー（コード 4）（回復見込み 5 分）");
    expect(describeError(RateLimitExceeded.forUsage(95, 90, 12), secrets).message).toBe(
      "レート制限の使用率がしきい値を超えた（使用率 95%、しきい値 90%）（回復見込み 12 分）",
    );
    expect(describeError(RateLimitExceeded.forError(undefined, 0), secrets).message).toBe("レート制限のエラー（HTTP 429）");
    expect(describeError(RateLimitExceeded.forUsage(95, 90, undefined), secrets).message).not.toContain("回復見込み");
  });

  it("DownloadError は download", () => {
    expect(describeError(new DownloadError("許可されていない URL"), secrets)).toEqual({
      message: "許可されていない URL",
      code: undefined,
      errorClass: "download",
    });
  });

  it("ConfigError は unknown で、変数名だけのメッセージがそのまま残る", () => {
    const error = new ConfigError("環境変数 WORKER_DAILY_TIME_JST の書式が不正です（HH:MM、00:00〜23:59）");
    expect(describeError(error, secrets)).toEqual({
      message: "環境変数 WORKER_DAILY_TIME_JST の書式が不正です（HH:MM、00:00〜23:59）",
      code: undefined,
      errorClass: "unknown",
    });
  });

  it("普通の Error は message を sanitizeForLog に通す（URL、トークン、10 桁以上の数字が消える）", () => {
    const error = new Error(
      "failed https://graph.facebook.com/v25.0/me?access_token=SECRET_TOKEN for 17841400000000000 token SECRET_TOKEN at db.example.supabase.co",
    );
    const described = describeError(error, secrets);
    expect(described).toEqual({ message: "failed <url> for *** token *** at ***", code: undefined, errorClass: "unknown" });
    expect(described.message).not.toContain("SECRET_TOKEN");
    expect(described.message).not.toContain("://");
    expect(described.message).not.toContain("supabase.co");
  });

  it("コードつきでも接続のコードでなければ unknown（message はマスク済み、code は残す）", () => {
    const error = Object.assign(new Error("Invalid URL"), { code: "ERR_INVALID_URL" });
    expect(describeError(error, secrets)).toEqual({ message: "Invalid URL", code: "ERR_INVALID_URL", errorClass: "unknown" });
    // 形が不正なコードは出さない
    const weird = Object.assign(new Error("x"), { code: "postgresql://u:p@h/db" });
    expect(describeError(weird, secrets).code).toBeUndefined();
  });

  it("数値の code は AuthError だけで扱う（DOMException の code: 20 などは Graph のコードにしない）", () => {
    const domLike = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: 20 });
    expect(describeError(domLike, secrets)).toEqual({ message: "The operation was aborted", code: undefined, errorClass: "unknown" });
  });

  it("new URL() の ERR_INVALID_URL が持つ input（接続文字列全体）を出さない。message に接続文字列があってもマスクする", () => {
    const input = "postgresql://dbuser:dbpass@db.example.supabase.co:5432/postgres";
    const bare = Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input });
    const described = describeError(bare, secrets);
    expect(described).toEqual({ message: "Invalid URL", code: "ERR_INVALID_URL", errorClass: "unknown" });
    expect(JSON.stringify(described)).not.toContain("dbpass");

    const verbose = Object.assign(new TypeError(`Invalid URL: ${input}`), { code: "ERR_INVALID_URL", input });
    const text = JSON.stringify(describeError(verbose, secrets));
    expect(text).toContain("Invalid URL: <db-url>");
    expect(text).not.toContain("dbpass");
    expect(text).not.toContain("dbuser");
    expect(text).not.toContain("supabase.co");
    expect(text).not.toContain("postgresql://");
  });

  it("Error でない値は 不明なエラー", () => {
    expect(describeError("boom SECRET_TOKEN", secrets)).toEqual({ message: "不明なエラー", code: undefined, errorClass: "unknown" });
    expect(describeError(undefined, secrets).message).toBe("不明なエラー");
    expect(describeError(null, secrets).message).toBe("不明なエラー");
  });
});

// ---------------------------------------------------------------------------
// createJobDeps（接続はしない。postgres.js は遅延接続）
// ---------------------------------------------------------------------------

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: "postgresql://dbuser:db%40pass@db.example.supabase.co:5432/postgres",
    supabaseUrl: "https://abcdefghij.supabase.co",
    supabaseServiceRoleKey: "SERVICE_ROLE_KEY_VALUE",
    graphApiVersion: "v25.0",
    metaAppId: "123",
    metaAppSecret: "APP_SECRET_VALUE",
    hourlyMinute: 5,
    dailyTimeJst: { hour: 5, minute: 30 },
    backfillMaxDays: 30,
    backfillHistoryDays: 730,
    rateHardLimit: 90,
    rateSoftLimit: 50,
    logLevel: "info",
    outputDir: ".local",
    downloadAllowedHosts: ["cdninstagram.com"],
    ...overrides,
  };
}

describe("createJobDeps", () => {
  it("プロセスの秘密の一覧（processSecrets）にアプリシークレット、サービスロールキー、接続文字列の各部分、Supabase のホスト、追加分を登録する", async () => {
    const deps = createJobDeps(config(), { secretsToAdd: ["EXTRA_TOKEN", undefined, ""] });
    try {
      expect(deps.secrets).toBe(processSecrets);
      const text = [
        "APP_SECRET_VALUE",
        "SERVICE_ROLE_KEY_VALUE",
        "dbuser",
        "db%40pass",
        "db@pass",
        "db.example.supabase.co",
        "abcdefghij.supabase.co",
        "EXTRA_TOKEN",
      ].join(" ");
      expect(deps.secrets.mask(text)).toBe("*** *** *** *** *** *** *** ***");
      // index.ts のプロセスの保険が使う一覧にも登録されている
      expect(processSecrets.mask("x APP_SECRET_VALUE y")).toBe("x *** y");
      expect(deps.config.graphApiVersion).toBe("v25.0");
      expect(deps.fetchImpl).toBeUndefined();
      expect(deps.now).toBeUndefined();
    } finally {
      await closeJobDeps(deps);
    }
  });

  it("接続文字列が不正なら固定文言の Error を投げ、値を含まない", () => {
    const bad = "not a url with secret";
    let thrown: unknown;
    try {
      createJobDeps(config({ databaseUrl: bad }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/^DB /);
    expect((thrown as Error).message).not.toContain(bad);
    expect((thrown as Error).message).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// cleanOldTempDirs
// ---------------------------------------------------------------------------

describe("cleanOldTempDirs", () => {
  it("接頭辞つきで 1 日以上前のディレクトリだけを消す（ファイル、新しいもの、別の接頭辞は残す）", async () => {
    const root = await mkdtemp(join(tmpdir(), "framework-test-"));
    try {
      const now = Date.now();
      const old = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const recent = (now - 23 * 60 * 60 * 1000) / 1000;
      const makeDir = async (name: string, mtimeSec?: number): Promise<void> => {
        const path = join(root, name);
        await mkdir(path);
        await writeFile(join(path, "f.bin"), "x");
        if (mtimeSec !== undefined) await utimes(path, mtimeSec, mtimeSec);
      };
      await makeDir(`${TMP_DIR_PREFIX}old-a`, old);
      await makeDir(`${TMP_DIR_PREFIX}old-b`, old);
      await makeDir(`${TMP_DIR_PREFIX}recent`, recent);
      await makeDir(`${TMP_DIR_PREFIX}fresh`);
      await makeDir("worker-old", old);
      await makeDir("other-old", old);
      const file = join(root, `${TMP_DIR_PREFIX}file`);
      await writeFile(file, "x");
      await utimes(file, old, old);

      expect(await cleanOldTempDirs(root, now)).toBe(2);
      expect((await readdir(root)).sort()).toEqual(
        [`${TMP_DIR_PREFIX}recent`, `${TMP_DIR_PREFIX}fresh`, `${TMP_DIR_PREFIX}file`, "worker-old", "other-old"].sort(),
      );
      // 2 回目は消すものがない
      expect(await cleanOldTempDirs(root, now)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("root が読めなければ 0 を返して失敗しない", async () => {
    expect(await cleanOldTempDirs(join(tmpdir(), "framework-test-does-not-exist"), Date.now())).toBe(0);
  });

  it("接頭辞は instagram-worker-", () => {
    expect(TMP_DIR_PREFIX).toBe("instagram-worker-");
  });
});

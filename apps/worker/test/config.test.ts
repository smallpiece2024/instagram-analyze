import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_GRAPH_API_VERSION,
  DOWNLOAD_ALLOWED_HOSTS,
  GOOGLE_OAUTH_TOKEN_URI,
  loadRegisterTokenConfig,
  loadVerifyConfig,
  loadVisionKey,
  loadWorkerConfig,
  outputDir,
} from "../src/config.js";

/** テスト用の秘密鍵（PEM、PKCS#8）。コミットしないよう、テストの中で作る（R4.1 設計 8 章） */
const TEST_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

/** 架空のサービスアカウントの鍵（Google が出す JSON の形。値は架空） */
function visionKeyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "fake-project",
    private_key_id: "0123456789abcdef",
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: "vision-worker@fake-project.iam.gserviceaccount.com",
    client_id: "100000000000000000000",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: GOOGLE_OAUTH_TOKEN_URI,
    ...overrides,
  });
}

/** 必須の変数だけを持つ環境。値は架空のもの */
const BASE = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  META_APP_ID: "123",
  META_APP_SECRET: "app-secret",
} as const;

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...BASE, ...overrides };
}

/** 例外が ConfigError で、メッセージに変数名を含み、値を含まないことを確かめる */
function expectConfigError(fn: () => unknown, name: string, value?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const message = (caught as ConfigError).message;
  expect(message).toContain(name);
  if (value !== undefined) expect(message).not.toContain(value);
}

describe("loadWorkerConfig", () => {
  it("必須の変数がそろっていれば既定値で読める", () => {
    const config = loadWorkerConfig(env());
    expect(config).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      supabaseUrl: BASE.SUPABASE_URL,
      supabaseServiceRoleKey: BASE.SUPABASE_SERVICE_ROLE_KEY,
      graphApiVersion: DEFAULT_GRAPH_API_VERSION,
      metaAppId: "123",
      metaAppSecret: "app-secret",
      hourlyMinute: 5,
      dailyTimeJst: { hour: 5, minute: 30 },
      backfillMaxDays: 30,
      backfillHistoryDays: 730,
      rateHardLimit: 90,
      rateSoftLimit: 50,
      logLevel: "info",
      outputDir: ".local",
      downloadAllowedHosts: [...DOWNLOAD_ALLOWED_HOSTS],
      videoMaxPerRun: 5,
      videoBudgetMs: 480_000,
      videoTextMaxPerRun: 5,
      videoTextBudgetMs: 480_000,
      videoTextMaxUnitsPerRun: 200,
      videoTextMonthlyUnitLimit: 1000,
      videoTextMonthlyMaxVideos: 30,
      visionKey: { ok: false, reason: "missing" },
    });
  });

  it("WORKER_VIDEO_TEXT_MAX_PER_RUN: 0〜100 の整数（0 は候補を数えるだけ。R4 の下限 1 と違う）", () => {
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_PER_RUN: "0" })).videoTextMaxPerRun).toBe(0);
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_PER_RUN: "100" })).videoTextMaxPerRun).toBe(100);
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_PER_RUN: "" })).videoTextMaxPerRun).toBe(5);
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_PER_RUN: "-1" })), "WORKER_VIDEO_TEXT_MAX_PER_RUN", "-1");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_PER_RUN: "101" })), "WORKER_VIDEO_TEXT_MAX_PER_RUN", "101");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_PER_RUN: "five" })), "WORKER_VIDEO_TEXT_MAX_PER_RUN", "five");
  });

  it("WORKER_VIDEO_TEXT_BUDGET_MS: 0〜30 分の整数（ミリ秒）", () => {
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_BUDGET_MS: "0" })).videoTextBudgetMs).toBe(0);
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_BUDGET_MS: "1800000" })).videoTextBudgetMs).toBe(1_800_000);
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_BUDGET_MS: "1800001" })), "WORKER_VIDEO_TEXT_BUDGET_MS", "1800001");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_BUDGET_MS: "8m" })), "WORKER_VIDEO_TEXT_BUDGET_MS", "8m");
  });

  it("WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN: 1〜1000 の整数", () => {
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN: "1" })).videoTextMaxUnitsPerRun).toBe(1);
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN: "1000" })).videoTextMaxUnitsPerRun).toBe(1000);
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN: "0" })), "WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN: "1001" })), "WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN", "1001");
  });

  it("WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT: 0〜1000 の整数。上限は無料枠と同じで、超える値は受け付けない", () => {
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT: "0" })).videoTextMonthlyUnitLimit).toBe(0);
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT: "700" })).videoTextMonthlyUnitLimit).toBe(700);
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT: "1000" })).videoTextMonthlyUnitLimit).toBe(1000);
    expectConfigError(
      () => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT: "1001" })),
      "WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT",
      "1001",
    );
    expectConfigError(
      () => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT: "10000" })),
      "WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT",
      "10000",
    );
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT: "-1" })), "WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT", "-1");
  });

  it("WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS: 0〜1000 の整数", () => {
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS: "0" })).videoTextMonthlyMaxVideos).toBe(0);
    expect(loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS: "1000" })).videoTextMonthlyMaxVideos).toBe(1000);
    expectConfigError(
      () => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS: "1001" })),
      "WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS",
      "1001",
    );
    expectConfigError(() => loadWorkerConfig(env({ WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS: "30本" })), "WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS", "30本");
  });

  it("Vision の鍵は loadWorkerConfig の visionKey に入り、形が不正でも起動（設定の読み込み）は失敗しない", () => {
    const valid = loadWorkerConfig(env({ GCP_VISION_KEY_JSON: visionKeyJson() }));
    expect(valid.visionKey).toEqual({
      ok: true,
      key: { clientEmail: "vision-worker@fake-project.iam.gserviceaccount.com", privateKey: TEST_PRIVATE_KEY_PEM },
    });
    expect(loadWorkerConfig(env({ GCP_VISION_KEY_JSON: "{not json" })).visionKey).toEqual({ ok: false, reason: "invalid" });
    expect(loadWorkerConfig(env({ GCP_VISION_KEY_FILE: join(tmpdir(), "no-such-dir", "no-such-key.json") })).visionKey).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("必須の変数が欠けていれば変数名を示す ConfigError", () => {
    for (const name of ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "META_APP_ID", "META_APP_SECRET"]) {
      expectConfigError(() => loadWorkerConfig(env({ [name]: undefined })), name);
      expectConfigError(() => loadWorkerConfig(env({ [name]: "   " })), name);
    }
  });

  it("前後の空白を除く。任意の変数を読む", () => {
    const config = loadWorkerConfig(
      env({
        META_APP_ID: " 123 ",
        META_GRAPH_API_VERSION: "v26.0",
        WORKER_OUTPUT_DIR: "/app/.local",
        WORKER_LOG_LEVEL: "debug",
        WORKER_BACKFILL_MAX_DAYS: "7",
      }),
    );
    expect(config.metaAppId).toBe("123");
    expect(config.graphApiVersion).toBe("v26.0");
    expect(config.outputDir).toBe("/app/.local");
    expect(config.logLevel).toBe("debug");
    expect(config.backfillMaxDays).toBe(7);
  });

  it("WORKER_HOURLY_MINUTE: 0〜59 の整数。空文字は既定の 5", () => {
    expect(loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "" })).hourlyMinute).toBe(5);
    expect(loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "0" })).hourlyMinute).toBe(0);
    expect(loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "59" })).hourlyMinute).toBe(59);
    expectConfigError(() => loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "60" })), "WORKER_HOURLY_MINUTE", "60");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "-1" })), "WORKER_HOURLY_MINUTE", "-1");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "5.5" })), "WORKER_HOURLY_MINUTE", "5.5");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "abc" })), "WORKER_HOURLY_MINUTE", "abc");
  });

  it("WORKER_DAILY_TIME_JST: HH:MM（00:00〜23:59）", () => {
    expect(loadWorkerConfig(env({ WORKER_DAILY_TIME_JST: "05:30" })).dailyTimeJst).toEqual({ hour: 5, minute: 30 });
    expect(loadWorkerConfig(env({ WORKER_DAILY_TIME_JST: "00:00" })).dailyTimeJst).toEqual({ hour: 0, minute: 0 });
    expect(loadWorkerConfig(env({ WORKER_DAILY_TIME_JST: "23:59" })).dailyTimeJst).toEqual({ hour: 23, minute: 59 });
    expect(loadWorkerConfig(env({ WORKER_DAILY_TIME_JST: "" })).dailyTimeJst).toEqual({ hour: 5, minute: 30 });
    expectConfigError(() => loadWorkerConfig(env({ WORKER_DAILY_TIME_JST: "5:30" })), "WORKER_DAILY_TIME_JST", "5:30");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_DAILY_TIME_JST: "24:00" })), "WORKER_DAILY_TIME_JST", "24:00");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_DAILY_TIME_JST: "05:60" })), "WORKER_DAILY_TIME_JST", "05:60");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_DAILY_TIME_JST: "0530" })), "WORKER_DAILY_TIME_JST", "0530");
  });

  it("しきい値: 1〜100 の整数", () => {
    for (const name of ["WORKER_RATE_HARD_LIMIT", "WORKER_RATE_SOFT_LIMIT"]) {
      expectConfigError(() => loadWorkerConfig(env({ [name]: "0" })), name);
      expectConfigError(() => loadWorkerConfig(env({ [name]: "101" })), name, "101");
      expectConfigError(() => loadWorkerConfig(env({ [name]: "50%" })), name, "50%");
    }
    const config = loadWorkerConfig(env({ WORKER_RATE_HARD_LIMIT: "100", WORKER_RATE_SOFT_LIMIT: "1" }));
    expect(config.rateHardLimit).toBe(100);
    expect(config.rateSoftLimit).toBe(1);
  });

  it("WORKER_BACKFILL_MAX_DAYS: 1〜730 の整数", () => {
    expectConfigError(() => loadWorkerConfig(env({ WORKER_BACKFILL_MAX_DAYS: "0" })), "WORKER_BACKFILL_MAX_DAYS");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_BACKFILL_MAX_DAYS: "731" })), "WORKER_BACKFILL_MAX_DAYS", "731");
    expect(loadWorkerConfig(env({ WORKER_BACKFILL_MAX_DAYS: "730" })).backfillMaxDays).toBe(730);
  });

  it("WORKER_BACKFILL_HISTORY_DAYS: 1〜730 の整数。既定は 730。値は例外に含めない", () => {
    expect(loadWorkerConfig(env()).backfillHistoryDays).toBe(730);
    expect(loadWorkerConfig(env({ WORKER_BACKFILL_HISTORY_DAYS: "" })).backfillHistoryDays).toBe(730);
    expect(loadWorkerConfig(env({ WORKER_BACKFILL_HISTORY_DAYS: "400" })).backfillHistoryDays).toBe(400);
    expect(loadWorkerConfig(env({ WORKER_BACKFILL_HISTORY_DAYS: "1" })).backfillHistoryDays).toBe(1);
    expectConfigError(() => loadWorkerConfig(env({ WORKER_BACKFILL_HISTORY_DAYS: "0" })), "WORKER_BACKFILL_HISTORY_DAYS");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_BACKFILL_HISTORY_DAYS: "731" })), "WORKER_BACKFILL_HISTORY_DAYS", "731");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_BACKFILL_HISTORY_DAYS: "1y" })), "WORKER_BACKFILL_HISTORY_DAYS", "1y");
  });

  it("WORKER_LOG_LEVEL: info か debug", () => {
    expect(loadWorkerConfig(env({ WORKER_LOG_LEVEL: "info" })).logLevel).toBe("info");
    expect(loadWorkerConfig(env({ WORKER_LOG_LEVEL: "debug" })).logLevel).toBe("debug");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_LOG_LEVEL: "verbose" })), "WORKER_LOG_LEVEL", "verbose");
    expectConfigError(() => loadWorkerConfig(env({ WORKER_LOG_LEVEL: "DEBUG" })), "WORKER_LOG_LEVEL", "DEBUG");
  });

  it("秘密の値（接続文字列、キー）を例外のメッセージに含めない", () => {
    expectConfigError(
      () => loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "99" })),
      "WORKER_HOURLY_MINUTE",
      BASE.DATABASE_URL,
    );
    expectConfigError(
      () => loadWorkerConfig(env({ WORKER_HOURLY_MINUTE: "99" })),
      "WORKER_HOURLY_MINUTE",
      BASE.SUPABASE_SERVICE_ROLE_KEY,
    );
  });

  it("META_GRAPH_API_VERSION: v25.0 の形", () => {
    expect(loadWorkerConfig(env({ META_GRAPH_API_VERSION: "v25.0" })).graphApiVersion).toBe("v25.0");
    expect(loadWorkerConfig(env({ META_GRAPH_API_VERSION: "v100.12" })).graphApiVersion).toBe("v100.12");
    expectConfigError(() => loadWorkerConfig(env({ META_GRAPH_API_VERSION: "25.0" })), "META_GRAPH_API_VERSION", "25.0");
    expectConfigError(() => loadWorkerConfig(env({ META_GRAPH_API_VERSION: "v25" })), "META_GRAPH_API_VERSION", "v25");
    expectConfigError(() => loadWorkerConfig(env({ META_GRAPH_API_VERSION: "latest" })), "META_GRAPH_API_VERSION", "latest");
  });

  it("DATABASE_URL と SUPABASE_URL は URL として読めること。値は例外に含めない", () => {
    expectConfigError(() => loadWorkerConfig(env({ DATABASE_URL: "not a url" })), "DATABASE_URL", "not a url");
    expectConfigError(() => loadWorkerConfig(env({ SUPABASE_URL: "127.0.0.1:54321" })), "SUPABASE_URL", "127.0.0.1:54321");
    expect(loadWorkerConfig(env({ SUPABASE_URL: "https://abcdefghij.supabase.co" })).supabaseUrl).toBe(
      "https://abcdefghij.supabase.co",
    );
  });

  it("WORKER_RATE_SOFT_LIMIT は WORKER_RATE_HARD_LIMIT 以下", () => {
    expectConfigError(
      () => loadWorkerConfig(env({ WORKER_RATE_SOFT_LIMIT: "95", WORKER_RATE_HARD_LIMIT: "90" })),
      "WORKER_RATE_SOFT_LIMIT",
      "95",
    );
    expectConfigError(
      () => loadWorkerConfig(env({ WORKER_RATE_SOFT_LIMIT: "95", WORKER_RATE_HARD_LIMIT: "90" })),
      "WORKER_RATE_HARD_LIMIT",
    );
    const equal = loadWorkerConfig(env({ WORKER_RATE_SOFT_LIMIT: "90", WORKER_RATE_HARD_LIMIT: "90" }));
    expect(equal.rateSoftLimit).toBe(90);
    expect(equal.rateHardLimit).toBe(90);
    // 既定の HARD 90 に対して SOFT 95 も不可
    expectConfigError(() => loadWorkerConfig(env({ WORKER_RATE_SOFT_LIMIT: "95" })), "WORKER_RATE_SOFT_LIMIT");
  });

  it("ConfigError の name", () => {
    expect(new ConfigError("x").name).toBe("ConfigError");
  });
});

describe("loadRegisterTokenConfig", () => {
  it("ワーカーの設定に加えて META_ACCESS_TOKEN と IG_USER_ID が必須", () => {
    const config = loadRegisterTokenConfig(env({ META_ACCESS_TOKEN: "token", IG_USER_ID: "17841400000000000" }));
    expect(config.accessToken).toBe("token");
    expect(config.igUserId).toBe("17841400000000000");
    expect(config.rateHardLimit).toBe(90);
    expectConfigError(() => loadRegisterTokenConfig(env({ IG_USER_ID: "1" })), "META_ACCESS_TOKEN");
    expectConfigError(() => loadRegisterTokenConfig(env({ META_ACCESS_TOKEN: "token" })), "IG_USER_ID");
    // ワーカーの必須項目も要る
    expectConfigError(
      () => loadRegisterTokenConfig(env({ META_ACCESS_TOKEN: "token", IG_USER_ID: "1", DATABASE_URL: undefined })),
      "DATABASE_URL",
    );
  });
});

describe("loadVerifyConfig", () => {
  it("META_ACCESS_TOKEN だけが必須で、DB と Storage とアプリの項目は任意", () => {
    const config = loadVerifyConfig({ META_ACCESS_TOKEN: "token" });
    expect(config).toEqual({
      accessToken: "token",
      graphApiVersion: DEFAULT_GRAPH_API_VERSION,
      igUserId: undefined,
      appId: undefined,
      appSecret: undefined,
      databaseUrl: undefined,
      supabaseUrl: undefined,
      supabaseServiceRoleKey: undefined,
    });
    expectConfigError(() => loadVerifyConfig({}), "META_ACCESS_TOKEN");
    expectConfigError(
      () => loadVerifyConfig({ META_ACCESS_TOKEN: "token", META_GRAPH_API_VERSION: "25" }),
      "META_GRAPH_API_VERSION",
      "25",
    );
  });

  it("任意の項目があれば読む", () => {
    const config = loadVerifyConfig(env({ META_ACCESS_TOKEN: "token", IG_USER_ID: "1" }));
    expect(config.igUserId).toBe("1");
    expect(config.appId).toBe("123");
    expect(config.appSecret).toBe("app-secret");
    expect(config.databaseUrl).toBe(BASE.DATABASE_URL);
    expect(config.supabaseUrl).toBe(BASE.SUPABASE_URL);
    expect(config.supabaseServiceRoleKey).toBe(BASE.SUPABASE_SERVICE_ROLE_KEY);
  });
});

describe("outputDir", () => {
  it("WORKER_OUTPUT_DIR がなければ .local", () => {
    expect(outputDir({})).toBe(".local");
    expect(outputDir({ WORKER_OUTPUT_DIR: "/app/.local" })).toBe("/app/.local");
  });
});

describe("loadVisionKey（R4.1 設計 3.8 節）", () => {
  const VALID_EMAIL = "vision-worker@fake-project.iam.gserviceaccount.com";

  it("GCP_VISION_KEY_JSON の中身を読み、client_email と private_key だけを返す（token_uri や project_id は持たない）", () => {
    const key = loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson() });
    expect(key).toEqual({ ok: true, key: { clientEmail: VALID_EMAIL, privateKey: TEST_PRIVATE_KEY_PEM } });
    expect(TEST_PRIVATE_KEY_PEM.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("どちらの変数もなければ missing。空白だけも missing", () => {
    expect(loadVisionKey({})).toEqual({ ok: false, reason: "missing" });
    expect(loadVisionKey({ GCP_VISION_KEY_JSON: "  ", GCP_VISION_KEY_FILE: "" })).toEqual({ ok: false, reason: "missing" });
  });

  it("GCP_VISION_KEY_JSON があれば GCP_VISION_KEY_FILE より優先し、ファイルは読まない", () => {
    let reads = 0;
    const readFile = (): string => {
      reads += 1;
      return visionKeyJson({ client_email: "from-file@fake-project.iam.gserviceaccount.com" });
    };
    const key = loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson(), GCP_VISION_KEY_FILE: "/keys/vision.json" }, readFile);
    expect(key.ok).toBe(true);
    expect(key.ok && key.key.clientEmail).toBe(VALID_EMAIL);
    expect(reads).toBe(0);
  });

  it("GCP_VISION_KEY_FILE のファイルを読む（差し替えた読み込み関数と、実際のファイルの両方）", () => {
    const paths: string[] = [];
    const readFile = (path: string): string => {
      paths.push(path);
      return visionKeyJson();
    };
    expect(loadVisionKey({ GCP_VISION_KEY_FILE: "/keys/vision.json" }, readFile).ok).toBe(true);
    expect(paths).toEqual(["/keys/vision.json"]);

    // 実際のファイル。一時ディレクトリに書き、終わりに消す（鍵をコミットしない）
    const dir = mkdtempSync(join(tmpdir(), "vision-key-test-"));
    try {
      const file = join(dir, "key.json");
      writeFileSync(file, visionKeyJson(), "utf8");
      expect(loadVisionKey({ GCP_VISION_KEY_FILE: file })).toEqual({
        ok: true,
        key: { clientEmail: VALID_EMAIL, privateKey: TEST_PRIVATE_KEY_PEM },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ファイルの読み込みに失敗したら invalid。例外（パスを含む）を外に出さない", () => {
    const readFile = (path: string): string => {
      throw new Error(`ENOENT: no such file, open '${path}'`);
    };
    expect(loadVisionKey({ GCP_VISION_KEY_FILE: "/secret/path/key.json" }, readFile)).toEqual({ ok: false, reason: "invalid" });
    // 既定の読み込み関数でも、存在しないパスで例外にならない
    expect(loadVisionKey({ GCP_VISION_KEY_FILE: join(tmpdir(), "no-such-dir", "no-such-key.json") })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("JSON として読めない、オブジェクトでない、必要な項目がないときは invalid（例外にしない）", () => {
    for (const raw of ["{not json", "", "null", "[]", '"string"', "123", "{}", '{"client_email": 1}']) {
      if (raw === "") continue; // 空は missing（上のテスト）
      expect(loadVisionKey({ GCP_VISION_KEY_JSON: raw }), raw).toEqual({ ok: false, reason: "invalid" });
    }
    expect(loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson({ client_email: undefined }) })).toEqual({ ok: false, reason: "invalid" });
    expect(loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson({ private_key: undefined }) })).toEqual({ ok: false, reason: "invalid" });
    expect(loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson({ token_uri: undefined }) })).toEqual({ ok: false, reason: "invalid" });
    expect(loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson({ private_key: 123 }) })).toEqual({ ok: false, reason: "invalid" });
  });

  it("token_uri が定数 https://oauth2.googleapis.com/token と一致しなければ invalid（別のホストに鍵で署名した JWT を送らない）", () => {
    expect(GOOGLE_OAUTH_TOKEN_URI).toBe("https://oauth2.googleapis.com/token");
    for (const tokenUri of [
      "https://oauth2.googleapis.com/token/",
      "http://oauth2.googleapis.com/token",
      "https://oauth2.googleapis.com.evil.example/token",
      "https://example.com/token",
      "",
    ]) {
      expect(loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson({ token_uri: tokenUri }) }), tokenUri).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("client_email は @<プロジェクト>.iam.gserviceaccount.com で終わること", () => {
    for (const email of [
      "vision-worker@fake-project.iam.gserviceaccount.com",
      "a@p1.iam.gserviceaccount.com",
      "x@my-project-123.iam.gserviceaccount.com",
    ]) {
      expect(loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson({ client_email: email }) }).ok, email).toBe(true);
    }
    for (const email of [
      "someone@gmail.com",
      "vision-worker@fake-project.iam.gserviceaccount.com.evil.example",
      "vision-worker@Fake-Project.iam.gserviceaccount.com",
      "vision-worker@fake_project.iam.gserviceaccount.com",
      "fake-project.iam.gserviceaccount.com",
      "",
    ]) {
      expect(loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson({ client_email: email }) }), email).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("private_key は -----BEGIN PRIVATE KEY----- で始まること（証明書や RSA 形式の PEM、空は invalid）", () => {
    for (const privateKey of [
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n",
      " -----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
      "",
    ]) {
      expect(loadVisionKey({ GCP_VISION_KEY_JSON: visionKeyJson({ private_key: privateKey }) })).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("JSON の中で \\n にエスケープされた private_key は改行に戻って返る（Google の鍵ファイルの形）", () => {
    const json = visionKeyJson();
    expect(json).toContain("\\n");
    expect(json).not.toContain("\n");
    const key = loadVisionKey({ GCP_VISION_KEY_JSON: json });
    expect(key.ok && key.key.privateKey).toBe(TEST_PRIVATE_KEY_PEM);
    expect(key.ok && key.key.privateKey.split("\n").length).toBeGreaterThan(3);
  });
});

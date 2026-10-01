import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_GRAPH_API_VERSION,
  DOWNLOAD_ALLOWED_HOSTS,
  loadRegisterTokenConfig,
  loadVerifyConfig,
  loadWorkerConfig,
  outputDir,
} from "../src/config.js";

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

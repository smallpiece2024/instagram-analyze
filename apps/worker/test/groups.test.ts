import { describe, expect, it } from "vitest";
import { DAYS_ARG_ERROR, groupCommand, JOB_ARGS_ERROR, parseJobOptions } from "../src/commands/run-job.js";
import type { WorkerConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import type { JobDefinition, JobDeps, JobOptions } from "../src/jobs/framework.js";
import { DAILY_JOBS, HOURLY_JOBS, runGroup, type GroupEntry } from "../src/jobs/groups.js";
import { createLogger, SecretRegistry } from "../src/lib/log.js";

function config(): WorkerConfig {
  return {
    databaseUrl: "postgresql://dbuser:dbpass@db.example.supabase.co:5432/postgres",
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
    logLevel: "debug",
    outputDir: ".local",
    downloadAllowedHosts: ["cdninstagram.com"],
    videoMaxPerRun: 5,
    videoBudgetMs: 480_000,
  };
}

/** DB には触らない（`runJobs` を差し替える）ので `db` は空 */
function deps(lines: string[]): JobDeps {
  const secrets = new SecretRegistry();
  let tick = 0;
  return {
    db: undefined as unknown as Db,
    config: config(),
    log: createLogger("debug", secrets, (line) => lines.push(line)),
    secrets,
    // 呼ぶたびに 100ms 進む時計（duration_ms の検証用）
    now: () => new Date(1_700_000_000_000 + 100 * tick++),
  };
}

function def(name: JobDefinition["name"]): JobDefinition {
  return { name, run: async () => {} };
}

describe("runGroup", () => {
  const entries: GroupEntry[] = [
    { def: def("token_check") },
    { def: def("profile_daily") },
    { def: def("media_sync"), options: { full: true } },
  ];

  it("各ジョブを順に全アカウントで実行し、options を渡す。すべて成功なら true。開始と終了を 1 行ずつ出す", async () => {
    const lines: string[] = [];
    const seen: { name: string; options: JobOptions }[] = [];
    const result = await runGroup("daily", entries, deps(lines), async (d, _deps, options) => {
      seen.push({ name: d.name, options: options ?? {} });
      return true;
    });
    expect(result).toBe(true);
    expect(seen).toEqual([
      { name: "token_check", options: {} },
      { name: "profile_daily", options: {} },
      { name: "media_sync", options: { full: true } },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ INFO {2}group=daily status=start jobs=3$/);
    expect(lines[1]).toMatch(/ INFO {2}group=daily status=success jobs=3 failed=0 duration_ms=\d+$/);
  });

  it("signal が abort されていれば、実行中のジョブを終えたあと残りを飛ばして warn を出す。失敗には数えない", async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const controller = new AbortController();
    const result = await runGroup(
      "hourly",
      entries,
      deps(lines),
      async (d) => {
        seen.push(d.name);
        if (d.name === "token_check") controller.abort(); // 実行中に停止要求
        return true;
      },
      controller.signal,
    );
    expect(result).toBe(true);
    expect(seen).toEqual(["token_check"]);
    expect(lines.some((l) => /WARN {2}group=hourly status=aborted remaining=2$/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/INFO {2}group=hourly status=aborted jobs=3 failed=0 duration_ms=\d+$/);
  });

  it("最初から abort されていれば 1 つも実行しない（remaining=3）。signal なしなら従来どおり", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    expect(
      await runGroup(
        "daily",
        entries,
        deps(lines),
        async () => {
          called += 1;
          return true;
        },
        controller.signal,
      ),
    ).toBe(true);
    expect(called).toBe(0);
    expect(lines.some((l) => /status=aborted remaining=3$/.test(l))).toBe(true);

    expect(
      await runGroup("daily", entries, deps([]), async () => {
        called += 1;
        return true;
      }),
    ).toBe(true);
    expect(called).toBe(3);
  });

  it("途中のジョブが失敗（failed）しても次に進み、1 つでも失敗なら false。終了行に failed= を出す", async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const result = await runGroup("hourly", entries, deps(lines), async (d) => {
      seen.push(d.name);
      return d.name !== "profile_daily";
    });
    expect(result).toBe(false);
    expect(seen).toEqual(["token_check", "profile_daily", "media_sync"]);
    expect(lines[1]).toMatch(/ INFO {2}group=hourly status=failed jobs=3 failed=1 duration_ms=\d+$/);
  });

  it("runJobs が投げても失敗として数えて次に進む（例外は外に出ない）。メッセージはマスクされる", async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const result = await runGroup("hourly", entries, deps(lines), async (d) => {
      seen.push(d.name);
      if (d.name === "token_check") throw new Error("boom https://graph.facebook.com/x?access_token=SECRET");
      return true;
    });
    expect(result).toBe(false);
    expect(seen).toEqual(["token_check", "profile_daily", "media_sync"]);
    expect(lines.some((l) => l.includes("WARN") && l.includes("group=hourly") && l.includes("job=token_check") && l.includes("status=failed") && l.includes("error_code=none") && l.includes("class=unknown"))).toBe(true);
    expect(lines.some((l) => l.includes("DEBUG") && l.includes('error="boom <url>"'))).toBe(true);
    expect(lines.join("\n")).not.toContain("SECRET");
    expect(lines.at(-1)).toMatch(/status=failed jobs=3 failed=1 /);
  });

  it("空のグループは true（開始と終了の行は出る）", async () => {
    const lines: string[] = [];
    let called = false;
    expect(
      await runGroup("daily", [], deps(lines), async () => {
        called = true;
        return true;
      }),
    ).toBe(true);
    expect(called).toBe(false);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/status=success jobs=0 failed=0 /);
  });

  it("HOURLY_JOBS と DAILY_JOBS は設計 6.1 章の順で、daily の media_sync だけ --full", () => {
    expect(HOURLY_JOBS.map((e) => e.def.name)).toEqual(["stories", "media_sync", "media_snapshot", "video_analysis", "account_backfill"]);
    expect(HOURLY_JOBS.map((e) => e.options)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // R5 設計 3.2 節: audience_demographics は account_daily の後、media_sync --full の前
    expect(DAILY_JOBS.map((e) => e.def.name)).toEqual(["token_check", "profile_daily", "account_daily", "audience_demographics", "media_sync"]);
    expect(DAILY_JOBS.map((e) => e.options)).toEqual([undefined, undefined, undefined, undefined, { full: true }]);
    // hourly と daily の media_sync は同じ定義（options だけが違う）
    expect(DAILY_JOBS[4]?.def).toBe(HOURLY_JOBS[1]?.def);
    // 属性は daily だけ（hourly には入れない）
    expect(HOURLY_JOBS.some((e) => e.def.name === "audience_demographics")).toBe(false);
    for (const entry of [...HOURLY_JOBS, ...DAILY_JOBS]) expect(typeof entry.def.run).toBe("function");
  });
});

describe("groupCommand（commands/run-job）", () => {
  it("引数があれば固定文言で投げる（設定を読む前に止まるので環境変数は要らない）", async () => {
    await expect(groupCommand("hourly", [], "x").run(["--bogus"])).rejects.toThrow("run-hourly は引数を取らない");
    await expect(groupCommand("daily", [], "x").run(["extra"])).rejects.toThrow("run-daily は引数を取らない");
    expect(groupCommand("hourly", [], "説明").description).toBe("説明");
  });
});

describe("parseJobOptions（commands/run-job）", () => {
  it("引数なし、--full、--days を読む", () => {
    expect(parseJobOptions([])).toEqual({ ok: true, options: {} });
    expect(parseJobOptions(["--full"])).toEqual({ ok: true, options: { full: true } });
    expect(parseJobOptions(["--days", "7"])).toEqual({ ok: true, options: { days: 7 } });
    expect(parseJobOptions(["--days=730", "--full"])).toEqual({ ok: true, options: { full: true, days: 730 } });
    expect(parseJobOptions(["--days", "1"])).toEqual({ ok: true, options: { days: 1 } });
  });

  it("未知の引数や位置引数は固定文言（値を含めない）", () => {
    expect(parseJobOptions(["--bogus"])).toEqual({ ok: false, error: JOB_ARGS_ERROR });
    expect(parseJobOptions(["extra"])).toEqual({ ok: false, error: JOB_ARGS_ERROR });
    expect(parseJobOptions(["--days"])).toEqual({ ok: false, error: JOB_ARGS_ERROR });
    expect(JOB_ARGS_ERROR).not.toContain("bogus");
  });

  it("--days は 1〜730 の整数だけ", () => {
    for (const bad of ["0", "731", "1.5", "abc", "1e2", "0x10"]) {
      expect(parseJobOptions(["--days", bad])).toEqual({ ok: false, error: DAYS_ARG_ERROR });
    }
    // `-1` は短いオプション、空文字は位置引数として parseArgs の段階で弾かれる（どちらも固定文言）
    for (const bad of ["-1", ""]) {
      const parsed = parseJobOptions(["--days", bad]);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.error).toMatch(/^(引数が不正|--days は)/);
    }
  });
});

/**
 * `schedule`: コンテナ内で常駐し、hourly と daily のグループを決まった時刻に動かす（設計 2 章）。
 * `docker compose up -d worker` で起動し、SIGTERM（`docker compose stop`）か SIGINT で、実行中のグループを
 * 終えてから止まる。
 */
import { parseArgs } from "node:util";
import { loadWorkerConfig } from "../config.js";
import { latestStartedAt } from "../db/job-runs.js";
import type { JobName } from "../db/types.js";
import { closeJobDeps, createJobDeps, describeError } from "../jobs/framework.js";
import { DEFAULT_INTERVAL_MS, runScheduler, type LastStarted } from "../jobs/scheduler.js";

const COMMAND = "schedule";

/** hourly グループの先頭のジョブ。この `started_at` を hourly の最終実行時刻とみなす */
const HOURLY_MARKER: JobName = "stories";
/** daily グループの最初に必ず行が残るジョブ（`token_check` は `shouldRun` を持たないが、将来の変更に備えて設計 2.3 章のとおり `profile_daily` を使う） */
const DAILY_MARKER: JobName = "profile_daily";

function formatDailyTime(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

export async function schedule(args: string[]): Promise<boolean> {
  try {
    parseArgs({ args, options: {}, strict: true, allowPositionals: false });
  } catch {
    throw new Error(`${COMMAND} は引数を取らない`);
  }

  const config = loadWorkerConfig();
  const deps = createJobDeps(config);
  const { db, log, secrets } = deps;
  const controller = new AbortController();
  const stop = (signal: string): void => {
    log.info({ scheduler: "stopping", signal });
    controller.abort();
  };
  // 2 回目の同じシグナルは Node の既定（即終了）に任せる
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  try {
    const lastStarted: LastStarted = {
      hourly: await latestStartedAt(db, HOURLY_MARKER),
      daily: await latestStartedAt(db, DAILY_MARKER),
    };
    log.info({
      scheduler: "start",
      hourly_minute: config.hourlyMinute,
      daily_time_jst: formatDailyTime(config.dailyTimeJst),
      interval_s: DEFAULT_INTERVAL_MS / 1000,
      last_hourly: lastStarted.hourly ? "あり" : "なし",
      last_daily: lastStarted.daily ? "あり" : "なし",
    });
    await runScheduler(deps, { signal: controller.signal, lastStarted });
    log.info({ scheduler: "stopped" });
    return true;
  } catch (error) {
    const failure = describeError(error, secrets);
    log.warn({ scheduler: "failed", error_code: failure.code ?? "none", class: failure.errorClass });
    log.debug({ scheduler: "failed", error: failure.message });
    return false;
  } finally {
    await closeJobDeps(deps);
  }
}

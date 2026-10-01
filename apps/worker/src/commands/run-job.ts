/**
 * ジョブ名とグループ名から `index.ts` の `COMMANDS` に登録するコマンドを作るヘルパ（設計 1.1 章）。
 *
 * - ジョブのコマンド: `worker media-sync [--full] [--days <n>]`。`accounts.status = 'active'` の全アカウントで
 *   実行し、`failed` のアカウントがなければ終了コード 0（`partial` と `skipped` は 0。設計 1.1 章）
 * - グループのコマンド: `worker run-hourly`、`worker run-daily`。途中のジョブが失敗しても次に進み、
 *   1 つでも `failed` があれば終了コード 1
 * - 引数の不備は固定文言の例外にする（`index.ts` の `main` がマスクして 1 行出し、終了コード 1 にする）。
 *   引数の値はメッセージに含めない
 */
import { parseArgs } from "node:util";
import { loadWorkerConfig } from "../config.js";
import { closeJobDeps, createJobDeps, runJobsForActiveAccounts, type JobDefinition, type JobOptions } from "../jobs/framework.js";
import { runGroup, type GroupEntry, type GroupName } from "../jobs/groups.js";

export interface CommandSpec {
  description: string;
  /** 戻り値が false なら終了コード 1 */
  run: (args: string[]) => Promise<boolean>;
}

/** `--days` の範囲（設計 5.2 章、5.3 章。バックフィルの上限と同じ） */
const MIN_DAYS = 1;
const MAX_DAYS = 730;

export const JOB_ARGS_ERROR = "引数が不正（--full と --days <n> だけを受け付ける）";
export const DAYS_ARG_ERROR = `--days は ${MIN_DAYS}〜${MAX_DAYS} の整数`;

export type ParsedJobOptions = { ok: true; options: JobOptions } | { ok: false; error: string };

/**
 * ジョブのコマンドライン引数を読む純粋関数。`--full`（真偽）と `--days <n>`（1〜730 の整数）だけを受け付け、
 * それ以外や不正な値は固定文言のエラーにする（値は含めない）
 */
export function parseJobOptions(args: string[]): ParsedJobOptions {
  let values: { full?: boolean; days?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: { full: { type: "boolean" }, days: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return { ok: false, error: JOB_ARGS_ERROR };
  }
  const options: JobOptions = {};
  if (values.full) options.full = true;
  if (values.days !== undefined) {
    if (!/^\d+$/.test(values.days)) return { ok: false, error: DAYS_ARG_ERROR };
    const days = Number(values.days);
    if (days < MIN_DAYS || days > MAX_DAYS) return { ok: false, error: DAYS_ARG_ERROR };
    options.days = days;
  }
  return { ok: true, options };
}

/** 1 つのジョブを全アカウントで 1 回実行するコマンド */
export function jobCommand(def: JobDefinition, description: string): CommandSpec {
  return {
    description,
    run: async (args) => {
      const parsed = parseJobOptions(args);
      if (!parsed.ok) throw new Error(parsed.error);
      const deps = createJobDeps(loadWorkerConfig());
      try {
        return await runJobsForActiveAccounts(def, deps, parsed.options);
      } finally {
        await closeJobDeps(deps);
      }
    },
  };
}

/** グループのジョブを順に 1 回実行するコマンド（`run-hourly`、`run-daily`）。引数は取らない */
export function groupCommand(name: GroupName, entries: GroupEntry[], description: string): CommandSpec {
  return {
    description,
    run: async (args) => {
      try {
        parseArgs({ args, options: {}, strict: true, allowPositionals: false });
      } catch {
        throw new Error(`run-${name} は引数を取らない`);
      }
      const deps = createJobDeps(loadWorkerConfig());
      try {
        return await runGroup(name, entries, deps);
      } finally {
        await closeJobDeps(deps);
      }
    },
  };
}

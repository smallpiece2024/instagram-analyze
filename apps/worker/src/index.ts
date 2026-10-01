/**
 * ワーカーの入口: `worker <command> [args]`。
 *
 * - コマンドは `COMMANDS` に登録する。ジョブは `jobCommand`、グループは `groupCommand` で作る（設計 1.1 章）
 * - プロセスの保険: `unhandledRejection` と `uncaughtException` で、マスクしたメッセージを 1 行出して終了コード 1。
 *   メッセージは `describeError(error, processSecrets)`（`createJobDeps` と `runJob` が登録した秘密 ＋ パターン。
 *   `PostgresError` は固定文言）で作る
 * - 起動時に `os.tmpdir()` 配下の古い `instagram-worker-*` ディレクトリ（1 日以上前）を消す（設計 1.2 章）
 * - ここで `console.log` を使うのは使い方の表示だけ。例外のオブジェクト（`new URL()` の `input` に接続文字列を持つ
 *   `ERR_INVALID_URL`、`query`／`parameters` を持つ `PostgresError` など）は出さない
 */
import { checkEnv } from "./commands/check-env.js";
import { registerToken } from "./commands/register-token.js";
import { groupCommand, jobCommand, type CommandSpec } from "./commands/run-job.js";
import { schedule } from "./commands/schedule.js";
import { verifyApi } from "./commands/verify-api.js";
import { job as accountBackfillJob } from "./jobs/account-backfill.js";
import { job as accountDailyJob } from "./jobs/account-daily.js";
import { cleanOldTempDirs, describeError, processSecrets } from "./jobs/framework.js";
import { DAILY_JOBS, HOURLY_JOBS } from "./jobs/groups.js";
import { job as mediaSnapshotJob } from "./jobs/media-snapshot.js";
import { job as mediaSyncJob } from "./jobs/media-sync.js";
import { job as profileDailyJob } from "./jobs/profile-daily.js";
import { job as storiesJob } from "./jobs/stories.js";
import { job as tokenCheckJob } from "./jobs/token-check.js";

type Command = CommandSpec;

/** 使い方の表示順。設定 → ジョブ → グループ → 常駐 → 既存の検証コマンド */
const COMMANDS: Record<string, Command> = {
  "register-token": {
    description: ".env のトークンを debug_token で調べ、accounts、private.credentials、Vault に登録する",
    run: (args) => registerToken(args),
  },
  "token-check": jobCommand(tokenCheckJob, "トークンの期限と状態を確かめて private.credentials を更新する"),
  "profile-daily": jobCommand(profileDailyJob, "プロフィールの日次記録"),
  "account-daily": jobCommand(accountDailyJob, "アカウント日次指標の直近 4 日と follower_count（--days <n> で日数を変える）"),
  "account-backfill": jobCommand(accountBackfillJob, "アカウント日次指標の 2 年分のバックフィル。job_state で再開"),
  "media-sync": jobCommand(mediaSyncJob, "投稿一覧の同期。--full で全ページを読み、消えた投稿を検出する"),
  "media-snapshot": jobCommand(mediaSnapshotJob, "投稿指標のスナップショット"),
  stories: jobCommand(storiesJob, "ストーリーズの一覧、指標、動画解析"),
  "run-hourly": groupCommand("hourly", HOURLY_JOBS, "stories → media-sync → media-snapshot → account-backfill を順に実行"),
  "run-daily": groupCommand("daily", DAILY_JOBS, "token-check → profile-daily → account-daily → media-sync --full を順に実行"),
  schedule: {
    description: "常駐して 1 時間ごとに run-hourly、1 日 1 回 run-daily を同じプロセス内で実行する",
    run: (args) => schedule(args),
  },
  "check-env": {
    description: "ffmpeg / ffprobe の動作と、動画の長さ・カットの取得を検証用動画で確かめる",
    run: () => checkEnv(),
  },
  "verify-api": {
    description: "Meta API で取得できる項目と制約を実機で検証し、結果を .local/api-verification に書き出す",
    run: () => verifyApi(),
  },
};

let fatalSeen = false;

function errorMessage(error: unknown): string {
  return describeError(error, processSecrets).message;
}

/** プロセスの保険。例外のオブジェクトは出さず、マスクしたメッセージを 1 行だけ出す */
function reportFatal(kind: string, error: unknown): void {
  fatalSeen = true;
  console.error(`${kind}: ${errorMessage(error)}`);
  process.exitCode = 1;
}

// unhandledRejection は 1 行出して終了コード 1 にし、処理は続ける（1 回実行のコマンドは main の終了で止まる）。
// 常駐（schedule）でも続けるか止めるかは段階 3 で決める
process.on("unhandledRejection", (reason) => {
  reportFatal("unhandledRejection", reason);
});
process.on("uncaughtException", (error) => {
  reportFatal("uncaughtException", error);
  // 例外のあとの状態は保証できないので、ここで終わる（常駐中なら restart で戻る）
  process.exit(1);
});

function usage(): void {
  console.log("使い方: worker <command> [args]");
  console.log("");
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length)) + 2;
  for (const [name, { description }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(width)} ${description}`);
  }
}

async function main(): Promise<number> {
  const [name, ...args] = process.argv.slice(2);
  // `constructor` や `__proto__` のような名前でプロトタイプを引かないよう、自身のプロパティだけを見る
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    usage();
    return name ? 1 : 0;
  }
  await cleanOldTempDirs();
  try {
    return (await command.run(args)) ? 0 : 1;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}

const code = await main();
process.exitCode = fatalSeen ? 1 : code;

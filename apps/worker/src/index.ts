import { checkEnv } from "./commands/check-env.js";
import { verifyApi } from "./commands/verify-api.js";

const COMMANDS: Record<string, { description: string; run: () => Promise<boolean> }> = {
  "check-env": {
    description: "ffmpeg / ffprobe の動作と、動画の長さ・カットの取得を検証用動画で確かめる",
    run: checkEnv,
  },
  "verify-api": {
    description: "Meta API で取得できる項目と制約を実機で検証し、結果を .local/api-verification に書き出す",
    run: verifyApi,
  },
};

function usage(): void {
  console.log("使い方: worker <command>");
  console.log("");
  for (const [name, { description }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${description}`);
  }
}

async function main(): Promise<number> {
  const name = process.argv[2];
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    usage();
    return name ? 1 : 0;
  }
  try {
    return (await command.run()) ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = await main();

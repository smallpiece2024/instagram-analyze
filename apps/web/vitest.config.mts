import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * vitest の設定（設計 4.2 章）。
 *
 * - 純粋関数と、`TEST_DATABASE_URL` があるときだけ動く結合テストだけを対象にする。
 *   async Server Components は vitest でテストしない（Next.js の docs のとおり）ので、jsdom や React のプラグインは入れない
 * - `server-only` は Next.js がコンパイラで扱うモジュールで、vitest では解決できないので空のスタブに差し替える
 * - `@/lib/dynamic`（`connection()` の呼び出し）は Next.js のリクエスト外では例外になるので、何もしないスタブに差し替える
 */
const src = fileURLToPath(new URL("./src", import.meta.url));
const stubs = fileURLToPath(new URL("./test/stubs", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "server-only", replacement: `${stubs}/server-only.ts` },
      { find: "@/lib/dynamic", replacement: `${stubs}/dynamic.ts` },
      { find: "@", replacement: src },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // 結合テスト（test/db/*）は同じローカル DB を共有し、Vault の件数などを数えるものがあるので、
    // ファイルを並列に走らせない（全体で 1〜2 秒なので速度への影響はない）
    fileParallelism: false,
  },
});

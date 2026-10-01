/**
 * リクエスト時の描画への切り替え（設計 1.2 章「動的描画」）。
 *
 * DB の読み出しは Request-time API ではないので、それだけではルートが動的にならず `next build` で焼き込まれる。
 * 読み出し関数は先頭でこれを呼ぶ（`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md`）。
 * `connection()` は Next.js のリクエスト外（vitest）では例外になるので、テストでは `test/stubs/dynamic.ts` に差し替える
 */
import "server-only";
import { connection } from "next/server";

export async function markDynamic(): Promise<void> {
  await connection();
}

/**
 * 結合テスト（`test/db/*.test.ts`）の共通の手伝い。架空の ID と、`readEnv` が読む環境変数の差し替え。
 * 架空の値だけを使い、実データの ID やユーザー名を書かない。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

/** 架空の Instagram アカウント ID（実在しない。先頭 6 桁が 0） */
export function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 架空のメディア ID（数字だけ。先頭 4 桁が 0、`seq` は 3 桁で末尾） */
export function fakeMediaId(seq: number): string {
  return "0000" + Date.now().toString() + seq.toString().padStart(3, "0");
}

/**
 * `readEnv` が読む変数を設定し、元に戻す関数を返す。DB 以外は架空の値（Meta には繋がない）。
 * `META_TARGET_IG_USER_ID` は `target` を渡せば設定し、渡さなければ消す
 */
export function setWebEnv(databaseUrl: string, target?: string): () => void {
  const values: Record<string, string | undefined> = {
    DATABASE_URL: databaseUrl,
    META_APP_ID: "1",
    META_APP_SECRET: "test-secret",
    META_GRAPH_API_VERSION: "v25.0",
    APP_URL: "http://localhost:3000",
    META_TARGET_IG_USER_ID: target,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

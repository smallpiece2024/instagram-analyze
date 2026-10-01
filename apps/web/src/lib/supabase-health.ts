/**
 * Supabase の各サービスに接続できるかを確かめる（R0: F-SYS-03）。
 * サーバー側でのみ呼ぶ。R1 ではトップ画面の「開発環境」の節に残す（設計 1.1 章。タイムアウトは 2 秒）。
 *
 * 設計 1.2 章の例外: `process.env` を読むのは `readEnv` だけという決まりに対し、このモジュールは `NEXT_PUBLIC_` の
 * 2 つ（ブラウザに出してよい値）を直接読む R0 の残置。R2 で削除する。
 */
import "server-only";

export interface ServiceHealth {
  name: string;
  path: string;
  ok: boolean;
  detail: string;
}

const SERVICES: { name: string; path: string }[] = [
  { name: "Auth（認証）", path: "/auth/v1/health" },
  { name: "REST API（PostgREST 経由の DB）", path: "/rest/v1/" },
  { name: "Storage（ファイル保存）", path: "/storage/v1/version" },
];

export interface SupabaseHealth {
  url: string | undefined;
  configured: boolean;
  services: ServiceHealth[];
}

/** `timeoutMs` は 1 サービスあたりの制限時間（既定 5 秒） */
export async function checkSupabaseHealth(timeoutMs = 5000): Promise<SupabaseHealth> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    return { url, configured: false, services: [] };
  }

  const services = await Promise.all(
    SERVICES.map(async ({ name, path }): Promise<ServiceHealth> => {
      try {
        const res = await fetch(`${url}${path}`, {
          headers: { apikey: key },
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { name, path, ok: res.ok, detail: `HTTP ${res.status}` };
      } catch {
        // 例外のメッセージには接続先が入りうるので固定文言にする
        return { name, path, ok: false, detail: "接続できません" };
      }
    }),
  );
  return { url, configured: true, services };
}

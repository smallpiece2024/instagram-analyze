/**
 * Supabase の各サービスに接続できるかを確かめる（R0: F-SYS-03）。
 * サーバー側でのみ呼ぶ。
 */

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

export async function checkSupabaseHealth(): Promise<SupabaseHealth> {
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
          signal: AbortSignal.timeout(5000),
        });
        return { name, path, ok: res.ok, detail: `HTTP ${res.status}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { name, path, ok: false, detail: `接続できません（${message}）` };
      }
    }),
  );
  return { url, configured: true, services };
}

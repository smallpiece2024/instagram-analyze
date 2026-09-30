import { connection } from "next/server";
import { checkSupabaseHealth } from "@/lib/supabase-health";

export default async function Home() {
  // 表示のたびに接続状態を確かめるため、リクエスト時に描画する
  await connection();
  const health = await checkSupabaseHealth();
  const allOk = health.configured && health.services.every((s) => s.ok);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <h1 className="text-2xl font-bold">Instagram 分析ツール</h1>
      <p className="mt-2 text-sm text-neutral-500">
        R0: ローカル開発環境。分析画面は R1 以降で追加します。
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Supabase の接続状態</h2>
        <p className="mt-1 text-sm text-neutral-500">接続先: {health.url ?? "未設定"}</p>

        {!health.configured ? (
          <p className="mt-4 rounded border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
            環境変数が設定されていません。apps/web/.env.example を .env.local にコピーし、値を入れてください。
          </p>
        ) : (
          <>
            <ul className="mt-4 divide-y divide-neutral-200 rounded border border-neutral-200">
              {health.services.map((s) => (
                <li key={s.path} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span>{s.name}</span>
                  <span
                    className={
                      s.ok
                        ? "rounded bg-green-100 px-2 py-0.5 text-sm text-green-800"
                        : "rounded bg-red-100 px-2 py-0.5 text-sm text-red-800"
                    }
                  >
                    {s.ok ? "OK" : "NG"}・{s.detail}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm">
              {allOk
                ? "すべてのサービスに接続できています。"
                : "接続できないサービスがあります。ルートで npm run db:start を実行したか確認してください。"}
            </p>
          </>
        )}
      </section>
    </main>
  );
}

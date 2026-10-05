import { ConnectionStatusList } from "@/app/jobs/_components/connection-status";

/**
 * 接続状態（R1 設計 1.1 章）。部品は R3 段階 0 で `/jobs` 側（`app/jobs/_components/connection-status.tsx`）へ移した。
 * R3 段階 1 でこのページを概要に作り直すまでは、今までどおり接続状態を表示する
 */
export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <h1 className="text-2xl font-bold">接続状態</h1>
      <p className="mt-1 text-sm text-neutral-500">Meta との接続と、収集の最終時刻。</p>

      <div className="mt-6">
        <ConnectionStatusList />
      </div>
    </main>
  );
}

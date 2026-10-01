"use client";

/**
 * 予期しないエラーの安全網（設計 1.2 章、3 章）。唯一の Client Component。
 * 開発時は `error.message` に元の文言（接続先などを含みうる）が入るので描画しない。`digest` だけを出す
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <h1 className="text-xl font-bold">画面を表示できませんでした</h1>
      <p className="mt-2 text-sm text-neutral-600">
        予期しないエラーが起きました。開発サーバーの端末の出力を確認してください。
      </p>
      {error.digest && <p className="mt-2 font-mono text-xs text-neutral-500">識別子: {error.digest}</p>}
      <button
        type="button"
        onClick={() => retry()}
        className="mt-6 rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
      >
        再試行
      </button>
    </main>
  );
}

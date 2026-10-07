import type { NextConfig } from "next";

/**
 * Next.js の設定（設計 1.2 章、1.5 章、2.5 章）。
 *
 * - `cacheComponents` は設定しない（従来モデル。動的描画は `src/lib/dynamic.ts` の `connection()` で行う）
 * - `serverExternalPackages`: postgres.js は Node の `net`／`tls` を使うのでバンドルから外す
 * - `logging.incomingRequests.ignore`: 開発サーバーの受信ログからコールバック（`?code=...&state=...`）を除く。
 *   `logging.fetches` は設定しない（fetch の URL が端末に出る）
 * - `headers()`: 全ルートに固定のセキュリティヘッダ。`Referrer-Policy` は `same-origin`（`no-referrer` にすると
 *   ブラウザが同一オリジンのフォーム送信でも `Origin: null` を送り、`/api/meta/login` の Origin 検査が 403 になる。
 *   `same-origin` でも Referer は他のオリジン（Storage、Meta）には送られない。`test/next-config.test.ts`）。
 *   署名付き URL か本人のデータを含むページ（`NO_STORE_PAGES`）は `Cache-Control: private, no-store`
 */
/**
 * 共有のキャッシュにも履歴のキャッシュにも残さないページの経路。
 * R3・R4: 署名付き URL を含むページ（投稿一覧、投稿詳細、リール分析）。
 * R5: タグ分析、タグの編集、ストーリーズ、オーディエンス、投稿時刻（R5 設計 4 章の S12）
 */
const NO_STORE_PAGES = [
  "/media",
  "/media/:id",
  "/reels",
  "/tags",
  "/tags/edit",
  "/stories",
  "/audience",
  "/timing",
] as const;

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  logging: {
    incomingRequests: {
      ignore: [/^\/api\/meta\/callback/],
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      // 署名付き URL（サムネイル）か本人のデータを含むページは共有のキャッシュにも履歴のキャッシュにも残さない
      // （R3 設計 4.7 節、R5 設計 4 章）
      ...NO_STORE_PAGES.map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      })),
    ];
  },
};

export default nextConfig;

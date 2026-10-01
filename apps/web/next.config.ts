import type { NextConfig } from "next";

/**
 * Next.js の設定（設計 1.2 章、1.5 章、2.5 章）。
 *
 * - `cacheComponents` は設定しない（従来モデル。動的描画は `src/lib/dynamic.ts` の `connection()` で行う）
 * - `serverExternalPackages`: postgres.js は Node の `net`／`tls` を使うのでバンドルから外す
 * - `logging.incomingRequests.ignore`: 開発サーバーの受信ログからコールバック（`?code=...&state=...`）を除く。
 *   `logging.fetches` は設定しない（fetch の URL が端末に出る）
 * - `headers()`: 全ルートに固定のセキュリティヘッダ
 */
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
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;

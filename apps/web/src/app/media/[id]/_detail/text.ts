/** 投稿詳細で使う文字の組み立て（純粋関数と定数）。指標の定義の文言は `lib/metric-definitions.ts` */

/** 区分の X 軸のラベル */
export const HORIZON_LABEL: Record<string, string> = {
  "1h": "1 時間",
  "3h": "3 時間",
  "6h": "6 時間",
  "24h": "24 時間",
  "3d": "3 日",
  "7d": "7 日",
  "30d": "30 日",
  "90d": "90 日",
};

/**
 * 「同じ種類の中で上位 n%」（3.4 節）。順位 k = 1 + この投稿より大きい比較相手の数、母数 m = 比較相手の数 + 1。
 * 表示は上位 ⌈k ÷ m × 100⌉%。この投稿の値がない、または m = 1 なら null
 */
export function topPercent(greater: number | null, peers: number): { percent: number; rank: number; of: number } | null {
  if (greater === null || !Number.isFinite(greater) || !Number.isFinite(peers) || peers < 1) return null;
  const rank = greater + 1;
  const of = peers + 1;
  return { percent: Math.ceil((rank / of) * 100), rank, of };
}

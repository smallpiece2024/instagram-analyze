/**
 * 投稿詳細で使う文字の組み立て（純粋関数と定数）。
 * 指標の定義の文言は R3 設計 4.6 節では `metric_definitions.description` と `lib/metric-definitions.ts` に置く。
 * それができるまで、見本（`render.js` の `DEF`）の文言をここに置く
 */
import type { PeerMetric } from "@/lib/queries/media-detail";

/** 指標名とヒントの文言（計算式、分母、API で取れない範囲） */
export const METRIC_TEXT: Record<PeerMetric | "retention_rate", { label: string; hint: string }> = {
  reach: { label: "リーチ", hint: "リーチ = 投稿を見たアカウントの数。同じ人は 1 回だけ数える（Meta の推定値）" },
  views: { label: "閲覧数", hint: "閲覧数 = 投稿が表示された回数。同じ人が何度見ても数える" },
  likes: { label: "いいね", hint: "いいね = いいねされた数" },
  saved: { label: "保存", hint: "保存 = 保存された数" },
  shares: { label: "シェア", hint: "シェア = シェアされた数" },
  profile_visits: {
    label: "プロフィール訪問",
    hint: "プロフィール訪問 = この投稿からプロフィールに来た数。リールは API で取れない",
  },
  follows: { label: "フォロー", hint: "フォロー = この投稿からフォローした数。リールは API で取れない" },
  avg_watch_time_s: {
    label: "平均視聴時間",
    hint: "平均視聴時間 = 1 回の再生あたりの平均の視聴時間。リールだけ取れる",
  },
  reach_rate: {
    label: "リーチ率",
    hint: "リーチ率 = 7 日時点のリーチ ÷ 投稿したときのフォロワー数。フォロワー数の増減の影響を取り除いて比べるための値",
  },
  save_rate: { label: "保存率", hint: "保存率 = 保存 ÷ リーチ" },
  share_rate: { label: "シェア率", hint: "シェア率 = シェア ÷ リーチ" },
  like_rate: { label: "いいね率", hint: "いいね率 = いいね ÷ リーチ" },
  er: { label: "ER", hint: "ER（エンゲージメント率） = (いいね + コメント + 保存 + シェア) ÷ リーチ" },
  retention_rate: { label: "視聴維持率", hint: "視聴維持率 = 平均視聴時間 ÷ 動画の長さ。リールだけ取れる" },
  skip_rate: {
    label: "スキップ率",
    hint: "スキップ率 = 再生の最初の 3 秒以内に次へ進まれた割合。低いほどよい。リールだけ取れる",
  },
  profile_visit_rate: {
    label: "プロフィール遷移率",
    hint: "プロフィール遷移率 = プロフィール訪問 ÷ リーチ。リールは API で取れない",
  },
  follow_conversion_rate: {
    label: "フォロー転換率",
    hint: "フォロー転換率 = フォロー ÷ プロフィール訪問。リールは API で取れない",
  },
};

/** 題名の最大の文字数（3.3 節） */
export const TITLE_MAX_CHARS = 40;

/**
 * 題名。キャプションの 1 行目の先頭 40 文字（`Array.from` で文字単位に切り、サロゲートペアを割らない）。
 * キャプションがなければ「（キャプションなし）」
 */
export function mediaTitle(caption: string | null | undefined): string {
  const first = (caption ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (first === "") return "（キャプションなし）";
  return Array.from(first).slice(0, TITLE_MAX_CHARS).join("");
}

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

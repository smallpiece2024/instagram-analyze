/**
 * 指標の名前と定義の文言（R3 設計 4.6 節、F-UI-29）。画面はここから読み、文言を画面ごとに写さない。
 * ヒントの文言は「計算式、分母、API で取れない範囲」を 1〜2 文で書く。純粋な定数（`server-only` なし）
 */

export interface MetricDefinition {
  /** 画面の指標名 */
  label: string;
  /** `MetricHint` に出す定義の文言 */
  hint: string;
}

/** 投稿単位の指標（API の指標と派生指標） */
export const METRIC_DEFINITIONS = {
  reach: { label: "リーチ", hint: "リーチ = 投稿を見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）" },
  views: { label: "閲覧数", hint: "閲覧数 = 投稿が表示された回数。同じ人が何度見ても数える（2025-04-21 から views に統一）" },
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
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;

/** アカウント単位（日次指標）と期間の集計の指標（概要、期間比較） */
export const ACCOUNT_METRIC_DEFINITIONS = {
  reach: {
    label: "リーチ",
    hint: "リーチ = 期間中に投稿やストーリーズを見たアカウントの数。同じ人は 1 回だけ数える（UU 数に近い。Meta の推定値）",
  },
  views: {
    label: "閲覧数",
    hint: "閲覧数 = 投稿やストーリーズが表示された回数。同じ人が何度見ても数える（2025-04-21 から views に統一）",
  },
  follower_gain: { label: "フォロワー純増", hint: "フォロワー純増 = 期間中にフォローされた数 − フォローを外された数" },
  followers: { label: "フォロワー数", hint: "フォロワー数 = 最新の記録のフォロワー数。選んだ期間には関係しない" },
  er: { label: "エンゲージメント率", hint: METRIC_DEFINITIONS.er.hint },
  save_rate: { label: "保存率", hint: METRIC_DEFINITIONS.save_rate.hint },
  share_rate: { label: "シェア率", hint: METRIC_DEFINITIONS.share_rate.hint },
  non_follower_reach_rate: {
    label: "非フォロワーリーチ比率",
    hint: "非フォロワーリーチ比率 = フォロワー以外へのリーチ ÷（フォロワーへのリーチ + フォロワー以外へのリーチ）",
  },
  posts: { label: "投稿数", hint: "投稿数 = 期間中に投稿した数（投稿日時の日本時間の日付）" },
  profile_visits: {
    label: "プロフィール訪問（参考）",
    // 集計は `media_list_metrics`（ストーリーズを含まない）の投稿単位の値の合計。リールは API で取れない
    hint: "プロフィール訪問（参考） = フィード（カルーセルを含む）の投稿からプロフィールに来た数の合計。リールからの訪問とアカウント全体の訪問は API で取れないため含まない",
  },
} as const satisfies Record<string, MetricDefinition>;

/**
 * 日次指標の 1 日の区切りの注記（見本 v4 の `compare.js`）。概要と期間比較に出す。
 * 日次指標の日付は API の区切り（米国太平洋時間）で、日本時間では 16 時（冬時間は 17 時）に日が変わる。
 * 画面では冬時間のかっこ書きと「米国太平洋時間」の語を出さない（2026-10-05 ユーザーの決定）
 */
export const DAY_BOUNDARY_NOTE =
  "リーチ、閲覧数、非フォロワーリーチ比率の 1 日は、日本時間の 16 時から翌日の 16 時まで。Instagram の集計の区切りによる。";

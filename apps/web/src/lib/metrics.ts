/**
 * 派生指標の表示規則、「—」の理由、前期間比、基準値の出し方（R3 設計 3.1 節）。`server-only` なし（純粋関数）。
 *
 * - 判定はこのファイルの 1 か所に置き、画面ごとに文言や条件を書かない
 * - 値の計算そのもの（比、分位）は DB のビューが行う。ここは表示の判定と、DB を使わない小さな集計だけ
 */

/** 投稿の種類（DB の `public.media_kind()` の値と同じ） */
export const MEDIA_KINDS = ["feed", "carousel", "reel", "story"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const KIND_LABEL: Record<MediaKind, string> = {
  feed: "フィード",
  carousel: "カルーセル",
  reel: "リール",
  story: "ストーリーズ",
};

/** 系列の色（`--chart-1`〜`--chart-4`） */
export function kindColor(kind: MediaKind): string {
  return `var(--chart-${MEDIA_KINDS.indexOf(kind) + 1})`;
}

export function isMediaKind(v: unknown): v is MediaKind {
  return typeof v === "string" && (MEDIA_KINDS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------
 * 指標と「—」の理由
 * ------------------------------------------------------------------ */

/** 投稿単位の指標（生の値と派生指標）。CSV と同じ名前 */
export type MediaMetricKey =
  | "reach"
  | "views"
  | "likes"
  | "comments"
  | "saved"
  | "shares"
  | "profile_visits"
  | "follows"
  | "avg_watch_time_ms"
  | "skip_rate"
  | "er"
  | "save_rate"
  | "share_rate"
  | "like_rate"
  | "comment_rate"
  | "reach_rate"
  | "profile_visit_rate"
  | "follow_conversion_rate"
  | "views_per_reach"
  | "retention_rate";

/** その種類では API で取れない（または R3 で出さない）指標（3.1 節の表の右端の列） */
const UNSUPPORTED: Partial<Record<MediaMetricKey, readonly MediaKind[]>> = {
  profile_visits: ["reel", "story"],
  follows: ["reel", "story"],
  profile_visit_rate: ["reel", "story"],
  follow_conversion_rate: ["reel", "story"],
  avg_watch_time_ms: ["feed", "carousel", "story"],
  skip_rate: ["feed", "carousel", "story"],
  // 視聴維持率は動画の長さが R4 なので、R3 ではすべての種類で出さない
  retention_rate: ["feed", "carousel", "reel", "story"],
};

export function isSupported(metric: MediaMetricKey, kind: MediaKind): boolean {
  return !(UNSUPPORTED[metric] ?? []).includes(kind);
}

/** 値を出せない理由 */
export type MissingReason = "unsupported" | "missing" | "not_yet" | "no_baseline_data";

/**
 * 理由ごとのヒントの文言。`not_yet` は「—」だけ（説明を付けない）なので null。
 * 収集開始より前の投稿のための専用の文言は作らない（2026-10-05 のユーザーの指示）
 */
export const MISSING_REASON_TEXT: Record<MissingReason, string | null> = {
  unsupported: "この種類では API で取れない",
  missing: "取得できなかった",
  not_yet: null,
  no_baseline_data: "計算に要る記録がない",
};

/** リーチ率の「投稿時のフォロワー数の記録がない」だけは文言を変える */
export const NO_FOLLOWERS_AT_POST_TEXT = "投稿時のフォロワー数の記録がない";

/** リーチ率は 7 日時点（168 時間）のリーチを使う */
export const REACH_RATE_HORIZON_HOURS = 7 * 24;

/** 「—」の判定の結果。`text` はヒントの文言（null は文言なし） */
export interface Missing {
  reason: MissingReason;
  text: string | null;
}

function missing(reason: MissingReason, text: string | null = MISSING_REASON_TEXT[reason]): Missing {
  return { reason, text };
}

/**
 * 比（分子 ÷ 分母）の指標の「—」の判定。値を出せるなら null。
 * 判定の順は unsupported → not_yet → no_baseline_data → missing（3.1 節）。
 * - 分母が 0 → no_baseline_data（0% と書かない）
 * - 分子か分母が null → missing（その種類では取れるはずなので欠損）
 */
export function ratioMissing(
  metric: MediaMetricKey,
  kind: MediaKind,
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): Missing | null {
  if (!isSupported(metric, kind)) return missing("unsupported");
  if (denominator === 0) return missing("no_baseline_data");
  if (numerator == null || denominator == null) return missing("missing");
  return null;
}

/** 生の値の指標の「—」の判定。値があれば null */
export function valueMissing(metric: MediaMetricKey, kind: MediaKind, value: number | null | undefined): Missing | null {
  if (!isSupported(metric, kind)) return missing("unsupported");
  if (value == null) return missing("missing");
  return null;
}

/**
 * リーチ率（7 日時点のリーチ ÷ 投稿時のフォロワー数）の「—」の判定。値を出せるなら null。
 * - `elapsed_latest` が 7 日未満 → not_yet（文言なし）
 * - 投稿時のフォロワー数の記録がない、または 0 → no_baseline_data（フォロワー数の文言）
 * - 7 日時点の値が許容幅の外（ビューの `reach_7d` が null）→ no_baseline_data
 */
export function reachRateMissing(input: {
  kind: MediaKind;
  elapsedLatestHours: number | null | undefined;
  reach7d: number | null | undefined;
  followersAtPost: number | null | undefined;
}): Missing | null {
  if (!isSupported("reach_rate", input.kind)) return missing("unsupported");
  if (input.elapsedLatestHours == null || input.elapsedLatestHours < REACH_RATE_HORIZON_HOURS) {
    return missing("not_yet");
  }
  if (input.followersAtPost == null || input.followersAtPost === 0) {
    return missing("no_baseline_data", NO_FOLLOWERS_AT_POST_TEXT);
  }
  if (input.reach7d == null) return missing("no_baseline_data");
  return null;
}

/** 比。分母が 0 か null、分子が null なら null */
export function ratio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  return numerator / denominator;
}

/* ------------------------------------------------------------------
 * 期間の集計（合計の比、倍率、順位）
 * ------------------------------------------------------------------ */

export interface RatioOfSums {
  /** 合計の比。使える投稿が 0 件か分母の合計が 0 なら null */
  value: number | null;
  /** 計算に使った件数（分子と分母がともにある投稿）。「n 件中 m 件」の m */
  used: number;
  /** 全件数。「n 件中 m 件」の n */
  total: number;
}

/** 合計の比（Σ分子 ÷ Σ分母）。分子か分母が null の投稿は両方から除く */
export function ratioOfSums(rows: readonly { numerator: number | null; denominator: number | null }[]): RatioOfSums {
  let num = 0;
  let den = 0;
  let used = 0;
  for (const r of rows) {
    if (r.numerator == null || r.denominator == null) continue;
    num += r.numerator;
    den += r.denominator;
    used += 1;
  }
  return { value: used === 0 ? null : ratio(num, den), used, total: rows.length };
}

/** 中央値に対する倍率。値か中央値が null、または中央値が 0 なら null */
export function multipleOfMedian(value: number | null | undefined, median: number | null | undefined): number | null {
  return ratio(value, median);
}

/**
 * 値の大きい順の順位（同じ値は同じ順位。1, 2, 2, 4）。
 * 値が null、比べる値（自分を含む null でない値）が 1 件以下なら null
 */
export function rankDescending(
  value: number | null | undefined,
  values: readonly (number | null | undefined)[],
): { rank: number; of: number } | null {
  if (value == null || !Number.isFinite(value)) return null;
  const present = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (present.length <= 1) return null;
  const rank = present.filter((v) => v > value).length + 1;
  return { rank, of: present.length };
}

/* ------------------------------------------------------------------
 * 前期間比
 * ------------------------------------------------------------------ */

export type DeltaDirection = "up" | "down" | "flat";

/** 前期間比。`prev_zero` は「前期 0」、null は出さない */
export type Delta =
  | { kind: "rate"; value: number; dir: DeltaDirection }
  | { kind: "pt"; value: number; dir: DeltaDirection }
  | { kind: "count"; value: number; dir: DeltaDirection }
  | { kind: "prev_zero" };

/** 件数の増減率。前期間が 0 か null なら「前期 0」、今期が null なら null */
export function deltaRate(cur: number | null | undefined, prev: number | null | undefined): Delta | null {
  if (cur == null || !Number.isFinite(cur)) return null;
  if (prev == null || prev === 0) return { kind: "prev_zero" };
  const value = (cur - prev) / prev;
  return { kind: "rate", value, dir: Math.abs(value) < 0.0005 ? "flat" : value > 0 ? "up" : "down" };
}

/** 率のポイント差（0〜1 の単位の差）。どちらかが null なら null */
export function deltaPoint(cur: number | null | undefined, prev: number | null | undefined): Delta | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const value = cur - prev;
  return { kind: "pt", value, dir: Math.abs(value) < 0.0005 ? "flat" : value > 0 ? "up" : "down" };
}

/** 人数の差（フォロワー純増など。確認事項 Q8）。どちらかが null なら null */
export function deltaCount(cur: number | null | undefined, prev: number | null | undefined): Delta | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const value = cur - prev;
  return { kind: "count", value, dir: value === 0 ? "flat" : value > 0 ? "up" : "down" };
}

/* ------------------------------------------------------------------
 * 基準値（F-UI-24）
 * ------------------------------------------------------------------ */

/**
 * 比較相手の数 n（自分を含めず、その指標で値のある投稿の数）による出し方。
 * - none: 0 件。線、帯、中央値を描かない
 * - range_only: 1〜2 件。最小〜最大の線と中央値だけ（帯なし）
 * - faint: 3〜9 件。帯と中央値を薄く描き「少ないので目安」と添える
 * - normal: 10 件以上
 */
export type BaselineDisplay = "none" | "range_only" | "faint" | "normal";

export const BASELINE_FAINT_MIN = 3;
export const BASELINE_NORMAL_MIN = 10;

export function baselineDisplay(n: number): BaselineDisplay {
  if (!Number.isFinite(n) || n <= 0) return "none";
  if (n < BASELINE_FAINT_MIN) return "range_only";
  if (n < BASELINE_NORMAL_MIN) return "faint";
  return "normal";
}

/** 基準値に添える注記。normal は `n = 12` */
export function baselineNote(n: number): string {
  switch (baselineDisplay(n)) {
    case "none":
      return "比べられる投稿がありません";
    case "range_only":
      return `同じ種類の投稿が ${n} 件のため範囲を出さない`;
    case "faint":
      return `n = ${n}（少ないので目安）`;
    case "normal":
      return `n = ${n}`;
  }
}

/** 比較相手の分布（DB の `percentile_cont` と同じ線形補間） */
export interface PeerStats {
  n: number;
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
}

/** 線形補間の分位（`percentile_cont`）。並べ替え済みの配列を受け取る */
export function percentileCont(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 比較相手の値から分布を作る。null と有限でない値は数えない（指標ごとに n が違う）。
 * 画面は DB で計算した値を使うので、これはテストと DB を使わない表示の確認のため
 */
export function peerStats(values: readonly (number | null | undefined)[]): PeerStats {
  const sorted = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { n: 0, mean: null, median: null, p25: null, p75: null, min: null, max: null };
  return {
    n,
    mean: sorted.reduce((a, b) => a + b, 0) / n,
    median: percentileCont(sorted, 0.5),
    p25: percentileCont(sorted, 0.25),
    p75: percentileCont(sorted, 0.75),
    min: sorted[0],
    max: sorted[n - 1],
  };
}

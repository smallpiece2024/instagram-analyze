/**
 * 投稿一覧のセルの表示（R3 設計 3.3 節）。値を出せないときの「—」の理由は `lib/metrics.ts` で決め、
 * 文言は `MissingValue` 部品に任せる（画面で文言を書かない）
 */
import { MissingValue } from "@/components/MissingValue";
import { formatCount, formatPercent } from "@/lib/format";
import {
  isMediaKind,
  MISSING_REASON_TEXT,
  type MediaKind,
  type Missing,
  ratioMissing,
  valueMissing,
} from "@/lib/metrics";
import type { BaselineMetric, MediaListRow } from "@/lib/queries/media";

/** 一覧の数値の列（並べ替えのキーと基準値の指標を兼ねる） */
export type ListMetric = BaselineMetric;

export const RATE_METRICS: ReadonlySet<ListMetric> = new Set(["save_rate", "share_rate", "er"]);

/** 行の種類。DB の値が想定外ならフィードとして扱う */
export function rowKind(row: Pick<MediaListRow, "kind">): MediaKind {
  return isMediaKind(row.kind) ? row.kind : "feed";
}

function engagement(row: MediaListRow): number | null {
  const { likes, comments, saved, shares } = row;
  if (likes == null || comments == null || saved == null || shares == null) return null;
  return likes + comments + saved + shares;
}

/** 値を出せない理由。値があれば null */
export function cellMissing(row: MediaListRow, metric: ListMetric): Missing | null {
  const value = row[metric];
  if (value != null) return null;
  const kind = rowKind(row);
  let m: Missing | null;
  switch (metric) {
    case "save_rate":
      m = ratioMissing("save_rate", kind, row.saved, row.reach);
      break;
    case "share_rate":
      m = ratioMissing("share_rate", kind, row.shares, row.reach);
      break;
    case "er":
      m = ratioMissing("er", kind, engagement(row), row.reach);
      break;
    default:
      m = valueMissing(metric, kind, value);
  }
  // 判定で出せるはずなのに値がない（式の違いなど）ときは欠損として扱う
  return m ?? { reason: "missing", text: MISSING_REASON_TEXT.missing };
}

export function formatMetric(metric: ListMetric, v: number | null): string {
  return RATE_METRICS.has(metric) ? formatPercent(v) : formatCount(v);
}

/** 1 つの指標のセルの中身（値か「—」） */
export function MetricValue({ row, metric }: { row: MediaListRow; metric: ListMetric }) {
  const missing = cellMissing(row, metric);
  if (missing) return <MissingValue missing={missing} />;
  return <>{formatMetric(metric, row[metric])}</>;
}

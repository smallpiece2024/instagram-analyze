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
import type { ErDenominator } from "@/lib/params";
import type { BaselineMetric, MediaListRow } from "@/lib/queries/media";

/** 一覧の数値の列（並べ替えのキーと基準値の指標を兼ねる） */
export type ListMetric = BaselineMetric;

export const RATE_METRICS: ReadonlySet<ListMetric> = new Set(["save_rate", "share_rate", "er"]);

/** 行の種類。DB の値が想定外ならフィードとして扱う */
export function rowKind(row: Pick<MediaListRow, "kind">): MediaKind {
  return isMediaKind(row.kind) ? row.kind : "feed";
}

/** 投稿から今までの日数（切り捨て）。一覧の投稿日時の下に小さく出す */
export function elapsedDays(hours: number): string {
  return `${Math.floor(Math.max(0, hours) / 24)} 日`;
}

function engagement(row: MediaListRow): number | null {
  const { likes, comments, saved, shares } = row;
  if (likes == null || comments == null || saved == null || shares == null) return null;
  return likes + comments + saved + shares;
}

function erDenominatorValue(row: MediaListRow, er: ErDenominator): number | null {
  switch (er) {
    case "reach":
      return row.reach;
    case "views":
      return row.views;
    case "followers":
      return row.followers_at_post;
  }
}

/** 値を出せない理由。値があれば null */
export function cellMissing(row: MediaListRow, metric: ListMetric, er: ErDenominator): Missing | null {
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
      m = ratioMissing("er", kind, engagement(row), erDenominatorValue(row, er));
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
export function MetricValue({ row, metric, er }: { row: MediaListRow; metric: ListMetric; er: ErDenominator }) {
  const missing = cellMissing(row, metric, er);
  if (missing) return <MissingValue missing={missing} />;
  return <>{formatMetric(metric, row[metric])}</>;
}

/**
 * リールの一覧（F-VID-10、確認事項 Q2。R4 設計 6.2 節）。期間内のすべてのリール。値のない欄は「—」。
 * 列の見出しで並べ替え（`sort`、`dir`。`y` は保つ）。ページ送りなし。
 * スマートフォンでは横スクロールの枠に入れ、サムネイルと題名の列を固定する
 */
import Link from "next/link";
import { SortHeader } from "@/components/SortHeader";
import { Thumb } from "@/components/Thumb";
import type { Query } from "@/components/href";
import { formatCount, formatElapsedDays, formatJst, formatPercent, formatSeconds, mediaTitle } from "@/lib/format";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import type { SortOrder } from "@/lib/params";
import { FACTORS, factorValue, formatFactor, type FactorKey, type ReelRow, type ReelSortKey } from "@/lib/reels";

interface Column {
  key: Exclude<ReelSortKey, "posted">;
  label: string;
  hint?: string;
  hideM?: boolean;
  cell: (r: ReelRow) => string;
}

function factorDef(key: FactorKey) {
  return FACTORS.find((f) => f.key === key) as (typeof FACTORS)[number];
}

function factorCell(key: FactorKey) {
  const f = factorDef(key);
  return (r: ReelRow) => formatFactor(factorValue(r, key), f.unit);
}

/** 数値の列（6.2 節「一覧」の順） */
export const REEL_COLUMNS: readonly Column[] = [
  { key: "elapsed", label: "経過日数", hideM: true, cell: (r) => formatElapsedDays(r.elapsed_hours) },
  { key: "duration", label: "長さ", hint: factorDef("duration").hint, cell: factorCell("duration") },
  { key: "cut_count", label: "画面変化", hint: factorDef("cut_count").hint, cell: factorCell("cut_count") },
  { key: "avg_scene", label: "平均シーン長", hint: factorDef("avg_scene").hint, hideM: true, cell: factorCell("avg_scene") },
  { key: "cuts_in_first_3s", label: "冒頭 3 秒", hint: factorDef("cuts_in_first_3s").hint, cell: factorCell("cuts_in_first_3s") },
  { key: "cuts_in_last_3s", label: "最後 3 秒", hint: factorDef("cuts_in_last_3s").hint, cell: factorCell("cuts_in_last_3s") },
  { key: "views", label: METRIC_DEFINITIONS.views.label, hint: METRIC_DEFINITIONS.views.hint, cell: (r) => formatCount(r.views) },
  { key: "reach", label: METRIC_DEFINITIONS.reach.label, hint: METRIC_DEFINITIONS.reach.hint, cell: (r) => formatCount(r.reach) },
  {
    key: "avg_watch_time",
    label: METRIC_DEFINITIONS.avg_watch_time_s.label,
    hint: METRIC_DEFINITIONS.avg_watch_time_s.hint,
    hideM: true,
    cell: (r) => formatSeconds(r.avg_watch_time_ms === null ? null : r.avg_watch_time_ms / 1000),
  },
  {
    key: "retention_rate",
    label: METRIC_DEFINITIONS.retention_rate.label,
    hint: METRIC_DEFINITIONS.retention_rate.hint,
    cell: (r) => formatPercent(r.retention_rate),
  },
  {
    key: "skip_rate",
    label: METRIC_DEFINITIONS.skip_rate.label,
    hint: METRIC_DEFINITIONS.skip_rate.hint,
    hideM: true,
    cell: (r) => formatPercent(r.skip_rate),
  },
  {
    key: "share_rate",
    label: METRIC_DEFINITIONS.share_rate.label,
    hint: METRIC_DEFINITIONS.share_rate.hint,
    cell: (r) => formatPercent(r.share_rate),
  },
  {
    key: "save_rate",
    label: METRIC_DEFINITIONS.save_rate.label,
    hint: METRIC_DEFINITIONS.save_rate.hint,
    cell: (r) => formatPercent(r.save_rate),
  },
  {
    key: "reach_rate",
    label: METRIC_DEFINITIONS.reach_rate.label,
    hint: METRIC_DEFINITIONS.reach_rate.hint,
    cell: (r) => formatPercent(r.reach_rate),
  },
];

export interface ReelTableProps {
  rows: readonly ReelRow[];
  urls: ReadonlyMap<string, string>;
  sort: ReelSortKey;
  dir: SortOrder;
  query: Query;
}

export function ReelTable({ rows, urls, sort, dir, query }: ReelTableProps) {
  const sortProps = { sort, order: dir, path: "/reels", query, orderParam: "dir" };
  return (
    <div className="table-wrap">
      <table className="table reel-table">
        <thead>
          <tr>
            <th scope="col" className="sticky-thumb">
              <span className="sr-only">サムネイル</span>
            </th>
            <th scope="col" className="sticky-title">
              投稿
            </th>
            <SortHeader label="投稿日" sortKey="posted" {...sortProps} />
            {REEL_COLUMNS.map((c) => (
              <SortHeader
                key={c.key}
                label={c.label}
                hint={c.hint}
                sortKey={c.key}
                numeric
                className={c.hideM ? "hide-m" : undefined}
                {...sortProps}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = `/media/${r.media_id}`;
            const title = mediaTitle(r.caption);
            return (
              <tr key={r.media_id} className={r.gone_at ? "dim" : undefined}>
                <td className="sticky-thumb">
                  <Link href={href} aria-label={title}>
                    <Thumb src={r.thumbnail_path ? (urls.get(r.thumbnail_path) ?? null) : null} kind="reel" />
                  </Link>
                </td>
                <td className="sticky-title">
                  <Link href={href}>{title}</Link>
                </td>
                <td className="num">{formatJst(r.posted_at).slice(0, 10)}</td>
                {REEL_COLUMNS.map((c) => (
                  <td key={c.key} className={c.hideM ? "num hide-m" : "num"}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

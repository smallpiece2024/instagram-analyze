/**
 * 投稿一覧の表（PC。R3 設計 3.3 節、見本 `render.js` の `S["media-list"]`）。
 * `tfoot` に全投稿の最新の値の基準値（中央値、平均、上位 25%、下位 25%）と、列ごとの n を置く
 */
import Link from "next/link";
import { MissingValue } from "@/components/MissingValue";
import { SortHeader } from "@/components/SortHeader";
import { Thumb } from "@/components/Thumb";
import { SpecialTags, TypeTag } from "@/components/TypeTag";
import type { Query } from "@/components/href";
import { formatCount, formatJst } from "@/lib/format";
import { baselineDisplay, MISSING_REASON_TEXT } from "@/lib/metrics";
import type { ErDenominator, SortOrder } from "@/lib/params";
import {
  type BaselineStats,
  type MediaBaseline,
  type MediaListRowWithThumbnail,
  type MediaSortKey,
  mediaTitle,
} from "@/lib/queries/media";
import { elapsedDays, formatMetric, type ListMetric, MetricValue, rowKind } from "./cells";

export interface ListColumn {
  key: ListMetric;
  label: string;
  /** スマートフォンの幅で隠す（見本の `hide-m`） */
  hideM?: boolean;
}

/** 数値の列（3.3 節の表の順） */
export const LIST_COLUMNS: readonly ListColumn[] = [
  { key: "reach", label: "リーチ" },
  { key: "views", label: "閲覧数", hideM: true },
  { key: "likes", label: "いいね", hideM: true },
  { key: "saved", label: "保存" },
  { key: "save_rate", label: "保存率" },
  { key: "share_rate", label: "シェア率" },
  { key: "er", label: "ER" },
  { key: "profile_visits", label: "プロフ訪問", hideM: true },
];

const BASELINE_ROWS: readonly { label: string; stat: keyof Omit<BaselineStats, "n"> }[] = [
  { label: "中央値", stat: "median" },
  { label: "平均", stat: "mean" },
  { label: "上位 25%", stat: "q75" },
  { label: "下位 25%", stat: "q25" },
];

const NO_PEERS = { reason: "no_baseline_data", text: MISSING_REASON_TEXT.no_baseline_data } as const;

export interface MediaTableProps {
  items: readonly MediaListRowWithThumbnail[];
  baseline: MediaBaseline;
  sort: MediaSortKey;
  order: SortOrder;
  er: ErDenominator;
  query: Query;
}

export function MediaTable({ items, baseline, sort, order, er, query }: MediaTableProps) {
  const sortProps = { sort, order, path: "/media", query };
  const hasViewsMark = items.some((m) => m.views_before_change);
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">サムネイル</span>
              </th>
              <th scope="col">投稿</th>
              <th scope="col">種類</th>
              <SortHeader label="投稿日時" sortKey="posted" {...sortProps} />
              {LIST_COLUMNS.map((c) => (
                <SortHeader key={c.key} label={c.label} sortKey={c.key} numeric {...sortProps} />
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((m) => {
              const kind = rowKind(m);
              const href = `/media/${m.media_id}`;
              const title = mediaTitle(m.caption);
              return (
                <tr key={m.media_id} className={m.gone_at ? "dim" : undefined}>
                  <td>
                    <Link href={href} aria-label={title ?? "（キャプションなし）"}>
                      <Thumb src={m.thumbnail_url} kind={kind} />
                    </Link>
                  </td>
                  <td className="title">
                    <Link href={href}>{title ?? "（キャプションなし）"}</Link>
                  </td>
                  <td>
                    <TypeTag kind={kind} />{" "}
                    <SpecialTags
                      isCollab={m.is_collab}
                      isTrialReel={m.is_trial_reel}
                      isBoosted={m.is_boosted}
                      gone={m.gone_at !== null}
                    />
                  </td>
                  <td className="nowrap small">
                    <div>{formatJst(m.posted_at)}</div>
                    <div className="muted">{elapsedDays(m.elapsed_hours)}</div>
                  </td>
                  {LIST_COLUMNS.map((c) => (
                    <td key={c.key} className={c.hideM ? "num hide-m" : "num"}>
                      <MetricValue row={m} metric={c.key} er={er} />
                      {c.key === "views" && m.views_before_change ? "*" : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {BASELINE_ROWS.map((r) => (
              <tr key={r.stat}>
                <td colSpan={4}>{r.label}</td>
                {LIST_COLUMNS.map((c) => {
                  const s = baseline[c.key];
                  return (
                    <td key={c.key} className={cellClass(c, s.n)}>
                      {s.n === 0 || s[r.stat] === null ? (
                        <MissingValue missing={NO_PEERS} />
                      ) : (
                        formatMetric(c.key, s[r.stat])
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td colSpan={4} className="small muted">
                n
              </td>
              {LIST_COLUMNS.map((c) => (
                <td key={c.key} className={c.hideM ? "num small muted hide-m" : "num small muted"}>
                  {formatCount(baseline[c.key].n)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      {hasViewsMark && <p className="note">* 指標変更（閲覧数）より前の投稿</p>}
    </>
  );
}

/** 件数が少ない列（n が 10 未満）は薄く表示する（3.1 節の基準値の出し方） */
function cellClass(c: ListColumn, n: number): string {
  const classes = ["num"];
  if (c.hideM) classes.push("hide-m");
  const display = baselineDisplay(n);
  if (display === "faint" || display === "range_only") classes.push("dim");
  return classes.join(" ");
}

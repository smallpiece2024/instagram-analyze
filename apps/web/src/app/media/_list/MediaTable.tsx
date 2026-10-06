/**
 * 投稿一覧の表（PC。R3 設計 3.3 節、見本 `render.js` の `S["media-list"]`）。
 * 表の下の基準値（中央値、平均、分位、n）は置かない（2026-10-06、ユーザーの判断）
 */
import Link from "next/link";
import { SortHeader } from "@/components/SortHeader";
import { Thumb } from "@/components/Thumb";
import { SpecialTags, TypeTag } from "@/components/TypeTag";
import type { Query } from "@/components/href";
import { formatElapsedDays, formatJst, mediaTitle } from "@/lib/format";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import type { SortOrder } from "@/lib/params";
import { type MediaListRowWithThumbnail, type MediaSortKey } from "@/lib/queries/media";
import { type ListMetric, MetricValue, rowKind } from "./cells";

export interface ListColumn {
  key: ListMetric;
  label: string;
  /** 指標の定義のヒント（F-UI-29） */
  hint: string;
  /** スマートフォンの幅で隠す（見本の `hide-m`） */
  hideM?: boolean;
}

/** 数値の列（3.3 節の表の順） */
export const LIST_COLUMNS: readonly ListColumn[] = [
  { key: "reach", label: METRIC_DEFINITIONS.reach.label, hint: METRIC_DEFINITIONS.reach.hint },
  { key: "views", label: METRIC_DEFINITIONS.views.label, hint: METRIC_DEFINITIONS.views.hint, hideM: true },
  { key: "likes", label: METRIC_DEFINITIONS.likes.label, hint: METRIC_DEFINITIONS.likes.hint, hideM: true },
  { key: "saved", label: METRIC_DEFINITIONS.saved.label, hint: METRIC_DEFINITIONS.saved.hint },
  { key: "save_rate", label: METRIC_DEFINITIONS.save_rate.label, hint: METRIC_DEFINITIONS.save_rate.hint },
  { key: "share_rate", label: METRIC_DEFINITIONS.share_rate.label, hint: METRIC_DEFINITIONS.share_rate.hint },
  { key: "er", label: METRIC_DEFINITIONS.er.label, hint: METRIC_DEFINITIONS.er.hint },
  { key: "profile_visits", label: "プロフ訪問", hint: METRIC_DEFINITIONS.profile_visits.hint, hideM: true },
];

export interface MediaTableProps {
  items: readonly MediaListRowWithThumbnail[];
  sort: MediaSortKey;
  order: SortOrder;
  query: Query;
}

export function MediaTable({ items, sort, order, query }: MediaTableProps) {
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
                <SortHeader key={c.key} label={c.label} hint={c.hint} sortKey={c.key} numeric {...sortProps} />
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
                    <Link href={href} aria-label={title}>
                      <Thumb src={m.thumbnail_url} kind={kind} />
                    </Link>
                  </td>
                  <td className="title">
                    <Link href={href}>{title}</Link>
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
                    <div className="muted">{formatElapsedDays(m.elapsed_hours)}</div>
                  </td>
                  {LIST_COLUMNS.map((c) => (
                    <td key={c.key} className={c.hideM ? "num hide-m" : "num"}>
                      <MetricValue row={m} metric={c.key} />
                      {c.key === "views" && m.views_before_change ? "*" : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasViewsMark && <p className="note">* 指標変更（閲覧数）より前の投稿</p>}
    </>
  );
}

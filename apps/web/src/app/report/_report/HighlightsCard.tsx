import Link from "next/link";
import { LoadError } from "@/app/_overview/states";
import { Card } from "@/components/Card";
import { MetricHint } from "@/components/MetricHint";
import { Thumb } from "@/components/Thumb";
import { SpecialTags, TypeTag } from "@/components/TypeTag";
import { EMPTY, formatCount, formatJst, formatPercent, mediaTitle } from "@/lib/format";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import type { Period } from "@/lib/period";
import { signWithSession } from "@/lib/queries/media";
import { getMonthHighlights, type HighlightRow } from "@/lib/queries/report";
import { elapsedDays, splitHighlights } from "@/lib/report";
import { SECTION_TITLES } from "./titles";

const TITLE = SECTION_TITLES.highlights;

function HighlightTable({ rows, signed }: { rows: readonly HighlightRow[]; signed: ReadonlyMap<string, string> }) {
  if (rows.length === 0) return <p className="muted">{EMPTY}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">サムネイル</span>
            </th>
            <th scope="col">投稿</th>
            <th scope="col">種類</th>
            <th scope="col">投稿日</th>
            <th scope="col" className="num">
              経過日数
            </th>
            <th scope="col" className="num">
              {METRIC_DEFINITIONS.reach.label}
            </th>
            <th scope="col" className="num">
              {METRIC_DEFINITIONS.share_rate.label}
            </th>
            <th scope="col">
              <MetricHint label="印" text={METRIC_DEFINITIONS.share_flag.hint} />
            </th>
            <th scope="col" className="num">
              比較
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const href = `/media/${encodeURIComponent(m.media_id)}`;
            const title = mediaTitle(m.caption);
            const days = elapsedDays(m.elapsed_latest);
            return (
              <tr key={m.media_id} className={m.gone_at ? "dim" : undefined}>
                <td>
                  <Link href={href} aria-label={title}>
                    <Thumb src={m.thumbnail_path === null ? null : (signed.get(m.thumbnail_path) ?? null)} kind={m.kind} />
                  </Link>
                </td>
                <td className="title">
                  <Link href={href}>{title}</Link>
                </td>
                <td>
                  <TypeTag kind={m.kind} />
                </td>
                <td className="nowrap small">{formatJst(m.posted_at)}</td>
                <td className="num">{days === null ? <span className="muted">{EMPTY}</span> : `${days} 日`}</td>
                <td className="num">{formatCount(m.reach)}</td>
                <td className="num">{formatPercent(m.share_rate, 2)}</td>
                <td>
                  <SpecialTags shareFlag={m.share_flag} />
                </td>
                <td className="num">{m.peer_n === null ? <span className="muted">{EMPTY}</span> : `${formatCount(m.peer_n)} 件`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 6 節: その月の投稿（ストーリーズを除く）をシェア率で並べ、上位と下位を出す（R6 設計 6.1 節、T10）。
 * 印（伸びた／課題）は順位の根拠ではなく添え物（印がない月もある。T24）
 */
export async function HighlightsCard({ accountId, period }: { accountId: string; period: Period }) {
  const r = await getMonthHighlights(accountId, period.from, period.to);
  if (!r.ok) {
    return (
      <Card title={TITLE}>
        <LoadError reason={r.reason} />
      </Card>
    );
  }
  const { top, bottom } = splitHighlights(r.data);
  const rated = r.data.filter((m) => m.share_rate !== null).length;
  const paths = [...top, ...bottom].map((m) => m.thumbnail_path).filter((p): p is string => typeof p === "string");
  const signed = paths.length > 0 ? await signWithSession(paths) : new Map<string, string>();

  return (
    <Card
      title={TITLE}
      foot={
        <>
          投稿は日本時間の投稿日で {period.from} 〜 {period.to}・{r.data.length} 件のうちシェア率のある {rated} 件から、高い順に上位、低い順に下位・
          比較は同じ種類の直前の投稿の件数
        </>
      }
    >
      <p className="small muted">よかった投稿（シェア率の高い順）</p>
      <HighlightTable rows={top} signed={signed} />
      <p className="small muted mt-6">課題のある投稿（シェア率の低い順）</p>
      <HighlightTable rows={bottom} signed={signed} />
    </Card>
  );
}

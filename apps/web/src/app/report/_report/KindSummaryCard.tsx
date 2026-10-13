import type { ReactNode } from "react";
import { LoadError } from "@/app/_overview/states";
import { Card } from "@/components/Card";
import { TypeTag } from "@/components/TypeTag";
import { EMPTY, formatCount, formatPercent } from "@/lib/format";
import type { Period } from "@/lib/period";
import { getKindSummary, getStorySummary } from "@/lib/queries/report";
import { SECTION_TITLES } from "./titles";

const TITLE = SECTION_TITLES.kinds;

/** 列は固定（U9）。当てはまらない欄は値が null なので「—」（種類で分岐しない。T15） */
const COLUMNS = ["件数", "Σリーチ", "Σ閲覧数", "ER", "保存率", "シェア率", "プロフィール訪問", "離脱率"] as const;

/** 書式済みの値。「—」は薄く出す */
function cell(text: string): ReactNode {
  return text === EMPTY ? <span className="muted">{EMPTY}</span> : text;
}

/**
 * 5 節: フィード、カルーセル、リール、ストーリーズの 4 行（R6 設計 6.1 節）。率は Σの比で、分子と分母がそろう投稿だけ。
 * markup は投稿一覧の表（`_list/MediaTable.tsx`）と同じ `table`
 */
export async function KindSummaryCard({ accountId, period }: { accountId: string; period: Period }) {
  const [kinds, stories] = await Promise.all([
    getKindSummary(accountId, period.from, period.to),
    getStorySummary(accountId, period.from, period.to),
  ]);
  if (!kinds.ok) {
    return (
      <Card title={TITLE}>
        <LoadError reason={kinds.reason} />
      </Card>
    );
  }
  if (!stories.ok) {
    return (
      <Card title={TITLE}>
        <LoadError reason={stories.reason} />
      </Card>
    );
  }
  const s = stories.data;
  const rows: { kind: "feed" | "carousel" | "reel" | "story"; values: string[] }[] = [
    ...kinds.data.map((k) => ({
      kind: k.kind,
      values: [
        formatCount(k.posts),
        formatCount(k.reach.sum),
        formatCount(k.views.sum),
        formatPercent(k.er.value, 2),
        formatPercent(k.saveRate.value, 2),
        formatPercent(k.shareRate.value, 2),
        formatCount(k.profileVisits.sum),
        EMPTY,
      ],
    })),
    {
      kind: "story",
      values: [formatCount(s.posts), EMPTY, formatCount(s.views.sum), EMPTY, EMPTY, EMPTY, EMPTY, formatPercent(s.exitRate.value, 2)],
    },
  ];

  return (
    <Card title={TITLE} foot={<>投稿は日本時間の投稿日で {period.from} 〜 {period.to}・率は合計の比（分子と分母のそろう投稿だけ）</>}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">種類</th>
              {COLUMNS.map((c) => (
                <th key={c} scope="col" className="num">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind}>
                <td>
                  <TypeTag kind={r.kind} />
                </td>
                {r.values.map((v, i) => (
                  <td key={COLUMNS[i]} className="num">
                    {cell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

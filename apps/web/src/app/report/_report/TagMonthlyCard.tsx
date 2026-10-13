import Link from "next/link";
import { LoadError } from "@/app/_overview/states";
import { Card } from "@/components/Card";
import { EMPTY, formatCount, formatPercent } from "@/lib/format";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import type { Period } from "@/lib/period";
import { getTagMonthly } from "@/lib/queries/report";
import { tagGroupRows } from "@/lib/tags";
import { SECTION_TITLES } from "./titles";

const TITLE = SECTION_TITLES.tags;

/**
 * 7 節: 軸ごとに値 × 件数 × 中央値（リーチ率、シェア率）。「タグなし」の行を含む（R5 Q4）。
 * 軸が 0 件なら空の表示で、タグの編集へのリンクだけ。行の分け方はタグ分析と同じ `tagGroupRows`
 */
export async function TagMonthlyCard({ accountId, period }: { accountId: string; period: Period }) {
  const r = await getTagMonthly(accountId, period.from, period.to);
  if (!r.ok) {
    return (
      <Card title={TITLE}>
        <LoadError reason={r.reason} />
      </Card>
    );
  }
  const { axes, values, rows } = r.data;
  const foot = <>投稿は日本時間の投稿日で {period.from} 〜 {period.to}・中央値は値のある投稿だけ</>;
  if (axes.length === 0) {
    return (
      <Card title={TITLE} foot={foot}>
        <p className="small muted">
          タグの軸がありません。<Link href="/tags/edit">タグの編集</Link>
        </p>
      </Card>
    );
  }
  return (
    <Card title={TITLE} foot={foot}>
      <div className="stack">
        {axes.map((axis) => {
          const groups = tagGroupRows(
            rows.filter((x) => x.axis_id === axis.id),
            values[axis.id] ?? [],
            "reach",
          );
          return (
            <section key={axis.id} aria-label={axis.name}>
              <p className="small muted">{axis.name}</p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">値</th>
                      <th scope="col" className="num">
                        件数
                      </th>
                      <th scope="col" className="num">
                        {METRIC_DEFINITIONS.reach_rate.label}（中央値）
                      </th>
                      <th scope="col" className="num">
                        {METRIC_DEFINITIONS.share_rate.label}（中央値）
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.id ?? "untagged"} className={g.n === 0 ? "dim" : undefined}>
                        <td className="title">{g.label}</td>
                        <td className="num">{formatCount(g.n)}</td>
                        <td className="num">
                          {g.medians.reach_rate.value === null ? <span className="muted">{EMPTY}</span> : formatPercent(g.medians.reach_rate.value, 2)}
                        </td>
                        <td className="num">
                          {g.medians.share_rate.value === null ? <span className="muted">{EMPTY}</span> : formatPercent(g.medians.share_rate.value, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    </Card>
  );
}

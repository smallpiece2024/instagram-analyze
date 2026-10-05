import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { MissingValue } from "@/components/MissingValue";
import { formatCount, formatValue, type ValueFormat } from "@/lib/format";
import { baselineDisplay, baselineNote, KIND_LABEL, MISSING_REASON_TEXT, type Missing } from "@/lib/metrics";
import type { Period } from "@/lib/period";
import { getPeriodBaselines, type BaselineMetric, type BaselineStat, type PeriodBaselines } from "@/lib/queries/compare";
import { getPostTotals, POST_KINDS, type PostTotals } from "@/lib/queries/period-summary";
import { periodLabel } from "./labels";

const NO_DATA: Missing = { reason: "no_baseline_data", text: MISSING_REASON_TEXT.no_baseline_data };

const METRICS: readonly { key: BaselineMetric; label: string; format: ValueFormat }[] = [
  { key: "reach", label: "リーチ", format: "count" },
  { key: "save_rate", label: "保存率", format: "percent" },
  { key: "er", label: "ER", format: "percent" },
];

function Cell({ v, format }: { v: number | null; format: ValueFormat }) {
  return <td className="num">{v === null ? <MissingValue missing={NO_DATA} /> : formatValue(v, format)}</td>;
}

/** 1 つの期間の 1 指標の行。n が 1〜2 なら平均と中央値だけ、0 なら全部「—」 */
function StatCells({ stat, format }: { stat: BaselineStat; format: ValueFormat }) {
  const display = baselineDisplay(stat.n);
  const showQuartiles = display === "faint" || display === "normal";
  return (
    <>
      <Cell v={stat.mean} format={format} />
      <Cell v={stat.median} format={format} />
      <Cell v={showQuartiles ? stat.p75 : null} format={format} />
      <Cell v={showQuartiles ? stat.p25 : null} format={format} />
      <td className="num xs muted">{display === "none" || display === "range_only" ? `n = ${stat.n}` : baselineNote(stat.n)}</td>
    </>
  );
}

function kindCounts(t: PostTotals): string {
  return POST_KINDS.map((k) => `${KIND_LABEL[k]} ${formatCount(t.byKind[k].posts)}`).join("・");
}

/** 投稿の基準値の表（3.5 節「表示」の 3、F-UI-24）。各投稿の最新の値の平均と分位、指標ごとの n */
export async function BaselineCard({ accountId, a, b }: { accountId: string; a: Period; b: Period }) {
  const [ba, bb, ta, tb] = await Promise.all([
    getPeriodBaselines(accountId, a.from, a.to),
    getPeriodBaselines(accountId, b.from, b.to),
    getPostTotals(accountId, a.from, a.to),
    getPostTotals(accountId, b.from, b.to),
  ]);
  if (!ba.ok || !bb.ok || !ta.ok || !tb.ok) {
    const reason = [ba, bb, ta, tb].find((r) => !r.ok);
    return (
      <Card title="投稿の基準値" className="col-12">
        <Callout state="bad">読み出せません（{reason && !reason.ok ? reason.reason : ""}）</Callout>
      </Card>
    );
  }
  const sides: readonly { name: string; period: Period; data: PeriodBaselines }[] = [
    { name: "A", period: a, data: ba.data },
    { name: "B", period: b, data: bb.data },
  ];

  return (
    <Card
      title="投稿の基準値"
      className="col-12"
      foot="期間に投稿した投稿（投稿日時の日本時間の日付）の、各投稿の最新の値。n はその指標で値のある投稿の数。"
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">指標</th>
              <th scope="col">期間</th>
              <th scope="col" className="num">平均</th>
              <th scope="col" className="num">中央値</th>
              <th scope="col" className="num">上位 25%</th>
              <th scope="col" className="num">下位 25%</th>
              <th scope="col" className="num">n</th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) =>
              sides.map((s, i) => (
                <tr key={`${m.key}-${s.name}`} className={baselineDisplay(s.data.stats[m.key].n) === "faint" ? "dim" : undefined}>
                  {i === 0 && (
                    <th scope="rowgroup" rowSpan={sides.length} className="row-head">
                      {m.label}
                    </th>
                  )}
                  <td className="nowrap">
                    {s.name} <span className="muted xs">{periodLabel(s.period)}</span>
                  </td>
                  {s.data.posts === 0 ? (
                    <td colSpan={5} className="muted">
                      期間中の投稿なし
                    </td>
                  ) : (
                    <StatCells stat={s.data.stats[m.key]} format={m.format} />
                  )}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="note">
        種類ごとの件数: A {kindCounts(ta.data)}、B {kindCounts(tb.data)}
      </p>
    </Card>
  );
}

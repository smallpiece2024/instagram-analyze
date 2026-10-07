import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { MetricHint } from "@/components/MetricHint";
import { MissingValue } from "@/components/MissingValue";
import { formatValue, type ValueFormat } from "@/lib/format";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import { MISSING_REASON_TEXT, type Missing } from "@/lib/metrics";
import type { Period } from "@/lib/period";
import { getPeriodBaselines, type BaselineMetric, type BaselineStat, type PeriodBaselines } from "@/lib/queries/compare";
import { BaselineBand, bandDomain } from "./BaselineBand";
import { periodLabel } from "./labels";

const NO_DATA: Missing = { reason: "no_baseline_data", text: MISSING_REASON_TEXT.no_baseline_data };

const METRICS: readonly { key: BaselineMetric; label: string; hint: string; format: ValueFormat }[] = [
  { key: "reach", label: METRIC_DEFINITIONS.reach.label, hint: METRIC_DEFINITIONS.reach.hint, format: "count" },
  { key: "save_rate", label: METRIC_DEFINITIONS.save_rate.label, hint: METRIC_DEFINITIONS.save_rate.hint, format: "percent" },
  { key: "er", label: METRIC_DEFINITIONS.er.label, hint: METRIC_DEFINITIONS.er.hint, format: "percent" },
];


/** 1 つの期間の 1 指標の、分布、中央値、n のセル。0 件は「—」と n = 0 */
function StatCells({
  stat,
  format,
  color,
  domain,
}: {
  stat: BaselineStat;
  format: ValueFormat;
  color: string;
  domain: { lo: number; hi: number };
}) {
  if (stat.n === 0) {
    return (
      <>
        <td className="band-cell">
          <MissingValue missing={NO_DATA} />
        </td>
        <td className="num">
          <MissingValue missing={NO_DATA} />
        </td>
        <td className="num xs muted">n = 0</td>
      </>
    );
  }
  return (
    <>
      <td className="band-cell">
        <BaselineBand stat={stat} format={format} color={color} lo={domain.lo} hi={domain.hi} />
      </td>
      <td className="num">{stat.median === null ? <MissingValue missing={NO_DATA} /> : formatValue(stat.median, format)}</td>
      <td className="num xs muted">n = {stat.n}</td>
    </>
  );
}

/**
 * 投稿の基準値（3.5 節「表示」の 3、F-UI-24、見本 v4 の `baselineCard`）。期間に投稿した投稿（投稿日時の日本時間の日付）の、
 * 各投稿の最新の値の分布を帯グラフで出す。目盛は指標ごとに A と B で共通
 */
export async function BaselineCard({ accountId, a, b }: { accountId: string; a: Period; b: Period }) {
  const [ba, bb] = await Promise.all([getPeriodBaselines(accountId, a.from, a.to), getPeriodBaselines(accountId, b.from, b.to)]);
  if (!ba.ok || !bb.ok) {
    const reason = !ba.ok ? ba.reason : !bb.ok ? bb.reason : "";
    return (
      <Card title="投稿の基準値" className="col-12">
        <Callout state="bad">読み出せません（{reason}）</Callout>
      </Card>
    );
  }
  // A は青、B は灰（期間の帯、主要指標の表、リーチ数のグラフと同じ）
  const sides: readonly { name: string; cls: string; color: string; period: Period; data: PeriodBaselines }[] = [
    { name: "A", cls: "is-a", color: "var(--color-primary)", period: a, data: ba.data },
    { name: "B", cls: "is-b", color: "var(--color-neutral)", period: b, data: bb.data },
  ];

  return (
    <Card title="投稿の基準値" className="col-12">
      <div className="legend">
        <span>
          <i className="band-key band-key--line" aria-hidden="true" />
          最小〜最大
        </span>
        <span>
          <i className="band-key band-key--box" aria-hidden="true" />
          25〜75% の範囲
        </span>
        <span>
          <i className="band-key band-key--med" aria-hidden="true" />
          中央値
        </span>
      </div>
      <div className="table-wrap table-wrap--sticky">
        <table className="table">
          <thead>
            <tr>
              <th scope="col" className="sticky-col">
                指標
              </th>
              <th scope="col">期間</th>
              <th scope="col">分布</th>
              <th scope="col" className="num">
                中央値
              </th>
              <th scope="col" className="num">
                n
              </th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => {
              const domain = bandDomain(sides.map((s) => s.data.stats[m.key]));
              return sides.map((s, i) => (
                <tr key={`${m.key}-${s.name}`} className={s.cls}>
                  {i === 0 && (
                    <th scope="rowgroup" rowSpan={sides.length} className="row-head sticky-col">
                      <MetricHint label={m.label} text={m.hint} />
                    </th>
                  )}
                  <td className="nowrap">
                    {s.name} <span className="muted xs">{periodLabel(s.period)}</span>
                  </td>
                  <StatCells stat={s.data.stats[m.key]} format={m.format} color={s.color} domain={domain} />
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

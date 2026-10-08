/**
 * オーディエンスのカード（R5 設計 6.4 節）。値は `lib/audience.ts` で計算済みのものを受け取り、描くだけにする。
 * 区分の名前（国コード、都市名）は JSX の子と属性として出す（S11）
 */
import { Card } from "@/components/Card";
import { HBars } from "@/components/charts/HBars";
import { Legend, type LegendItem } from "@/components/charts/Legend";
import { LineChart, type LineSeries } from "@/components/charts/LineChart";
import { MissingValue } from "@/components/MissingValue";
import {
  BREAKDOWN_LABEL,
  DENOMINATOR_NOTE,
  weekLabel,
  type BreakdownCard,
  type TrendSeries,
} from "@/lib/audience";
import { formatCount, formatDateShort, formatJst } from "@/lib/format";
import { MISSING_REASON_TEXT } from "@/lib/metrics";

/** 系列の色。5 本目からは同じ色の破線にして見分ける（色の変数は 4 つだけ） */
const SERIES_STYLES: readonly { color: string; dashed: boolean }[] = [
  { color: "var(--chart-1)", dashed: false },
  { color: "var(--chart-2)", dashed: false },
  { color: "var(--chart-3)", dashed: false },
  { color: "var(--chart-4)", dashed: false },
  { color: "var(--chart-1)", dashed: true },
  { color: "var(--chart-2)", dashed: true },
  { color: "var(--chart-3)", dashed: true },
  { color: "var(--chart-4)", dashed: true },
];

function seriesStyle(i: number): { color: string; dashed: boolean } {
  return SERIES_STYLES[i % SERIES_STYLES.length] ?? { color: "var(--chart-1)", dashed: false };
}

/** カードの下の時点。「2026-10-12 の週（日本時間）の記録・取得 2026-10-13 05:31」 */
function timeNote(week: string, fetchedAt: Date | null): string {
  return `${weekLabel(week)}・取得 ${formatJst(fetchedAt)}`;
}

/** 内訳のカード（半幅）。最新の週が `empty` か行なしなら「—」 */
export function BreakdownCardView({ card, week, metricLabel }: { card: BreakdownCard; week: string; metricLabel: string }) {
  const label = BREAKDOWN_LABEL[card.breakdown];
  if (card.kind === "missing") {
    return (
      <Card title={label} className="col-6" foot={timeNote(week, card.fetchedAt)}>
        <p>
          <MissingValue missing={{ reason: "missing", text: MISSING_REASON_TEXT.missing }} />
        </p>
      </Card>
    );
  }
  return (
    <Card
      title={label}
      sub={`合計 ${formatCount(card.total)}`}
      className="col-6"
      foot={
        <>
          {DENOMINATOR_NOTE}・{timeNote(week, card.fetchedAt)}
        </>
      }
    >
      <div className="chart">
        <HBars title={`${metricLabel}の${label}の人数と割合`} rows={card.rows} />
      </div>
      {card.others > 0 && <p className="small muted">ほか {card.others} 件</p>}
    </Card>
  );
}

function trendLines(series: readonly TrendSeries[]): LineSeries[] {
  return series.map((s, i) => ({ label: s.label, values: s.values, dots: true, ...seriesStyle(i) }));
}

function trendLegend(series: readonly TrendSeries[]): LegendItem[] {
  return series.map((s, i) => {
    const st = seriesStyle(i);
    return { label: s.label, color: st.color, shape: st.dashed ? "dash" : "line" };
  });
}

/** 推移の折れ線 1 枚。系列が 0 本なら「—」 */
function TrendChart({
  title,
  heading,
  series,
  labels,
  width,
}: {
  title: string;
  heading: string;
  series: readonly TrendSeries[];
  labels: readonly string[];
  width: number;
}) {
  return (
    <div>
      <p className="small muted">{heading}</p>
      {series.length === 0 ? (
        <p>
          <MissingValue missing={{ reason: "missing", text: MISSING_REASON_TEXT.missing }} />
        </p>
      ) : (
        <>
          <div className="chart">
            <LineChart title={title} labels={labels} series={trendLines(series)} format="percent" width={width} height={200} min={0} />
          </div>
          <Legend items={trendLegend(series)} />
        </>
      )}
    </div>
  );
}

/** 推移（全幅）。性別と年齢を半幅ずつ並べ、その下に国（最新の週の上位 5 か国） */
export function TrendCard({
  weeks,
  gender,
  age,
  country,
  latestWeek,
  lastFetchedAt,
}: {
  weeks: readonly string[];
  gender: readonly TrendSeries[];
  age: readonly TrendSeries[];
  country: readonly TrendSeries[];
  latestWeek: string;
  lastFetchedAt: Date | null;
}) {
  const labels = weeks.map(formatDateShort);
  return (
    <Card
      title="推移"
      sub="週ごとの割合"
      className="col-12"
      foot={
        <>
          点は週の月曜の日付・{DENOMINATOR_NOTE}・{timeNote(latestWeek, lastFetchedAt)}
        </>
      }
    >
      <div className="grid">
        <div className="col-6">
          <TrendChart title="性別の割合の週ごとの推移" heading="性別" series={gender} labels={labels} width={360} />
        </div>
        <div className="col-6">
          <TrendChart title="年齢の割合の週ごとの推移" heading="年齢" series={age} labels={labels} width={360} />
        </div>
        <div className="col-12">
          <TrendChart
            title="国の割合の週ごとの推移（最新の週の上位 5 か国）"
            heading="国（最新の週の上位 5 か国）"
            series={country}
            labels={labels}
            width={760}
          />
        </div>
      </div>
    </Card>
  );
}

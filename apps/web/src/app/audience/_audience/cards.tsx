/**
 * オーディエンスのカード（R5 設計 6.4 節）。値は `lib/audience.ts` で計算済みのものを受け取り、描くだけにする。
 * 区分の名前（国コード、都市名）は JSX の子と属性として出す（S11）
 */
import { Card } from "@/components/Card";
import { HBars } from "@/components/charts/HBars";
import { Legend } from "@/components/charts/Legend";
import { Pie, type PieSlice } from "@/components/charts/Pie";
import { MissingValue } from "@/components/MissingValue";
import {
  BREAKDOWN_LABEL,
  DENOMINATOR_NOTE,
  weekLabel,
  type BreakdownCard,
} from "@/lib/audience";
import { formatCount, formatJst, formatPercent } from "@/lib/format";
import { MISSING_REASON_TEXT } from "@/lib/metrics";

/** 円グラフの扇の色の元。色の変数は 4 つだけなので、5 つ目からは同じ色を薄めて見分ける */
const SLICE_BASES: readonly string[] = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

function sliceColor(i: number): string {
  const base = SLICE_BASES[i % SLICE_BASES.length] ?? "var(--chart-1)";
  return Math.floor(i / SLICE_BASES.length) % 2 === 1 ? `color-mix(in oklab, ${base} 45%, var(--color-surface))` : base;
}

/** 性別と年齢は円グラフ、国と都市は横棒 */
function BreakdownChart({ card, title }: { card: Extract<BreakdownCard, { kind: "ok" }>; title: string }) {
  if (card.breakdown === "country" || card.breakdown === "city") {
    return (
      <div className="chart">
        <HBars title={title} rows={card.rows} />
      </div>
    );
  }
  const slices: PieSlice[] = card.rows.map((r, i) => ({ ...r, color: sliceColor(i) }));
  return (
    <>
      <div className="chart">
        <Pie title={title} slices={slices} />
      </div>
      <Legend
        items={slices.map((s) => ({ label: `${s.label} ${formatCount(s.value)}（${formatPercent(s.share, 1)}）`, color: s.color }))}
      />
    </>
  );
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
      <BreakdownChart card={card} title={`${metricLabel}の${label}の人数と割合`} />
      {card.others > 0 && <p className="small muted">ほか {card.others} 件</p>}
    </Card>
  );
}

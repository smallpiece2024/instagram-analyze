import { Card } from "@/components/Card";
import { LineChart } from "@/components/charts/LineChart";
import { VBars } from "@/components/charts/VBars";
import { formatCount, formatDateShort, formatJst, mediaTitle } from "@/lib/format";
import { clampPeriod, compareYmd, eachDay, periodLength, type Period, type Ymd } from "@/lib/period";
import { getMetricChangeDates, getPostMarkers } from "@/lib/queries/overview";
import { getDailySeries, getFollowerChange, getFollowerSeries } from "@/lib/queries/period-summary";
import { LoadError } from "./states";

export interface DailyTrendCardProps {
  accountId: string;
  /** 今の期間（太平洋時間の日付） */
  period: Period;
  /** 日次指標のある最初の日（期間がそれより前から始まるなら、ある分だけ描く） */
  dataStart: Ymd;
  /** 日次指標の取得時刻の最大（カードの下の注記） */
  dailyFetchedAt: Date | null;
  className?: string;
}

const TITLE = "リーチ数とフォロワー数の日次推移";

/** 幅ごとの描き分け（PC の 8 列のカードは 760、スマートフォンは 340。設計 5.3 節） */
const WIDTHS = [
  { width: 760, className: "only-d" },
  { width: 340, className: "only-m" },
] as const;

/**
 * リーチ数の日次の棒と、フォロワー数の折れ線（3.2 節）。X 軸は太平洋時間の日付で、フォロワー数（日本時間の日付）は
 * 同じ日付の位置に置く（6 章）。投稿の印は投稿日時を太平洋時間の日付に直した位置。
 * 軸の終わりは、期間の終わり（リーチ数のある最新の日）とフォロワー数の最新の記録の日の遅い方。日次指標は閉じた日しか
 * 取れず 2 日遅れるので、右端はリーチ数の棒が空になり、折れ線だけ最新の記録まで伸びる（折れ線の右端の数と
 * フォロワー数のタイルが同じ記録になる。2026-10-15 のユーザーの決定）
 */
export async function DailyTrendCard({ accountId, period, dataStart, dailyFetchedAt, className }: DailyTrendCardProps) {
  // 最新の記録は `OverviewKpis` のフォロワー数のタイルと同じ読み出し（同じ引数なので `cache` で 1 回になる）
  const change = await getFollowerChange(accountId, period.from, period.to);
  if (!change.ok) {
    return (
      <Card title={TITLE} className={className}>
        <LoadError reason={change.reason} />
      </Card>
    );
  }
  const latestOn = change.data.latest?.captured_on ?? null;
  const to = latestOn !== null && compareYmd(latestOn, period.to) > 0 ? latestOn : period.to;
  // 日次指標の始まりより前の日は「欠け」ではないので軸に入れない（ある分だけ描く）
  const clamped = clampPeriod({ from: period.from, to }, dataStart, to);
  const axis = clamped?.period ?? { from: period.from, to };
  const [daily, followers, markers, changes] = await Promise.all([
    getDailySeries(accountId, axis.from, axis.to),
    getFollowerSeries(accountId, axis.from, axis.to),
    getPostMarkers(accountId, axis.from, axis.to),
    getMetricChangeDates(axis.from, axis.to),
  ]);
  const failed = [daily, followers, markers, changes].find((r) => !r.ok);
  if (failed && !failed.ok) {
    return (
      <Card title={TITLE} className={className}>
        <LoadError reason={failed.reason} />
      </Card>
    );
  }
  if (!daily.ok || !followers.ok || !markers.ok || !changes.ok) return null;

  const dates = eachDay(axis);
  const labels = dates.map(formatDateShort);
  const indexOf = new Map(dates.map((d, i) => [d, i]));

  const reachByDate = new Map(daily.data.map((p) => [p.metric_date, p.reach]));
  const reach = dates.map((d) => reachByDate.get(d) ?? null);
  let maxIndex = -1;
  reach.forEach((v, i) => {
    if (v !== null && (maxIndex < 0 || v > (reach[maxIndex] ?? 0))) maxIndex = i;
  });

  const followerByDate = new Map(followers.data.map((p) => [p.captured_on, p.followers_count]));
  const followerValues = dates.map((d) => followerByDate.get(d) ?? null);
  const lastFollower = [...followerValues].reverse().find((v): v is number => v !== null);

  // 同じ日の投稿は印を 1 つにまとめ、ヒントに投稿ごとの「投稿日時」と「題名」の 2 行を空行で区切って並べる
  const tipsByIndex = new Map<number, string[]>();
  for (const m of markers.data) {
    const i = indexOf.get(m.posted_date_pt);
    if (i === undefined) continue;
    const tips = tipsByIndex.get(i) ?? [];
    tips.push(`${formatJst(m.posted_at)}\n${mediaTitle(m.caption)}`);
    tipsByIndex.set(i, tips);
  }
  const markerIndexes = [...tipsByIndex.keys()].sort((a, b) => a - b);
  const markerTips = markerIndexes.map((i) => (tipsByIndex.get(i) ?? []).join("\n\n"));
  const refLines = changes.data
    .map((d) => indexOf.get(d))
    .filter((i): i is number => i !== undefined)
    .map((index) => ({ index, label: "指標変更" }));

  // 「N 日分」は日次指標の日数（右端の未反映の日は数えない）
  const shortened = clamped?.truncated ? `${axis.from} から ${periodLength({ from: axis.from, to: period.to })} 日分` : null;

  return (
    <Card
      title={TITLE}
      className={className}
      foot={
        <>
          <span style={{ color: "var(--chart-marker)" }}>▲</span> は投稿のあった日・リーチ数の反映は 2 日遅れます・日次指標:{" "}
          {period.to} まで・取得 {formatJst(dailyFetchedAt)}
          {shortened && `・${shortened}`}
        </>
      }
    >
      <p className="small muted">リーチ数</p>
      {WIDTHS.map(({ width, className: cls }) => (
        <div key={width} className={`chart ${cls}`}>
          <VBars
            title="リーチ数の日次の棒グラフ"
            values={reach}
            labels={labels}
            color="var(--chart-1)"
            width={width}
            height={170}
            markers={markerIndexes}
            markerTips={markerTips}
            refLines={refLines}
            valueLabels={maxIndex >= 0 ? [maxIndex] : undefined}
          />
        </div>
      ))}
      <p className="small muted mt-6">フォロワー数</p>
      {WIDTHS.map(({ width, className: cls }) => (
        <div key={width} className={`chart ${cls}`}>
          <LineChart
            autoMin
            title="フォロワー数の折れ線グラフ"
            labels={labels}
            width={width}
            height={130}
            align
            markers={markerIndexes}
            markerTips={markerTips}
            refLines={refLines}
            series={[
              {
                label: "フォロワー数",
                values: followerValues,
                color: "var(--chart-1)",
                // 日ごとの点。ヒントは「フォロワー数 10/13: 1,234」（2026-10-15 のユーザーの依頼）
                dots: true,
                endLabel: lastFollower === undefined ? undefined : formatCount(lastFollower),
              },
            ]}
          />
        </div>
      ))}
    </Card>
  );
}

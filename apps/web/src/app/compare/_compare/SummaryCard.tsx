import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { Delta } from "@/components/Delta";
import { MissingValue } from "@/components/MissingValue";
import { formatValue, type ValueFormat } from "@/lib/format";
import {
  deltaCount,
  deltaPoint,
  deltaRate,
  KIND_LABEL,
  MISSING_REASON_TEXT,
  type Delta as DeltaValue,
  type Missing,
  type RatioOfSums,
} from "@/lib/metrics";
import { compareYmd, type Period, type Ymd } from "@/lib/period";
import { getPeriodComparison, type PeriodSide } from "@/lib/queries/compare";
import { POST_KINDS, type PostSum } from "@/lib/queries/period-summary";
import { PT_NOTE } from "@/lib/metric-definitions";
import { periodLabel } from "./labels";

/** 値がない（計算に使える日や投稿がない）ときの「—」。文言は `lib/metrics.ts` の理由から決まる */
const NO_DATA: Missing = { reason: "no_baseline_data", text: MISSING_REASON_TEXT.no_baseline_data };

type DeltaKind = "rate" | "pt" | "count";

interface Row {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  format: ValueFormat;
  delta: DeltaKind;
  /** 値の右に添える「n 件中 m 件」など */
  aNote?: string;
  bNote?: string;
  sub?: boolean;
}

function deltaOf(kind: DeltaKind, a: number | null, b: number | null): DeltaValue | null {
  if (kind === "rate") return deltaRate(a, b);
  if (kind === "pt") return deltaPoint(a, b);
  return deltaCount(a, b);
}

/** 欠けた投稿があるときだけ「n 件中 m 件」 */
function usedNote(r: { used: number; total: number }): string | undefined {
  return r.used < r.total ? `${r.total} 件中 ${r.used} 件` : undefined;
}

function ratioRow(key: string, label: string, a: RatioOfSums, b: RatioOfSums): Row {
  return { key, label, a: a.value, b: b.value, format: "percent", delta: "pt", aNote: usedNote(a), bNote: usedNote(b) };
}

function sumRow(key: string, label: string, a: PostSum, b: PostSum): Row {
  return { key, label, a: a.sum, b: b.sum, format: "count", delta: "rate", aNote: usedNote(a), bNote: usedNote(b) };
}

function rowsOf(a: PeriodSide, b: PeriodSide): Row[] {
  return [
    { key: "reach", label: "リーチ（日別合計）", a: a.daily.reach.sum, b: b.daily.reach.sum, format: "count", delta: "rate" },
    { key: "views", label: "閲覧数（日別合計）", a: a.daily.views.sum, b: b.daily.views.sum, format: "count", delta: "rate" },
    {
      key: "followers",
      label: "フォロワー純増",
      a: a.followers.net,
      b: b.followers.net,
      format: "count",
      delta: "count",
    },
    {
      key: "nf",
      label: "非フォロワーリーチ比率",
      a: a.daily.nonFollowerReachRate.value,
      b: b.daily.nonFollowerReachRate.value,
      format: "percent",
      delta: "pt",
      aNote: daysNote(a.daily.nonFollowerReachRate),
      bNote: daysNote(b.daily.nonFollowerReachRate),
    },
    { key: "posts", label: "投稿数", a: a.posts.posts, b: b.posts.posts, format: "count", delta: "rate" },
    ...POST_KINDS.map(
      (k): Row => ({
        key: `posts-${k}`,
        label: KIND_LABEL[k],
        a: a.posts.byKind[k].posts,
        b: b.posts.byKind[k].posts,
        format: "count",
        delta: "rate",
        sub: true,
      }),
    ),
    ratioRow("er", "ER", a.posts.er, b.posts.er),
    ratioRow("save", "保存率", a.posts.saveRate, b.posts.saveRate),
    ratioRow("share", "シェア率", a.posts.shareRate, b.posts.shareRate),
    sumRow("pv", "プロフィール訪問（参考）", a.posts.profileVisits, b.posts.profileVisits),
  ];
}

function daysNote(r: RatioOfSums): string | undefined {
  return r.used < r.total ? `${r.total} 日中 ${r.used} 日` : undefined;
}

function Value({ v, format, note }: { v: number | null; format: ValueFormat; note?: string }) {
  if (v === null) return <MissingValue missing={NO_DATA} />;
  return (
    <>
      {formatValue(v, format)}
      {note && <div className="xs muted">{note}</div>}
    </>
  );
}

function daysLine(name: string, side: PeriodSide): string | null {
  const { periodDays, reach } = side.daily;
  return reach.days < periodDays ? `${name}: ${periodDays} 日中 ${reach.days} 日分` : null;
}

/** 主要指標の表（3.5 節「表示」の 1） */
export async function SummaryCard({
  accountId,
  a,
  b,
  dataStart,
}: {
  accountId: string;
  a: Period;
  b: Period;
  /** 日次指標の始まり（太平洋時間の日付） */
  dataStart: Ymd;
}) {
  const result = await getPeriodComparison(accountId, a, b);
  if (!result.ok) {
    return (
      <Card title="主要指標" className="col-12">
        <Callout state="bad">読み出せません（{result.reason}）</Callout>
      </Card>
    );
  }
  const { a: sa, b: sb } = result.data;
  const rows = rowsOf(sa, sb);
  const gaps = [daysLine("A", sa), daysLine("B", sb)].filter((s): s is string => s !== null);
  const bBeforeData = compareYmd(b.to, dataStart) < 0;

  return (
    <Card
      title="主要指標"
      className="col-12"
      foot={
        <>
          <p>リーチ、閲覧数、非フォロワーリーチ比率: 米国太平洋時間の日付で集計（日別の値の合計で、期間の重複を除いた人数ではない）。</p>
          <p>フォロワー純増: 日本時間の日付の記録（期間の前日の記録から終わりの日の記録までの差）。</p>
          <p>投稿数、ER、保存率、シェア率、プロフィール訪問: 投稿日時の日本時間の日付で期間に入れ、各投稿の最新の値で集計。</p>
          <p>{PT_NOTE}</p>
        </>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">指標</th>
              <th scope="col" className="num">
                A <span className="muted">{periodLabel(a)}</span>
              </th>
              <th scope="col" className="num">
                B <span className="muted">{periodLabel(b)}</span>
              </th>
              <th scope="col" className="num">
                差
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className={r.sub ? "row-head row-head--sub" : "row-head"}>
                  {r.label}
                </th>
                <td className="num">
                  <Value v={r.a} format={r.format} note={r.aNote} />
                </td>
                <td className="num">
                  <Value v={r.b} format={r.format} note={r.bNote} />
                </td>
                <td className="num">
                  <Delta delta={deltaOf(r.delta, r.a, r.b)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(gaps.length > 0 || bBeforeData) && (
        <div className="note">
          {gaps.length > 0 && <p>{gaps.join("、")}（合計はある日の合計）</p>}
          {bBeforeData && <p>この期間の日次指標はありません（日次指標は {dataStart} から）</p>}
        </div>
      )}
    </Card>
  );
}


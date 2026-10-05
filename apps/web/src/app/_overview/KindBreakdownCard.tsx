import { Card } from "@/components/Card";
import { KindLegend } from "@/components/charts/Legend";
import { Stacked100 } from "@/components/charts/Stacked100";
import { MetricHint } from "@/components/MetricHint";
import { TypeTag } from "@/components/TypeTag";
import { formatCount, formatJst } from "@/lib/format";
import type { Period } from "@/lib/period";
import { getPostTotals, POST_KINDS } from "@/lib/queries/period-summary";
import { LoadError } from "./states";
import { HINT } from "./texts";

export interface KindBreakdownCardProps {
  accountId: string;
  /** 今の期間。投稿日時の日本時間の日付がこの範囲に入る投稿を数える（6 章） */
  period: Period;
  /** 投稿の指標の取得時刻の最大（カードの下の注記） */
  mediaFetchedAt: Date | null;
  className?: string;
}

const TITLE = "投稿の種類の内訳";

/** 棒を描く最少の投稿数（3.2 節「件数が少ないとき」） */
const MIN_POSTS_FOR_BARS = 3;

/**
 * 投稿の種類の内訳（3.2 節）。100% 積み上げ棒 3 行（投稿数、リーチ、保存）と表。
 * 0 件の種類も凡例と表から消さない。ストーリーズは `getPostTotals` に入らないので出さない
 */
export async function KindBreakdownCard({ accountId, period, mediaFetchedAt, className }: KindBreakdownCardProps) {
  const totals = await getPostTotals(accountId, period.from, period.to);
  if (!totals.ok) {
    return (
      <Card title={TITLE} className={className}>
        <LoadError reason={totals.reason} />
      </Card>
    );
  }
  const { byKind, posts } = totals.data;
  const rows = [
    { label: "投稿数", parts: POST_KINDS.map((kind) => ({ kind, value: byKind[kind].posts })) },
    { label: "リーチ", parts: POST_KINDS.map((kind) => ({ kind, value: byKind[kind].reach.sum })) },
    { label: "保存", parts: POST_KINDS.map((kind) => ({ kind, value: byKind[kind].saved.sum })) },
  ];

  return (
    <Card
      title={TITLE}
      className={className}
      foot={`投稿日: 日本時間の日付・投稿ごとの最新の取得 ${formatJst(mediaFetchedAt)}`}
    >
      <KindLegend kinds={POST_KINDS} />
      {posts >= MIN_POSTS_FOR_BARS && (
        <div className="chart">
          <Stacked100 title="投稿の種類ごとの投稿数、リーチ、保存の割合" rows={rows} width={360} />
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>種類</th>
              <th className="num">投稿</th>
              <th className="num">
                <MetricHint label="リーチ" text={HINT.postReach} />
              </th>
              <th className="num">
                <MetricHint label="保存" text={HINT.postSaved} />
              </th>
            </tr>
          </thead>
          <tbody>
            {POST_KINDS.map((kind) => (
              <tr key={kind}>
                <td>
                  <TypeTag kind={kind} />
                </td>
                <td className="num">{formatCount(byKind[kind].posts)}</td>
                <td className="num">{formatCount(byKind[kind].reach.sum)}</td>
                <td className="num">{formatCount(byKind[kind].saved.sum)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

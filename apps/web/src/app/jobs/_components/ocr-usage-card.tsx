/**
 * 「AI・OCR の利用状況」（R4.1 設計 6.4 節、要件 9 章）。今月（UTC）のユニットと無料枠の残り、直近 12 か月の表。
 * 無料枠と単価は `lib/ocr-usage.ts` の定数（ワーカーの月の上限とは別の値）。推定費用は画面で掛ける。
 * `QueryResult` の失敗はカードの中の `Callout`（R3 4.5 節）
 */
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { MetricHint } from "@/components/MetricHint";
import { formatCount } from "@/lib/format";
import {
  currentMonthUsage,
  estimatedCostUsd,
  fillMonths,
  formatUsd,
  FREE_UNITS_WARN_BELOW,
  remainingFreeUnits,
  VISION_FREE_UNITS_PER_MONTH,
} from "@/lib/ocr-usage";
import { getOcrMonthlyUsage } from "@/lib/queries/ocr-usage";

const TITLE = "AI・OCR の利用状況";
const UNIT_HINT = "ユニット = Vision API の課金の単位。画像 1 枚 = 1 ユニット";
const FOOT = "推定。請求は Google Cloud の明細で確かめる。手動の確認（scripts/ocr-check.mjs）の分は含まない。";

export async function OcrUsageCard({ accountId, className }: { accountId: string; className?: string }) {
  const result = await getOcrMonthlyUsage(accountId);
  if (!result.ok) {
    return (
      <Card title={TITLE} className={className}>
        <Callout state="bad">読み出せません（{result.reason}）</Callout>
      </Card>
    );
  }
  const rows = result.data;
  if (rows.length === 0) {
    return (
      <Card title={TITLE} className={className}>
        <p>まだ利用がありません</p>
      </Card>
    );
  }
  const now = new Date();
  const cur = currentMonthUsage(rows, now);
  const remaining = remainingFreeUnits(cur.units);
  const months = fillMonths(rows, now);
  return (
    <Card title={TITLE} sub={`今月（UTC）${cur.month}`} className={className} foot={FOOT}>
      <div className="stack">
        {remaining < FREE_UNITS_WARN_BELOW && (
          <Callout state="warn">今月の無料枠の残り {formatCount(remaining)} ユニット</Callout>
        )}
        <div className="metrics-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(9em, 1fr))", marginTop: 0 }}>
          <div>
            <span style={{ display: "block" }}>
              <MetricHint label="ユニット" text={UNIT_HINT} />
            </span>
            <b>
              {formatCount(cur.units)} ／ {formatCount(VISION_FREE_UNITS_PER_MONTH)}
            </b>
          </div>
          <div>
            <span>残り</span>
            <b>{formatCount(remaining)}</b>
          </div>
          <div>
            <span>本数</span>
            <b>{formatCount(cur.videos)}</b>
          </div>
          <div>
            <span>要求</span>
            <b>{formatCount(cur.requests)}</b>
          </div>
          <div>
            <span>失敗</span>
            <b>{formatCount(cur.failed_requests)}</b>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">月（UTC）</th>
                <th scope="col" className="num hide-m">
                  要求
                </th>
                <th scope="col" className="num hide-m">
                  画像
                </th>
                <th scope="col" className="num">
                  <MetricHint label="ユニット" text={UNIT_HINT} />
                </th>
                <th scope="col" className="num">
                  本数
                </th>
                <th scope="col" className="num">
                  失敗
                </th>
                <th scope="col" className="num">
                  推定費用（USD）
                </th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td className="num">{m.month}</td>
                  <td className="num hide-m">{formatCount(m.requests)}</td>
                  <td className="num hide-m">{formatCount(m.images)}</td>
                  <td className="num">{formatCount(m.units)}</td>
                  <td className="num">{formatCount(m.videos)}</td>
                  <td className="num">{formatCount(m.failed_requests)}</td>
                  <td className="num">{formatUsd(estimatedCostUsd(m.units))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

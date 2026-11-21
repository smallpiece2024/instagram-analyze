/**
 * 「上限」（課題 ia-6ui）。DB と Storage の現在値・使用率・増分と、日ごと（JST）の収集の所要とレート制限の使用率。
 * 上限としきい値は `lib/capacity.ts` の定数。`QueryResult` の失敗はカードの中の `Callout`（R3 4.5 節）
 */
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import {
  capacityGrowth,
  dailyLimits,
  DB_LIMIT_BYTES,
  formatBytes,
  formatSignedBytes,
  isOverWarnRatio,
  RUN_DURATION_WARN_SECONDS,
  slowDays,
  STORAGE_LIMIT_BYTES,
  usageRatio,
} from "@/lib/capacity";
import { EMPTY, formatCount, formatDuration, formatPercent } from "@/lib/format";
import { getCapacity } from "@/lib/queries/capacity";

const TITLE = "上限";
const FOOT = "DB は pg_database_size の値。ディスクの使用量（WAL を含む）より小さい。";
const WARN_MINUTES = RUN_DURATION_WARN_SECONDS / 60;

function seconds(v: number | null): string {
  return v === null ? EMPTY : formatDuration(v * 1000);
}

function Size({
  label,
  bytes,
  limit,
  diff,
  days,
}: {
  label: string;
  bytes: number;
  limit: number;
  diff: number | null;
  days: number | null;
}) {
  return (
    <>
      <div>
        <span>{label}</span>
        <b>
          {formatBytes(bytes)} ／ {formatBytes(limit)}
        </b>
      </div>
      <div>
        <span>{label} の使用率</span>
        <b>{formatPercent(usageRatio(bytes, limit))}</b>
      </div>
      <div>
        <span>{days === null ? `${label} の増分` : `${label} の増分（${days} 日前との差）`}</span>
        <b>{diff === null ? EMPTY : formatSignedBytes(diff)}</b>
      </div>
    </>
  );
}

export async function LimitsCard({ accountId, className }: { accountId: string; className?: string }) {
  const result = await getCapacity(accountId);
  if (!result.ok) {
    return (
      <Card title={TITLE} className={className}>
        <Callout state="bad">読み出せません（{result.reason}）</Callout>
      </Card>
    );
  }
  const { capacity, runs, rates } = result.data;
  const growth = capacityGrowth(capacity);
  const days = dailyLimits(runs, rates, new Date());
  const slow = slowDays(days);
  return (
    <Card
      title={TITLE}
      sub={growth === null ? undefined : `${growth.latest.captured_on}（UTC）の記録`}
      className={className}
      foot={FOOT}
    >
      <div className="stack">
        {growth === null ? (
          <p>まだ記録がありません</p>
        ) : (
          <>
            {isOverWarnRatio(growth.latest.db_bytes, DB_LIMIT_BYTES) && (
              <Callout state="warn">
                DB の使用率 {formatPercent(usageRatio(growth.latest.db_bytes, DB_LIMIT_BYTES))}（8 割以上）
              </Callout>
            )}
            {isOverWarnRatio(growth.latest.storage_bytes, STORAGE_LIMIT_BYTES) && (
              <Callout state="warn">
                Storage の使用率 {formatPercent(usageRatio(growth.latest.storage_bytes, STORAGE_LIMIT_BYTES))}（8
                割以上）
              </Callout>
            )}
            <div
              className="metrics-row"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(11em, 1fr))", marginTop: 0 }}
            >
              <Size
                label="DB"
                bytes={growth.latest.db_bytes}
                limit={DB_LIMIT_BYTES}
                diff={growth.dbDiff}
                days={growth.days}
              />
              <Size
                label="Storage"
                bytes={growth.latest.storage_bytes}
                limit={STORAGE_LIMIT_BYTES}
                diff={growth.storageDiff}
                days={growth.days}
              />
              <div>
                <span>Storage の個数</span>
                <b>{formatCount(growth.latest.storage_objects)}</b>
              </div>
            </div>
          </>
        )}
        {slow.length > 0 && (
          <Callout state="warn">
            収集の所要が {WARN_MINUTES} 分を超えた日: {slow.map((d) => `${d.date}（最大 ${seconds(d.maxSeconds)}）`).join("、")}
          </Callout>
        )}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">日（JST）</th>
                <th scope="col" className="num">
                  収集の回数
                </th>
                <th scope="col" className="num">
                  所要の最大
                </th>
                <th scope="col" className="num hide-m">
                  所要の中央値
                </th>
                <th scope="col" className="num">
                  レート制限の使用率の最大
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td className="num">{d.date}</td>
                  <td className="num">{formatCount(d.runs)}</td>
                  <td className="num">{seconds(d.maxSeconds)}</td>
                  <td className="num hide-m">{seconds(d.medianSeconds)}</td>
                  <td className="num">{d.maxUsage === null ? EMPTY : `${d.maxUsage}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

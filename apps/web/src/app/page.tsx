import Link from "next/link";
import { Suspense } from "react";
import { Callout, Note } from "@/components/Callout";
import { Card } from "@/components/Card";
import { PageHead } from "@/components/PageHead";
import { lastUpdatedLabel } from "@/lib/format";
import { parseRange } from "@/lib/params";
import { isStale, lastNDays, previousPeriod, todayPacific } from "@/lib/period";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getOverviewUpdatedAt } from "@/lib/queries/overview";
import { getDailyRange } from "@/lib/queries/period-summary";
import { RangeChips } from "./_overview/Chips";
import { DailyTrendCard } from "./_overview/DailyTrendCard";
import { KindBreakdownCard } from "./_overview/KindBreakdownCard";
import { OverviewKpis } from "./_overview/OverviewKpis";
import { CardLoading, LoadError, NotCollected } from "./_overview/states";
import { DAY_BOUNDARY_NOTE } from "@/lib/metric-definitions";

const TITLE = "概要";

/**
 * 概要（R3 設計 3.2 節）。期間の終わりは今日ではなく、日次指標（`reach`）のある最新の日（太平洋時間の日付）。
 * 期間（`?range=`）は `lib/params` で検査し、外れた値は既定に戻す（4.7 節）。ER の分母はリーチに固定（2026-10-06、ユーザーの判断）。
 * カードごとに `<Suspense>` で包み、1 枚の失敗でほかを止めない（4.5 節）
 */
export default async function OverviewPage(props: PageProps<"/">) {
  const searchParams = await props.searchParams;
  const range = parseRange(searchParams.range);

  const account = await getTargetAccount();
  if (!account.ok) {
    return (
      <main className="main">
        <PageHead title={TITLE} />
        {account.reason === TARGET_ACCOUNT_NOT_SET ? (
          <Callout state="warn">
            {TARGET_ACCOUNT_NOT_SET}。<Link href="/connect">接続設定</Link>
          </Callout>
        ) : (
          <LoadError reason={account.reason} />
        )}
      </main>
    );
  }
  const accountId = account.data.id;

  const [dailyRange, updatedAt] = await Promise.all([getDailyRange(accountId), getOverviewUpdatedAt(accountId)]);
  const updated = updatedAt.ok ? updatedAt.data : { daily: null, media: null, latest: null };

  if (!dailyRange.ok || dailyRange.data === null) {
    return (
      <main className="main">
        <PageHead title={TITLE} sub={lastUpdatedLabel(updated.latest)} tools={<RangeChips range={range} />} />
        {!dailyRange.ok ? (
          <Card>
            <LoadError reason={dailyRange.reason} />
          </Card>
        ) : (
          <div className="grid">
            <Card title="リーチとフォロワー数の日次推移" className="col-8">
              <NotCollected />
            </Card>
            <Card title="投稿の種類の内訳" className="col-4">
              <NotCollected />
            </Card>
          </div>
        )}
        <Note>{DAY_BOUNDARY_NOTE}</Note>
      </main>
    );
  }

  const { start, end } = dailyRange.data;
  const cur = lastNDays(end, range);
  const prev = previousPeriod(cur);
  const stale = isStale(end, todayPacific(new Date()));

  return (
    <main className="main stack">
      <PageHead
        title={TITLE}
        sub={`過去 ${range} 日（${cur.from} 〜 ${cur.to}）・${lastUpdatedLabel(updated.latest)}`}
        tools={<RangeChips range={range} />}
      />
      {stale && (
        <Callout state="warn">
          日次指標が {end} で止まっています。<Link href="/jobs">収集ログ</Link>
        </Callout>
      )}
      {!updatedAt.ok && <LoadError reason={updatedAt.reason} />}
      <Suspense fallback={<div className="kpis" aria-busy="true" />}>
        <OverviewKpis accountId={accountId} cur={cur} prev={prev} />
      </Suspense>
      <div className="grid">
        <Suspense fallback={<CardLoading title="リーチとフォロワー数の日次推移" className="col-8" />}>
          <DailyTrendCard
            accountId={accountId}
            period={cur}
            dataStart={start}
            dailyFetchedAt={updated.daily}
            className="col-8"
          />
        </Suspense>
        <Suspense fallback={<CardLoading title="投稿の種類の内訳" className="col-4" />}>
          <KindBreakdownCard accountId={accountId} period={cur} mediaFetchedAt={updated.media} className="col-4" />
        </Suspense>
      </div>
      <Note>{DAY_BOUNDARY_NOTE}</Note>
    </main>
  );
}

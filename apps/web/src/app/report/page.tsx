import Link from "next/link";
import { Suspense } from "react";
import { OverviewKpis } from "@/app/_overview/OverviewKpis";
import { CardLoading, LoadError, NotCollected } from "@/app/_overview/states";
import { Callout, Note } from "@/components/Callout";
import { Card } from "@/components/Card";
import { ChoiceChips } from "@/components/ChoiceChips";
import { PageHead } from "@/components/PageHead";
import { buildHref } from "@/components/href";
import { formatJst } from "@/lib/format";
import { DAY_BOUNDARY_NOTE } from "@/lib/metric-definitions";
import { clampPeriod, isStale, periodLength, previousMonth, todayPacific } from "@/lib/period";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getDailyRange } from "@/lib/queries/period-summary";
import { getReportNotes } from "@/lib/queries/report-notes";
import { resolveReportMonth } from "@/lib/report-month";
import { saveReportNotes } from "./actions";
import { FollowerTrendCard } from "./_report/FollowerTrendCard";
import { FunnelCard } from "./_report/FunnelCard";
import { HighlightsCard } from "./_report/HighlightsCard";
import { KindSummaryCard } from "./_report/KindSummaryCard";
import { ReachViewsTrendCard } from "./_report/ReachViewsTrendCard";
import { NextPlanForm, ReportNotesProvider, SummaryField } from "./_report/ReportNotesForm";
import { TagMonthlyCard } from "./_report/TagMonthlyCard";
import { SECTION_TITLES as T } from "./_report/titles";

const TITLE = "レポート";
const REPORT_PATH = "/report";

/**
 * 月次レポート（R6 設計 6 章、6.1 節）。`?month=YYYY-MM` を `resolveReportMonth` で検査し、不正か範囲の外なら既定の月（前月）。
 * 日次指標がなければ概要と同じ `NotCollected` を出し、月の選択と記入欄は出さない。
 * 9 節をカードで上から順に並べ、節ごとに `<Suspense>` で包む（1 枚の失敗でほかを止めない）。1 節と 9 節の記入欄の値だけページで await する。
 * 認可はページでは確かめない（proxy が守る）。Server Action の中で確かめる
 */
export default async function ReportPage(props: PageProps<"/report">) {
  const searchParams = await props.searchParams;

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

  const dailyRange = await getDailyRange(accountId);
  if (!dailyRange.ok) {
    return (
      <main className="main">
        <PageHead title={TITLE} />
        <Card>
          <LoadError reason={dailyRange.reason} />
        </Card>
      </main>
    );
  }
  const resolved =
    dailyRange.data === null ? null : resolveReportMonth(searchParams.month, { start: dailyRange.data.start, latest: dailyRange.data.end });
  if (dailyRange.data === null || resolved === null) {
    return (
      <main className="main stack">
        <PageHead title={TITLE} />
        <Card title={T.kpis}>
          <NotCollected />
        </Card>
        <Note>{DAY_BOUNDARY_NOTE}</Note>
      </main>
    );
  }

  const { month, period: calendarMonth, selectable } = resolved;
  const latest = dailyRange.data.end;
  // 表示の期間は `to` を日次指標の最新の日に切り詰める（今月を選んだとき。T9 (1)）。`from` は暦月の 1 日のまま
  const clamped = clampPeriod(calendarMonth, null, latest);
  const period = clamped?.period ?? calendarMonth;
  const shortened = clamped?.truncated ? `${period.from} から ${periodLength(period)} 日分` : null;
  const prev = previousMonth(calendarMonth.from);
  const stale = isStale(latest, todayPacific(new Date()));

  const notes = await getReportNotes(accountId, month);
  const savedNotes = notes.ok ? notes.data : null;

  const chips = selectable.map((m) => ({ value: m, label: m, href: buildHref(REPORT_PATH, { month: m }) }));

  return (
    <main className="main stack">
      <PageHead
        title={TITLE}
        sub={`${month}（${period.from} 〜 ${period.to}）${shortened ? `・${shortened}` : ""}`}
        tools={<ChoiceChips label="月" options={chips} current={month} />}
      />
      {stale && (
        <Callout state="warn">
          日次指標が {latest} で止まっています。<Link href="/jobs">収集ログ</Link>
        </Callout>
      )}
      <ReportNotesProvider action={saveReportNotes}>
        <Card title={T.summary}>
          {notes.ok ? <SummaryField saved={savedNotes?.summary ?? ""} /> : <LoadError reason={notes.reason} />}
        </Card>
        <Card title={T.kpis} foot={<>前期 = 前月（{prev.from} 〜 {prev.to}）・フォロワー数は月末の記録</>}>
          <Suspense key={`kpis-${month}`} fallback={<div className="kpis" aria-busy="true" />}>
            <OverviewKpis accountId={accountId} cur={period} prev={prev} followerTile="end" />
          </Suspense>
        </Card>
        <Suspense key={`followers-${month}`} fallback={<CardLoading title={T.followers} />}>
          <FollowerTrendCard accountId={accountId} period={period} />
        </Suspense>
        <Suspense key={`reach-${month}`} fallback={<CardLoading title={T.reachViews} />}>
          <ReachViewsTrendCard accountId={accountId} period={period} prev={prev} />
        </Suspense>
        <Suspense key={`kinds-${month}`} fallback={<CardLoading title={T.kinds} />}>
          <KindSummaryCard accountId={accountId} period={period} />
        </Suspense>
        <Suspense key={`highlights-${month}`} fallback={<CardLoading title={T.highlights} />}>
          <HighlightsCard accountId={accountId} period={period} />
        </Suspense>
        <Suspense key={`tags-${month}`} fallback={<CardLoading title={T.tags} />}>
          <TagMonthlyCard accountId={accountId} period={period} />
        </Suspense>
        <Suspense key={`funnel-${month}`} fallback={<CardLoading title={T.funnel} />}>
          <FunnelCard accountId={accountId} period={period} />
        </Suspense>
        <Card title={T.nextPlan}>
          {notes.ok ? (
            <NextPlanForm
              month={month}
              saved={savedNotes?.next_plan ?? ""}
              savedAt={savedNotes ? formatJst(savedNotes.updated_at) : null}
            />
          ) : (
            <LoadError reason={notes.reason} />
          )}
        </Card>
      </ReportNotesProvider>
      <Note>{DAY_BOUNDARY_NOTE}</Note>
    </main>
  );
}

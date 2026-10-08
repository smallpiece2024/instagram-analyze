/**
 * 投稿時刻（`/timing`。R5 設計 6.5 節、要件 F-UI-42、見本 `render.js` の `S.timing`）。
 *
 * - 対象は過去 1 年間（365 日）の投稿（ストーリーズを除く）。曜日と時間帯は投稿日時の JST
 * - 選択は指標（`m`。既定は 24 時間リーチ。文言に件数）と種類（`kind`。既定はすべて）。データの状況で既定を変えない（T15）
 * - すべてのカードを選んだ指標と種類で描き直す。計算はサーバーの純関数（`buildTimingView`）
 * - 対象が 0 件なら、全カードの代わりに「—」（件数は選択の文言で分かる）
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { ChoiceChips } from "@/components/ChoiceChips";
import { PageHead } from "@/components/PageHead";
import { buildHref } from "@/components/href";
import { lastUpdatedLabel } from "@/lib/format";
import { KIND_FILTERS, parseKindFilter, parseTimingMetric, TIMING_METRICS } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getTimingRows } from "@/lib/queries/timing";
import {
  buildTimingView,
  KIND_FILTER_LABEL,
  TIMING_METRIC_LABEL,
  timingMetricOptionLabel,
  timingQuery,
} from "@/lib/timing";
import { BandCard, DayCard, HeatCard, NoTiming, TopCard } from "./_timing/cards";

const TITLE = "投稿時刻";
const PATH = "/timing";

export default async function TimingPage(props: PageProps<"/timing">) {
  const sp = await props.searchParams;
  const m = parseTimingMetric(sp.m);
  const kind = parseKindFilter(sp.kind);

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
          <Callout state="bad">読み出せません（{account.reason}）</Callout>
        )}
      </main>
    );
  }

  const result = await getTimingRows(account.data.id);
  if (!result.ok) {
    return (
      <main className="main">
        <PageHead title={TITLE} />
        <Card>
          <Callout state="bad">読み出せません（{result.reason}）</Callout>
        </Card>
      </main>
    );
  }

  const { rows, last_fetched_at } = result.data;
  const view = buildTimingView(rows, m, kind);

  const tools = (
    <>
      <ChoiceChips
        label="比べる指標"
        lead="比べる指標"
        current={m}
        options={TIMING_METRICS.map((v) => ({
          value: v,
          label: timingMetricOptionLabel(v, view.metricCounts[v]),
          href: buildHref(PATH, timingQuery(v, kind)),
        }))}
      />
      <ChoiceChips
        label="投稿の種類"
        lead="投稿の種類"
        current={kind}
        options={KIND_FILTERS.map((v) => ({
          value: v,
          label: KIND_FILTER_LABEL[v],
          href: buildHref(PATH, timingQuery(m, v)),
        }))}
      />
    </>
  );

  return (
    <main className="main main--wide stack">
      <PageHead
        title={TITLE}
        sub={`${TIMING_METRIC_LABEL[m]}（過去 1 年間の投稿 ${view.total} 件）・${lastUpdatedLabel(last_fetched_at)}`}
        tools={tools}
      />
      <div className="grid">
        {view.total === 0 ? (
          <NoTiming />
        ) : (
          <>
            <HeatCard view={view} />
            <BandCard view={view} />
            <DayCard view={view} />
            <TopCard view={view} />
          </>
        )}
      </div>
    </main>
  );
}

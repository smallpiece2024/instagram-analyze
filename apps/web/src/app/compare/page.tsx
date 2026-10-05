import Link from "next/link";
import { Suspense } from "react";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { PageHead } from "@/components/PageHead";
import { lastUpdatedLabel } from "@/lib/format";
import { isStale, todayPacific } from "@/lib/period";
import { getTargetAccount } from "@/lib/queries/account";
import { getCompareUpdatedAt } from "@/lib/queries/compare";
import { getDailyRange } from "@/lib/queries/period-summary";
import { BaselineCard } from "./_compare/BaselineCard";
import { OverlayCard } from "./_compare/OverlayCard";
import { PeriodForm, PresetLinks } from "./_compare/PeriodForm";
import { resolveCompare, type CompareParams } from "./_compare/periods";
import { SummaryCard } from "./_compare/SummaryCard";

const TITLE = "期間比較";

function Loading({ title }: { title: string }) {
  return (
    <Card title={title} className="col-12">
      <p className="small muted">読み込み中…</p>
    </Card>
  );
}

/** 最終更新の 1 行（失敗しても画面を止めない） */
async function UpdatedAt({ accountId }: { accountId: string }) {
  const r = await getCompareUpdatedAt(accountId);
  return <>{lastUpdatedLabel(r.ok ? r.data : null)}</>;
}

/** 期間比較（R3 設計 3.5 節） */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params: CompareParams = await searchParams;
  const account = await getTargetAccount();
  if (!account.ok) {
    return (
      <main className="main stack">
        <PageHead title={TITLE} />
        <Callout state="bad">
          {account.reason} <Link href="/connect">接続設定へ</Link>
        </Callout>
      </main>
    );
  }
  const accountId = account.data.id;
  const range = await getDailyRange(accountId);
  if (!range.ok) {
    return (
      <main className="main stack">
        <PageHead title={TITLE} />
        <Callout state="bad">読み出せません（{range.reason}）</Callout>
      </main>
    );
  }
  if (range.data === null) {
    return (
      <main className="main stack">
        <PageHead title={TITLE} />
        <Card title="主要指標">
          <p className="small">
            まだ収集されていません。<Link href="/jobs">接続と収集ログへ</Link>
          </p>
        </Card>
      </main>
    );
  }

  const { start, end } = range.data;
  const sel = resolveCompare(params, end);
  const stale = isStale(end, todayPacific(new Date()));
  // 期間が変わったら Suspense の中を描き直す
  const key = `${sel.a.from}_${sel.a.to}_${sel.b.from}_${sel.b.to}`;

  return (
    <main className="main stack">
      <PageHead
        title={TITLE}
        sub={
          <Suspense fallback={lastUpdatedLabel(null)}>
            <UpdatedAt accountId={accountId} />
          </Suspense>
        }
        tools={<PresetLinks current={sel.preset} />}
      />
      {stale && (
        <Callout state="warn">
          日次指標が {end} で止まっています。<Link href="/jobs">接続と収集ログへ</Link>
        </Callout>
      )}
      <Card
        title="期間"
        foot="日付は米国太平洋時間の日付（日次指標の日付）。投稿単位の値は投稿日時の日本時間の日付で期間に入れる。"
      >
        <PeriodForm input={sel.input} errors={sel.errors} />
        {sel.truncatedTo && <p className="note">{sel.truncatedTo} までのデータで表示</p>}
      </Card>
      <div className="grid">
        <Suspense key={`s${key}`} fallback={<Loading title="主要指標" />}>
          <SummaryCard accountId={accountId} a={sel.a} b={sel.b} dataStart={start} />
        </Suspense>
        <Suspense key={`o${key}`} fallback={<Loading title="リーチの日次の重ね合わせ" />}>
          <OverlayCard accountId={accountId} a={sel.a} b={sel.b} />
        </Suspense>
        <Suspense key={`b${key}`} fallback={<Loading title="投稿の基準値" />}>
          <BaselineCard accountId={accountId} a={sel.a} b={sel.b} />
        </Suspense>
      </div>
    </main>
  );
}

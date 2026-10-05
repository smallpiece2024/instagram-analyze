/**
 * `/jobs`: 接続と収集ログ（R3 設計 3.6 節。見本の `S.connection`）。
 *
 * - 対象のアカウントは `getTargetAccount`（4.1 節）。決まらなければ固定文言と `/connect` へのリンクだけ
 * - クエリ `job` は `parseJob`（ジョブ名の許可リスト）、`status` は `parseJobStatus`（5 値）、`page` は `parsePageNumber`。外れたら既定
 * - カードは `<Suspense>` で包み、それぞれがデータを取る。1 枚の失敗はそのカードの中に出す（4.5 節）
 * - 見本の「今すぐ収集」ボタンは置かない（1.2 節）
 */
import Link from "next/link";
import { Suspense } from "react";
import { Callout } from "@/components/Callout";
import { PageHead } from "@/components/PageHead";
import { parseJob, parseJobStatus, parsePageNumber } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { ConnectionStatusList } from "./_components/connection-status";
import { RunsCard } from "./_components/runs-card";
import { ScheduleCard } from "./_components/schedule-card";
import { JobsHeadSub, JobsSummary } from "./_components/summary";

const TITLE = "接続と収集ログ";

function Loading({ className }: { className?: string }) {
  return <p className={className ? `${className} small muted` : "small muted"}>読み込み中…</p>;
}

export default async function JobsPage(props: PageProps<"/jobs">) {
  const sp = await props.searchParams;
  const job = parseJob(sp.job);
  const status = parseJobStatus(sp.status);
  const page = parsePageNumber(sp.page);
  const account = await getTargetAccount();

  if (!account.ok) {
    return (
      <main className="main stack">
        <PageHead title={TITLE} />
        {account.reason === TARGET_ACCOUNT_NOT_SET ? (
          <Callout state="warn">
            {TARGET_ACCOUNT_NOT_SET}。<Link href="/connect">接続設定へ</Link>
          </Callout>
        ) : (
          <Callout state="bad">読み出せません（{account.reason}）</Callout>
        )}
      </main>
    );
  }

  const accountId = account.data.id;
  return (
    <main className="main stack">
      <PageHead
        title={TITLE}
        sub={
          <Suspense fallback={null}>
            <JobsHeadSub accountId={accountId} />
          </Suspense>
        }
      />
      <Suspense fallback={<Loading />}>
        <JobsSummary accountId={accountId} />
      </Suspense>
      <div className="grid">
        <Suspense fallback={<Loading className="col-6" />}>
          <ConnectionStatusList accountId={accountId} className="col-6" />
        </Suspense>
        <Suspense fallback={<Loading className="col-6" />}>
          <ScheduleCard accountId={accountId} className="col-6" />
        </Suspense>
        <Suspense fallback={<Loading className="col-12" />}>
          <RunsCard accountId={accountId} job={job} status={status} page={page} className="col-12" />
        </Suspense>
      </div>
    </main>
  );
}

/**
 * ストーリーズ（`/stories`。R5 設計 6.3 節、要件 F-UI-40、見本 `render.js` の `S.stories`）。
 *
 * - 期間は `range`（30、90、365 日。既定 30。確認事項 Q9）。`range`、`sort`、`dir` は `lib/stories.ts` で検査する
 * - 値は `story_list_metrics`（確定値）。計算はサーバーの純関数（`buildStoriesView`）、描画は Server Component
 * - 離脱ファネルは期間の前から続くまとまりも 1 件目から描く（確認事項 Q10）
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { ChoiceChips } from "@/components/ChoiceChips";
import { PageHead } from "@/components/PageHead";
import { Pager } from "@/components/Pager";
import { buildHref, type Query } from "@/components/href";
import { lastUpdatedLabel, PAGE_SIZE } from "@/lib/format";
import { parsePageNumber, STORY_RANGES } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { signWithSession } from "@/lib/queries/media";
import { getStories } from "@/lib/queries/stories";
import {
  buildStoriesView,
  paginateStories,
  parseStoriesParams,
  storiesQuery,
  storyRangeLabel,
  type StoriesParams,
} from "@/lib/stories";
import { FunnelCard, OpsCard, SummaryCard, TrendCard } from "./_stories/cards";
import { StoryTable } from "./_stories/StoryTable";

const TITLE = "ストーリーズ";

/** 期間の選択。`sort` と `dir` は保ち、`page` は外す（1 ページ目に戻る） */
function RangeChips({ params }: { params: StoriesParams }) {
  return (
    <ChoiceChips
      label="期間"
      current={String(params.range)}
      options={STORY_RANGES.map((range) => ({
        value: String(range),
        label: storyRangeLabel(range),
        href: buildHref("/stories", storiesQuery({ ...params, range })),
      }))}
    />
  );
}

export default async function StoriesPage(props: PageProps<"/stories">) {
  const sp = await props.searchParams;
  const params = parseStoriesParams(sp);
  const page = parsePageNumber(sp.page);

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

  const result = await getStories(account.data.id, params.range);
  if (!result.ok) {
    return (
      <main className="main">
        <PageHead title={TITLE} tools={<RangeChips params={params} />} />
        <Card>
          <Callout state="bad">読み出せません（{result.reason}）</Callout>
        </Card>
      </main>
    );
  }

  const view = buildStoriesView(result.data.rows);
  const sub = `全 ${view.rows.length} 件（${storyRangeLabel(params.range)}）・${lastUpdatedLabel(result.data.last_fetched_at)}`;
  if (view.rows.length === 0) {
    return (
      <main className="main">
        <PageHead title={TITLE} sub={sub} tools={<RangeChips params={params} />} />
        <Card>
          <p>まだストーリーズがありません</p>
        </Card>
      </main>
    );
  }

  const query: Query = storiesQuery(params);
  // 一覧は 1 ページ PAGE_SIZE 件。署名はそのページのサムネイルだけ
  const { pageRows, currentPage, pageCount } = paginateStories(view.rows, params.sort, params.dir, page);
  const paths = Array.from(new Set(pageRows.flatMap((r) => (r.thumbnail_path ? [r.thumbnail_path] : []))));
  const urls = await signWithSession(paths);

  return (
    <main className="main main--wide stack">
      <PageHead title={TITLE} sub={sub} tools={<RangeChips params={params} />} />
      <SummaryCard view={view} />
      <div className="grid">
        <Card title="ストーリーズの一覧" sub={`${view.rows.length} 件`} className="col-12">
          <StoryTable rows={pageRows} urls={urls} sort={params.sort} dir={params.dir} query={query} />
          <Pager page={currentPage} pageCount={pageCount} path="/stories" query={query} total={view.rows.length} pageSize={PAGE_SIZE} />
        </Card>
        <TrendCard view={view} />
        <OpsCard view={view} />
        <FunnelCard view={view} />
      </div>
    </main>
  );
}

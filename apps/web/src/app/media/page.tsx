/**
 * 投稿一覧（`/media`。R3 設計 3.3 節、見本 `render.js` の `S["media-list"]`）。
 *
 * - 指標は各投稿の最新のスナップショットの値。投稿日時の下に投稿からの経過日数を出す（説明の注記は付けない）
 * - PC は表、スマートフォンはカードの並び。同じ HTML に両方を出して CSS（`only-d`／`only-m`）で切り替える
 * - クエリ `sort`、`order`、`page`、`er` は `lib/params.ts` で検査し、外れたら既定に戻す（4.7 節）
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { PageHead } from "@/components/PageHead";
import { Pager } from "@/components/Pager";
import { buildHref, type Query } from "@/components/href";
import { formatCount, lastUpdatedLabel, PAGE_SIZE } from "@/lib/format";
import { DEFAULT_SORT, parseEr, parseOrder, parsePageNumber, parseSort } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getMediaPage, MEDIA_SORT_KEYS } from "@/lib/queries/media";
import { ErSwitch } from "./_list/ErSwitch";
import { MediaCards } from "./_list/MediaCards";
import { MediaTable } from "./_list/MediaTable";

const TITLE = "投稿一覧";

export default async function MediaPage(props: PageProps<"/media">) {
  const sp = await props.searchParams;
  const sort = parseSort(sp.sort, MEDIA_SORT_KEYS, DEFAULT_SORT);
  const order = parseOrder(sp.order);
  const page = parsePageNumber(sp.page);
  const er = parseEr(sp.er);

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

  const result = await getMediaPage(account.data.id, { sort, order, page, er });
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

  const data = result.data;
  // 既定の値は URL に出さない
  const query: Query = {
    sort: sort === DEFAULT_SORT ? undefined : sort,
    order: order === "desc" ? undefined : order,
    er: er === "reach" ? undefined : er,
  };
  const csvHref = buildHref("/export/media", { sort: query.sort, order: query.order });
  const sub = `全 ${formatCount(data.total)} 件・${lastUpdatedLabel(data.last_fetched_at)}`;

  if (data.total === 0) {
    return (
      <main className="main">
        <PageHead title={TITLE} sub={sub} />
        <Card>
          <p>
            投稿がまだ収集されていません。<Link href="/jobs">収集ログ</Link>
          </p>
        </Card>
      </main>
    );
  }

  const first = (page - 1) * PAGE_SIZE + 1;
  const last = first + data.items.length - 1;

  return (
    <main className="main stack">
      <PageHead
        title={TITLE}
        sub={sub}
        tools={
          <a className="btn btn--ghost" href={csvHref}>
            CSV
          </a>
        }
      />
      <div className="toolbar">
        <div className="tools">
          <ErSwitch er={er} query={query} />
        </div>
      </div>
      {data.items.length === 0 ? (
        <Card>
          <p>
            このページには投稿がありません。<Link href={buildHref("/media", query)}>1 ページ目へ</Link>
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <div className="only-d">
              <MediaTable items={data.items} baseline={data.baseline} sort={sort} order={order} er={er} query={query} />
            </div>
            <MediaCards items={data.items} er={er} />
          </Card>
          {data.pageCount > 1 && (
            <div>
              <Pager page={page} pageCount={data.pageCount} path="/media" query={query} />
              <p className="small muted text-center">
                {formatCount(first)}〜{formatCount(last)} 件目（全 {formatCount(data.total)} 件）
              </p>
            </div>
          )}
        </>
      )}
    </main>
  );
}

import Link from "next/link";
import { elapsedLabel, EMPTY, formatJst, isInstagramPermalink, metricCell, PAGE_SIZE, parsePage } from "@/lib/format";
import { getMediaPage } from "@/lib/queries/media";

const METRICS = [
  ["views", "views"],
  ["reach", "reach"],
  ["likes", "likes"],
  ["comments", "comments"],
  ["saved", "saved"],
  ["shares", "shares"],
] as const;

const TH = "whitespace-nowrap px-3 py-2 text-left font-medium text-neutral-600";
const TD = "whitespace-nowrap px-3 py-2 align-top";

export default async function MediaPage(props: PageProps<"/media">) {
  const { page: pageParam } = await props.searchParams;
  const page = parsePage(pageParam);
  const result = await getMediaPage(page);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <h1 className="text-2xl font-bold">投稿一覧</h1>
      <p className="mt-1 text-sm text-neutral-500">
        フィードとリール（ストーリーズは含まない）。投稿日時の新しい順に {PAGE_SIZE} 件ずつ。指標は最新のスナップショット。
      </p>

      {!result.ok ? (
        <p className="mt-6 rounded border border-red-400 bg-red-50 p-3 text-sm text-red-900">
          読み出せません（{result.reason}）。
        </p>
      ) : result.data.items.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          {page === 1 ? "投稿がまだ収集されていません。" : "このページには投稿がありません。"}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded border border-neutral-200">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th className={TH}>サムネイル</th>
                <th className={TH}>種類</th>
                <th className={TH}>投稿日時（JST）</th>
                {METRICS.map(([key, label]) => (
                  <th key={key} className={`${TH} text-right`}>
                    {label}
                  </th>
                ))}
                <th className={TH}>指標の取得</th>
                <th className={TH}>消えた</th>
                <th className={TH}>リンク</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {result.data.items.map((m) => (
                <tr key={m.id}>
                  <td className={TD}>
                    {m.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 非公開バケットの署名付き URL（?token= 付き、ローカルは 127.0.0.1）なので next/image を使わない（設計 1.4 章）
                      <img
                        src={m.thumbnail_url}
                        width={96}
                        height={96}
                        loading="lazy"
                        alt=""
                        className="h-24 w-24 rounded object-cover"
                      />
                    ) : (
                      <span className="inline-flex h-24 w-24 items-center justify-center rounded bg-neutral-100 text-xs text-neutral-500">
                        {m.media_product_type}
                      </span>
                    )}
                  </td>
                  <td className={TD}>
                    <div>{m.media_product_type}</div>
                    <div className="text-xs text-neutral-500">{m.media_type}</div>
                  </td>
                  <td className={TD}>{formatJst(m.posted_at)}</td>
                  {METRICS.map(([key]) => (
                    <td key={key} className={`${TD} text-right`}>
                      {metricCell(m.metrics, key)}
                    </td>
                  ))}
                  <td className={TD}>
                    <div>{formatJst(m.metrics_fetched_at)}</div>
                    <div className="text-xs text-neutral-500">{elapsedLabel(m.elapsed_seconds)}</div>
                  </td>
                  <td className={TD}>{m.gone_at ? formatJst(m.gone_at) : EMPTY}</td>
                  <td className={TD}>
                    {isInstagramPermalink(m.permalink) ? (
                      <a
                        href={m.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-700 hover:underline"
                      >
                        Instagram で開く
                      </a>
                    ) : (
                      EMPTY
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.ok && (
        <nav aria-label="ページ" className="mt-4 flex items-center gap-4 text-sm">
          {page > 1 ? (
            <Link href={page === 2 ? "/media" : `/media?page=${page - 1}`} className="text-blue-700 hover:underline">
              前のページ
            </Link>
          ) : (
            <span className="text-neutral-400">前のページ</span>
          )}
          <span className="text-neutral-500">ページ {page}</span>
          {result.data.hasNext ? (
            <Link href={`/media?page=${page + 1}`} className="text-blue-700 hover:underline">
              次のページ
            </Link>
          ) : (
            <span className="text-neutral-400">次のページ</span>
          )}
        </nav>
      )}
    </main>
  );
}

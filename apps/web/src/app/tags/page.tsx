/**
 * タグ分析（`/tags`。R5 設計 6.1 節、F-UI-31、F-UI-32）。
 *
 * - 期間は過去 1 年間（365 日）の固定。対象はストーリーズを除く投稿。値は各投稿の最新の値（リーチ率だけ 7 日時点）
 * - 選択は `axis`（軸の id）、`kind`、`m`。不正な値は既定に戻す（`lib/params`。T12）。データの状況で既定を変えない
 * - 計算はサーバーで行い（`buildTagsView`）、数値だけを描画に渡す
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { ChoiceChips } from "@/components/ChoiceChips";
import { PageHead } from "@/components/PageHead";
import { lastUpdatedLabel } from "@/lib/format";
import { KIND_FILTERS, parseKindFilter, parseSelectedAxis, parseTagMetric, TAG_METRICS } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getHashtagStats, getTagAnalysis, getTagAxes } from "@/lib/queries/tags";
import {
  buildTagsView,
  KIND_FILTER_LABEL,
  optionLabel,
  sortByOrder,
  TAG_METRIC_LABEL,
  tagsHref,
  type TagsParams,
} from "@/lib/tags";
import { HashtagCard, KindCompareCard, NoAxisCard, TagCompareCard } from "./_tags/cards";

const TITLE = "タグ分析";

function EditLink() {
  return <Link href="/tags/edit">タグを編集</Link>;
}

function Failed({ reason }: { reason: string }) {
  return (
    <main className="main">
      <PageHead title={TITLE} tools={<EditLink />} />
      <Card>
        <Callout state="bad">読み出せません（{reason}）</Callout>
      </Card>
    </main>
  );
}

export default async function TagsPage(props: PageProps<"/tags">) {
  const sp = await props.searchParams;

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
  const accountId = account.data.id;

  const axesResult = await getTagAxes(accountId);
  if (!axesResult.ok) return <Failed reason={axesResult.reason} />;
  const axes = sortByOrder(axesResult.data);
  const axisIds = axes.map((a) => a.id);
  const firstAxisId = axisIds[0];

  const params: TagsParams = {
    axis: parseSelectedAxis(sp.axis, axisIds),
    kind: parseKindFilter(sp.kind),
    m: parseTagMetric(sp.m),
  };
  const axis = axes.find((a) => a.id === params.axis);

  const [analysis, hashtags] = await Promise.all([
    getTagAnalysis(accountId, params.axis ?? null),
    getHashtagStats(accountId),
  ]);
  if (!analysis.ok) return <Failed reason={analysis.reason} />;
  if (!hashtags.ok) return <Failed reason={hashtags.reason} />;

  const { rows, values, last_fetched_at } = analysis.data;
  if (rows.length === 0) {
    return (
      <main className="main">
        <PageHead title={TITLE} sub={`投稿 0 件（過去 1 年間）・${lastUpdatedLabel(last_fetched_at)}`} tools={<EditLink />} />
        <Card>
          <p>まだ投稿がありません</p>
        </Card>
      </main>
    );
  }

  const view = buildTagsView(rows, values, hashtags.data, params.kind, params.m);
  const tagged = axis ? `・タグ付き ${view.tagged} 件` : "";

  return (
    <main className="main main--wide stack">
      <PageHead
        title={TITLE}
        sub={`投稿 ${view.total} 件（過去 1 年間）${tagged}・${lastUpdatedLabel(last_fetched_at)}`}
        tools={<EditLink />}
      />
      <div className="stack">
        {axes.length > 0 && (
          <ChoiceChips
            label="タグの軸"
            current={params.axis ?? ""}
            options={axes.map((a) => ({ value: a.id, label: a.name, href: tagsHref(params, firstAxisId, { axis: a.id }) }))}
          />
        )}
        <ChoiceChips
          label="種類"
          current={params.kind}
          options={KIND_FILTERS.map((k) => ({
            value: k,
            label: optionLabel(KIND_FILTER_LABEL[k], view.kindCounts[k]),
            href: tagsHref(params, firstAxisId, { kind: k }),
          }))}
        />
        <ChoiceChips
          label="比べる指標"
          current={params.m}
          options={TAG_METRICS.map((m) => ({
            value: m,
            label: optionLabel(TAG_METRIC_LABEL[m], view.metricCounts[m]),
            href: tagsHref(params, firstAxisId, { m }),
          }))}
        />
      </div>
      <div className="grid">
        {axis ? (
          <TagCompareCard axisName={axis.name} rows={view.tagRows} m={params.m} overall={view.overall} />
        ) : (
          <NoAxisCard />
        )}
        <KindCompareCard rows={view.kindRows} />
        <HashtagCard table={view.hashtags} m={params.m} />
      </div>
    </main>
  );
}

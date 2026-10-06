/**
 * リール分析（`/reels`。R4 設計 6.2 節、見本 `render.js` の `S.reels` から文字の要因を除いたもの）。
 *
 * - 期間は過去 1 年間（365 日）の固定で、選択は置かない。対象はリールだけ
 * - 目的変数は選べる（リーチ率、リーチ数、閲覧数。文言に件数。既定はリーチ率。データの状況で自動では変えない）
 * - クエリ `y`、`sort`、`dir` は `lib/reels.ts` で検査し、不正な値は既定に戻す。並べ替えのたびにページ全体を計算し直す
 * - 計算はサーバーで行い（`buildReelsView`）、数値だけを描画に渡す
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { MetricHint } from "@/components/MetricHint";
import { PageHead } from "@/components/PageHead";
import { PendingMark } from "@/components/PendingMark";
import { buildHref, type Query } from "@/components/href";
import { lastUpdatedLabel } from "@/lib/format";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { signWithSession } from "@/lib/queries/media";
import { getReels } from "@/lib/queries/reels";
import {
  buildReelsView,
  objectiveOptionLabel,
  OBJECTIVES,
  parseReelsParams,
  reelsQuery,
  sortReels,
  type Objective,
  type ReelsParams,
} from "@/lib/reels";
import {
  CorrelationCard,
  FactorScatterCard,
  GroupsCard,
  NoAnalysis,
  objectiveHint,
  ResponseScatterCard,
  TopBottomCard,
} from "./_reels/cards";
import { ReelTable } from "./_reels/ReelTable";

const TITLE = "リール分析";

/** 選択の見出しのヒント。何を選ぶのかを示す（見出しだけでは分からないと 2026-10-06 にユーザー） */
const OBJECTIVE_SELECT_HINT =
  "比べる指標 = 動画の長さや画面変化の回数などの要因と、どの指標の関係を見るか。要因との関係、上位と下位、散布図の縦軸、区分の棒は、ここで選んだ指標で計算する";

/** 目的変数の選択（投稿時刻の画面の指標の選択と同じ形。リンクで JS なしに動く）。`sort` と `dir` は保つ */
function ObjectiveChips({ params, counts }: { params: ReelsParams; counts: Record<Objective, number> }) {
  return (
    <nav className="chips" aria-label="比べる指標" style={{ alignItems: "center" }}>
      <span className="small muted">
        <MetricHint label="比べる指標" text={OBJECTIVE_SELECT_HINT} />
      </span>
      {OBJECTIVES.map((y) => (
        <Link
          key={y}
          className="chip"
          href={buildHref("/reels", reelsQuery({ ...params, y }))}
          aria-current={y === params.y ? "true" : undefined}
          title={objectiveHint(y)}
        >
          {objectiveOptionLabel(y, counts[y])}
          <PendingMark />
        </Link>
      ))}
    </nav>
  );
}

export default async function ReelsPage(props: PageProps<"/reels">) {
  const params = parseReelsParams(await props.searchParams);

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

  const result = await getReels(account.data.id);
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
  if (rows.length === 0) {
    return (
      <main className="main">
        <PageHead title={TITLE} sub={`リール 0 件（過去 1 年間）・${lastUpdatedLabel(last_fetched_at)}`} />
        <Card>
          <p>まだ投稿がありません</p>
        </Card>
      </main>
    );
  }

  const view = buildReelsView(rows, params.y);
  const query: Query = reelsQuery(params);
  const paths = Array.from(new Set(rows.flatMap((r) => (r.thumbnail_path ? [r.thumbnail_path] : []))));
  const urls = await signWithSession(paths);
  const analyzed = view.analyzedCount > 0;

  return (
    <main className="main main--wide stack">
      <PageHead
        title={TITLE}
        sub={`リール ${view.total} 件（過去 1 年間）・${lastUpdatedLabel(last_fetched_at)}`}
        tools={<ObjectiveChips params={params} counts={view.objectiveCounts} />}
      />
      <div className="grid">
        {analyzed ? (
          <>
            <CorrelationCard view={view} />
            <TopBottomCard view={view} urls={urls} />
            <FactorScatterCard view={view} />
          </>
        ) : (
          <NoAnalysis title="要因との関係" />
        )}
        <GroupsCard view={view} analyzed={analyzed} />
        <ResponseScatterCard view={view} />
        <Card title="リールの一覧" sub={`${view.total} 件`} className="col-12">
          <ReelTable rows={sortReels(rows, params.sort, params.dir)} urls={urls} sort={params.sort} dir={params.dir} query={query} />
        </Card>
      </div>
    </main>
  );
}

/**
 * オーディエンス（`/audience`。R5 設計 6.4 節）。見本はなく、概要の部品（横棒、折れ線、凡例）を組み合わせる。
 *
 * - フォロワーの属性: 最新の週の性別、年齢、国、都市の横棒と、週ごとの割合の推移
 * - 反応したユーザーの属性: `ok` の週が 1 つでもあるときだけ、同じ形の 4 枚を出す（F-UI-41）。なければ節ごと出さない
 * - timeframe は `this_month` だけ（確認事項 Q7）。選択は置かない
 * - 計算はサーバーの純関数（`buildAudienceView`）で行い、描画に数値だけを渡す
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { PageHead } from "@/components/PageHead";
import { AUDIENCE_TIMEFRAME, buildAudienceView, METRIC_LABEL, type AudienceMetric, type AudienceView } from "@/lib/audience";
import { lastUpdatedLabel } from "@/lib/format";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getAudience } from "@/lib/queries/audience";
import { BreakdownCardView, TrendCard } from "./_audience/cards";

const TITLE = "オーディエンス";

/** 節の見出し。「フォロワーの属性（記録 n 週）」と最新の週 */
function SectionHead({ id, metric, view }: { id: string; metric: AudienceMetric; view: AudienceView }) {
  return (
    <div className="page-head">
      <div>
        <h2 id={id}>
          {METRIC_LABEL[metric]}（記録 {view.weekCount} 週）
        </h2>
        {view.latestWeek && <div className="sub">最新の週 {view.latestWeek}（日本時間）</div>}
      </div>
    </div>
  );
}

/** 4 枚のカード（性別、年齢、国、都市） */
function BreakdownCards({ metric, view }: { metric: AudienceMetric; view: AudienceView }) {
  const week = view.latestWeek ?? "";
  return (
    <>
      {view.cards.map((card) => (
        <BreakdownCardView key={card.breakdown} card={card} week={week} metricLabel={METRIC_LABEL[metric]} />
      ))}
    </>
  );
}

export default async function AudiencePage() {
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

  const [follower, engaged] = await Promise.all([
    getAudience(account.data.id, "follower_demographics", AUDIENCE_TIMEFRAME),
    getAudience(account.data.id, "engaged_audience_demographics", AUDIENCE_TIMEFRAME),
  ]);
  if (!follower.ok || !engaged.ok) {
    const reason = !follower.ok ? follower.reason : !engaged.ok ? engaged.reason : "";
    return (
      <main className="main">
        <PageHead title={TITLE} />
        <Card>
          <Callout state="bad">読み出せません（{reason}）</Callout>
        </Card>
      </main>
    );
  }

  const fv = buildAudienceView(follower.data);
  const ev = buildAudienceView(engaged.data);
  const last = [fv.lastFetchedAt, ev.lastFetchedAt].reduce<Date | null>(
    (a, d) => (d !== null && (a === null || d.getTime() > a.getTime()) ? d : a),
    null,
  );

  return (
    <main className="main main--wide stack">
      <PageHead title={TITLE} sub={lastUpdatedLabel(last)} />
      <section aria-labelledby="audience-follower">
        <SectionHead id="audience-follower" metric="follower_demographics" view={fv} />
        {fv.latestWeek === null ? (
          <Card>
            <p className="small muted">
              まだ収集されていません。<Link href="/jobs">収集ログ</Link>
            </p>
          </Card>
        ) : (
          <div className="grid">
            <BreakdownCards metric="follower_demographics" view={fv} />
            <TrendCard
              weeks={fv.weeks}
              country={fv.country.series}
              latestWeek={fv.latestWeek}
              lastFetchedAt={fv.lastFetchedAt}
            />
          </div>
        )}
      </section>
      {ev.hasOk && (
        <section aria-labelledby="audience-engaged">
          <SectionHead id="audience-engaged" metric="engaged_audience_demographics" view={ev} />
          <div className="grid">
            <BreakdownCards metric="engaged_audience_demographics" view={ev} />
          </div>
        </section>
      )}
    </main>
  );
}

# R6 月次レポート、伸びた投稿の検出、低下の通知の設計

- 版: 0.1（2026-10-12）。確認事項 Q1〜Q16 は未決

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-12 | 起草（`nextjs-developer`。親が 2026-10-12 に確かめた事実票をもとにする） |

- 要件: `doc/requirements/requirements-definition.md` 4.7 章（F-RPT-01、F-RPT-02、F-RPT-10、F-RPT-11）、5.5 章（時刻）、7 章（指標の定義。7.1 のシェア率、非フォロワーリーチ比率、7.3 のフォロワー純増、7.4 の目安値）、8.7 章（AI-01: 伸びた投稿の検出は統計で行う）、9 章（画面一覧）と 9.1 章（月次レポートの 9 節）、10 章（R6 の完了条件「前月分の月次レポートを画面に表示できる。伸びた投稿の検出が動く」）
- 既存: R1 の表（`profile_daily`、`media_insight_snapshots`）、R2 の `web_app` ロールと `check-alerts`（`apps/worker/src/commands/check-alerts.ts`、`jobs/alerts.ts`）、R3 のビュー（`20261005000000_r3_analysis_views.sql` の `media_horizon_metrics`、`media_list_metrics`、`account_daily_wide`）、R5 の表とビュー（`20261009000000_r5_analysis.sql` の `tag_axes`、`tag_values`、`media_tags`、`story_list_metrics`）、Web の `lib/queries/period-summary.ts`、`lib/period.ts`、`app/_overview/OverviewKpis.tsx`、`lib/auth.ts`（`checkAccess(pathname)`）、`lib/request-guard.ts`（`isSameOriginPost`）、R5 設計 6.2 節（Server Action の形）
- デザイン: `doc/design-system.md`。design-lab v3 に月次レポートの見本はないので、既存の部品（`Card`、`Kpi`、`Delta`、`Callout`、`MetricHint`、`MissingValue`、`SortHeader`、`Thumb`、`TypeTag`、`ChoiceChips`、`components/charts/` の `LineChart`、`HBars`、`HStack`、`Strip`、`Pie`、`VBars`、`BandRow`）の組み合わせで案を書く（見た目は実装後にユーザーが確かめる）

この文書で「未確認」と書いたものは、起草時に確かめられなかった事実。実装の前に確かめる。外部の事実（Meta API、DB の中身）は、親が 2026-10-12 に確かめた事実票（付録 A）だけを根拠にした。Web ページは取っていない。

---

## 1. 目的と範囲

### 1.1 R6 でやること

| 区分 | 内容 | 要件 |
|---|---|---|
| DB | 伸びた投稿の判定のビュー `media_outlier_flags`（同じ種類の直前 20 投稿のシェア率の分布と比べる。窓関数と順序集合の集約で、ワーカーのジョブは足さない）。レポートの記入欄の表 `report_notes`（`web_app` から書く） | F-RPT-10、F-RPT-02 |
| ワーカー | `check-alerts --scope daily` に `non_follower_reach_drop`（非フォロワーリーチ比率の低下）と `follower_drop`（フォロワーの急減）を足す。届く経路は既存の GitHub の失敗メール | F-RPT-11 |
| 画面 | レポート `/report`（既定は前月。`?month=YYYY-MM`）。9.1 章の 9 節を既存の部品で組む。1 節（総評）と 9 節（翌月の施策）は利用者が書き、Server Action で保存する。投稿一覧と投稿詳細に「伸びた」「課題」の印を出す。ナビに「レポート」を足す | F-RPT-01、F-RPT-02、F-RPT-10 |

### 1.2 R6 でやらないこと

- **PDF などのファイル出力**（F-RPT-01 で作らないと決めている）。印刷はブラウザの印刷に任せ、印刷用の CSS も作らない
- **AI による総評の下書き**（要件 8.7.3 章。R7 以降）。R6 の総評は利用者が書く
- **目標値（目安値）の表と設定画面、2 節の「目標比」**（要件 9 章の「設定」と 7.4 章は未着手。Q4）。R6 は実績と前月比だけを出す
- **メール送信の API や Slack の導入**。通知は既存の GitHub の失敗メールだけ（`doc/design/r2-cloud.md` 5.3 節）
- **伸びた投稿のメール通知**（Q3。親の推奨は画面の印とレポートまで。失敗メールは異常の通知の経路なので、良い知らせには使わない）
- **投稿単位の非フォロワーリーチ比率による判定**。Meta のメディアのインサイトに内訳がない（事実票。R0 検証 2.4 節）。F-RPT-10 の投稿単位の判定はシェア率で行い、非フォロワーリーチ比率はアカウント日次指標で F-RPT-11 として見る
- **通知の履歴の表と重複の抑止**（Q8。既存の `token` と同じく、条件が続く間は毎日の失敗メールになる）
- **特殊な投稿（コラボ、お試し、ブースト）の除外の設定**（R3 の Q4、R5 の方針のまま作らない。判定の比較対象から外す規則は固定で持つ。3.6 節）
- **レポートの月の切り替え以外の絞り込み**（種類、タグの軸の選択など）。各節は固定の構成で出す
- **ストーリーズの伸びた投稿の判定**（`media_list_metrics` に入らない。比べる指標も違う）
- **`media_analysis_dataset` への列の追加**（R6 では使わない。事実票）

---

## 2. 既に済んでいるもの

| もの | 内容 |
|---|---|
| 投稿一覧の値 | `media_list_metrics`（1 投稿 1 行。ストーリーズを除く）。`share_rate`、`save_rate`、`reach_rate`、`elapsed_latest`、`is_collab`／`is_trial_reel`／`is_boosted`、`posted_date_jst`、`thumbnail_path` |
| 経過時間をそろえた値 | `media_horizon_metrics`（`horizon` と `within_tolerance`）。R6 の判定は `latest` どうしで比べる（R3 の決定）ので、区分は使わない |
| 日次指標 | `account_daily_wide`（太平洋時間の日付で 1 日 1 行。`reach`、`reach_follower`、`reach_non_follower`、`views_follower`、`views_non_follower`。行がない日は欠け、最新の日は `reach` が null のことがある） |
| フォロワー数 | `profile_daily`（`captured_on` は日本時間の日付、1 日 1 行、JST 05:30 ごろ） |
| ストーリーズ | `story_list_metrics`（`views`、`tap_exit`、`swipe_forward`、`exit_rate`、`story_day_jst`） |
| タグ | `tag_axes`、`tag_values`、`media_tags`。タグ別の比較のクエリは `lib/queries/tags.ts`（期間は「過去 N 日」。暦月で絞る引数があるかは未確認） |
| 期間集計 | `lib/queries/period-summary.ts`: `getDailyRange`、`getDailySeries`、`getDailyTotals`、`getFollowerSeries`、`getFollowerChange`、`getPostTotals`。どれも `(accountId, from, to)` の形で、暦月の `Period` をそのまま渡せる |
| 前期間比 | `lib/metrics.ts` の `deltaCount`（件数の増減率 %）、`deltaPoint`／`deltaRate`（率はポイント差 pt） |
| 月の計算 | `lib/period.ts` の `monthOf`、`previousMonth`、`sameMonthLastYear`、`presetPeriods("month", latest)`（最新の日を含む月の前月と、その前の月）、`clampPeriod`、`todayPacific`、`isStale` |
| 主要指標のタイル | `app/_overview/OverviewKpis.tsx`（`cur` と `prev` の `Period` を受けて 6 枚: リーチ、閲覧数、フォロワー純増、ER、保存率、フォロワー数。「30 日中 28 日分」の欠けの注記つき）。暦月を渡せばレポートの 2 節になる |
| 通知 | `evaluateAlerts(input, now, scope, simulate)`（純関数。`AlertAccount` は `ordinal/total` の連番）。`check-alerts.ts` の `loadAlertAccounts` が deps で DB を読む。該当があれば終了コード 1 → GitHub の失敗メール。ログは `WARN alert=<kind> account=1/N …`。履歴が足りなければ `reason=no_history` |
| 投稿詳細の比較 | 「同じ種類の中央値の何倍か」「同じ種類の中で上位何 %か」（R3 F-UI-22。比較対象は同じ種類の全投稿） |
| Web の権限と認可 | 表とビューは列挙して `grant`、表には操作ごとのポリシー。Web から書く表の手本は R5 のタグの表（列ごとの `grant update`、`using (true)` のポリシー、`set_updated_at()` のトリガー）。`checkAccess` には固定の経路、`isSameOriginPost`、SQL は `lib/queries/<name>.ts`、応答は `no-store` |

---

## 3. 伸びた投稿の検出（F-RPT-10）

### 3.1 方法

統計だけで判定する（AI-01）。投稿ごとに、**同じアカウント・同じ種類（`kind`）の直前 20 投稿**のシェア率の分布を取り、四分位で外れ値を判定する（Tukey の fence）。

| 項目 | 決定 |
|---|---|
| 指標 | **シェア率**（`share_rate` = シェア ÷ リーチ。最新の値）1 つに固定する。要件の「非フォロワーリーチ比率」は投稿単位では取れない（1.2 節）。保存率とリーチ率は印の根拠にしない（Q1） |
| 比較対象 | 同じアカウント、同じ `kind`、`posted_at` がその投稿より前の投稿を新しい順に 20 件（Q2）。シェア率が null の投稿（リーチが 0 か未取得）と特殊な投稿（3.6 節）は比較対象から除く。消えた投稿（`gone_at`）は除かない（最新の値が凍っているだけで、投稿としては本物） |
| 値 | 各投稿の最新の値どうし（R3 の決定）。経過日数で比べ方を切り替えず、画面に `elapsed_latest` を「経過 n 日」として出す |
| 統計量 | 比較対象の Q1、中央値、Q3、IQR = Q3 − Q1 |
| 印 | `share_rate > Q3 + 1.5 × IQR` → `high`（伸びた）。`share_rate < Q1 − 1.5 × IQR` → `low`（課題）。それ以外は印なし（Q5） |
| 判定しない | 比較対象が **8 件未満**（Q6）、またはその投稿のシェア率が null。印は null にし、比較対象の件数 `peer_n` は常に出す |

- 率は 0 以上なので、下の fence が負になる種類（IQR が広い）では `low` はほぼ付かない。これは意図した性質で、「課題」の印は「明らかに低い」ときだけに出る。Q5 で 1.5 を変えるときは上下で同じ値にする（片側だけ緩めない）
- 比較対象が 20 件に満たないが 8 件以上ある投稿（運用の初期や、カルーセルのように少ない種類）は、ある分だけで判定する。「20 件中 n 件」ではなく「比較 n 件」とだけ出す
- 窓を「直前 20 投稿」にする理由: 要件の例示に合わせ、投稿の頻度が変わっても比較の数が一定になる。「過去 90 日」にすると頻度で件数が揺れる

### 3.2 SQL の案（ビュー `media_outlier_flags`）

判定はビューで行い、ワーカーのジョブを足さない。理由: (1) 入力は `media_list_metrics` にそろっていて、計算は 1 文の SQL で書ける、(2) スナップショットが更新されるたびに値が変わるので、保存すると更新の仕組みが要る、(3) 画面（投稿一覧、投稿詳細、レポート）が `left join` するだけで済む。

```sql
create view public.media_outlier_flags
with (security_invoker = true) as
select
  m.media_id,
  m.account_id,
  m.kind,
  m.posted_at,
  m.share_rate,
  m.elapsed_latest,
  p.n as peer_n,
  p.q1 as peer_q1,
  p.median as peer_median,
  p.q3 as peer_q3,
  (p.q3 - p.q1) as peer_iqr,
  p.q3 + 1.5 * (p.q3 - p.q1) as peer_upper,
  p.q1 - 1.5 * (p.q3 - p.q1) as peer_lower,
  case
    when m.share_rate is null or p.n < 8 then null
    when m.share_rate > p.q3 + 1.5 * (p.q3 - p.q1) then 'high'
    when m.share_rate < p.q1 - 1.5 * (p.q3 - p.q1) then 'low'
  end as share_flag
from public.media_list_metrics m
cross join lateral (
  select
    count(*)::int as n,
    percentile_cont(0.25) within group (order by r.share_rate) as q1,
    percentile_cont(0.5)  within group (order by r.share_rate) as median,
    percentile_cont(0.75) within group (order by r.share_rate) as q3
  from (
    select s.share_rate
    from public.media_list_metrics s
    where s.account_id = m.account_id
      and s.kind = m.kind
      and s.posted_at < m.posted_at
      and s.share_rate is not null
      and not s.is_boosted and not s.is_collab and not s.is_trial_reel
    order by s.posted_at desc, s.media_id desc
    limit 20
  ) r
) p;
```

- `percentile_cont` は順序集合の集約で**窓関数としては使えない**（`over` が付かない）。そのため `rows between 20 preceding and 1 preceding` の窓ではなく、`lateral` の副問い合わせで 20 件を切ってから集約する。これが「ビューでは難しい点」の 1 つ目
- 2 つ目は性能。`media_list_metrics` 自体が `media_horizon_metrics` を 2 回結合するビューなので、投稿 N 件 × 比較 20 件の形は N が数百件なら許容の見込みだが、未計測。遅ければ、(a) `with base as (select … from media_list_metrics)` で 1 回だけ読み、`array_agg(share_rate) over (partition by account_id, kind order by posted_at rows between 20 preceding and 1 preceding)` で配列を作り、`unnest` した配列に `percentile_cont` を当てる形（1 パス）に変える。列は同じにしておき、作り直しで済むようにする。結合テストで 300 件の fixture の実行時間を測る（7.1）
- 1.5 と 8 はビューの本文の定数。Q5／Q6 で変えたら `create or replace view` で作り直す（列は変わらない）。設定の表には持たない（1.2 節）
- `posted_at` が同じ投稿（カルーセルの同時投稿など）は `media_id desc` で順を固定する。自分自身は `posted_at <` で外れるが、同時刻の別の投稿は比較対象に入る（意図どおり。同じ時刻でも別の投稿）

### 3.3 印の出し先

| 場所 | 出し方 |
|---|---|
| 投稿一覧 `/media` | `lib/queries/media.ts` の一覧の SQL に `left join public.media_outlier_flags f using (media_id)` を足し、`share_flag` と `peer_n` を返す。行の種類（`TypeTag`）の横に印（6.3 節） |
| 投稿詳細 `/media/[id]` | 既存の「同じ種類との比較」のカードに 1 行足す: 「直前の同種 n 件のシェア率: 中央値 x% ・ Q1 y% ・ Q3 z% ・ 判定: 伸びた／課題／なし ・ 経過 d 日」（6.3 節） |
| レポート 6 節 | その月の投稿を `media_outlier_flags` と結合し、印を表に出す（6.1 節） |

### 3.4 型（Web）

```ts
export type ShareFlag = "high" | "low";

export interface OutlierFlag {
  media_id: string;
  share_rate: number | null;
  elapsed_latest: number | null;   // 秒。画面で日に直す
  peer_n: number;
  peer_q1: number | null;
  peer_median: number | null;
  peer_q3: number | null;
  share_flag: ShareFlag | null;    // peer_n < 8 か share_rate が null なら null
}
```

### 3.5 「自動で知らせる」の範囲

R6 は**画面の印とレポートの 6 節まで**（Q3）。メールは送らない。理由: 届く経路が GitHub の失敗メール（`check-alerts` の終了コード 1）しかなく、これは収集の異常を知らせる経路なので、良い知らせを混ぜると「失敗メール＝異常」の意味が崩れる。メールで知らせたくなったら、送信の経路（R7 以降）と一緒に決める。

### 3.6 特殊な投稿の扱い

| 投稿 | 比較対象に入れるか | 自分の判定 | 理由 |
|---|---|---|---|
| ブースト（`is_boosted`） | 入れない | する（印は付きうる） | 広告でリーチが伸びるので、比較対象に入れると分布がずれる。自分の判定はするが、画面では既存の `TypeTag`（ブースト）が横に並ぶので、見た人が割り引ける |
| コラボ（`is_collab`） | 入れない | する | 相手のフォロワーにも届くので、リーチとシェアの比が普段と違う |
| お試しリール（`is_trial_reel`） | 入れない | する | 非フォロワーにだけ出るので、シェア率の分布が違う |
| 消えた投稿（`gone_at`） | 入れる | する | 最新の値が凍っているだけ |

- 「自分の判定はする」のは、データの状況で判定の有無を切り替えないため（R3 の決定）。除外は比較対象の側だけで、規則として固定する。Q7

---

## 4. 低下の通知（F-RPT-11）

### 4.1 判定の式

`check-alerts --scope daily` に 2 種類を足す。どちらも純関数 `evaluateAlerts` で判定し、DB の読み出しは `check-alerts.ts` の `loadAlertAccounts` に足す（4.3 節）。

| 種類 | 入力 | 条件 | 判定しない（`noHistory`） |
|---|---|---|---|
| `non_follower_reach_drop` | `account_daily_wide`。`latest` = `reach` のある最新の日（`getDailyRange` と同じ規則）。**直近** = `latest − 6` 〜 `latest` の 7 日。**基準** = `latest − 34` 〜 `latest − 7` の 28 日。それぞれ `reach` と `reach_non_follower` がともにある日だけで Σ非フォロワーリーチ ÷ Σリーチ（`getDailyTotals.nonFollowerReachRate` と同じ式） | `基準の比率 − 直近の比率 ≥ 10 pt`（Q9） | 直近の使えた日数が 5 日未満、または基準の使えた日数が 20 日未満（Q10）。欠けた日は補間しない（合計から外れるだけ） |
| `follower_drop` | `profile_daily`。`followers_count` が null でない最新の記録 `latest` と、その**前日**（`captured_on = latest.captured_on − 1`）の記録 `previous` | `previous − latest ≥ 10 人` **かつ** `(previous − latest) ÷ previous ≥ 1%`（Q11） | `previous` の記録がない（前日が欠けている）。2 日前の記録で代用しない |

- 非フォロワーリーチ比率を「直近 7 日 vs その前 28 日」にする理由: 1 日の値は投稿の有無で大きく揺れるので、7 日の合計ベースで平らにする。基準を 28 日にするのは、月の中の波（投稿の多い週と少ない週）をならすため
- 条件を「pt 差」にする理由: 比率の相対の減り方（半減など）だと、もともと低い（10% 前後の）アカウントで 5 pt の揺れが「半減」になり、鳴りすぎる。pt 差は値の大きさによらず同じ意味になる。代案は Q9
- `follower_drop` を「人数かつ率」にする理由: 人数だけだと大きなアカウントで日常の揺れが引っかかり、率だけだと小さなアカウントで 1〜2 人の減りが引っかかる。両方を満たしたときだけ鳴らす（親の案の「または」より狭い。Q11）
- `follower_drop` は前日比だけで、7 日比や 30 日比は作らない（「急減」の検出。緩やかな減少は画面の 3 節で見る）
- 同じ事象で毎日メールが来ること: `non_follower_reach_drop` は窓が 7 日なので、条件が続けば最長で 7 日（基準が入れ替わるまで）、毎日の daily で終了コード 1 になり、1 日 1 通の失敗メールが続く。`follower_drop` は前日比なので、減り続けない限り 1 回で止む。R6 では**抑止しない**（既存の `token` も期限が切れるまで毎日鳴る。通知の履歴の表を作る案は Q8）

### 4.2 `evaluateAlerts` への足し方

```ts
// jobs/alerts.ts に足す
export interface RatioWindow {
  /** Σ非フォロワーリーチ */
  numerator: number;
  /** Σリーチ */
  denominator: number;
  /** 使えた日数（両方の値がある日） */
  days: number;
}

export interface AlertAccount {
  // …既存の項目…
  /** 非フォロワーリーチ比率の直近 7 日と基準 28 日。daily だけ読む。読んでいなければ判定しない */
  nonFollowerReach?: { recent: RatioWindow; base: RatioWindow };
  /** フォロワー数の最新と前日。previous が null なら判定しない */
  followers?: { latest: { count: number }; previous: { count: number } | null };
}

export type Alert =
  | /* 既存 */
  | { kind: "non_follower_reach_drop"; ordinal: number; total: number; recentPt: number; basePt: number; recentDays: number; baseDays: number }
  | { kind: "follower_drop"; ordinal: number; total: number; dropRate: number };

/** しきい値（Q9〜Q11） */
export const NON_FOLLOWER_REACH_DROP_PT = 10;
export const NON_FOLLOWER_REACH_RECENT_DAYS = 7;
export const NON_FOLLOWER_REACH_BASE_DAYS = 28;
export const NON_FOLLOWER_REACH_MIN_RECENT_DAYS = 5;
export const NON_FOLLOWER_REACH_MIN_BASE_DAYS = 20;
export const FOLLOWER_DROP_MIN_COUNT = 10;
export const FOLLOWER_DROP_MIN_RATE = 0.01;
```

- `evaluateAlerts` の `scope === "daily"` の分岐に `evaluateNonFollowerReachDrop(account, total)` と `evaluateFollowerDrop(account, total)` を足す。入力が省略されていれば `undefined`（判定しない）。履歴が足りなければ `noHistory = true`（既存の `stories` と同じ 1 つの真偽値を共有する。`reason=no_history` の意味は「どれかの判定を履歴不足で見送った」に広がる）
- 比率は 0〜1 の数で受け、pt は `(base − recent) × 100` で計算する。分母が 0 の窓は「使えた日数 0」と同じ扱い（判定しない）
- `Alert` の値に**フォロワーの人数（絶対数）を持たせない**。ログは GitHub Actions に出るため（公開リポジトリ。NF-SEC-06）。`follower_drop` は `dropRate`（率）だけ、`non_follower_reach_drop` は pt と日数だけを持つ

### 4.3 DB の読み出し

新しいファイル `apps/worker/src/db/alert-signals.ts` に 2 関数を置く（既存の `account-daily.ts` と `profile.ts` は書き込みの関数の置き場所なので触らず、並列の作業で衝突しないようにする）。

| 関数 | 読む先 | 返す |
|---|---|---|
| `readNonFollowerReachWindows(db, accountId)` | `public.account_daily_wide`（`reach` のある最新の日を基点に 35 日分） | `{ recent: RatioWindow; base: RatioWindow }`。日次指標が 1 日もなければ `undefined` |
| `readFollowerPair(db, accountId)` | `public.profile_daily`（`followers_count is not null` の最新 1 件と、その前日の 1 件） | `{ latest, previous }`。記録がなければ `undefined` |

- **未確認**: ワーカーの DB ロールが `account_daily_wide`（`security_invoker` のビュー）を読めるか。ワーカーは基の表の所有者側のロールで動いている見込みだが、権限は読んでいない。読めなければマイグレーションで `grant select on public.account_daily_wide to <ワーカーのロール>` を足す。基の表 `account_daily_metrics` を直接集計する案は、内訳の 0／null の規則（R3）を 2 か所に持つことになるので採らない
- `loadAlertAccounts` は `scope === "daily"` のときだけ 2 つを読む（`monthlyOcrUsage` と同じ形）。接続は 2 本なので順に読む

### 4.4 ログの形

```
WARN alert=non_follower_reach_drop account=1/1 recent_pt=23.4 base_pt=41.0 days=7/28
WARN alert=follower_drop account=1/1 drop_rate=1.8
INFO command=check-alerts scope=daily accounts=1 alerts=2
```

- `alertFields` に 2 つの `case` を足す。小数は 1 桁に丸める。アカウントの ID、ユーザー名、フォロワーの人数、リーチの人数は出さない
- daily は JST 05:17 ごろに動くので、その時点の最新の日次指標（太平洋時間の前日まで）とその朝の `profile_daily` で判定する。`profile_daily` が JST 05:30 ごろに書かれるなら、`check-alerts` の時点では**前日の朝の記録が最新**で、判定は 1 日遅れる。実害はないが、`collect.yml` の順（`run-daily` の後に `check-alerts`）で同じ回の記録が使えるかは**未確認**（Q12）

### 4.5 テスト（ワーカー）

- `apps/worker/test/alerts.test.ts`: 境目（10.0 pt ちょうどは鳴る、9.9 は鳴らない。10 人かつ 1% の両方、片方だけ、前日なし）、入力の省略で判定しない、`noHistory` が立つ、hourly では判定しない、`simulate` との併存、入力を変更しない
- `apps/worker/test/check-alerts.test.ts`: `alertFields` の形（人数を含まない）、daily で 2 つを読む、hourly で読まない
- `apps/worker/test/db/alert-signals.test.ts`（新規）: 最新の日の `reach` が null の行を基点にしない、35 日の境目、欠けた日、内訳が null の日は分母にも入らない、前日の欠け、`followers_count` が null の記録を飛ばす、2 アカウントのデータを分ける

---

## 5. DB

マイグレーション `supabase/migrations/20261013000000_r6_report.sql`（日付は実装の日に合わせる）。手書き。構成は R5 と同じ（前置き、表、ビュー、権限と RLS、ロールバックのコメント）。

### 5.1 表 `report_notes`（記入欄）

```sql
create table public.report_notes (
  account_id uuid not null references public.accounts (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),   -- 月の 1 日
  summary text not null default ''
    check (char_length(summary) <= 2000 and summary !~ '[^[:print:]\n]'),   -- 総評（1 節）
  next_plan text not null default ''
    check (char_length(next_plan) <= 2000 and next_plan !~ '[^[:print:]\n]'), -- 翌月の施策（9 節）
  updated_at timestamptz not null default now(),
  primary key (account_id, month)
);

comment on table public.report_notes is
  '月次レポートの記入欄（総評と翌月の施策）。月は 1 日の日付。アカウントごと月ごとに 1 行。Web（web_app）が upsert する';

create trigger report_notes_set_updated_at before update on public.report_notes
  for each row execute function public.set_updated_at();
```

- 月の列は `date`（1 日固定）にする。`text` の `YYYY-MM` より並べ替えと範囲の比較が素直
- 文字数の上限 2,000（Q13）。`char_length` はコードポイント。改行は許し、ほかの制御文字は拒む（R5 の名前の check と同じ考え。`[[:print:]]` に全角文字が入ることは**未確認**。DB の結合テストで日本語と絵文字が通ることを確かめ、通らなければ `!~ '[[:cntrl:]]'` に改行の例外を足す形に変える）
- 履歴（版）は持たない。上書きだけ（R5 のタグと同じ。最後に変えた時刻だけ）
- 索引は主キーだけ（アカウント × 月で引く）

### 5.2 ビュー `media_outlier_flags`

3.2 節の SQL。`comment on view` に「比較対象は同じ種類の直前 20 投稿（特殊な投稿とシェア率 null を除く）。fence は 1.5 × IQR。8 件未満は判定しない」を書き、定数を変えたら comment も直す。

### 5.3 権限と RLS

```sql
alter table public.report_notes enable row level security;
revoke all on table public.report_notes, public.media_outlier_flags from public, anon, authenticated;

grant select, insert on table public.report_notes to web_app;
grant update (summary, next_plan) on table public.report_notes to web_app;   -- updated_at はトリガー、month と account_id は変えない

create policy web_app_select on public.report_notes for select to web_app using (true);
create policy web_app_insert on public.report_notes for insert to web_app with check (true);
create policy web_app_update on public.report_notes for update to web_app using (true) with check (true);
-- delete は与えない（画面に消す操作がない。空にするのは update）

grant select on table public.media_outlier_flags to web_app;   -- security_invoker。基の表の select は R3 で済み
```

- ポリシーが `using (true)` なのは R2／R5 と同じ考え（誰が使えるかは `checkAccess`、対象のアカウントは SQL の `account_id` で絞る）
- `on conflict do update` の upsert には `insert` と `update` の両方の権限が要る（列の `update` で足りることは結合テストで確かめる）

### 5.4 ロールバック（コメント）

```sql
-- 先に Web を R6 より前の版に戻す
-- drop view if exists public.media_outlier_flags;
-- drop table if exists public.report_notes;   -- 利用者が書いた総評と施策も消える
-- delete from supabase_migrations.schema_migrations where version = '20261013000000';
```

---

## 6. 画面

| 画面 | URL | 種類 | 要件 |
|---|---|---|---|
| レポート | `/report`、`/report?month=YYYY-MM` | ページと Server Action | F-RPT-01、F-RPT-02、F-RPT-10（6 節） |
| 投稿一覧（変更） | `/media` | ページ | F-RPT-10（印） |
| 投稿詳細（変更） | `/media/[id]` | ページ | F-RPT-10（印と分布） |

- `checkAccess` はページと Server Action の中で呼ぶ（proxy は変えない。R5 4 章）。応答は `Cache-Control: private, no-store`
- 月の選び方: `?month=YYYY-MM`。検査は `^\d{4}-(0[1-9]|1[0-2])$` で、不正なら既定（R3 4.7 節「不正なら既定に戻す」）。**既定は `presetPeriods("month", latest).a`**（日次指標の最新の日を含む月の前月。期間比較の `month` と同じ）。選べる月は `getDailyRange().start` の月から最新の日を含む月まで（今月は途中までの値で、タイルの「31 日中 11 日分」の既存の注記が出る。Q14）。範囲の外の月は既定に戻す
- 月の境目: **投稿単位の節（5、6、7、8 の投稿分）は `posted_date_jst` の暦月、日次指標の節（2、4）は `metric_date`（太平洋時間）の暦月、フォロワー数（2、3）は `captured_on`（日本時間）の暦月**。ページの見出しの下に既存の注記の形で「日次指標の日付は米国太平洋時間の区切り、投稿は日本時間の投稿日」と 1 行出す（概要と同じ文言を使い、新しい説明文を足さない）

### 6.1 レポート `/report` の構成

9.1 章の 9 節を上から順にカード（`Card`）で並べる。節の番号と見出しは 9.1 章の文言のまま。

| 節 | 内容 | 使う関数・ビュー | 新しく要るもの | 部品 |
|---|---|---|---|---|
| 1 総評 | 利用者の記入（結果、課題、翌月の方針を 3 行）。保存は 9 節と同じフォーム | `getReportNotes(accountId, month)` | `lib/queries/report-notes.ts` | `<textarea>`（6.2 節） |
| 2 主要指標のサマリー | リーチ、閲覧数、フォロワー純増、ER、保存率、フォロワー数の 6 枚。前月比つき。**目標比は出さない**（Q4） | `OverviewKpis({ accountId, cur: month, prev: previousMonth(month.from) })` をそのまま使う | なし（`app/_overview/OverviewKpis.tsx` を `/report` から import できる場所に置くか、そのまま import するかは実装で決める。**未確認**: `_overview` 配下の部品をほかの経路から import している例があるか） | `Kpi`、`Delta` |
| 3 フォロワー数の推移 | 月内の日ごとのフォロワー数の折れ線。月初と月末の値、純増 | `getFollowerSeries(accountId, from, to)`、`getFollowerChange` | なし | `LineChart` |
| 4 リーチと閲覧数の推移 | 日ごとのリーチ（フォロワー／非フォロワーの 2 本）と閲覧数（同 2 本）。月の合計と非フォロワーリーチ比率（前月比 pt） | `getDailySeries`、`getDailyTotals`（当月と前月） | なし（概要の日次推移の描き方を流用。**未確認**: 概要の日次推移の部品が内訳の 2 本を描けるか。描けなければ `LineChart` に 2 系列を渡す） | `LineChart`、`Kpi` |
| 5 投稿の種類ごとのまとめ | フィード、カルーセル、リール、ストーリーズの 4 行。列は件数、Σリーチ（ストーリーズは Σ閲覧数）、ER、保存率、シェア率（Σの比）、プロフィール訪問（リールは `MissingValue`）、ストーリーズは離脱率 | `getPostTotals`（件数、Σリーチ、Σ保存は `byKind` にある）。種類ごとの率は足りない | `getKindSummary(accountId, from, to)`（`media_list_metrics` を `kind` で group by。率は Σの比、分子と分母がそろう投稿だけ）、`getStorySummary(accountId, from, to)`（`story_list_metrics` を `story_day_jst` の月で絞り、件数、Σ閲覧、Σ離脱、離脱率） | 表（`SortHeader` なしの固定の順）、`TypeTag` |
| 6 よかった投稿 3 件、課題のある投稿 3 件 | その月の投稿（ストーリーズを除く）を**シェア率の高い順に 3 件、低い順に 3 件**。列はサムネイル、題名、種類、投稿日、経過日数、リーチ、シェア率、印（`high`／`low`）、比較 n 件。シェア率が null の投稿は末尾に回し、3 件に入れない。印は順位の根拠ではなく添え物（印がない月もある。月の投稿が 6 件未満なら重なる投稿は出さず、ある分だけ） | `media_list_metrics` ⋈ `media_outlier_flags` | `getMonthHighlights(accountId, from, to)` | 表、`Thumb`、`TypeTag`、印（6.3 節） |
| 7 タグ別の比較 | 軸ごとに値 × 件数 × 中央値（リーチ率、シェア率）。「タグなし」の行を含む（R5 Q4） | `lib/queries/tags.ts` の比較の関数 | **未確認**: 既存の関数の期間が「過去 N 日」（`now()` 基点）で、暦月の `from`／`to` を受けられるか。受けられなければ、同じ SQL を `posted_date_jst between` に置き換えた `getTagMonthly(accountId, from, to)` を `lib/queries/report.ts` に書く（軸が 0 件なら節を空の表示にし、タグの編集へのリンクだけ） | 表 |
| 8 ファネルの転換率 | 3 本の横棒を 2 組。**投稿**（フィードとカルーセル。リールはプロフィール訪問が API にない）: Σリーチ → Σプロフィール訪問 → Σフォロー（3 つがそろう投稿だけ。転換率は各段 ÷ 前段）。**ストーリーズ**: Σ閲覧数 → Σ離脱（tap_exit）と Σ次へ（swipe_forward）（率は ÷ Σ閲覧数） | `media_list_metrics`、`story_list_metrics` | `getMonthFunnel(accountId, from, to)` | `HBars`（各段の値と率の数値ラベル） |
| 9 翌月の施策 | 利用者の記入。1 節と同じフォームで保存 | `getReportNotes` | （1 節と同じ） | `<textarea>` |

- 新しいクエリは `lib/queries/report.ts`（読み出し）と `lib/queries/report-notes.ts`（記入欄の読み書き）に置き、計算は `lib/report.ts`（純関数: 月の検査、選べる月の列挙、ファネルの率、上位と下位の 3 件の選び方）に置く。`getKindSummary` などの型は `period-summary.ts` の `RatioOfSums`／`PostSum` を使い回す
- どの節も、値がなければ `MissingValue`（—）を出し、節自体は消さない（固定の構成）
- 8 節の「ファネル」はアカウント単位のプロフィール訪問が API にないための近似で、投稿単位の合計である旨を既存の `MetricHint` の形（指標の説明）で出す。新しい説明文ではなく、`lib/metric-definitions.ts` に 2 指標（投稿のファネル、ストーリーズのファネル）の定義を足す

### 6.2 記入欄と Server Action

1 節と 9 節は **1 つの `<form action={saveReportNotes}>`** にまとめ、`<textarea name="summary">` を 1 節の位置、`<textarea name="next_plan">` を 9 節の位置に置き、保存のボタンは 9 節の末尾に 1 つ。隠し項目は `month` だけ（`account_id` は送らない）。JS なしでも動く。保存中は `PendingMark`。

**ファイルの分け方（R5 S3 と同じ）**:

- `app/report/actions.ts`（`'use server'`）は `saveReportNotes` だけを export する（export の一覧をテストで固定）
- 読み書きの SQL は `lib/queries/report-notes.ts`（`import "server-only"`）。`getReportNotes(accountId, month)` と `upsertReportNotes(accountId, month, summary, nextPlan)`

**`saveReportNotes(formData)` の先頭で行う検査（順に。R5 6.2 節と同じ）**:

1. 同一オリジン: `isSameOriginPost(headers, appUrl)` が偽なら何もせず固定の文言
2. 認可: `checkAccess("/report")` を**固定の値**で呼び、`pass` でなければ何もせず固定の文言
3. 対象のアカウント: `getTargetAccount()`
4. 入力の形: `month`、`summary`、`next_plan` がすべて `typeof v === "string"`（`File` を拒む）。`month` は `^\d{4}-(0[1-9]|1[0-2])$` で、`lib/report.ts` の「選べる月」の範囲に入ること（範囲の外は固定の文言。未来の月に書けない）
5. 本文: `normalize("NFC")` → `\r\n` と `\r` を `\n` に → 末尾の空白と改行を除く → `[...s].length` が 0〜2,000 → `/[^\P{C}\n]/u`（改行以外の制御文字）に当たれば拒む。空は許す（空にして保存＝消す）
6. 書き込み: `insert into public.report_notes (account_id, month, summary, next_plan) values (…) on conflict (account_id, month) do update set summary = excluded.summary, next_plan = excluded.next_plan`（`month` は `YYYY-MM-01` にして渡す）

**エラーの文言**: すべて 1 つの固定の文言（例: 「保存できませんでした」）。DB のエラー文は返さない。ログは Action の名前、成否、SQLSTATE だけ（本文は出さない）。

- 成功したら同じ月のページを描き直す。`revalidatePath` を使うなら `/report` に限る。フォームの状態の扱い（`useActionState` か `redirect` か）と Next.js 16 の Server Functions の作法は、実装の前に `node_modules/next/dist/docs/` の該当資料（Forms、Server Functions）を読んで決める（この起草では読んでいない）
- 記入欄の下に `updated_at`（日本時間）を「保存: YYYY-MM-DD HH:mm」の形で出す。未保存なら出さない
- 同時編集（2 人が同じ月を編集）は後勝ち。版や排他は作らない（R5 のタグと同じ。Q15）

### 6.3 投稿一覧と投稿詳細の印

- **印の見た目**: 既存の `TypeTag` と同じ pill の形で、文言は「伸びた」（`--color-ok` 系）と「課題」（`--color-bad` 系）。**未確認**: `TypeTag` に色の指定（tone）の引数があるか。なければ `TypeTag` に `tone?: "ok" | "bad"` を足す（既存の呼び出しは変えない。共通の部品の変更なので段階 2 の担当がまとめて行う）。新しい部品は作らない
- **投稿一覧** `/media`: 種類のタグの横に印。印の並べ替えと絞り込みは作らない（1.2 節）。`lib/queries/media.ts` の一覧の SQL に `left join public.media_outlier_flags` を足し、`share_flag` と `peer_n` を返す。CSV 出力に `share_flag` と `peer_n` の列を足すかは Q16
- **投稿詳細** `/media/[id]`: 既存の「同じ種類との比較」のカードに 1 行: 「直前の同種 n 件のシェア率: 中央値 x% ・ Q1 y% ・ Q3 z% ・ 判定: 伸びた／課題／なし ・ 経過 d 日」。`n` が 8 未満なら判定の欄は `MissingValue`（—）で、`n` はそのまま出す。既存の「同じ種類の中央値の何倍か」（全投稿が比較対象）とは比較対象が違うので、両方の行に比較対象の件数を添える（既存の行に件数がなければ足す。文言は「同じ種類 n 件」）
- 印の根拠（しきい値）は画面に文で書かない。`MetricHint` の指標の説明として `lib/metric-definitions.ts` に「伸びた／課題の印: 同じ種類の直前 20 投稿のシェア率の四分位範囲から外れた投稿」を 1 項目足す

### 6.4 ナビ

- `NavLinks.tsx` の `NAV_ITEMS` に「レポート」`/report` を足す。位置は**「期間比較」の次、「接続と収集ログ」の前**（Q1 の推奨どおりなら 10 項目: 概要、投稿一覧、リール分析、タグ分析、ストーリーズ、投稿時刻、オーディエンス、期間比較、**レポート**、接続と収集ログ）。理由: 期間比較と同じ「期間をまとめて見る」画面で、設定寄りの「接続と収集ログ」より前
- スマートフォンは既存の折り返す複数段のタブのまま（10 項目で 3 段になる見込み。見た目はユーザーが確かめる）
- `test/routes.test.ts` に `/report` の `no-store` を足す

---

## 7. テスト

### 7.1 確かめること

| 区分 | 内容 |
|---|---|
| DB（`media_outlier_flags`） | 比較対象が直前 20 件で切れる（21 件目は入らない）。自分自身を含まない。同じ `kind` だけ（フィードの比較対象にリールが入らない）。別のアカウントの投稿が入らない。シェア率 null と特殊な投稿（ブースト、コラボ、お試し）が比較対象から外れ、自分の判定はされる。消えた投稿は比較対象に入る。7 件で判定なし（`share_flag` null、`peer_n` = 7）、8 件で判定あり。境目（fence ちょうどは印なし。`>` と `<`）。`percentile_cont` が補間する（偶数件の中央値）。IQR が 0（全部同じ値）で fence = 中央値になり、上回る 1 件だけ `high`。同時刻の投稿の順（`media_id desc`）。`web_app` で読める、`anon`／`authenticated` は読めない。300 件の fixture で実行時間を測り、記録する（3.2 節の性能の判断） |
| DB（`report_notes`） | 月の check（2 日は拒む）。2,001 文字で拒む（コードポイント。絵文字を含む）。改行は通り、タブと制御文字は拒む。日本語と絵文字が `[[:print:]]` を通る（通らなければ check を直す）。`web_app` で select／insert／update（`summary`、`next_plan`）ができ、`month`、`account_id`、`updated_at` は update できず、delete できない。upsert が列の update の権限で通る。トリガーが `updated_at` を入れる。`accounts` を消すと消える。マイグレーションが `supabase db reset` で通る。関数の棚卸し（`web-role.test.ts`。R6 は関数を足さないので変化なし） |
| 単体（worker） | 4.5 節 |
| 結合（worker と DB） | 4.5 節の `alert-signals.test.ts` |
| 画面（単体） | `month` の検査（不正、範囲の外、未来、`2026-13`、`2026-1`）。既定の月（最新の日が 10 月 11 日なら 9 月。最新の日が 1 月なら前年 12 月）。選べる月の列挙（データの始まりの月から最新の日の月まで。始まりと最新が同じ月なら 1 つ）。6 節の上位・下位 3 件（同値はシェア率 → 投稿日時 → id、null は末尾で選ばれない、投稿 2 件なら重ならず 1 件と 1 件、1 件なら上位だけ）。ファネルの率（前段 0 で `MissingValue`）。5 節の率（分子と分母のそろう投稿だけ）。経過日数の表示（秒 → 日、切り捨て）。Server Action（7.2）。`<script>` を含む総評が文字として出る |
| 画面（結合） | `getKindSummary`、`getStorySummary`、`getMonthHighlights`、`getMonthFunnel`、`getReportNotes`／`upsertReportNotes` が 2 アカウントのデータを分ける。暦月の境目（JST 9 月 30 日 23:59 と 10 月 1 日 0:00 の投稿、太平洋時間の `metric_date` の月末）。`getMonthHighlights` が `media_outlier_flags` の印を持ち、ストーリーズを含まない。タグの月次（7 節）が「タグなし」を含む |
| 方針の回帰 | 比較対象が 8 件未満でも `peer_n` を出し、比較の方法を変えない（全投稿の中央値に切り替えない）。月の投稿が 6 件未満でも 6 節の選び方を変えない。目標比の列がない。印がなくても 6 節は出る |
| 受け入れ | 7.3 |

### 7.2 Server Action（単体。`checkAccess` と `headers()` を `vi.mock`）

- `checkAccess` が**固定の値 `"/report"`** で呼ばれる。`pass` でなければ書かない
- `isSameOriginPost` が偽なら書かない
- `actions.ts` の export が `saveReportNotes` だけ
- `month` の検査（形、範囲の外、未来の月、`File`）。本文の検査（2,000 と 2,001 コードポイント、`\r\n` の正規化、末尾の改行の除去、制御文字、NFC で長さが変わるもの、空で保存できる）
- エラーの文言は 1 つ。DB のエラー文を返さない。ログは SQLSTATE だけで本文を出さない

### 7.3 受け入れ（要件 10 章の R6 の完了条件）

- **前月分の月次レポート**: 本番の `/report` を開き、既定で前月（2026 年 9 月）が出て、9 節がすべて描かれる（値のない節は — で出る）ことを確かめる。総評と翌月の施策を書いて保存し、再読み込みで残る。Instagram の担当者も書ける
- **伸びた投稿の検出が動く**: 本番の投稿一覧で印の付いた投稿があるか数え、投稿詳細の「直前の同種 n 件」の行で中央値と判定が出ることを確かめる。印が 1 件もなければ、手元の DB に fixture（同種 20 件 + シェア率が fence を超える 1 件）を入れて `high` が付くことをもって動作の確認とし、本番は「印なし」のまま完了とする（データの状況でしきい値を変えない）
- **低下の通知**: 本番では鳴らないのが正常。手元で `WORKER_SIMULATE_ALERT` と同じ要領で fixture を入れて `check-alerts --scope daily` が終了コード 1 になることを確かめる。本番で鳴ったときの失敗メールの確認は、鳴ったときに行う
- PC 幅とスマートフォン幅の見た目はユーザーが確かめる

### 7.4 テストファイルの担当

| 担当（8 章） | ファイル |
|---|---|
| 1（DB） | `apps/web/test/db/r6-views.test.ts`（新規。`media_outlier_flags`、`report_notes`）、`apps/web/test/db/web-role.test.ts`（追記: 権限）、`apps/web/test/db/fixtures.ts`（`report_notes` と、同種 20 件 + 外れ値の投稿の組を**最初に**足す） |
| 2a（ワーカー） | `apps/worker/test/alerts.test.ts`、`check-alerts.test.ts`（追記）、`apps/worker/test/db/alert-signals.test.ts`（新規） |
| 2b（画面の共通） | `apps/web/test/routes.test.ts`（`/report`）、`TypeTag` の tone（追記があれば）、`apps/web/test/metric-definitions.test.ts`（あれば追記。**未確認**） |
| 3A（レポート） | `apps/web/test/report.test.ts`、`test/report-actions.test.ts`、`test/db/report.test.ts`、`test/db/report-notes.test.ts` |
| 3B（印） | `apps/web/test/db/media.test.ts`、`test/db/media-detail.test.ts`（追記） |

- 段階 3 の担当は `fixtures.ts` を読むだけにし、足りなければ親に戻して段階 1 の担当がまとめて足す（R5 と同じ）

---

## 8. 段階

同じ作業ツリーで、段階ごとにファイルを分担する（git worktree は使わない）。各担当は 7.4 の自分のテストも書く。

| 段階 | 内容 | 担当の案 | ファイル |
|---|---|---|---|
| 0 | 確認事項の回答。本番の数を数える: 種類ごとの投稿数（比較対象 8 件に届く種類）、シェア率が null の投稿数、特殊な投稿の数、非フォロワーリーチの内訳がある日数、`profile_daily` の欠けた日。`lib/queries/tags.ts` の関数の引数、`TypeTag` の引数、`_overview` の部品の import の可否、ワーカーのロールのビューの権限（4.3 節）、`[[:print:]]` と日本語（5.1 節）を確かめる | 親とユーザー | — |
| 1 | マイグレーション、`fixtures.ts`、DB のテスト。300 件の fixture で `media_outlier_flags` の実行時間を測る | `postgres-sql-reviewer` が設計とレビュー | `supabase/migrations/20261013000000_r6_report.sql`、7.4 の 1 |
| 2a | `check-alerts` の 2 種類、DB の読み出し、テスト | `node-worker-developer` | `apps/worker/src/jobs/alerts.ts`、`commands/check-alerts.ts`、`db/alert-signals.ts`、7.4 の 2a |
| 2b | 画面の共通: ナビ、`TypeTag` の tone、`lib/metric-definitions.ts` の 3 項目、`lib/report.ts`（月の検査と列挙）、`no-store` の対象 | `nextjs-developer` | `components/NavLinks.tsx`、`components/TypeTag.tsx`、`lib/metric-definitions.ts`、`lib/report.ts`、7.4 の 2b |
| 3 | 画面（2 人で並列。1 と 2b の後） | `nextjs-developer` × 2 | A（レポート）: `app/report/page.tsx`、`app/report/actions.ts`、`app/report/_report/*`、`lib/queries/report.ts`、`lib/queries/report-notes.ts`。B（印）: `lib/queries/media.ts`、`lib/queries/media-detail.ts`、`app/media/_list/*`、`app/media/[id]/_detail/*` |
| 4 | 本番に反映: `supabase db push` → main のマージ → Vercel の反映。`db push` は毎時 17 分ごろに動く収集を避けて行う（R5 D3）。順は DB が先（ビューと表がないと画面が落ちる）。翌朝の daily の `check-alerts` が `alerts=0` か `reason=no_history` で終わることを `/jobs` と GitHub Actions のログで確かめる | 親とユーザー | — |
| 5 | 受け入れ（7.3）、セキュリティレビュー（Server Action、権限と RLS、ログに人数が出ないこと）、ユーザーの画面の確認 | `quality-engineer`、`security-engineer`、ユーザー | — |

- 段階 1 と 2a と 2b は並べて進められる（ビューの列は 3.2 節、表は 5.1 節で決まっている。ワーカーは `account_daily_wide` と `profile_daily` しか読まないので、マイグレーションを待たずに書き始められる）
- 段階 3 の A と B は触るファイルが重ならない。共通の部品の変更が要るときは段階 3 の中では直さず、親に戻して 2b の担当がまとめて直す
- 担当 A の Server Action はセキュリティレビューを必ず通す（Web から書く 2 つ目の表）

---

## 9. 確認事項

| # | 問い | 推奨 |
|---|---|---|
| Q1 | ナビの位置 | 「期間比較」の次、「接続と収集ログ」の前（6.4 節） |
| Q2 | 比較対象の窓 | 同じ種類の直前 20 投稿（要件の例示のまま）。「過去 90 日」は頻度で件数が揺れるので採らない |
| Q3 | 伸びた投稿をメールでも知らせるか | R6 は画面の印とレポートまで。失敗メールは異常の通知の経路なので使わない（3.5 節） |
| Q4 | 2 節の「目標比」を出すか | 出さない。目標値の表も設定画面もない。目安値の設定（要件 7.4 章）を作る回に列を足す |
| Q5 | fence の係数 | 1.5 × IQR（Tukey の標準）。上下で同じ値。印が少なすぎれば 1.0 に下げる（両側とも）。本番の分布を段階 0 で見て決める |
| Q6 | 判定に要る比較対象の最小の件数 | 8 件。四分位が意味を持つ最小の目安。それ未満は `peer_n` だけ出す |
| Q7 | 特殊な投稿（ブースト、コラボ、お試し）の扱い | 比較対象から外し、自分の判定はする（3.6 節）。除外の設定は作らない |
| Q8 | 同じ事象で毎日の失敗メールが来ることを抑止するか | R6 では抑止しない（既存の `token` と同じ）。鳴ってから煩わしければ通知の履歴の表（`alert_events`）を R7 以降で作る |
| Q9 | `non_follower_reach_drop` のしきい値と式 | 直近 7 日 vs その前 28 日の合計ベースの比率で、**10 pt 以上**の低下。代案は相対（直近 ≤ 基準 × 0.5）。段階 0 で本番の 7 日ごとの値の揺れ幅を見て決める |
| Q10 | 判定に要る日数 | 直近 5 日以上、基準 20 日以上。満たさなければ `no_history` |
| Q11 | `follower_drop` のしきい値 | 前日比で **10 人以上かつ 1% 以上**（両方）。親の案の「または」は小さなアカウントで鳴りすぎるので「かつ」にした |
| Q12 | `check-alerts` の daily が、その朝の `profile_daily` を見られる順か（4.4 節） | `collect.yml` の順を段階 0 で確かめる。`run-daily` の後なら同じ回の記録で判定できる。前なら 1 日遅れを受け入れる（直さない） |
| Q13 | 記入欄の文字数の上限 | 2,000 コードポイント（3 行の総評と箇条書きの施策に十分）。超えたら固定の文言 |
| Q14 | 選べる月に今月（途中）を含めるか | 含める。既存の「31 日中 11 日分」の注記で途中と分かる。既定は前月のまま |
| Q15 | 記入欄の同時編集 | 後勝ち。版や排他は作らない（R5 のタグと同じ） |
| Q16 | 投稿一覧の CSV に印の列を足すか | 足す（`share_flag`、`peer_n` の 2 列。一覧の SQL に既に結合しているので安い）。足さないならその旨 |

---

## 付録 A 読んだ資料

親が 2026-10-12 に確かめた事実票（依頼文）と、次のファイル（行範囲つき）。Web ページは取っていない。

1. `doc/requirements/requirements-definition.md`: 302〜311 行（4.7 章）、406〜418 行（5.4〜5.5 章）、475〜520 行（7 章）、579〜625 行（8.7 章）、626〜676 行（9 章、9.1 章、10 章）
2. `doc/design/r5-analysis.md`: 1〜64 行、109〜126 行、405〜461 行、560〜674 行
3. `supabase/migrations/20261005000000_r3_analysis_views.sql`: 全文
4. `supabase/migrations/20261009000000_r5_analysis.sql`: 1〜80 行、136〜191 行、192〜248 行
5. `apps/worker/src/jobs/alerts.ts`: 全文
6. `apps/worker/src/commands/check-alerts.ts`: 全文
7. `apps/web/src/lib/queries/period-summary.ts`: 全文
8. `apps/web/src/app/_overview/OverviewKpis.tsx`: 全文
9. `apps/web/src/lib/period.ts`: 全文
10. `doc/design-system.md`: 全文

存在だけ Glob で確かめたもの（中身は読んでいない）: `apps/worker/src/db/*.ts`（`account-daily.ts`、`profile.ts` など 12 本）、`apps/web/src/components/**/*.tsx`（`TypeTag`、`PendingMark`、`charts/*` など）、`apps/web/src/lib/queries/*.ts`（`tags.ts`、`media.ts`、`media-detail.ts` など）、`apps/web/test/db/*.ts`（`fixtures.ts`、`web-role.test.ts` など）、`apps/web/src/app/**/page.tsx`。

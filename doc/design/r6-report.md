# R6 月次レポート、伸びた投稿の検出、低下の通知の設計

- 版: 0.2（2026-10-12）。確認事項 Q1〜Q17 は未決（Q12 は解消）

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-12 | 起草（`nextjs-developer`。親が 2026-10-12 に確かめた事実票をもとにする） |
| 0.2 | 2026-10-12 | レビュー 4 本（DB、セキュリティ、品質、画面）と親の判断を反映した。**3 章（検出）**: D1（特殊フラグの null は `is not true` で比較対象に入れる）、D2（`share_flag` に `none`）、D3（軽い基を `materialized` にして lateral）、D4／T1／T23（シェア率が 0 に張り付く性質を明記。係数 1.0 の案は消した）、D5（fence は 1 回だけ計算）、D6（`params` の 1 か所）、D15（結合は `media_id` と `account_id`）、T2／Q17（指標の固定を Q に）、T3（タプル比較）、T18（`gone_at` の数）、U13（詳細の行は四分位だけ）。**4 章（通知）**: S1（ログは連番と日数だけ。率と pt を持たない）、T4（整数の交差乗算、`previous = 0`）、T5（約 14 日）、T6／Q9（直近 7 日に投稿がなければ判定しない）、T7（境目の列挙、null は前日なし、fixture の置き場）、T19（`no_history=<kinds>`）、D12（SQL の案、`limit 2`、bigint の文字列）、Q12（解消）。**5 章（DB）**: D7／S8（`translate` と `[[:cntrl:]]`。CR は拒む）、D8（`report_month`、`extract(day)`）、D9（制約の名前、`updated_at` の性質）、D10（`service_role`）、D11（退避）、S7（`grant insert` は列指定）。**6 章（画面）**: U1（`DAY_BOUNDARY_NOTE` だけ）、U2（フォームは 9 節のカードの中。1 節は `form` 属性）、U3（戻り値に本文）、U4（`useActionState`、`revalidatePath`）、U5／S4／S5／S13（`lib/form-input.ts`、R5 の `authorize()` の順、理由別の固定文言）、U6／S12（ページは proxy、Action は固定の経路）、U7／U14（`OverviewKpis` を直接 import。「前期」は前月）、U8／U15（`LineChart` に 2 系列、`WIDTHS` を写す）、U9／T15（5 節の列を固定）、U10（`SpecialTags` に `shareFlag`）、U16／T16（`HBars` と棒の下の表、`used/total`）、U17（`ChoiceChips`）、U18／T8／S6（`NotCollected`、記入欄なし、Action は拒む）、U19（カードごとの `Suspense`）、U20／U23（ラベル、`aria-live`、`formatJst`）、U21（定義の置き場）、U22（前方一致）、S2（ZWJ を許す）、S9（`overflow-wrap`、リンク化しない）、S10／Q16（CSV は `lib/csv.ts`）、T9（`followerTile`、月末の値、Q14）、T10（3 件の分け方）、T14（検査の順）、T17／Q15（巻き添え）、T20（既定は `latest` を含む月の前月）。**7 章（テスト）**: D13（a〜i）、T12（fixture）、T13（判定対象と印の件数）、T21、T24、S11（架空の id）。**8 章（段階）**: S3／D14（数値は `.local/`、文書には決定と件数）、T11／U11（`lib/report-month.ts` と `lib/report.ts`）、U12（`next.config.ts`）、T22（CSV のファイル、部品の移動は 2b）。親が確かめた事実で 0.1 の「未確認」を解消した（残りは 2 つ。冒頭） |

- 要件: `doc/requirements/requirements-definition.md` 4.7 章（F-RPT-01、F-RPT-02、F-RPT-10、F-RPT-11）、5.5 章（時刻）、7 章（指標の定義。7.1 のシェア率、非フォロワーリーチ比率、7.3 のフォロワー純増、7.4 の目安値）、8.7 章（AI-01: 伸びた投稿の検出は統計で行う）、9 章（画面一覧）と 9.1 章（月次レポートの 9 節）、10 章（R6 の完了条件「前月分の月次レポートを画面に表示できる。伸びた投稿の検出が動く」）
- 既存: R1 の表（`profile_daily`、`media_insight_snapshots`）、R2 の `web_app` ロールと `check-alerts`（`apps/worker/src/commands/check-alerts.ts`、`jobs/alerts.ts`）、R3 のビュー（`20261005000000_r3_analysis_views.sql` の `media_horizon_metrics`、`media_list_metrics`、`account_daily_wide`）、R5 の表とビュー（`20261009000000_r5_analysis.sql` の `tag_axes`、`tag_values`、`media_tags`、`story_list_metrics`）、Web の `lib/queries/period-summary.ts`、`lib/period.ts`、`app/_overview/OverviewKpis.tsx`、`lib/auth.ts`（`checkAccess(pathname)`）、`lib/request-guard.ts`（`isSameOriginPost`）、`app/tags/edit/_edit/input.ts`（R5 の入力の検査と状態）、`components/TypeTag.tsx`（`SpecialTags`）、`components/charts/HBars.tsx`、`lib/metric-definitions.ts`（`DAY_BOUNDARY_NOTE`）、R5 設計 6.2 節（Server Action の形）
- デザイン: `doc/design-system.md`。design-lab v3 に月次レポートの見本はないので、既存の部品（`Card`、`Kpi`、`Delta`、`Callout`、`MetricHint`、`MissingValue`、`SortHeader`、`Thumb`、`TypeTag`／`SpecialTags`、`ChoiceChips`、`PageHead`、`components/charts/` の `LineChart`、`HBars`、`HStack`、`Strip`、`Pie`、`VBars`、`BandRow`）の組み合わせで案を書く（見た目は実装後にユーザーが確かめる）

この文書で「未確認」と書いたものは、起草時に確かめられなかった事実。実装の前に確かめる。外部の事実（Meta API、DB の中身、既存のコードの挙動）は、親が 2026-10-12 に確かめた事実票（付録 A）だけを根拠にした。Web ページは取っていない。版 0.2 で残る未確認は 2 つ: **`media_outlier_flags` の実行時間**（段階 1 で測る。3.2 節）と、**React 19 の `<form action>` が失敗時に入力を `defaultValue` に戻す挙動**（実装時に react.dev で確かめる。6.2 節）。

---

## 1. 目的と範囲

### 1.1 R6 でやること

| 区分 | 内容 | 要件 |
|---|---|---|
| DB | 伸びた投稿の判定のビュー `media_outlier_flags`（同じ種類の直前 20 投稿のシェア率の分布と比べる。順序集合の集約と lateral で、ワーカーのジョブは足さない）。レポートの記入欄の表 `report_notes`（`web_app` から書く） | F-RPT-10、F-RPT-02 |
| ワーカー | `check-alerts --scope daily` に `non_follower_reach_drop`（非フォロワーリーチ比率の低下）と `follower_drop`（フォロワーの急減）を足す。届く経路は既存の GitHub の失敗メール | F-RPT-11 |
| 画面 | レポート `/report`（既定は前月。`?month=YYYY-MM`）。9.1 章の 9 節を既存の部品で組む。1 節（総評）と 9 節（翌月の施策）は利用者が書き、Server Action で保存する。投稿一覧と投稿詳細に「伸びた」「課題」の印を出す。ナビに「レポート」を足す | F-RPT-01、F-RPT-02、F-RPT-10 |

### 1.2 R6 でやらないこと

- **PDF などのファイル出力**（F-RPT-01 で作らないと決めている）。印刷はブラウザの印刷に任せ、印刷用の CSS も作らない
- **AI による総評の下書き**（要件 8.7.3 章。R7 以降）。R6 の総評は利用者が書く
- **目標値（目安値）の表と設定画面、2 節の「目標比」**（要件 9 章の「設定」と 7.4 章は未着手。Q4）。R6 は実績と前月比だけを出す
- **メール送信の API や Slack の導入**。通知は既存の GitHub の失敗メールだけ（`doc/design/r2-cloud.md` 5.3 節）
- **伸びた投稿のメール通知**（Q3。親の推奨は画面の印とレポートまで。失敗メールは異常の通知の経路なので、良い知らせには使わない）
- **投稿単位の非フォロワーリーチ比率による判定**。Meta のメディアのインサイトに内訳がない（事実票。R0 検証 2.4 節）。F-RPT-10 の投稿単位の判定はシェア率で行い（Q17）、非フォロワーリーチ比率はアカウント日次指標で F-RPT-11 として見る
- **通知の履歴の表と重複の抑止**（Q8。既存の `token` と同じく、条件が続く間は毎朝の失敗メールになる。`non_follower_reach_drop` は約 14 日続きうる。4.1 節）
- **特殊な投稿（コラボ、お試し、ブースト）の除外の設定**（R3 の Q4、R5 の方針のまま作らない。判定の比較対象から外す規則は固定で持つ。本番ではこれらの列が全投稿 null なので、規則は将来ワーカーが判定できるようになったときに効く。3.6 節）
- **レポートの月の切り替え以外の絞り込み**（種類、タグの軸の選択など）。各節は固定の構成で出す
- **ストーリーズの伸びた投稿の判定**（`media_list_metrics` に入らない。比べる指標も違う）
- **`media_analysis_dataset` への列の追加**（R6 では使わない。事実票）
- **12 か月を超えたときの月の選び方（`<select>`）**（R7 以降。U17）。R6 は `ChoiceChips`

---

## 2. 既に済んでいるもの

| もの | 内容 |
|---|---|
| 投稿一覧の値 | `media_list_metrics`（1 投稿 1 行。ストーリーズを除く）。`share_rate`、`save_rate`、`reach_rate`、`elapsed_latest`、`is_collab`／`is_trial_reel`／`is_boosted`（**本番では全投稿 null**。ワーカーは判定できず null のまま書く）、`posted_date_jst`、`posted_date_pt`、`profile_visits`、`follows`、`thumbnail_path` |
| 経過時間をそろえた値 | `media_horizon_metrics`（`horizon` と `within_tolerance`）。R6 の判定は `latest` どうしで比べる（R3 の決定）ので、区分は使わない |
| 日次指標 | `account_daily_wide`（太平洋時間の日付で 1 日 1 行。`reach`、`reach_follower`、`reach_non_follower`、`views_follower`、`views_non_follower`。行がない日は欠け、最新の日は `reach` が null のことがある） |
| フォロワー数 | `profile_daily`（`captured_on` は日本時間の日付、1 日 1 行、JST 05:30 ごろ） |
| ストーリーズ | `story_list_metrics`（`views`、`tap_exit`、`swipe_forward`、`exit_rate`、`story_day_jst`） |
| タグ | `tag_axes`、`tag_values`、`media_tags`。タグ別の比較のクエリ `lib/queries/tags.ts` の `getTagAnalysis(accountId, axisId)` は**過去 365 日固定で暦月を受けない**。R6 は `getTagMonthly(accountId, from, to)` を新しく書く（6.1 節） |
| 期間集計 | `lib/queries/period-summary.ts`: `getDailyRange`、`getDailySeries`（`reach_follower`、`reach_non_follower`、`views_follower`、`views_non_follower` の内訳 4 列を返す）、`getDailyTotals`、`getFollowerSeries`、`getFollowerChange`（`end`、`start`、`net`、`latest`）、`getPostTotals`。どれも `(accountId, from, to)` の形で、暦月の `Period` をそのまま渡せる |
| 前期間比 | `lib/metrics.ts` の `deltaCount`（件数の増減率 %）、`deltaPoint`／`deltaRate`（率はポイント差 pt） |
| 月の計算 | `lib/period.ts` の `monthOf`（不正な日付は `RangeError`）、`previousMonth`、`sameMonthLastYear`、`presetPeriods("month", latest)`（最新の日を含む月の前月と、その前の月）、`clampPeriod`（切り詰めの注記つき）、`todayPacific`、`isStale` |
| 主要指標のタイル | `app/_overview/OverviewKpis.tsx`（`cur` と `prev` の `Period` を受けて 6 枚: リーチ、閲覧数、フォロワー純増、ER、保存率、フォロワー数。「30 日中 28 日分」の欠けの注記つき。前の期間は「前期」の語）。**フォロワー数のタイルは `getFollowerChange().latest`（期間に関係なく全体の最新）を出す**。import しているのは `app/page.tsx` だけ。概要の日次推移 `DailyTrendCard` は内訳の 2 本を描かない（`WIDTHS` と `clampPeriod` の扱いを持つ） |
| 日の区切りの注記 | `lib/metric-definitions.ts` の `DAY_BOUNDARY_NOTE`。概要の末尾に `<Note>` で出す。画面では「米国太平洋時間」の語を出さない（2026-10-05 ユーザーの決定） |
| 指標の定義 | `lib/metric-definitions.ts` の `METRIC_DEFINITIONS`（投稿単位）と `ACCOUNT_METRIC_DEFINITIONS`（アカウント単位と期間の集計）。`MetricHint` のボタンは `type="button"`。`test/metric-definitions.test.ts` はない |
| 特殊な投稿の印 | `components/TypeTag.tsx` の `SpecialTags({ isCollab, isTrialReel, isBoosted, gone })` が「コラボ」「お試しリール」「広告」「削除済み」を `tag tag--special` で出す。`TypeTag` に色の引数はない |
| 横棒 | `components/charts/HBars.tsx`。行は `{ label, value, share }`。棒の長さは `share`（行の最大を全幅）、右に「値（割合）」。率のラベルを 1 本ごとに別に書く引数はない |
| 通知 | `evaluateAlerts(input, now, scope, simulate)`（純関数。`AlertAccount` は `ordinal/total` の連番）。`check-alerts.ts` の `loadAlertAccounts` が deps で DB を読む。該当があれば終了コード 1 → GitHub の失敗メール。ログは `WARN alert=<kind> account=1/N …`。履歴が足りなければ `reason=no_history`。**ワーカーは `postgres.<project-ref>`（表の所有者、bypassrls）で接続する**ので、ビューの grant は要らない。**`collect.yml` は `run-daily` → `run-hourly` → `check-alerts` の順** |
| 投稿詳細の比較 | 「同じ種類の中央値の何倍か」「同じ種類の中で上位何 %か」（R3 F-UI-22。比較対象は同じ種類の全投稿） |
| Web の権限と認可 | 表とビューは列挙して `grant`、表には操作ごとのポリシー。Web から書く表の手本は R5 のタグの表（列ごとの `grant update`、`using (true)` のポリシー、`set_updated_at()` のトリガー）。`service_role` には既定で全権が付く（R2 で意図的に残した方針）。**ページは `checkAccess` を呼ばず proxy が守る**（matcher は `_next/static` と favicon 以外すべて。公開は login と favicon だけ）。Server Action の中では `checkAccess` に固定の経路、`isSameOriginPost`、`readEnv()`（R5 の `authorize()` の順: env → origin → access → account）。SQL は `lib/queries/<name>.ts`、応答の `no-store` は `apps/web/next.config.ts` |
| R5 の入力の検査 | `app/tags/edit/_edit/input.ts`: `allValuesAreStrings(formData)`、`singleString(formData, name)`、`TagEditState { status, message }`、`failed()`／`saved()`、`messageForFailure(operation, sqlstate)`（理由別の固定文言。値を含めない）。禁止の文字は `/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u` |
| ナビ | `NavLinks.tsx` の `NAV_ITEMS`。`activeNavHref` は `/` だけ完全一致、ほかは前方一致。ナビのテストファイルはない |
| CSV | `app/export/media/route.ts`（投稿一覧の CSV）、`lib/csv.ts`（逃がし）、`test/export-media.test.ts`、`test/csv.test.ts` |

---

## 3. 伸びた投稿の検出（F-RPT-10）

### 3.1 方法

統計だけで判定する（AI-01）。投稿ごとに、**同じアカウント・同じ種類（`kind`）の直前 20 投稿**のシェア率の分布を取り、四分位で外れ値を判定する（Tukey の fence）。

| 項目 | 決定 |
|---|---|
| 指標 | **シェア率**（`share_rate` = シェア ÷ リーチ。最新の値）1 つに固定する（Q17）。要件の「非フォロワーリーチ比率」は投稿単位では取れない（1.2 節）。保存率とリーチ率は印の根拠にしない（Q17） |
| 比較対象 | 同じアカウント、同じ `kind` で、`(posted_at, media_id)` がその投稿より小さい投稿を新しい順に 20 件（Q2）。シェア率が null の投稿（リーチが 0 か未取得）と特殊な投稿（3.6 節）は比較対象から除く。**除かれた投稿は 20 件の枠を使わない**（直前 25 件のうち 5 件が除外なら `peer_n` = 20）。消えた投稿（`gone_at`）は除かない（最新の値が凍っているだけで、投稿としては本物） |
| 値 | 各投稿の最新の値どうし（R3 の決定）。経過日数で比べ方を切り替えず、画面に `elapsed_latest` を「経過 n 日」として出す |
| 統計量 | 比較対象の Q1、中央値、Q3、IQR = Q3 − Q1。fence は `upper = Q3 + 1.5 × IQR`、`lower = Q1 − 1.5 × IQR`（Q5） |
| 印 | `share_rate > upper` → `high`（伸びた）。`share_rate < lower` → `low`（課題）。それ以外 → `none`（判定したが印なし） |
| 判定しない | 比較対象が **8 件未満**（Q6）、またはその投稿のシェア率が null → `share_flag` は null。比較対象の件数 `peer_n` は常に出す |

**シェア率が 0 に張り付く性質（D4、T1）。規則は固定のまま、次の性質を分かって使う。**

- シェアは 0 の投稿が多い。比較対象 20 件のうち 15 件以上（75% 以上）がシェア 0 なら Q3 = 0、IQR = 0、`upper` = 0 になり、**シェアが 1 件でもあれば `high`** が付く。このとき印の意味は「同種の直前 20 件の 75% を超えるシェア率」になる
- 同様に Q1 = 0（5 件以上がシェア 0）なら `lower` ≤ 0 で、**`low` は付かない**。「課題」の印は、分布の下側に幅があるアカウント（シェアが毎回付く）でだけ出る
- 率は 0 以上なので、IQR が広い種類でも `lower` が負になり `low` はほぼ付かない。これは意図した性質で、「課題」の印は「明らかに低い」ときだけに出る
- 段階 0 で種類ごとに「Q3 = 0 か」だけを見て Q5 の判断材料にする（分布の値は文書に書かない。S3）。受け入れ（7.3）で「判定対象の件数」と「印の件数」を記録し、多すぎれば Q5 の (b) を検討する
- 比較対象が 20 件に満たないが 8 件以上ある投稿（運用の初期や、カルーセルのように少ない種類）は、ある分だけで判定する。「20 件中 n 件」ではなく「比較 n 件」とだけ出す
- 窓を「直前 20 投稿」にする理由: 要件の例示に合わせ、投稿の頻度が変わっても比較の数が一定になる。「過去 90 日」にすると頻度で件数が揺れる

### 3.2 SQL の案（ビュー `media_outlier_flags`）

判定はビューで行い、ワーカーのジョブを足さない。理由: (1) 入力は `media` と最新のスナップショットにそろっていて、計算は 1 文の SQL で書ける、(2) スナップショットが更新されるたびに値が変わるので、保存すると更新の仕組みが要る、(3) 画面（投稿一覧、投稿詳細、レポート）が `left join` するだけで済む。

```sql
-- share_rate の式は media_list_metrics（R3）と同じ（shares ÷ reach。reach が 0 か null なら null）。
-- 軽い基（media + 最新のスナップショット 1 件）を materialized で 1 回だけ作り、その上で直前 20 件を lateral で切る（D3）。
-- 式を 2 か所に持つので、全行で media_outlier_flags.share_rate = media_list_metrics.share_rate を結合テストで確かめる（D13 (e)）。
-- 定数（係数 1.5、最小件数 8）は params の 1 か所（D6）。Q5／Q6 で変えたら create or replace view と comment を直す
create view public.media_outlier_flags
with (security_invoker = true) as
with base as materialized (
  select
    m.id as media_id, m.account_id,
    public.media_kind(m.media_product_type, m.media_type) as kind,
    m.posted_at, s.elapsed_seconds as elapsed_latest,
    public.metric_value(s.metrics, '{shares}') / nullif(public.metric_value(s.metrics, '{reach}'), 0) as share_rate,
    -- 本番では 3 列とも null。null は「判定できない」で、特殊とは扱わない（D1）
    (m.is_boosted is true or m.is_collab is true or m.is_trial_reel is true) as is_special
  from public.media m
  left join lateral (
    select s.elapsed_seconds, s.metrics from public.media_insight_snapshots s
    where s.media_id = m.id order by s.fetched_at desc limit 1
  ) s on true
  where m.media_product_type <> 'STORY'
),
params as (select 1.5::float8 as k, 8 as min_n)
select
  b.media_id, b.account_id, b.kind, b.posted_at, b.share_rate, b.elapsed_latest,
  p.n as peer_n, p.q1 as peer_q1, p.median as peer_median, p.q3 as peer_q3,
  p.iqr as peer_iqr, p.upper as peer_upper, p.lower as peer_lower,
  case
    when b.share_rate is null or p.n < params.min_n then null
    when b.share_rate > p.upper then 'high'
    when b.share_rate < p.lower then 'low'
    else 'none'
  end as share_flag
from base b
cross join params
cross join lateral (
  -- fence は副問い合わせで 1 回だけ計算し、列と判定で同じ値を使う（D5）
  select q.n, q.q1, q.median, q.q3, (q.q3 - q.q1) as iqr,
         q.q3 + params.k * (q.q3 - q.q1) as upper,
         q.q1 - params.k * (q.q3 - q.q1) as lower
  from (
    select count(*)::int as n,
      percentile_cont(0.25) within group (order by r.share_rate) as q1,
      percentile_cont(0.5)  within group (order by r.share_rate) as median,
      percentile_cont(0.75) within group (order by r.share_rate) as q3
    from (
      select s.share_rate from base s
      where s.account_id = b.account_id and s.kind = b.kind
        and (s.posted_at, s.media_id) < (b.posted_at, b.media_id)   -- 同時刻は id で順を固定（T3）
        and s.share_rate is not null and not s.is_special
      order by s.posted_at desc, s.media_id desc
      limit 20
    ) r
  ) q
) p;
```

- `percentile_cont` は順序集合の集約で**窓関数としては使えない**（`over` が付かない）。また `rows between 20 preceding and 1 preceding` の窓は、除外する投稿（シェア率 null、特殊）も行として数えるので「条件を満たす直前 20 件」にならない（D3）。そのため `lateral` の副問い合わせで条件つきの 20 件を切ってから集約する。これが「ビューでは難しい点」
- `media_list_metrics` を基にしない理由（D3）: `media_horizon_metrics` を 2 回結合する重いビューを外側 N 行 × 内側で評価し、`/media` 一覧ではさらに同じ基を 2 度計算することになる。必要な列だけの軽い基を `materialized` にして 1 回だけ読む
- `percentile_cont` は float8 を返し、`share_rate` は numeric。比較は Postgres の暗黙の変換で通るが、**判定は `peer_upper`／`peer_lower` の列と同じ値で行う**（D5）。「ちょうど」のテストは fixture の値を 2 進で正確な値（1/8、1/4、3/8 …）にし、ビューが返す `peer_upper` と比べる
- `is_special` は `is true` で null を偽にする（D1）。`not s.is_boosted and …` と書くと null → 偽で本番の全投稿が比較対象から消え、印が 1 件も付かない
- **性能は未計測**。段階 1 で 300 件の fixture を入れて `explain (analyze, buffers)` を取り、次を見る（D3）: (1) `set role web_app` で測る、(2) 基が `CTE Scan`／`Materialize` として 1 回だけ現れる、(3) 内側の lateral の `loops` が N で、1 回あたり ms 未満、(4) 最新スナップショットが `Index Scan Backward using media_insight_snapshots_media_id_fetched_at_key`、(5) `/media` 一覧の実クエリ（`left join` を足したもの）でも測り、300 件で 300 ms 未満、(6) `limit 20` の `rows` の見積もりと実際の差。計画の形は記録する（数値は件数と時間だけ）

### 3.3 印の出し先

| 場所 | 出し方 |
|---|---|
| 投稿一覧 `/media` | `lib/queries/media.ts` の一覧の SQL に `left join public.media_outlier_flags f on f.media_id = m.media_id and f.account_id = m.account_id`（D15）を足し、`share_flag` と `peer_n` を返す。行の種類（`TypeTag`）の横に `SpecialTags` の印（6.3 節） |
| 投稿詳細 `/media/[id]` | 既存の「同じ種類との比較」のカードに 1 行足す: 「直前の同種 n 件のシェア率: 中央値 x% ・ Q1 y% ・ Q3 z%」。`share_flag` が `high`／`low` のときだけ行末に `SpecialTags` の pill（U13。「判定: なし」の語は出さない） |
| レポート 6 節 | その月の投稿を `media_outlier_flags` と結合し、印を表に出す（6.1 節） |

### 3.4 型（Web）

```ts
/** none = 判定したが印なし。null（判定しない: 比較対象が 8 件未満かシェア率 null）は share_flag の列の null で表す（D2） */
export type ShareFlag = "high" | "low" | "none";

export interface OutlierFlag {
  media_id: string;
  share_rate: number | null;
  elapsed_latest: number | null;   // 秒。画面で日に直す（切り捨て）
  peer_n: number;
  peer_q1: number | null;
  peer_median: number | null;
  peer_q3: number | null;
  share_flag: ShareFlag | null;
}
```

- Web は `peer_n >= 8` を再計算しない（定数 8 はビューの外に漏らさない。D2）。`share_flag` が null なら `MissingValue`、四分位の値が null なら `MissingValue`

### 3.5 「自動で知らせる」の範囲

R6 は**画面の印とレポートの 6 節まで**（Q3）。メールは送らない。理由: 届く経路が GitHub の失敗メール（`check-alerts` の終了コード 1）しかなく、これは収集の異常を知らせる経路なので、良い知らせを混ぜると「失敗メール＝異常」の意味が崩れる。メールで知らせたくなったら、送信の経路（R7 以降）と一緒に決める。

### 3.6 特殊な投稿の扱い

| 投稿 | 比較対象に入れるか | 自分の判定 | 理由 |
|---|---|---|---|
| ブースト（`is_boosted = true`） | 入れない | する（印は付きうる） | 広告でリーチが伸びるので、比較対象に入れると分布がずれる。自分の判定はするが、画面では既存の `SpecialTags`（広告）が横に並ぶので、見た人が割り引ける |
| コラボ（`is_collab = true`） | 入れない | する | 相手のフォロワーにも届くので、リーチとシェアの比が普段と違う |
| お試しリール（`is_trial_reel = true`） | 入れない | する | 非フォロワーにだけ出るので、シェア率の分布が違う |
| **3 列が null（判定できない）** | **入れる** | する | 本番では全投稿が null（ワーカーは判定できず null のまま書く）。null を「特殊」と扱うと比較対象が空になる（D1） |
| 消えた投稿（`gone_at`） | 入れる | する | 最新の値が凍っているだけ。早く消した投稿は値が小さいまま分布を下に引く可能性があるので、段階 0 で `gone_at` のある投稿の数と「投稿から消すまでの日数」の分布を見る（T18。件数と日数だけ） |

- 「自分の判定はする」のは、データの状況で判定の有無を切り替えないため（R3 の決定）。除外は比較対象の側だけで、規則として固定する。Q7

---

## 4. 低下の通知（F-RPT-11）

### 4.1 判定の式

`check-alerts --scope daily` に 2 種類を足す。どちらも純関数 `evaluateAlerts` で判定し、DB の読み出しは `check-alerts.ts` の `loadAlertAccounts` に足す（4.3 節）。

| 種類 | 入力 | 条件 | 判定しない |
|---|---|---|---|
| `non_follower_reach_drop` | `account_daily_wide`。`latest` = `reach` のある最新の日（`getDailyRange` と同じ規則）。**直近** = `latest − 6` 〜 `latest` の 7 日。**基準** = `latest − 34` 〜 `latest − 7` の 28 日。それぞれ `reach` と `reach_non_follower` がともにある日だけで Σ非フォロワーリーチ（`recentNum`、`baseNum`）と Σリーチ（`recentDen`、`baseDen`）を取る（`getDailyTotals.nonFollowerReachRate` と同じ式）。あわせて直近 7 日（太平洋時間の日付 `posted_date_pt`）の投稿数（ストーリーズを除く）`recentPosts` | 基準の比率 − 直近の比率 ≥ 10 pt（Q9）。**整数の交差乗算で判定する**（T4）: `(baseNum × recentDen − recentNum × baseDen) × 10 ≥ baseDen × recentDen` | **`no_history`**: 直近の使えた日数が 5 日未満、基準の使えた日数が 20 日未満（Q10）、どちらかの分母が 0。**`no_posts`**: `recentPosts` = 0（投稿がない週の低下は推薦の兆候ではない。Q9 の推奨）。欠けた日は補間しない（合計から外れるだけ） |
| `follower_drop` | `profile_daily`。`followers_count` が null でない記録を新しい順に 2 件（`latest`、`previous`） | `previous` が `latest` の**前日**（`captured_on` の差がちょうど 1 日）で、`previous − latest ≥ 10` **かつ** `(previous − latest) × 100 ≥ previous`（1% 以上。整数で判定。Q11） | **`no_history`**: 記録が 2 件に満たない、`previous` が前日でない（null の記録は飛ばすので、前日の `followers_count` が null なら「前日なし」）、`previous = 0` |

- 非フォロワーリーチ比率を「直近 7 日 vs その前 28 日」にする理由: 1 日の値は投稿の有無で大きく揺れるので、7 日の合計ベースで平らにする。基準を 28 日にするのは、月の中の波（投稿の多い週と少ない週）をならすため
- 条件を「pt 差」にする理由: 比率の相対の減り方（半減など）だと、もともと低い（10% 前後の）アカウントで 5 pt の揺れが「半減」になり、鳴りすぎる。pt 差は値の大きさによらず同じ意味になる。代案は Q9
- 浮動小数で割った比率を引き算すると 10 pt の境目が不安定になるので、分子と分母の整数のまま交差乗算で比べる（T4）。`follower_drop` も同じ
- 1 週間投稿しないだけで非フォロワーリーチが落ちて 10 pt に当たりうる（T6）。これは推薦から外れた兆候ではないので、直近 7 日に投稿がなければ判定しない（`no_posts`）。段階 0 で「7 日ごとの比率」と「投稿数」を並べて見て、Q9 の決定だけを記録する
- `follower_drop` を「人数かつ率」にする理由: 人数だけだと大きなアカウントで日常の揺れが引っかかり、率だけだと小さなアカウントで 1〜2 人の減りが引っかかる。両方を満たしたときだけ鳴らす（親の案の「または」より狭い。Q11）
- `follower_drop` は前日比だけで、7 日比や 30 日比は作らない（「急減」の検出。緩やかな減少は画面の 3 節で見る）
- **同じ事象で毎朝メールが来ること（T5）**: `non_follower_reach_drop` は直近 7 日が基準に繰り入れられて基準の比率が徐々に下がるので、低下が続けば条件は**約 14 日間**満たされ続け、毎朝の daily で終了コード 1 → 1 日 1 通の失敗メールが約 14 日続く。`follower_drop` は前日比なので、減り続けない限り 1 回で止む。R6 では**抑止しない**（既存の `token` も期限が切れるまで毎日鳴る。通知の履歴の表を作る案は Q8）

### 4.2 `evaluateAlerts` への足し方

```ts
// jobs/alerts.ts に足す
/** 合計は整数（日次指標の値の和）。率は持たない（S1） */
export interface RatioWindow {
  /** Σ非フォロワーリーチ */
  numerator: number;
  /** Σリーチ */
  denominator: number;
  /** 使えた日数（両方の値がある日） */
  days: number;
}

export interface FollowerRecord {
  /** YYYY-MM-DD（日本時間の日付） */
  capturedOn: string;
  count: number;
}

export interface AlertAccount {
  // …既存の項目…
  /** 非フォロワーリーチ比率の直近 7 日と基準 28 日、直近 7 日の投稿数。daily だけ読む。読んでいなければ判定しない */
  nonFollowerReach?: { recent: RatioWindow; base: RatioWindow; recentPosts: number };
  /** フォロワー数の記録の新しい順 2 件（null の記録は除いた後）。1 件なら previous は null。隣接（前日）の検査は純関数で行う */
  followers?: { latest: FollowerRecord; previous: FollowerRecord | null };
}

/** 率や pt、人数を持たない（公開ログに出るため。S1） */
export type Alert =
  | /* 既存 */
  | { kind: "non_follower_reach_drop"; ordinal: number; total: number; recentDays: number; baseDays: number }
  | { kind: "follower_drop"; ordinal: number; total: number };

export interface AlertEvaluation {
  alerts: Alert[];
  /** 履歴が足りず判定を見送った判定があった（既存。stories に加えて 2 種類も立てる） */
  noHistory: boolean;
  /** 見送った判定の種類（固定の語。ログの no_history=<kinds>。T19） */
  noHistoryKinds: ("stories" | "non_follower_reach_drop" | "follower_drop")[];
  /** 直近 7 日に投稿がなく見送った（ログの no_posts=non_follower_reach_drop） */
  noPosts: boolean;
}

/** しきい値（Q9〜Q11） */
export const NON_FOLLOWER_REACH_DROP_PT = 10;
export const NON_FOLLOWER_REACH_RECENT_DAYS = 7;
export const NON_FOLLOWER_REACH_BASE_DAYS = 28;
export const NON_FOLLOWER_REACH_MIN_RECENT_DAYS = 5;
export const NON_FOLLOWER_REACH_MIN_BASE_DAYS = 20;
export const FOLLOWER_DROP_MIN_COUNT = 10;
export const FOLLOWER_DROP_MIN_PERCENT = 1;
```

- `evaluateAlerts` の `scope === "daily"` の分岐に `evaluateNonFollowerReachDrop(account, total)` と `evaluateFollowerDrop(account, total)` を足す。入力が省略されていれば `undefined`（判定しない。`noHistory` も立てない）
- 交差乗算は `BigInt` で行う（`BigInt(baseNum) * BigInt(recentDen) - …`）。合計の積は `Number` の安全な範囲を超えないが、境目を整数のまま比べるため
- 前日の判定: `capturedOn` を `Date.UTC` で日数に直し、差がちょうど 1 なら前日。それ以外は `no_history`
- `Alert` の値に**率、pt、フォロワーの人数（絶対数）を持たせない**（S1）。ログは GitHub Actions に出るため（公開リポジトリ。NF-SEC-06 の「件数と成否だけ」）。合計値は `loadAlertAccounts` の中に留め、debug ログにも出さない

### 4.3 DB の読み出し

新しいファイル `apps/worker/src/db/alert-signals.ts` に 3 関数を置く（既存の `account-daily.ts` と `profile.ts` は書き込みの関数の置き場所なので触らず、並列の作業で衝突しないようにする）。ワーカーは `postgres.<project-ref>`（表の所有者、bypassrls）で接続するので、`security_invoker` のビュー `account_daily_wide` をそのまま読める（grant は不要）。基の表 `account_daily_metrics` を直接集計する案は、内訳の 0／null の規則（R3）を 2 か所に持つことになるので採らない。

| 関数 | 読む先 | 返す |
|---|---|---|
| `readNonFollowerReachWindows(db, accountId)` | `public.account_daily_wide`（`reach` のある最新の日を基点に 35 日分。1 文） | `{ recent: RatioWindow; base: RatioWindow }`。日次指標が 1 日もなければ `undefined` |
| `countRecentPosts(db, accountId, latest)` | `public.media`（ストーリーズを除く。`posted_at` を太平洋時間の日付にして `latest − 6` 〜 `latest`） | `number` |
| `readFollowerPair(db, accountId)` | `public.profile_daily`（`followers_count is not null` の新しい順 2 件） | `{ latest, previous }`。記録がなければ `undefined` |

```sql
-- readNonFollowerReachWindows（D12）。coalesce で null を 0 にしない（内訳が null の日は分母にも入れない）。account_id は必ず付ける
with latest as (
  select max(metric_date) as d from public.account_daily_wide where account_id = $1 and reach is not null
)
select
  (count(*) filter (where w.metric_date > l.d - 7))::int                 as recent_days,
  (sum(w.reach_non_follower) filter (where w.metric_date > l.d - 7))::bigint as recent_num,
  (sum(w.reach) filter (where w.metric_date > l.d - 7))::bigint          as recent_den,
  (count(*) filter (where w.metric_date <= l.d - 7))::int                as base_days,
  (sum(w.reach_non_follower) filter (where w.metric_date <= l.d - 7))::bigint as base_num,
  (sum(w.reach) filter (where w.metric_date <= l.d - 7))::bigint         as base_den,
  l.d::text as latest
from latest l
join public.account_daily_wide w
  on w.account_id = $1 and w.metric_date between l.d - 34 and l.d
where w.reach is not null and w.reach_non_follower is not null
group by l.d;

-- countRecentPosts
select count(*)::int as posts
from public.media
where account_id = $1 and media_product_type <> 'STORY'
  and (posted_at at time zone 'America/Los_Angeles')::date between $2::date - 6 and $2::date;

-- readFollowerPair（D12）。前日かどうかは TS で確かめる
select captured_on::text as captured_on, followers_count
from public.profile_daily
where account_id = $1 and followers_count is not null
order by captured_on desc
limit 2;
```

- node-postgres は `bigint`／`numeric` を文字列で返すので、`::bigint`／`::int` にした上で `Number()`（または `BigInt()`）に直す。`sum` が null（使えた日が 0）は `0` と日数 0 にする
- `loadAlertAccounts` は `scope === "daily"` のときだけ 3 つを読む（`monthlyOcrUsage` と同じ形）。接続は 2 本なので順に読む

### 4.4 ログの形

```
WARN alert=non_follower_reach_drop account=1/1 days=7/28
WARN alert=follower_drop account=1/1
INFO command=check-alerts scope=daily accounts=1 alerts=0 reason=no_history no_history=follower_drop
INFO command=check-alerts scope=daily accounts=1 alerts=0 no_posts=non_follower_reach_drop
```

- `alertFields` に 2 つの `case` を足す。鍵は `alert`、`account`、`days` だけ（S1）。率、pt、人数、アカウントの ID、ユーザー名は出さない
- `INFO` の `reason=no_history` は既存のまま（該当なしのときだけ）。見送った判定の種類を `no_history=<kinds>`（カンマ区切りの固定の語）で足し、投稿がなく見送ったときは `no_posts=non_follower_reach_drop` を足す（T19。kind は固定の語で、データではない）
- `collect.yml` は `run-daily` → `run-hourly` → `check-alerts` の順なので、daily の回の `check-alerts` は**同じ回の `profile_daily`**（その朝の記録）と、太平洋時間の前日までの日次指標で判定する（Q12 は解消）

### 4.5 テスト（ワーカー）

- `apps/worker/test/alerts.test.ts`:
  - `non_follower_reach_drop`: 整数の交差乗算の境目（基準 41%、直近 31% のような値で 10.0 pt ちょうどは鳴り、9.9 pt 相当は鳴らない。0.41／0.31 を `41/100`、`31/100` の分子分母で与える）、直近 5 日で鳴り 4 日で `no_history`、基準 20 日で鳴り 19 日で `no_history`、分母 0 で `no_history`、`recentPosts` = 0 で `no_posts`（鳴らない）、入力の省略で判定しない
  - `follower_drop`: 10 人かつ 1% の両方、片方だけ（9 人で 2%、10 人で 0.9%）、`previous` が null、`previous` が 2 日前（隣接でない）で `no_history`、`previous = 0` で `no_history`、境目（ちょうど 10 人、ちょうど 1%）
  - 共通: hourly では判定しない、`simulate` との併存、入力を変更しない、`noHistoryKinds` に種類が入る
- `apps/worker/test/check-alerts.test.ts`: `alertFields` の鍵が `alert`、`account`、`days` だけ（S1。`Object.keys` を固定）、daily で 3 つを読み hourly で読まない、`INFO` の `no_history=` と `no_posts=`、debug ログに合計値が出ない
- `apps/worker/test/db/alert-signals.test.ts`（新規）: 境目を列挙（T7）: `latest` は `reach` が null の行を基点にしない、`latest − 34` は入り `latest − 35` は入らない、`latest − 7` は基準、`latest − 6` は直近、欠けた日は日数に入らない、`reach_non_follower` が null の日は分子にも分母にも入らない、`followers_count` が null の記録を飛ばす（その結果 `previous` が前日でなくなる）、投稿数の太平洋時間の境目、2 アカウントのデータを分ける。fixture（日次指標、`profile_daily`、`media`）の helper は `apps/worker/test/db/` に 2a が作る（架空の id。S11）

---

## 5. DB

マイグレーション `supabase/migrations/20261013000000_r6_report.sql`（日付は実装の日に合わせる）。手書き。構成は R5 と同じ（前置き、表、ビュー、権限と RLS、ロールバックのコメント）。

### 5.1 表 `report_notes`（記入欄）

```sql
create table public.report_notes (
  account_id uuid not null references public.accounts (id) on delete cascade,
  report_month date not null
    constraint report_notes_month_is_first_day check (extract(day from report_month) = 1),   -- 月の 1 日（D8）
  summary text not null default ''
    constraint report_notes_summary_length check (char_length(summary) <= 2000)
    constraint report_notes_summary_chars check (translate(summary, E'\n', '') !~ '[[:cntrl:]]'),   -- 改行以外の制御文字を拒む（D7）
  next_plan text not null default ''
    constraint report_notes_next_plan_length check (char_length(next_plan) <= 2000)
    constraint report_notes_next_plan_chars check (translate(next_plan, E'\n', '') !~ '[[:cntrl:]]'),
  updated_at timestamptz not null default now(),
  primary key (account_id, report_month)
);

comment on table public.report_notes is
  '月次レポートの記入欄（総評と翌月の施策）。report_month は月の 1 日。アカウントごと月ごとに 1 行。Web（web_app）が upsert する';

create trigger report_notes_set_updated_at before update on public.report_notes
  for each row execute function public.set_updated_at();
```

- 月の列は `date`（1 日固定）にし、列名は `report_month`（`month` はキーワードと同じ綴り。D8）。check は `extract(day from …) = 1`（`date_trunc('month', date)` は timestamptz 版に解決されてセッションの TZ に依存する）
- 文字数の上限 2,000（Q13）。`char_length` はコードポイント。改行（LF）は許し、ほかの制御文字（`[[:cntrl:]]`。CR、タブを含む）は拒む。R5 の名前の check（`name !~ '[[:cntrl:]]'`）と同じ考えで、`[[:print:]]` は照合順序に依存する（C 照合では日本語も絵文字も printable でない）ので使わない（D7、S8）。**CR は DB で拒む**ので、Action が `\r\n` と `\r` を `\n` に正規化してから書く（6.2 節）
- 制約には名前を付ける（D9）。同じ値で upsert しても `on conflict do update` は update なので `updated_at` が進む（D9。6.2 節の表示に書く）
- 履歴（版）は持たない。上書きだけ（R5 のタグと同じ。最後に変えた時刻だけ）
- 索引は主キーだけ（アカウント × 月で引く）

### 5.2 ビュー `media_outlier_flags`

3.2 節の SQL。`comment on view` に「比較対象は同じ種類の直前 20 投稿（特殊な投稿とシェア率 null を除く。フラグが null の投稿は含む）。fence は 1.5 × IQR。8 件未満は判定しない（share_flag は null）。none は判定したが印なし。share_rate の式は media_list_metrics と同じ」を書き、定数を変えたら comment も直す。

### 5.3 権限と RLS

```sql
alter table public.report_notes enable row level security;
-- anon／authenticated の revoke は既定で権限がないので冗長だが、R5 と同じ形で書く（害なし。D10）
revoke all on table public.report_notes, public.media_outlier_flags from public, anon, authenticated;

grant select on table public.report_notes to web_app;
grant insert (account_id, report_month, summary, next_plan) on table public.report_notes to web_app;   -- updated_at は insert でも書けない（S7）
grant update (summary, next_plan) on table public.report_notes to web_app;   -- updated_at はトリガー、report_month と account_id は変えない

create policy web_app_select on public.report_notes for select to web_app using (true);
create policy web_app_insert on public.report_notes for insert to web_app with check (true);
create policy web_app_update on public.report_notes for update to web_app using (true) with check (true);
-- delete は与えない（画面に消す操作がない。空にするのは update）

grant select on table public.media_outlier_flags to web_app;   -- security_invoker。基の表（media、media_insight_snapshots）の select は R2／R3 で済み
```

- ポリシーが `using (true)` なのは R2／R5 と同じ考え（誰が使えるかは proxy と `checkAccess`、対象のアカウントは SQL の `account_id` で絞る）
- `service_role` には既定で全権が付く（R2 で意図的に残した方針。D10）。Web の接続は `web_app`
- `on conflict do update` の upsert には `insert`（列指定）と `update`（列指定）の両方の権限が要る。列の指定で足りることは結合テストで確かめる

### 5.4 ロールバック（コメント）

```sql
-- 先に Web を R6 より前の版に戻す
-- 利用者が書いた総評と施策を退避する（D11）: copy (select * from public.report_notes) to stdout with (format csv, header)
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

- **認可（U6、S12）**: ページは `checkAccess` を呼ばず、proxy が守る（matcher は `_next/static` と favicon 以外すべて。公開は login と favicon だけなので `/report` は自動で守られる）。Server Action の中では `checkAccess("/report")` を固定の経路で呼ぶ（6.2 節）。`routes.test.ts` に「`/report` は claims なしで `pass` にならない」と `no-store` の 2 件を足す
- **応答**: `Cache-Control: private, no-store`（`apps/web/next.config.ts` の対象に `/report` を足す。U12）
- **月の選び方**: `?month=YYYY-MM`。`searchParams.month` は `string[]` になりうるので、文字列 1 つでなければ不正（S6 (1)）。検査の順は **正規表現 `^\d{4}-(0[1-9]|1[0-2])$` → 選べる範囲（文字列の比較）→ `monthOf`**（T14。`0000-01` のような値で `monthOf` が `RangeError` を投げて 500 にならないよう、範囲の検査を先にする）。不正なら既定（R3 4.7 節「不正なら既定に戻す」）。検査、既定、列挙は `lib/report-month.ts`（純関数。U11）に置き、ページと Action で同じ関数を使う（S6）
- **既定の月（T20）**: `presetPeriods("month", latest).a` = 日次指標の最新の日 `latest` を含む月の前月（期間比較の `month` と同じ）。日本時間の月初 1〜2 日は `latest` がまだ前月なので既定は前々月になる。これは `latest` の定義どおりで、直さない（受け入れは月初 3 日目以降に行う。7.3）
- **選べる月（Q14）**: `getDailyRange().start` の月から `latest` を含む月まで。今月（途中）を含める。表示の期間は `clampPeriod` で `to` を `latest` に切り詰め、既存の切り詰めの注記を出す（T9 (1): 切り詰めないと今月のフォロワー純増の `end` が常に null になる）。範囲の外の月は既定に戻す
- **日次指標がないとき（T8、U18、S6 (3)）**: `getDailyRange()` が null なら、概要と同じ `NotCollected` を出し、月の選択と記入欄は出さない。Action は選べる月が空なら拒む
- **月の切り替え UI（U17）**: `ChoiceChips`（概要の `RangeChips` と同じ形）を `PageHead` の `tools` に置く。ラベルは `YYYY-MM`。12 か月を超えたときの `<select>` は R7 以降
- **注記（U1）**: ページの末尾に `DAY_BOUNDARY_NOTE` をそのまま `<Note>` で出す（概要と同じ）。「投稿は日本時間」のような新しい注記は足さない（画面では「米国太平洋時間」の語を出さない決定）。月の境目の規則は次のとおりで、文書にだけ書く: **投稿単位の節（5、6、7、8 の投稿分）は `posted_date_jst` の暦月、日次指標の節（2、4）は `metric_date`（太平洋時間）の暦月、フォロワー数（2、3）は `captured_on`（日本時間）の暦月**
- **読み出しの単位（U19）**: カードごとに `<Suspense fallback={<CardLoading />}>` で包み、各カードの Server Component が自分の関数を await する。`loading.tsx` は作らない。1 節と 9 節の値（`getReportNotes`）だけページで await する（フォームの `defaultValue` に要るため）

### 6.1 レポート `/report` の構成

9.1 章の 9 節を上から順にカード（`Card`）で並べる。節の番号と見出しは 9.1 章の文言のまま。

| 節 | 内容 | 使う関数・ビュー | 新しく要るもの | 部品 |
|---|---|---|---|---|
| 1 総評 | 利用者の記入（結果、課題、翌月の方針を 3 行）。`<textarea name="summary" form="report-notes">` を置く（フォーム本体は 9 節。U2） | `getReportNotes(accountId, month)` | `lib/queries/report-notes.ts` | `<textarea>`（6.2 節） |
| 2 主要指標のサマリー | リーチ、閲覧数、フォロワー純増、ER、保存率、フォロワー数の 6 枚。前月比つき。**目標比は出さない**（Q4）。「前期」の語はそのままで、レポートでは前月の意味（U14） | `OverviewKpis({ accountId, cur: month, prev: previousMonth(month.from), followerTile: "end" })`。`@/app/_overview/OverviewKpis` を直接 import し、移さない（U7） | 2b で `OverviewKpis` に `followerTile?: "latest" \| "end"` を足す（既定 `"latest"`。概要は変えない）。レポートは **月末の `getFollowerChange().end`**（`captured_on` 時点。null なら —）を出す（T9 (2)）。失敗の表示は `Callout` | `Kpi`、`Delta` |
| 3 フォロワー数の推移 | 月内の日ごとのフォロワー数の折れ線。月初と月末の値、純増 | `getFollowerSeries(accountId, from, to)`、`getFollowerChange` | なし。`DailyTrendCard` の `WIDTHS` と `clampPeriod` の扱いを写す（共通化しない。U15） | `LineChart` |
| 4 リーチと閲覧数の推移 | 日ごとのリーチ（フォロワー／非フォロワーの 2 本）と閲覧数（同 2 本）の 2 つのグラフ。月の合計と非フォロワーリーチ比率（前月比 pt） | `getDailySeries`（内訳 4 列を返す）、`getDailyTotals`（当月と前月） | なし。`LineChart` に 2 系列を渡す（フォロワー: `--chart-1` の実線、非フォロワー: 同色で `dashed: true`）。凡例の部品はないので `endLabel` に系列名と値（U8） | `LineChart`、`Kpi` |
| 5 投稿の種類ごとのまとめ | フィード、カルーセル、リール、ストーリーズの 4 行。**列は固定**（U9）: 件数、Σリーチ、Σ閲覧数、ER、保存率、シェア率（Σの比）、プロフィール訪問、離脱率。当てはまらない欄（リールのプロフィール訪問、ストーリーズの ER など）は値が null なので `MissingValue`（種類で分岐しない。T15）。markup は `_list/MediaTable.tsx` と同じ | `getPostTotals`（件数、Σリーチ、Σ保存は `byKind` にある）。種類ごとの率は足りない | `getKindSummary(accountId, from, to)`（`media_list_metrics` を `kind` で group by。率は Σの比、分子と分母がそろう投稿だけ）、`getStorySummary(accountId, from, to)`（`story_list_metrics` を `story_day_jst` の月で絞り、件数、Σ閲覧、Σ離脱、離脱率） | 表（`SortHeader` なしの固定の順）、`TypeTag` |
| 6 よかった投稿 3 件、課題のある投稿 3 件 | その月の投稿（ストーリーズを除く）をシェア率で並べ、**上位 = 先頭 `min(3, ceil(n/2))` 件、下位 = 末尾 `min(3, floor(n/2))` 件**（T10。n は シェア率が null でない投稿の数。重ならない）。並び順はシェア率 → 投稿日時の新しい順 → `media_id`。シェア率が null の投稿は選ばれない。列はサムネイル、題名、種類、投稿日、経過日数、リーチ、シェア率、印（`high`／`low` のときだけ）、比較 n 件。印は順位の根拠ではなく添え物（印がない月もある。上位 3 件に `low` が付く月もありうる。T24） | `media_list_metrics` ⋈ `media_outlier_flags` | `getMonthHighlights(accountId, from, to)`、選び方は `lib/report.ts` の純関数 | 表、`Thumb`、`TypeTag`、`SpecialTags` |
| 7 タグ別の比較 | 軸ごとに値 × 件数 × 中央値（リーチ率、シェア率）。「タグなし」の行を含む（R5 Q4）。軸が 0 件なら節は空の表示で、タグの編集へのリンクだけ | — | `getTagMonthly(accountId, from, to)` を `lib/queries/report.ts` に新しく書く（`getTagAnalysis` は過去 365 日固定で暦月を受けない。SQL は同じ形で `posted_date_jst between` に置き換える） | 表 |
| 8 ファネルの転換率 | 2 組。**投稿**（フィードとカルーセル。リールはプロフィール訪問が API にない）: Σリーチ → Σプロフィール訪問 → Σフォロー（3 つがそろう投稿だけ。各段の `used/total` を添える。T16: Σリーチは 5 節の数と違う）。**ストーリーズ**: Σ閲覧数 → Σ離脱（tap_exit）と Σ次へ（swipe_forward） | `media_list_metrics`、`story_list_metrics` | `getMonthFunnel(accountId, from, to)`、率は `lib/report.ts` の純関数 | `HBars`（`share` は 1 段目に対する割合。棒の右の「値（割合）」はそのまま）＋棒の下に小さな表（段、値、前段比、`used/total`。U16。率のラベルを 1 本ごとに置く引数がないため） |
| 9 翌月の施策 | 利用者の記入。`<form id="report-notes" action={formAction}>` の本体をこのカードに置く（`next_plan`、隠し `month`、保存のボタン、`PendingMark`、文言） | `getReportNotes` | （1 節と同じ） | `<textarea>`、`PendingMark` |

- 新しいクエリは `lib/queries/report.ts`（読み出し）と `lib/queries/report-notes.ts`（記入欄の読み書き）に置く。純関数は 2 つに分ける（T11、U11）: `lib/report-month.ts`（2b: 月の検査、既定、選べる月の列挙）と `lib/report.ts`（3A: ファネルの率、上位と下位の選び方、種類の率）。`getKindSummary` などの型は `period-summary.ts` の `RatioOfSums`／`PostSum` を使い回す
- どの節も、値がなければ `MissingValue`（—）を出し、節自体は消さない（固定の構成）
- 8 節の「ファネル」はアカウント単位のプロフィール訪問が API にないための近似で、投稿単位の合計である旨は `MetricHint` の指標の説明で出す。`ACCOUNT_METRIC_DEFINITIONS` に 2 項目（投稿のファネル、ストーリーズのファネル）を足す（U21）

### 6.2 記入欄と Server Action

**フォームの構造（U2）**: `<form id="report-notes" action={formAction}>` は **9 節のカードの中だけ**に置く（`<textarea name="next_plan">`、隠し `<input name="month">`、保存のボタン、`PendingMark`、文言の `<p aria-live="polite">`）。1 節の `<textarea name="summary" form="report-notes">` は 1 節のカードに置き、`form` 属性で関連付ける。1 つの `<form>` で 7 枚のカードを挟むと、`useActionState` のためにページ全体を Client Component にする必要が出るため。JS なしでも動く（`form` 属性は HTML の標準）。

**状態（U3、U4）**: R5 と同じ `(prevState, formData)` の署名で `useActionState` を使う。成功時は `revalidatePath("/report")`。`redirect` と `router.refresh()` は使わない。戻り値は `{ status: "idle" | "ok" | "error"; message: string; values?: { summary: string; next_plan: string } }` で、**失敗時は送られた本文を `values` に含めて返し**、`<textarea defaultValue={state.values?.summary ?? saved.summary}>` にする（React 19 の `<form action>` は送信後に入力を `defaultValue` に戻すので、失敗すると書いた本文が消える。**この挙動は未確認**で、実装時に react.dev で確かめる。`values` はログに出さない）。

**入力の UI（U20、S9、U23）**: `<label htmlFor>` で 2 つの `<textarea>` に名前を付ける。`maxLength` は付けない（検査はサーバー）。保存中は `disabled={pending}`。本文の表示は `overflow-wrap: anywhere`（空白なしの 2,000 文字で段組みが崩れない）。本文の URL をリンクにしない（文字のまま）。記入欄の下に `updated_at` を `formatJst`（`lib/format`）で「保存: YYYY-MM-DD HH:mm」の形で出す。未保存なら出さない。同じ値で保存しても時刻は進む（D9）。

**ファイルの分け方（R5 S3、U5）**:

- `app/report/actions.ts`（`'use server'`）は `saveReportNotes` だけを export する（export の一覧をテストで固定）
- 読み書きの SQL は `lib/queries/report-notes.ts`（`import "server-only"`）。`getReportNotes(accountId, month)` と `upsertReportNotes(accountId, month, summary, nextPlan)`
- 汎用の検査と状態は **2b が `lib/form-input.ts` に出す**: `allValuesAreStrings`、`singleString`、状態の型（`FormState`）、`saved()`／`failed()`。`app/tags/edit/_edit/input.ts` はそこから import して再 export し、R5 のテストは変えない。R6 の検査（月、本文）と文言は `app/report/_report/input.ts`（純関数）に置く

**`saveReportNotes(prevState, formData)` の先頭で行う検査（順に。R5 の `authorize()` と同じ順）**:

0. 環境（S5）: `readEnv()` が `ok` でなければ固定の文言
1. 同一オリジン: `isSameOriginPost(headers, appUrl)` が偽なら何もせず固定の文言
2. 認可: `checkAccess("/report")` を**固定の値**で呼び、`pass` でなければ何もせず固定の文言
3. 対象のアカウント: `getTargetAccount()`
4. 入力の形（S4）: `allValuesAreStrings(formData)`（余分な項目に `File` があっても拒む）。`month`、`summary`、`next_plan` は `singleString` で取る（ない、同じ名前が 2 つ、文字列でないなら拒む）
5. 月（S6 (2)(3)）: ページと同じ `lib/report-month.ts` の検査（正規表現 → 選べる範囲 → `monthOf`）。選べる月は `getDailyRange()` から列挙し、空なら拒む（日次指標がないアカウントには書けない）。隠し項目の `month` にはページが検査済みの月を入れる
6. 本文（S2）: `normalize("NFC")` → `\r\n` と `\r` を `\n` に → 末尾の空白と改行を除く → `[...s].length` が 0〜2,000 → `/[^\P{C}\n‍]/u` に当たれば拒む（**C カテゴリ（制御・書式・サロゲート・私用・未割当）を、改行と ZWJ（U+200D）以外すべて拒む**。ZWJ を許すのは家族・職業・旗の絵文字が ZWJ でつながるため。U+2028／U+2029 は C カテゴリでないので通る）。空は許す（空にして保存＝消す）
7. 書き込み: `insert into public.report_notes (account_id, report_month, summary, next_plan) values (…) on conflict (account_id, report_month) do update set summary = excluded.summary, next_plan = excluded.next_plan`（`report_month` は `YYYY-MM-01`）

**文言（S13。R5 の `messageForFailure` と同じ形。値を含めない）**:

| 場合 | 文言 |
|---|---|
| 月が不正、範囲の外、選べる月が空 | 「月が正しくありません」 |
| 本文が 2,000 コードポイントを超える | 「2,000 文字までです」 |
| 本文に使えない文字 | 「使えない文字があります」 |
| 環境、同一オリジンでない、認可、アカウント、入力の形（`File`、重複）、DB のエラー（すべての SQLSTATE） | 「保存できませんでした」 |
| 成功 | 「保存しました」 |

- DB のエラー文は返さない（R3 4.7 節）。ログは Action の名前、成否、SQLSTATE だけ（本文、`values`、月は出さない）
- **同時編集（T17、Q15）**: 1 つのフォームで 2 欄を一緒に保存するので、2 人が同じ月を別々の欄で編集しても後に保存した人の 2 欄で上書きされる（巻き添え）。版や排他は作らず受け入れる（R5 のタグと同じ）

### 6.3 投稿一覧と投稿詳細の印

- **印の見た目（U10）**: `SpecialTags` に `shareFlag?: "high" | "low" | null` を足し、「伸びた」「課題」を既存の「コラボ」「広告」と同じ `tag tag--special` で出す。**色は付けない**（新しい見た目を足さない）。`none` と null は何も出さない。2b が足し、3B は値を渡すだけ
- **投稿一覧** `/media`: 種類のタグの横に `SpecialTags` の印。印の並べ替えと絞り込みは作らない（1.2 節）。`lib/queries/media.ts` の一覧の SQL に `left join public.media_outlier_flags f on f.media_id = m.media_id and f.account_id = m.account_id` を足し、`share_flag` と `peer_n` を返す。**CSV（Q16、S10）**: `app/export/media/route.ts` に `share_flag` と `peer_n` の 2 列を足す。値は既存の `lib/csv.ts` の逃がしを通し、null は空欄
- **投稿詳細** `/media/[id]`（U13）: 既存の「同じ種類との比較」のカードに 1 行: 「直前の同種 n 件のシェア率: 中央値 x% ・ Q1 y% ・ Q3 z%」。行の形は固定で、`share_flag` が `high`／`low` のときだけ行末に `SpecialTags` の pill。四分位が null なら `MissingValue`、`n` はそのまま出す。既存の「同じ種類の中央値の何倍か」（全投稿が比較対象）とは比較対象が違うので、既存の行にも件数を添える（文言は「同じ種類 n 件」）
- 印の根拠（しきい値）は画面に文で書かない。`METRIC_DEFINITIONS` に `share_flag`（「伸びた／課題の印 = 同じ種類の直前 20 投稿のシェア率の四分位範囲（1.5 × IQR）から外れた投稿。比較対象が 8 件未満なら判定しない」）を 1 項目足す（U21）

### 6.4 ナビ

- `NavLinks.tsx` の `NAV_ITEMS` に「レポート」`/report` を足す。位置は**「期間比較」の次、「接続と収集ログ」の前**（Q1 の推奨どおりなら 10 項目: 概要、投稿一覧、リール分析、タグ分析、ストーリーズ、投稿時刻、オーディエンス、期間比較、**レポート**、接続と収集ログ）。理由: 期間比較と同じ「期間をまとめて見る」画面で、設定寄りの「接続と収集ログ」より前
- `activeNavHref` は `/` だけ完全一致、ほかは前方一致なので `/report` は追記だけで現在位置になる（U22）。ナビのテストファイルはないので足さない
- スマートフォンは既存の折り返す複数段のタブのまま（10 項目で 3 段になる見込み。見た目はユーザーが確かめる）

---

## 7. テスト

### 7.1 確かめること

| 区分 | 内容 |
|---|---|
| DB（`media_outlier_flags`） | (a) **特殊フラグが null の投稿は比較対象に入る**（D1）。(b) **除外される投稿が 20 件の枠を使わない**（直前 25 件のうち 5 件が除外なら `peer_n` = 20）。(c) ストーリーズを除く全投稿が 1 行ずつ出る（スナップショットのない投稿も `share_rate` null で出る）。(d) `share_flag` と `peer_upper`／`peer_lower` の整合（`high` の行は `share_rate > peer_upper`、`low` は `< peer_lower`、`none` はその間）。(e) 全行で `media_outlier_flags.share_rate = media_list_metrics.share_rate`（回帰）。比較対象が直前 20 件で切れる（21 件目は入らない）。自分自身を含まない。**同時刻で id の小さい投稿は入り、大きい投稿は入らない**（T3）。同じ `kind` だけ。別のアカウントの投稿が入らない。シェア率 null の投稿と `is_* = true` の投稿が比較対象から外れ、自分の判定はされる。消えた投稿は比較対象に入る。7 件で `share_flag` null と `peer_n` = 7、8 件で判定あり。自分の `share_rate` が null なら `peer_n` があっても null（T21）。境目: fixture のシェア率は 2 進で正確な値（1/8、1/4、3/8 …）にし、「ちょうど」はビューが返す `peer_upper` と比べて `none`（`>` と `<`。D5）。`percentile_cont` が補間する（偶数件の中央値）。**IQR = 0: Q3 = 0 ならシェア 1 件で `high`**（D4。テスト名にそう書く）、全部同じ正の値なら fence = 中央値で上回る 1 件だけ `high`。`web_app` で読める、`anon`／`authenticated` は読めない。(i) 300 件の fixture で `set role web_app` にして `explain (analyze, buffers)` を取り、3.2 節の 6 点を見て、計画の形と時間を記録する（段階 1） |
| DB（`report_notes`） | 月の check（2 日は拒む）。2,001 コードポイントで拒む（絵文字を含む）。改行（LF）は通り、**CR**、タブ、ほかの制御文字は拒む（D7、D13 (g)）。日本語、絵文字（ZWJ でつないだもの）、U+2028 が通る。`web_app` で select／insert（4 列）／update（`summary`、`next_plan`）ができ、**`updated_at` を含む insert は拒まれる**（S7）、`report_month`、`account_id`、`updated_at` は update できず、delete できない。upsert が列指定の権限で通る。**同じ値で 2 回 upsert しても 1 行のままで `updated_at` が進む**（D13 (h)）。トリガーが `updated_at` を入れる。`accounts` を消すと消える。(f) `anon`／`authenticated` は読めない。DB の check と Action の検査の差（Action は ZWJ を許し DB も通す。Action は CR を `\n` にするので DB に CR は届かない。T21）。マイグレーションが `supabase db reset` で通る。関数の棚卸し（`web-role.test.ts`。R6 は関数を足さないので変化なし） |
| 単体（worker） | 4.5 節 |
| 結合（worker と DB） | 4.5 節の `alert-signals.test.ts` |
| 画面（単体） | `month` の検査（`string[]`、不正、範囲の外、未来、`2026-13`、`2026-1`、**`0000-01` で例外にならない**。T14）。既定の月（`latest` が 10 月 11 日なら 9 月、1 月なら前年 12 月、月初 1 日で `latest` が前月なら前々月。T20）。選べる月の列挙（データの始まりの月から `latest` の月まで。同じ月なら 1 つ。`getDailyRange` null なら空）。6 節の分け方（T10: n = 1 → 上位 1・下位 0、2 → 1・1、3 → 2・1、4 → 2・2、5 → 3・2、6 以上 → 3・3。同値はシェア率 → 投稿日時の新しい順 → `media_id`。null は選ばれない）。ファネルの率（前段 0 で `MissingValue`、`used/total`）。5 節の率（分子と分母のそろう投稿だけ。null の欄は —）。経過日数の表示（秒 → 日、切り捨て）。`OverviewKpis` の `followerTile`（`end` で月末の値、null で —、`latest` は従来どおり）。Server Action（7.2）。ページ側の固定値: 隠し `month` が検査済みの月、`DAY_BOUNDARY_NOTE` が末尾に出る、`NotCollected` のとき記入欄が出ない（T21）。`<script>` を含む総評と**翌月の施策**が文字として出る（T21） |
| 画面（結合） | `getKindSummary`、`getStorySummary`、`getMonthHighlights`、`getMonthFunnel`、`getTagMonthly`、`getReportNotes`／`upsertReportNotes` が 2 アカウントのデータを分ける。暦月の境目（JST 9 月 30 日 23:59 と 10 月 1 日 0:00 の投稿、太平洋時間の `metric_date` の月末）。`getMonthHighlights` が `media_outlier_flags` の印を持ち、ストーリーズを含まない。`getTagMonthly` が「タグなし」を含む。一覧の `left join` が `account_id` でも結合する（D15） |
| 方針の回帰 | 比較対象が 8 件未満でも `peer_n` を出し、比較の方法を変えない（全投稿の中央値に切り替えない）。月の投稿が 6 件未満でも 6 節の選び方（T10 の式）を変えない。目標比の列がない。印がなくても 6 節は出る。今月を選んでも `to` の切り詰め以外は同じ構成 |
| 受け入れ | 7.3 |

### 7.2 Server Action（単体。`checkAccess`、`headers()`、`readEnv()` を `vi.mock`）

- 順: `readEnv()` が `ok` でなければ書かない → `isSameOriginPost` が偽なら書かない → `checkAccess` が**固定の値 `"/report"`** で呼ばれ `pass` でなければ書かない（要求の見出しの経路を使わない）
- `actions.ts` の export が `saveReportNotes` だけ
- 入力の形（S4）: 余分な項目に `File`、`summary` が 2 つ、`month` がない
- 月: 形、範囲の外、未来の月、`0000-01`、選べる月が空（`getDailyRange` null）で拒む（S6 (3)）
- 本文（S2）: 2,000 と 2,001 コードポイント、`\r\n` と `\r` の正規化、末尾の改行の除去、NFC で長さが変わるもの、空で保存できる。**ZWJ でつないだ絵文字（家族、職業、旗）は通る**。U+202E（RLO）、U+200B（ZWSP）、U+0000、タブは拒む。U+2028／U+2029 は通る
- 文言（S13）: 理由別の 4 つと成功の 1 つ。DB のエラー（どの SQLSTATE でも）は「保存できませんでした」。DB のエラー文を返さない。ログは SQLSTATE だけで本文と `values` を出さない
- 戻り値（U3）: 失敗時に `values` に送られた本文（正規化前）が入る。成功時は `values` なし
- `revalidatePath` が `/report` だけで呼ばれる（成功時のみ）

### 7.3 受け入れ（要件 10 章の R6 の完了条件）

- **前月分の月次レポート**: 本番の `/report` を**月初 3 日目以降**に開き（T20）、既定で `latest` を含む月の前月（2026 年 9 月の見込み）が出て、9 節がすべて描かれる（値のない節は — で出る）ことを確かめる。総評と翌月の施策を書いて保存し、再読み込みで残る。Instagram の担当者も書ける。失敗時に本文が消えないことを、わざと 2,001 文字で保存して確かめる（U3）
- **伸びた投稿の検出が動く**: 本番の投稿一覧で**判定対象の件数（`share_flag` が null でない投稿）と印の件数（`high`、`low` それぞれ）**を数えて記録する（T13。件数だけ。S3）。投稿詳細の「直前の同種 n 件」の行で中央値と四分位が出ることを確かめる。印が 1 件もなければ、手元の DB に fixture（同種 20 件 + シェア率が `peer_upper` を超える 1 件。架空の id）を入れて `high` が付くことをもって動作の確認とし、本番は「印なし」のまま完了とする。印が判定対象の大半に付いていれば（Q3 = 0 の性質。3.1 節）、その件数を Q5 の判断に使う。6 節の上位 3 件に `low` が付いていないかも見る（T24。付いていても不具合ではない）
- **低下の通知**: 本番では鳴らないのが正常。手元で fixture を入れて `check-alerts --scope daily` が終了コード 1 になり、ログに率と人数が出ないことを確かめる。本番で鳴ったときの失敗メールの確認は、鳴ったときに行う
- 記録に残すのは決定と件数だけ。値、分布、`media_id` は `.local/` に置き、文書に書かない（S3）
- PC 幅とスマートフォン幅の見た目はユーザーが確かめる

### 7.4 テストファイルの担当

| 担当（8 章） | ファイル |
|---|---|
| 1（DB） | `apps/web/test/db/r6-views.test.ts`（新規。`media_outlier_flags`、`report_notes`、`explain` の記録）、`apps/web/test/db/web-role.test.ts`（追記: 権限）、`apps/web/test/db/fixtures.ts`（**最初に**足す。T12: `FakeMedia` に `is_collab`／`is_trial_reel`／`is_boosted`／`gone_at` の項目、`report_notes` の作り方、日次指標（`account_daily_metrics`）と `profile_daily` の作り方、同種 20 件 + 外れ値の投稿の組） |
| 2a（ワーカー） | `apps/worker/test/alerts.test.ts`、`check-alerts.test.ts`（追記）、`apps/worker/test/db/alert-signals.test.ts`（新規）と `apps/worker/test/db/` の fixture の helper |
| 2b（画面の共通） | `apps/web/test/routes.test.ts`（`/report` の `no-store` と「claims なしで `pass` にならない」）、`test/report-month.test.ts`（新規）、`test/form-input.test.ts`（新規。`lib/form-input.ts` に移した関数。R5 の `tag-edit-actions.test.ts` は変えない）、`test/charts.test.ts`（`SpecialTags` の `shareFlag`、`OverviewKpis` の `followerTile` は該当のテストに追記） |
| 3A（レポート） | `apps/web/test/report.test.ts`（`lib/report.ts`）、`test/report-actions.test.ts`、`test/db/report.test.ts`、`test/db/report-notes.test.ts` |
| 3B（印） | `apps/web/test/db/media.test.ts`、`test/db/media-detail.test.ts`、`test/export-media.test.ts`（CSV の 2 列。T22）（追記） |

- **fixture は架空の値だけ**（S11、D14）: 実在の `media_id`、キャプション、サムネイルのパス、`ig_user_id`、実測の値を使わない。id は `r6_` のような架空の接頭辞。本番の数を写すときは件数と割合だけ
- 段階 3 の担当は `fixtures.ts` を読むだけにし、足りなければ親に戻して段階 1 の担当がまとめて足す（R5 と同じ）

---

## 8. 段階

同じ作業ツリーで、段階ごとにファイルを分担する（git worktree は使わない）。各担当は 7.4 の自分のテストも書く。

| 段階 | 内容 | 担当の案 | ファイル |
|---|---|---|---|
| 0 | 確認事項の回答。本番の数を数える（**数値は `.local/` に置き、文書には決定と件数だけを書く**。S3、D14）: 種類ごとの投稿数（比較対象 8 件に届く種類）、シェア率が null の投稿数、**種類ごとに「直前 20 件の Q3 = 0 か」**（D4、T1。Q5 の判断材料）、`gone_at` のある投稿の数と消すまでの日数（T18）、非フォロワーリーチの内訳がある日数、**7 日ごとの比率と投稿数を並べて見る**（T6。Q9 の判断材料）、`profile_daily` の欠けた日 | 親とユーザー | — |
| 1 | マイグレーション、`fixtures.ts`（T12 の項目を最初に）、DB のテスト。300 件の fixture で `set role web_app` にして `explain (analyze, buffers)` を取り、3.2 節の 6 点を見る（D3） | `postgres-sql-reviewer` が設計とレビュー | `supabase/migrations/20261013000000_r6_report.sql`、7.4 の 1 |
| 2a | `check-alerts` の 2 種類、DB の読み出し、テスト、fixture の helper | `node-worker-developer` | `apps/worker/src/jobs/alerts.ts`、`commands/check-alerts.ts`、`db/alert-signals.ts`、7.4 の 2a |
| 2b | 画面の共通: ナビ、`SpecialTags` の `shareFlag`（U10）、`OverviewKpis` の `followerTile`（T9）、`lib/metric-definitions.ts` の 3 項目（U21）、`lib/report-month.ts`（U11）、`lib/form-input.ts` と `tags/edit/_edit/input.ts` の import の付け替え（U5）、`next.config.ts` の `no-store` の対象（U12） | `nextjs-developer` | `components/NavLinks.tsx`、`components/TypeTag.tsx`、`app/_overview/OverviewKpis.tsx`、`lib/metric-definitions.ts`、`lib/report-month.ts`、`lib/form-input.ts`、`app/tags/edit/_edit/input.ts`、`apps/web/next.config.ts`、7.4 の 2b |
| 3 | 画面（2 人で並列。1 と 2b の後） | `nextjs-developer` × 2 | A（レポート）: `app/report/page.tsx`、`app/report/actions.ts`、`app/report/_report/*`（`input.ts` を含む）、`lib/report.ts`、`lib/queries/report.ts`、`lib/queries/report-notes.ts`。B（印）: `lib/queries/media.ts`、`lib/queries/media-detail.ts`、`app/media/_list/*`、`app/media/[id]/_detail/*`、`app/export/media/route.ts`（T22） |
| 4 | 本番に反映: `supabase db push` → main のマージ → Vercel の反映。`db push` は毎時 17 分ごろに動く収集を避けて行う（R5 D3）。順は DB が先（ビューと表がないと画面が落ちる）。翌朝の daily の `check-alerts` が `alerts=0`（または `no_history=`／`no_posts=` つき）で終わることを `/jobs` と GitHub Actions のログで確かめる | 親とユーザー | — |
| 5 | 受け入れ（7.3）、セキュリティレビュー（Server Action、権限と RLS、ログに率と人数が出ないこと）、ユーザーの画面の確認 | `quality-engineer`、`security-engineer`、ユーザー | — |

- 段階 1 と 2a と 2b は並べて進められる（ビューの列は 3.2 節、表は 5.1 節で決まっている。ワーカーは `account_daily_wide`、`media`、`profile_daily` しか読まないので、マイグレーションを待たずに書き始められる）
- 段階 3 の A と B は触るファイルが重ならない。共通の部品の変更が要るときは段階 3 の中では直さず、親に戻して 2b の担当がまとめて直す（部品の移動も 2b。T22）
- 担当 A の Server Action はセキュリティレビューを必ず通す（Web から書く 2 つ目の表）

---

## 9. 確認事項

| # | 問い | 推奨 |
|---|---|---|
| Q1 | ナビの位置 | 「期間比較」の次、「接続と収集ログ」の前（6.4 節） |
| Q2 | 比較対象の窓 | 同じ種類の直前 20 投稿（要件の例示のまま）。「過去 90 日」は頻度で件数が揺れるので採らない |
| Q3 | 伸びた投稿をメールでも知らせるか | R6 は画面の印とレポートまで。失敗メールは異常の通知の経路なので使わない（3.5 節） |
| Q4 | 2 節の「目標比」を出すか | 出さない。目標値の表も設定画面もない。目安値の設定（要件 7.4 章）を作る回に列を足す |
| Q5 | fence の係数と、シェア率が 0 に張り付く性質（3.1 節）の扱い | (a) **1.5 × IQR のまま受け入れる**（推奨）。Q3 = 0 の種類では印の意味が「同種の直前 20 件の 75% を超えるシェア率」になるが、規則は固定で、画面の説明も変えない。(b) 指標をリーチ率（最新のリーチ ÷ 投稿時のフォロワー数）に替える（0 に張り付かないが、収集開始前の投稿は `followers_at_post` が null で、判定も比較対象もできない）。段階 0 の「種類ごとに Q3 = 0 か」と受け入れの件数で決める。係数を上下で別にしない |
| Q6 | 判定に要る比較対象の最小の件数 | 8 件。四分位が意味を持つ最小の目安。それ未満は `peer_n` だけ出す |
| Q7 | 特殊な投稿（ブースト、コラボ、お試し）の扱い | `true` のものは比較対象から外し、自分の判定はする。**null（本番の全投稿）は比較対象に入れる**（3.6 節）。除外の設定は作らない |
| Q8 | 同じ事象で毎朝の失敗メールが来ることを抑止するか | R6 では抑止しない（既存の `token` と同じ）。`non_follower_reach_drop` は約 14 日続きうる（T5）。鳴ってから煩わしければ通知の履歴の表（`alert_events`）を R7 以降で作る |
| Q9 | `non_follower_reach_drop` のしきい値と式 | 直近 7 日 vs その前 28 日の合計ベースの比率で、**10 pt 以上**の低下（整数の交差乗算）。**直近 7 日に投稿（ストーリーズを除く）が 0 件なら判定しない**（推奨。投稿がない週の低下は推薦の兆候ではない。T6）。代案は相対（直近 ≤ 基準 × 0.5）。段階 0 で「7 日ごとの比率」と「投稿数」を並べて見て、決定だけを記録する |
| Q10 | 判定に要る日数 | 直近 5 日以上、基準 20 日以上。満たさなければ `no_history` |
| Q11 | `follower_drop` のしきい値 | 前日比で **10 人以上かつ 1% 以上**（両方。整数で判定）。親の案の「または」は小さなアカウントで鳴りすぎるので「かつ」にした |
| Q12 | `check-alerts` の daily が、その朝の `profile_daily` を見られる順か | **解消**: `collect.yml` は `run-daily` → `run-hourly` → `check-alerts` の順なので、同じ回の記録で判定できる（4.4 節） |
| Q13 | 記入欄の文字数の上限 | 2,000 コードポイント（3 行の総評と箇条書きの施策に十分）。超えたら「2,000 文字までです」 |
| Q14 | 選べる月に今月（途中）を含めるか | 含める。表示の期間は `clampPeriod` で `to` を最新の日に切り詰め、既存の切り詰めの注記を出す（切り詰めないと今月のフォロワー純増が常に —。T9 (1)）。既定は前月のまま |
| Q15 | 記入欄の同時編集 | 後勝ち。1 つのフォームで 2 欄を一緒に保存するので、別々の欄を編集していても後の人の 2 欄で上書きされる（巻き添え。T17）。版や排他は作らない（R5 のタグと同じ） |
| Q16 | 投稿一覧の CSV に印の列を足すか | 足す（`share_flag`、`peer_n` の 2 列。一覧の SQL に既に結合しているので安い）。既存の `lib/csv.ts` の逃がしを通し、null は空欄（S10） |
| Q17 | 判定の指標をシェア率 1 つに固定すること | 固定する。要件の「非フォロワーリーチ比率」は投稿単位では取れない（Meta のメディアのインサイトに内訳がない）。保存率は国内の目安（2〜3%）と比べる指標で分布の外れ値の意味が薄く、リーチ率は収集開始前の投稿で分母（`followers_at_post`）が null になり比較対象に入れられない。シェア率はフォロワー外への広がりに効く指標（要件 7.1 章）で、「伸びた」の意味に最も近い。0 に張り付く性質は Q5 で扱う |

---

## 付録 A 読んだ資料

親が 2026-10-12 に確かめた事実票（依頼文と版 0.2 の依頼文）と、次のファイル（行範囲つき）。Web ページは取っていない。

版 0.1:

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

版 0.2 で追加:

11. `apps/web/src/app/tags/edit/_edit/input.ts`: 全文（R5 の入力の検査と状態。U5）
12. `apps/web/src/components/TypeTag.tsx`: 全文（`SpecialTags`。U10）
13. `apps/web/src/components/charts/HBars.tsx`: 全文（U16）
14. `apps/web/src/lib/metric-definitions.ts`: 全文（`DAY_BOUNDARY_NOTE` と定義の置き場。U1、U21）

存在だけ Glob で確かめたもの（中身は読んでいない）: `apps/worker/src/db/*.ts`（`account-daily.ts`、`profile.ts` など 12 本）、`apps/web/src/components/**/*.tsx`（`PendingMark`、`PageHead`、`charts/*` など）、`apps/web/src/lib/queries/*.ts`（`tags.ts`、`media.ts`、`media-detail.ts` など）、`apps/web/test/db/*.ts`（`fixtures.ts`、`web-role.test.ts` など）、`apps/web/test/*.test.ts`（ナビのテストはない。`export-media.test.ts`、`csv.test.ts` はある）、`apps/web/src/app/**/page.tsx`、`apps/web/src/app/export/media/route.ts`、`apps/web/src/lib/csv.ts`。

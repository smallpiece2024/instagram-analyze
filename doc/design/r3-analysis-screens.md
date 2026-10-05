# R3 分析画面の設計

- 版: 0.4（2026-10-05）。実装前にユーザーの確認を受ける。確認事項は 11 章

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-05 | 起草 |
| 0.2 | 2026-10-05 | 3 本のレビュー（DB・SQL、セキュリティ、品質）の指摘を反映。経過時間の区分の許容幅（R-1）、日次の内訳の 0 と未取得の区別（R-2）、分位の n を指標ごと（R-3）、一覧の基準値を固定区分に（R-4）、スキップ率の単位（R-5）、日付の違いの明記（R-6）、対象アカウントの決め方（M1）、除外の設定の Server Action と Cookie（M2）、照合結果の置き場所（M3）、入力の検査（M4）、合計の比の欠損の扱い、「—」の理由の列挙、テストの道具と置き場所と担当、突き合わせの手順の具体化、ログに出さないもの、ロールバック SQL。レビューで確かめられた事実で「未確認」を置き換え、確認事項を統合して番号を振り直した |
| 0.3 | 2026-10-05 | 確認事項 Q1〜Q20 はすべて推奨どおりと回答を得た。親が `next.config`（`cacheComponents` なし、`Referrer-Policy: same-origin`）と照合の列（`accounts.ig_user_id`）を確かめて「未確認」を置き換えた |
| 0.4 | 2026-10-05 | ユーザーの決定（Q21）で、比較の基準に「最新の値（投稿から 30 日以上の投稿）」を足し、7 日時点と自動で切り替える（3.1 節「比較の基準」）。再レビューの指摘を反映: 日次の内訳の 0／null の判定を実データに合わせて直す、期間の終わりを `reach` のある最新の日にする、7 日時点の値が許容内にない場合は既存の理由 `no_baseline_data` に寄せる（ユーザーの指示で新しい理由は足さない）、`getMediaHorizons` が `within_tolerance` を返す、`getMediaBaseline` のテスト、`media_kind()` の `strict` を外す、ロールバックに R1 の定義を載せる。`reels_skip_rate` が 0〜100 であることを確認済みにした |
- 要件: `doc/requirements/requirements-definition.md` 4.4 章（F-UI-10〜11、F-UI-20〜29）、5.5 章、7 章、9 章、10 章
- デザイン: `doc/design-system.md`、`doc/design-lab/README.md`、`doc/design-lab/v3/render.js`（見本の描画）
- 既存: R1 のスキーマとビュー（`supabase/migrations/20261001100100_r1_collection.sql`、`20261001100400_r1_views.sql`）、R2 の `web_app` ロール（`20261002005926_r2_web_role.sql`）、`apps/web` の R1 画面

この文書で「未確認」と書いたものは、起草時に読んだ資料では確かめられなかった事実。実装の前に確かめる（多くは 11 章の確認事項にした）。

---

## 1. 目的と範囲

### 1.1 R3 でやること

| 区分 | 内容 | 要件 |
|---|---|---|
| 画面 | 概要、投稿一覧、投稿詳細、期間比較を R2.5 のデザイン（案 01「スタンダード・朱」）で作る | F-UI-20〜23 |
| 画面 | R1 の最小限の画面（`/`、`/jobs`、`/media`、`/connect`）をデザインシステムに合わせて作り直す。`/` は概要に替え、接続状態と収集ログは 1 画面にまとめる（2 章） | 9 章 |
| 指標 | 派生指標（保存率、シェア率、いいね率、ER、リーチ率、プロフィール遷移率、フォロー転換率、非フォロワーリーチ比率など）を計算して表示する。率には分母を明示する | F-UI-10、F-UI-11 |
| 共通 | 基準値（平均、中央値、上位 25%、下位 25%）、指標変更の注記、最終更新時刻、指標の定義のヒント | F-UI-24〜26、F-UI-29 |
| 出力 | 投稿一覧と日次指標の CSV | F-UI-27 |
| 特殊な投稿 | コラボ、お試しリール、ブーストの区別と集計からの除外。ただし 3 列は API で判定できず全件 null（R0 の P7）なので、R3 では今は何も変わらない。除外の設定を作るか見送るかは確認事項 Q4（8 章） | F-UI-28 |
| DB | 画面用のビューと関数を足すマイグレーション（手書き。4 章） | — |

### 1.2 R3 でやらないこと

- リール分析、カットと文字のタイムライン（R4、R4.1）。投稿詳細の「動画の長さ」「視聴維持率」は R4 で動画の長さを取るまで「—」にする。
- タグ分析、ストーリーズ、オーディエンス、投稿時刻の分析（R5）。月次レポート（R6）。
- 投稿一覧の絞り込み（F-UI-21 で置かないと決定済み）。特殊な投稿の除外（F-UI-28）は、作るなら全画面共通の表示設定にする（8 章、確認事項 Q4）。
- 収集の「今すぐ収集」ボタン（見本の接続と収集ログ画面にある）。GitHub Actions の起動に別の資格情報が要るため R3 では作らない（確認事項 Q17）。
- 目安値の設定画面（要件 7.4。R3 では保存率の目安 2〜3% を定数で表示する。確認事項 Q15）。
- 管理者と閲覧者の区別（F-SYS-16。ログインした本人と共有のもう 1 人は同じ権限）。

---

## 2. 画面の一覧と URL、ナビゲーション

### 2.1 画面と URL

| 画面 | URL | 種類 | R1 からの変更 | 要件 |
|---|---|---|---|---|
| 概要 | `/` | ページ | `/`（接続状態）を置き換える | F-UI-20 |
| 投稿一覧 | `/media` | ページ | 作り直す | F-UI-21 |
| 投稿詳細 | `/media/[id]` | ページ | 新規 | F-UI-22 |
| 期間比較 | `/compare` | ページ | 新規 | F-UI-23 |
| 接続と収集ログ | `/jobs` | ページ | R1 の `/`（接続状態）と `/jobs`（収集ログ）を 1 画面にまとめる（見本の「接続と収集ログ」） | 9 章 |
| 接続設定 | `/connect` | ページ | 見た目だけ作り直す。トークンを入れる処理は変えない | 9 章 |
| ログイン | `/login` | ページ | 見た目だけ作り直す | R2 |
| 投稿一覧の CSV | `/export/media` | Route Handler（GET） | 新規 | F-UI-27 |
| 日次指標の CSV | `/export/daily` | Route Handler（GET） | 新規 | F-UI-27 |

- 画面の状態（期間、並べ替え、ページ）は URL のクエリに持たせる（`?range=30`、`?sort=reach&order=desc&page=2` など）。共有や再読み込みで同じ表示になり、Server Component だけで描ける。
- CSV は `page.tsx` と同じ階層に `route.ts` を置けない（Next.js 16 の Route Handlers の文書「Route Resolution」）ため、`/export/` の下に分ける。
- R2 の proxy の matcher は `"/((?!_next/static|favicon\\.ico).*)"` で、`/export/*`、`/media/[id]`、`/compare`、Server Action の POST はすべて proxy を通る（未ログインは 303 で `/login` へ、許可外は 403）。新しい URL のために proxy を変える必要はない。ページと Route Handler と Server Action の中でも `checkAccess` を呼び、二重に守る（7 章、8 章）。

### 2.2 ナビゲーション

- 上部のバーに、ブランド（アカウント名）と、ナビ「概要」「投稿一覧」「期間比較」「接続と収集ログ」を置く。ログアウトはバーの右端。投稿詳細はナビに出さず、一覧から移る（現在位置は「投稿一覧」にする）。
- 現在位置は `aria-current="page"` を付け、`--color-nav-active` の文字色と `--nav-active-decor`（下に朱の 2px の線）で示す。
- モバイル（700px 以下）は、R2.5 の `lab.css` の決定どおり、項目を文字幅に合わせて折り返す複数段のタブにする（横スクロールやハンバーガーメニューにしない）。R3 のナビは 4 項目なので、多くの端末で 1〜2 段に収まる。
- ナビは R2 の決まりのとおり、本人（`checkAccess` が `pass`）にだけ出す。ログアウトはログイン済みなら誰にでも出す。
- R1 の `/`（接続状態）を開いていたブックマークは概要に変わる。接続状態は `/jobs` で見る（確認事項 Q1）。

---

## 3. 画面ごとの設計

### 3.1 共通

#### 用語と種類

| 画面の表記 | 条件（`media`） | 系列の色 |
|---|---|---|
| フィード | `media_product_type = 'FEED'` かつ `media_type <> 'CAROUSEL_ALBUM'` | `--chart-1` |
| カルーセル | `media_product_type = 'FEED'` かつ `media_type = 'CAROUSEL_ALBUM'` | `--chart-2` |
| リール | `media_product_type = 'REELS'` | `--chart-3` |
| ストーリーズ | `media_product_type = 'STORY'` | `--chart-4` |

この対応は DB の関数 `public.media_kind()`（4 章）に 1 か所で持たせ、画面と CSV が同じ区分を使う。R3 の画面はストーリーズを扱わない（概要の種類の内訳を除く）。

#### 派生指標（要件 7 章）

| 指標 | 式 | 分母の表示 | 取れない種類、出せないとき |
|---|---|---|---|
| ER（エンゲージメント率） | (いいね + コメント + 保存 + シェア) ÷ リーチ | 「分母: リーチ」。分母の切り替え（閲覧数、フォロワー数）は 3.2 と 3.3 | — |
| 保存率 | 保存 ÷ リーチ | 分母: リーチ | — |
| シェア率 | シェア ÷ リーチ | 分母: リーチ | — |
| いいね率 | いいね ÷ リーチ | 分母: リーチ | — |
| コメント率 | コメント ÷ リーチ | 分母: リーチ | — |
| リーチ率 | **常に 7 日時点**のリーチ ÷ 投稿したときのフォロワー数（要件 7.1 の定義。比較の基準が「最新の値」のときも 7 日時点のまま） | 分母: 投稿時のフォロワー数 | 投稿から 7 日未満（`not_yet`）、7 日時点の値が許容幅の外か投稿時のフォロワー数の記録がない（`no_baseline_data`。どちらの基準でも「—」。Q11） |
| プロフィール遷移率 | プロフィール訪問 ÷ リーチ | 分母: リーチ | リール |
| フォロー転換率 | フォロー ÷ プロフィール訪問 | 分母: プロフィール訪問 | リール |
| 閲覧数／リーチ | 閲覧数 ÷ リーチ | — | — |
| 視聴維持率 | 平均視聴時間 ÷ 動画の長さ | — | フィード、カルーセル。R3 ではリールも「—」（動画の長さは R4） |
| スキップ率 | API の `reels_skip_rate`。API の単位は percent なので、ビューで 100 で割って 0〜1 にそろえる（4.3 節）。実値は 0〜100 の単位（実データで 28.6〜49.4）で、/100 は正しい（確認済み） | — | フィード、カルーセル |
| 非フォロワーリーチ比率 | 非フォロワーのリーチ ÷ 分母（アカウント単位。分母は確認事項 Q9） | 分母を明示 | 内訳が未取得の日 |

- 分母が 0 または null の率は「—」にする（0% と書かない）。
- 率の前期間比はポイント差（例: 2.0% → 3.0% は +1.0 pt）、件数は増減率（%）にする（F-UI-20）。前期間の値が 0 または null の件数の増減率は出さず「前期 0」と書く。フォロワー純増は人数の差にする案がある（確認事項 Q8）。

#### 「—」の理由

値を出せないときは「—」を出し、理由をヒントに書く。理由は列挙型 `MissingReason` で持ち、部品は理由から文言を決める（文言を画面ごとに書かない）。

| 理由 | 意味 | 判定 | ヒントの文言の例 |
|---|---|---|---|
| `unsupported` | その種類では API で取れない | 種類の規則（上の表の右端の列） | 「この種類では API で取れない」 |
| `missing` | 取れるはずが取れなかった（欠損） | 種類の規則では取れるのに値が null | 「取得できなかった」 |
| `not_yet` | まだその時点に達していない | 経過時間が区分に届いていない。7 日時点の値は `elapsed_latest` < 7 日のとき、最新の値の基準は `elapsed_latest` < 30 日のとき | 「—」だけ（説明の文言は付けない） |
| `no_baseline_data` | 計算に要る記録がない | 投稿時のフォロワー数の記録がない、分母が 0、`elapsed_latest` ≧ 7 日なのに 7 日時点の値が許容内にない | 「投稿時のフォロワー数の記録がない」「計算に要る記録がない」 |

判定の順は `unsupported` → `not_yet` → `no_baseline_data` → `missing`。判定は `lib/metrics.ts` の 1 か所に置く。収集開始より前の投稿のための専用の理由や説明の文言は作らない（2026-10-05 のユーザーの指示）。7 日時点の値が許容内にない投稿は、7 日時点の比較の対象に入らないだけで、画面に専用の説明を出さない。

スナップショットの JSON は、取れない指標はキーなし、取得の失敗は値 null。`metric_value()` はどちらも null を返すので、`unsupported` と `missing` は DB の値ではなく種類の規則で分ける（`follows` と `profile_visits` はフィード（カルーセルを含む）だけ、`ig_reels_avg_watch_time`、`ig_reels_video_view_total_time`、`reels_skip_rate` はリールだけ）。

#### 基準値（F-UI-24）

- 比べる母集団は「同じ種類の投稿」。削除やアーカイブで消えた投稿（`gone_at` あり）も含める（R1 の方針「データは残す」。消えるまでの値は実績なので）。特殊な投稿の除外の設定（8 章）を作れば、それが効く。
- 値は、下の「比較の基準」で決めた値を使う。7 日時点の基準では**実際の経過時間が許容幅に入るものだけ**を使う（4.3 節。収集前からある投稿や収集が止まった投稿の、生涯や 25 日目の値が「7 日」に混ざらないように）。
- 出す値は平均、中央値、上位 25%（75 パーセンタイル）、下位 25%（25 パーセンタイル）。分位は `percentile_cont`（線形補間）で計算する。
- 件数（n）は**指標ごと**に数えて添える（同じ母集団でも、指標によって null の投稿があるため。例: リーチは 12 件、リーチ率は 5 件）。n によって出し方を変える。

| n（その指標で値のある比較相手の数） | 出し方 |
|---|---|
| 0 | 「比べられる投稿がありません」。帯グラフの線、帯、中央値を描かない |
| 1〜2 | 最小〜最大の線と中央値だけ描き、帯（25〜75%）は描かない。「同じ種類の投稿が n 件のため範囲を出さない」と注記 |
| 3〜9 | 帯と中央値を出すが、`opacity` を下げて薄く描き「n = 7（少ないので目安）」と添える（README のグラフの決まり「件数が少ない区分は薄く表示し、件数を添える」） |
| 10 以上 | 通常の表示 |

本番は投稿 24 件程度で、種類ごとに分けると 1 種類あたり数件〜十数件になる（カルーセルはまだない）。R3 の開始時点では多くの比較が「薄い表示」になる前提で作る。

#### 比較の基準（Q21。2026-10-05 にユーザーが採用）

実データでは、収集開始（2026-10-01）より前の投稿 24 件が 1h〜7d の全区分で許容幅を外れ（30d は 1 件、90d は 3 件だけ許容内）、投稿時のフォロワー数の記録も 24 件中 0 件だった。7 日時点だけで比べると、基準値、帯グラフ、リーチ率がすべて「—」になる。そこで比較の基準を 2 つ持ち、自動で選ぶ。

| 基準 | 使う値 | 画面の表記 |
|---|---|---|
| 7 日時点 | `media_horizon_metrics` の `horizon = '7d'` かつ `within_tolerance` | 「投稿から 7 日時点で比較」 |
| 最新の値 | `horizon = 'latest'` かつ `elapsed_seconds >= 2592000`（投稿から 30 日以上たった投稿の最新のスナップショット） | 「最新の値で比較（投稿から 30 日以上の投稿）」 |

- **選び方**: 比較相手のうち、7 日時点の値が許容内の投稿が 3 件以上（n の表で帯を出せる数）あれば「7 日時点」、なければ「最新の値」。数えるのは指標ごとではなく、`7d` の行が許容内の投稿の数。利用者の切り替えは置かない。
- **当てはめる範囲**: 投稿詳細（比較相手は同じ種類。自分の値も同じ基準で取る）、投稿一覧の `tfoot`（全投稿）、期間比較の投稿の基準値の表（期間ごと）。それぞれの母集団で選ぶ。
- **自分の値**: 「最新の値」の基準のとき、自分が投稿から 30 日未満なら、自分の値は「—」（`not_yet`）にし、帯と中央値だけを描く。
- **表示**: どちらの基準で比べたかを、カードの見出しの横（投稿詳細）、`tfoot` の見出し（投稿一覧）、表の下（期間比較）に必ず書く。「最新の値」のときは、ヒントに「7 日時点の値が許容内の投稿が n 件しかないため」と理由を書く。
- **リーチ率**はどちらの基準でも 7 日時点の定義のまま（3.1 節の表）。投稿時のフォロワー数の記録がない投稿は「—」（Q11）。今の実データでは全件が「—」になる。
- **当面の見込み**: 収集開始（2026-10-01）より後の投稿がたまるまで、7 日時点の比較は使えない（ほとんどの母集団で「最新の値」が選ばれる）。収集開始後の投稿が種類ごとに 3 件を超え、投稿から 7 日を過ぎたものから、7 日時点に切り替わる。

#### 最終更新時刻と古いデータの警告（F-UI-26）

- ページの見出しの下に「最終更新 2026-10-05 08:30」を出す。値はその画面が使うデータの取得時刻の最大値（概要: `account_daily_metrics.fetched_at` と `media_insight_snapshots.fetched_at`、投稿一覧と詳細: スナップショットの `fetched_at`）。
- カードごとにデータの時点と日付の区切りが違うので、カードの下に必ず書く。例: 「日次指標: 2026-10-04（米国太平洋時間の日付）まで・取得 2026-10-05 08:30」「フォロワー数: 2026-10-05（日本時間の日付）の記録」。
- 投稿ごとの指標は「最新の取得 2026-10-05 08:30（投稿から 12 日）」を投稿詳細に出す。投稿一覧では取得時刻の列は出さず、CSV に入れる。
- **古いデータの警告**: 日次指標の最新の日（`reach` のある最新の日。3.2 節）が、太平洋時間の今日から数えて N 日より前なら、概要と期間比較の見出しの下に `callout`（`data-state="warn"`）で「日次指標が 2026-10-01 で止まっています」と `/jobs` へのリンクを出す。N は確認事項 Q10（推奨 3 日）。

#### 指標変更の注記（F-UI-25）

- 定義が変わった日は `metric_definitions` の `available_from`、`deprecated_on`、`successor` から読む（4.6 節）。日次グラフの X 軸の範囲にその日が入るときだけ、縦の破線（`--chart-ref`）とラベル「指標変更」を描く。表では、その日より前の投稿の閲覧数のセルに「*」を付け、表の下に注記を書く。
- 本番の日次指標は約 400 日分（2025 年 8 月下旬ごろから）で、2025-04-21 は日次グラフの範囲に入らない見込み。投稿が 2025-04-21 より前にあれば一覧と詳細の注記が出る。

#### 指標の定義のヒント（F-UI-29）

- 指標名を `MetricHint` 部品で包む。マウスを乗せる、フォーカスする、タップするとポップアップで定義を出す。文言は「計算式、分母、API で取れない範囲」を 1〜2 文で書く（4.6 節）。
- 実装: ボタン要素（`type="button"`、点線の下線、`cursor: help`）に、HTML の `popover` 属性のポップアップを結び付ける。タップとクリックは `popovertarget` で JS なしに開閉でき、マウスを乗せたときの表示だけを小さな Client Component で足す。`title` 属性はスマートフォンで出ないので使わない（見本の `title` は置き換える）。
- ヒントの文言は文字として描き、HTML として解釈しない（`dangerouslySetInnerHTML` を使わない）。

#### 空のとき、エラーのとき（全画面共通）

| 状態 | 表示 |
|---|---|
| 対象のアカウントが決まらない（`META_TARGET_IG_USER_ID` が未設定、または一致する `accounts` の行がない） | 「対象のアカウントが設定されていません」と `/connect` へのリンク。ほかのアカウントを代わりに選ばない（4.1 節） |
| データがまだない（収集前） | カードごとに「まだ収集されていません」と `/jobs` へのリンク |
| DB に接続できない、クエリが失敗した | 既存の `QueryResult` と `describeDbError` の形を引き継ぐ。カードの中に `callout`（`data-state="bad"`）で「読み出せません（理由）」。1 枚のカードの失敗でほかのカードを止めない（4.5 節） |
| 想定外の例外 | ルートの `error.tsx` で「表示できませんでした」と再読み込みのボタン。例外の文面は画面に出さない |
| 存在しない投稿 ID、形の合わない ID | `notFound()` で 404 |
| クエリの値が不正（期間、並べ替え、ページ、絞り込み） | 既定の値に戻して表示する（4.7 節）。日付の入力だけは入力欄の下に理由を出す |

---

### 3.2 概要（`/`）

見本: `render.js` の `SCREENS.overview`。

#### 期間

- クエリ `?range=7|30|90`（既定 30。ほかの値は既定に戻す）。期間の終わりは「日次指標がそろっている最後の日」（`account_daily_wide` の `max(metric_date) filter (where reach is not null)`。太平洋時間の日付。今日の日付を起点にしない。実データでは最新の日に `follower_count` の行しかなく `reach` が null の日があるため、単純な `max(metric_date)` にしない）、始まりはそこから `range - 1` 日前。比較する前期間は、その直前の同じ日数。
- 見出しの下に「過去 30 日（2026-09-05 〜 2026-10-04、日付は米国太平洋時間）・最終更新 …」。
- 期間の中で日次指標がそろっている日数を「30 日中 28 日分」と書く（欠けがあるとき）。前期間も同じ。
- 期間の切り替えは `<select>` ではなく、3 つのリンク（チップ）にする（JS なしで動き、現在の値に印を付ける）。

#### 数字タイル（6 枚）

| タイル | 値 | 前期間比 | 補足（タイルの下の小さな文字） | データと日付 |
|---|---|---|---|---|
| リーチ | 期間の日別リーチの合計 | 増減率 % | 「日別の合計（期間の重複を除いた人数ではない）」 | 日次指標（太平洋時間） |
| 閲覧数 | 期間の日別閲覧数の合計 | 増減率 % | 「前期 n」 | 日次指標（太平洋時間） |
| フォロワー純増 | 期間末の記録 − 期間初めの前日の記録（下の「純増の端の記録」） | 確認事項 Q8 | 「現在 n・日本時間の記録」 | `profile_daily`（日本時間） |
| エンゲージメント率 | 期間中に投稿した投稿の (いいね + コメント + 保存 + シェア) の合計 ÷ リーチの合計 | ポイント差 pt | 「分母: リーチ・期間中の投稿 n 件中 m 件で計算」 | 投稿の最新の指標（投稿日時は日本時間） |
| 保存率 | 期間中に投稿した投稿の保存の合計 ÷ リーチの合計 | ポイント差 pt | 「分母: リーチ・n 件中 m 件・目安 2〜3%（出典と年）」 | 同上 |
| プロフィール訪問（参考） | 期間中に投稿したフィードとカルーセル（とストーリーズ）の投稿単位のプロフィール訪問の合計 | 増減率 % | 「フィードとストーリーズの投稿単位の合計。リールとアカウント全体は含まない」 | 同上 |

- **合計の比の欠損**: ER と保存率の「合計の比」は、分子に使う指標と分母（リーチ）が**どれも null でない投稿だけ**で計算する（ある投稿のリーチだけが分母に入って保存が null だと、率が下がるため）。計算に使った件数を「期間中の投稿 n 件中 m 件で計算」と書く。m = 0 なら「—」。
- リーチの合計は、日ごとのユニーク数を足したものなので期間のユニーク数より大きい（確認事項 Q5）。
- ER と保存率を合計の比にするか、投稿ごとの率の中央値にするかは確認事項 Q6。
- **ER の分母の切り替え**（F-UI-11）: ER タイルの下に「リーチ／閲覧数／フォロワー数」の 3 つのリンク（`?er=reach|views|followers`。ほかの値は `reach`）。フォロワー数を分母にした「期間の反応の合計 ÷ 期間末のフォロワー数」は投稿数に比例して大きくなり、期間どうしで比べられない。推奨は「1 投稿あたり」（期間の反応の合計 ÷ m ÷ 期間末のフォロワー数）にする（確認事項 Q7）。
- 期間中の投稿が 0 件のとき、ER、保存率、プロフィール訪問のタイルは「—」と「期間中の投稿なし」。前期間の投稿が 0 件のときは前期間比を出さない。
- **純増の端の記録**: 期間末の記録は、`profile_daily` のうち `captured_on` が期間の終わりの日以前で最も新しいもの、期間初めの記録は、期間の始まりの前日以前で最も新しいもの（期間の日付は太平洋時間、`captured_on` は日本時間の日付だが、同じ日付の値として比べる。6 章）。どちらも、指定の日から 1 日を超えて離れていれば使わず「—」にし、「記録は 2026-09-xx から」と書く。
- 日次指標の `follower_count` は 1 日ごとの新規フォロワー数で、直近 30 日分しかなく遡って取れない（バックフィル対象外）。純増の代わりにも、30 日を超える期間の集計にも使わない。

#### リーチとフォロワー数の日次推移（8 列のカード）

- 上段: リーチの日次の棒（`--chart-1`、データ端 4px の角丸）。最大の日に数値ラベル。軸は太平洋時間の日付（カードの下に明記）。
- 下段: フォロワー数の折れ線（`profile_daily` の値。日本時間の日付。カードの下に明記）。右端に現在の数。上段と X 軸をそろえる（6 章）。
- 投稿のあった日に ▲（`--chart-marker`）を X 軸の下に描く。投稿日時は**太平洋時間の日付に直して**置く（グラフの軸が太平洋時間の日付のため。変換は SQL の 1 か所。6 章）。
- 指標変更の日が範囲に入れば縦の破線（3.1 節）。
- 日次指標が範囲の途中で欠けている日は棒を描かず、X 軸の下に小さく「欠け」を示す（0 の棒と区別する）。
- 件数が少ないとき: 日次指標が `range` より少ない日数しかなければ、ある分だけ描き「2026-09-20 から 15 日分」と書く。`profile_daily` は R1 の収集開始からしかないので、下段は右寄りの短い線になる。

#### 投稿の種類の内訳（4 列のカード）

- 100% 積み上げ棒 3 行（投稿数、リーチ、保存）と表。期間中に投稿したもの（日本時間の日付）を数える。ストーリーズの保存は API にないので「—」。
- 系列の色は 3.1 節の固定の順。種類が 0 件でも凡例から消さない（色を塗り替えない）。
- 件数が少ないとき: 期間中の投稿が 3 件未満なら棒を描かず、表だけにする。

#### 注記

- ページの下に見本の `PT_NOTE`（日次指標の日付は米国太平洋時間、投稿単位とフォロワー数は日本時間）を出す。

---

### 3.3 投稿一覧（`/media`）

見本: `render.js` の `S["media-list"]`。

#### 表示

- 見出し「投稿一覧」、補足「全 24 件・最終更新 …」、右に「CSV」ボタン（`/export/media` へのリンク。並べ替えの条件を引き継ぐ）。
- PC（701px 以上）は表、スマートフォンはカードの並び（見本の `media-cards`）。同じ HTML に両方を出して CSS で切り替える（見本の `only-d`／`only-m`）。

| 列 | 内容 | 並べ替えのキー | スマートフォンのカード |
|---|---|---|---|
| （サムネイル） | 署名付き URL の画像（R1 と同じ `signThumbnailUrls`。`next/image` は使わない）。押すと詳細へ | — | 出す |
| 投稿 | キャプションの 1 行目の先頭 40 文字（題名。`Array.from` で文字単位に切り、サロゲートペアを割らない）。押すと詳細へ。キャプションがなければ「（キャプションなし）」 | — | 出す |
| 種類 | 種類のタグ。特殊な投稿のタグ（値が true のときだけ） | — | 出す |
| 投稿日時 | 日本時間 `2026-10-05 10:00`。最新の取得が投稿から 7 日（604,800 秒）未満なら「計測中」の小さなタグ | `posted`（既定、新しい順） | 出す |
| リーチ | 最新の値 | `reach` | 出す |
| 閲覧数 | 最新の値。2025-04-21 より前の投稿は「*」 | `views` | 出さない |
| いいね | 最新の値 | `likes` | 出さない |
| 保存 | 最新の値 | `saved` | 出す |
| 保存率 | 保存 ÷ リーチ | `save_rate` | 出す |
| シェア率 | シェア ÷ リーチ | `share_rate` | 出さない |
| ER | ER（分母は概要と同じ切り替え。既定はリーチ） | `er` | 出す |
| プロフ訪問 | リールは「—」 | `profile_visits` | 出さない |

- 題名にキャプションを使うかは確認事項 Q12（R1 の一覧はキャプションを画面に出さない方針だった）。
- 行の指標は「最新のスナップショット」の値。投稿からの日数が違う投稿を並べることになるので、表の下に「指標は最新の取得時点の値。投稿から日が浅い投稿は小さく出る」と注記する。

#### 並べ替えとページ

- クエリ `?sort=<キー>&order=asc|desc&page=<n>`。キーは上の表の固定の対応表（キー → ビューの列名）で列名に変え、表にないキーは既定（`posted` の `desc`）に戻す。`order` は `asc`／`desc` 以外を `desc` にする。`page` は `^\d{1,6}$` に合う 1 以上の数だけを受け付け、それ以外は 1。
- null は並べ替えの向きによらず最後（`nulls last`）。同じ値のときは `posted_at desc, media_id desc` で順を固定する。
- 列の見出しはリンクにし、押すたびに降順 → 昇順を切り替える。現在の列に `aria-sort`。
- 1 ページ 50 件。総件数を数えてページ番号を出す（`‹ 前へ 1 2 3 … 24 次へ ›` と「1〜50 件目（全 n 件）」）。総件数が 50 件以下なら、ページ送りは出さず「全 24 件」だけ書く。範囲外のページ番号は「このページには投稿がありません」と 1 ページ目へのリンク。

#### 基準値の行（F-UI-24）

- 表の `tfoot` に「中央値」「平均」「上位 25%」「下位 25%」の 4 行を置く（全投稿。種類別にはしない。種類別の比較は投稿詳細で行う）。
- 基準値は行の値（全投稿の最新の値）では計算しない（投稿ごとに経過時間が違うため）。3.1 節「比較の基準」で選んだ基準（全投稿を母集団にして選ぶ）の値で計算し、`tfoot` の見出しに「投稿から 7 日時点の値（n は列ごと）」または「最新の値（投稿から 30 日以上の投稿。n は列ごと）」と明記する。列ごとに n を添える（3.1 節）。
- 特殊な投稿の除外の設定があれば効く。削除済みの投稿も含める。スマートフォンのカードの並びには出さない。

#### 空、エラー

- 投稿が 0 件: 「投稿がまだ収集されていません」と `/jobs` へのリンク。表の枠は出さない。
- `gone_at` のある投稿（削除やアーカイブ）は薄く表示し、「消えた」の小さなタグを付ける（基準値には含める）。

---

### 3.4 投稿詳細（`/media/[id]`）

見本: `render.js` の `S["media-detail"]`。

#### 構成（上から。F-UI-22 の順）

1. パンくず（投稿一覧 › 題名）と見出し。
2. **投稿の情報**: 大きいサムネイル（一覧と同じ `signThumbnailUrls`）、種類のタグと特殊な投稿のタグ、投稿日時（日本時間）、最終更新（最新のスナップショットの取得時刻と「投稿から n 日」）、題名、キャプション全文、Instagram で開くリンク。
   - キャプションは文字の子要素として描き、`white-space: pre-wrap` で改行を保つ。`dangerouslySetInnerHTML` は使わない。
   - Instagram へのリンクは既存の `isInstagramPermalink` で検査し、`target="_blank" rel="noopener noreferrer"` を付ける。
3. **量の指標**（6 列のカード）と **質の指標**（6 列のカード）。PC では横に並べ、スマートフォンでは縦に積む。
4. **リーチの伸び方**（12 列のカード）。

フィード、カルーセル、リールで同じ項目を同じ順に並べ、その種類で取れない項目は「—」と理由（3.1 節）にする。

#### 量の指標と質の指標の帯グラフ

| カード | 行（この順） |
|---|---|
| 量の指標 | リーチ、閲覧数、いいね、保存、シェア、プロフィール訪問、フォロー、平均視聴時間 |
| 質の指標 | リーチ率、保存率、シェア率、いいね率、ER、視聴維持率、スキップ率 |

- 1 行は「指標名（ヒント付き）・この投稿の値（右寄せ）・帯グラフ」。帯グラフは、線 = 同じ種類の最小〜最大、帯 = 25〜75%、縦線 = 中央値（`--chart-ref`）、点 = この投稿（種類の色、8px 以上、面の色の縁取り）。目盛は行ごと。右ほどよい側で、スキップ率だけ向きを逆にする（カードの下に注記）。
- 下位 25%、中央値、上位 25% と n は SVG の `<title>` とヒントで出す（画面の数字はこの投稿の値だけ。各指標は画面に 1 回だけ）。
- **比べる基準**: 3.1 節「比較の基準」で、同じ種類の比較相手（この投稿を除く）を母集団にして「7 日時点」か「最新の値」を選ぶ。自分の値も同じ基準で取る。カードの見出しの横に「投稿から 7 日時点で比較」または「最新の値で比較（投稿から 30 日以上の投稿）」と書き、この投稿の値の実際の経過時間（例: 「実際は 7 日 3 時間時点」「投稿から 412 日時点」）をヒントに出す。
  - 「7 日時点」の基準で、この投稿が 7 日未満なら、この投稿が到達した最大の区分（24h、3d など）で比べ、比較相手もその区分の許容内の値を使う（カードの見出しを「投稿から 3 日時点で比較」にする）。
  - この投稿の値が取れなければ点を描かず「—」と理由（最新の値の基準で 30 日未満なら `not_yet`、7 日時点の基準で自分の 7 日時点の値が許容内にないなら `no_baseline_data`）。
- 比較相手は同じ種類（3.1 節）で、選んだ基準の値がある投稿。この投稿自身は母集団から除く。n は指標ごとに数える。件数による出し方は 3.1 節の表に従う。
- **リーチ率**は常に 7 日時点（`media_list_metrics.reach_rate`）で、比較の基準によらない。この投稿が 7 日未満なら「—（7 日経過後に表示）」（`not_yet`）、7 日時点が許容外なら `no_baseline_data`。比較相手の分位も `media_list_metrics.reach_rate` で計算する。投稿時のフォロワー数は、投稿日時より前（`captured_at <= posted_at`）で 3 日以内の `profile_daily` の記録を使う。記録がない投稿（R1 の収集開始より前の投稿）は「—」と「投稿時のフォロワー数の記録がない」。本番の 24 件の多くはこれに当たる見込み（確認事項 Q11）。
- 平均視聴時間は API の値（ミリ秒）を秒に直して表示する。視聴維持率は R4 まで「—」と「動画の長さは R4 で取得」。スキップ率はビューで 0〜1 にそろえた値を % で表示する。

#### 投稿単位のファネル（フィードとカルーセル）

- F-UI-22 に「投稿単位のファネル（フィードとストーリーズのみ）」があるが、同じ要件に「各指標は画面に 1 回だけ出す」もあり、リーチ → プロフィール訪問 → フォローの段を描くと量の指標と重なる。案: ファネルのカードは置かず、プロフィール遷移率とフォロー転換率を質の指標の末尾に 2 行足す（リールは「—」）。確認事項 Q14。

#### リーチの伸び方

- X 軸は経過時間の区分（1 時間、3 時間、6 時間、24 時間、3 日、7 日、30 日、90 日）を等間隔に置く。Y 軸はリーチ（1 軸）。
- この投稿の線（種類の色、2px、点付き、右端に最新の値）、同じ種類の中央値（破線）、25〜75% の帯。区分ごとに許容幅に入る値だけを使う。`getMediaHorizons` が区分ごとに `within_tolerance` と実際の経過時間を返し、偽の区分は点を描かず線を切る。説明の文言は添えない（収集開始前の投稿のための文言は増やさない。2026-10-05 ユーザー）。
- 収集開始より前の投稿は、ほとんどの区分が許容外で線がほぼ描かれないが、専用の説明は出さない（3.1 節の「—」の理由の注記）。
- グラフの上に 2 つの数字（基準は量の指標と同じ。「最新の値」の基準なら最新の値どうしで比べる）:
  - 「中央値に対する倍率」= この投稿の値 ÷ 同じ区分の中央値（小数 1 桁）。中央値が 0、または n = 0 なら「—」。
  - 「同じ種類の中で上位 n%」: 順位 k = 1 + （この投稿より値が**大きい**比較相手の数）（同じ値は同じ順位）、母数 m = 比較相手の数 + 1（自分を含む）、表示は「上位 ⌈k ÷ m × 100⌉%（m 件中 k 位）」。m = 1（比較相手なし）なら「—」。
- 90 日の区分は今のビューにない（`30d` まで）。足すかは確認事項 Q16。
- この投稿がまだ到達していない区分は線を描かない（点線で延ばさない）。
- 件数が少ないとき: 比較相手が 0 件なら、この投稿の線だけと「比べられる投稿がない」。

#### 空、エラー

- ID は `^\d{1,25}$`（Instagram のメディア ID は数字）に合うものだけを受け付ける。合わなければ、または該当がない、ストーリーズ、対象のアカウントのものでないなら `notFound()`。
- スナップショットが 1 件もない: 投稿の情報だけ出し、ほかのカードは「指標はまだ取得されていません」。

---

### 3.5 期間比較（`/compare`）

見本はない（R2.5 の見本画面に期間比較はない）。概要の部品（数字タイル、日次の折れ線、表）と、概要と共通の期間集計の関数（`lib/queries/period-summary.ts`。10 章の段階 0）を組み合わせて作る。

#### 期間の指定

| プリセット | 期間 A（新しい方） | 期間 B（比べる方） |
|---|---|---|
| 前 7 日 | 最新の日（`max(metric_date)`）までの 7 日 | その直前の 7 日 |
| 前 30 日 | 最新の日までの 30 日 | その直前の 30 日 |
| 前月 | 最新の日を含む月の前の月（暦月、1 日〜末日） | その前の月 |
| 前年同月 | 最新の日を含む月の前の月 | その 1 年前の同じ月 |

- 任意の期間: `<form method="get">` に 4 つの日付入力。クエリは `?preset=7d|30d|month|yoy` か `?a=2026-09-01..2026-09-30&b=2026-08-01..2026-08-31`。
- 入力の検査（4.7 節）: 日付は `YYYY-MM-DD` の形で、暦として正しい日（2026-02-30 を拒む）、開始 ≦ 終了（同じ日の 1 日の期間は許す）、期間の長さ 366 日以内。最新の日より後の日付は最新の日に切り詰めて「2026-10-04 までのデータで表示」と書く。データの始まりより前を含む期間はそのまま受け付け、ある分の日数を書く。検査に通らなければ入力欄の下に理由を出し、既定（前 30 日）で表示する。`preset` の不明な値は既定にする。
- 日付は太平洋時間の日付（日次指標の日付）として扱い、フォームの横に注記する。投稿単位の値は、投稿日時の日本時間の日付で期間に入れる（6 章）。

#### 表示

1. **主要指標の表**: 行 = リーチ（日別合計）、閲覧数（日別合計）、フォロワー純増、非フォロワーリーチ比率、投稿数（種類別）、ER、保存率、シェア率、プロフィール訪問（参考）。列 = A、B、差（件数は %、率は pt、純増は確認事項 Q8）。差の色は増が `--color-pos`、減が `--color-neg`、変化なしが `--color-neutral`（記号 ▲▼ も付け、色だけに頼らない）。合計の比は 3.2 節と同じく欠損のない投稿だけで計算し「n 件中 m 件」を書く。行ごとの日付の区切り（太平洋時間／日本時間）を表の下に書く。
2. **日次の重ね合わせ**: リーチの日次を、期間の 1 日目をそろえて A（`--color-primary`、実線）と B（`--color-neutral`、破線）の折れ線で重ねる。X 軸は「1 日目、2 日目…」、ヒントに実際の日付。日数が違うときは長い方に合わせ、短い方は途中で終わる。
3. **投稿の基準値の表**（F-UI-24）: A と B のそれぞれの期間に投稿した投稿について、3.1 節「比較の基準」で期間ごとに選んだ基準の値で、リーチ、保存率、ER の平均、中央値、上位 25%、下位 25% と、指標ごとの n。どちらの基準かを表の下に期間ごとに書く。種類別のタブは置かず、表の下に種類ごとの件数を書く。

#### 件数が少ないとき、空のとき

- 期間の日次指標が欠けている日があれば「A: 30 日中 28 日分」のように表の下に書き、合計は「ある日の合計」と注記する。
- B の期間がデータの範囲より前なら、B の列を「—」にし「この期間の日次指標はありません（日次指標は 2025-08-xx から）」。
- 期間中の投稿が 0 件なら、投稿の基準値は「期間中の投稿なし」。n が 1〜2 なら平均と中央値だけ出し、分位は「—」。
- 古いデータの警告（3.1 節）を出す。

---

### 3.6 接続と収集ログ（`/jobs`）

見本: `render.js` の `S.connection`。R1 の `/`（接続状態）と `/jobs`（収集ログ）の中身をこの 1 画面に移す。

| 部分 | 内容 | データ |
|---|---|---|
| 警告 | 直近 24 時間に失敗があれば `callout`（`data-state="bad"`）で件数と最新の失敗の要約 | `job_runs` |
| 数字タイル | 24 時間の実行（成功・一部失敗・失敗の内訳）、連続失敗（通知のしきい値と並べる）、トークン期限まで（日）、API 使用率（直近の `rate_usage`）、保存した投稿の数、保存した日次指標の日数 | `job_runs`、`account_connection_status`、`media`、`account_daily_metrics` |
| 接続状態のカード | 状態、Instagram のユーザー名、トークンの種類と期限、データアクセスの期限、最終確認、最終エラー。期限の進み具合の棒（14 日前から注意、7 日前から重大） | `account_connection_status` |
| 収集スケジュールのカード | ジョブごとの予定（定数。GitHub Actions のワークフローの cron と合わせる）と直近の実行結果 | 定数、`job_latest_runs` |
| ジョブの実行記録 | 時刻、ジョブ、結果、所要、件数、内容。絞り込みのチップ（すべて、失敗のみ、ジョブ名）はクエリ `?job=&status=` のリンク。50 件ずつページ送り | `job_runs` |

- `job` はジョブ名の許可リスト（収集スケジュールの定数と同じ一覧）、`status` は `job_runs.status` の 5 値の列挙だけを受け付け、外れたら絞り込みなしにする（4.7 節）。
- 結果の表示は `job_runs.status` を見本の 3 段階に寄せる: `success` → 成功（ok）、`partial` と `skipped` → 注意（warn）、`failed` → 失敗（bad）、`running` → 実行中（neutral）。
- `job_runs.error` を画面に出すのは今と同じ（ワーカーがトークンや取得データを含めない決まり。R1 のテーブルのコメント）。
- 見本の「今すぐ収集」ボタンは置かない（1.2 節）。
- R1 の `/` の接続状態の部品（`getConnectionStatus`、`lib/queries/connection-status.ts`）は `/jobs` に移す。移す作業は段階 0 で行う（10 章）。
- `/connect`（接続設定）は処理を変えず、カード、フォームの部品、ボタンのクラスだけをデザインシステムに合わせる。

---

## 4. データの取り方

### 4.1 方針

- 今までどおり、Server Component から `web_app` ロールで Postgres に直結し（`dbFromEnv`、postgres.js のタグ付きテンプレート）、読み出し関数は `apps/web/src/lib/queries/` に置く。関数は `QueryResult` を返し、例外を投げない（R1 の `media.ts` の形）。`React.cache` で同じリクエスト内の重複を除く（Next.js 16「Fetching Data」の「Reusing data with React.cache」）。
- 派生指標は**ビューで計算する**（投稿一覧の並べ替えを SQL の `order by` でできるようにするため。画面、CSV、テストが同じ式を使う）。分位（基準値）は、特殊な投稿の除外の条件で母集団が変わりうるので、ビューにせずクエリで `percentile_cont` を使う。
- ビューはすべて `security_invoker = true`。基のテーブルの select とポリシーは R2 で `web_app` に与え済みなので、足すのはビューの select と関数の execute だけ。
- **対象のアカウント**: `META_TARGET_IG_USER_ID`（サーバーだけの環境変数。`NEXT_PUBLIC_` を付けない。Vercel にも置く）と一致する `accounts` の行を `getTargetAccount()`（`lib/queries/account.ts`）で選ぶ。未設定、または一致する行がなければ、ほかのアカウントを代わりに選ばず「対象のアカウントが設定されていません」を返す（3.1 節）。読み出し関数はすべて `accountId` を第 1 引数に取り（シグネチャに出す）、SQL で `account_id = ${accountId}` を必ず付ける。照らす列は `accounts.ig_user_id`（`text not null unique`。確認済み）。

### 4.2 使うテーブルとビュー

| 画面の部分 | 使うもの | 既存か |
|---|---|---|
| 概要の日次推移、期間の合計、期間比較、日次の CSV | `account_daily_wide`（`account_daily_metrics` を横持ちにする） | 新規 |
| フォロワー数の推移と純増、投稿時のフォロワー数 | `profile_daily` | 既存 |
| 投稿一覧、概要と期間比較の投稿単位の値、投稿の CSV、リーチ率 | `media_list_metrics` | 新規 |
| 投稿詳細の帯グラフと伸び方、基準値 | `media_horizon_metrics`（`media_metrics_at_horizon` を横持ちにし、派生指標を足す） | 新規 |
| 経過時間をそろえた指標 | `media_metrics_at_horizon`（許容幅の列を末尾に足す。`90d` は確認事項 Q16） | 既存を変更 |
| 接続と収集ログ | `account_connection_status`、`job_latest_runs`、`job_runs` | 既存 |
| サムネイル | Storage のバケット `thumbnails`（本人のセッションで署名。R2 のまま） | 既存 |
| 指標の名前と定義、指標変更の日 | `metric_definitions`（列: `scope`、`metric`、`label_ja`、`description`、`unit`、`breakdowns`、`media_product_types`、`available_from`、`deprecated_on`、`successor`。R2 で select を与え済み） | 既存 |

**DB の指標の名前**（R1 の収集の実装。レビューで確認）:

| データ | 名前 |
|---|---|
| 日次指標（内訳なし） | `reach`、`views`、`accounts_engaged`、`total_interactions`、`likes`、`comments`、`shares`、`saves`、`replies`、`reposts`、`follows_and_unfollows`、`profile_links_taps`。`follower_count`（1 日ごとの新規フォロワー。直近 30 日のみ、バックフィル対象外）。`online_followers`（`breakdown = 'hour'`） |
| 日次指標の内訳 | `follow_type`（`reach`、`views`、`follows_and_unfollows`。値は `FOLLOWER`／`NON_FOLLOWER`）、`media_product_type`、`contact_button_type`。値が 0 の区分は行がない。印の行 `(metric, breakdown, breakdown_value = '')` は、`reach` と `views` の `follow_type` では `value` に合計値が入る（区分の行がない日は印の値が 0）。`value` が null なのは `follows_and_unfollows` の印の行だけ。印の行がなければ未取得（実データで確認） |
| スナップショットの JSON | `reach`、`views`、`likes`、`comments`、`saved`、`shares`、`profile_visits`、`follows`（FEED のみ）、`ig_reels_avg_watch_time`、`ig_reels_video_view_total_time`、`reels_skip_rate`（REELS のみ。unit は percent）。取れない指標はキーなし、取得の失敗は null |

日次は `saves`、投稿の JSON は `saved` と名前が違う。ビューの列名は `saved` にそろえる。

### 4.3 マイグレーションの案

ファイル名の案: `supabase/migrations/2026100XXXXXXX_r3_analysis_views.sql`（手書き。`supabase db pull` で作らない）。

#### 経過時間の区分の許容幅（R-1）

`media_metrics_at_horizon` は「区分の秒数を初めて超えたスナップショット」を選び、上限がない。収集を始める前からある投稿は最初のスナップショットが投稿から数か月後になり、収集が止まった投稿は「7 日」に 25 日目の値が入る。そこで区分ごとに許容幅を持たせ、`within_tolerance`（実際の経過時間 ≦ 区分 + 許容幅）を列に足す。分位、リーチ率、帯グラフ、伸び方のグラフは `within_tolerance` が真の値だけを使う。画面には実際の経過時間を出す（3.4 節）。

| 区分 | 許容幅（案） |
|---|---|
| 1h、3h、6h | + 1 時間 |
| 24h、3d、7d、30d、90d | + 区分の 25%（24h は + 6 時間、7d は + 42 時間） |

許容幅の値は確認事項 Q3。

```sql
-- R3: 分析画面のビューと関数
-- 設計: doc/design/r3-analysis-screens.md 4 章。ロールバックは 4.3 節の末尾

-- ---------------------------------------------------------------
-- 1. 投稿の種類（フィード、カルーセル、リール、ストーリーズ）
-- インライン展開させるため、set search_path も strict も付けない（R-7、再レビュー軽-1。strict があると
-- CASE を含む本体は展開されない）。引数の列（media_product_type、media_type）は NOT NULL なので、strict を外しても結果は同じ。
-- 本体は引数の比較だけでテーブルを参照しない。Supabase の linter の function_search_path_mutable の警告は受け入れる
-- ---------------------------------------------------------------
create or replace function public.media_kind(p_product_type text, p_media_type text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_product_type = 'REELS' then 'reel'
    when p_product_type = 'STORY' then 'story'
    when p_media_type = 'CAROUSEL_ALBUM' then 'carousel'
    else 'feed'
  end
$$;

comment on function public.media_kind(text, text) is
  '投稿の種類。feed: フィード、carousel: カルーセル、reel: リール、story: ストーリーズ';

-- R2 の決まり: 関数を足したら PUBLIC の実行権を取り消す（結合テストが棚卸しする）
revoke execute on function public.media_kind(text, text) from public;
grant execute on function public.media_kind(text, text) to web_app;

-- ---------------------------------------------------------------
-- 2. media_metrics_at_horizon に許容幅の列を足す（列は末尾にだけ足せる）。
-- 90d の行は確認事項 Q16 で足すと決まったときだけ入れる
-- ---------------------------------------------------------------
create or replace view public.media_metrics_at_horizon
with (security_invoker = true) as
with horizons (horizon, horizon_seconds, tolerance_seconds) as (
  values
    ('1h', 3600, 3600), ('3h', 10800, 3600), ('6h', 21600, 3600),
    ('24h', 86400, 21600), ('3d', 259200, 64800), ('7d', 604800, 151200),
    ('30d', 2592000, 648000), ('90d', 7776000, 1944000)
)
select
  m.id as media_id, h.horizon, h.horizon_seconds, s.fetched_at, s.elapsed_seconds, s.metrics,
  h.tolerance_seconds,
  (s.elapsed_seconds <= h.horizon_seconds + h.tolerance_seconds) as within_tolerance
from public.media m
cross join horizons h
cross join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= h.horizon_seconds
  order by s.elapsed_seconds
  limit 1
) s
union all
select m.id, 'latest'::text, null::integer, s.fetched_at, s.elapsed_seconds, s.metrics,
  null::integer, true
from public.media m
cross join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id
  order by s.fetched_at desc
  limit 1
) s;

comment on view public.media_metrics_at_horizon is
  '投稿からの経過時間をそろえた指標。horizon は 1h, 3h, 6h, 24h, 3d, 7d, 30d, 90d, latest。'
  'within_tolerance は実際の経過時間が区分 + 許容幅に入るか（入らない値は比較に使わない）';

-- ---------------------------------------------------------------
-- 3. media_horizon_metrics: 投稿（ストーリーズを除く）× 区分ごとの指標と派生指標
-- ---------------------------------------------------------------
create view public.media_horizon_metrics
with (security_invoker = true) as
with base as (
  select
    h.media_id,
    m.account_id,
    public.media_kind(m.media_product_type, m.media_type) as kind,
    m.posted_at,
    m.gone_at,
    m.is_collab, m.is_trial_reel, m.is_boosted,
    h.horizon, h.horizon_seconds, h.tolerance_seconds, h.within_tolerance,
    h.elapsed_seconds, h.fetched_at,
    public.metric_value(h.metrics, '{reach}') as reach,
    public.metric_value(h.metrics, '{views}') as views,
    public.metric_value(h.metrics, '{likes}') as likes,
    public.metric_value(h.metrics, '{comments}') as comments,
    public.metric_value(h.metrics, '{saved}') as saved,
    public.metric_value(h.metrics, '{shares}') as shares,
    public.metric_value(h.metrics, '{profile_visits}') as profile_visits,
    public.metric_value(h.metrics, '{follows}') as follows,
    public.metric_value(h.metrics, '{ig_reels_avg_watch_time}') as avg_watch_time_ms,
    -- API の unit は percent で、実値は 0〜100（実データで 28.6〜49.4。確認済み）。0〜1 にそろえる（R-5）
    public.metric_value(h.metrics, '{reels_skip_rate}') / 100 as skip_rate
  from public.media_metrics_at_horizon h
  join public.media m on m.id = h.media_id
  where m.media_product_type <> 'STORY'
)
select
  b.*,
  (b.likes + b.comments + b.saved + b.shares) / nullif(b.reach, 0) as er,
  b.saved / nullif(b.reach, 0) as save_rate,
  b.shares / nullif(b.reach, 0) as share_rate,
  b.likes / nullif(b.reach, 0) as like_rate,
  b.comments / nullif(b.reach, 0) as comment_rate,
  b.profile_visits / nullif(b.reach, 0) as profile_visit_rate,
  b.follows / nullif(b.profile_visits, 0) as follow_conversion_rate,
  b.views / nullif(b.reach, 0) as views_per_reach
from base b;

comment on view public.media_horizon_metrics is
  '投稿（ストーリーズを除く）の経過時間の区分ごとの指標と派生指標。基準値は within_tolerance が真の行に対してクエリで計算する。skip_rate は 0〜1';

-- ---------------------------------------------------------------
-- 4. media_list_metrics: 投稿一覧（1 投稿 1 行）。最新の値、7 日時点のリーチ、投稿時のフォロワー数、リーチ率
-- ---------------------------------------------------------------
create view public.media_list_metrics
with (security_invoker = true) as
select
  m.id as media_id,
  m.account_id,
  public.media_kind(m.media_product_type, m.media_type) as kind,
  m.media_type,
  m.media_product_type,
  m.posted_at,
  -- 日付の変換はここだけで行う（JS で二重に持たない。6 章）
  (m.posted_at at time zone 'Asia/Tokyo')::date as posted_date_jst,
  (m.posted_at at time zone 'America/Los_Angeles')::date as posted_date_pt,
  m.caption,
  m.permalink,
  m.thumbnail_path,
  m.is_collab, m.is_trial_reel, m.is_boosted,
  m.gone_at,
  lt.fetched_at as latest_fetched_at,
  lt.elapsed_seconds as elapsed_latest,
  lt.reach, lt.views, lt.likes, lt.comments, lt.saved, lt.shares,
  lt.profile_visits, lt.follows, lt.avg_watch_time_ms, lt.skip_rate,
  lt.er, lt.save_rate, lt.share_rate, lt.like_rate, lt.comment_rate,
  lt.profile_visit_rate, lt.follow_conversion_rate, lt.views_per_reach,
  d7.reach as reach_7d,
  d7.elapsed_seconds as elapsed_7d,
  pf.followers_count as followers_at_post,
  pf.captured_at as followers_captured_at,
  d7.reach / nullif(pf.followers_count, 0) as reach_rate
from public.media m
left join public.media_horizon_metrics lt
  on lt.media_id = m.id and lt.horizon = 'latest'
left join public.media_horizon_metrics d7
  on d7.media_id = m.id and d7.horizon = '7d' and d7.within_tolerance
left join lateral (
  -- 投稿より前の、最も近い記録（3 日以内）。投稿の後に取った記録は使わない（R-10）
  select p.followers_count, p.captured_at
  from public.profile_daily p
  where p.account_id = m.account_id
    and p.captured_at <= m.posted_at
    and p.captured_at >= m.posted_at - interval '3 days'
  order by p.captured_at desc
  limit 1
) pf on true
where m.media_product_type <> 'STORY';

comment on view public.media_list_metrics is
  '投稿一覧（ストーリーズを除く）。指標は最新のスナップショット。リーチ率は 7 日時点（許容幅内）のリーチ ÷ 投稿前 3 日以内の記録のフォロワー数';

-- ---------------------------------------------------------------
-- 5. account_daily_wide: アカウント日次指標を 1 日 1 行にする（日付は API の日付 = 米国太平洋時間）
-- 内訳の列の決め方（R-2、再レビュー中-1、軽-3）:
--   区分の行がある            → その値（value が null なら null のまま。0 にしない）
--   区分の行がなく、同じ指標・内訳の別の区分の行がある、または印の行の value が 0 → 0（値が 0 の区分は行がない）
--   それ以外（印の値が正なのに区分の行が 1 つもない、印の行がない） → null（未取得）
-- ---------------------------------------------------------------
create view public.account_daily_wide
with (security_invoker = true) as
select
  d.account_id,
  d.metric_date,
  max(d.value) filter (where d.metric = 'reach' and d.breakdown = '') as reach,
  max(d.value) filter (where d.metric = 'views' and d.breakdown = '') as views,
  max(d.value) filter (where d.metric = 'accounts_engaged' and d.breakdown = '') as accounts_engaged,
  max(d.value) filter (where d.metric = 'total_interactions' and d.breakdown = '') as total_interactions,
  max(d.value) filter (where d.metric = 'likes' and d.breakdown = '') as likes,
  max(d.value) filter (where d.metric = 'comments' and d.breakdown = '') as comments,
  max(d.value) filter (where d.metric = 'shares' and d.breakdown = '') as shares,
  max(d.value) filter (where d.metric = 'saves' and d.breakdown = '') as saved,
  max(d.value) filter (where d.metric = 'follower_count' and d.breakdown = '') as new_followers,
  case
    when bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = 'FOLLOWER')
      then max(d.value) filter (where d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = 'FOLLOWER')
    when bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value <> '')
      or bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = '' and d.value = 0)
      then 0
  end as reach_follower,
  case
    when bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = 'NON_FOLLOWER')
      then max(d.value) filter (where d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = 'NON_FOLLOWER')
    when bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value <> '')
      or bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = '' and d.value = 0)
      then 0
  end as reach_non_follower,
  case
    when bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = 'FOLLOWER')
      then max(d.value) filter (where d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = 'FOLLOWER')
    when bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value <> '')
      or bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = '' and d.value = 0)
      then 0
  end as views_follower,
  case
    when bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = 'NON_FOLLOWER')
      then max(d.value) filter (where d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = 'NON_FOLLOWER')
    when bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value <> '')
      or bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = '' and d.value = 0)
      then 0
  end as views_non_follower,
  max(d.fetched_at) as fetched_at
from public.account_daily_metrics d
group by d.account_id, d.metric_date;

comment on view public.account_daily_wide is
  'アカウント日次指標の横持ち。metric_date は API の日付（米国太平洋時間の 0 時区切り）。行がない日は欠け。'
  '内訳の列は、区分の行があればその値、別の区分の行があるか印の値が 0 なら 0、それ以外は null（未取得）。'
  'saved は API の saves。new_followers は直近 30 日のみ。最新の日は follower_count だけで reach が null のことがある';

-- ---------------------------------------------------------------
-- 6. web_app への権限（R2 の決まり: 列挙する）
-- media_metrics_at_horizon は create or replace なので既存の grant が残る
-- ---------------------------------------------------------------
grant select on table
  public.media_horizon_metrics,
  public.media_list_metrics,
  public.account_daily_wide
to web_app;
```

- **内訳の 0 と未取得**: `reach` と `views` の `follow_type` の印の行には合計値が入るので、印の値が 0 なら全区分 0、印の値が正なのに区分の行が 1 つもなければ区分は未取得（null）と分けられる。`follows_and_unfollows` の印の行だけは `value` が null で、この区別ができない（R3 では `follows_and_unfollows` の内訳を使わないので列を作らない）。
- 非フォロワーリーチ比率は、`reach_follower` か `reach_non_follower` が null の日は「—」（`missing`）にする。
- `media_list_metrics` は `media_horizon_metrics` を 2 回（`latest` と `7d`）結合する。投稿 24 件では問題にならないのでこの形のままにする（R-8）。数百件を超えて遅ければ、`media` と lateral 2 本で直接書く形に変える。確認は 9.2 節の手動の計測で行う。

#### ロールバック（R-13）

```sql
-- R3 の分析ビューを戻す。依存の順に消す
drop view if exists public.media_list_metrics;
drop view if exists public.media_horizon_metrics;
drop view if exists public.account_daily_wide;

-- media_metrics_at_horizon は足した列を create or replace で消せないので、消して R1 の定義
-- （20261001100400_r1_views.sql の 94〜139 行をそのまま）で作り直し、comment と grant をやり直す
drop view if exists public.media_metrics_at_horizon;

create view public.media_metrics_at_horizon
with (security_invoker = true) as
with horizons (horizon, horizon_seconds) as (
  values
    ('1h', 3600),
    ('3h', 10800),
    ('6h', 21600),
    ('24h', 86400),
    ('3d', 259200),
    ('7d', 604800),
    ('30d', 2592000)
)
select
  m.id as media_id,
  h.horizon,
  h.horizon_seconds,
  s.fetched_at,
  s.elapsed_seconds,
  s.metrics
from public.media m
cross join horizons h
cross join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= h.horizon_seconds
  order by s.elapsed_seconds
  limit 1
) s
union all
select
  m.id as media_id,
  'latest'::text as horizon,
  null::integer as horizon_seconds,
  s.fetched_at,
  s.elapsed_seconds,
  s.metrics
from public.media m
cross join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id
  order by s.fetched_at desc
  limit 1
) s;

comment on view public.media_metrics_at_horizon is '投稿からの経過時間をそろえた指標。horizon は 1h, 3h, 6h, 24h, 3d, 7d, 30d, latest';

grant select on table public.media_metrics_at_horizon to web_app;

drop function if exists public.media_kind(text, text);
```

`media_analysis_dataset` は `media_metrics_at_horizon` を参照しない（R1 のビュー）ので、作り直しの影響を受けない。

### 4.4 索引

- 新しい索引は足さない。使うのは既存の `media_insight_snapshots (media_id, elapsed_seconds)`（区分の値）、一意制約の `(media_id, fetched_at)`（最新の値）、`account_daily_metrics` の主キー `(account_id, metric_date, …)`（日付の範囲）、`profile_daily` の主キー、`job_runs (job_name, started_at desc)` と `(account_id, started_at desc)`。
- 投稿時のフォロワー数は `profile_daily` を `captured_at` で探すが、行数が 1 日 1 行なので索引は要らない。
- ジョブの実行記録を「失敗のみ」で絞るときは `status` の索引がないが、`job_runs` の行数（1 日数十件）では全件を走査しても速い。1 年分（数万件）で遅くなれば `(account_id, status, started_at desc)` を足す。

### 4.5 画面ごとのクエリ（`lib/queries/`）と既存の関数

すべての関数は第 1 引数に `accountId` を取る（4.1 節）。

| ファイル | 関数 | 中身 | 既存との関係 |
|---|---|---|---|
| `account.ts` | `getTargetAccount()` | 対象のアカウント 1 件。決まらなければ理由つきの失敗 | 新規 |
| `period-summary.ts` | `getDailyRange(accountId)`（最新の日は `max(metric_date) filter (where reach is not null)`）、`getDailySeries(accountId, from, to)`、`getFollowerSeries(accountId, from, to)`、`getPostTotals(accountId, from, to, opts)` | 概要と期間比較で共通の期間集計（10 章の段階 0） | 新規 |
| `overview.ts` | 概要のカードごとの組み立て | `period-summary.ts` を使う | 新規 |
| `media.ts` | `listMedia(accountId, { sort, order, page, opts })`、`countMedia(accountId, opts)`、`getMediaBaseline(accountId, opts)`、`getMediaPage(…)` | 一覧、総件数、`tfoot` の基準値、サムネイルの署名 | 作り直し。`listMedia` と `getMediaPage` は名前を残し、引数を変える |
| `media-detail.ts` | `getMedia(accountId, id)`、`getMediaHorizons(accountId, id)`（区分ごとの値と `within_tolerance`、実際の経過時間）、`getPeerStats(accountId, kind, basis, excludeId, opts)` | 投稿 1 件、区分ごとの値、同じ種類の分位と最小・最大と指標ごとの n | 新規 |
| `baseline.ts` | `chooseBasis(accountId, scope, opts)` | 比較の基準（`{ kind: '7d', horizon }` か `{ kind: 'latest30' }`）を、母集団の 7 日時点が許容内の投稿の数（3 件以上か）で選ぶ（3.1 節）。詳細、一覧、期間比較が共通に使う | 新規 |
| `compare.ts` | `getPeriodComparison(accountId, a, b, opts)` | `period-summary.ts` を組み合わせる | 新規 |
| `connection-status.ts` | `getConnectionStatus(accountId)` | 接続状態 | 既存。`/jobs` から使う。引数に `accountId` を足す |
| `jobs.ts` | `getLatestRuns(accountId)`、`listRecentRuns(accountId, { job, status, page })`、`getJobStats(accountId)` | 収集ログ | 既存の 2 つは名前を残し、引数を足す。`getJobStats` は新規 |

- **既存の結合テスト**: `apps/web/test/db/queries.test.ts` は `getConnectionStatus`、`getMediaPage`／`listMedia`、`getLatestRuns`／`listRecentRuns` を import している。段階 0 でこのファイルを画面ごとに分け（`test/db/media.test.ts`、`test/db/jobs.test.ts`）、`queries.test.ts` は消す。引数の変更に合わせた直しは、各関数の担当（10 章）が自分のテストファイルで行う。
- `opts` は特殊な投稿の除外の設定（8 章。作らなければ引数ごと持たない）。
- 分位のクエリの例（指標ごとに n を数える。`percentile_cont` と `count(列)` は null を飛ばす）:

```sql
select
  count(reach)::int as reach_n,
  min(reach) as reach_min, max(reach) as reach_max, avg(reach) as reach_mean,
  percentile_cont(array[0.25, 0.5, 0.75]) within group (order by reach) as reach_q,
  count(save_rate)::int as save_rate_n,
  percentile_cont(array[0.25, 0.5, 0.75]) within group (order by save_rate) as save_rate_q
  -- 指標ごとに同じ形を並べる
from public.media_horizon_metrics
where account_id = $1 and kind = $2 and media_id <> $4
  -- 7 日時点の基準
  and horizon = $3 and within_tolerance;
  -- 最新の値の基準では、上の 1 行の代わりに: and horizon = 'latest' and elapsed_seconds >= 2592000
```

- **7 日時点の基準では `latest` の行を使わない**。`latest` を使うのは「最新の値」の基準だけで、必ず `elapsed_seconds >= 2592000`（投稿から 30 日以上）の条件を付ける（条件なしの `latest` は投稿一覧の行の表示にだけ使う）。基準の分岐は SQL の文字列を組み立てず、2 本のクエリを分けて書く。

- リーチ率の分位は `media_list_metrics.reach_rate` に対して同じ形で計算する（3.4 節）。
- 並べ替えはキー → 列名の固定の対応表で列名を決め、postgres.js の識別子ヘルパー（`db(column)`）で埋める。向きは `asc`／`desc` の 2 値だけを分岐で書く（文字列を連結しない）。
- 1 画面の中のカードは `<Suspense>` で包み、それぞれの Server Component がデータを取る。カードの失敗はカードの中で表示する（Next.js 16「Fetching Data」の「Streaming」）。同じカードの中の独立したクエリは `Promise.all` で並べる（同「Parallel data fetching」）。
- キャッシュはしない。データは本人だけのもので、R1 と同じく `markDynamic()` でリクエストのたびに描く。`use cache` は Cache Components（`cacheComponents: true`）が前提で、今の `next.config` は `cacheComponents` を設定していない（確認済み）。R3 では使わない。

### 4.6 指標の名前と定義の文言

- 指標の画面の名前は `metric_definitions.label_ja`、指標変更の日は `available_from`、`deprecated_on`、`successor` から読む。
- ヒントの文言は `metric_definitions.description` を使う。今は多くが null なので、R3 のマイグレーション（または別のマイグレーション）で、R3 の画面に出す API の指標の `description` を `update` で埋める。派生指標（ER、保存率など。API の指標ではないので `metric_definitions` にない）の文言は `apps/web/src/lib/metric-definitions.ts` の定数に置く。DB と定数に同じ指標の文言を二重に持たない。確認事項 Q13。

### 4.7 入力の検査とログ

| 入力 | 受け付ける値 | 外れたとき |
|---|---|---|
| `range`（概要） | `7`、`30`、`90` | 30 |
| `er`（分母） | `reach`、`views`、`followers` | `reach` |
| `sort`（一覧、CSV） | 並べ替えのキーの対応表のキー | `posted` |
| `order` | `asc`、`desc` | `desc` |
| `page`（一覧、収集ログ） | `^\d{1,6}$` かつ 1 以上 | 1 |
| 投稿 ID（`/media/[id]`） | `^\d{1,25}$` | `notFound()` |
| `preset`（期間比較） | `7d`、`30d`、`month`、`yoy` | `30d` |
| `a`、`b`（期間比較）、`from`、`to`（日次の CSV） | `YYYY-MM-DD` の形、暦として正しい日、開始 ≦ 終了、366 日以内 | 期間比較は既定の期間と入力欄の下の理由。CSV は 400 と固定の文言 |
| `job`（収集ログ） | ジョブ名の許可リスト | 絞り込みなし |
| `status`（収集ログ） | `running`、`success`、`partial`、`failed`、`skipped` | 絞り込みなし |
| Cookie `ia_exclude` | 8 章 | 除外なし |

- 検査の関数は `lib/params.ts` にまとめ、単体テストを付ける（9.1 節）。
- **サムネイル**: 一覧も詳細も R1 と同じ `signThumbnailUrls`（本人のセッションで 1 時間の署名）を使い、別の署名の経路を作らない。署名付き URL を含むページの応答は `Cache-Control: private, no-store` にし、`<img>` に `referrerPolicy="no-referrer"` を付ける（Instagram へのリンクなどで署名付き URL が外へ漏れないように。サイト全体の `Referrer-Policy` は `next.config` で `same-origin` に設定済み（確認済み））。
- **ログに出さないもの**: アクセストークン、Cookie とセッションの値、`ia_exclude` 以外の Cookie、署名付き URL、キャプション、アカウントの ID とユーザー名、DB の接続文字列、SQL の本文と引数。サーバーのログにはクエリの名前と DB のエラーコード（SQLSTATE）だけを書く。CSV の失敗、Server Action の失敗では DB のエラー文を利用者に返さない（固定の文言）。

---

## 5. デザインシステムの移し方

### 5.1 トークン

- `doc/design-system.md` の `:root` を `apps/web/src/app/globals.css` にそのまま移す（PC 幅の `--card-pad: 22px` の media query も）。
- ただし先頭の Google Fonts の `@import` は使わず、`next/font/google` の `Noto_Sans_JP`（400、500、700）に置き換える（ビルド時に取り込み、外部へのリクエストを出さない）。`layout.tsx` の Geist と Geist_Mono を外し、フォントの CSS 変数を `--font-body` と `--font-num` の先頭に入れる。日本語のフォントのサブセットの指定（`subsets`、`preload`）は実装時に `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md` で確かめる（今回は読んでいない）。
- Tailwind CSS 4 との関係: トークンは `:root` の普通の CSS 変数として置き、`@theme` には入れない。Tailwind の `--color-*` の名前空間にトークン（`--color-bg`、`--color-text` など）を入れるとユーティリティ（`bg-bg`、`text-text`）が生まれて名前が紛らわしくなるため。既存の Tailwind の既定の色（`neutral-500` など）は使うのをやめる。
- 部品の見た目は、R2.5 の `doc/design-lab/v3/lab.css` のクラス（`topbar`、`nav`、`page-head`、`card`、`kpis`、`kpi`、`grid`／`col-*`、`table`、`tag`、`chip`、`callout`、`status`、`progress`、`media-card`、`only-d`／`only-m`、`hide-m` など）を `globals.css`（または `src/styles/` の数本の CSS）に移して使う。Tailwind のユーティリティは余白や配置の小さな調整にだけ使う。`lab.css` は今回読んでいないので、移すときに案 01 以外の案の切り替え（`--card-tilt` など使わない変数）を落とす。
- 移した後、R1 の画面に残る Tailwind の色のクラスは置き換える。

### 5.2 部品（`apps/web/src/components/`）

| 部品 | 種類 | 見本の関数 |
|---|---|---|
| `AppShell`（上部のバーとナビ） | Server（現在位置だけ Client。`usePathname`） | `shell` |
| `PageHead` | Server | `pageHead` |
| `Card` | Server | `card` |
| `Kpi`（数字タイルと前期間比） | Server | `kpi`、`delta`、`deltaPt` |
| `TypeTag`、`SpecialTags` | Server | `tag` |
| `Thumb` | Server | `thumb` |
| `MetricHint` | Client（マウスを乗せたときの表示） | 各 `title` |
| `Pager` | Server | 投稿一覧のページ送り |
| `SortHeader` | Server | 列の見出し |
| `Callout`、`Note` | Server | `note` |
| `charts/VBars`、`charts/LineChart`、`charts/Stacked100`、`charts/BandRow`、`charts/Legend` | Server（SVG を返す） | `vbars`、`lineChart`、`stacked100`、`cmpRow`、`legend` |

### 5.3 グラフ: SVG を自作する（推奨）

- 推奨: 見本の描画関数（`render.js` の `vbars`、`lineChart`、`stacked100`、`cmpRow`）を、SVG を返す Server Component に移す。依存を増やさず、JS をブラウザに送らず、見本と同じ見た目（README の「グラフの決まり」: 1 軸、線 2px、点 8px、データ端 4px の角丸、系列の色の固定、直接ラベル）をそのまま再現できる。R3 のグラフは棒、折れ線（帯つき）、100% 積み上げ、帯グラフの 4 種で、操作（拡大、ドラッグ）は要らない。
- 幅: 見本は描画時にコンテナの幅を測っていたが、Server Component では測れない。`viewBox` を決めた幅（PC の 8 列のカードで 760、12 列で 1140 など）で描き、`width: 100%` で縮める。スマートフォンでは文字が縮みすぎるので、日次推移のように横に長いグラフは、スマートフォン用の `viewBox`（幅 340）で別に描いた SVG を `only-m` で出し分ける。X 軸のラベルは幅に合わせて間引く。
- ヒント: SVG の `<title>` と `aria-label` に値を入れる（見本の帯グラフと同じ）。棒や点を指したときの吹き出しは R3 では作らない。
- 依存を増やす案（決めない。確認事項 Q2）:

| 候補 | 長所 | 短所 |
|---|---|---|
| Recharts | React の部品で書ける。吹き出しや凡例が揃っている | Client Component になり JS が増える。帯（25〜75%）や行ごとの目盛の帯グラフは結局自作に近い。見本の細かい決まりに合わせる手間がある |
| visx | 低水準で見本に合わせやすい | 部品の組み立ては自作と大差ない。依存が多い |
| Chart.js | 軽い | Canvas で、トークン（CSS 変数）と `aria` の扱いが SVG より手間 |

---

## 6. 日付と時刻

要件 5.5 章に従う。DB の時刻はすべて UTC、画面は日本時間。日付には 3 つの種類があり、混ぜない。画面のカードごとに、どの種類の日付かを書く（3.1 節）。

| データ | 日付の意味 | 画面の表記 |
|---|---|---|
| `account_daily_metrics.metric_date`（と `account_daily_wide`） | API の日付。米国太平洋時間（`America/Los_Angeles`）の 0 時区切り。日本時間に組み替えられない | 「米国太平洋時間の日付」 |
| `profile_daily.captured_on` | 記録した日（日本時間の日付） | 「日本時間の日付」 |
| `media.posted_at`、`fetched_at`、`profile_daily.captured_at`、`job_runs.started_at` など | UTC の時刻 | 日本時間の `YYYY-MM-DD HH:mm`（既存の `formatJst`） |

- **期間の起点**: 概要と期間比較の「最新の日」は、今日の日付ではなく `account_daily_wide` の `max(metric_date) filter (where reach is not null)` にする（日次指標は太平洋時間の前日分を毎日取るので今日の分はまだなく、最新の日に `follower_count` の行しかない日もある）。
- **投稿の期間への入れ方**: 投稿単位の値（ER、保存率、投稿数、基準値）は、投稿日時の日本時間の日付（`posted_date_jst`）が期間（日付の範囲）に入る投稿を数える（要件 5.5「投稿単位の分析は日本時間」）。日次指標の期間と最大 17 時間ずれることを、概要と期間比較の注記（見本の `PT_NOTE`）で説明する。
- **グラフの投稿の印**: 日次推移のグラフの ▲ は、`media_list_metrics.posted_date_pt`（投稿日時を太平洋時間の日付に直したもの）の位置に置く（例: 日本時間 10-05 10:00 の投稿は太平洋時間 10-04 18:00 なので 10-04）。ヒントには日本時間の投稿日時を書く。
- **変換は 1 か所**: 日本時間と太平洋時間の日付への変換は SQL（`at time zone`）で行い、ビューの列（`posted_date_jst`、`posted_date_pt`）として返す。JS では日付の変換をせず、時刻の表示（`formatJst`）と、時刻を持たない日付の計算（下）だけを行う。
- **フォロワー数の折れ線**: 日次推移の X 軸（太平洋時間の日付）に、`profile_daily` の日本時間の日付をそのまま同じ日付の位置に置く。最大 1 日弱ずれるが、フォロワー数の変化は緩やかなので許容し、カードの下で断る。純増の端の記録も同じ扱い（3.2 節）。
- **夏時間**: 太平洋時間の切り替えは Postgres の `at time zone 'America/Los_Angeles'` に任せ、オフセットを手で足し引きしない。
- **日付の計算**（前 7 日、前月、前年同月）は時刻を持たない日付（`YYYY-MM-DD` の文字列を年月日の数にしたもの）で行い、`Date` の時刻計算を使わない（日をまたぐ誤差を避ける）。`lib/period.ts` に置く。
- **前月と前年同月**: 暦月の 1 日〜末日。うるう年の 2 月 29 日を含む月の前年同月は 2 月 28 日まで（期間の日数が違うことを表の下に書く）。
- **古いデータの警告**の「今日」は太平洋時間の今日（`Intl.DateTimeFormat` の `timeZone: 'America/Los_Angeles'` で日付だけを取る。これは表示用の変換ではなく現在日の取得なので、上の「変換は 1 か所」の例外とする）。

---

## 7. CSV 出力（F-UI-27）

### 7.1 エンドポイント

| URL | 中身 | クエリ | ファイル名 |
|---|---|---|---|
| `/export/media` | 投稿一覧の全件（ページで切らない）。**特殊な投稿の除外の Cookie は読まず全行を出し**、3 つの判定の列で利用者が絞る | `sort`、`order`（一覧と同じ並び。4.7 節の検査） | `instagram-media-YYYYMMDD.csv`（出力した日、日本時間） |
| `/export/daily` | 日次指標 | `from`、`to`（太平洋時間の日付。省略時は全期間。4.7 節の検査） | `instagram-daily-YYYYMMDD.csv` |

- `app/export/media/route.ts` と `app/export/daily/route.ts` に `GET` を書く。Route Handler はキャッシュされない（Next.js 16「Route Handlers」の「Caching」。Cache Components が有効でも、DB を読む `GET` はリクエスト時に動く）。
- **認可**: proxy が `/export/*` も通す（2.1 節。未ログインは 303 で `/login`、許可外は 403）。そのうえでハンドラーの先頭でも `checkAccess` を呼び、`pass` でなければ未ログインは 401、許可外は 403 を返す（proxy の設定が変わったときの備え）。未ログインの応答をハンドラーでも 303 にそろえるかは確認事項 Q19。
- **失敗**: DB の失敗は 500 と固定の文言（「CSV を作れませんでした」）だけを返し、DB のエラー文を出さない。ログには 4.7 節の決まりで書く。対象のアカウントが決まらないときは 409 と固定の文言。
- 応答ヘッダー: `Content-Type: text/csv; charset=utf-8`、`Content-Disposition: attachment; filename="…"`、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`。
- 件数は投稿で数百件、日次で数百行なので、全部を文字列にしてから返す（ストリームにしない）。

### 7.2 形式

- UTF-8、先頭に BOM（Excel で文字化けしないため）、改行は CRLF、区切りはカンマ。
- 値にカンマ、ダブルクォート、CR、LF が入るときはダブルクォートで囲み、中のダブルクォートは 2 つに重ねる（RFC 4180）。
- **数式の注入を防ぐ**: 列の定義で「文字列の列」と「数値の列」を決め、文字列の列（`caption`、`permalink` など）だけに次を行う。値の先頭の空白（半角、全角、タブ、CR、LF）を飛ばした最初の文字が `=`、`+`、`-`、`@`、タブ、CR、LF、または全角の `＝`、`＋`、`－`、`＠` なら、値の先頭に `'` を付ける。そのあとで引用の処理をする。数値の列は値の形（数値かどうか）ではなく列の定義で判定し、数値として書く（負の数を含みうる）。
- 時刻は日本時間の `YYYY-MM-DD HH:mm:ss`（列名に `_jst` を付ける）。日次の日付は `metric_date_pt`。
- 率は 0〜1 の小数（例: `0.0213`）で書き、% にしない。欠損と「取れない」はどちらも空欄。
- 列の見出しの言語は確認事項 Q18。

### 7.3 列

列はコードで列挙し（ビューの全列を `select *` で出さない）、見出しの並びを単体テストで固定する。`thumbnail_path`、`account_id`、署名付き URL は入れない。

投稿（`media_list_metrics` から）:

`media_id`, `kind`, `posted_at_jst`, `caption`, `permalink`, `is_collab`, `is_trial_reel`, `is_boosted`, `gone_at_jst`, `latest_fetched_at_jst`, `elapsed_latest_hours`, `reach`, `views`, `likes`, `comments`, `saved`, `shares`, `profile_visits`, `follows`, `avg_watch_time_ms`, `skip_rate`, `er`, `save_rate`, `share_rate`, `like_rate`, `comment_rate`, `profile_visit_rate`, `follow_conversion_rate`, `views_per_reach`, `reach_7d`, `elapsed_7d_hours`, `followers_at_post`, `reach_rate`

日次（`account_daily_wide` から。`profile_daily` を日付で横に付ける）:

`metric_date_pt`, `reach`, `reach_follower`, `reach_non_follower`, `views`, `views_follower`, `views_non_follower`, `accounts_engaged`, `total_interactions`, `likes`, `comments`, `shares`, `saved`, `new_followers`, `followers_count_jst_day`, `fetched_at_jst`

- キャプションを CSV に入れるかは確認事項 Q12 と合わせて決める（公開リポジトリには CSV を置かないので、漏れの心配は利用者の手元の扱いだけ）。

---

## 8. 特殊な投稿（F-UI-28）

### 8.1 区別

- `media` に `is_collab`、`is_trial_reel`、`is_boosted` の列がある（R1。null は「判定できない」）。**ワーカーはこれらを埋めておらず、本番は全件 null**（API で判定できない。R0 の P7）。
- 画面: 値が true の投稿にだけ、種類のタグの横に「コラボ」「お試し」「ブースト」の小さなタグ（`--tag-border` の枠、本文の色）を出す。今は出る投稿がない。
- 集計の扱いでは、null は「特殊でない」とみなす（除外しない）。全件 null の間は、投稿一覧の表の下に「コラボ、お試しリール、ブーストの判定は API で取れないため行っていない」と 1 行書く。

### 8.2 除外の設定（作るかは確認事項 Q4）

全件 null の今は、除外の設定を作っても集計は何も変わらない。推奨は R3 では作らず、判定の手段（手で印を付ける、API が対応する）ができたときに作る。作る場合の設計を次に書く。

- 上部のバーの下に「集計から除く: コラボ／お試しリール／ブースト」の 3 つのチェックボックスを置き、`<form>` の Server Action で Cookie を書き換える。全画面で共通にし、ページを移っても保つ。判定できる（true の投稿がある）種類のチェックボックスだけを出す。
- **Server Action の守り**: 先頭で `checkAccess` を呼び、`pass` でなければ何もせずに失敗を返す（proxy は Server Action の POST も通すが、二重に守る）。書き換えの後の戻り先は、フォームから受け取ったパスを許可リスト（`/`、`/media`、`/media/<数字>`、`/compare`、`/jobs`。クエリは付け直さないか、4.7 節の検査を通したものだけ）で検査し、外れたら `/`。外部の URL や `//` で始まる値に戻さない。
- **Cookie `ia_exclude`**: 値は `collab`、`trial`、`boosted` をカンマでつないだもの（重複なし、順は固定）。書くときも読むときも許可値だけを通し、長さが 32 文字を超える値や許可外の語を含む値は「除外なし」とみなす。属性は `HttpOnly`、`Secure`（本番）、`SameSite=Lax`、`Path=/`、有効期限 1 年。
- 除外が効く範囲: 基準値（投稿一覧の `tfoot`、投稿詳細の比較相手、期間比較の投稿の基準値）、概要と期間比較の投稿単位の合計（ER、保存率、プロフィール訪問、投稿数）。
- 除外が効かない範囲: 投稿一覧の行そのもの（行は消さず、除外中の投稿は薄く表示して「集計から除外中」のタグ）、投稿詳細のこの投稿自身の値、アカウントの日次指標、投稿の CSV（7.1 節）。
- 除外が効いているときは、該当する数字の横に「除外: 2 件」と書く。既定はすべて「除かない」。

---

## 9. テストの方針

道具は vitest。単体テストは `apps/web/test/*.test.ts`、DB を使う結合テストは `apps/web/test/db/*.test.ts`（`describe.skipIf(!TEST_DATABASE_URL)`）。Route Handler の認可は既存の `test/routes.test.ts` と同じく `checkAccess` を `vi.mock` して確かめる。新しいテストの道具は足さない。

テストファイルは画面ごとに分け、各段階の担当が自分のファイルを書く（10 章）。

### 9.1 単体テスト（DB なし）

| 対象 | ファイル | 確かめること |
|---|---|---|
| 派生指標と書式（`lib/format.ts`、`lib/metrics.ts`） | `test/metrics.test.ts` | 分母 0 と null で「—」、% の桁、pt の差（2.0% → 3.0% は +1.0 pt）、増減率、前期 0。合計の比で、分子か分母が null の投稿を除き「n 件中 m 件」の m が合う。m = 0 で「—」。倍率の中央値 0 で「—」。順位で同じ値が同じ順位、m = 1 で「—」。「—」の理由の判定: `elapsed_latest` が 7 日未満で `not_yet`、7 日以上で 7 日時点が許容外なら `no_baseline_data`、最新の値の基準で 30 日未満の自分の値が `not_yet` |
| 「—」の理由 | 同上 | 種類ごとの `unsupported`（リールのプロフィール訪問とフォロー、フィードとカルーセルの視聴系）、`missing`、`not_yet`（7 日未満のリーチ率）、`no_baseline_data` |
| 件数による基準値の出し方と比較の基準の選び方 | `test/baseline.test.ts` | 比較相手の数 n = 0、1、2、3、9、10 の境目（自分を含めない数で数える）。指標ごとに n が違うとき。7 日時点が許容内の比較相手が 2 件で「最新の値」、3 件で「7 日時点」が選ばれる。表示の見出しが基準に合う |
| 期間の計算（`lib/period.ts`） | `test/period.test.ts` | 前 7 日、前 30 日、前月（月末が 28／29／30／31 日）、前年同月（うるう年）、同じ日の 1 日の期間、最新の日より後の切り詰め、データの始まりより前 |
| 入力の検査（`lib/params.ts`） | `test/params.test.ts` | 4.7 節の表の全行。日付の形、暦（2026-02-30、2025-02-29）、逆順、366 日と 367 日、`page` の 0、負、7 桁、数字以外、許可リスト外の `sort`、`job`、`status`、`range`、`er`、`preset`、投稿 ID の 26 桁と数字以外 |
| CSV（`lib/csv.ts`） | `test/csv.test.ts` | 引用符、カンマ、CR、LF、BOM、CRLF。数式の注入（`=`、`+`、`-`、`@`、タブ、CR、LF、全角の `＝＋－＠`、先頭の空白のあとの `=`）。数値の列の負の数は対象外。投稿と日次の見出しの並びを固定（`thumbnail_path`、`account_id` がない） |
| CSV の Route Handler | `test/routes.test.ts`（既存に足す） | `checkAccess` を `vi.mock` して、未ログイン 401、許可外 403、本人 200 とヘッダー（`Content-Type`、`Content-Disposition`、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`）。DB の失敗で 500 と固定の文言（DB のエラー文を含まない） |
| 除外の設定（作る場合） | `test/exclude.test.ts` | Cookie の値の検査（許可外の語、重複、33 文字以上）、戻り先のパスの許可リスト（`//evil`、`https://…`、`/media/abc`）、`checkAccess` が `pass` でないときに Cookie を書かない |
| グラフの部品 | `test/charts.test.ts` | 系列が 0 件、1 点、全部 null、全部同じ値（目盛の幅 0）で例外を投げず、`NaN` を SVG に出さない。n = 1〜2 で帯を描かず線と中央値だけ、n = 3〜9 で薄い表示 |

### 9.2 結合テスト（ローカルの Supabase）

| ファイル | 確かめること |
|---|---|
| `test/db/views.test.ts` | マイグレーションが `supabase db reset` で通る。`web_app` で新しいビュー 3 本を select でき、`media_kind` を実行できる。R2 の「関数の PUBLIC の実行権の棚卸し」に `media_kind` が引っかからない。`anon` と `authenticated` からは読めない。新しいビュー 3 本と作り直した `media_metrics_at_horizon` の `pg_class.reloptions` に `security_invoker=true` がある |
| 同上（区分） | `media_metrics_at_horizon` が区分ごとに「初めて超えた」スナップショットを選ぶ。収集前からある投稿（最初のスナップショットが 200 日後）と、収集が 25 日目で止まった投稿で、`7d` の `within_tolerance` が偽になり、分位とリーチ率に入らない。許容幅の境目（7d + 42 時間ちょうどと 1 秒超え） |
| 同上（JSON） | キーがない指標と値が null の指標がともに null になる。`reels_skip_rate` が 0〜1 になる |
| 同上（日次） | `account_daily_wide`: 印の値が 0 で区分の行なし → 区分は 0。印の行なし → null。印の値が正で区分の行なし → null。区分の片方だけ行がある → もう片方は 0。区分の行があって value が null → null。行のない日は返らない。`saves` が `saved` の列に入る |
| `test/db/period-summary.test.ts`（範囲） | 最新の日に `follower_count` の行しかない（`reach` が null）とき、`getDailyRange` の終わりがその前日になる |
| 同上（フォロワー） | `media_list_metrics.followers_at_post` が、投稿より前で 3 日以内の記録だけを使う（投稿の後の記録、4 日前の記録は使わない）。日本時間 0 時をまたぐ投稿（UTC 14:59 と 15:00）で `posted_date_jst` と `posted_date_pt` が正しい |
| `test/db/media.test.ts`（`queries.test.ts` から分ける） | `listMedia`、`getMediaPage`、`countMedia`、`getMediaBaseline`。`getMediaBaseline` が、選んだ基準の値だけを使う（7 日時点の基準で `latest` や他の区分の値が混ざらない）、`within_tolerance` が偽の投稿を含めない、最新の値の基準で投稿から 30 日未満の投稿を含めない。並べ替えで null が最後、同値の順が固定。`gone_at` のある投稿が一覧と基準値に入る。別のアカウントの投稿が出ない（2 アカウントのデータで分離） |
| `test/db/media-detail.test.ts` | `getPeerStats` が `percentile_cont` の期待値と合い、自分を除き、指標ごとに n が違う。基準が「最新の値」のとき 30 日未満の投稿を含めない。`getMediaHorizons` が区分ごとに `within_tolerance` と実際の経過時間を返し、偽の区分も行として返す（画面が点を描かずに経過時間を添えられる）。`chooseBasis` が実データに近い形（収集前の投稿だけ）で「最新の値」を選ぶ。別のアカウントの投稿が比較相手に入らない |
| `test/db/period-summary.test.ts`、`test/db/compare.test.ts` | 期間の合計、欠けた日の数え方、合計の比の欠損の扱い、純増の端の記録（1 日を超えて離れた記録を使わない）。2 アカウントの分離 |
| `test/db/jobs.test.ts`（`queries.test.ts` から分ける） | `getConnectionStatus`、`getLatestRuns`、`listRecentRuns`、`getJobStats`。`job` と `status` の絞り込み。2 アカウントの分離 |
| `test/db/account.test.ts` | `META_TARGET_IG_USER_ID` が未設定、一致なし、一致ありで `getTargetAccount` が正しく返し、未設定と一致なしでほかのアカウントを選ばない |

- CSV の結合テストの期待値は proxy の動きにする（未ログインは 303 で `/login`、許可外は 403、本人は 200）。ハンドラーの 401／403 は 9.1 節の単体テストで確かめる。
- **性能の計測**は自動テストにせず、手動のスクリプト（`scripts/` に置く。合成データ 1,000 件を入れて、投稿一覧、投稿詳細、概要の主なクエリを `explain analyze` する）にする。判定は「各クエリの実行時間が 500 ms 以下」。結果を `doc/progress.md` に記録する。

### 9.3 画面の受け入れ（要件 10 章の R3 の完了条件）

- **デザインシステム**: PC 幅（1280px 程度）とスマートフォン幅（390px 程度）で、概要、投稿一覧、投稿詳細（フィード、カルーセル、リールの 3 件）、期間比較、接続と収集ログを見本（`doc/design-lab/v3/`）と見比べ、ユーザーが確認する。ナビの複数段のタブ、表とカードの切り替え、ヒントのタップを確かめる。画面のキャプチャはコミットしない。
- **数値の照合**（DB と Instagram アプリ）。手順:
  1. 収集のジョブ（投稿の指標）が成功した直後に、対象の投稿の最新のスナップショットの値と `fetched_at` を SQL で書き出し、`.local/r3-check/` に保存する。
  2. 書き出しから 30 分以内に、Instagram アプリのインサイトで同じ投稿の値を写し、同じファイルに書く。
  3. 対象: フィード、カルーセル、リールのそれぞれで、投稿から 7 日を過ぎた投稿 1 件と 7 日未満の投稿 1 件（最大 6 件。ない種類は飛ばして記録する）。指標はリーチ、閲覧数、いいね、保存、シェア（フィードはプロフィール訪問とフォローも）。
  4. 許容差（案）: 7 日を過ぎた投稿は「差が 5% 以内、または差の絶対値が 3 以内」で合格。7 日未満の投稿は値が動くので記録だけにし、合否は付けない。許容差は確認事項 Q20。
  5. アカウント単位: アプリの「過去 7 日」のリーチと閲覧数を、概要の過去 7 日（太平洋時間の日付の合計）と比べる。期間の区切りと集計の定義が違うので差の率を記録するだけにし、合否は付けない。
  6. 画面と DB の照合は別の手順にする。同じ投稿について、画面（一覧と詳細）の数字が SQL の値と表示の丸め以外で一致することを確かめる（ここは完全一致で合格）。
  7. 記録の列: 確認日時、種類、経過の区分（7 日超／未満）、指標、DB の値、アプリの値、差、差の率、合否。実数（DB の値、アプリの値、差）と投稿の ID は `.local/` にだけ置く。`doc/` には種類、区分、指標、差の率、合否だけを表で残す（ID、ユーザー名、実数を書かない）。
- **件数が少ないとき**: 本番の 24 件（すべて収集開始より前の投稿）で、投稿詳細と投稿一覧の基準値が「最新の値で比較（投稿から 30 日以上の投稿）」と明記されて帯と n が出ること、7 日時点の比較が使われないこと（7 日時点の値は既存の理由の「—」で、収集開始前の投稿のための専用の説明が出ないこと）、リーチ率が全件「—」になること、薄い表示と n の表示を確かめる。空の DB（ローカル）で各画面の空の表示、`META_TARGET_IG_USER_ID` が未設定のときの表示を確かめる。
- **アクセシビリティ**: キーボードだけでナビ、並べ替え、ページ送り、ヒント、期間の入力を操作できる。表の `aria-sort`、グラフの `aria-label`。黄と緑の系列に数値ラベルか表が添えてある（design-system.md の注意）。
- **ビルドと静的検査**: `next build`、ESLint、型検査、vitest が通る。

---

## 10. 実装の段階分け

同じ作業ツリーで、段階ごとにファイルを分担する（git worktree は使わない）。同じファイルを 2 人が同時に触らないように、各段階の担当ファイルを決める。**各担当は自分のテストファイルも書く**（9 章の表のファイル）。

### 段階 0: 土台

| 担当 | ファイル（テストを含む） |
|---|---|
| DB（`postgres-sql-reviewer` が設計とレビュー） | `supabase/migrations/…_r3_analysis_views.sql`、`test/db/views.test.ts`、`scripts/` の性能計測のスクリプト |
| 画面の土台（`nextjs-developer`） | `apps/web/src/app/globals.css`、`apps/web/src/app/layout.tsx`、`apps/web/src/components/`（5.2 節の共通部品と `charts/` の 4 種）、`lib/format.ts`（書式の追加）、`lib/metrics.ts`（派生指標の表示規則、「—」の理由、基準値の出し方）、`lib/period.ts`、`lib/params.ts`、`lib/csv.ts`、`test/metrics.test.ts`、`test/baseline.test.ts`、`test/period.test.ts`、`test/params.test.ts`、`test/csv.test.ts`、`test/charts.test.ts` |
| 共通のクエリと移動（`nextjs-developer`。画面の土台のあと） | `lib/queries/account.ts`、`lib/queries/period-summary.ts`、`lib/queries/baseline.ts`（比較の基準の選び方。B、C、D が読むだけ）、R1 の `/` の接続状態の部品を `/jobs` 側へ移す作業、`test/db/queries.test.ts` を `test/db/media.test.ts` と `test/db/jobs.test.ts` に分ける作業、`test/db/account.test.ts`、`test/db/period-summary.test.ts`、`test/routes.test.ts` への新しい URL の追加（proxy の設定は変えない） |

DB と画面の土台は触るファイルが違うので並列にしてよい。共通のクエリは DB のマイグレーションのあと。段階 0 の終わりに、部品の見た目を概要の骨組みでユーザーに見せる。

### 段階 1: 画面（並列）

| 担当 | 画面 | ファイル（テストを含む） |
|---|---|---|
| A | 概要 | `app/page.tsx`、`app/_overview/*`、`lib/queries/overview.ts` |
| B | 投稿一覧と投稿の CSV | `app/media/page.tsx`、`app/media/_list/*`、`lib/queries/media.ts`、`app/export/media/route.ts`、`test/db/media.test.ts` |
| C | 投稿詳細 | `app/media/[id]/page.tsx`、`app/media/[id]/_detail/*`、`lib/queries/media-detail.ts`、`test/db/media-detail.test.ts` |
| D | 期間比較と日次の CSV | `app/compare/page.tsx`、`app/compare/_compare/*`、`lib/queries/compare.ts`、`app/export/daily/route.ts`、`test/db/compare.test.ts` |
| E | 接続と収集ログ、接続設定とログインの見た目 | `app/jobs/*`、`app/connect/*`、`app/login/*`、`lib/queries/jobs.ts`、`lib/queries/connection-status.ts`、`test/db/jobs.test.ts` |

- A と D は段階 0 の `period-summary.ts` を読むだけにする。B と D は段階 0 の `lib/csv.ts` を読むだけにする。CSV の Route Handler の単体テストは `test/routes.test.ts` に足すので、B と D は順番に足す（同時に編集しない）。
- 共通部品（`components/`、`lib/`）の変更が要るときは、段階 1 の中では直さず、親に戻して段階 0 の担当がまとめて直す。
- 特殊な投稿の除外の設定を作る場合（確認事項 Q4）は、段階 0 の画面の土台の担当が `lib/exclude.ts`、Server Action、`test/exclude.test.ts` を持つ。

### 段階 2: 仕上げ（順番に）

1. テストの不足を足す（`quality-engineer`）。
2. CSV、入力の検査、（作るなら）除外の設定の `security-engineer` のレビュー。
3. 性能計測のスクリプトを本番相当の件数で 1 回動かす。
4. 本番での数値の照合と、PC とスマートフォンでのユーザーの確認（9.3 節）。
5. `doc/progress.md` と README の更新。

---

## 11. 確認事項

ユーザーに決めてもらうこと。推奨を添える（0.1 の Q1〜Q13 とレビューの指摘を統合し、番号を振り直した）。

**回答（2026-10-05）: Q1〜Q20 はすべて推奨どおり。**

| # | 事項 | 推奨 |
|---|---|---|
| Q1 | `/` を概要にし、R1 の接続状態を `/jobs` にまとめること | まとめる（見本の「接続と収集ログ」と同じ構成） |
| Q2 | グラフの描画に依存を増やすか | 増やさない。見本の SVG の描画関数を Server Component に移す（5.3 節） |
| Q3 | 経過時間の区分の許容幅 | 1h〜6h は + 1 時間、24h 以上は + 区分の 25%（4.3 節）。本番の 24 件で外れる投稿の数を見てから決め直す |
| Q4 | 特殊な投稿の除外の設定を R3 で作るか（3 列は全件 null で、今は何も変わらない） | 作らない。タグと注記だけにし、判定の手段ができたときに 8.2 節の設計で作る |
| Q5 | 概要のリーチと閲覧数は日別の合計で、期間のユニーク数ではない。タイルの名前 | 名前は「リーチ」のまま、補足とヒントに「日別の合計」と書く |
| Q6 | 概要と期間比較の ER と保存率を「合計の比」にするか「投稿ごとの率の中央値」にするか | 合計の比（欠損のない投稿だけ、n 件中 m 件を表示）をタイルに出し、中央値は期間比較の基準値の表に出す |
| Q7 | ER の分母をフォロワー数にしたときの式（期間の合計 ÷ フォロワー数は投稿数に比例する） | 1 投稿あたり（期間の反応の合計 ÷ m ÷ 期間末のフォロワー数） |
| Q8 | フォロワー純増の前期間比を増減率にするか人数の差にするか | 人数の差（例: +12 人）。純増は 0 や負になりやすく、増減率が意味をなさないため |
| Q9 | 非フォロワーリーチ比率の分母（内訳なしの `reach` か、内訳の合計 `reach_follower + reach_non_follower` か） | 内訳の合計。分子と同じ内訳から取れ、0 と未取得の扱いがそろう。分母を表示する |
| Q10 | 古いデータの警告を出すまでの日数 | 3 日（日次指標は前日分を毎日取るので、通常は 1〜2 日前が最新） |
| Q11 | 投稿時のフォロワー数の記録がない投稿（R1 の収集開始より前）のリーチ率 | 「—」にする。日次の `follower_count`（新規フォロワー、直近 30 日のみ）から遡って推定しない |
| Q12 | 投稿一覧の題名にキャプションの 1 行目を使うか（R1 は出さない方針だった）。CSV にキャプションを入れるか | 使う（F-UI-21 の「題名」と見本に合わせる）。CSV にも入れる（数式の注入の対策をする） |
| Q13 | 指標の定義の文言の置き場所 | API の指標は `metric_definitions.description` をマイグレーションで埋めて使う。派生指標は TS の定数。二重に持たない |
| Q14 | 投稿詳細のファネル（フィードとカルーセル）。「各指標は画面に 1 回」と重なる | ファネルのカードは置かず、プロフィール遷移率とフォロー転換率を質の指標に 2 行足す |
| Q15 | 保存率の目安値（2〜3%）の出典と年。設定画面を作るか | R3 では定数で出典と年を添えて表示し、設定画面は作らない |
| Q16 | 伸び方のグラフの 90 日の区分。90 日時点までスナップショットの収集が続くか | 収集の予定を確かめ、続くなら `90d` を足す。続かなければ 30 日までにして要件の表記を直す |
| Q17 | 見本にある「今すぐ収集」ボタン | R3 では作らない（GitHub Actions を起動する資格情報を Vercel に置くことになるため） |
| Q18 | CSV の列の見出しを英字にするか日本語にするか | 英字のスネークケース（ビューの列名と同じ）。日本語の対応表を README に置く |
| Q19 | CSV の Route Handler の未ログインの応答（proxy は 303、ハンドラーは 401） | ハンドラーは 401 のままにする（proxy を通った後に未ログインになるのは異常で、ダウンロードの途中でログイン画面の HTML を CSV として保存させないため） |
| Q20 | 数値の照合の許容差 | 7 日を過ぎた投稿で「差が 5% 以内、または差の絶対値が 3 以内」。7 日未満とアカウント単位は記録だけ |
| Q21 | 比較の基準に「最新の値（投稿から 30 日以上の投稿）」を足し、7 日時点と自動で切り替える（7 日時点が許容内の比較相手が 3 件以上なら 7 日時点） | 回答: 採用（2026-10-05）。3.1 節「比較の基準」。収集開始前の投稿のための新しい理由や文言は足さない |

---

## 付録 A. 読んだ資料

### 0.1（起草）

| 資料 | 範囲 |
|---|---|
| `doc/requirements/requirements-definition.md` | 210〜233 行（4.4 章）、410〜418 行（5.5 章）、475〜519 行（7 章）、626〜672 行（9 章、10 章） |
| `doc/design-system.md` | 全体 |
| `doc/design-lab/README.md` | 43〜62 行（トークンの区分、グラフの決まり）、183 行以降（見本画面の注記） |
| `doc/design-lab/v3/render.js` | 239〜460 行（概要、投稿一覧、投稿詳細）、709〜731 行（接続と収集ログ） |
| `supabase/migrations/20261001100100_r1_collection.sql` | 全体 |
| `supabase/migrations/20261001100400_r1_views.sql` | 全体 |
| `supabase/migrations/20261002005926_r2_web_role.sql` | 1〜155 行 |
| `apps/web/src/lib/queries/media.ts`、`apps/web/src/app/media/page.tsx`、`apps/web/src/app/layout.tsx` | 全体 |
| Next.js 16 の文書 `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` | 全体 |
| 同 `06-fetching-data.md` | 全体 |
| 同 `08-caching.md` | 1〜110 行 |

### 0.2（レビューの反映）

- この設計書だけを読み直した。proxy の matcher、日次指標の名前と内訳、スナップショットの JSON のキー、`metric_definitions` の列、特殊な投稿の 3 列の状態、テストの道具と置き場所は、3 本のレビューが確かめた事実を使った（レビューの根拠のファイルは読み直していない）。

### 未確認のまま残るもの

`doc/design-lab/v3/lab.css`、`next/font` の文書（`13-fonts.md`）、90 日時点まで収集が続くか。

0.4 で確認済みにしたこと（再レビューと親による実データの確認）: `reels_skip_rate` は 0〜100 の単位（28.6〜49.4）。`reach` と `views` の `follow_type` の印の行には合計値が入る。最新の日は `follower_count` の行だけで `reach` が null のことがある。収集開始前の投稿 24 件は 1h〜7d が全区分で許容外（30d は 1 件、90d は 3 件が許容内）、`followers_at_post` は 0 件。カルーセルの投稿はまだない。0.4 で読んだのはこの設計書と `supabase/migrations/20261001100400_r1_views.sql` の 94〜139 行（ロールバックに載せた）だけ。

親が確かめたこと（2026-10-05）: `next.config` は `cacheComponents` を設定していない（従来のモデル。動的描画は `src/lib/dynamic.ts` の `connection()`）。全ルートの `Referrer-Policy` は `same-origin`（R1 で `no-referrer` から変更）。`META_TARGET_IG_USER_ID` と照らすのは `accounts.ig_user_id`（`text not null unique`）。

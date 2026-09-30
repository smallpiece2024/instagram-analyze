# 調査05: Instagram アカウント運用の「分析の型」（KPI ツリー／レポート／ダッシュボード／分析手法／自作知見）

調査日: 2026-09-30。対象は「実務者がどう分析し意思決定しているか」。ツール機能一覧は対象外。
各項目に出典 URL と年を付す。確認できなかった事項は「未確認」、推測は「推測」と明記する。

## 0. 前提として押さえるべき定義変更（数値目安を読む際の注意）

- 2025-01-08: Meta が account-level の `profile_views` / `website_clicks` / `email_contacts` / `phone_call_clicks` / `text_message_clicks` / `get_directions_clicks` を廃止、2025-04 に完全削除（Emplifi, 2025 https://docs.emplifi.io/platform/latest/home/instagram-media-and-profile-insights-metrics-depre ）。現在の代替は `profile_links_taps`、`follows_and_unfollows`（Meta 公式リファレンス、2026-09-30 閲覧 https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights/ ）。
- 2025-04-21: `impressions`（および Reels の `plays`）が廃止され `views` に統一。Views は同一ユーザーの再表示も数えるため Impressions より「25% 以上高い」との報告（Zoomph, 2025-05 https://zoomph.com/blog/instagrams-shift-from-impressions-to-views-what-it-means-for-sports-sponsorship-social-media-reporting/ ）。Metricool は 2025-01-01 を境に Impressions/Views を分割表示、ストーリーズは Impressions のまま（Metricool Help, 2025 https://help.metricool.com/instagram-replaces-impressions-with-views-what-you-need-to-know-f6n8j ）。
- 含意: 2024 年以前の国内記事にある「ホーム率＝ホームからのインプレッション÷フォロワー数」等は、現在はアプリ内「閲覧数」の流入元別数値で読み替える必要がある（読み替えの妥当性は推測。Meta 公式の言及は未確認）。前年同期比は 2025-04 で系列が断絶する。

## 1. KPI ツリー／ファネル設計

### 1.1 KGI → KPI 分解の国内実例

| 出典（年） | KGI | 中間 KPI | 備考 |
|---|---|---|---|
| find-model (2022) https://find-model.jp/insta-lab/instagram-kpi-kgi-configuration/ | 来年度売上 前年比 +30% | Instagram 経由 EC 訪問数を半年で 2 倍／フォロワー数を 3 か月で 2 倍／ハッシュタグ投稿増加率 +30% | KPI ツリー＝KGI を頂点に KPI をぶら下げる図と定義 |
| growthseed (2022, 更新 2026-08) https://growthseed.jp/experts/sns/instagram-kpi/ | (1) 認知向上 (2) コミュニティ拡大 (3) 売上向上 | (1) リーチ・インプレッション・フォロワー・プロフィールアクセス (2) エンゲージメント数・保存数・ER（＝EG 数÷リーチ） (3) リンククリック数・インプレッション | 数値目安なし。「成長段階に見合った KPI」を強調 |
| aainc echoes (2020) https://service.aainc.co.jp/product/echoes-instagram/blog/instagram-kgi-kpi | EC: EC 売上/購入数、店舗: 来店数、ブランド: 認知率（純粋/助成想起）または UGC 投稿数 | 立ち上げ期: 投稿数・フォロワー数／成長期: EG 数・率、リーチ | 「インプレッション＝投稿数×1 投稿あたりインプレッション」の分解式 |
| comnico (2026-03) https://www.comnico.jp/we-love-social/socialmedia-goal | 認知／興味関心・ファン化／購買／拡散・ロイヤルティ | 認知: リーチ・インプレッション・プロフィール閲覧／興味: 保存・親密なコメント・DM 数／購買: CTR・CVR・CV 数／拡散: ストーリーズシェア数 | KPI 目標値の置き方 3 通り: 競合ベンチマーク、逆算式「リーチ×CTR×CVR×客単価」、3 か月テスト運用で実績ベース |
| inhouse-plus (2026-07) https://inhouse-plus.jp/reporting/instagram-insight-report/ | — | 認知＝リーチ／興味＝エンゲージメント・保存／成果＝新規フォロワー | 月次レポートの 5 必須項目として提示 |

海外の分類例: Later (2026-06) は Reach & Awareness／Engagement／Audience Growth／Conversion & Traffic／Paid の 5 群 https://later.com/blog/social-media-report/ 。Hootsuite (2026-05) は Awareness（フォロワー成長率・リーチ率・リールシェア）／Engagement（ER by follower, ER by reach）／Conversion（サイト流入・外部リンクタップ・ストーリーズリンククリック）＋North Star Metric の 9 指標 https://blog.hootsuite.com/instagram-metrics/ 。

### 1.2 フォロワー獲得メカニズムの指標化

国内で定着している「4 指標」（定義は複数記事で一致）:

| 指標 | 定義 | 目安（出典） |
|---|---|---|
| ホーム率 | ホーム（フィード）からの閲覧数 ÷ フォロワー数 | 30% 未満: 平均未満／30–40%: 平均／40–50%: 良／50%+: 優（strategy-code 2024, 更新 2026-09 https://strategy-code.com/marketing-colum/sns/instagram/home-rate/ ）。SAKIYOMI (2025-01) は規模別に 2,000 人: 30%、2–5 千: 40–50%、5 千–1 万: 50% https://sns-sakiyomi.com/blog/tips/instagram-algorithm/ 。lgram は 30–50%、60% 超でバズ可能性（年未確認 https://lgram.jp/media/know-how/instagram-insight-analysis/ ） |
| 保存率 | 保存数 ÷ リーチ数 | 2% 超で伸びやすく 3% 超で高確率でバズ（SAKIYOMI 2025-01）。2–3%（lgram）。2–4% 以上（neworder 2026-05） |
| プロフィールアクセス率 | プロフィールのアクティビティ ÷ リーチ数 | 1% 未満: 平均未満／1–2%／2–3%／3%+: 優（strategy-code 2024/2026 https://strategy-code.com/marketing-colum/sns/instagram/profile-access-rate/ ）。SAKIYOMI は 3–5%。lgram は 1–3%（美容サロン等は約 20% と業種差が大きい） |
| フォロワー転換率 | フォロワー増加数 ÷ プロフィールアクセス数 | 4% 未満／4–6%: 平均／6–8%: 良／8%+: 優（strategy-code 2024/2026 https://strategy-code.com/marketing-colum/sns/instagram/follower-conversion-rate/ ）。SAKIYOMI・lgram も 6–8% |

これらは各社の経験則で母集団は非公開。Meta 公式の目安は存在しない（未確認ではなく、公式ドキュメントに記載がないことを確認）。

海外の同型ファネル "reach → profile visits → follows": creatorflow (2026) は「リーチの 3–8% がプロフィール訪問」「フォロワー外リーチの 1–3% がフォロー」を目安として提示（根拠データは未提示） https://creatorflow.so/blog/instagram-analytics-creators-metrics-guide/ 。OSS の jdh4601/instagram-dashboard (2026) も "reach → profile visits → follows or bio-link clicks" をアカウントファネルとして実装 https://github.com/jdh4601/instagram-dashboard 。

API 上の対応: メディア単位インサイトに `reach`, `profile_visits`, `profile_activity`, `follows` が存在するため、投稿ごとに「リーチ→プロフィール→フォロー」の 2 段転換率を計算できる（Meta 公式、2026-09-30 閲覧 https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights/ ）。アカウント単位では `reach`/`views` に `follower_type` ブレークダウン（フォロワー／非フォロワー）がある（gist jameschapman2c 2026-04 https://gist.github.com/jameschapman2c/65eff9f54a2d350b17a6ce5127b9fe42 ）。

### 1.3 投稿単位の評価指標と目安値

| 指標 | 目安 | 出典（年・母集団） |
|---|---|---|
| ER（by followers） | 全体平均 0.48%（前年比 −24%）。カルーセル 0.55%／リール 0.52%／画像 0.37% | Socialinsider 2026（2025 年 1–12 月、3,500 万投稿・44.7 万ページ） https://www.socialinsider.io/social-media-benchmarks/instagram |
| ER（by followers） | 1–3% が平均、5%+ で強い。業種別 3.0–4.4%（教育 4.2%、非営利 4.4% など） | Hootsuite 2026-05 / 2026-06（自社調査、期間不明） https://blog.hootsuite.com/average-engagement-rate/ |
| ER（by reach） | 5%+（Hootsuite）。規模別目標: 1–10K 6%+、10–100K 4%+、100–500K 2.5%+、500K+ 1.5%+（creatorflow 2026） | 上記 |
| リーチ率 | 投稿 12%／ストーリーズ 2%（大規模）。小規模は投稿 34%／ストーリーズ 7.5%（Hootsuite 2026-05） | 国内: 1,000 人未満 40–70%、1 千–1 万 30–50%、1 万+ 10–30%（walkand 2026-09 https://walkand.co.jp/instagram-reach-guide/ ） |
| フォロワー外比率 | リールは閲覧の 55% が非フォロワー。リールのみ非フォロワー>フォロワー。目標 40–60%、30% 未満は新規到達不足（creatorflow 2026、原典未確認） | 国内: 投稿インサイトで発見タブ流入 80% なら外部拡散成功と判断（検索要約、原典個別未確認） |
| シェア率 | シェア÷リーチ 1–2% で強、3%+ で DM 拡散（creatorflow 2026）。1–3% 以上（neworder 2026-05） | |
| コメント数・保存数（実数） | 1–5K: リール 3 件・保存 1／10–50K: コメント 12・保存 7／100K–1M: コメント 60・保存 96（リール、投稿あたり中央値） | Socialinsider 2026 |
| リール視聴維持率（avg watch time ÷ 尺） | 15 秒未満 55%+（70%+ で強）／15–30 秒 45%+／30–60 秒 40%+／60 秒超 30%+ | Retensis 2026-04（「目標値であり測定平均ではない」と明記） https://retensis.com/blog/good-instagram-reels-retention-rate |
| リール平均視聴時間 | 30 秒動画で 8–16 秒が最もエンゲージ高。維持率単独は EG との相関が弱く、平均視聴時間と併用で有効 | That Random Agency 2026-01（自社 101 本） https://www.thatrandomagency.com/blog/video-watch-time-2026 |
| 3 秒スキップ率／視聴時間 | スキップ 30% 未満、平均視聴時間は尺の 50% 超 | creatorflow 2026 |
| 視聴維持率（国内） | 70% 以上 | neworder 2026-05（海外目安より大幅に高い。定義差の可能性、要注意） |
| ストーリーズ完了率 | 平均 70%、離脱率 5%（<190K: 68.3%/6.0%、1.1M+: 70.5%/4.4%） | Dash Social 2025-12 更新（2K ブランド、2025-01〜06） https://www.dashsocial.com/blog/every-instagram-stories-performance-benchmark-you-need-to-know |
| ストーリーズ離脱率（枚数別） | 1 枚目 23.8%、3 枚目 18.5%、9 枚目 13.3%。タップフォワード 50–66%。リーチ率は 1–5K 10.4% → 100K+ 0.65% | Socialinsider 2025（161,180 ストーリーズ、2025-01〜05） https://www.socialinsider.io/social-media-benchmarks/instagram-stories-benchmarks |
| ストーリーズリーチ率（国内） | 10–20%（neworder）。閲覧率 20% 割れで発見欄露出・ライブ集客に影響（eduGate 2026-09 https://blog.edugate.jp/instagram-nobinai-toukou-type-shindan/ ） | |
| フォロワー成長率 | 1–2%（期間未記載、Hootsuite）。週 1–2%（<100K）、0.5–1%（>100K）（creatorflow）。年間: 1–5K 22%、100K–1M 11.25%（Socialinsider 2025 年） | |

ストーリーズ完了率の定義例: 「最終フレーム閲覧者 ÷ 最初のフレーム閲覧者 ×100」（ReportingNinja 2026-05 https://www.reportingninja.com/blog/instagram-analytics-report ）。Emplifi は「離脱・タップバック・タップフォワードで中断されなかったインプレッションの割合」と定義（式は未記載） https://docs.emplifi.io/platform/latest/home/story-completion-rate 。

## 2. レポートの型

### 2.1 企業 SNS 担当 → 上司・経営層（月次）

- neworder (2026-05) https://www.neworder.co.jp/2026/05/26/instagram_reporting/ : サマリー 1 枚に 7 指標（フォロワー増減、月間総リーチ、平均 ER、リール視聴維持率、平均保存率、ストーリーズリーチ率、月間投稿数）。各指標に「前月比・目標比・原因分析・翌月施策」をセット。指標は 5–7 個に絞り「3 分で意思決定できる」構成。フォーマット別に最重要指標を分ける（フィード: 保存率・ホーム率／カルーセル: DM シェア・ER／リール: 視聴維持率・完全視聴率／ストーリーズ: リーチ率・スワイプアウト率）。記述例「保存率低下の原因は告知投稿 4 本、来月はノウハウ型カルーセル週 1 本で 2.5% 回復を目指す」。
- inhouse-plus (2026-07): 3 ステップ（インサイト確認→スプレッドシート記録→グラフ＋コメント）。月次シート（行＝年月、列＝5 項目）と投稿シートを分ける。上位投稿 3 件をサムネ付きで掲載、推移は折れ線。
- SAKIYOMI (2024-04) https://sns-sakiyomi.com/blog/tips/instagram-report/ : 6 項目＝フォロワー増加数（日次と月次）、投稿ごとのリーチ、投稿ごとの保存数（＋保存率）、ホーム率、プロフィール遷移数と転換率、フォロワー転換率。
- comnico (2026-01) パワポ無料テンプレ https://www.comnico.jp/we-love-social/sns_report : KPI 進捗／フォロワー推移／主要数値推移／投稿一覧／ER 良好・不良投稿／投稿カテゴリ別分析／投稿タイプ別分析／競合比較／まとめ＆次月アクション。
- 共通する型: 「結果 → 原因 → 次アクション」を 1 行ずつ。Later (2026-06) も「最重要の発見を冒頭に」「指標を目標に接続」「次のステップで締める」を推奨。

### 2.2 代理店・運用代行 → 顧客

- Re:Works (2026-04) https://reworks-official.jp/monthly-report-writing/ : 9 セクション＝①総評（結果・課題・来月方針を 3 行）②KPI サマリー（フォロワー・リーチ・プロフアクセス・リンククリック・保存を前月比）③勝ち投稿 Top3（再現可能要素の言語化）④課題投稿 Top3（原因仮説＋改善案）⑤カテゴリ別・形式別分析⑥ボトルネック分析（リーチ→CV のファネル転換率を目安と比較）⑦来月の施策提案⑧来月の投稿計画（週単位）⑨競合アカウント分析。
- sharecoto レポートサービス https://www.sharecoto.co.jp/service/instagram-support/report : PDF 月次、フォロワー推移（日別）／投稿全体まとめ（12 の分析軸）／ハッシュタグ分析（共起タグ）／競合・新着情報。12 万円〜/月。
- 海外テンプレ: AgencyAnalytics（表紙／Monthly Summary／Insights（フォロワー・コメント・いいね・属性）／Feed（期間内の投稿・ストーリーズ・リール）／Ads／Goal & Budget Pacing） https://agencyanalytics.com/report-templates/instagram 。DashThis（ER・フォロワー成長率・サイトクリック・CTR・プロフィール訪問・属性。表＝上位投稿/ハッシュタグ、折れ線＝推移、円＝属性/投稿タイプ、棒＝複数 KPI 推移） https://dashthis.com/instagram-report-template/ 。ReportingNinja (2026-05): Audience／Engagement／Content／Reach／Conversion の 5 節。Later (2026-06): Summary／Key Metrics／Top Posts／Community Insights（コメント・DM からの顧客の声）／Campaign Results／Strategy Updates／Next Steps。HubSpot・Canva 等の汎用テンプレは「フォロワー数・投稿数・ER・リーチ・前月比」の最小構成（検索要約、個別未確認）。

### 2.3 Looker Studio／スプレッドシートの実例

- Windsor.ai テンプレ (2026-09) https://windsor.ai/data-studio-instagram-insights-overview-report/ : 3 ページ（Insights Overview＝スコアカード／Posts Reporting＝投稿別表／Insights Activity＝日別時系列）。取り込み経路は「Meta Business Suite CSV → Sheets → Looker Studio（更新なし・履歴はエクスポート時点のみ）」か「コネクタ（Windsor/Supermetrics/Catchr/Databloo/ReportDash 等、時間・日次更新、履歴をコネクタ側で蓄積）」 https://windsor.ai/how-to-import-instagram-data-into-looker-studio/ 。
- 国内 SaaS 例 inhouse-plus https://inhouse-plus.jp/portfolio/instagram-monthly-report/ : Looker Studio 出力、34 プリセット、毎日 17 時に前日分反映、過去 24 か月保持、月 4,980 円。項目＝アカウント概要・月次/日次推移・投稿一覧（サムネ）・動画/リール・ストーリーズ・属性（性別/年齢/地域）。
- GAS 自作例: rightcode (2023-11) は「フォロー・フォロワー」「インサイト（リーチ・インプ・プロフィールビュー）」「投稿別（いいね・コメント・インプ・リーチ・保存・URL）」の 3 シート https://rightcode.co.jp/blogs/42608 。Qiita shink97 (2022-09) は「90 日前までしか遡れないので毎日の定点観測を残す」動機で日次取得 https://qiita.com/shink97/items/20ec3c55b94a3f0ec585 。zenn renue (2025-04) は広告日別／投稿別／フォロワーの 3 シート＋CPA 自動計算 https://zenn.dev/renue/articles/327f4e82a58d86 。
- ストーリーズは Supermetrics 公式でも「作成後 24 時間しか取得不可、5 ビュー未満は 0 が入る」ため、Sheets の「新結果を旧結果と結合」で自前蓄積を推奨 https://docs.supermetrics.com/docs/about-instagram-insights-story-reporting-limitations 。

### 2.4 粒度（週次／月次／四半期／キャンペーン）

- Later (2026-06): 月次＝定例、四半期＝戦略評価、年次＝前年比・予算、週次＝キャンペーン中のみ任意。AgencyAnalytics は日次〜年次のスケジュール配信に対応。Improvado (2026-08) は 7/14/30/90 日での確認と「月次でベースライン設定」 https://improvado.io/blog/instagram-analytics-dashboard 。
- comnico (2026-03): 新規開始時は 3 か月をデータ収集期間として実績ベースで KPI 設定。
- Later (2026-08) のタグ運用では「最低月 1 回タグ別に集計」 https://later.com/blog/social-media-campaign-tagging-system/ 。
- 前年同期比は 2025-04 の Views 統一で断絶するため、脚注で明示し ER・フォーマット別指標で比較するのが推奨（Zoomph 2025-05）。

## 3. ダッシュボード設計のベストプラクティス

### 3.1 一般的な画面構成

- Iconosquare: Analytics タブ＝Overview／Engagement／Community／Reach／Stories／Reels・Videos／Mentions／Profile activity、＋ウィジェット自由配置のカスタムダッシュボード（レビュー記事群 2026、検索要約）。
- Improvado (2026-08): Overview（フォロワー成長率・ER）／Content Performance（投稿・ストーリーズ・リールをリーチ/EG でソート）／Audience Demographics（地域・年齢・性別・アクティブ時間）／Engagement（いいね・コメント・保存・シェア・完了率）／Business Impact（CV・CTR・CPA）。
- Windsor テンプレ: 概要 → 投稿別 → 日別。jdh4601: ファネル（reach→profile→follow/bio click）、フォロワー/非フォロワー別リーチ、7 日変化、ルールベース診断（強み・ボトルネック）。
- Sprout Social: Post Performance Report をタグでフィルタ、Tag Performance Report でタグ別比較（サポートページは 403 で本文未確認、検索要約のみ）。

### 3.2 期間比較・移動平均・初速（時間経過別）

- 前月比・目標比の 2 軸表示（neworder 2026-05）、前月比と推移で必ず比較（Re:Works 2026-04）、季節性の把握（ReportingNinja 2026-05）。
- 初速: 「投稿後 24 時間以内の初速エンゲージメントが重要、フォロワーが多い時間帯に投稿」（tetemarche、検索要約 https://tetemarche.co.jp/column/instagram-views ）、「初速がバズに最重要」（excellent 2023-05 https://excellent.ne.jp/sns/8335/ ）、「フォロワーアクティブ時間に投稿し初速確保」（comnico 2026-09 https://www.comnico.jp/we-love-social/ig-algorithm ）。海外は Engagement Velocity＝総エンゲージメント÷投稿後経過時間（B Squared 2025-04 https://bsquared.media/what-is-social-media-engagement-velocity/ ）。1h/3h/6h/24h 刻みの計測を推奨する記事もあるが原典未確認。
- API 制約（重要）: メディア単位インサイトは累積値のみ返す（時系列なし。推測: 公式リファレンスに period 指定が無いことから）。24h/48h/7d/28d の曲線を描くには、自前で投稿後のスナップショットを定期取得して差分を保存する必要がある。データ反映は最大 48 時間遅延（Meta 公式）ので「投稿後 1 時間の値」は信頼できない可能性がある（推測）。

### 3.3 異常検知・アラート

- Improvado (2026-04, 更新 2026-07) https://improvado.io/blog/marketing-anomaly-detection-automated-alerts : 固定閾値（透明だが季節で誤報）vs ベースライン型（4–8 週の季節ベースラインとの乖離）。2–3 連続区間の逸脱で発火、重大度で通知先を分ける（高: 即時／中: Slack・メール／低: 週次ダイジェスト）、回復ウィンドウでフラッピング防止、アラート精度 70%+ を目標。
- 適用例: n8n の Follower Growth Tracker は毎日 0 時に `followers_count` と `insights?metric=follower_count&period=day` を保存し、閾値外なら Slack 通知（keyapi 2026-04 https://www.keyapi.ai/blog/n8n-instagram-graph-api-node-guide/ ）。GPT-4 で投稿の高/低パフォーマンスをスコアして Slack に通知する n8n テンプレもある https://n8n.io/workflows/10824-automate-instagram-engagement-and-sentiment-analysis-with-gpt-4-and-slack-reports/ 。
- 「バズ検知」の実務的定義例: 自アカウントの直近 N 投稿の中央値に対する倍率（例: リーチ 3 倍、保存率 3% 超）。目安値は SAKIYOMI の「保存率 3% 超で高確率でバズ」以外に定量的な出典は未確認。

### 3.4 投稿の属性タグ付けと A/B 比較

- Later (2026-08): タグは 3 種（Campaign／Content Type＝リール・カルーセル・UGC・教育・舞台裏／Goal＝認知・CV・コミュニティ・流入）、合計 3–5 個に絞る、「測るものを名前にする（Project Phoenix より Q3 launch）」、予約投稿時に付ける（事後付与は続かない）。
- graphed (2025-12) https://www.graphed.com/blog/how-to-analyze-instagram-content-strategy : 投稿を 3–5 のピラーとフォーマットに分類し群ごとの平均を算出、上位群を特定。「直近 30 日の上位 20% がピラー」（検索要約）。
- USAGov (2020) https://www.usa.gov/blog/2020/08/six-things-we-learned-from-our-usagov-instagram-audit : 141 投稿を種別・曜日・時間で集計。火・木は月水金の 3 倍、9 時と 12–15 時（ET）がピーク、インフォグラフィックはいいねが少ないがシェア・保存 10 倍、動画は最低いいね。
- 手動か自動か: フォーマット（`media_type`, `media_product_type`）は API から自動付与できる。テーマ・CTA 有無・撮影パターンは手動タグが基本で、Sprout はキーワードによる自動タグ付けを提供（検索要約、未確認）。jdh4601 は「ルールベース診断＋任意で LLM」を採用し、再現性・デバッグ性を理由に決定論的分析を優先。

## 4. 分析手法・フレームワーク

### 4.1 「伸びた／伸びなかった投稿」の要因分析

- 国内の定石: 伸びた投稿と伸びなかった投稿を並べ、タイトル・冒頭、デザイン、テーマ適合、曜日時間、ハッシュタグの差を比較（mbp-japan、検索要約）。kimkim (2025-04) https://note.com/kimkim417/n/nafedfe3d8354 : 成功投稿は「共感性・有益性・視覚的魅力」、失敗は原因分析、成功は再現性確認。eduGate (2026-09): フォーマット別に見る指標を固定（リール＝再生数・視聴維持率／フィード＝いいね・保存・コメント／ストーリーズ＝閲覧数・返信、閲覧率 20% 割れが警告線）。
- アルゴリズム側の評価シグナル（comnico 2026-09、Mosseri 発言の整理）: 視聴時間・シェア（送信）が最重要、いいねが重要。「保存」より「送信」重視へ、オリジナリティ（透かし・再投稿は露出低下）、冒頭 3 秒、ハッシュタグは関連性の高い 5 個以内。creatorflow (2026) も「Mosseri 2025-01: watch time → likes per reach → sends per reach」と整理。
- 失敗事例: excellent (2023-05) はフォロー整理でホーム率 10–20%→30–40%、ストーリーズ閲覧率 10–20%→20–30% に改善したが保存率 0–0.5% は不変で発見タブ掲載に至らず撤退。示唆: フォロワー内指標の改善だけでは外部拡散に直結しない。
- 実務手順の型（各記事の共通項を整理）: ①同フォーマット内で上位 20%/下位 20% を抽出 ②タグ（テーマ・CTA・構成）で集計 ③差が出た属性を仮説化 ④翌月 2–4 本で検証 ⑤レポートに「勝ち Top3／課題 Top3」として記載（Re:Works 2026-04）。

### 4.2 ハッシュタグ戦略

- 2024 年にハッシュタグのフォロー機能と「最近」タブが廃止、Mosseri は「ハッシュタグはリーチに直接影響しない」と繰り返し発言（Inrō／Edge Marketing 等 2026、検索要約）。2025–2026 はキーワード検索・SEO 型の発見へシフト、推奨は関連性の高い 3–5 個（複数記事）。
- 定量: Fanpage Karma (2026) https://www.fanpagekarma.com/insights/do-instagram-hashtags-work/ は 160 万投稿で「5 個でリーチ +2%、4 個はほぼ同等、1–3 個は 0 個より低い、6 個以上は低下」。構成は大規模 2–3＋中規模 1–2＋ニッチ 1。効果は「測定可能だが小さい」。
- 流入測定: アプリ内の投稿インサイトには閲覧の流入元（ホーム／発見／プロフィール／ハッシュタグ／その他）が表示されるが、API で流入元別は取得できない（推測。SINIS FAQ は 403 で未確認）。Hashtag Search API はユーザー名を返さず、直近 24 時間、7 日で 30 タグまで、50 件/ページ（creatorflow 2026-08 https://creatorflow.so/blog/ugc-tracking/ ）。
- 含意: 自作ツールでは「投稿ごとの使用タグを保存し、タグ組み合わせ別のリーチ・非フォロワー比率を事後集計」が現実的。

### 4.3 投稿時間・頻度

- `online_followers`: フォロワーの時間帯別オンライン数。「直近 30 日分のみ」「100 フォロワー未満は不可」（Meta 公式）。曜日×時間のヒートマップ化が定番。
- USAGov (2020) は自投稿の実績から曜日・時間を決定。目安の一般論（昼 9–15 時等）は地域差が大きいので、online_followers と自投稿の初速の照合が実務的（推測）。
- 頻度: Socialinsider 2025 年の投稿数中央値はリール 8/月、カルーセル 5/月、画像 7/月。eduGate は「リール週 1 以上、フィード間隔 1 週間以内、ストーリーズ 1 日 3–5 回」。Socialinsider 2025 ストーリーズ: 1–5K は週 3 本、10–50K は日 1 本。「週 3 投稿 4.1% vs 毎日 3.2%」等の主張は原典未確認。

### 4.4 フォロワー属性とコンテンツの整合性

- API の属性: 年齢・都市・国・性別、上位 45 件のみ、100 フォロワー以上（gist 2026-04、Meta 公式）。
- 実務: 想定ターゲットと実フォロワーの年齢・性別・地域のズレを確認し、偏っていれば投稿内容・ハッシュタグを見直す（comnico 2026 インサイト解説ほか、検索要約）。comnico (2026) https://www.comnico.jp/we-love-social/business-profile-instagram-insight-2 は「フォロワー/非フォロワー内訳が全フォーマットで見られる」「リーチ・閲覧数・シェアを同時に追う」「アプリ内は 90 日（有料は 180 日）」と整理。
- 自作での拡張: `follower_type` ブレークダウンで「投稿ごとの非フォロワー比率」を出し、テーマタグ別に「新規向け／既存向け」を可視化する（推測ベースの設計案）。

### 4.5 競合・ベンチマーク

- Business Discovery で取れるもの: `followers_count`, `follows_count`, `media_count`, `biography`, `website`, `username`, `profile_picture_url`, 直近メディアの `like_count`, `comments_count` 等。取れないもの: インサイト（リーチ等）、ストーリーズ、フォロワー一覧、非公開/年齢制限アカウント（Meta 公式 https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery/ 、keyapi 2026-06）。Platform Rate Limit の対象。
- 計算例: 直近 50–100 投稿の (いいね＋コメメント)÷フォロワー数で ER を推定（ficode、検索要約）。GAS Lab (2023-03) は毎日 10 時に競合のフォロワー数・投稿数・投稿別いいね/コメントをシートに蓄積 https://note.com/gas_lab/n/n4123b9dc53e9 。いいね非表示アカウントの扱いは未確認。
- 手順: Socialinsider (2026-09) の 6 ステップ（目的→コンテンツテーマ/形式→エンゲージメント→提携情報→ベンチマーク→施策）。比較指標は総エンゲージメント、ER（by followers と by reach）、フォロワー成長率、投稿頻度、コンテンツピラー別内訳 https://www.socialinsider.io/blog/competitive-analysis-on-instagram/ 。comnico (2026-03) は競合の成長率・ER を KPI 目標の基準線に用いる。

### 4.6 コメント・DM の定性分析

- Brand24 (2026-02) https://brand24.com/blog/instagram-sentiment-analysis/ : 対象は公開投稿・コメント・メンション・ブランドハッシュタグ。DM は対象外。手順＝キーワード設定→収集→フィルタ→感情比率→絵文字→トピック抽出→時系列。用途＝炎上検知、キャンペーン効果、トピック抽出、競合比較。限界＝皮肉・スラング・文化文脈、中立が大半。
- API: コメントは `/media/comments`、DM は Messaging API（`instagram_manage_messages`、Webhook `messages`）。Webhook は `comments`, `mentions`, `messages`, `story_insights` を提供、アプリ Live・Advanced Access が必要（Meta 公式 https://developers.facebook.com/docs/instagram-platform/webhooks ）。注意: ストーリーズ `replies` は「欧州と日本のユーザーの返信を含まない」（Meta 公式メディアインサイト）。日本の運用ではストーリーズ返信数を API で評価できない。
- FAQ 抽出の国内実務記事は検索予算切れで未確認。n8n の GPT-4 ワークフローのように LLM で「質問／称賛／苦情／スパム」に分類し質問をクラスタ化するのが自作の現実解（推測）。

### 4.7 キャンペーン／UGC／メンション

- creatorflow (2026-08): タグ付け投稿（`/tags`）と `mentioned_media` は投稿者が分かるので権利確認や連絡が可能。ハッシュタグ経由はユーザー名なし。ストーリーズでのメンションは Mentions API 非対応で DM 受信箱に届く。「潜在リーチ＝タグ付けした人のフォロワー合計」は上限値であり実績ではない。UGC ダッシュボードの指標＝ユニーク投稿者数、リピート投稿者（アンバサダー候補）、投稿の ER、返信で送った計測リンクのクリック。
- aainc (2020) はブランド KGI に UGC 投稿数を採用。Later はキャンペーンタグでレポートに Campaign Results 節を設ける。

## 5. 「自作ツール」の設計判断に関わる知見

### 5.1 データ保持と取得設計

| 制約 | 内容 | 出典 |
|---|---|---|
| アカウント指標の保持 | User Metrics は最大 90 日 | Meta 公式 insights ガイド（2026-09-30 閲覧） |
| online_followers | 直近 30 日のみ | Meta 公式リファレンス |
| メディア指標 | 保持 2 年、1 リクエスト最大 90 日範囲 | gist 2026-04（Meta 公式ページで未確認） |
| 反映遅延 | 最大 48 時間 | Meta 公式リファレンス |
| ストーリーズ | 作成後 24 時間のみ。`story_insights` Webhook も最初の 24 時間分のみ。5 ビュー未満はエラー code 10 | Meta 公式（メディアインサイト、Webhooks）、Supermetrics |
| カルーセル子要素 | アルバム内メディアのインサイトは取得不可 | Meta 公式 |
| 属性 | 上位 45 件、100 フォロワー以上 | gist 2026-04、Meta 公式 |
| 欠損の表現 | データが無い場合は 0 ではなく空配列 | Meta 公式 |
| 指標廃止 | 2025-01 profile_views 等、2025-04 impressions | Emplifi、Zoomph |
| 蓄積開始 | 接続後からしか貯まらない（Metricool は接続時期で過去 Impressions の有無が変わる） | Metricool Help 2025 |

推奨（各出典の帰結を整理した設計案）:
- アカウント日次スナップショット（`followers_count`, `reach`, `views`, `accounts_engaged`, `total_interactions`, `follows_and_unfollows`, `profile_links_taps`、`follower_type` 内訳）を毎日保存し、48 時間遅延を考慮して直近 3 日を再取得して上書き。
- メディアは公開後 1h/6h/24h/48h/7d/14d/28d のスナップショットを保存し、以後は週次。累積値の差分で「初速」と「ロングテール（保存・発見タブ流入）」を分ける。
- ストーリーズは Webhook `story_insights` を第一候補、なければ公開中に 4–6 時間ごとにポーリング。
- 生 JSON を保存し、正規化テーブルには `metric_version`（impressions/views）列を持たせ、2025-04 前後の系列断絶をレポートで脚注化。
- online_followers は週 1 回 30 日分を保存し、曜日×時間の長期平均を自前で構築。

### 5.2 個人・小規模の OSS／スクリプト例と絞った機能

- jdh4601/instagram-dashboard (2026, Next.js/TS, JSON→SQLite→Postgres の差し替え式): リール・カルーセル指標同期、アカウントファネル、フォロワー/非フォロワー別リーチ、7 日変化、ルールベース診断、任意で LLM によるフック分析、日次メール。単一運用者・ローカル優先を明言。
- dkautomation23/instagram-metrics-reader (Python) https://github.com/dkautomation23/instagram-metrics-reader : 読み取り専用スコープをコードで強制、SQLite に TTL キャッシュ（2 回目は Graph 呼び出し 0）、`X-App-Usage` 監視と指数バックオフ、`needs_refresh()` でトークン先行更新、`as_of`/`age_hours`/`is_stale`/`source` を各スナップショットに付与、Page→IG の紐付けエラーを 0 で誤魔化さない。
- MavenKimKR/instagram-insights-local-sync (JS): JSON/CSV スナップショット出力のみ。Lanthanum89/instagram-analytics (Python GUI): 詳細未確認。jstolpe の business_discovery.py: フィールド取得のみで派生指標なし。
- GAS 系（国内）: 日次で 3 シート程度（アカウント／投稿別／競合）に追記する構成が典型。n8n（keyapi 2026-04）: 毎日 0 時フォロワー保存、8 時に Slack/メールのダイジェスト、50–55 日ごとのトークン更新ワークフロー。
- 共通して絞られている機能: 日次蓄積、投稿別テーブル、簡易ファネル、通知。UI は後回しか Sheets/Looker Studio に委譲。

### 5.3 「作って分かった落とし穴」

- セットアップ（アプリ作成・権限・審査・長期トークン）が最難関（rightcode 2023-11、GAS Lab、Qiita 2022）。
- トークン: 長期トークンは 60 日で失効、24 時間経過後に更新可能、50–55 日で自動更新を組まないと本番で静かに壊れる（Phyllo 2026-05 https://www.getphyllo.com/post/instagram-api-rate-limits-explained----and-how-to-scale-beyond-them-2026 、keyapi 2026-04）。
- レート制限: Instagram Platform は「24 時間あたり 4800 × インプレッション数」（アプリ・ユーザー組み合わせごと。Meta 公式 https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ ）。小規模アカウントほど枠が小さい（gist は下限 ~240/h と記載、未確認）。Instagram Login 経由は 200 回/時/ユーザー（Phyllo）。失敗リクエストも消費。ページ表示のたびに API を叩く設計は枯渇するので、キャッシュ＋スケジュール同期（プロフィール 24h、インサイト ~5h）が推奨。
- 指標の廃止・改名に追随が必要（2025 年に 2 回）。過去系列との比較は脚注必須。
- サムネイル URL は期限付きで後で表示不能になる（zenn 2025-04）。画像を残すなら自前で保存。
- ストーリーズは取り逃すと二度と取れない。日本ではストーリーズ返信数が API 指標に含まれない。
- 48 時間遅延により「昨日」の数値が翌朝は未確定。
- 流入元（発見タブ／ハッシュタグ）とアプリ内「閲覧数の内訳」は API で取れない（推測）。手入力欄を持つか諦める。

## 6. まとめ（推奨案）

### 6.1 推奨 KPI ツリー（3 パターン）

A. ブランド認知（企業・店舗）
- KGI: 指名検索数／来店・問い合わせ数／UGC 投稿数（aainc 2020、comnico 2026）
- L1: 月間リーチ（非フォロワー比率 40–60% を目標、creatorflow 2026）、フォロワー純増、メンション・タグ付け数
- L2: 投稿別リーチ、シェア率（1–2%）、保存率（2–3%）、ホーム率（30–50%）
- L3: 投稿数×フォーマット、24h 初速リーチ、リール平均視聴時間、online_followers 適合率

B. EC 送客
- KGI: Instagram 経由売上・CV（GA/UTM 側で計測）
- L1: `profile_links_taps`、ストーリーズ `link_clicks`、bio リンククリック、CVR
- L2: プロフィールアクセス率（1–5%）、ストーリーズリーチ率（10–20%）・完了率（70%）、投稿別 `profile_visits`
- L3: 商品系投稿の保存率、コメント/DM の質問数、キャンペーンタグ別リーチ

C. クリエイター
- KGI: フォロワー純増（週 1–2%）＋案件・収益
- L1: 投稿別ファネル（reach → profile_visits → follows）、フォロワー転換率 6–8%
- L2: 非フォロワー比率、リール維持率（尺別目標、Retensis 2026）、3 秒スキップ率 <30%、シェア率
- L3: 投稿頻度（リール週 2 本目安＝月 8 本中央値）、初速、ホーム率（既存フォロワー親密度）

### 6.2 推奨 月次レポート項目

1. 総評 3 行（結果・課題・来月方針）
2. KPI サマリー表: 5–7 指標 × 実績／前月比／目標比／原因コメント（neworder 型）
3. フォロワー推移（日次折れ線、純増、増減イベント注記）
4. リーチ・閲覧数推移（フォロワー/非フォロワー内訳、Views 定義の脚注）
5. フォーマット別サマリー（フィード: 保存率・ホーム率／カルーセル: シェア率／リール: 維持率・平均視聴時間／ストーリーズ: リーチ率・完了率・リンククリック）
6. 勝ち投稿 Top3／課題投稿 Top3（サムネ・数値・仮説）
7. タグ別（テーマ×フォーマット×CTA）平均比較
8. ファネル（リーチ→プロフィール→フォロー→リンク）の転換率と目安比較
9. フォロワー属性（年齢・性別・地域）とターゲット差分
10. 競合ベンチマーク（フォロワー成長率・推定 ER・投稿頻度）
11. コミュニティの声（コメント/メンションの主要トピック、質問）
12. 来月の施策（優先順位付き）と投稿計画

### 6.3 ダッシュボード推奨画面と必要データ

| 画面 | 主要ウィジェット | 必要データ |
|---|---|---|
| 概要 | KPI スコアカード（前期比）、フォロワー・リーチ・閲覧数の日次折れ線（7 日移動平均）、異常アラート | アカウント日次スナップショット、目標値 |
| 投稿一覧 | 表（サムネ、フォーマット、タグ、リーチ、非フォロワー比、保存率、シェア率、フォロー数）、ソート・タグフィルタ | メディア一覧＋最新インサイト、タグ |
| 投稿詳細 | 1h〜28d の累積曲線、同フォーマット中央値との比較、ファネル、使用ハッシュタグ | メディアスナップショット履歴 |
| ストーリーズ | 日別リーチ率、枚数別離脱率、リンククリック | 24h 内取得のストーリーズ指標 |
| オーディエンス | 属性（年齢・性別・地域）、online_followers ヒートマップ、フォロワー/非フォロワー比の推移 | 属性スナップショット、online_followers |
| 競合 | フォロワー推移、投稿頻度、推定 ER の並列比較 | Business Discovery 日次スナップショット |
| レポート | 月次レポート生成（6.2 の項目）、期間選択、CSV/PDF 出力 | 上記すべて |

### 6.4 MVP に含める機能／後回しの仮説

MVP（出典で「最初に必要」と一致する機能）:
- 長期トークン自動更新、レート制限監視、キャッシュ付き同期ジョブ
- アカウント日次スナップショット（90 日制限対策）と投稿別スナップショット（初速用）
- ストーリーズの 24h 内取得（Webhook またはポーリング）
- 投稿一覧＋派生指標（保存率・シェア率・非フォロワー比・ファネル転換率）、手動タグ
- 概要ダッシュボードと月次レポートの自動生成（Sheets/Looker Studio への出力でも可）

後回しでよい（仮説）:
- 競合ベンチマーク（Business Discovery は取得範囲が狭く、まず自アカウントの型を固める）
- コメント感情分析・FAQ 抽出（LLM 連携、精度課題）
- 自動タグ付け（手動タグの運用が安定してから）
- UGC/メンション管理（ストーリーズメンション非対応など制約が多い）
- 異常検知の統計モデル化（まず固定閾値＋連続区間ルールで十分）
- 広告データ統合

### 未確認・注意事項の一覧
- 各社の目安値（ホーム率・保存率・転換率など）の母集団・算出方法は非公開。
- メディア指標 2 年保持・90 日クエリ上限は gist のみで Meta 公式ページ上では確認できず。
- 流入元別（発見タブ・ハッシュタグ）の API 取得可否は未確認（推測: 不可）。
- Sprout Social のタグ機能の詳細（自動ルール）はサポートページが 403 で未確認。
- 国内のコメント/DM FAQ 抽出の実務記事は検索予算切れで未調査。
- hinome の「2026 年版 KPI 目安一覧」は本文取得に失敗し未確認。

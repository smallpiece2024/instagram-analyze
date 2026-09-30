# 調査02: 日本国内の Instagram 分析ツール／SNS 分析・運用ツール

- 調査日: 2026-09-30
- 方法: 日本語 Web 検索（「Instagram 分析ツール おすすめ 2026」「インスタ 分析ツール 比較 法人 料金」「Instagram インサイト 分析 ツール 無料」「SAKIYOMI 保存率 ホーム率 …」など約 60 クエリ）＋ 公式サイト・比較サイト・レビューサイト・ノウハウ記事の本文取得
- 注意: 価格は税込／税抜が情報源により混在する。公式ページで確認できたものはその旨を記載し、比較サイト経由のものは「比較サイト情報」と明記した。年号は情報源の公開日・更新日。

---

## 0. 要約

- 国内ツールは「Instagram 特化」と「マルチ SNS 統合」の 2 系統。特化型（SINIS、Slooooth/Aista、SAKIYOMI、HINOME、Insight Suite、CCX social、GRASIS、Reposta、ooowl、hashpick 等）は無料〜月 1 万円台に裾野があり、統合型（Social Insight、comnico、Beluga、Statusbrew、Tofu Analytics）は初期 10 万円＋月 5 万円前後からの法人向け価格帯。
- ほぼ全ての国内ツールが Meta 公式 Graph API（Facebook ログイン＋Facebook ページ連携、ビジネス／クリエイターアカウント必須）でデータを取得し、無料プランは「直近 45〜50 日」のデータ保持制限で有料化を誘導する構造。
- 日本市場独自の KPI 体系（保存率／ホーム率／プロフィールアクセス率／フォロワー転換率）が運用代行会社（SAKIYOMI、テテマーチ等）発で定着し、ツール側も「初速分析」「PowerPoint/Excel レポート自動生成」「承認フロー」「インスタントウィン等のキャンペーン管理」という日本の報告・運用文化に沿った機能を備える。

---

## 1. 国内主要ツール比較表（2025〜2026 年時点）

| ツール | 提供会社 | ターゲット | 料金帯 | データ取得 | 無料プラン |
|---|---|---|---|---|---|
| SINIS for Instagram | テテマーチ | 中小〜大企業、代理店 | LITE 0 円／STARTER 11,000 円（税込）／PROFESSIONAL 55,000 円（税込）／複数アカウント一括プラン 30 アカウント以上（初期 10 万円） | Facebook 連携（Graph API） | あり（45 日） |
| Slooooth（旧 Aista） | notari | 中小〜企業、代理店 | PRO 8,800 円/月。旧 Aista プレミア版は 300,000 円/月（銀行振込） | 公式 API（明記なし・推測） | トライアルのみ |
| SAKIYOMI 分析ツール | SAKIYOMI | 個人〜中小、内製担当者 | 単体 10,000 円/月、Slack 併用 15,000 円、コンサル 50,000 円（最低 3 か月） | 未確認 | なし |
| Social Insight | ユーザーローカル | 中堅〜大企業 | ビジネス版／エンタープライズ版、要問合せ（比較サイト: 初期 5 万＋月 5 万円〜） | インサイト連携＋ハッシュタグ収集 | なし |
| comnico Marketing Suite | コムニコ | 企業マーケ部門、代理店 | 初期 100,000 円＋月 50,000 円（年契約 45,000 円、税別）、3 アカウント込 | インサイト連携 | トライアルあり |
| Beluga スタジオ／Beluga キャンペーン | ユニークビジョン | 企業（キャンペーン主体） | 初期 10 万円＋BASIC 2 万円/月〜、PRO 20 万円/月〜、キャンペーン付 23 万円/月〜 | 公式 API（メンション必須） | なし |
| Tofu Analytics | misosil | 中小〜企業（ソーシャルリスニング） | 月 10,000 円〜、初期無料、縛りなし | 公式 API＋独自全量データ | トライアルあり |
| HINOME | Hinome | 個人〜企業 | フリー 0 円／ベーシック 5,980 円／プロ 22,000 円／ビジネス 55,000 円、初期導入サポート 55,000 円 | Meta 公式 API | あり |
| Reposta | ROC | 代理店、インフルエンサー | フリー 0 円（過去 1 か月）／スタンダード 5,500 円/月/アカウント | 公式 API | あり |
| Insight Suite | スマートシェア | 個人〜企業 | Free 0 円／Lite 6,400 円／Standard 16,000 円／Professional 40,000 円（12 か月契約時） | Instagram Graph API | あり（50 日） |
| CCX social（旧 MASAI） | ライスカレープラス | 個人〜企業、インフルエンサー | 基本無料、AI コンサルタント無制限 500 円/月 | 公式 API | あり |
| GRASIS | SNAPLACE | 自社運用〜代理店 | フリー 0 円／ライト 9,800 円／スモール 29,800 円／スタンダード 69,800 円／プレミアム 120,000 円 | Graph API（Facebook ページ連携必須） | あり |
| ooowl | ユニークワン | 初心者・中小 | 6,600 円／11,000 円／33,000 円/月 | 公式 API | 1 か月トライアル |
| hashpick | ホットリンク | 中小〜企業 | 約 3,000 円／5,700 円／7,200 円/月、カスタム | 公式 API | 30 日トライアル |
| Statusbrew（日本版） | Statusbrew（インド発、東京オフィス） | 多店舗・代理店・大企業 | 6,400 円〜、代理店向け 15,000 円/10 プロファイル、100 アカウント 85,000 円/月（年払） | 公式 API | 14 日トライアル |
| hashout | hashout | 企業（ハッシュタグ効果測定） | 30,000〜100,000 円/月（PR TIMES）、比較サイトでは 60,000〜150,000 円 | 公式 API | 1 週間トライアル |

出典: LISKUL 2026-01（https://liskul.com/instagram-analysis-104839 ）、エルグラム 20 選 2025-11 更新（https://lgram.jp/media/tool/analysis-tools/ ）、各公式サイト（後述）。

---

## 2. ツール別詳細

### 2.1 SINIS for Instagram（テテマーチ株式会社）
- ターゲット: 中小〜大企業、代理店。導入 60,000 件以上（Slooooth メディア 2026-05 の記載、第三者情報）。
- 機能: LITE（無料）でフィード・ストーリーズ・リール投稿分析、ハッシュタグランキング、フォロワー属性（年齢・性別・地域）、CSV ダウンロード、アカウント変化の自動検知通知。STARTER で相関分析、2 期間比較、Excel・PowerPoint レポート自動生成、他社アカウント分析 6 社（PROFESSIONAL 10 社）。PROFESSIONAL でハッシュタグ投稿収集（10 タグ）、初速分析、タグ付け・@メンション投稿収集（ファンユーザー分析、2019-11 発表）、コメント収集・管理、投稿予約。「AI アシスト考察」（前月サマリーとネクストアクションを生成 AI が出力）はサポートセンターに記事あり。複数アカウント一括分析プラン（30 アカウント以上、グループ分析、全アカウント CSV 一括 DL、2025-06 プレスリリース）。
- 指標: フォロワー数推移、エンゲージメント率、インプレッション、保存数、属性。テテマーチのアルゴリズム解説（2024-06）ではフォロワー内リーチ率／フォロワー内エンゲージメント率／フォロワー外リーチ率／プロフィールアクセス率／フォロワー転換率を段階指標として提示。
- データ取得: Facebook アカウント連携＝Graph API。ビジネスアカウントへの変更が必要。
- 料金: LITE 0 円（45 日保持）、STARTER 11,000 円/月（税込）、PROFESSIONAL 55,000 円/月（税込）。年払いキャンペーンで STARTER 年 120,000 円→100,000 円（2025-03）。
- 口コミ（ITreview 4.5、5 件、2020〜2025）: 良い点「公式インサイトより運用に役立つ表示」「過去時点のフォロワー数を振り返れる」「Facebook 連携だけで PC 閲覧」。不満「無料は 45 日分のみで定期 DL が必要」「特定ハッシュタグ単位のリーチが欲しい」「AI 精度の向上に期待」。
- 出典: https://lgram.jp/media/tool/sinis/ （2025-10 更新）、https://www.itreview.jp/products/sinis/reviews 、https://tetemarche.co.jp/news/sinis_professional （2019）、https://tetemarche.co.jp/news/tete-250305 （2025）、https://prtimes.jp/main/html/rd/p/000000227.000017171.html （2025）、https://tetemarche.co.jp/column/instagram_algorithm （2024）

### 2.2 Slooooth（すろ〜す）／Aista（notari 株式会社）
- Aista は「日本初の Instagram 専用分析ツール」、累計導入 5,000 社。現在は Aista プレミア版（300,000 円/月、銀行振込、デモあり）と、後継の Slooooth（8,800 円/月）を提供。ハッシュタグ検索ツール「ハシュレコ」も同社。
- 機能: フォロワー推移、投稿数、いいね数、エンゲージメント率、ハッシュタグ分析（最適な数・種類提案）、ユーザータグ分析（タグ付けアカウントと回数）、キャンペーンハッシュタグ分析（複数タグの合計リーチ・推定最大リーチ）、競合統計。Slooooth はワンクリックで 50 枚以上のレポート生成、AI レコメンド（改善施策提案）、予約投稿、ストーリーズ分析。
- 口コミ: Aista は「競合分析が使い勝手良く提案資料に役立つ」一方「月額 30 万円で導入が難しい」。
- 出典: https://notari.co.jp/aista/ 、https://lgram.jp/media/tool/aista/ （2024-05 更新）、https://digi-mado.jp/products/83164/ 、https://media.slooooth.com/ig-analytics-tools-comparison/ （2026-05）

### 2.3 SAKIYOMI（株式会社 SAKIYOMI）
- 運用代行（月 100,000 円〜）・スクール・分析ツールを提供。ツールは「4 つの重要変数（保存率・ホーム率・プロフィールアクセス率・フォロワー転換率）に限定したダッシュボード」が特徴。ストーリーズの視聴完了率・離脱率、投稿分析、競合フォロワー増減比較、約 50 本の動画教材、Slack コミュニティ。
- 料金: 分析ツール単体 10,000 円/月、Slack＋ツール 15,000 円/月、コンサル付 50,000 円/月。最低 3 か月契約。
- データ取得方法: 公式・比較サイトとも明記なし（未確認）。口コミに「投稿データ到着に最低 3 日以上」とあり、リアルタイム API ではなくバッチ取得の可能性（推測）。
- 口コミ: 「コスパが良い」「フォロワー増加につながった」／「担当者対応が雑・連絡が遅い」。
- 出典: https://lgram.jp/media/tool/sakiyomi/ （2025-09 更新）、https://kigyolog.com/tool.php?id=2004 （2026-01 更新）

### 2.4 Social Insight（株式会社ユーザーローカル）
- ターゲット: 中堅〜大企業（導入 1,000 社以上。NTT ドコモ、楽天、富士フイルム等）。対応 SNS: X、Instagram、Facebook、LINE、YouTube、TikTok、投稿管理は Threads・LinkedIn も。
- 機能: アカウント分析（フォロワー推移、投稿内容と反応の相関、属性）、時間帯分析、競合比較、クチコミ分析（ハッシュタグ発言数、画像と反応の相関、キャンペーン効果）、投稿管理（AI 文案生成、OCR、承認ワークフロー）、キャンペーン自動化（フォロー／いいね／コメント／タグ付け／ハッシュタグ投稿、当選者抽選自動化）、PowerPoint レポート自動作成。
- 料金: ビジネス版／エンタープライズ版、要資料請求。比較サイトでは初期 50,000 円＋月 50,000 円〜。
- 口コミ（ITreview 4.2、21 件、中堅 14／中小 7）: 良い点「複数 SNS 横断」「PPT ボタン一つでレポート」「安価」。不満「監視キーワード数・競合数の上限」「レポートテンプレの自由度」「ダッシュボードの情報密度」「テキストマイニングが難解」「連携が時々切れる」「UI が古い」「API 制限で SNS ごとに機能差」。
- 出典: https://sns.userlocal.jp/lp/instagram/ 、https://www.itreview.jp/products/social-insight/reviews 、https://strate.biz/social_listening/social_insight/

### 2.5 comnico Marketing Suite（株式会社コムニコ）
- ターゲット: 企業マーケ部門、代理店、制作会社、多店舗（15 アカウント以上はエンタープライズ）。対応: Instagram、X、Facebook、TikTok。
- 機能: 予約投稿（レビュー機能、最大 3 段階承認フロー）、自社アカウント分析＋自動レポート出力（KPI に合わせたカスタム）、競合分析（フォロワー推移、反応数）、コメント・DM の統合受信箱、Instagram クチコミ分析（ハッシュタグ収集、投稿数推移、頻出単語）。Instagram 月次レポートの PowerPoint テンプレートを無料配布。
- 料金: 初期 100,000 円、月 50,000 円（年契約 45,000 円、税別）。3 アカウント・10 ユーザー込。追加アカウント 10,000 円/月、競合 10 アカウント単位 10,000 円/月、クチコミデータ 1 万件単位 3,000 円/月。
- 不満点: YouTube 未対応、Instagram への同時投稿未対応（2025-06 時点）。
- 出典: https://www.comnico.jp/products/cms/jp 、https://kigyolog.com/tool.php?id=2302 （2025-06 更新）、https://www.comnico.jp/instagram_reporttemplate

### 2.6 Beluga シリーズ（株式会社ユニークビジョン）
- Beluga スタジオ: 初期 10 万円、BASIC 2 万円/月〜（1 か月〜）、STANDARD 5 万円〜、PRO 20 万円〜（3 か月〜）。Instagram は自社 1 アカウント＋他社 3 アカウント、PRO でハッシュタグ検索保存 5 個（追加 1 万円/ワード）。分析はタイムライン・競合のフォロワー／エンゲージメント測定が中心。
- Beluga キャンペーン for Instagram: インスタントウィン、ライブ配信コメント、写真・感想投稿（UGC）、チャットボット診断の 4 形式。フォローチェック（チャットボット併用必須）、DM 自動返信、当選管理。収集には公式アカウントのメンションが必須。キャンペーン付プランは 23 万円/月〜。
- 出典: https://www.uniquevision.co.jp/service/beluga/plan/ 、https://www.uniquevision.co.jp/service/beluga-campaignforinstagram/

### 2.7 Tofu Analytics（misosil, Inc.）
- ソーシャルリスニング寄り。キーワード監視で口コミ自動収集、アカウント分析、競合横並び比較、AI による感情・属性・カテゴリ判定、UGC 分析、インフルエンサー特定（2 次・3 次拡散追跡）、採用向けアカウント抽出。対応: Instagram、X、Facebook、LINE、YouTube、TikTok、Threads。
- 料金: 月 10,000 円〜、初期無料、契約期間縛りなし。「公式 API 認定企業」を掲げ、公式 API＋独自の全量データ技術を併用。
- 出典: https://tofu.misosil.com/tool/instagram 、https://strate.biz/textmining/tofu-analytics/

### 2.8 HINOME（株式会社 Hinome）
- 導入 23,000 アカウント以上。Meta 公式 API 連携を明示し「凍結リスク最小化」を訴求。
- 機能: ダッシュボード、初速分析（投稿後 24 時間を 1 時間単位で可視化）、AI ハッシュタグ提案、PNG/Excel レポート（最短 5 秒）、予約投稿、ベンチマーク（複数競合比較）、UGC 分析、DM 自動応答、AI 投稿文生成。
- 料金: フリー 0 円／ベーシック 5,980 円（12 か月契約 4,700 円）／プロ 22,000 円（18,000 円）／ビジネス 55,000 円（44,000 円）、Enterprise 50,000 円〜。初期導入サポート 55,000 円。
- 導入事例: 初速分析で「リーチ 4〜5 倍」（Teals 社）。
- 出典: https://lgram.jp/media/tool/hinome/ （2025-09 更新）、https://service.hinome.app/

### 2.9 Reposta（株式会社 ROC）
- レポート出力特化。Instagram／Facebook／TikTok。レポート項目: フォロワー分析、月次・日次推移、フィード投稿、ストーリーズ、広告、メンション、競合、ハッシュタグ、リール、KGI・KPI 機能、初速分析。指標: エンゲージメント数、フォロワー属性、いいね、コメント、保存、再生数、シェア数、インプレッション数。Excel 出力・URL 共有、3 クリック作成、デイリーレポートのメール配信。
- 料金: フリー 0 円（過去 1 か月）／スタンダード 5,500 円/月/アカウント（税込）。2 週間トライアル。
- 出典: https://reposta.jp/ 、https://kigyolog.com/tool.php?id=2418

### 2.10 Insight Suite（スマートシェア株式会社）
- Graph API 利用、登録初日から自動収集。投稿分析（フォロワー・リーチ・インプレッション・エンゲージメント推移）、ハッシュタグ分析（利用回数、平均エンゲージメント数/率）、競合分析（月回数制）、トレンド分析、UGC 分析、インフルエンサーチェック、複数アカウント切替、予約投稿（カルーセル・リール対応、2022-10）。
- 料金（12 か月契約／単月）: Free 0 円（1 アカウント、50 日、競合 10 回/月、自社タグ 1）／Lite 6,400／8,000 円（2 アカウント、3 年保持）／Standard 16,000／20,000 円（5 アカウント、無制限）／Professional 40,000／50,000 円。
- 出典: https://insightsuite.jp/ 、https://prtimes.jp/main/html/rd/p/000000111.000019448.html （2022）

### 2.11 CCX social（旧 MASAI、株式会社ライスカレープラス）
- Instagram＋TikTok を無料で分析。インサイト分析（フォロワー、エンゲージメント、投稿一覧、ハッシュタグ、タグ付け、メンション、ストーリーズ、コメント管理、初速分析、5 アカウントサマリー）、ベンチマーク分析（10 アカウント）、業界トレンド分析（業界別アカウント・トレンドワード）、「アナリストレポート」（アナリスト視点の考察を自動表示）、ドラッグ＆ドロップのレポート作成、生成 AI「AI コンサルタント」（無料は月 3 回、500 円/月で無制限）。
- 指標: インプレッション、リーチ、いいね、保存、エンゲージメント率、フォロワー推移、コメント。
- 出典: https://lgram.jp/media/tool/ccx-social/ （2025-10 更新）、https://liskul.com/instagram-analysis-104839

### 2.12 GRASIS（合同会社 SNAPLACE）
- 全プランでアカウント数無制限が特徴。Graph API 利用、パスワード預かりなし、Facebook ページ連携必須。機能: 自社詳細分析、競合・ベンチマーク、アカウント品質分析（アドフラウド検出）、ワンクリック PDF 報告書、AI 投稿提案・戦略提案・画像診断、インフルエンサー発掘、X・LINE 分析。指標: フォロワー推移、エンゲージメント率、リーチ、フォロー率、CVR、インプレッション。
- 料金: フリー 0 円／ライト 9,800 円／スモール 29,800 円／スタンダード 69,800 円（初期 5 万円）／プレミアム 120,000 円（初期 5 万円）。
- 不満点: 第三者レビューの蓄積が少ない、個人運用には不向き（Facebook ページ必須）。
- 出典: https://apress.jp/archives/38813 （2026-08）、https://grasis.jp/

### 2.13 ooowl（株式会社ユニークワン）
- 初心者向けのシンプル設計。投稿インサイト、フォロワー推移・属性、ハッシュタグ分析・AI 提案、競合 5 アカウント、PDF レポート。Instagram＋X。ミニマム 6,600 円／スタンダード 11,000 円／プロフェッショナル 33,000 円/月、1 か月トライアル。
- 出典: https://ooowl.jp/ 、https://lgram.jp/media/tool/ooowl/

### 2.14 ホットリンク関連（hashpick／BuzzSpreader）と「Insight Intelligence」の実態
- ホットリンクは 2017 年に Instagram 向け「BuzzSpreader」（AI ハッシュタグレコメンド）を、2024-05 に Instagram 分析ツール「hashpick」（インサイト、UGC 検索、インフルエンサー検索。エントリー約 3,000 円／スタンダード 5,700 円／アドバンス 7,200 円/月）をリリース。
- 「Insight Intelligence Q」はデータセクション社のソーシャルリスニングツールであり、ホットリンク製ではない。ミツモアは「公式サイトにアクセスできず、提供終了の可能性」と記載（未確認）。依頼中の「Insight Intelligence（ホットリンク）」は製品名と提供元の取り違えの可能性が高い（推測）。
- 出典: https://marketing.itmedia.co.jp/mm/articles/2405/16/news094.html （2024）、https://www.hottolink.co.jp/info/20170606_82451/ （2017）、https://meetsmore.com/products/insight-intelligence-q

### 2.15 Statusbrew 日本版
- インド発、東京オフィス、日本語 UI・日本チームサポート。多店舗・代理店・大企業向け。機能: 複数アカウント一括配信、AI 投稿生成、承認フロー（多段階）、統合受信箱（コメント・DM・メンション・ストーリーズタグ）、センチメント自動フィルタ、広告コメント監視、ハッシュタグリスニング、259 種以上の指標、オーガニック vs 広告比較、競合分析、横断ダッシュボード、SSO・監査ログ（Enterprise）。
- 料金: Lite（1 ユーザー 5 プロファイル）／Standard（3／10）／Premium（6／15）／Enterprise。6,400 円〜、代理店向け 15,000 円/月で 10 プロファイル、100 アカウント 85,000 円/月（年払）。
- 口コミ（ITreview、中小 14／中堅 6／大企業 5）: 良い点「承認ワークフロー」「200 アカウント超の管理」。不満「画面の情報量が多く文字が小さい」「受信箱の横幅」「CSV 一括予約の改善」「一部 SNS の広告分析非対応」「ベンチマーク比較が欲しい」。
- 出典: https://statusbrew.co.jp/instagram 、https://statusbrew.co.jp/pricing 、https://www.itreview.jp/products/statusbrew/reviews 、https://www.aspicjapan.org/asu/service/38467

### 2.16 その他の国内ツール（簡潔）
- hashout（株式会社 hashout）: ハッシュタグ・アカウント効果測定。投稿数・投稿者数・いいね集計、人気投稿ランキング、ストーリーズ分析、AI 関連タグ、投稿時間分析。Short 30,000／Tall 50,000／Large 100,000 円/月（PR TIMES プラン改定）。1,000 社利用。無料タグ検索「タグジェネ」提供元（終了）。https://hashout.co.jp/
- Moribus Navi（AIQ 株式会社）: 特許取得「プロファイリング AI」で画像・動画・テキストを解析、業界別成功事例、伴走型。個別見積。
- InStats: 4,980 円/月。初速分析、投稿比較、UGC、ハッシュタグ順位、PDCA カレンダー。スマホ対応。
- SocialDog: X 中心だが Instagram 対応。Personal 1,480 円〜／Professional 4,980 円〜／Business 19,800 円〜（2026-03、税抜）。Instagram 固有の分析詳細は未確認。
- aumo Biz: 20,000 円/月。実店舗向けに MEO と Instagram を統合、多言語対応。
- トレミル（フリースタイルエンターテイメント）: AI 分析特化、要問合せ。
- インハウスプラス「Instagram インサイトレポート」: Looker Studio 連携の自動レポート、月 4,980 円（税込）〜、過去 24 か月参照。https://inhouse-plus.jp/portfolio/instagram-monthly-report/
- Insighter（Woomy）: 「Instagram 公認」を掲げる分析ツール。詳細料金は未確認。

### 2.17 依頼にあったが実態を確認できなかった名称
- Kanaria、Minsta、Nobita、Toaster: 日本語・英語で検索したが Instagram 分析ツールとしての情報は見つからず（未確認。同名の音楽家・一般アカウントのみヒット）。
- Zeals: 検索結果に分析ツールとしての記載なし。調査者の知識では会話型コマース（チャットボット接客）企業であり分析ツールではない（推測、要確認）。
- Insta Try（インスタトライ）: 比較記事に「いいね・フォローで自動アプローチする AI ツール」として掲載。分析ツールではなく自動アクション系であり、後述の規約リスク領域に属する。

---

## 3. 無料・公式ツール（Instagram インサイト、Meta Business Suite）と 2025〜2026 年の指標変更

- インサイトはプロアカウント（ビジネス／クリエイター）で無料。主な日本語表示名: リーチ（リーチしたアカウント数）、閲覧数（Views）、インタラクション数（いいね・コメント・シェア・保存）、プロフィールのアクティビティ（プロフィールへのアクセス、ウェブサイトクリック、道順、メール）、フォロー数、フォロワー属性（性別・年齢・地域・アクティブ時間帯）。フィード投稿は閲覧数の内訳（プロフィール／ホーム／ハッシュタグ／発見）、ストーリーズはナビゲーション（次へ・離脱・戻る）、リールは視聴維持率・平均再生時間・3 秒スキップ率。アプリで遡れるのは最大 90 日。
- 2025-04 以降「インプレッション」「再生数」等が「閲覧数（Views）」に統一され、旧データとの互換性が失われた。2026-04 のアップデートでインサイトが「概要／エンゲージメント／オーディエンス」の 3 タブ構成となり、「閲覧数を基準としたアクション率」が追加（フィード・カルーセル・リール対象）。2026-06 にはリールの割合指標が「リーチへの重要度順」に並ぶ表示に変更。
- API 側では 2026-06-15 にページ／投稿のリーチ、動画・ストーリーズのインプレッション、3 秒視聴者などが廃止され、Media Views／Media Viewers（ユニークビュー基準）へ移行。有料／オーガニック内訳やバイラル区分は引き継がれず、6/15 をまたぐグラフに段差が生じると解説されている。
- 「2026 年 2 月末に全公開アカウントでインサイトが利用可能になった」との記述が一部記事の要約に見られたが、本文で確認できた記事はプロアカウント前提のままであり未確認。
- Meta Business Suite（PC）では閲覧数、リーチ、エンゲージメント、属性、フォロワー／非フォロワー内訳、発見タブ流入元を期間集計でき、CSV エクスポートしてスプレッドシート管理する運用が「多くの企業には十分」と紹介されている。
- Graph API の前提: ビジネス／クリエイターアカウント＋Facebook ページ連携（Facebook ログイン版）。レート制限はユーザー単位 200 回/時、ハッシュタグ検索は 30 個/週、長期トークン最大 60 日。Facebook ページ不要の「Instagram API with Instagram Login」（2024 年提供開始）は調査者の知識であり、今回の検索では一次情報を確認できていない（未確認）。
- 出典: https://www.comnico.jp/we-love-social/business-profile-instagram-insight-2 （2026-09）、https://camtsuku.com/guide/3817 （2026-08 更新）、https://www.sharecoto.co.jp/instagramlab/news-2026 （2026）、https://tatap.jp/knowledge/instagram-insights-metrics-change/ （2026-08）、https://www.neworder.co.jp/2026/05/26/instagram_reporting/ （2026-05）、https://inhouse-plus.jp/reporting/instagram-insight-report/ （2026-07）、https://mobinc.jp/column/2026/03/12/mastering-instagram-graph-api-from-basics-to-advanced/ （2026-03）

---

## 4. ハッシュタグ分析系

- ハシュレコ（notari）: キーワード 1 語から関連ハッシュタグ候補を提示。Aista の 5,000 社分データを利用。モバイル対応。無料。
- タグジェネ（hashout）: 提供終了（note 記事 2023 年頃の報告）。
- hashout、Aista/Slooooth、SINIS PROFESSIONAL、Social Insight、comnico の「Instagram クチコミ分析」、Beluga のハッシュタグ検索保存は、いずれも Graph API のハッシュタグ検索（30 個/週の制限）を前提にした「指定タグの投稿収集・件数推移・人気投稿」型。国内ツールは「自社タグ集計」「キャンペーンタグの合計リーチ」を重視する傾向。
- 出典: https://ferret-plus.com/8087 、https://note.com/aoneko/n/n35d4c759028c 、https://prtimes.jp/main/html/rd/p/000000061.000026754.html

---

## 5. フォロワー分析系の非公式アプリ（フォロチェック等）の実態と規約リスク

- 「Insta チェックー」「フォロチェック」類はフォロー／フォロワーの差分（相互フォロー、リムーブ通知）を表示するアプリで、Instagram の ID・パスワード入力や非公式 API を用いるものが多い。
- Instagram 利用規約は「不正な方法を用いて、アカウントの作成、情報へのアクセス、または情報取得を試みること」を禁止しており、非承認アプリの利用はシャドウバン、一時停止、凍結の対象になり得ると複数記事が指摘。パスワード入力型はアカウント乗っ取り被害の報告もある（Yahoo!知恵袋、個人ブログ）。
- 自動いいね・自動フォロー系（hashlikes 3 か月 15,980 円、月 18,900 円〜のサービス等）も同様に規約違反・凍結リスクがあり、「返報性だけのフォロワーが増えホーム率が下がる」という運用上の弊害も指摘される。
- 国内ツール各社（HINOME、GRASIS、Insighter 等）はこれと対比して「Meta 公式 API 利用」「パスワード預かりなし」を安全性の訴求点にしている。
- 出典: https://item.woomy.me/is/tutorial/account-ban/ 、https://snsschool.net/column/instagram-marketing/account-suspension （2026）、https://tanakacoffeelab.com/instafollowcheck/ 、https://vitalify.jp/app-lab/sns/auto-like/

---

## 6. 日本市場特有の KPI 体系（定義と目安値）

| 指標（日本語名） | 計算式 | 目安値（出典・年） |
|---|---|---|
| 保存率 | 保存数 ÷ リーチ数 × 100 | 2〜3%（SAKIYOMI 2025-01）、2% 合格・3% 超でバズ傾向（SAKIYOMI 2026-02）、1〜3% 平均・3〜5% 良・5% 以上優秀（Genegram 2026-09）、2〜4% 以上（neworder 2026-05） |
| ホーム率 | フォロワー内リーチ数（ホーム数）÷ フォロワー数 × 100 | 40〜50%（SAKIYOMI 2025-01）、60% 超でバズが生まれやすい（SAKIYOMI 2025-02／2026-02） |
| プロフィールアクセス率（プロフィール遷移率） | プロフィールアクセス数 ÷ リーチ数 × 100 | 3〜5%（SAKIYOMI 2025／2026）、2〜3%（SAKIYOMI 関連記事）、0.5〜1.5%（neworder 2026）※定義差あり |
| フォロワー転換率 | フォロワー増加数 ÷ プロフィールアクセス数 × 100 | 6〜8%（SAKIYOMI）、20〜40%（neworder 2026）※大きく乖離しており、母数の取り方が異なる可能性（推測） |
| フォロワー内リーチ率／フォロワー外リーチ率／フォロワー内エンゲージメント率 | テテマーチが「フォロワー→発見タブ拡散」の段階指標として定義（2024-06） | 目安値の記載なし |
| 発見タブ流入数・率 | 発見タブ経由リーチ ÷ 総リーチ | 総リーチの 20〜40% 以上（neworder 2026） |
| 非フォロワーリーチ率 | 非フォロワーリーチ ÷ 総リーチ | 50% 超で新規層到達（neworder 2026） |
| リール視聴維持率／完全視聴率／スキップ率 | 維持率＝平均再生時間÷動画長、スキップ率＝3 秒以内離脱割合 | 維持率 70% 以上、完全視聴率 15〜20%（neworder）、スキップ率 50% 以下が第一目標・30% 未満で良好（tatap 2026-07） |
| ストーリーズ視聴完了率／離脱率／リーチ率 | 離脱＝スワイプアウト | リーチ率 10〜20%、離脱率 5% 以下、インタラクション率 3〜5%（neworder 2026） |
| エンゲージメント率 | (いいね＋コメント＋保存) ÷ リーチ（neworder）または ÷ インプレッション（e-pace） | 2〜5%（neworder）※分母の定義がサイトごとに異なる |
| 初速 | 投稿後 24 時間の 1 時間単位推移。1 日後の保存率 3% 以上を目安（SAKIYOMI） | HINOME、SINIS PRO、CCX social、Reposta、InStats が機能化 |

- 分析タイミングは「1 日後（保存率）→1 週間後（保存率・ホーム率）→1 か月後（4 指標すべて）」が SAKIYOMI の標準（2026-02）。
- 4 指標は「保存率→発見タブ露出」「ホーム率→フォロワー親密度」「プロフィールアクセス率→導線」「フォロワー転換率→プロフィール品質」と因果に対応づけて説明される。
- 出典: https://sns-sakiyomi.com/blog/tips/instagram-algorithm/ （2025-01）、https://sns-sakiyomi.com/blog/tips/instagram-home/ （2025-02）、https://sns-sakiyomi.com/blog/function/instagram-insight/ （2026-02）、https://genegram.jp/2026/09/255/ （2026-09）、https://www.neworder.co.jp/2026/05/26/instagram_reporting/ （2026-05）、https://tatap.jp/knowledge/instagram-insights-improvement/ （2026-07）、https://tetemarche.co.jp/column/instagram_algorithm （2024-06）

---

## 7. 日本の企業アカウント運用における典型的な月次レポート

- 基本 5 項目（インハウスプラス 2026-07）: 新規フォロワー数、投稿リーチ数、アカウントリーチ数、エンゲージメント数、保存数。認知→興味→成果のファネルに対応。
- 5 ページ構成例（エルグラム）: 表紙 → アカウント全体数値と前月比グラフ → 投稿別リーチ・保存 TOP3 → 投稿別プロフィール遷移・フォロワー数 TOP3 → 総括と翌月方針。
- コムニコの無料 PowerPoint テンプレート（2026-01）: KPI 進捗、フォロワー数推移、主要数値推移（インプレッション、URL クリック、いいね、コメント）、投稿一覧、エンゲージメント率のベスト／ワースト投稿、投稿カテゴリ別・投稿タイプ別分析。
- neworder（2026-05）のサマリー推奨 7 指標: フォロワー増減（前月比・目標比）、月間総リーチ、平均エンゲージメント率、発見タブ流入数、フォロワー／非フォロワー比率、リール視聴維持率または再生数、月間投稿数・フォーマット比率。報告の 3 原則は「前月比と目標比の 2 軸」「なぜ＋次月施策をセット」「5〜7 指標に絞る」。
- e-pace（2026-08 更新）の記載項目: 対象期間、KPI 実績と達成率、フォロワー数と増減、投稿数と投稿一覧、ベスト・ワースト投稿、考察・改善施策。
- 代理店の相場: ライトプラン（月 5〜15 万円）は投稿代行＋簡易レポート、スタンダード（15〜30 万円）は投稿＋コメント対応＋月次レポート。レポートは PowerPoint／Excel 形式が主流で、ツール側も「PPT/Excel 自動生成」「サムネイル付き投稿一覧」「前月比」を標準装備。
- 出典: https://inhouse-plus.jp/reporting/instagram-insight-report/ 、https://lgram.jp/media/know-how/report-generation/ 、https://www.comnico.jp/we-love-social/sns_report 、https://www.neworder.co.jp/2026/05/26/instagram_reporting/ 、https://e-pace.co.jp/column/sns-report/ 、https://cone-c-slide.com/liblog/instagram/

---

## 8. 国内ツールと海外ツールの違い

- 海外（Hootsuite、Sprout Social、Later、Iconosquare）: マルチ SNS 統合、受信箱・カスタマーケア、業界ベンチマーク、100 以上の指標をリアルタイム表示。Iconosquare は月 33 ドル（49 ユーロ）〜で日本語非対応。Hootsuite は UI が日本語化されているがサポートは英語中心で「日本語情報が少ない」と評される。
- 国内: Instagram 単体特化が多く、無料〜1 万円台の裾野が広い。指標体系は「保存率・ホーム率・プロフィールアクセス率・フォロワー転換率」など運用代行会社発の日本語 KPI をそのまま採用し、「初速分析」「PPT/Excel の月次レポート自動生成」「承認フロー（最大 3 段階）」「インスタントウィン等のキャンペーン応募・当選管理」「UGC／タグ付け投稿の収集」「AI 考察（前月総括と次アクション）」が差別化点。比較記事も「非エンジニアの複数人で使うなら日本語サポートのある国産」を推奨。
- 思想の違い（推測を含む）: 海外は「チームのワークフロー基盤」、国内は「上司・クライアントへの報告資料を短時間で作る」「フォロワーを増やすための 4 指標 PDCA」に最適化されている。Statusbrew は海外製をローカライズし承認フロー・多店舗管理で国内大企業に食い込む例。
- 出典: https://media.slooooth.com/ig-analytics-tools-comparison/ （2026-05）、https://kigyolog.com/tool.php?id=2186 （2024-11）、https://suitup.jp/blog/24316/ 、https://blog.hootsuite.com/instagram-analytics-tools/ （2026）

---

## 9. まとめ

### 9.1 国内ツールにほぼ共通する定番機能
1. Graph API による自社アカウントの自動収集（フォロワー推移、投稿別リーチ／閲覧数／保存／エンゲージメント率、フォロワー属性、ストーリーズ・リール別）
2. 競合（ベンチマーク）アカウントの公開指標比較（プラン別に 3〜10 アカウント）
3. ハッシュタグ分析（自社タグ集計、関連タグ提案、指定タグの投稿収集）
4. レポート自動生成（PowerPoint／Excel／PDF／PNG、CSV ダウンロード、URL 共有）
5. 無料プランは「直近 45〜50 日」制限、有料で無期限保持
6. 予約投稿・承認フロー・コメント管理（統合型に多い）

### 9.2 国内ツールならではの機能・指標
- 4 指標ダッシュボード（保存率／ホーム率／プロフィールアクセス率／フォロワー転換率）とその目安値表示
- 初速分析（投稿後 24 時間を 1 時間単位で可視化、1 日後の保存率判定）
- AI 考察・AI コンサルタント（日本語で前月総括・次アクション・投稿文案を生成）
- キャンペーン（インスタントウィン、フォローチェック、当選抽選、UGC 収集）とその効果測定
- タグ付け・メンション投稿からの「ファンユーザー」特定
- 業界トレンド／業界別アカウントの参照（CCX social、Moribus Navi）
- 「Meta 公式 API 利用・パスワード預かりなし」を安全性として訴求（非公式アプリとの差別化）

### 9.3 自作する際に参考にすべき点
1. データ取得は Graph API（ビジネス／クリエイターアカウント）一択。Facebook ページ連携の要否、200 回/時のレート制限、ハッシュタグ検索 30 個/週、長期トークン 60 日更新を設計に織り込む。非公式スクレイピング・パスワード入力は規約リスクがあり採用しない。
2. 2025〜2026 年の指標変更（インプレッション→閲覧数、API のリーチ／インプレッション廃止→Media Views/Viewers）に耐える設計にする。指標名を内部で抽象化し、日付境界で数え方が変わる旨を UI に表示する。
3. アプリのインサイトは 90 日、無料ツールは 45〜50 日しか遡れないため、「日次スナップショットの永続保存」が自作ツールの最大の価値になる（前年比・引き継ぎ資料に必須）。
4. 日本語 KPI（保存率・ホーム率・プロフィールアクセス率・フォロワー転換率・発見タブ流入率・視聴維持率・スキップ率）を計算式つきで実装し、目安値は出典と年を明示して切り替え可能にする。サイトごとに分母の定義（リーチかインプレッションか）が異なるので定義を固定して表示する。
5. 初速分析（投稿後 24 時間の 1 時間粒度）は国内ツールで差別化要素として定着しており、定期ポーリング設計で実装可能。
6. 月次レポートは「前月比＋目標比」「ベスト／ワースト投稿（サムネイル付）」「発見タブ流入」「総括と翌月施策欄」を含む 5〜7 指標サマリー構成が定番。PowerPoint/Excel 出力の需要が高い。
7. 競合分析は公開データ（Business Discovery API）の範囲に限られる点を明示する。
8. 国内ユーザーの不満点（データ保持制限、ハッシュタグ単位のリーチ不足、レポートテンプレの自由度不足、ダッシュボードの情報過多、連携切れ、UI の古さ、データ反映の遅さ）は改善余地として設計目標にできる。

---

## 出典一覧（主要）
- LISKUL「インスタ分析ツールおすすめ 17 選」2026-01: https://liskul.com/instagram-analysis-104839
- エルグラム「インスタ分析ツール 20 選」2025-11 更新: https://lgram.jp/media/tool/analysis-tools/
- SINIS: https://lgram.jp/media/tool/sinis/ ／ https://www.itreview.jp/products/sinis/reviews ／ https://tetemarche.co.jp/news/tete-250305 ／ https://prtimes.jp/main/html/rd/p/000000227.000017171.html
- Aista/Slooooth: https://notari.co.jp/aista/ ／ https://lgram.jp/media/tool/aista/ ／ https://digi-mado.jp/products/83164/
- SAKIYOMI: https://lgram.jp/media/tool/sakiyomi/ ／ https://kigyolog.com/tool.php?id=2004 ／ https://sns-sakiyomi.com/blog/tips/instagram-algorithm/ ／ https://sns-sakiyomi.com/blog/tips/instagram-home/ ／ https://sns-sakiyomi.com/blog/function/instagram-insight/
- Social Insight: https://sns.userlocal.jp/lp/instagram/ ／ https://www.itreview.jp/products/social-insight/reviews
- comnico: https://www.comnico.jp/products/cms/jp ／ https://kigyolog.com/tool.php?id=2302 ／ https://www.comnico.jp/we-love-social/sns_report ／ https://www.comnico.jp/we-love-social/business-profile-instagram-insight-2
- Beluga: https://www.uniquevision.co.jp/service/beluga/plan/ ／ https://www.uniquevision.co.jp/service/beluga-campaignforinstagram/
- Tofu Analytics: https://tofu.misosil.com/tool/instagram
- HINOME: https://lgram.jp/media/tool/hinome/ ／ https://service.hinome.app/
- Reposta: https://reposta.jp/
- Insight Suite: https://insightsuite.jp/
- CCX social: https://lgram.jp/media/tool/ccx-social/
- GRASIS: https://apress.jp/archives/38813
- ooowl: https://ooowl.jp/
- hashpick/ホットリンク: https://marketing.itmedia.co.jp/mm/articles/2405/16/news094.html
- Insight Intelligence Q: https://meetsmore.com/products/insight-intelligence-q
- Statusbrew: https://statusbrew.co.jp/pricing ／ https://www.itreview.jp/products/statusbrew/reviews
- hashout: https://prtimes.jp/main/html/rd/p/000000061.000026754.html
- 指標変更: https://tatap.jp/knowledge/instagram-insights-metrics-change/ ／ https://www.sharecoto.co.jp/instagramlab/news-2026 ／ https://camtsuku.com/guide/3817
- Graph API: https://mobinc.jp/column/2026/03/12/mastering-instagram-graph-api-from-basics-to-advanced/
- KPI: https://genegram.jp/2026/09/255/ ／ https://www.neworder.co.jp/2026/05/26/instagram_reporting/ ／ https://tatap.jp/knowledge/instagram-insights-improvement/ ／ https://tetemarche.co.jp/column/instagram_algorithm
- レポート: https://inhouse-plus.jp/reporting/instagram-insight-report/ ／ https://e-pace.co.jp/column/sns-report/ ／ https://lgram.jp/media/know-how/report-generation/
- 非公式アプリのリスク: https://item.woomy.me/is/tutorial/account-ban/ ／ https://snsschool.net/column/instagram-marketing/account-suspension ／ https://tanakacoffeelab.com/instafollowcheck/
- 海外比較: https://media.slooooth.com/ig-analytics-tools-comparison/ ／ https://kigyolog.com/tool.php?id=2186

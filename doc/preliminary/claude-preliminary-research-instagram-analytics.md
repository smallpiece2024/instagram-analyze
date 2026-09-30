# Instagram 分析ツール自作に向けた事前調査（Claude による調査結果）

| 項目 | 内容 |
|---|---|
| 作成日 | 2026-09-30 |
| 作成者 | Claude（Claude Code）による Web 調査の統合 |
| 目的 | 自作 Instagram 分析ツールの **要件定義の入力資料**。国内外の既存ツール、Meta 公式 API の取得可能データと制約、Instagram 固有の特性、実務の分析手法を整理し、要件候補と決めるべき論点を提示する |
| 調査方法 | 5 テーマ（海外ツール／国内ツール／Meta API／Instagram の特性／分析の型）に分けて並列に Web 調査。公式ドキュメント・公式発表を一次情報として優先し、比較記事・レビューサイトは補助とした |
| 付録 | 各テーマの詳細レポート（出典 URL 付き）を `doc/preliminary/claude-preliminary-research-appendix/` に収録。本編は付録の要点を統合したもの |

## 情報の扱いについて

- 出典の信頼度を **[公式]**（Meta / Instagram の公式ドキュメント・公式発表・Adam Mosseri 本人の発言）、**[大手調査]**（Socialinsider、Rival IQ、Dash Social 等の大規模データ分析）、**[第三者]**（ツール事業者・運用代行会社のブログ、比較記事、レビューサイト）の 3 段階で区別している。
- 一次情報で裏付けできなかった事項は **未確認**、調査者の推測は **推測** と明記した。
- 料金は 2025〜2026 年時点の公開情報で、年払い／月払い・通貨・税込税抜が混在する。参考値として扱うこと。
- Meta の API とアプリ内 Insights は 2024〜2026 年に指標の名称・定義が大きく変わっている（後述）。2024 年以前の記事の数値目安は現行指標に読み替えが必要。

---

## 1. エグゼクティブサマリー

1. **既存ツールの大半は Meta 公式 Graph API から取れるデータを可視化しているに過ぎない**。ユーザーの見立ては正しい。差別化要素は「API では遡れない履歴の蓄積」「派生 KPI の計算」「レポート整形」「競合の公開データ比較」「AI 要約」に集約される。
2. **自作ツールの最大の価値は「日次スナップショットの永続保存」**。アプリ内 Insights は 90 日、API のアカウント日次指標は 90 日、ストーリーズは 24 時間で消える。多くの無料プランは 45〜50 日制限で有料化を誘導している。
3. **API は 2 系統ある**。Facebook Login 系（Facebook ページ必須。競合分析・ハッシュタグ検索・タグ付け投稿・ストーリーズ Webhook が使える）と Instagram Login 系（ページ不要だが上記が使えない）。競合分析まで行うなら Facebook Login 系が必要。
4. **個人アカウントは分析できない**。Basic Display API は 2024-12 に廃止済みで、対象はプロアカウント（ビジネス／クリエイター）のみ。
5. **指標体系は 2025-04 に断絶している**。impressions / plays が views に統一され、profile_views 等も廃止。2025-08 にリールの Skip Rate、2025-12 に reposts、2026-04 に saved_count / shares_count フィールドが追加。スキーマは「views 世代」を前提にし、旧指標は履歴用に別保持する。
6. **Instagram のランキングで重いのは watch time / likes / sends（DM 共有）** [公式発言 2025-01]。投稿評価は「shares/reach」「likes/reach」「平均視聴時間／尺」「フォロワー外リーチ比率」を標準指標にすべき。
7. **日本市場には独自の KPI 体系がある**。保存率・ホーム率・プロフィールアクセス率・フォロワー転換率の「4 指標」と「初速分析（投稿後 24 時間を 1 時間刻み）」、「PowerPoint / Excel の月次レポート自動生成」が国内ツールの定番。
8. **エンゲージメント率の分母は各社で異なる**（followers / reach / views）。ベンチマーク値が 0.3%〜1.9% とぶれるのはこのため。自アカウント評価はリーチベース（保存・シェア込み）、競合比較はフォロワーベース（いいね＋コメント）と定義を分けて併記する。
9. **競合について取れるのは公開データのみ**（フォロワー数、投稿数、投稿ごとの like / comments / リール view_count）。リーチ・保存・属性は取れない。スクレイピングや非公式 API は規約違反で凍結リスクがあり採用しない。
10. **MVP は「接続・トークン管理」「日次蓄積」「投稿別スナップショット（初速）」「ストーリーズの 24 時間内取得」「派生 KPI 付き投稿一覧」「概要ダッシュボード」「月次レポート」**。競合・AI・UGC・異常検知の高度化は後回しでよい。

---

## 2. 市場調査: 既存ツールの全体像

### 2.1 海外ツール（分類別）

詳細は付録 01。価格は年払い換算の月額が中心で、参考値。

| 分類 | ツール | ターゲット | 特徴・差別化 | 価格帯（2025〜26） |
|---|---|---|---|---|
| 総合 SNS 管理 | Sprout Social | 中堅〜大企業 | 大量の指標・レポート、AI 要約、Listening は別売 | $79〜399/シート/月 |
| 総合 SNS 管理 | Hootsuite | 中小〜大企業 | 目標別の最適投稿時間ヒートマップ、競合 20 社比較、業界ベンチマーク | $99〜399/ユーザー/月 |
| 総合 SNS 管理 | Later | 個人・中小 | ビジュアルプランナー由来、Link in Bio 売上計測、ER はリーチベース | $18.75〜82.5/月 |
| 総合 SNS 管理 | Buffer | 個人〜小規模 | チャンネル課金で安価、AI Takeaways | $5〜12/チャンネル/月 |
| 総合 SNS 管理 | Metricool | フリーランス・代理店 | Impressions→Views を日付で分割表示、Looker Studio 連携 | €0〜43/月 |
| 総合 SNS 管理 | Iconosquare | 中小・代理店 | 100 以上の指標、ドラッグ＆ドロップのダッシュボード、業界ベンチマーク | €0〜119/月 |
| 総合 SNS 管理 | Agorapulse | 中小・代理店 | UTM 自動付与＋Google Analytics 連携の Social ROI | $79〜149/ユーザー/月 |
| 総合 SNS 管理 | Sendible / Planoly / Tailwind / Flick | 代理店／個人 | Flick はハッシュタグ順位追跡が独自 | $9〜179/月 |
| 分析特化 | Socialinsider | 代理店・ブランド | ER を reach 基準／followers 基準で切替、年次ベンチマーク公開、AI ピラー分類 | $82〜199/月 |
| 分析特化 | Rival IQ | ブランド・代理店 | 競合集合「Landscape」でのベンチマーク、中央値で報告 | $239〜559/月 |
| 分析特化 | quintly / Minter.io / Sotrender / Not Just Analytics | 代理店〜個人 | Minter.io はストーリーズを無期限保持、毎時更新 | $9〜355/月 |
| エンタープライズ | Brandwatch / Emplifi / Sprinklr / Talkwalker / Meltwater / Dash Social | 大企業 | Listening 統合、独自スコア（Dash Social の Entertainment Score 等） | 要問合せ（年 $12,000〜） |
| インフルエンサー分析 | HypeAuditor / Modash / Phlanx / Analisa.io | ブランドの案件選定 | フェイクフォロワー検出（公開データ＋ML）。規約リスクのある取得手段を含む可能性 | $199〜499/月 |
| 公式（無料） | Instagram アプリ内 Insights / Meta Business Suite / Edits | 全員 | 2026-04 に Overview / Engagement / Audience の 3 タブに再編。90 日まで。CSV は 90 日単位 | 無料 |

### 2.2 国内ツール

詳細は付録 02。

| ツール | 提供会社 | ターゲット | 特徴 | 価格帯 |
|---|---|---|---|---|
| SINIS for Instagram | テテマーチ | 中小〜大企業・代理店 | 無料 LITE（45 日保持）、相関分析、2 期間比較、Excel / PowerPoint 自動生成、他社 6〜10 社、初速分析、AI アシスト考察 | 0〜55,000 円/月 |
| Slooooth（旧 Aista） | notari | 中小〜代理店 | 日本初の Instagram 専用分析。50 枚以上のレポート生成、AI 改善提案。ハッシュタグ提案「ハシュレコ」も同社 | 8,800 円/月（Aista プレミアは 30 万円/月） |
| SAKIYOMI 分析ツール | SAKIYOMI | 個人〜中小の内製担当 | 「4 指標」に絞ったダッシュボード、ストーリーズ視聴完了率、教材・コミュニティ付き | 10,000〜50,000 円/月 |
| Social Insight | ユーザーローカル | 中堅〜大企業 | マルチ SNS、クチコミ分析、キャンペーン自動化、PowerPoint 自動作成 | 初期 5 万＋月 5 万円〜 |
| comnico Marketing Suite | コムニコ | 企業マーケ・代理店 | 3 段階承認フロー、カスタム自動レポート、無料の PPT 月次テンプレ配布 | 初期 10 万＋月 4.5〜5 万円 |
| Beluga | ユニークビジョン | 企業（キャンペーン主体） | インスタントウィン・UGC 収集・当選管理 | 初期 10 万＋月 2〜23 万円 |
| Tofu Analytics | misosil | 中小〜企業 | ソーシャルリスニング寄り、AI 感情・属性判定、2 次・3 次拡散追跡 | 月 1 万円〜 |
| HINOME | Hinome | 個人〜企業 | 初速分析（24 時間を 1 時間刻み）、AI ハッシュタグ提案、PNG / Excel 出力 | 0〜55,000 円/月 |
| Reposta | ROC | 代理店・インフルエンサー | レポート出力特化、KGI・KPI 機能、日次メール | 0〜5,500 円/月/アカウント |
| Insight Suite | スマートシェア | 個人〜企業 | 無料 50 日保持、ハッシュタグ・競合・UGC 分析、予約投稿 | 0〜50,000 円/月 |
| CCX social（旧 MASAI） | ライスカレープラス | 個人〜企業 | 基本無料、アナリストレポート自動表示、AI コンサルタント 500 円/月 | 0〜500 円/月 |
| GRASIS | SNAPLACE | 自社運用〜代理店 | アカウント数無制限、アドフラウド検出、AI 画像診断 | 0〜120,000 円/月 |
| ooowl / hashpick / hashout / InStats / SocialDog / aumo Biz 他 | 各社 | 初心者〜企業 | ハッシュタグ効果測定（hashout）、MEO 統合（aumo Biz）など | 3,000〜100,000 円/月 |
| Statusbrew 日本版 | Statusbrew | 多店舗・代理店・大企業 | 海外製のローカライズ。多段階承認、統合受信箱、259 指標 | 6,400 円〜 |

依頼にあった Kanaria / Minsta / Nobita / Toaster は Instagram 分析ツールとして実態を確認できなかった（未確認）。Insight Intelligence Q はデータセクション社のリスニングツールでホットリンク製ではない。

### 2.3 ほぼ全ツールに共通する定番機能

1. **アカウント概要**: フォロワー数と増減（日次・純増）、reach、views（旧 impressions）、interactions、ER と前期間比
2. **投稿一覧テーブル**: サムネイル、種別（画像／カルーセル／リール）、likes / comments / saves / shares / reach / views / ER でソート、トップ投稿抽出
3. **リール・ストーリーズの個別分析**: リールは views / reach / 視聴時間 / 維持率、ストーリーズは reach / views / replies / navigation（次へ・戻る・離脱）/ 完了率
4. **オーディエンス属性**: 年齢・性別・国／都市（フォロワー 100 人以上で取得可）
5. **最適投稿時間**: 曜日×時間のヒートマップ
6. **ハッシュタグ分析**: 自投稿で使ったタグ別の成果
7. **競合比較**: 公開データ（フォロワー数、投稿数、平均 likes / comments、フォロワーベース ER）の並列比較
8. **レポート出力**: PDF / CSV / Excel / PowerPoint、定期メール、ロゴ差替え
9. **データ保持期間をプランで差別化**（無料 30〜50 日、有料 1〜3 年または無制限）
10. **AI 要約**（2025〜2026 年に急速に定番化。Sprout、Buffer、Metricool、Socialinsider、Iconosquare、Hootsuite、SINIS、CCX social 等）

### 2.4 一部のツールだけが持つ差別化機能

- **業界ベンチマーク**（自社 vs 業界中央値）: Iconosquare、Socialinsider、Rival IQ、Emplifi、Dash Social、Hootsuite
- **独自スコア**: Dash Social の Entertainment Score、HypeAuditor の AQS、Modash のフェイク率
- **カスタム指標・ダッシュボード**: quintly（独自クエリ言語）、Sprout Premium Analytics、Iconosquare
- **ハッシュタグ順位トラッキング**: Flick（取得手段は非公開。API 制約上、公開データ取得を併用している可能性。推測）
- **オーガニック／広告の分離表示**: Metricool、Sotrender、Sprout
- **ROI 連携**: Agorapulse（UTM 自動付与＋GA）、Later（Link in Bio 売上）
- **BI 連携・MCP**: Looker Studio コネクタ（Metricool、Socialinsider、Rival IQ、Iconosquare）、MCP サーバー（Socialinsider、Minter.io、Iconosquare）
- **API 制約を超える保持**: Minter.io のストーリーズ無期限保持
- **国内独自**: 4 指標ダッシュボード（SAKIYOMI）、初速分析（HINOME、SINIS、CCX social、Reposta、InStats）、PPT / Excel 自動生成、承認フロー、インスタントウィン等のキャンペーン管理、タグ付け・メンション投稿からのファンユーザー特定

### 2.5 国内と海外の思想の違い

- **海外**: マルチ SNS のチーム運用基盤（受信箱、承認、Listening）。業界ベンチマークと 100 以上の指標をリアルタイムに見せる。日本語サポートは弱い。
- **国内**: Instagram 単体特化が多く、無料〜1 万円台に裾野がある。「上司・クライアントへの報告資料を短時間で作る」「フォロワーを増やすための 4 指標 PDCA」に最適化。運用代行会社（SAKIYOMI、テテマーチ等）発の KPI をそのままツールに実装している。

### 2.6 ユーザーの不満点と、自作で解決できること

| 不満（出典: G2 / Capterra / ITreview / 事業者ブログ） | 自作での解決策 |
|---|---|
| 日次データが 90 日（無料ツールは 45〜50 日）で消え、遡れない | API を日次で叩き自前 DB に蓄積 |
| サードパーティも「接続した日以降」しか持たない | 接続直後に過去メディアの累計値をバックフィルし、以後は差分で履歴化 |
| ストーリーズの履歴が残らない | 24 時間以内のポーリング＋`story_insights` Webhook |
| 投稿別の長期トレンド（初速・ロングテール）が見えない | 投稿後 1h / 6h / 24h / 48h / 7d / 28d のスナップショット |
| 比較期間が固定、前年同月比が出ない | 任意期間 vs 任意期間の比較 |
| レポート整形が面倒（担当者は週 3.8 時間を分析・レポートに費やす [Sprout 調査]） | テンプレート化した月次レポートの自動生成 |
| 複数アカウント横断が高価（シート課金・アカウント課金） | 自前 DB でアカウント数の制限なし |
| views と impressions の混在で数字が跳ねる | 2025-04-21 を境に系列を分け、グラフに注釈 |
| コラボ・Trial・ブースト投稿が通常投稿と混ざる | 投稿属性でフラグ管理し、集計から除外可能に |
| ハッシュタグ単位のリーチが分からない、レポートテンプレの自由度が低い、UI が古い、連携が切れる、データ反映が遅い | 設計目標として取り込む |

---

## 3. Meta 公式 API で取得できるデータと制約

詳細は付録 03（v25.0 リファレンスに基づく）。

### 3.1 API の 2 系統と選択

| 項目 | Instagram API with Facebook Login（旧 Instagram Graph API） | Instagram API with Instagram Login（2024-07〜） |
|---|---|---|
| ホスト | graph.facebook.com | graph.instagram.com |
| Facebook ページ | **必須** | 不要 |
| インサイト | 可 | 可（2025-01 以降） |
| Hashtag Search | 可 | **不可** |
| Business Discovery（競合の公開データ） | 可 | **不可** |
| タグ付け投稿 `/tags` | 可 | 不可（ドキュメント間で矛盾あり、未確認） |
| `story_insights` Webhook | 可 | 不可 |
| 広告を含む合算指標（total_likes 等）、facebook_views、ストーリーズ link_clicks | 可 | 不可 |
| 長期トークン | Facebook User 約 60 日、Page token は無期限、System User token は無期限 | Instagram User 60 日（24 時間経過後に更新可） |

- 両系統ともプロアカウント（ビジネス／クリエイター）専用。個人アカウントは不可。
- **自分が管理するアカウントだけを扱うなら App Review 不要（Standard Access）**。アプリで役割（Admin / Developer / Tester）を持つユーザーのアカウントは開発モードのまま扱える。ただし **Webhooks は Live モード＋Advanced Access が必須**、Hashtag Search の「Instagram Public Content Access」も審査が必要と記載（開発モードで動くかは未確認）。
- API 利用料は無料。必要なのは Meta 開発者アカウント、Business 型アプリ、プロアカウント、（Facebook Login 系なら）Facebook ページ。
- Graph API のバージョンは 2 年サポート。常に明示指定する。調査時点の最新は v26.0（2026-07-29）。

### 3.2 自アカウントについて取れるデータ

| 分類 | 取れるもの | 粒度・遡及 |
|---|---|---|
| プロフィール | followers_count, follows_count, media_count, biography, website, name, username, profile_picture_url | **現在値のみ。履歴なし** |
| アカウント日次インサイト | reach（内訳 media_product_type / follow_type）, views（内訳 follower_type / media_product_type）, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, reposts, follows_and_unfollows（内訳 follow_type）, profile_links_taps（内訳 contact_button_type） | period=day。**保存 90 日**。1 クエリの since〜until 上限は 30 日との二次情報あり（未確認） |
| オーディエンス属性 | follower_demographics, engaged_audience_demographics（age / gender / city / country、this_week / this_month） | 現在のスナップショットのみ。上位 45 件。**フォロワー 100 人未満は取得不可** |
| 時間帯別オンライン | online_followers | 直近 30 日。**現行バージョンで返るかは未確認** |
| メディア一覧 | id, caption, media_type（IMAGE / VIDEO / CAROUSEL_ALBUM）, media_product_type（FEED / REELS / STORY / AD）, timestamp, permalink, media_url, thumbnail_url, like_count, comments_count, view_count, saved_count, shares_count, reposts_count, is_ai_generated, children 等 | 直近 10,000 件。since / until 指定可 |
| メディアインサイト（累計値） | FEED / CAROUSEL: views, reach, likes, comments, shares, saved, reposts, total_interactions, profile_visits, profile_activity（BIO_LINK_CLICKED / CALL / DIRECTION / EMAIL / TEXT）, follows。REELS: views, reach, likes, comments, shares, saved, reposts, total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time, reels_skip_rate, crossposted_views。STORY: views, reach, shares, replies, navigation（SWIPE_FORWARD / TAP_BACK / TAP_EXIT / TAP_FORWARD）, profile_visits, profile_activity, follows, link_clicks（FB Login） | **累計値のみ（時系列なし）**。保存 2 年。**ストーリーズは 24 時間のみ**。カルーセルの子メディアにはインサイトなし。リールでの profile_visits / follows の可否は資料間で記載が揺れる（未確認） |
| コメント | 本文、投稿者、いいね数、返信。非表示／削除／返信操作 | メディアが残る限り |
| メンション・タグ付け | mentioned_media, mentioned_comment（ストーリーズのメンションは非対応）, /tags（FB Login） | 現在返せる範囲 |
| Webhook | comments, mentions, story_insights（FB Login）, messages（IG Login） | リアルタイム。Live＋Advanced Access が必要 |
| フォロワー一覧 | **API では不可**。「あなたの情報をダウンロード（DYI）」の JSON エクスポート（準備に最大 30 日、手動）のみ | 手動 |

### 3.3 競合・他者について取れるデータ

| 手段 | 取れるもの | 取れないもの |
|---|---|---|
| Business Discovery（FB Login） | username, biography, website, followers_count, media_count、各メディアの caption, like_count, comments_count, view_count（リール）, media_type, media_product_type, permalink, timestamp, media_url | follows_count, name（資料により記載が揺れる）、ストーリーズ、インサイト（reach / saves / shares）、フォロワー一覧、属性、非公開・個人・年齢制限アカウント |
| Hashtag Search（FB Login） | タグ付き公開メディアの caption, like_count, comments_count, media_type, permalink, timestamp（top_media / recent_media） | **投稿者 username**、ストーリーズ、広告。recent_media はクエリ時点から 24 時間以内のみ |
| Webhook / mentions / tags | 自分に言及・タグ付けした他者のメディア基本情報 | 相手のインサイト |

競合分析でできること: フォロワー数・投稿数の日次推移（自前蓄積）、投稿ごとの like / comments / view_count からのフォロワーベース ER 推定、投稿頻度・種別・時間帯の分析。**できないこと: 競合のリーチ・保存・シェア・ストーリーズ・属性**。

### 3.4 制約一覧

| 項目 | 制約 |
|---|---|
| レート制限（Instagram Platform 一般、BUC） | 24 時間あたり **4800 × 対象アカウントの直近 24 時間のインプレッション数**。ヘッダ X-Business-Use-Case-Usage で残量確認。フォロワーが少ないアカウントは枠が極端に小さくなり得る |
| レート制限（Business Discovery / Hashtag Search） | Platform Rate Limit: 1 時間あたり 200 × アプリのユーザー数。ヘッダ X-App-Usage |
| Hashtag Search | ローリング 7 日間で **30 ユニークハッシュタグ**／アカウント |
| Content Publishing | 24 時間で 100 件（リファレンスは 50 件と記載。未確認）。**予約投稿の機能は API に無い**（自前スケジューラが必要） |
| データ反映遅延 | **最大 48 時間**。日次値は取得日から 2〜3 日前まで再取得して上書きする |
| 欠損の表現 | 0 ではなく空配列で返る。NULL と 0 を区別する |
| 日本固有 | ストーリーズの replies は欧州・日本のユーザーに対し **常に 0** |
| media_url / thumbnail_url | 有効期限付き URL。サムネイルを残すなら自前保存 |
| コラボ投稿 | 指標は共同投稿者間でプール（同一値）。作成者のみデータ取得可 |
| トークン | 長期トークンは 60 日。**50〜55 日周期の自動更新**を組まないと本番で静かに壊れる。app secret を使う交換処理はサーバー側で実行 |
| Platform Terms | Platform Data は不要になったら可及的速やかに削除、目的外利用・販売・再識別禁止。自アカウントの蓄積は正当な目的の範囲と解釈できる（推測）。他者のデータの長期保存は慎重に |
| スクレイピング | Meta 利用規約で自動化手段によるデータ取得は禁止。凍結・IP ブロック・法的措置のリスク。**採用しない** |

### 3.5 2024〜2026 年の主な変更タイムライン（API・Insights）

| 日付 | 変更 |
|---|---|
| 2024-05 | v20.0。属性の timeframe は this_week / this_month のみに |
| 2024-07-23 | Instagram API with Instagram Login 提供開始 |
| 2024-08-07 | Instagram が「views」を全形式の主要指標に統一すると発表 |
| 2024-12-04 | Basic Display API 停止。個人アカウント向け API 消滅 |
| 2025-01-08 | profile_views, website_clicks, email_contacts, get_directions_clicks, phone_call_clicks, text_message_clicks 廃止。後継は profile_links_taps（プロフィール訪問数の日次推移は API で取れなくなった） |
| 2025-01-21 | v22.0。views 新設。impressions, plays, clips_replays_count 等を廃止（全バージョン 2025-04-21 停止）。Instagram Login でもインサイト取得可に |
| 2025-06-16 | IG Media に view_count 追加（Business Discovery でもリールの再生数が取れる） |
| 2025-08-24 | アプリ内 Insights にリールの Retention チャートと Skip Rate（View Rate は廃止） |
| 2025-11-03 | アプリ内 Professional Dashboard に Competitive Insights（最大 10 アカウント。ER は非表示） |
| 2025-12-03 | メディア reels_skip_rate, reposts, crossposted_views, facebook_views／ユーザー reposts 追加。DELETE /{ig-media-id}、トライアルリール API |
| 2026-04-22 | IG Media に reposts_count, saved_count, shares_count、total_like_count / total_comments_count / total_views_count（FB Login）。Like API |
| 2026-04 | アプリ内 Insights を Overview / Engagement / Audience の 3 タブに再編。Share Rate、views over time を投稿単位で表示 |
| 2026-06-22 | is_ai_generated、ストーリーズ link_clicks（FB Login） |
| 2026-07-29 | v26.0 |

国内記事には「2026-06-15 に API 側でリーチ・インプレッションが廃止され Media Views / Viewers へ移行」との記述があるが、v25.0 の Instagram リファレンスでは reach は現存しており、Facebook ページ側の変更の可能性がある（未確認。要実機確認）。

### 3.6 実機検証が必要な未確認事項

1. follower_count（period=day）と online_followers が現行バージョンで返るか
2. ユーザーインサイトの since〜until の最大レンジ（30 日か）
3. メディアインサイトの 1 リクエスト最大範囲（90 日との二次情報）
4. Content Publishing の 24 時間上限（100 か 50 か）
5. Business Discovery で profile_picture_url / follows_count が取れるか
6. Instagram Login で /tags が使えるか
7. Hashtag Search が開発モード（Standard Access）で動くか
8. DYI エクスポートにアカウントインサイトが含まれるか
9. リールで profile_visits / follows が返るか
10. 日付境界のタイムゾーン（UTC-7 で判定されるとの二次情報）
11. 2026-06-15 のリーチ廃止が Instagram にも及ぶか

---

## 4. Instagram の特性と分析観点

詳細は付録 04。

### 4.1 コンテンツ形式ごとの特性と見るべき指標

| 形式 | 役割 | 見るべき指標 | 注意 |
|---|---|---|---|
| フィード画像 | 既存フォロワーへの定期接触 | views, reach, likes, comments, saved, shares, profile_visits, follows | ER が最も低い形式（Socialinsider 2025: 0.37%） |
| カルーセル（最大 20 枚） | 保存・熟読を促す | 上記＋saved（保存が最も多い形式） | ER 最高（0.55%）。枚数を属性に持つ |
| リール（最長 3 分、20 分説あり） | フォロワー外リーチ・発見 | views, reach, avg_watch_time, total_view_time, skip_rate, shares, saved, follows | 視聴の過半がフォロワー外。watch time と sends が重い |
| ストーリーズ（24 時間） | 関係維持・送客 | reach, views, replies（日本は 0）, link_clicks, navigation 4 種, profile_activity | **24 時間以内に取得しないと消える** |
| ライブ | リアルタイム交流 | 配信中のみ | 2025-08 から 1,000 フォロワー以上が必要 |
| ハイライト・ノート・ブロードキャストチャンネル・Instants | 補助 | Insights が乏しい／無い | 手動入力欄で補うか対象外に |
| Trial Reels（2024-12〜） | フォロワー外だけに試験配信 | 通常投稿と分けて集計 | 基準超で自動公開 |
| コラボ投稿 | 相互フォロワーへ配信 | 指標は共同投稿者で共有 | 自アカウント単独の指標と混ぜない |
| リポスト（2025-08〜） | 他者投稿を自分のタブへ | reposts | リポスト主体はおすすめ対象外 |
| ショッピング（商品タグ） | 商品ページへの導線 | Commerce Manager 側 | Shop タブ・アプリ内決済は縮小、商品タグは継続 |

### 4.2 アルゴリズム・ランキングシグナル

- **サーフェス別のシグナル** [公式 2023-05]: フィードは「ユーザーの行動、投稿の情報、投稿者の情報、関係」。発見タブは「投稿の人気度がフィードよりはるかに重要」で予測対象は「いいね・保存・シェア」。リールは「リシェア・最後まで視聴・いいね・音源ページ遷移」を予測。**低解像度・ウォーターマーク付き・無音・枠付き・大部分がテキスト・再投稿のリールは非推薦**。
- **3 大シグナル** [Mosseri 2025-01-22]: 「watch time、likes、sends」。Insights では「average watch time、likes per reach、sends per reach」に注目せよと発言。likes はフォロワー向け、sends はフォロワー外向けでやや重い。コメントは 3 つに含まれない。「sends は likes の 3〜5 倍」等の重み数値は第三者の推測で未確認。
- **オリジナル性** [公式 2024-04、2026-04]: 30 日に 10 回以上の無加工リポストは推薦除外。2026-04-30 から写真・カルーセルにも拡大し、月単位で「大半が他人のコンテンツ」なら非推薦。
- **ハッシュタグ** [Mosseri]: 「リーチを増やさない。内容を伝え検索を助けるもの」。2025-12 から上限 30→5 個。2025-07 から公開プロアカウントの投稿が Google 検索にインデックスされ、キャプション・代替テキストのキーワードが外部流入に影響。
- **推薦の比率** [Meta 決算 2024-04]: Instagram で見られるコンテンツの 50% 超が AI 推薦。**フォロワー数はリーチの上限ではない**。分析では reach の follow_type 内訳（FOLLOWER / NON_FOLLOWER）と shares を中心に「発見される力」を測る。
- **シャドウバン**: 公式には「推薦不適格（not eligible for recommendation）」。Account Status で確認・異議申立て可。分析では「フォロワー外リーチ比率が突然ゼロ近くになる」パターンを制限の兆候として切り分ける。
- **共有の主戦場は DM** [Mosseri 2023-12、2025-12]: 公開指標に現れない sends（shares）が最重要シグナル。

### 4.3 他 SNS と比べた Instagram 分析の難しさ

1. 公開データが極端に少ない（他者はフォロワー数・likes・comments まで）
2. ハッシュタグ検索 API が弱い（30 タグ／7 日、投稿者不明、直近 24 時間）
3. 消えるコンテンツが多い（ストーリーズ 24 時間、ノート 3 日、Instants）
4. アプリ内 Insights は 90 日のローリングウィンドウ
5. 日本固有: ストーリーズ replies が API で常に 0
6. 本文にリンクを貼れない。送客はプロフィール・ストーリーズ・DM 経由に限られ、DM は Insights 対象外（UTM が必須）
7. 形式ごとに指標体系が違い、統一 KPI が作りにくい
8. 指標定義の変更が頻繁（2025-04、2025-08、2026-04）
9. 画像・動画中心で、テキスト分析だけでは要因分析が弱い
10. コラボ投稿の指標が共有される
11. Threads は別プラットフォーム・別 API

### 4.4 KPI の推奨定義とベンチマーク

**エンゲージメント率の定義比較**

| 定義 | 分子 | 分母 | 採用例 | 用途 |
|---|---|---|---|---|
| A. フォロワーベース（狭義） | likes + comments | followers | Socialinsider、Rival IQ | **競合比較・業界ベンチマーク照合**（公開情報で計算可） |
| B. フォロワーベース（広義） | likes + comments + saves + shares | followers | HypeAuditor 等 | 自アカウントのみ |
| C. リーチベース | likes + comments + saves + shares | reach | Later、Hootsuite、国内実務 | **自アカウントの投稿評価**（見た人のうち反応した割合） |
| D. ビューベース | interactions | views | Dash Social | views は再表示を含むため C より低く出る |

**推奨 KPI 定義**

| KPI | 定義 | 根拠 |
|---|---|---|
| ER（自アカウント） | (likes + comments + saves + shares) / reach | 公式が重視する saves / shares を含み、フォロワー外リーチの影響を受けない |
| ER（競合・ベンチマーク用） | (likes + comments) / followers | Socialinsider・Rival IQ と定義が揃う |
| 発見力 | shares / reach、reach(NON_FOLLOWER) / reach | Mosseri の「sends per reach」 |
| いいね率 | likes / reach | 3 大シグナル |
| 保存率 | saved / reach | 国内 4 指標 |
| プロフィール遷移率 | profile_visits / reach | 国内 4 指標 |
| フォロー転換率 | follows / profile_visits（投稿単位）、follows_and_unfollows（日次） | 国内 4 指標 |
| ホーム率（近似） | reach(FOLLOWER) / followers_count | 国内定義は「ホームからの閲覧数 ÷ フォロワー数」または「フォロワー内リーチ ÷ フォロワー数」で揺れる。API では流入元別の閲覧数が取れないため reach の follow_type 内訳で近似（推測） |
| 動画品質 | ig_reels_avg_watch_time / 尺、reels_skip_rate | 公式 Insights と同じ定義 |
| ストーリーズ品質 | TAP_EXIT / views、SWIPE_FORWARD / views、完了率（最終スライド views ÷ 最初のスライド views） | navigation 内訳 |
| 送客 | link_clicks（ストーリーズ）、profile_activity.BIO_LINK_CLICKED、UTM セッション | DM は測れない |
| 成長 | follows_and_unfollows 純増、フォロワー成長率 | |

**ベンチマーク値（出典・年を必ず併記して表示する）**

| 指標 | 値 | 出典 |
|---|---|---|
| ER（フォロワーベース）全業種 | 中央値 0.30%（2026）、0.36%（2025）。上位 25% は 1.05% | Rival IQ / Quid |
| ER（フォロワーベース）形式別 | 平均 0.48%（前年比 -24%）。カルーセル 0.55%、リール 0.52%、画像 0.37% | Socialinsider 2025 データ（3,500 万投稿） |
| ER フォロワーベース／ビューベース | 0.4% / 1.9%。リール 2.7%、カルーセル 1.4%、静止画 1.3%（ビューベース） | Dash Social 2026 H1 |
| 年間フォロワー増加率 | 1〜5K: 22.0%、10〜50K: 17.2%、100K〜1M: 11.3% | Socialinsider 2025 |
| ストーリーズ リーチ率（viewers / followers） | 1〜5K: 約 10%、100K〜1M: 約 0.5〜0.65%。離脱率 8〜13%、完了率約 70% | Socialinsider 2025、Dash Social 2025 |
| 投稿頻度 中央値 | 月あたりリール 8、カルーセル 5、画像 7 | Socialinsider 2025 |
| 最適投稿時間 | 各社（Buffer / Sprout / Hootsuite / Later）で結論が異なる | 自アカウントの online_followers と投稿時刻別成果から算出するのが妥当 |

### 4.5 日本市場の KPI 体系（4 指標＋初速）

| 指標 | 計算式 | 目安（出典・年） |
|---|---|---|
| 保存率 | 保存数 ÷ リーチ数 | 2〜3%（SAKIYOMI 2025〜26）。3% 超でバズ傾向。1〜3% 平均、3〜5% 良、5% 以上優秀（Genegram 2026-09） |
| ホーム率 | ホームからの閲覧数（またはフォロワー内リーチ）÷ フォロワー数 | 30〜50%。60% 超でバズが生まれやすい（SAKIYOMI）。規模別に 2,000 人: 30%、5 千〜1 万: 50% |
| プロフィールアクセス率 | プロフィールアクセス数 ÷ リーチ数 | 3〜5%（SAKIYOMI）、1〜3%（lgram）、0.5〜1.5%（neworder 2026）※定義差・業種差が大きい |
| フォロワー転換率 | フォロワー増加数 ÷ プロフィールアクセス数 | 6〜8%（SAKIYOMI、strategy-code）。neworder は 20〜40% と大きく乖離（母数の取り方が異なる可能性。推測） |
| フォロワー外リーチ率／発見タブ流入率 | 非フォロワーリーチ ÷ 総リーチ | 50% 超で新規層到達、発見タブ 20〜40% 以上（neworder 2026） |
| リール視聴維持率／スキップ率 | 平均再生時間 ÷ 尺、3 秒以内離脱割合 | 維持率 70% 以上（国内）、尺別 30〜70%（海外 Retensis 2026）、スキップ率 50% 以下→30% 未満で良好 |
| ストーリーズ リーチ率／離脱率 | viewers ÷ followers、TAP_EXIT ÷ views | リーチ率 10〜20%、離脱率 5% 以下（neworder 2026） |
| 初速 | 投稿後 24 時間を 1 時間刻みで可視化。1 日後の保存率 3% 以上が目安 | SAKIYOMI。分析タイミングは「1 日後→1 週間後→1 か月後」 |

いずれも各社の経験則で母集団は非公開。Meta 公式の目安値は存在しない。ツール内では出典・年・定義をラベル付きで表示し、目安値は設定で切り替え可能にする。

---

## 5. 分析の型（KPI ツリー／レポート／ダッシュボード／手法）

詳細は付録 05。

### 5.1 目的別 KPI ツリー（3 パターン）

**A. ブランド認知（企業・店舗）**
- KGI: 指名検索数／来店・問い合わせ数／UGC 投稿数
- L1: 月間リーチ（非フォロワー比率 40〜60% を目標）、フォロワー純増、メンション・タグ付け数
- L2: 投稿別リーチ、シェア率（1〜2%）、保存率（2〜3%）、ホーム率（30〜50%）
- L3: 投稿数×フォーマット、24 時間初速リーチ、リール平均視聴時間、online_followers との適合

**B. EC 送客**
- KGI: Instagram 経由売上・CV（GA / UTM 側で計測）
- L1: profile_links_taps、ストーリーズ link_clicks、CVR
- L2: プロフィールアクセス率（1〜5%）、ストーリーズ リーチ率（10〜20%）・完了率（70%）、投稿別 profile_visits
- L3: 商品系投稿の保存率、コメント・DM の質問数、キャンペーンタグ別リーチ

**C. クリエイター**
- KGI: フォロワー純増（週 1〜2%）＋案件・収益
- L1: 投稿別ファネル（reach → profile_visits → follows）、フォロワー転換率 6〜8%
- L2: 非フォロワー比率、リール維持率、3 秒スキップ率 30% 未満、シェア率
- L3: 投稿頻度（リール週 2 本目安）、初速、ホーム率

### 5.2 月次レポートの定番構成

国内（neworder、Re:Works、comnico、SAKIYOMI、inhouse-plus）と海外（Later、AgencyAnalytics、DashThis、ReportingNinja）に共通する型は「結果 → 原因 → 次アクション」を 1 行ずつ、指標は 5〜7 個に絞る、前月比と目標比の 2 軸、ベスト／ワースト投稿をサムネイル付きで示す、というもの。

1. 総評 3 行（結果・課題・来月方針）
2. KPI サマリー表: 5〜7 指標 × 実績／前月比／目標比／原因コメント
3. フォロワー推移（日次折れ線、純増、イベント注記）
4. リーチ・閲覧数推移（フォロワー／非フォロワー内訳、views 定義の脚注）
5. フォーマット別サマリー（フィード: 保存率・ホーム率／カルーセル: シェア率／リール: 維持率・平均視聴時間／ストーリーズ: リーチ率・完了率・リンククリック）
6. 勝ち投稿 Top3／課題投稿 Top3（サムネイル・数値・仮説）
7. タグ別（テーマ×フォーマット×CTA）の平均比較
8. ファネル（リーチ→プロフィール→フォロー→リンク）の転換率と目安比較
9. フォロワー属性（年齢・性別・地域）とターゲットとの差分
10. 競合ベンチマーク（フォロワー成長率・推定 ER・投稿頻度）
11. コミュニティの声（コメント・メンションの主要トピック、質問）
12. 来月の施策（優先順位付き）と投稿計画

国内では PowerPoint / Excel 形式の需要が高い。前年同月比は 2025-04 の views 統一で系列が断絶するため脚注が必要。

### 5.3 ダッシュボードの推奨画面構成

公式の 2026 年再編（Overview / Engagement / Audience）と第三者ツールの典型（Overview / Content / Audience / Competitors / Hashtags / Reports）は収斂している。

| 画面 | 主要ウィジェット | 必要データ |
|---|---|---|
| 概要 | KPI スコアカード（前期比）、フォロワー・リーチ・閲覧数の日次折れ線（7 日移動平均）、異常アラート | アカウント日次スナップショット、目標値 |
| 投稿一覧 | 表（サムネイル、フォーマット、タグ、リーチ、非フォロワー比、保存率、シェア率、フォロー数、ER）、ソート・タグフィルタ | メディア一覧＋最新インサイト、タグ |
| 投稿詳細 | 1h〜28d の累積曲線（初速・ロングテール）、同フォーマット中央値との比較、ファネル、使用ハッシュタグ | メディアスナップショット履歴 |
| ストーリーズ | 日別リーチ率、スライド順の離脱率、リンククリック | 24 時間内に取得したストーリーズ指標 |
| オーディエンス | 属性（年齢・性別・地域）、online_followers ヒートマップ、フォロワー／非フォロワー比の推移 | 属性スナップショット、online_followers |
| 競合 | フォロワー推移、投稿頻度、推定 ER の並列比較 | Business Discovery 日次スナップショット |
| レポート | 月次レポート生成、期間選択、CSV / PDF 出力 | 上記すべて |

グラフ種別の定番: 時系列折れ線（フォロワー・reach・views）、投稿種別ごとの棒／積み上げ、曜日×時間ヒートマップ、属性の横棒（年齢×性別）と国／都市ランキング、リールのリテンション曲線、ストーリーズのファネル。ER は分母をツールチップで明示し、可能なら切替可能にする。指標変更の境界（2025-01-01 や 2025-04-21）にはツールチップで注記する（Metricool、Sprinklr の実例）。

### 5.4 分析手法

- **伸びた／伸びなかった投稿の要因分析**: 同フォーマット内で上位 20%／下位 20% を抽出 → タグ（テーマ・CTA・構成）で集計 → 差が出た属性を仮説化 → 翌月 2〜4 本で検証 → 「勝ち Top3／課題 Top3」としてレポート。フォロワー内指標（ホーム率）だけ改善しても保存率が上がらなければ発見タブに載らない、という国内の失敗事例あり。
- **投稿の属性タグ付け**: フォーマット（media_type / media_product_type）は API から自動付与。テーマ・CTA 有無・撮影パターンは手動タグが基本。タグは 3 種（キャンペーン／コンテンツ種別／目的）で合計 3〜5 個に絞り、投稿時に付ける（事後付与は続かない）。自動分類は LLM で補助できるが、再現性のためルールベースを優先する OSS 例がある。
- **初速**: 国内で定着（投稿後 24 時間を 1 時間刻み）。海外は Engagement Velocity（総エンゲージメント ÷ 経過時間）。**API のメディアインサイトは累計値のみ返すため、自前で投稿後のスナップショットを定期取得して差分を保存する必要がある**。48 時間の反映遅延があるため投稿後 1 時間の値の信頼性は要検証。
- **異常検知**: 固定閾値（透明だが季節で誤報）とベースライン型（4〜8 週の季節ベースラインとの乖離）。2〜3 連続区間の逸脱で発火、重大度で通知先を分ける。バズ検知は「直近 N 投稿の中央値に対する倍率」など。
- **ハッシュタグ**: 効果は「測定可能だが小さい」（Fanpage Karma、160 万投稿: 5 個でリーチ +2%、6 個以上で低下）。流入元別の閲覧数は API で取れない（推測）。自投稿の使用タグを保存し、タグ組み合わせ別のリーチ・非フォロワー比率を事後集計するのが現実的。キャプションのキーワード・トピック分類の方が投資価値が高い。
- **投稿時間・頻度**: online_followers（直近 30 日）を週 1 回保存して曜日×時間の長期平均を自前で構築し、自投稿の初速と照合する。
- **フォロワー属性とコンテンツの整合性**: 想定ターゲットと実フォロワーのズレを確認。follower_type 内訳で投稿ごとの非フォロワー比率を出し、テーマ別に「新規向け／既存向け」を可視化する。
- **競合・ベンチマーク**: Business Discovery の日次スナップショット（フォロワー数、投稿数、投稿別 like / comments）からフォロワーベース ER・成長率・投稿頻度を比較。いいね非表示アカウントの扱いは未確認。
- **コメント・DM の定性分析**: コメントは API で取得可（ストーリーズ返信は日本では 0）。LLM で「質問／称賛／苦情／スパム」に分類し質問をクラスタ化するのが自作の現実解。DM は Messaging API と Webhook が必要。
- **キャンペーン／UGC**: タグ付け投稿と mentioned_media は投稿者が分かる。ハッシュタグ経由は投稿者不明。ストーリーズでのメンションは API 非対応。

---

## 6. 自作ツールの要件候補（要件定義への入力）

以下は調査結果から導いた **候補** であり、優先度は仮説。要件定義で取捨選択する。

### 6.1 前提の選択肢

| 論点 | 選択肢 | 影響 |
|---|---|---|
| 対象アカウント | (a) 自分のプロアカウント 1 つ／(b) 自分が管理する複数／(c) 他者（顧客）のアカウント | (a)(b) は App Review 不要。(c) は Advanced Access＋ビジネス認証が必要 |
| API 系統 | Facebook Login 系（ページ必須）／Instagram Login 系（ページ不要） | 競合分析・ハッシュタグ検索・ストーリーズ Webhook・タグ付け投稿は Facebook Login 系のみ |
| 対象アカウントの規模 | フォロワー 100 人未満か以上か | 100 人未満だと属性・follows_and_unfollows・online_followers が取れず、BUC のレート枠も小さい |
| 過去データ | 接続時に遡れるのは日次 90 日、メディア累計値 2 年 | それ以前は取得不能。DYI エクスポートの手動取り込みで補うか |

### 6.2 機能要件候補

**Must（MVP）**

| ID | 要件 | 根拠 |
|---|---|---|
| F-01 | Meta 公式 API によるプロアカウント接続（OAuth）、長期トークンの自動更新（50〜55 日周期）、失効時の再認証導線 | 3.4、5.4 の落とし穴 |
| F-02 | アカウント日次スナップショットの蓄積: followers_count / follows_count / media_count、アカウント日次インサイト全指標と breakdown（media_product_type、follow_type、follower_type、contact_button_type） | 90 日で消える。自作の最大の価値 |
| F-03 | 48 時間遅延対策として直近 2〜3 日分を再取得して上書き | 3.4 |
| F-04 | メディア一覧の同期と、接続時の過去メディア累計値バックフィル | 「接続した日以降しか無い」不満の解消 |
| F-05 | 投稿別スナップショット: 投稿後 1h / 6h / 24h / 48h / 7d / 14d / 28d、以後週次。差分から初速と成長曲線を算出 | 累計値しか返らない API 制約への対策。国内の初速分析 |
| F-06 | ストーリーズの 24 時間以内ポーリング（4〜6 時間ごと）と期限直前の確定値保存。Facebook Login 系なら story_insights Webhook も併用 | 24 時間で消滅 |
| F-07 | 派生 KPI の計算と定義の明示: ER（リーチベース／フォロワーベース）、いいね率、保存率、シェア率、プロフィール遷移率、フォロー転換率、フォロワー外リーチ比率、ホーム率（近似）、リール維持率・スキップ率、ストーリーズ離脱率・完了率 | 4.4、4.5 |
| F-08 | 投稿の属性管理: フォーマット自動判定、手動タグ（テーマ／CTA／キャンペーン）、コラボ・Trial・ブースト・リポスト・AI 生成のフラグと集計除外 | 5.4 |
| F-09 | 概要ダッシュボード: KPI タイル＋前期間比、日次時系列（移動平均）、任意期間 vs 任意期間の比較 | 5.3 |
| F-10 | 投稿一覧（サムネイル付き、派生 KPI でソート・フィルタ）と投稿詳細（成長曲線、ファネル、同フォーマット中央値比較） | 5.3 |
| F-11 | 月次レポートの自動生成（5.2 の構成）。出力形式は要決定（HTML / PDF / Markdown / CSV。国内需要は PowerPoint / Excel） | 5.2 |
| F-12 | 指標変更への耐性: metric 名を文字列で保持、API バージョンと取得時刻を記録、生 JSON を保存、impressions / views の境界をレポートとグラフに注記 | 3.5 |

**Should**

| ID | 要件 |
|---|---|
| F-13 | オーディエンス属性（follower_demographics / engaged_audience_demographics）の週次スナップショットと推移 |
| F-14 | online_followers の週次保存と曜日×時間ヒートマップ、自投稿の初速との照合による最適投稿時間 |
| F-15 | 競合の公開データ日次スナップショット（Business Discovery）とフォロワーベース ER・成長率・投稿頻度の並列比較 |
| F-16 | 異常検知とアラート: 固定閾値＋連続区間ルール（フォロワー急減、フォロワー外リーチ比率の急落、バズ検知）。Slack / メール通知 |
| F-17 | 自投稿で使ったハッシュタグの保存とタグ組み合わせ別集計、キャプションのキーワード集計 |
| F-18 | コメントの収集・保存（削除・非表示で消えるため） |
| F-19 | 複数アカウントの横断ビュー |
| F-20 | DYI エクスポート（フォロワー一覧 JSON）の手動インポート |
| F-21 | サムネイル画像の自前保存（URL 期限切れ対策） |

**Could**

| ID | 要件 |
|---|---|
| F-22 | AI 機能: 月次レポートの自然言語要約、キャプション・コメントのトピック分類と感情分類、画像のタグ付け（人物／商品／テキスト量）、投稿属性×成果の要因分析 |
| F-23 | Hashtag Search API による指定タグの投稿収集（30 タグ／7 日の枠内） |
| F-24 | UGC・メンション・タグ付け投稿の収集（Facebook Login 系） |
| F-25 | Threads API との連携 |
| F-26 | 広告データ（Marketing API）との統合、オーガニック／広告の分離表示 |
| F-27 | UTM 連携による送客・CV の計測 |
| F-28 | BI 連携（Looker Studio / スプレッドシートへのエクスポート） |

**Won't（やらないこと）**

- スクレイピング、非公式 API、パスワード預かり、自動いいね・自動フォロー（規約違反・凍結リスク）
- API で取れないデータ（他者のフォロワー一覧・保存数・リーチ、流入元別閲覧数）の推定表示
- 投稿予約・公開機能（分析ツールのスコープ外。必要になれば Content Publishing API で別途）

### 6.3 データ要件（日次で蓄積すべきもの）

| 優先 | データ | 理由 |
|---|---|---|
| ★★★ | 自アカウントの followers_count / follows_count / media_count | 現在値しか返らない |
| ★★★ | アカウント日次インサイト＋breakdown 別値 | 90 日で消える |
| ★★★ | ストーリーズのメディア情報とインサイト | 24 時間で消える |
| ★★☆ | 属性（age / gender / city / country、this_week / this_month） | 現在のスナップショットのみ |
| ★★☆ | online_followers | 直近 30 日のみ |
| ★★☆ | 各投稿の like_count / comments_count / view_count / saved_count / shares_count / reposts_count とメディアインサイトの日次（投稿直後は時間別）スナップショット | 累計値のみで時系列が残らない |
| ★★☆ | 競合の followers_count / media_count | 現在値のみ |
| ★☆☆ | 競合の各投稿の like_count / comments_count / view_count | 推移を見るなら差分が必要 |
| ★☆☆ | Hashtag Search の結果、コメント本文 | recent_media は 24 時間分、コメントは削除で消える |
| 手動 | フォロワー／フォロー中一覧（DYI） | API 不可 |

スキーマ上の注意: metric を文字列で持ち API バージョンと取得時刻を併記する、NULL と 0 を区別する、生 JSON を保持する、日本のストーリーズ replies は常に 0 として扱う。

### 6.4 非機能要件候補

| 分類 | 要件 |
|---|---|
| レート制限 | X-Business-Use-Case-Usage / X-App-Usage を監視し、指数バックオフ。画面表示のたびに API を叩かず、スケジュール同期＋キャッシュ（プロフィール 24 時間、インサイト数時間）。失敗リクエストも枠を消費する |
| 認証・秘密情報 | app secret とトークンはサーバー側で管理。読み取り専用スコープを原則とする |
| 規約順守 | Meta Platform Terms（目的外利用禁止、不要データの削除、業界標準のセキュリティ）。他者データの長期保存・第三者提供は慎重に |
| 可観測性 | 同期ジョブの成否、取得件数、遅延、トークン残日数をログ・通知 |
| 保守性 | 指標の改名・廃止に追随できる抽象化。バージョン明示 |
| 可搬性 | 単一運用者・ローカル優先の OSS 例（SQLite → Postgres 差し替え式）が参考になる |

### 6.5 MVP の仮説

含める: F-01〜F-12（接続・トークン、日次蓄積、投稿別スナップショット、ストーリーズ、派生 KPI、タグ、概要ダッシュボード、投稿一覧・詳細、月次レポート、指標変更耐性）。

後回し: 競合ベンチマーク（取得範囲が狭く、まず自アカウントの型を固める）、AI 機能（精度課題）、自動タグ付け、UGC・メンション、統計的な異常検知、広告統合。

---

## 7. 要件定義で決めるべき論点

1. **誰のためのツールか**: 自分 1 アカウントの分析か、複数アカウントの横断か、将来的に他者（顧客）のアカウントも扱うか。App Review の要否と設計規模が変わる。
2. **API 系統**: 競合分析・ハッシュタグ・ストーリーズ Webhook を使うなら Facebook Login 系＋Facebook ページ接続。自アカウントのインサイトだけなら Instagram Login 系で足りる。
3. **競合分析の優先度**: 公開データのみで満足できるか。ネイティブの Competitive Insights（2025-11、ER 非表示）との差別化は ER・保存率の推定と履歴蓄積。
4. **レポートの出力形式**: Web 画面だけでよいか、PowerPoint / Excel / PDF が必要か（国内の報告文化では需要が高い）。
5. **実行環境とデータ保存先**: ローカル常駐か、クラウドのスケジューラか。SQLite / Postgres 等の選定。同期頻度（日次＋投稿直後の時間別）。
6. **UI の形態**: 自前 Web アプリか、スプレッドシート／Looker Studio への出力で済ませるか。
7. **KPI 定義の固定**: ER の分母、ホーム率の近似方法、目安値の採用元（出典・年をラベル表示）。
8. **AI 機能の要否と範囲**: 要約・分類・要因分析のどこまでやるか。LLM の利用コスト。
9. **対象アカウントの規模**: フォロワー 100 人未満のアカウントを扱う場合、属性等が取れない前提で UI を設計する必要がある。
10. **過去データのバックフィル範囲**: 接続時に日次 90 日・メディア 2 年を取り切るか。DYI エクスポートの取り込みをどこまでやるか。
11. **実機検証**: 3.6 の未確認事項（follower_count / online_followers の可否、since〜until の上限、Business Discovery のフィールド等）を要件定義の前後で確認する。

---

## 8. 付録・主要出典

### 付録（詳細レポート、出典 URL 付き）

| ファイル | 内容 |
|---|---|
| `claude-preliminary-research-appendix/01_global-tools.md` | 海外ツール 30 種以上の機能・指標・料金・不満点、Meta API 制約への各社の対応 |
| `claude-preliminary-research-appendix/02_japan-tools.md` | 国内ツール 16 種以上、日本独自 KPI の定義と目安、月次レポートの型、非公式アプリの規約リスク |
| `claude-preliminary-research-appendix/03_meta-api.md` | Meta 公式 API（v25.0）の取得可能メトリクス表、制約、権限、トークン、変更履歴、未確認事項 |
| `claude-preliminary-research-appendix/04_instagram-characteristics.md` | コンテンツ形式別の特性、アルゴリズム、KPI 定義とベンチマーク、他 SNS との違い、AI 動向 |
| `claude-preliminary-research-appendix/05_kpi-frameworks.md` | KPI ツリー、レポート・ダッシュボードの型、分析手法、OSS 実装例と落とし穴 |

### 主要出典（一次情報）

- Instagram Platform 概要・リファレンス: https://developers.facebook.com/docs/instagram-platform/
- Instagram Platform changelog: https://developers.facebook.com/docs/instagram-platform/changelog
- Graph API changelog / versioning: https://developers.facebook.com/docs/graph-api/changelog
- IG User Insights: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights
- IG Media Insights: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights
- Business Discovery: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery.md
- Hashtag Search: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search.md
- Rate limiting: https://developers.facebook.com/docs/graph-api/overview/rate-limiting
- Access levels / App Review: https://developers.facebook.com/docs/graph-api/overview/access-levels
- Meta Platform Terms: https://developers.facebook.com/terms/dfc_platform_terms/
- Basic Display API 廃止: https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api/
- Instagram Ranking Explained（2023-05-31）: https://about.instagram.com/blog/announcements/instagram-ranking-explained
- Mosseri「watch time / likes / sends」（2025-01-22、Social Media Today 経由）: https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/
- Trial Reels: https://creators.instagram.com/blog/instagram-trial-reels
- Your Algorithm: https://about.instagram.com/blog/announcements/reels-algorithm-control
- Reposts / Map / Friends（2025-08）: https://about.fb.com/news/2025/08/new-instagram-features-help-you-connect/

### 主要出典（大手調査）

- Socialinsider Instagram Benchmarks: https://www.socialinsider.io/social-media-benchmarks/instagram
- Socialinsider Stories Benchmarks: https://www.socialinsider.io/social-media-benchmarks/instagram-stories-benchmarks
- Rival IQ 2025: https://www.rivaliq.com/blog/social-media-industry-benchmark-report/
- Rival IQ / Quid 2026: https://www.quid.com/knowledge-hub/resource-library/blog/2026-social-media-industry-benchmark-report
- Dash Social 2026: https://www.dashsocial.com/social-media-benchmarks/instagram
- Buffer 最適投稿時間: https://buffer.com/resources/when-is-the-best-time-to-post-on-instagram/

### 主要出典（国内）

- SAKIYOMI アルゴリズム・4 指標: https://sns-sakiyomi.com/blog/tips/instagram-algorithm/
- SAKIYOMI インサイト（2026-02）: https://sns-sakiyomi.com/blog/function/instagram-insight/
- テテマーチ アルゴリズム解説（2024-06）: https://tetemarche.co.jp/column/instagram_algorithm
- neworder 月次レポート（2026-05）: https://www.neworder.co.jp/2026/05/26/instagram_reporting/
- comnico インサイト解説（2026-09）: https://www.comnico.jp/we-love-social/business-profile-instagram-insight-2
- comnico レポートテンプレ: https://www.comnico.jp/we-love-social/sns_report
- LISKUL 分析ツール 17 選（2026-01）: https://liskul.com/instagram-analysis-104839
- エルグラム 分析ツール 20 選（2025-11）: https://lgram.jp/media/tool/analysis-tools/
- Re:Works 月次レポートの書き方（2026-04）: https://reworks-official.jp/monthly-report-writing/

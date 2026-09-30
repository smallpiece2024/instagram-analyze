# 海外 Instagram 分析ツール調査（research_01）

- 調査日: 2026-09-30
- 調査方法: WebSearch / WebFetch による公式サイト・ヘルプセンター・Meta 開発者ドキュメント・レビューサイト（G2 / Capterra / 第三者レビュー記事）の確認。G2・Capterra・一部ヘルプセンターは直接取得が拒否（403）されたため、検索結果スニペットおよび第三者記事経由の情報を含む。
- 注意: 価格は 2025〜2026 年時点の公開情報。年払い/月払い・通貨・時期によって差があり、第三者記事間で数値が食い違うものは併記した。確認できなかった事項は「未確認」、推測は「推測」と明記する。

---

## 0. 前提: Meta（Instagram）API と公式インサイトの 2025〜2026 年の変更

各ツールの機能・指標は Meta Graph API（Instagram API with Facebook Login / with Instagram Login）の制約に強く依存するため、先に整理する。

### 0.1 指標の廃止・新設タイムライン

| 日付 | 内容 | 出典 |
|---|---|---|
| 2025-01-08（v21 以降） | プロフィール指標 `profile_views`, `website_clicks`, `email_contacts`, `phone_call_clicks`, `text_message_clicks`, `get_directions_clicks` を廃止。メディア指標 `video_views`（Reels 以外）を廃止 | Emplifi Docs (2025) https://docs.emplifi.io/platform/latest/home/instagram-media-and-profile-insights-metrics-depre |
| 2025-01-21 | `views` 指標を新設（メディア/アカウント）。`impressions`, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count` を v22 以降で廃止、全バージョンで 2025-04-21 に停止。Insights API が Instagram Login でも利用可能に | Meta Changelog https://developers.facebook.com/documentation/instagram-platform/changelog |
| 2025-12-03 | `reels_skip_rate`（メディア）、`reposts`（メディア/ユーザー）、`crossposted_views`, `facebook_views`（FB クロスポスト Reels）を追加 | 同上 |
| 2026-04-22 | IG Media に `reposts_count`, `saved_count`, `shares_count` フィールドと `total_like_count`, `total_comments_count`, `total_views_count` を追加。`facebook_views` を Feed/Reels/Stories に拡張 | 同上 |
| 2026-06-22 | Stories に `link_clicks` 指標を追加（Facebook Login 必須） | 同上 |

Meta が views に統一した理由は「Facebook と Instagram で全コンテンツ形式に共通の配信指標を作る」ため。views は同一人物の再視聴（リプレイ）も含む（Social Media Today 2025 https://www.socialmediatoday.com/news/meta-deprecates-impressions-in-favor-of-views-api/757958/）。

### 0.2 現在（2026-09 時点）取得可能な主な指標

- アカウント（`/{ig-user-id}/insights`）: `accounts_engaged`, `comments`, `likes`, `shares`, `saves`, `replies`（Stories 返信）, `reposts`, `total_interactions`（ブースト含む）, `reach`（`media_product_type` / `follow_type` 別内訳）, `views`（`follower_type` / `media_product_type` 別内訳、"in development"）, `follows_and_unfollows`（100 フォロワー以上）, `profile_links_taps`（`contact_button_type` 別内訳）, `follower_demographics` / `engaged_audience_demographics` / `reached_audience_demographics`（age, city, country, gender。100 フォロワー以上・上位 45 件のみ）。`impressions` は廃止。データ遅延は最大 48 時間。（Meta Docs https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights）
- メディア（`/{ig-media-id}/insights`）: Feed/Carousel: `comments, likes, shares, saved, reposts, reach, views, facebook_views, profile_visits, profile_activity（BIO_LINK_CLICKED/CALL/DIRECTION/EMAIL/OTHER/TEXT 内訳）, follows, total_interactions`。Reels: 上記 + `ig_reels_avg_watch_time, ig_reels_video_view_total_time, reels_skip_rate, crossposted_views`。Stories: `replies, shares, reposts, navigation（SWIPE_FORWARD/TAP_BACK/TAP_EXIT/TAP_FORWARD）, link_clicks, reach, views, profile_visits, profile_activity, follows, total_interactions`。Stories のインサイトは 24 時間のみ、視聴者 5 人未満はエラー、EU・日本ユーザーの Stories 返信は 0 を返す。アルバム内メディアは対象外。（Meta Docs https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights）

### 0.3 その他の制約

- レート制限: ユーザー当たり 200 リクエスト/時（elfsight 2026 https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/）。
- データ保持: 指標データは最大 2 年。メディア endpoint は直近 10,000 件まで。日付境界は UTC-7 で判定される模様。コラボ投稿のデータは作成者のみ取得可（Supermetrics Docs https://docs.supermetrics.com/docs/good-to-know-about-instagram-insights）。プロ（ビジネス/クリエイター）アカウントへ切替以前のデータは取得不可。
- ハッシュタグ検索（`ig_hashtag_search`）: ビジネスアカウント当たり 7 日間ローリングで 30 ユニークハッシュタグまで。Stories のハッシュタグ・絵文字は非対応。取得メディアの投稿者は権限がない限り "Unknown User"。過去分の遡及取得は不可（Emplifi Docs https://docs.emplifi.io/platform/latest/home/instagram-hashtag-limitation-faq、Meta Docs）。
- 競合（他社アカウント）データ: Business Discovery で `followers_count, media_count, biography, website, media{like_count, comments_count, view_count, ...}` のみ取得可。インサイト（reach/views/saves 等）は不可。年齢制限アカウントは返らない（Meta Docs https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery）。

### 0.4 Instagram 公式インサイト / Meta Business Suite / Edits

- アプリ内 Insights: 2026-04 に「Overview / Engagement / Audience」の 3 タブ構成へ再編。Overview は views, reach, profile visits, follows。Reels 向けに skip rate（3 秒以内離脱率。旧 view rate を置換）、share rate、views over time、retention chart を追加。コラボ投稿・トライアル Reels・クロスポスト・ブースト投稿は当初非対応（inro.social 2026 https://www.inro.social/blog/instagram-insights-update-2025、FrameOS 2026 https://frameos.studio/blog/how-to-read-instagram-insights）。プロフィール系データはアプリ内で過去 90 日まで（Minter.io Blog 更新 2026-05 https://minter.io/blog/how-to-access-historical-insights-data-for-instagram/）。
- Meta Business Suite: デスクトップで Insights 閲覧・CSV エクスポート（Overview / Content / Audience。1 回のエクスポートは最大 90 日）（Poststeady 2026 https://www.poststeady.com/resources/export-instagram-insights-to-csv、GSD Solutions 2026 https://gsdsolutionsinc.com/how-to-download-content-analytics-from-meta-business-suite-ig-and-fb-updated-2026/）。
- Creator Studio は 2023-03 に終了し Meta Business Suite へ統合（Meta Help https://www.facebook.com/business/help/825637908842087）。2026-06-24 に Facebook 向けの AI 搭載「Creator Studio」コンパニオンが限定テストとして発表（sociality.io 2026 https://sociality.io/blog/facebook-creator-studio/、詳細未確認）。
- Edits アプリ: 2026 年に「Shareable Insights」として Reels の views / likes / comments / shares / saves とオーディエンス情報を PDF 出力（メディアキット用途）。Insights 上で最大 3 本の Reels を views / watch time / follows / interactions で並列比較可能（HeyOrca 2026 https://www.heyorca.com/blog/instagram-social-news、embedsocial 2026 https://embedsocial.com/blog/new-instagram-features-2026/）。

---

## 1. ツール別調査

凡例（ターゲット）: 個人=個人クリエイター、SMB=中小企業、ENT=大企業・代理店、INF=インフルエンサーマーケ。

### A. 総合 SNS 管理ツール（投稿＋分析）

#### Sprout Social
- ターゲット: SMB 上位〜ENT。シート課金。
- 主要機能: Instagram Business Profiles レポート、Competitors レポート、Profiles / Group / Tag / Team レポート、Stories 指標、ハッシュタグ分析（自社ブランドタグ vs 業界タグ比較）、トップコメンター（影響力のあるフォロワー）抽出、Optimal Send Times、Premium Analytics（カスタムダッシュボード、フィルタ、共有リンク、"Analyze by AI Assist" によるウィジェット単位の要約）、Listening は別売アドオン（Sprout 公式 2026 https://sproutsocial.com/features/instagram-analytics/、https://sproutsocial.com/features/premium-analytics/）。
- 指標: engagement rate (per impression) = エンゲージメント ÷ impressions（2025 年以降は views）、engagement rate (per follower)、engagements = likes + comments + saves + Stories 返信 + プロフィールリンククリック、video views、saved、reach、views。2025-11 の記事で Instagram Business Profiles レポートは impressions の代わりに views を表示すると説明（Sprout 2025-11-24 https://sproutsocial.com/insights/instagram-impressions/、https://sproutsocial.com/insights/instagram-engagement-rate/）。
- データ取得: Meta Graph API（Meta Business Partner）。競合レポートは公開データ（Business Discovery 相当）と推測。
- 料金（2026、年払い/シート/月）: Essentials $79（月払い $99）、Standard $199、Professional $299、Advanced $399、Enterprise 要問合せ。Premium Analytics は Standard 以上のアドオン（価格非公開）（https://sproutsocial.com/pricing/）。
- 差別化: 大量の指標とレポートテンプレート、AI 要約、Listening・Employee Advocacy 等の統合。
- 不満点（G2 経由）: シート課金＋アドオンで高額（Professional 10 人で年 $35,000 超）、Listening と Premium Analytics が別売、小規模事業者には過剰（socialchamp / sociality.io 2026 https://sociality.io/blog/sprout-social-alternatives/、G2 https://www.g2.com/products/sprout-social/reviews）。

#### Hootsuite
- ターゲット: SMB〜ENT。ユーザー課金。2026 年に「Social OS」として再編（Perch 等の名称に変更）。
- 主要機能: 8 ネットワークの分析、Best Time to Publish（直近 30 日の自社データから、Extend Reach / Build Awareness / Increase Engagement / Drive Traffic の 4 目標別に曜日×時間ヒートマップ表示）、競合分析（自社 1 アカウント vs 最大 20 競合。平均投稿文字数、投稿当たりハッシュタグ数、いいね/コメント別トップ投稿、競合の人気ハッシュタグ）、業界ベンチマーク（成長率・ER・投稿頻度を業界平均と比較）、カスタムレポート（Professional 以上）、90 日先のトレンド予測、会話型 AI「Wisdom」、Lumen by Talkwalker による Listening（Hootsuite Help https://help.hootsuite.com/s/article/best-times?language=en_US、https://help.hootsuite.com/s/article/competitive-analysis?language=en_US、https://www.hootsuite.com/plans）。
- 指標: reach, views（旧 impressions）, engagement rate, followers online, link clicks 等。ネットワークにより計算元が異なる（Facebook は Post views / Post engagement rate 等）。views 移行の具体的なヘルプ記事は未確認。
- データ取得: Meta Graph API。Instagram 連携に個人の Facebook アカウントが必要な点への不満あり。
- 料金（2026、年払い/ユーザー/月）: Standard $99（10 アカウント）、Professional $199（無制限プロフィール、カスタムレポート）、Advanced $399、Enterprise 要問合せ（https://www.hootsuite.com/plans）。第三者記事には Standard $199（年払い）/$249（月払い）と記すものもあり、時期によるプラン改定と思われる（ToolsBrief 2026 https://toolsbrief.org/hootsuite-review-2026/。未確認）。
- 不満点: 2023 年以降無料プラン廃止と値上げ、UI が煩雑、上位プランに分析機能が集中、投稿エラー・接続不良のバグ、サポート品質（socialchamp 2026 https://www.socialchamp.com/blog/hootsuite-reviews/、G2 https://www.g2.com/products/hootsuite/reviews）。

#### Later
- ターゲット: 個人クリエイター、SMB、インフルエンサー（ビジュアルプランナー由来）。
- 主要機能: 投稿パフォーマンス（ER、views/impressions、likes、comments、saves のランキング）、Reels 分析、Stories 分析（views、reach、completion rate、replies。最大 3 か月）、オーディエンス属性（年齢・性別・都市/国・言語）、フォロワー増減、ハッシュタグ分析（有料）、Best Time to Post（自社オーディエンスの反応から上位 7 つの投稿時間を算出）、Link in Bio のクリック/CTR/売上、AI「Future Insights」（トレンド予兆）。デスクトップのみ（https://later.com/instagram-analytics/、Later Blog 2026 https://later.com/blog/ai-social-media-management/）。
- 指標定義: engagement rate = (Likes + Comments + Saves + Shares) ÷ Reach × 100（リーチ基準）（Later Blog 2026-06-25 https://later.com/blog/instagram-engagement-rate/）。
- データ取得: Meta Graph API。「API はスワイプアップ、プロフィールクリック、スタンプタップを含まない」「100 フォロワー未満は属性データが限定」と明記。Instagram Insights と数値が異なる理由のヘルプ記事あり（https://help.later.com/hc/en-us/articles/1500007689821 、本文は取得不可）。
- 料金（2026、年払い/月）: Starter $18.75（1 Social Set、分析履歴 3 か月）、Growth $37.50（2 Set、1 年）、Scale $82.50（6 Set、2 年、カスタム分析、Meta 広告分析、競合ベンチマーク、Brand Health、メンション）（https://later.com/pricing/）。
- 不満点（Capterra/Trustpilot）: 他ツールと比べ分析が浅い、複数アカウント管理が煩雑、更新・解約時の課金トラブル（Capterra https://www.capterra.com/p/152254/Later/reviews/、startupowl 2026 https://startupowl.com/reviews/later）。

#### Buffer
- ターゲット: 個人〜小規模チーム。チャンネル課金。
- 主要機能: Insights（単一チャンネル / 全チャンネル）、AI Takeaways（自動要約）、タグ（キャンペーン）別分析、Essentials 以上でカスタム日付範囲・カスタム指標セット・ブランド付きレポート出力、30 日超の分析履歴、Instagram のファーストコメント予約（Buffer Help https://support.buffer.com/article/595-features-available-on-each-buffer-plan）。Instagram 固有指標の詳細ページ（buffer.com/instagram-analytics）は 404 のため、best time / ハッシュタグ / Stories の指標詳細は未確認。
- データ取得: Meta Graph API。
- 料金（2026）: Free（3 チャンネル、10 件キュー）、Essentials $6/チャンネル/月（年払い $5）、Team $12（年払い $10）。10 チャンネル超で $4、25 超で $3 に逓減（Blotato 2026 https://www.blotato.com/blog/buffer-pricing、Buffer Help）。
- 差別化: 低価格・チャンネル課金、960 万投稿から算出した最適投稿時間の公開調査（Buffer 2026 https://buffer.com/resources/when-is-the-best-time-to-post-on-instagram/）。
- 不満点: 分析はベンチマークや AI 解釈の深さで専門ツールに劣る（複数レビューの共通評価。推測含む）。

#### Metricool
- ターゲット: フリーランス、SMB、代理店。ブランド課金。
- 主要機能・指標（ヘルプセンター記載）: Community（followers, following, total content, follower growth, daily followers）、Demographics（性別・年齢・国/都市。100 フォロワー以上）、Account views / Reach / Impressions（2024 年以前）、Posts（organic/paid reach, organic/paid views, interactions, likes, comments, shares, saves, engagement, new followers、ハッシュタグ別 views/頻度/平均 likes/comments）、Reels（reach, views（2025-04-21 以降リプレイ含む）, watch time, retention %, view rate（3 秒以上）, reposts）、Stories（impressions, 平均 reach, replies, taps back/forward, exits。EU/日本は制限）、Competitors（followers, 投稿数, 平均 likes/comments, ER）、Best times ヒートマップ、Looker Studio コネクタ、PDF/PPT レポート。engagement = organic interactions ÷ organic reach（Metricool Help https://help.metricool.com/en/article/instagram-metrics-12vpkyb/）。
- Impressions→Views 対応: 2025-01-01 以前の投稿は "Impressions"、以降は "Views" と表示し、切替位置にツールチップ。投稿/Reels は Organic Views と Promoted Impressions の列に分割。Stories は Impressions のまま。Looker Studio の "Impressions" フィールドは Views の値を返し、新たに "Organic Views" を追加（2025-04-07 更新）（Metricool Help https://help.metricool.com/instagram-replaces-impressions-with-views-what-you-need-to-know-f6n8j）。
- AI: 2026-08 に分析テーブル上部の「Explore insights」（最良/最悪コンテンツ、パターン、前期間比の変化を質問形式で提示）（Metricool 2026 https://metricool.com/product-updates-august-2026/）。
- 料金（2026、metricool.com/pricing）: Free €0（1 ブランド、データ 30 日、競合 5、投稿 20/月）、Starter €16〜/月（年払い。最大 10 ブランド、履歴無制限、競合 100、PDF/PPT レポート）、Advanced €43〜（最大 50 ブランド、カスタムテンプレート、Looker Studio）、Custom。第三者記事では USD 建て Starter $22 / Advanced $54 / Enterprise $172。追加: X アカウント $10/月（2026-07 以降）、ハッシュタグトラッキング $25/日（efficient.app 2026 https://efficient.app/apps/metricool）。
- 不満点: UI が古い/煩雑、Reels アップロード失敗・二重投稿・アカウント切断のバグ、サポート品質のばらつき（Capterra https://www.capterra.com/p/203702/Metricool/reviews/、socialchamp 2026 https://www.socialchamp.com/blog/metricool-reviews/）。

#### Iconosquare
- ターゲット: SMB、代理店（分析重視）。
- 主要機能: 100 以上の指標、ドラッグ＆ドロップのカスタムダッシュボード、投稿/Reels/Stories 分析（平均 reach/投稿、Stories completion rate、エンゲージメント推移）、オーディエンス属性（年齢・性別・言語・国）、最適投稿時間、ハッシュタグ・メンション分析、競合トラッキング、業界ベンチマーク（follower growth、engagement per reach、投稿頻度、Stories completion rate）、ラベル/アルバムによるキャンペーン集計、PDF/XLS 出力、定期メールレポート、Looker Studio 連携（2026）、AI アナリスト「Uma」、MCP 連携（BloggingWizard 2026-02 https://bloggingwizard.com/iconosquare-review/、iconosquare.com/pricing）。
- 指標定義: ER の公式は公式ページから未確認（第三者記事は「engagement per reach」「engagement rate per post」を挙げる）。
- データ取得: Meta Graph API。競合・ベンチマークは公開データと推測。
- 料金（2026、年払い EUR/月、iconosquare.com/pricing）: Free（2 プロフィール、履歴 1 か月）、Starter €15（3 プロフィール、1 年）、Launch €33（4、1 年、定期レポート）、Scale €69（4 プロフィール、3 ユーザー、2 年、競合・業界ベンチマーク）、Custom €119〜（ホワイトラベル）。第三者記事には旧体系（Single $59 / Teams $99）や「Pro $59 / Advanced $99」の記載もある（未確認）。
- 不満点: ユーザー課金で増員に弱い、トークン失効による再接続の頻発、Meta ネイティブとの数値ずれ、Top Followers の不正確さ（過去）、指標が多く学習コストが高い、X 対応の変遷（2025-08 に X を削除との記事と 2026 に X 予約投稿を追加との記事が併存。未確認）（Hack'celeration 2026 https://hackceleration.com/labs/review/iconosquare、Capterra https://www.capterra.com/p/166110/Iconosquare/reviews/）。

#### Agorapulse
- ターゲット: SMB〜中規模チーム、代理店。ユーザー課金。
- 主要機能: プロフィール基本レポート、Report Studio（カスタムレポート）、Social ROI（UTM 自動付与＋Google Analytics 連携で投稿別の流入/CV）、競合ベンチマーク・広告レポート（Advanced 以上）、AI 返信/提案（https://www.agorapulse.com/pricing/、Agorapulse 2025 https://www.agorapulse.com/blog/agorapulse-news/new-agorapulse-features-2025/）。
- 料金（2026、ユーザー/月）: Standard $79（年払い）/$99（月払い）、データ保持 6 か月。Professional $119/$149、12 か月。Advanced $149/$199、24 か月、競合ベンチマーク・ROI・広告レポート。Custom。
- 不満点: 2025-04 頃から数か月続いた Instagram Stories レポートのバグとその間の課金継続、価格が高い、Stories 投稿や複数画像投稿の制限（G2 https://www.g2.com/products/agorapulse/reviews?qs=pros-and-cons、postplanify 2026 https://postplanify.com/agorapulse-reviews）。

#### Sendible
- ターゲット: 代理店・フランチャイズ（全プランでユーザー無制限）。
- 主要機能: 200 以上の分析モジュール、8 種のプリセットレポート（Engagement レポート: オーディエンス成長、最適投稿時間、engaged users、トップコンテンツ）、カスタムレポートビルダー（Premium 以上）、ブランド付きレポート、自動メール送付、共有リンク、キャンペーン/コンテンツピラー別集計、Google Analytics 連携、ホワイトラベル（Elite 以上のアドオン）（https://www.sendible.com/pricing）。
- 料金（2026、月額）: Core $9（6 プロフィール）、Plus $29（18）、Premium $79（42）、Elite $179（90）、Enterprise 要問合せ。第三者記事には旧体系（Creator $29 / Traction $89 / Scale $199 / Advanced $299）もある（socialchamp https://www.socialchamp.com/blog/sendible-pricing/）。
- 不満点: 代理店特化で個人には過剰（Sotrender 記事 2025-12）。その他は未確認。

#### Planoly
- ターゲット: 個人クリエイター、小規模チーム（ビジュアルグリッド計画が中心）。
- 主要機能: 分析ダッシュボード（エンゲージメント、フォロワー増減、投稿パフォーマンス、best time）と第三者記事は記すが、公式料金ページには分析機能の内訳記載なし（未確認）（SelectHub 2026 https://www.selecthub.com/p/social-media-management-software-tools/planoly/、https://www.planoly.com/pricing）。
- 料金（2026）: Starter $14/月、Growth $24、Pro $47（公式ページ）。第三者記事は $16〜$54 とし、$13→$16 への値上げに不満（socialchamp https://www.socialchamp.com/blog/planoly-pricing/）。
- 不満点: 自動投稿の失敗、解約後の課金、アップロード上限。

#### Tailwind
- ターゲット: Pinterest＋Instagram の小規模事業者。
- 料金（2026）: Free（5 投稿/月、1 アカウント、基本分析）、Pro $14.99、Advanced $24.99、Max $49.99（https://www.tailwindapp.com/pricing）。
- Instagram 分析の詳細: 公式サイトは Pinterest 中心で、Instagram 分析の指標一覧は未確認。Google Analytics 連携あり（SoftwareAdvice 2026 https://www.softwareadvice.com/marketing/tailwind-profile/）。

#### Flick
- ターゲット: Instagram 中心の個人クリエイター・小規模ブランド（ハッシュタグ調査が起点）。
- 主要機能: ハッシュタグ検索・コレクション（競争度 低/中/高、20 言語以上）、投稿単位のハッシュタグトラッキング（どのタグでランクインしたか、順位、表示継続時間）、Instagram のみの分析（アカウント概要、Feed/Stories/Reels、オーディエンス活動時間、ハッシュタグ成果）、最適投稿時間、AI アシスタント、予約投稿（https://www.flick.social/learn/pricing、topsocialtools 2026 https://www.topsocialtools.com/insights/flick/）。
- データ取得: Meta Graph API と推測。ハッシュタグ順位追跡の取得手段は未確認（API のハッシュタグ制約上、公開データ取得を併用している可能性がある。推測）。
- 料金（2026）: 公式（GBP 年払い）Solo £11/月（4 プロフィール、30 投稿、30 追跡投稿）、Pro £24（8 プロフィール、無制限）、Agency £55（20 プロフィール、5 ユーザー）。USD 表記の記事では Solo $14、Pro $30（年払い $24）、Agency $68（$55）。7 日間トライアル。
- 不満点: Solo の 30 投稿上限。

### B. 分析・ベンチマーク特化ツール

#### Socialinsider
- ターゲット: 代理店・ブランド（投稿機能なし、分析専業）。
- 主要機能・指標: プロフィール（followers, growth rate, ER（reach 基準 / followers 基準）, total engagements, reach/impressions, 属性）、投稿別（reactions, comments, shares, saves、フォーマット別比較: Reels/カルーセル/画像）、Reels（views 等）、Stories（views, completion, tap forward/exit/reply）、最適投稿時間、競合の並列比較・推移、ハッシュタグ、業界ベンチマーク（毎年ベンチマークレポートを公開）、AI（自社＋競合＋ベンチマークを読んで文章で回答）、AI によるコンテンツ分類とピラー別集計、CSV/PDF/PPT/XLS 出力、ブランド付き・定期配信、MCP コネクタ（https://www.socialinsider.io/instagram-analytics、https://www.socialinsider.io/pricing）。
- 指標定義: ER by followers = (Likes + Comments + Saves + Shares) ÷ Followers × 100、ER by reach = 同 ÷ Reach × 100（Socialinsider Blog 2026-03 https://www.socialinsider.io/blog/instagram-metrics/）。
- データ取得: 自社は Meta API、競合は公開データ。
- 料金（2026、月額）: Adapt $82（20 アカウント、履歴 3 か月、1 ユーザー）、Optimize $124（30、6 か月、2 ユーザー）、Predict $199（40、12 か月、5 ユーザー）、Enterprise。追加: プロフィール $6/月、メンバー $15/月、API $100/月、Looker Studio $100/月。
- 不満点（G2）: 競合プロフィールを 1 件ずつ登録する必要がある（Rival IQ は自動）（G2 https://www.g2.com/products/socialinsider/reviews）。

#### Rival IQ
- ターゲット: ブランド・代理店の競合インテリジェンス。
- 主要機能: 「Landscape」（競合・同業アカウントのカスタム集合）でのベンチマーク（ER、投稿頻度、フォロワー成長、コンテンツタイプ別）、投稿レベルの内容分析、ハッシュタグ分析、Listening 保存検索、メールアラート、定期レポート、Private data（自社 Instagram Insights 連携、Engage 以上）、複数ハンドル集約・推定 impressions・API（Engage Pro）、Looker Studio コネクタ、年次ベンチマークレポート（https://www.rivaliq.com/pricing/、coldiq 2026 https://coldiq.com/tools/rival-iq）。
- 指標定義: ER = (likes + comments + shares) ÷ followers、中央値で報告。2026 年版の全業種 Instagram 中央値は 0.30〜0.36%（記事により差）（Rival IQ https://www.rivaliq.com/blog/good-engagement-rate-instagram/、Quid 2026 https://www.quid.com/knowledge-hub/resource-library/blog/2026-social-media-industry-benchmark-report）。
- データ取得: 競合は公開データ、自社は Meta API（Private data）。
- 料金（2026、月額）: Drive $239（10 社、履歴 6 か月、1 ユーザー、更新 12 時間毎）、Engage $349（20 社、12 か月、2 ユーザー、6 時間毎）、Engage Pro $559（40 社、24 か月、5 ユーザー、3 時間毎、API）。年払い 15% 引。
- 不満点: 入口価格が高い（G2 4.5、Socialinsider との比較で価格面が劣後）。

#### quintly（Facelift 傘下）
- ターゲット: 代理店・ENT。
- 主要機能: 数百のカスタマイズ可能な指標（旧記載では 250 以上）、独自クエリ言語によるカスタム指標、カスタムダッシュボード、競合ベンチマーク、Instagram Insights（プライベートデータ）連携、レポート自動化、API（Facelift Data Studio 経由）（Cuspera 2026 https://www.cuspera.com/products/quintly-social-media-analytics-x-1195）。
- 料金: 公式ページは取得不可。第三者リストでは $120〜$479/月＋見積（SoftwareSuggest / SpotSaaS 2026。未確認）。
- 不満点: 未確認。

#### Minter.io
- ターゲット: 1〜数プロフィールを深く分析したいブランド・代理店（プロフィール課金）。
- 主要機能: オーディエンスインサイト、投稿/Stories/Reels 成果、プロフィール活動、メンション、コラボ、広告分析、ハッシュタグモニタリング、競合分析、CSV/XLS/PDF/PPTX 出力、定期・ブランド付きレポート、Slack 配信、AI チャット、MCP サーバー、毎時更新（Gold 以上）。Stories データは API の 2 年制約を超えて無期限保持、ハッシュタグは過去 1 か月＋トップ 3,000 投稿（https://minter.io/pricing、Minter.io Blog 2026-05）。
- 料金（2026、プロフィール/月）: Silver $9、Gold $19、Platinum $39（広告分析、ハッシュタグ 1、競合 3）、Pro 5+ $180/月（5 プロフィール以上、API）。14 日トライアル。
- 不満点: プロフィール数に比例して高くなる、投稿機能なし（socialrails 2026 https://socialrails.com/blog/minter-io-review）。

#### Not Just Analytics
- ターゲット: 個人クリエイター、SMB、小規模代理店（イタリア発）。
- 主要機能: 任意の公開ハンドルをログイン不要で分析（ER、平均 likes/comments/video views、フォロワー推移、不自然な急増検知）、競合が使うハッシュタグ、競合のスポンサード投稿・コラボ投稿の発見、ニッチスコア、オーディエンス分析、Facebook 連携によるビジネスインサイト（最大 12 か月）、PDF レポート、投稿タイミング・内容のアドバイス（https://www.notjustanalytics.com/、GetApp 2026 https://www.getapp.com/marketing-software/a/not-just-analytics/）。
- データ取得: 「公式 Instagram API の利用を認可されており、パスワードは要求しない」と明記。公開プロフィールの分析は Business Discovery 相当の公開データと推測。
- 料金（2026、公式）: Light €7.50/月（1 プロフィール、ビジネスデータ 1 か月）、Standard €24.17（5 プロフィール、3 か月、ロゴ付き自動レポート）、Pro €74.17（20 プロフィール、12 か月、顧客プロフィール接続）。第三者記事の Creator €14 / Pro €29 は旧体系と思われる（https://public.notjustanalytics.com/pricing）。
- 不満点: 未確認。

#### Keyhole（Muck Rack 傘下）
- ターゲット: PR・マーケチームのキャンペーン/ハッシュタグ追跡。2024 年に Muck Rack が買収し、2026-09 時点で keyhole.co/instagram-analytics は muckrack.com のソーシャルリスニングページへリダイレクト。
- 主要機能: ハッシュタグ/キーワードトラッカー（投稿数・ユーザー数・エンゲージメント・reach をリアルタイム）、センチメント、インフルエンサー特定、レポート。プロフィール分析の有無は記事間で矛盾（socialrails は「なし」）（socialrails 2026-03 https://socialrails.com/blog/keyhole-review、Brand24 2026 https://brand24.com/blog/monitor-hashtag-performance/）。
- 料金（2026）: Professional $179/月（3 トラッカー）、Corporate $539（10、API）、Enterprise $999。14 日トライアル、無料プランなし。
- 不満点: 投稿機能なし、履歴約 12 か月、入口価格が高い。

#### Sotrender
- ターゲット: 代理店・ブランド（ポーランド発）。
- 主要機能: 投稿/Reels/Stories 別の詳細、属性、オーガニック＋広告の統合、競合ベンチマーク（Plus 以上）、PDF/PPTX/XLS 自動レポート、センチメント、カスタマーサービス指標（応答率等）、API（Custom）（https://www.sotrender.com/pricing/、Sotrender Blog 2025-12 https://www.sotrender.com/blog/2025/12/instagram-analytics-tools/）。
- 料金（2026）: Essential $80/月（年払い $72。5 プロフィール、履歴 90 日）、Plus $200（$176。15、180 日）、Expert $355（$315。30、1 年、ブランド付き定期レポート）、Custom。
- 不満点: 未確認。

#### Analisa.io
- ターゲット: SMB、代理店、インフルエンサー選定。
- 主要機能: 任意の公開 Instagram/TikTok プロフィール・ハッシュタグの AI 分析、フォロワー属性（年齢・性別・国）、フォロワー真正性監査、インフルエンサーマッピング、タグ付け関係、投稿スケジュール、ジオロケーションマップ、期間指定、PDF/Excel 出力（https://analisa.io/、SaaSworthy 2026 https://www.saasworthy.com/product/analisaio）。
- データ取得: 公開データ（推測: 公開プロフィールのスクレイピング／サンプリング）。
- 料金: 基本分析は無料、有料は約 $48.30/月〜（SaaSworthy）。公式ページは取得不可（未確認）。
- 不満点: 投稿機能なし、Web のみ。

#### Inflact（旧 Ingramer）
- ターゲット: Instagram 成長・自動化を求める個人/SMB。
- 主要機能: 無料の Profile Analyzer（ER、投稿頻度、トップハッシュタグ、興味関心、キャプション意味解析）、競合トラッキング（消える Stories も保存）、インフルエンサー検索、ハッシュタグ生成、予約投稿、チャットボット（https://inflact.com/pricing/、conversiongems https://www.conversiongems.com/tools/inflact-instagram-profile-analyzer）。
- データ取得: 公開データのスクレイピングと自動化（推測）。
- 料金（2026）: Free、Research $34/月、Pro $59/月。年払い 30% 引、$1 の 3 日トライアル。
- 不満点: 利用後にアカウントがフラグ/制限されたとの報告（affmaven 2026 https://affmaven.com/inflact-review/）。Meta 規約上のリスクが高い。

#### Squarelovin
- 状況: 2026 年時点の公式サイトはクリエイター発掘・UGC 収集・アフィリエイトストアフロント等の「コミュニティ＆クリエイターコンテンツプラットフォーム」に転換しており、無料 Instagram 分析ツールとしての提供は確認できない（https://squarelovin.com/）。古い比較記事（HubSpot 等）には「無料 Instagram Insights、有料 €9.90/月〜」の記載が残るが現状は未確認。

### C. エンタープライズ向け（Listening・統合スイート）

#### Brandwatch（Cision 傘下）
- ターゲット: ENT。製品は Consumer Intelligence / Social Media Management（旧 Falcon.io）/ Influence。
- 主要機能: カスタマイズ可能なダッシュボード、チャネル横断のパフォーマンス計測、競合ベンチマーク（競合チャネル分析は 7 年分、消費者データは 12 か月）、1 億以上のソースを対象とする Listening（https://www.brandwatch.com/products/social-media-management/）。
- Impressions→Views 対応（2025-04-10 実施）: plays を views に改名（値は同一）、impressions は 2025-01-01 以降を views で遡及置換（値は増える）、ER 式を (Engagements ÷ Views) × 100 に変更（ER は低下）、2025 年分の旧 impressions は削除、2024 年以前は impressions として保持（Brandwatch Help 2025 https://social-media-management-help.brandwatch.com/en/articles/12767947-deprecation-of-instagram-impressions-plays-and-video-views）。
- 料金: 要問合せ。第三者推定で SMB $800〜1,200/月、G2 ベース年 $12,000〜18,000。「Essentials $108/月」との記載もあるが未確認（Vendr / socialchamp 2026 https://www.socialchamp.com/blog/brandwatch-pricing/）。
- 不満点: Instagram の一部フォーマットや一括予約に難あり（SelectHub 2026）。

#### Emplifi（旧 Socialbakers）
- ターゲット: ENT（約 20,000 ブランド）。課金は「ボリューム（オーディエンス規模・インタラクション量）」ベースで要問合せ。
- 主要機能: Unified Analytics、Listening、Publisher、Community、Influencers & UGC、AI レイヤー「Fuel AI」、グローバル/地域別の業界ベンチマーク、年次ベンチマークレポート公開（https://emplifi.io/、https://emplifi.io/resources/social-media-benchmark-report/）。
- API 対応: 2025-04-20 まで impressions を保持し、以降は views を impressions にマッピング。プロフィールレベルの新指標「Video Views」は 2025-06-06 以降のみ。メディア views の履歴は 2024-07 頃から。1/7/28 日ローリングのプロフィール impressions は代替なしで廃止（3 か月間は閲覧可）。2025-01 廃止分（profile_views 等）は 2025-04 にスイートから削除（Emplifi Docs）。ハッシュタグ制約には「複数のビジネスアカウント接続で 30×N に拡張」「メンション/タグ収集への切替」を案内。
- 不満点: 高額・無料プランなし、ENT 向けで小規模には過剰（thecmo / research.com 2026）。

#### Sprinklr
- ターゲット: ENT。セルフサーブ（旧 Advanced $299/ユーザー/月）は 2026-04-30 に終了し、エンタープライズ見積のみ（Vendr 中央値 約 $129,000/年、最低 $50,000/年）（chatarmin 2026 https://chatarmin.com/en/blog/sprinklr-pricing）。
- 主要機能: カスタムレポート/ダッシュボード、Listening、Unified-CXM。
- API 対応: 投稿レベルで「Instagram Business Post Views」が impressions と reel plays を置換、アカウントレベルで「Instagram Account Daily Views」が impressions を置換。2024-08 以降の views をバックフィル、トレンド系指標はバックフィルなし。旧指標のダッシュボードは動作するが新データは入らない（Sprinklr Help 2025 https://www.sprinklr.com/help/articles/instagram-reporting-changelog/impressions-and-reel-plays-deprecation-and-introduction-of-views-metric/68072c6acbfca249dfba78e1）。
- 不満点（G2）: 複雑さ・学習コスト（Complex Usage 54 件、Learning Curve 48 件）、価格、アドオン依存（G2 https://www.g2.com/products/sprinklr-social/reviews）。

#### Talkwalker（Lumen by Talkwalker、Hootsuite 傘下）
- 2024-04-08 に Hootsuite が買収を発表。現在は「Lumen」として Hootsuite の Listening を担う。1.5 億サイト・30 以上のソーシャルチャネル、Blue Silk AI、画像認識（ロゴ検出）。Instagram の自社アカウント分析は Hootsuite 側が担当（https://www.talkwalker.com/press-release/hootsuite、Merciv 2026 https://www.merciv.com/blog/talkwalker-competitors-alternatives）。
- 料金: 非公開。第三者推定で年 $13,000〜100,000（TrustRadius）。

#### Meltwater
- ターゲット: ENT の PR/マーケ。
- 主要機能: Instagram を含む多チャネルのオーガニック＋広告の統合分析、競合ベンチマーク・シェアオブボイス・センチメント、AI 要約、定期レポート、長期履歴（https://www.meltwater.com/en/products/social-media-analytics）。
- 料金: 要問合せ。小規模で年 $15,000〜30,000（communitytracker 2026 https://www.communitytracker.ai/blog/meltwater-review）。
- 不満点: 更新頻度、すべてがアドオンで見積が不透明（G2）。

#### Dash Social（旧 Dash Hudson）
- ターゲット: ENT ブランド（美容・ファッション・小売等）。
- 主要機能: Entertainment Score（Reels/TikTok の視聴者の「楽しんだ度合い」を測る独自指標）、Vision AI（コンテンツの成果予測・ダッシュボード要約）、TSI（Total Social Impact）、競合インサイト・ベンチマーク（Engage は 3 競合まで）、コンテンツセグメンテーション、カスタムダッシュボード（Advance 以上）、日次/週次/月次の自動レポート、Creator Management / Premium Analytics / Social Listening はアドオン（https://www.dashsocial.com/pricing、https://www.dashsocial.com/features/instagram-insights）。
- 指標: 公開ベンチマークで ER を「followers 基準 0.4%」と「views 基準 1.9%」の 2 種で提示（2026）。
- 料金: 公式ページは非表示。2026-04 の第三者記事が「公式ページ掲載の価格」として Engage $999/月、Advance $1,999、Enterprise $3,499〜を引用（archive.com 2026 https://archive.com/blog/dash-hudson-pricing。現行は未確認）。

### D. インフルエンサー分析ツール

#### HypeAuditor
- ターゲット: INF（ブランド・代理店のインフルエンサー選定）。
- 主要機能・指標: Audience Quality Score（AQS、1〜100。構成要素は engagement rate、quality audience（実在人物の割合。1,500 以上フォロー中の「マスフォロワー」やボットを除外）、フォロワー/フォロー増減パターン、engagement authenticity（ポッド・ギブアウェイ除外））、like-to-comment 比率、likes spread、35 以上の指標、属性、ブランドメンション、推定リーチ・料金、35+ 指標のレポート、無料ツール多数（HypeAuditor Blog https://blog.hypeauditor.com/what-is-audience-quality-score-on-hypeauditor/）。
- データ取得: 公開データ＋ML（50 以上の行動特徴でフォロワーを real/suspicious/bot に分類）。比較記事では「クリエイターのログイン許可も利用」とするが詳細は未確認。
- 料金（2026-03）: Basic 約 $299/月、Pro 約 $499/月（年払い）、Enterprise 見積（flinque 2026 https://www.flinque.com/hypeauditor-pricing/）。
- 不満点: 高額、長期契約（ajogu 2026。未確認）。

#### Modash
- ターゲット: INF。
- 主要機能: 2.5〜3.8 億クリエイターの DB、フェイクフォロワーチェック（フォロワーを real / mass followers / influencers / suspicious / bots の 5 分類し、後 2 者の合計を fake rate）、ER・平均 views をコンテンツ種別（Reels vs Posts）で分解、paid vs organic、ブランドコラボ履歴、EMV、属性（画像認識とサンプリングによる推定。フォロワーリスト非公開の場合は算出不可）、PDF レポート、Shopify 連携の売上計測（https://www.modash.io/pricing、Modash Help https://help.modash.io/en/articles/13715083-understanding-audience-demographics-and-insights）。
- データ取得: クリエイターのログイン不要の公開データのみ。
- 料金（2026）: Essentials $199/月（プロフィール閲覧 300/月）、Performance $499（800/月）、Enterprise $14,700/年〜。
- 不満点: 高額（ainfluencer 2026）。

#### Phlanx
- ターゲット: INF（小規模ブランド）。
- 主要機能: Engagement Calculator（平均 likes＋comments ÷ followers）、監査レポート、インフルエンサーディレクトリ、契約管理、JPG/PDF 出力（https://phlanx.com/engagement-calculator）。
- 料金: SoftwareAdvice は A$25/月の単一プラン、influencer-hero は $49〜100/月と記載し矛盾（未確認）。
- 不満点: 無料で得られる機能に課金、サポート無応答、無料枠の利用制限（SoftwareAdvice https://www.softwareadvice.com/product/479492-Phlanx/）。

### E. Meta 公式（比較基準）
- 無料。Instagram アプリ内 Insights（0.4 参照）、Meta Business Suite（デスクトップ、CSV エクスポート 90 日単位）、Edits（PDF 共有）。競合分析・ハッシュタグ分析・カスタムダッシュボード・長期履歴（90 日超のプロフィール推移）はなく、これらが第三者ツールの存在理由になっている。

---

## 2. まとめ

### 2.1 ほぼ全ツールに共通する「定番機能」
1. アカウント概要: フォロワー数と増減（純増・日次）、reach、views（旧 impressions）、interactions/engagements、ER。
2. 投稿一覧テーブル: サムネイル＋種別（画像/カルーセル/Reels）＋ likes/comments/saves/shares/reach/views/ER でソート。トップ投稿抽出。
3. Reels・Stories 個別分析: Reels は views/reach/watch time/retention、Stories は reach/views/replies/navigation（tap back/forward/exit）/completion rate（Stories は 24 時間制約のため各社が定期取得して保持）。
4. オーディエンス属性: 年齢・性別・国/都市（100 フォロワー以上）。一部は言語。
5. 最適投稿時間: 曜日×時間のヒートマップ（フォロワーのオンライン時間または過去エンゲージメントから算出）。
6. ハッシュタグ分析: 自社投稿で使ったタグ別の成果（views/ER）。
7. 競合比較: 公開データ（フォロワー数、投稿数、平均 likes/comments、ER by followers）の並列比較。
8. レポート出力: PDF/CSV/XLS/PPT、定期メール、代理店向けのロゴ付き（ホワイトラベル）。
9. マルチネットワーク横断ダッシュボードとプラン別データ保持期間（3 か月 / 1 年 / 2 年）。
10. AI 要約（2025〜2026 年に急速に定番化: Sprout「Analyze by AI Assist」、Buffer「AI Takeaways」、Metricool「Explore insights」、Socialinsider AI、Iconosquare「Uma」、Hootsuite「Wisdom」、Dash Social「Vision AI」、Meltwater AI 要約）。

### 2.2 一部のツールだけが持つ「差別化機能」
- 業界ベンチマーク（自社 vs 業界中央値）: Iconosquare、Socialinsider、Rival IQ、Emplifi、Dash Social、Hootsuite。
- 独自スコア: Dash Social の Entertainment Score / TSI、HypeAuditor の AQS、Modash の fake follower rate、Not Just Analytics のニッチスコア。
- カスタム指標定義・クエリ: quintly（独自クエリ言語）、Sprout Premium Analytics のカスタムウィジェット、Iconosquare のドラッグ＆ドロップダッシュボード。
- ハッシュタグ順位トラッキング（投稿がどのタグでどの順位に何時間表示されたか）: Flick。ハッシュタグ/キーワードのキャンペーン追跡: Keyhole。
- 競合のスポンサード投稿・コラボ投稿検出: Not Just Analytics。競合の Stories 保存: Inflact（規約リスク）。
- オーガニック/広告の分離表示: Metricool（Organic Views / Promoted Impressions 列）、Sotrender、Sprout、Rival IQ（FB Ads）。
- ROI 連携（UTM 自動付与＋Google Analytics）: Agorapulse Social ROI、Sendible、Tailwind。Link in Bio の売上計測: Later。
- BI 連携: Looker Studio コネクタ（Metricool Advanced、Socialinsider $100/月、Rival IQ Engage、Iconosquare 2026）。MCP サーバー/コネクタ（Socialinsider、Minter.io Gold 以上、Iconosquare 有料プラン）。
- API 制約を超える保持: Minter.io の Stories 無期限保持、Metricool 有料プランの履歴無制限。
- アラート: Rival IQ のメールアラート、Planoly のトレンドアラート（詳細未確認）。
- コンテンツ分類: Socialinsider の AI ピラー分類、Sprout/Buffer のタグ、Iconosquare のラベル/アルバム、Dash Social のセグメンテーション。
- 更新頻度の差別化: Rival IQ（12h/6h/3h）、Minter.io（毎時）。

### 2.3 自作時に参考にすべき UI/レポート設計パターン
- 画面構成: 公式の 2026 年再編（Overview / Engagement / Audience）と第三者ツールの典型（Overview / Content(Posts・Reels・Stories) / Audience / Competitors / Hashtags / Reports）が収斂している。Overview は KPI タイル（followers, reach, views, interactions, ER）＋前期間比の増減率。
- 期間比較: プリセット（7/30/90 日、3/6/12 か月、カスタム）＋「前の期間と比較」。公式アプリは 90 日、API は 2 年が上限なので、自前で日次スナップショットを蓄積する設計が各ツール共通（履歴長がプラン差別化になっている）。
- グラフ種別: 時系列折れ線（フォロワー・reach・views）、投稿種別別の棒/積み上げ（Feed/Carousel/Reels/Stories の配分と成果）、曜日×時間ヒートマップ（最適投稿時間）、属性の横棒（年齢×性別）と国/都市ランキング、Reels のリテンション曲線とスキップ率（公式 2026 と同じ）、Stories のファネル（reach→completion、exit/next 内訳）。
- 投稿テーブル: サムネイル、種別、公開日時、reach、views、likes、comments、saves、shares、ER（分母を明示）、獲得フォロワー（Metricool の "new followers"、API の `follows`）。
- ER 定義の明示: 分母（followers / reach / views）が各社で異なり、ベンチマーク値が 0.3%（followers）〜1.9%（views）まで変わる。ツール内でどの定義かをツールチップで示し、可能なら切替可能にする（Socialinsider は reach/followers 切替）。
- 指標変更の可視化: Metricool の「2025-01-01 前は Impressions、以降は Views」の境界ツールチップ、Sprinklr の「新旧指標は直接比較しない」注記は、API 変更に耐える UI の実例。
- レポート: 定期配信（日/週/月）、PDF＋CSV、ロゴ差替え、共有リンク、AI による「何が変わったか」の文章要約。

### 2.4 Meta API 制約への各ツールの対応
- Impressions→Views（2025-04-21）: (a) 名称変更＋遡及置換（Brandwatch: 2025-01-01 以降を views で置換し ER 式も views 基準へ、2025 年分の旧 impressions は削除）、(b) 日付で分割表示（Metricool: 境界にツールチップ、Stories は impressions のまま）、(c) 旧値を保持し新指標を並列＋バックフィル（Sprinklr: 2024-08 から views をバックフィル、Emplifi: views を impressions にマッピングし過去分は保持）、(d) レポート名の更新（Sprout: Business Profiles レポートで views 表示、Zoomph: "Projected Impressions"→"Projected Views"）。共通の注意点は「views はリプレイを含むため値が大きくなり、ER が低下する」こと。
- Profile views / website clicks 廃止（2025-01）: アカウントレベルでは `profile_links_taps`（contact_button_type 内訳）、メディアレベルでは `profile_visits` / `profile_activity` で代替。プロフィール訪問数の日次推移は公式アプリでしか見られなくなり、ツール側はアプリ画面の手動転記か、投稿単位の合算で近似している（Emplifi は代替なしで削除）。
- Stories の 24 時間制約: 各社が短周期（毎時等）でポーリングして永続化（Minter.io は無期限保持）。期限切れ後は完全な views が返らないため、Stories だけ impressions 表記を残すツールがある（Metricool、FrameOS 記事）。
- ハッシュタグ 30 件/7 日: Emplifi は複数ビジネスアカウント接続で枠を N 倍、またはメンション/タグ収集へ誘導。Metricool はハッシュタグトラッキングを $25/日の従量課金にして API 枠を管理。Keyhole・Flick 等の広範なハッシュタグ追跡の取得手段は非公開（未確認）。
- 競合データ: 公式には Business Discovery（followers_count、media_count、like_count、comments_count、view_count のみ）。Rival IQ・Socialinsider・Iconosquare・Hootsuite の競合分析は、この範囲（ER by followers、投稿頻度、フォロワー推移の自前蓄積）に収まっている。属性・reach・saves などは競合について取得できない。Inflact・Analisa・HypeAuditor・Modash のような公開データ深掘り型はスクレイピング/サンプリングに依存し、Meta 規約上のリスクとアカウント制限報告がある。
- データ遅延 48 時間・2 年保持・200 req/h: 各ツールは「更新頻度」をプラン差別化にし（Rival IQ 12h/6h/3h）、100 フォロワー未満の属性非表示や EU/日本の Stories 返信ゼロを UI 上で注記している（Metricool、Later）。

### 2.5 自作にあたっての示唆（事実に基づく整理）
- 無料の公式 Insights と差別化しやすいのは「90 日超の履歴蓄積」「期間比較」「競合の公開データ比較」「レポート自動化」「ER 定義の切替」「AI 要約」であり、いずれも API で取得可能な範囲で実装できる。
- 逆に「ハッシュタグ順位追跡」「競合の属性・reach」「プロフィール訪問の日次推移」は API では不可能または制約が強く、既存ツールも代替指標か非公開手段に頼っている。
- 指標名は 2025〜2026 年に大きく変わったため、スキーマは「views 世代」（views、reach、total_interactions、saves、shares、reposts、follows、profile_links_taps、reels_skip_rate、ig_reels_avg_watch_time、navigation、link_clicks）を前提にし、旧 impressions は履歴用に別カラムで残すのが各社の実装に近い。

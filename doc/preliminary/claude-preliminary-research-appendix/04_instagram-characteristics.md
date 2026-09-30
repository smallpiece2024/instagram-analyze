# Instagram の特性と分析ツールが押さえるべき観点（事前調査 04）

調査日: 2026-09-30
目的: Instagram 分析ツールを自作するにあたり、他 SNS と異なる Instagram 固有の特性（形式・アルゴリズム・KPI・API 制約）と、ユースケース別に必要な観点を整理する。

## 0. 情報の信頼度の区分

本書では出典を次の 3 段階で扱う。

- **[公式]** about.instagram.com / creators.instagram.com / about.fb.com / developers.facebook.com / Adam Mosseri 本人の発言（Social Media Today 等が日付付きで引用したもの）
- **[大手調査]** Socialinsider, Rival IQ(Quid), Dash Social, Buffer, Sprout Social, Hootsuite の年次レポート・大規模データ分析
- **[第三者]** マーケ会社・ツール事業者のブログ。数値は参考値であり、一次資料で裏取りできなかったものは「未確認」と明記する

---

## 1. コンテンツ形式ごとの特性

### 1.1 形式別の特徴と「見るべき指標」

| 形式 | 主な役割 | 見るべき指標（Insights / API 名） | 補足 |
|---|---|---|---|
| フィード画像 | 既存フォロワーへの定期接触 | views, reach, likes, comments, saved, shares, profile_visits, follows | Socialinsider 2025 データではエンゲージメント率が最も低い形式（0.37%）。投稿量も減少傾向 |
| カルーセル（最大 20 枚, 2024-07〜） | 保存・熟読を促す情報量の多い投稿 | 上記 + saved（保存数が最も多い形式） | 2025 データで ER 0.55% と最高。50K フォロワー超ではリーチでもリールを上回る（Socialinsider） |
| リール（最長 3 分 2025-01〜、20 分は 2025-09 以降 [第三者]） | フォロワー外リーチ・発見 | views, reach, ig_reels_avg_watch_time, ig_reels_video_view_total_time, reels_skip_rate（2025-08 追加）, retention チャート, shares, saved, follows | 視聴の 55% がフォロワー外（Meta 発言の第三者引用、未確認）。ランキングは watch time と sends が重い |
| ストーリーズ（24 時間で消滅） | 既存フォロワーとの関係維持・送客 | reach, views, replies, link_clicks, navigation（TAP_FORWARD / TAP_BACK / SWIPE_FORWARD(次のアカウントへ) / TAP_EXIT）, profile_activity | API での Insights 取得は 24 時間以内のみ。日本の事業者は replies が常に 0 を返す（2021-04〜）[公式 API 仕様] |
| ライブ | リアルタイム交流 | 同時視聴者ピーク、平均視聴時間、コメント | 2025-08 から公開アカウントかつ 1,000 フォロワー以上が必要 [公式報道] |
| ハイライト | ストーリーズの永続化・プロフィール導線 | 元ストーリーズの指標のみ。ハイライト単体の Insights はない | 2024-11 に専用タブ化（丸いアイコン列が廃止） |
| ノート（60 字, 3 日で消滅） | 軽い近況共有。投稿・リールにも付与可（2024-07〜） | Insights なし [未確認: 公式に公開指標なし] | 分析対象にしづらい |
| ブロードキャストチャンネル | 一斉配信（2024-12 から返信・投票・分析を拡充） | Insights Overview に総インタラクション、ストーリーズ共有、投票数（アプリ内のみ） | API・サードパーティ投稿は未対応 [第三者] |
| Trial Reels（お試しリール, 2024-12-10〜） | フォロワー外だけに配信して A/B テスト | 約 24 時間後に views/likes/comments/shares と過去の Trial との比較。72 時間以内の views が基準を超えれば自動で通常公開 [公式] | 2026 年初頭に予約投稿対応。新 Insights UI には未対応（2026-04） |
| コラボ投稿（最大 5 名の共同投稿者 [第三者]） | 共同投稿で相互のフォロワーへ配信 | 全共同投稿者に**同一のプール済み指標**が表示され、アカウント別内訳は出ない | 分析上、コラボ投稿は自アカウント単独の指標と混ぜないこと |
| リポスト（2025-08-06〜） | 公開リール・投稿を自プロフィールの「Reposted」タブへ | reposts（API メディア指標） | リポスト主体のアカウントはおすすめ対象外（2.3 参照） |
| ショッピング（商品タグ） | 商品詳細ページへの導線 | 商品タグのタップ等（Commerce Manager 側） | Shop タブは 2023 に廃止、ライブショッピング終了、アプリ内チェックアウトも縮小 [第三者]。商品タグ・カタログ広告は継続 |
| Threads 連携 | 単一画像投稿のクロスポスト、Threads でのいいねを Instagram 側に通知 | Threads は独自 Insights と Threads API（2024〜）で取得 | リール・カルーセル・ストーリーズは連携不可 [第三者] |

出典:
- Instagram Platform Media Insights（API 指標一覧） https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights [公式, 2026 時点]
- Trial Reels 公式 https://creators.instagram.com/blog/instagram-trial-reels [公式, 2024-12-10]
- Reposts / Map / Friends タブ https://about.fb.com/news/2025/08/new-instagram-features-help-you-connect/ [公式, 2025-08]
- Socialinsider Instagram Benchmarks https://www.socialinsider.io/social-media-benchmarks/instagram [大手調査, 2025 データ]
- ライブ 1,000 フォロワー要件 https://techcrunch.com/2025/08/01/instagram-now-requires-users-to-have-at-least-1000-followers-to-go-live/ [2025-08]
- コラボ投稿の指標共有 https://minter.io/blog/how-to-measure-instagram-collab-posts/ [第三者]
- 機能タイムライン https://napoleoncat.com/blog/instagram-new-features-and-updates/ , https://metricool.com/instagram-news/ [第三者, 2026-09 更新]

### 1.2 2024〜2026 年の主要な機能変更（分析への影響）

| 時期 | 変更 | 分析への影響 |
|---|---|---|
| 2024-04-30 | オリジナルコンテンツ優遇。30 日に 10 回以上の無加工リポストは Explore/おすすめから除外。リポストの代わりに原作者の投稿を推薦 [公式発表を Engadget/SMT が報道] | リポスト比率をアカウント健全性の指標として持つ |
| 2024-07 | カルーセル 20 枚、投稿へのノート付与 | カルーセルの枚数を属性として保持 |
| 2024-08-07 | 「ビュー（views）」を全形式の主要指標に統一すると発表 [公式] | 指標体系の転換点 |
| 2024-11 | ハイライト専用タブ化。ハッシュタグフォロー廃止（2024-12-13）| ハッシュタグ経由リーチの前提が崩れる |
| 2024-12-04 | Instagram Basic Display API 終了 [公式] | 分析は Instagram API（Business/Creator + App Review）が唯一の正規手段 |
| 2024-12-10 | Trial Reels 開始 [公式] | 「試験配信」フラグを投稿属性に持つ |
| 2025-01 | プロフィールグリッドを正方形から縦長 3:4 に変更。リール上限 90 秒→3 分 [Mosseri, Threads] | サムネイル比率・尺の分布を分析軸に |
| 2025-01-22 | Mosseri が「watch time / likes / sends」を 3 大シグナルと説明 [公式発言] | 2.2 参照 |
| 2025-04-21 | API で impressions / plays / video_views が views に置き換え [公式] | 2025-04 前後で時系列が不連続。過去 impressions と views を混在させない |
| 2025-04-22 | 動画編集アプリ Edits 公開 | Edits 側の分析（2026-09 に PDF 出力等）と役割分担 |
| 2025-07 | 公開プロアカウントの投稿が Google 検索にインデックス [Hootsuite Trends 等] | キャプション・代替テキストのキーワードが外部流入に影響 |
| 2025-08-06 | リポスト、Instagram Map、リールの「Friends」タブ [公式] | reposts 指標の登場。友人経由の閲覧経路 |
| 2025-08-24 | リールに Retention（維持率）チャートと Skip Rate（最初の 3 秒での離脱率）を追加。View Rate は廃止 [SMT] | 動画の「フック」評価が定量化可能に |
| 2025-09 | ロゴタイプ刷新、リール上限 20 分 [第三者、日付要確認] | 長尺リールを短尺と分けて分析 |
| 2025-11-03 | Professional Dashboard に「Competitive Insights」（最大 10 アカウントのフォロワー増・投稿頻度・投稿別成果を比較。エンゲージメント率は非表示 [第三者]） | ネイティブに競合比較が出た。自作ツールは ER・保存率等で差別化 |
| 2025-12-10 | 「Your Algorithm」（ユーザーが推薦トピックを確認・調整）発表。2026-04-15 に発見タブへ拡張、2026-06-10 に全面展開 [公式] | 推薦は「トピック」単位で説明されるようになった。投稿のトピック分類の重要性が上がる |
| 2025-12-18 | ハッシュタグ上限を 30→5 に段階的変更 [SMT, 公式発言引用] | ハッシュタグ数の分析軸は 0〜5 で足りる |
| 2025-12 末 | Mosseri 年末メモ「主要な共有手段は DM」「AI で真正性が無限に複製可能になる」→ 創作ツール、AI ラベル、真正性検証、信頼シグナルの 4 優先事項 | DM 共有（sends）とオリジナル性が引き続き中核 |
| 2026-02〜05 | Instants（24 時間で消える写真共有）テスト→2026-05-13 に全世界公開 [TechCrunch] | Insights 対象外 [未確認] |
| 2026-04 | Insights UI 刷新（Overview / Engagement / Audience の 3 タブ。Share Rate、Skip Rate、時間経過ごとの views を投稿単位で表示。コラボ・Trial・クロスポスト・ブースト投稿は対象外）[SMT 2026-04-26] | 自作ツールでもこれらの派生率を標準化する |
| 2026-04-30 | オリジナル性ポリシーを写真・カルーセルにも拡大。「月単位」でアカウントを評価し、大半が他人のコンテンツなら非推薦化。Account Status で確認・異議申立て可 [Mosseri 発言を PetaPixel が報道] | 2.3 参照 |
| 2026-05-04 | 「AI Creator」ラベルのテスト [第三者] | AI 生成コンテンツの識別が属性化される可能性 |
| 2026-09-10 | タグ付けされた投稿を自分のグリッドに追加可能 [Mosseri] | 自分の投稿とタグ付け投稿の区別が必要 |

その他: DM の翻訳・予約送信・ピン留め（2025-01〜02）、Instagram for TV（2025-12 Fire TV、2026-02 Google TV）、Reels のアフィリエイトリンク（2026 春、対象国限定）、リールの Series 機能テスト（2025-06）。

---

## 2. アルゴリズム／ランキングシグナル

### 2.1 サーフェス別シグナル（Instagram Ranking Explained, 2023-05-31）[公式]

出典: https://about.instagram.com/blog/announcements/instagram-ranking-explained

- **フィード**: 重要度順に (1) ユーザーの行動（いいね・シェア・保存・コメント履歴）(2) 投稿の情報（人気度、投稿時刻、位置情報）(3) 投稿者の情報（過去数週間のやり取り）(4) 投稿者との関係。予測対象は「数秒滞在・コメント・いいね・シェア・プロフィール写真タップ」の 5 つ。同一人物の連投は並べない。
- **ストーリーズ**: 閲覧履歴（その人のストーリーズをどれだけ見るか）、エンゲージメント履歴、親密さ。予測対象は「タップして開く・返信・次のストーリーへ移動」。
- **発見タブ (Explore)**: 投稿の情報（人気度が「フィードよりはるかに重要」）、Explore 内での行動、投稿者とのやり取り、投稿者の情報。予測対象は「いいね・保存・シェア」。推奨ガイドライン違反は表示しない。
- **リール**: ユーザーの行動、投稿者とのやり取り、リールの情報（音源、映像、人気度）、投稿者の情報。予測対象は「リシェア・最後まで視聴・いいね・音源ページへ移動」。**非推薦**: 「低解像度またはウォーターマーク付き、無音、枠付き、大部分がテキスト、既に Instagram に投稿済みのリール」。

2025-12 の「Your Algorithm」以降、公式説明は「AI が推定した興味トピック」を軸にした表現に変わっている（https://about.instagram.com/blog/announcements/reels-algorithm-control）。

### 2.2 Mosseri の「3 大シグナル」（2025-01-22）[公式発言]

出典: https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/

- 「ランキングで最も重要な上位 3 シグナルは watch time、likes、sends」
- 「Insights では average watch time、likes per reach、sends per reach に注目せよ」
- 「likes は connected（フォロワー向け）コンテンツでやや重要、sends は unconnected（非フォロワー向け）コンテンツでやや重要」
- コメントはこの 3 つに含まれていない。

注意: 「sends は likes の 3〜5 倍の重み」という数値は socialday.live 等が「業界分析（2026-07）」として述べているもので、Mosseri の発言ではない。**未確認（推測値）**として扱う。同様に「オリジナルは 40〜60% 多く配信」「米国の推薦の 75% がオリジナル」等の第三者ブログの数値も一次資料が見当たらない。

分析ツールへの含意: 投稿単位で `shares / reach`（sends per reach）、`likes / reach`、平均視聴時間／尺（視聴維持率）を標準 KPI にする。

### 2.3 オリジナル性・リポスト・ウォーターマーク

- 2023-05: ウォーターマーク付き・低解像度・再投稿済みリールは非推薦 [公式]
- 2024-04-30: 「作成または実質的に強化していない」コンテンツを 30 日に 10 回以上投稿するアグリゲーターは Explore・フィード推薦から除外。リポストは原作者の投稿に置換して推薦し、原作者に通知。小規模アカウントの配信を是正するリール順位変更も同時に発表 [公式発表, Engadget/SMT 報道] https://www.engadget.com/instagrams-algorithm-overhaul-will-reward-original-content-and-penalize-aggregators-130018977.html
- 2026-04-30: 対象を写真・カルーセルに拡大。月単位で「大半が他人のコンテンツ」なら非推薦。クレジット表記・ウォーターマーク・軽微なトリミングはオリジナル扱いにならない。解説・リミックス・グリーンスクリーン等の「実質的な付加」があれば可。既存フォロワーへの配信は影響なし [Mosseri 発言, PetaPixel] https://petapixel.com/2026/04/30/new-instagram-policies-target-reposted-content/

### 2.4 検索・キーワード・ハッシュタグ

- Mosseri は 2024 年から一貫して「ハッシュタグはリーチを増やさない。投稿内容を伝え検索を助けるもの」と発言 [第三者による引用多数]。2025-12-18 に上限を 5 個へ [SMT] https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/
- 2025-07 から公開プロアカウントの投稿（キャプション・代替テキスト・位置情報）が Google 検索の対象に [Hootsuite Trends 2026, 各社報道]
- Instagram 内検索はキャプション・コメント・画像/動画の内容（埋め込みモデル）を利用と Mosseri が説明（2026-07 Q&A, 第三者引用）。
- 含意: キャプションの語彙（キーワード）と代替テキストは分析対象に含める価値がある。ハッシュタグ数×成果の相関分析は 0〜5 の範囲で十分。

### 2.5 発見タブ・おすすめとフォロワー外リーチ

- Zuckerberg（2024-04, Q1 2024 決算）「Instagram で人々が見るコンテンツの 50% 超が AI 推薦」。リールは Instagram 滞在時間の約 50% [Meta 決算報道] https://www.benzinga.com/news/24/04/38420928/
- Mosseri（2023-12, Threads）「フィードへの共有は減り、ストーリーズは増え、DM での写真・動画共有はさらに多い」。2025 年末メモでも「主要な共有手段は DM」。
- 含意: フォロワー数はリーチの上限ではない。分析では **reach の follower_type 内訳（followers / non_followers）** と **sends（shares）** を中心に「発見される力」を測る。API の account insights `reach` は `follow_type` breakdown を、`views` は `follower_type` を持つ。

### 2.6 シャドウバン／リーチ低下の一般的要因

- Instagram は「シャドウバン」という語を使わず、推奨ガイドライン違反による「非推薦（not eligible for recommendation）」として説明。Account Status（設定内）で推薦適格性を確認・異議申立てできる [公式機能, 2026-04 のポリシー記事で言及]
- リーチ低下の主な要因（第三者の整理）: (1) 推奨ガイドライン違反・自動化ツール利用による制限 (2) リポスト主体 (3) 視聴維持率・保存・シェアの低さ（単なる内容の弱さ）(4) 投稿テーマの一貫性欠如 (5) ウォーターマーク。外形上は同じ「リーチ減」なので、分析ツールでは「フォロワー外リーチ比率が突然ゼロ近くになる」パターンを制限の兆候として切り分ける。

---

## 3. 主要 KPI の定義とベンチマーク

### 3.1 エンゲージメント率（ER）の定義比較

| 定義 | 分子 | 分母 | 採用例 | 妥当性 |
|---|---|---|---|---|
| A. フォロワーベース（狭義） | likes + comments | followers | Socialinsider, Rival IQ(Quid)（Rival IQ は shares 等も含める） | 他社・競合と比較可能（公開情報のみで計算可）。リーチが分母でないため、フォロワー外リーチが多いリールでは実態を過小評価 |
| B. フォロワーベース（広義） | likes + comments + saves + shares | followers | HypeAuditor 等一部 | 自アカウントのみ計算可。競合比較不可 |
| C. リーチベース | likes + comments + saves + shares | reach | Later, Hootsuite, 多くの実務者 | 「見た人のうち反応した割合」で投稿の質を最も正確に表す。競合には使えない（reach は非公開） |
| D. ビューベース | interactions | views | Dash Social（Engagement Rate / Views） | views は重複表示を含むため C より低く出る |

推奨（4 章まとめでも再掲）: 自アカウントの投稿評価は **C（リーチベース、保存・シェア込み）** を主 KPI とし、競合比較・業界ベンチマーク照合には **A（フォロワーベース、likes+comments）** を併記する。2 種を混同しないよう名称を分ける。

出典: https://later.com/blog/instagram-engagement-rate/ , https://blog.hootsuite.com/calculate-engagement-rate/ , https://www.socialinsider.io/blog/how-to-calculate-engagement-rate/

### 3.2 その他の KPI 定義（推奨）

| KPI | 定義 | 備考 |
|---|---|---|
| 保存率 | saved / reach | Socialinsider は followers 分母（0.02〜0.05%）。自アカウントは reach 分母を推奨 |
| シェア率（sends per reach） | shares / reach | Mosseri の 3 大シグナル。2026-04 の公式 Insights にも「Share Rate」が登場 |
| いいね率（likes per reach） | likes / reach | 同上 |
| コメント率 | comments / reach | 2025 以降のランキング説明では 3 大シグナル外だが会話の深さは重視 [第三者] |
| プロフィール遷移率 | profile_visits / reach | 投稿 Insights の profile_visits |
| フォロー転換率 | follows / reach または follows / profile_visits | 投稿 Insights の follows |
| 外部リンク遷移率 | profile_activity(BIO_LINK_CLICKED) / profile_visits、ストーリーズは link_clicks / views | DM 内リンクは Insights で追跡不可 → UTM 必須 |
| リール視聴維持率 | ig_reels_avg_watch_time / 動画尺 | 目安「50% 超」は第三者値 |
| リール Skip Rate | 最初の 3 秒で離脱した割合（公式指標） | 「30〜40% 未満が健全」は第三者値 |
| ストーリーズ完了率 | 最終スライド views / 最初のスライド views | 公式指標ではなく派生値 |
| ストーリーズ離脱率 | TAP_EXIT / views、次アカウント遷移率 = SWIPE_FORWARD / views | TAP_BACK は「見返された」ポジティブ指標 |
| フォロワー外リーチ比率 | reach(non_followers) / reach | 発見力 |
| 投稿頻度 | 形式別の週次・月次投稿数 | ベンチマークは 3.3 |
| フォロワー純増 | follows_and_unfollows（follow_type 内訳） | 100 フォロワー以上で取得可 |

### 3.3 ベンチマーク値（出典と年を明記）

**全体 ER（フォロワーベース）**
- Rival IQ 2025 年版: 全業種中央値 0.36%、上位 25% は 1.05%。前年比 -16%。https://www.rivaliq.com/blog/social-media-industry-benchmark-report/ [大手調査, 2025]
- Rival IQ(Quid) 2026 年版: 中央値 0.30%。業種別レンジ 0.14%（Health & Beauty）〜2.10%（高等教育）。Tech & Software 0.33%、金融 0.26% [大手調査, 2026] https://www.quid.com/knowledge-hub/resource-library/blog/2026-social-media-industry-benchmark-report
- Socialinsider（2025-01〜12、3,500 万投稿・447,613 ページ、likes+comments/followers）: 平均 0.48%（前年比 -24%）。カルーセル 0.55%、リール 0.52%、画像 0.37% [大手調査, 2025 データ] https://www.socialinsider.io/social-media-benchmarks/instagram
- Dash Social 2026 H1: フォロワーベース 0.4%、ビューベース 1.9%。形式別（ビューベースと推定）リール 2.7%、カルーセル 1.4%、静止画 1.3%。業種例: Beauty 0.2%/2.1%、CPG 0.4%/2.6%、Food&Bev 0.4%/2.5%、Media 0.5%/2.3%、Travel 0.5%/2.3%。平均投稿 9 本/週 [大手調査, 2026 H1] https://www.dashsocial.com/social-media-benchmarks/instagram

**保存・シェア・コメント率（Socialinsider, 2025-10〜2026-03, 1,500 万投稿, followers 分母）**
- コメント率: リール 0.06% / カルーセル 0.04% / 画像 0.03%
- シェア率: リール 0.10% / カルーセル 0.08% / 画像 0.07%
- 保存率: リール 0.04% / カルーセル 0.05% / 画像 0.02%
- 中央値の実数: 保存はリール 35・カルーセル 37・画像 10 https://www.socialinsider.io/social-media-benchmarks/instagram-engagement-report

**フォロワー規模別（Socialinsider 2025）**
- 年間フォロワー増加率: 1–5K 22.0%、5–10K 20.3%、10–50K 17.2%、50–100K 13.6%、100K–1M 11.3%（2024 は 27〜38%）
- 投稿あたり views 中央値: 1–5K リール 580 / カルーセル 993 / 画像 417、100K–1M リール 16,035 / カルーセル 35,370 / 画像 22,900
- リールのリーチ率（reach/followers）: 1–5K で約 9.8%、100 万に近づくと約 5% [Socialinsider ブログ, 2025–2026]

**ストーリーズ（Socialinsider, 2025-01〜05, 161,180 本）** https://www.socialinsider.io/social-media-benchmarks/instagram-stories-benchmarks
- リーチ率（viewers/followers）: 1–5K 画像 9.55% / 動画 10.40%、10–50K 1.35% / 2.00%、100K–1M 0.50% / 0.65%
- 離脱率（exits/views）: 1–5K 12.8〜13.4%、100K–1M 8.3〜8.7%
- タップフォワード率: 50〜67%
- 完了率: 約 70%（Dash Social/第三者の集計、大規模ほど高い）
- 推奨本数: 1–5K 月 12 本、10–50K 月 35 本、100K–1M 月 80 本（同レポート）

**投稿頻度**
- Socialinsider 2025: 月平均リール 8・カルーセル 5・画像 7（2024: 6/4/10）
- Rival IQ 2025: 全業種で週 4 回強、初めて微減

**注意**: 業種別・規模別の数値は各社で定義・母集団が異なり、そのまま自社に当てはめられない。ツール内では「出典・年・定義」をラベル付きで表示すべき。

### 3.4 最適投稿時間

- Buffer（960 万投稿, 2026-09 更新）: 木 9 時、水 12 時、水 18 時。金土が最弱。https://buffer.com/resources/when-is-the-best-time-to-post-on-instagram/
- Sprout Social（約 20 億エンゲージメント, 2026）: 火・水がピーク、週末が最低
- Hootsuite（100 万投稿, 118 か国）: 月・火・木
- Later（600 万投稿）: 早朝 5 時前後
- 各社で結論が異なる。**自アカウントの `online_followers`（直近 30 日のみ API 取得可）と投稿時刻別成果から算出するのが妥当**。

---

## 4. 分析の目的・ユースケース別に必要な観点

| ユースケース | 主要な問い | 必須指標 | Instagram 固有の注意 |
|---|---|---|---|
| 企業ブランド／マーケ（認知・ファン化・送客） | 新規に届いているか、関係が深まっているか、サイトへ送れているか | フォロワー外リーチ比率、sends/reach、保存率、プロフィール遷移率、フォロー転換率、外部リンクタップ、ストーリーズ link_clicks、投稿形式別 ER | 本文にリンク不可 → 送客はプロフィール・ストーリーズ・DM 経由に限られる。DM 内リンクは Insights 外 |
| EC・店舗（送客・商品タグ） | どの投稿が商品閲覧・来店に繋がるか | 商品タグ付き投稿の views/reach、profile_activity（DIRECTION/CALL）、link_clicks、UTM 付き流入、リール内商品タグ | Shop タブ・アプリ内決済は縮小、商品タグは継続。Meta は「日本ユーザーはショッピングタグから商品詳細を見る割合が他国の 3 倍」と発表（年不明、第三者引用） |
| 個人クリエイター（案件獲得・フォロワー増） | どの投稿が新規フォローを生むか、案件提示用の実績 | follows/reach、視聴維持率、Skip Rate、Trial Reels の結果比較、フォロワー属性（年齢・性別・都市）、ER（フォロワーベースも併記） | Trial Reels は通常投稿と分けて集計。コラボ投稿は共同投稿者と指標が共有される |
| 代理店（複数アカウントの月次レポート） | 横断比較と自動レポート | 上記の全指標のアカウント横断ビュー、期間比較（前月・前年同月）、形式別内訳、出典付きベンチマーク | 90 日で消える native Insights の蓄積、ストーリーズは 24 時間以内の取得（Webhook `story_insights`）、views 転換（2025-04）前後の断絶 |
| インフルエンサーマーケ（選定・フェイク検出・効果測定） | 本物の視聴者か、案件が効いたか | ER（フォロワーベース）、フォロワー増減の急変、コメント質、フォロワー属性、フォロー/フォロワー比、パートナーシップ広告の成果（CPA/CTR） | 他者アカウントの reach・保存は API で取れない → 公開指標（likes/comments）中心の推定。HypeAuditor は AQS（1〜100）で real/other influencers/mass followers/suspicious を分類 |

インフルエンサー領域の補足: Meta のパートナーシップ広告（クリエイターアカウントから配信、「Paid partnership」表示）が主流化し、2026 年にはブランド投稿に必須化されたとの第三者報告 https://www.contentgrip.com/meta-branded-content-rules-update/ [未確認]。Creator Marketplace は 2026 時点で 18 か国以上（日本含む）。

---

## 5. 他 SNS と比べた Instagram 分析の難しさ・特徴

1. **公開データが極端に少ない**: Instagram API は自分が管理する Business/Creator アカウントのみ。他者アカウントは Business Discovery（フォロワー数・投稿の likes/comments 等）に限られ、reach・saves・shares は不可。YouTube Data API は承認不要で 1 日 10,000 ユニット、TikTok Research API は米欧の学術研究者限定、X API は有料化。Instagram は Business Verification + App Review（数週間）が必要 [Phyllo 等第三者比較, 2026]
2. **ハッシュタグ検索 API の弱さ**: 7 日間に 30 ユニークハッシュタグまで。ストーリーズ非対応。個人情報（ユーザー名）は返さない [公式] https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search
3. **消えるコンテンツ**: ストーリーズ（24 時間）、ノート（3 日）、Instants（24 時間）、Trial Reels（非公開扱い）。API のストーリーズ Insights は 24 時間で消える → Webhook 購読か定期ポーリングが必須。
4. **native Insights の 90 日制限**: アプリ内・Meta Business Suite とも直近 90 日のローリングウィンドウ。CSV エクスポートは 90 日単位 [複数の第三者ガイド]
5. **日本固有**: API のストーリーズ `replies` は日本のクリエイターに対し 2021-04 から常に 0 [公式 API 仕様]。返信数はアプリ内 Insights か手動記録に頼る。
6. **リンクを本文に貼れない**: 送客経路がプロフィールリンク・ストーリーズリンクスティッカー・DM に限定。DM は Insights 対象外。Meta Verified 向けにキャプション内リンクのテスト（2026, 第三者）。
7. **DM 中心の共有文化**: 公開指標に現れない「sends」が最重要シグナル。コメントより DM 返信が多いブランドでは公開 ER だけでは実態が見えない。
8. **形式ごとに指標体系が違う**: ストーリーズは navigation、リールは watch time／skip rate、フィードは saves／profile_visits。統一 KPI が作りにくい。
9. **指標定義の変更が頻繁**: impressions→views（2025-04）、View Rate→Skip Rate（2025-08）、Insights UI 刷新（2026-04）。時系列の断絶を明示する設計が必要。
10. **画像・動画中心**: テキスト分析だけでは要因分析が弱い。画像内容（人物・商品・テキスト量）・動画の尺・音源といった属性の付与が他 SNS より重要。
11. **コラボ投稿の指標が共有**: 共同投稿者間で同一値。自アカウント単独の実力と混ざる。
12. **Threads は別プラットフォーム**: 独自 Insights/API。Instagram 側には「Threads でのいいね通知」程度の連携。

---

## 6. 分析ツールに対する「あるある不満」と自作で解決できること

Reddit は本調査環境からアクセスできなかったため、レビューサイト（Capterra/G2 要約）、ツール事業者ブログ、Sprout Social の調査から整理した。

| 不満 | 根拠 | 自作での解決策 |
|---|---|---|
| 日次データが 90 日で消え、遡れない | native Insights の 90 日制限（複数の第三者ガイド） | API を日次で叩き自前 DB に蓄積（account insights の `day` period、media insights のスナップショット） |
| サードパーティも「接続した日以降」しか持たない | 「since you connected」制約 [第三者] | 接続直後に過去メディアの lifetime 指標を一括バックフィルし、以後は差分で日次履歴を作る |
| ストーリーズの履歴が残らない | API 24 時間制限 | `story_insights` Webhook ＋ 期限前のポーリング |
| 投稿別の長期トレンドが見えない | 多くのツールは投稿の最終値のみ | 投稿ごとの views/reach/saves を日次スナップショットで保存し、公開後 1/3/7/30 日の成長曲線を描く（2026-04 の公式 UI も「views over time」を追加） |
| 比較期間が固定・前年同月比が出ない | ツール仕様 | 任意期間 vs 任意期間、投稿形式別・曜日別の比較 |
| レポート整形が面倒 | Sprout 調査: 分析・レポートに週 3.8 時間 https://sproutsocial.com/insights/the-state-of-social-media/ | テンプレート化した月次 PDF/HTML、出典付きベンチマーク表の自動挿入 |
| 複数アカウント横断が高価 | Sprout Social は 1 ユーザー月 99 ドルから、席課金・アカウント数課金（Capterra/G2 要約） | 自前 DB で無制限にアカウントを並べる |
| 競合比較で ER が出ない | Competitive Insights（2025-11）は ER 非表示 [第三者] | Business Discovery で公開指標を取得しフォロワーベース ER を計算 |
| views と impressions の混在で数字が跳ねる | views は impressions より約 25% 高い [Emplifi/Sprinklr 等ツール事業者] | 2025-04-21 を境に系列を分け、グラフに注釈 |
| コラボ・Trial・ブースト投稿が通常投稿と混ざる | 公式 Insights も新 UI で除外 | 投稿属性でフラグ管理し、集計から任意に除外 |
| ハッシュタグ効果の分析が的外れ | ハッシュタグはリーチに効かない（Mosseri） | ハッシュタグよりキャプションのキーワード・トピック分類に投資 |

---

## 7. AI 活用の動向（2025〜2026）

- **画像内容の分類・成果予測**: Dash Social「Vision AI」が視覚要素から投稿の成果を予測し、動画のカバー画像を選定 https://www.dashsocial.com/features/predictive-ai [事業者説明]
- **感情分析**: Sprout Social がメンション・メッセージのリアルタイム感情分析、Hootsuite は Talkwalker 連携のリスニング https://sproutsocial.com/insights/sentiment-analysis-tools/ , https://blog.hootsuite.com/ai-social-listening/
- **最適投稿時間の予測**: Sprout「Optimal Send Times」（ViralPost）、Hootsuite の AI カレンダー、Metricool の best time [事業者説明]
- **キャプション生成・要約レポート**: Hootsuite OwlyWriter、Sprout の自動レポート生成
- **プラットフォーム側の AI**: Instagram の「Your Algorithm」（トピック要約）、Edits の AI 制作アシスタント（2025-06 デスクトップ版）、AI 生成コンテンツのラベル（2026）、Meta の Movie Gen ベース動画編集
- **利用実態**: Hootsuite Social Trends 2026「79% のソーシャルメディア担当が AI を毎日利用」 https://www.hootsuite.com/research/social-trends
- 自作で現実的な範囲: (1) キャプション・コメントのトピック分類と感情分類（LLM）、(2) 画像のタグ付け（人物/商品/テキスト量/色調）、(3) 投稿属性×成果の要因分析（回帰・SHAP 程度）、(4) 自アカウント実績に基づく投稿時間推定、(5) 月次レポートの自然言語要約。

---

## 8. まとめ

### 8.1 「Instagram の特徴を押さえた分析ツール」チェックリスト

**形式別**
- [ ] フィード／カルーセル: saved、shares、profile_visits、follows を投稿単位で保持。カルーセルは枚数を属性に
- [ ] リール: avg_watch_time、total_view_time、skip_rate、尺、音源、Trial 由来かどうか。3 分超は別区分
- [ ] ストーリーズ: navigation 4 種、link_clicks、replies（日本は API で 0）、スライド順、24 時間以内に取得
- [ ] ライブ／ハイライト／ノート／ブロードキャスト: 指標が乏しいことを明示し、手動入力欄を用意
- [ ] コラボ・リポスト・ブースト・クロスポスト: フラグ管理し集計から除外可能に
- [ ] views（2025-04〜）と impressions（〜2025-04）の系列分離

**アルゴリズム対応**
- [ ] likes/reach、shares/reach、平均視聴時間／尺 の 3 指標を標準表示
- [ ] reach の followers／non_followers 内訳と、その比率の時系列
- [ ] リポスト比率・ウォーターマーク有無（手動または画像判定）をアカウント健全性の指標に
- [ ] キャプションのキーワード・トピック分類。ハッシュタグ数は 0〜5
- [ ] フォロワー外リーチ比率の急落アラート（非推薦化の兆候）

**目的別**
- [ ] ブランド: 認知（non_followers reach）→ 関係（saves、replies）→ 送客（link taps、profile_activity）のファネル
- [ ] EC: 商品タグ付き投稿の分離、UTM 連携、DIRECTION/CALL タップ
- [ ] クリエイター: follows/reach、フォロワー属性、Trial Reels 比較、案件用サマリー
- [ ] 代理店: 複数アカウント横断、任意期間比較、出典付きベンチマーク、レポート出力
- [ ] インフルエンサー選定: 公開指標からのフォロワーベース ER、フォロワー増減の異常検知、コメント質

**データ基盤**
- [ ] 日次スナップショット蓄積（account insights `day`、media insights）
- [ ] ストーリーズ Webhook
- [ ] 指標定義変更の日付をメタデータとして保持（2025-04-21、2025-08-24、2026-04）
- [ ] Business Discovery による競合の公開指標取得（ハッシュタグ検索は 30/7 日の制限内で）

### 8.2 KPI の推奨定義

| KPI | 採用案 | 理由 |
|---|---|---|
| エンゲージメント率（自アカウント） | (likes+comments+saves+shares) / reach | 公式が重視する saves/shares を含み、フォロワー外リーチの影響を受けない |
| エンゲージメント率（競合・ベンチマーク用） | (likes+comments) / followers | Socialinsider・Rival IQ と定義が揃い、公開情報だけで算出可 |
| 発見力 | shares/reach、reach(non_followers)/reach | Mosseri の「sends per reach」と一致 |
| コンテンツ品質（動画） | avg_watch_time / 尺、skip_rate | 公式 Insights と同じ定義 |
| ストーリーズ品質 | exits/views、swipe_forward/views、完了率 | navigation breakdown をそのまま使う |
| 送客 | link_clicks（ストーリーズ）、profile_activity.BIO_LINK_CLICKED、UTM セッション | DM は測れないため UTM を前提に |
| 成長 | follows/reach（投稿単位）、follows_and_unfollows（日次） | 「フォローに至る率」と純増を分離 |

### 8.3 2024〜2026 年の変更タイムライン（要約）

- 2024-04-30 オリジナル優遇・アグリゲーター除外（30 日 10 回）
- 2024-07 カルーセル 20 枚、投稿へのノート
- 2024-08-07 views を主要指標に統一と発表
- 2024-11〜12 ハイライトタブ化、ハッシュタグフォロー廃止、Basic Display API 終了（12-04）、Trial Reels（12-10）
- 2025-01 グリッド 3:4、リール 3 分、Mosseri「watch time / likes / sends」（01-22）
- 2025-04-21 API で impressions/plays → views。2025-04-22 Edits 公開
- 2025-07 Google 検索インデックス
- 2025-08 リポスト・Map・Friends タブ（08-06）、ライブ 1,000 フォロワー要件、リール Retention/Skip Rate（08-24）
- 2025-09 ロゴタイプ刷新・リール 20 分 [要確認]
- 2025-11-03 Competitive Insights
- 2025-12 「Your Algorithm」（12-10）、ハッシュタグ上限 5（12-18）、グリッド並べ替え全面展開、Mosseri 年末メモ
- 2026-02〜06 Instagram for TV 拡大、Instants（05-13 全世界）、Your Algorithm を Explore（04-15）・全面展開（06-10）
- 2026-04 Insights UI 刷新（Share Rate / Skip Rate / views over time）、オリジナル性ポリシーを写真・カルーセルに拡大（04-30）
- 2026-05 AI Creator ラベルのテスト
- 2026-09 タグ付け投稿をグリッドに追加、Edits に PDF 出力等

### 8.4 未確認事項（要追加調査）

- 「sends は likes の 3〜5 倍」等の重み付け数値（一次資料なし）
- 3 分超リールが非フォロワーに推薦されないという公式根拠
- リール 20 分化とロゴ刷新の正確な日付
- カルーセルのスライド別キャプションの展開時期（2025-12 説と 2026-08 説）
- パートナーシップ広告の「必須化」（2026）の公式根拠
- ブロードキャストチャンネル・ノート・Instants の API での指標提供有無
- 日本市場固有の行動データ（SAKIYOMI「タブる 37.4% / タグる 18.1%」は 2020 年調査で古い https://prtimes.jp/main/html/rd/p/000000019.000044549.html ）

---

## 主要出典一覧

- Instagram Ranking Explained（2023-05-31）https://about.instagram.com/blog/announcements/instagram-ranking-explained
- Mosseri 3 大シグナル（2025-01-22, SMT）https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/
- Trial Reels（2024-12-10）https://creators.instagram.com/blog/instagram-trial-reels
- Reposts/Map/Friends（2025-08）https://about.fb.com/news/2025/08/new-instagram-features-help-you-connect/
- Your Algorithm（2025-12-10）https://about.instagram.com/blog/announcements/reels-algorithm-control
- リール Retention/Skip Rate（2025-08-24, SMT）https://www.socialmediatoday.com/news/instagram-adds-retention-insights-reels/758464/
- ハッシュタグ 5 個（2025-12-18, SMT）https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/
- Insights UI 刷新（2026-04-26, SMT）https://www.socialmediatoday.com/news/instagram-improves-insights-ui-adds-new-metrics/818504/
- オリジナル性ポリシー拡大（2026-04-30, PetaPixel）https://petapixel.com/2026/04/30/new-instagram-policies-target-reposted-content/
- 2024-04 オリジナル優遇（Engadget）https://www.engadget.com/instagrams-algorithm-overhaul-will-reward-original-content-and-penalize-aggregators-130018977.html
- views 転換（Emplifi ドキュメント）https://docs.emplifi.io/platform/latest/home/instagram-insights-metrics-deprecation-april-2025
- Meta 開発者ドキュメント: Media Insights https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights / User Insights https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights / Hashtag Search https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search
- Socialinsider: Instagram Benchmarks https://www.socialinsider.io/social-media-benchmarks/instagram / Engagement Report https://www.socialinsider.io/social-media-benchmarks/instagram-engagement-report / Stories Benchmarks https://www.socialinsider.io/social-media-benchmarks/instagram-stories-benchmarks
- Rival IQ 2025 https://www.rivaliq.com/blog/social-media-industry-benchmark-report/ / 2026（Quid）https://www.quid.com/knowledge-hub/resource-library/blog/2026-social-media-industry-benchmark-report
- Dash Social 2026 https://www.dashsocial.com/social-media-benchmarks/instagram
- Buffer 最適投稿時間 https://buffer.com/resources/when-is-the-best-time-to-post-on-instagram/
- Buffer アルゴリズム解説（2026-03）https://buffer.com/resources/instagram-algorithms/
- Sprout Social State of Social 2026 https://sproutsocial.com/insights/the-state-of-social-media/
- Hootsuite Social Trends 2026 https://www.hootsuite.com/research/social-trends
- Zuckerberg「50% 超が AI 推薦」（2024-04）https://www.benzinga.com/news/24/04/38420928/
- Mosseri 年末メモ解説（2026-01-01）https://om.co/2026/01/01/what-is-instagrams-adam-mosseri-really-saying-in-his-year-end-memo/
- ライブ 1,000 フォロワー（2025-08-01）https://techcrunch.com/2025/08/01/instagram-now-requires-users-to-have-at-least-1000-followers-to-go-live/
- Instants（2026-05-13）https://techcrunch.com/2026/05/13/instagrams-new-instants-feature-combines-elements-from-snapchat-and-bereal/
- Instagram for TV https://about.instagram.com/blog/announcements/instagram-tv-app
- 機能タイムライン（第三者）https://napoleoncat.com/blog/instagram-new-features-and-updates/ , https://metricool.com/instagram-news/
- Competitive Insights（第三者）https://www.dataslayer.ai/blog/instagram-competitive-insights-analyze-competition-2025
- API 比較（第三者）https://www.getphyllo.com/post/social-media-api-guide-on-top-apis-for-developers
- フェイクフォロワー検出（HypeAuditor）https://hypeauditor.com/free-tools/instagram-fake-follower-check/
- ストーリーズ navigation 解説（Hootsuite）https://blog.hootsuite.com/instagram-stories-analytics/

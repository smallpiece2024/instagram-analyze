これから、instagramを分析するツールを作成しようと思う。世の中に、インスタグラムの分析ツールはたくさんあるのだけど、結局メタ社のAPIを使って得られる情報を得ているだけだと思うので、自分で作る。世の中のたくさんの分析ツールから、いいところ、共通するところを真似したいので、インターネットで国内外のサービスを徹底的に調べ、またインスタグラムの特徴をおさえた分析ツールに必要な要件をまとめてください。

------------

かなり調べました。結論からいうと、**自作する価値は十分あります**。

ただし、「既存ツール＝Meta APIの値を表示しているだけ」という理解は半分正しく、
半分違います。自アカウントの基礎データは多くがMeta API由来ですが、各社の価値はむしろ、

**取得 → 継続保存 → 加工 → 比較 → 意味づけ → 次の施策につなげる**

という部分にあります。

たとえば、競合アカウントのフォロワー数は今日取得できても、半年前の推移はAPIを今日叩いても
復元できません。ストーリーズはもっと厳しく、API経由では24時間以内に取得・保存しておかないと
消えます。つまり、**データを継続的に貯めること自体が分析ツールの重要な機能**です。 :chatgpt-content-reference{index="0"}

---

# 1. 調査した代表的なサービス

国内外を合わせると、機能はかなり収束しています。

| サービス | 特に参考になるところ |
|---|---|
| SINIS | 期間比較、競合分析、ハッシュタグ、UGC、投稿カテゴリ、投稿とフォロワー増減の重ね合わせ、Excel/PPTレポート、AI考察 :chatgpt-content-reference{index="1"} |
| HINOME | 保存率・フォロー転換率などの率分析、競合、UGC、ハッシュタグ、投稿カレンダー :chatgpt-content-reference{index="2"} |
| Social Insight | 自社・競合比較、ソーシャルリスニング、投稿管理。独自に大量のSNSデータも蓄積 :chatgpt-content-reference{index="3"} |
| InStats | 投稿3時間後・1日後・7日後などを保存する初速分析、フォロワー転換率など :chatgpt-content-reference{index="4"} |
| CCX social | 業界比較、競合、AIコンサルタント、自由レポート。過去には初速分析も提供 :chatgpt-content-reference{index="5"} |
| Tofu Analytics | UGC・競合に加え、AIによる投稿の感情・カテゴリ分類 :chatgpt-content-reference{index="6"} |
| Sprout Social | 投稿・プロフィール・Story・Reels、競合、ハッシュタグ、カスタムレポート :chatgpt-content-reference{index="7"} |
| Metricool | 投稿公開後15〜30日の「成長曲線」、競合比較、Organic/Paidの分離 :chatgpt-content-reference{index="8"} |
| Iconosquare | 100以上の指標、競合、投稿時間、Reelsの時系列分析、AI分析 :chatgpt-content-reference{index="9"} |
| Later | Reels・Story・投稿分析、Best Time、業界比較、中央値を使ったレポート :chatgpt-content-reference{index="10"} |
| Socialinsider | 競合、業界ベンチマーク、AIによるContent Pillar分類・分析 :chatgpt-content-reference{index="11"} |
| Rival IQ | 競合中心。投稿テーマ・時間・ハッシュタグ、アラート、自動レポート :chatgpt-content-reference{index="12"} |
| Brandwatch | 競合、業界ベンチマーク、異常に伸びた投稿の自動検出、AI要約、Listening :chatgpt-content-reference{index="13"} |
| Hootsuite / Perch | 競合20アカウント程度、業界ベンチマーク、Best Time、AIによる改善提案 :chatgpt-content-reference{index="14"} |
| Buffer | 投稿時間・投稿形式・頻度の推奨、独自タグ、PDFレポートなど :chatgpt-content-reference{index="15"} |
| Keyhole | ハッシュタグ・キーワード・インフルエンサー・競合・アラート :chatgpt-content-reference{index="16"} |

これらを眺めると、機能がきれいに5層に分かれます。

**Metaデータ取得  
→ 時系列保存  
→ 指標化  
→ 比較・分類  
→ AIなどによる考察**

です。

---

# 2. 自作ツールで一番重要なのは「データベース」

ここはかなり重要です。

Instagramアプリを見れば現在の数字は分かります。

Meta APIを叩いても現在の数字は分かります。

しかし分析ツールが価値を持つのは、

> 「あの投稿は1時間後、3時間後、24時間後、
> 7日後にどう伸びたか」

を後から調べられることです。

SINIS、InStats、Metricool、Iconosquareなどが、
形は違っても同じ方向に進んでいます。Metricoolは投稿後15〜30日の推移を保存し、
日次値と累積値の両方で分析しています。 :chatgpt-content-reference{index="17"}

したがって、自作版も

**Instagram APIビューア**

ではなく、

**Instagram時系列データウェアハウス＋分析UI**

と考えた方がよいです。

---

# 3. Instagram特有の「見るべき構造」

普通のWebアクセス解析と違い、Instagramは

**認知 → 興味 → プロフィール → フォロー → 外部行動**

というファネルで考えると非常に分かりやすくなります。

例えば、

```text
非フォロワーに届く
        ↓
Reach / Views
        ↓
Save / Share / Comment
        ↓
Profile Visit
        ↓
Follow
        ↓
Bio Link Click
```

です。

単純な「いいね数」より、

**どの段階までユーザーを動かせたのか**

を見るべきです。

現在のAPIではアカウントレベルで
Views、Reach、Accounts Engaged、Interactions、
Follows/Unfollows、Profile Links Tapなどを取得でき、
フォロワー・非フォロワーやコンテンツ種類によるbreakdownもあります。 :chatgpt-content-reference{index="18"}

---

# 4. 必須にしたい派生指標

API値そのものより、こちらの方が重要です。

| 指標 | 例 |
|---|---|
| Engagement Rate | interactions / reach |
| Save Rate | saves / reach |
| Share Rate | shares / reach |
| Like Rate | likes / reach |
| Profile Visit Rate | profile visits / reach |
| Follow Conversion | follows / profile visits |
| Follow per Reach | follows / reach |
| 非フォロワーReach率 | non-follower reach / reach |
| Repeat View的指標 | views / reach |
| Follower Growth Rate | follower増加 / 期首followers |
| Reel Retention | avg watch time / duration |
| Story Completion | 最終Story reach / 最初Story reach |

ただし非常に大事なのは、

**分母を固定してしまわないこと**

です。

各サービスでも、

「Engagement / followers」

と

「Engagement / reach」

が混在しています。

LaterなどにはEngagement Rateの計算式を変更できる仕組みもあります。 :chatgpt-content-reference{index="19"}

したがって、

```text
保存率
  保存 / Reach
  保存 / Views
  保存 / Followers
```

を切り替えられる設計がよいです。

これは自作する大きなメリットです。

---

# 5. Feed・Reels・Storiesは別物として扱う

ここも非常に重要です。

## Feed / Carousel

中心になるのは、

**Reach → Save / Share → Profile → Follow**

です。

特に「保存」は、その場の反応ではなく

> あとでもう一度見たい

という意図なので、情報系投稿では重要です。

Carouselについてはさらに、

画像枚数、1枚目のタイプ、文字量、テーマ

などを独自データとして持たせる価値があります。

---

## Reels

FeedとはKPIを変えるべきです。

Reelsでは

**Views  
Reach  
Average watch time  
Total watch time  
Retention  
Share  
Repost**

を中心に見る設計がよいです。

Metricoolも平均視聴時間÷動画時間からRetentionを計算しています。 :chatgpt-content-reference{index="20"}

2026年にはRepost、Skip Rate、FacebookへのCrosspost関連指標なども
第三者ツールに入り始めています。 :chatgpt-content-reference{index="21"}

したがってDBは、

```text
metric_name
metric_value
```

のように、新しい指標を追加できる構造にしておいた方がいいです。

---

## Stories

Feed/Reelsとは完全に別画面にした方がよいと思います。

見るのは、

```text
Story 1
1000
 ↓
Story 2
850
 ↓
Story 3
670
 ↓
Story 4
610
```

という**離脱ファネル**です。

さらに、

Back  
Forward  
Exit  
Next Story

を見る。

Instagramならではの非常に面白い分析になります。

そして技術的にはここが最重要です。

**Story InsightsはAPI経由では24時間しか取得できず、
過去Storyを後からbackfillできません。**

Sprout SocialもStoryだけはbackfillなしで1時間ごとに取得しています。 :chatgpt-content-reference{index="22"}

したがって、

> Story収集バッチ

は後回しにしてはいけません。

**UIは後回しでも、収集処理だけは最初から作る**

べきです。

また、日本ではStoryのRepliesがAPI上0になる制約があります。 :chatgpt-content-reference{index="23"}

---

# 6. 「初速分析」はぜひ入れたい

国内ツールに非常に多い機能ですが、海外でもMetricoolやIconosquareが
似た方向に進んでいます。

例えば投稿後、

```text
1h
3h
6h
12h
24h
48h
72h
7d
14d
30d
```

でsnapshotを保存します。

すると、

### 投稿A

```text
0 → 500 → 2,000 → 4,000
```

### 投稿B

```text
0 → 100 → 300 → 8,000
```

のような違いが見えます。

Bは「初速型」ではなく、
後からRecommendationなどで伸びた可能性があります。

最終結果だけを見たら、両方とも8,000で終わってしまいます。

**自作するなら、ここはかなり面白い部分になると思います。**

---

# 7. 私なら「投稿分類」を中心機能にする

既存ツールの中でも、SINISのカテゴリ分析、
BufferのTag、SocialinsiderのContent Pillarなど、
かなり共通して存在します。

SINISでは投稿に独自カテゴリを付け、
カテゴリ単位で平均ReachやEngagementを比較できます。 :chatgpt-content-reference{index="24"}

例えば自分の投稿に、

| 軸 | 値 |
|---|---|
| テーマ | 店舗紹介 |
| 投稿目的 | 認知 |
| Format | Carousel |
| CTA | 保存 |
| 被写体 | 人 |
| テキスト量 | 多 |
| Campaign | 台湾まつり2027 |
| Content Pillar | イベント |
| Tone | 親しみ |
| 制作方法 | 写真 |

を付ける。

そうすると、

> 「人が写っている投稿の方がReachが高い」

> 「イベント告知はReachは低いが保存率が高い」

> 「CarouselはReelsよりFollow Conversionが高い」

といった分析ができます。

ここから先は**Meta APIには存在しない、自分の分析ツール独自のデータ**です。

---

# 8. さらにAIを使うなら、ここが一番面白い

単純な

> AIに「分析してください」と数字を全部渡す

だけでは、既存ツールと大差ありません。

むしろ、

**画像・動画・CaptionそのものをAIで構造化する**

のが面白いと思います。

例えば投稿から自動で、

```text
theme = "イベント紹介"
people = true
text_heavy = false
cta = "来場"
emotion = "楽しさ"
visual_style = "写真"
opening_hook = "質問"
```

のようなmetadataを生成する。

そして、

```text
performance metrics
        ×
creative metadata
```

を分析する。

これはSocialinsiderのContent Pillarや、
Tofu AnalyticsのAI分類にも近い考え方です。 :chatgpt-content-reference{index="25"}

ここまでやると、

> Meta APIを見るためのツール

から、

> **「どういうコンテンツを作ればよいか」を学習するツール**

になります。

自作する意味がかなり出ます。

---

# 9. 競合分析

MetaのBusiness Discoveryを使うことで、他のInstagram
Professional Accountについて、プロフィール情報やfollowers数、
mediaなど一部の公開情報を取得できます。公式Meta Postmanでも、
他のBusiness/Creatorの基本情報・metrics取得が用途として明記されています。 :chatgpt-content-reference{index="26"}

ただし、

**自分のアカウントと同じデータは取れません。**

例えば競合の

- Reach
- Saves
- Profile Visit
- Follow Conversion

などのprivate insightは見えません。

競合比較では主として、

```text
Followers
Follower growth
投稿数
投稿頻度
Likes
Comments
Content type
Caption
Hashtags
```

などになります。

Metricoolも競合のEngagementを算出するとき、
Reachが取得できないためFollowersを分母にしています。 :chatgpt-content-reference{index="27"}

したがってUI上でも、

**Owned Engagement Rate**

と

**Competitor Engagement Rate**

を同じ意味の数字として扱わない、

という設計が必要です。

---

# 10. ハッシュタグは「中心」ではなく補助機能

SINIS、Keyhole、Sproutなど、多くのツールにあります。

ただし自作版では優先順位を下げてよいと思います。

Meta APIではHashtag Searchがありますが、
1アカウントあたり**7日間で30個のユニークHashtag**という制限があります。 :chatgpt-content-reference{index="28"}

したがって、

```text
自投稿で使ったHashtag
        ↓
投稿performanceとの相関
```

をまず作る。

その後、

```text
#高津区
#溝の口
#台湾祭
```

などを定点観測する機能を足すのがよいでしょう。

---

# 11. UGCもInstagramでは重要

SINIS、HINOME、Social Insightなど国内ツールではかなり重視されています。

具体的には、

```text
Mentionされた件数
Taggedされた投稿
Mentionしたユーザー
投稿頻度
```

です。

これは、

**「自分が投稿したもの」ではなく
「他人が自分について投稿したもの」**

を見る指標です。

ブランド・店舗・地域メディア・イベントの分析では
かなり価値があります。

---

# 12. 分析画面の要件

私なら最終的にはこの構成にします。

| 画面 | 内容 |
|---|---|
| Overview | Views、Reach、Interactions、Followers、Profile Action |
| Growth | Followers増減＋投稿タイムライン |
| Content | 全投稿一覧、ソート、filter、独自Tag |
| Content Detail | 1h〜30日の成長curve |
| Reels | Views、Watch Time、Retention、Share |
| Stories | Story sequence、Completion、Exit、Forward/Back |
| Audience | Age、Gender、Country、City、Online時間 |
| Content Analysis | Theme/Format/CTA等による比較 |
| Competitors | Followers、投稿頻度、Engagement、人気投稿 |
| UGC | Mention / Tagged post |
| Hashtag | 自投稿Hashtag＋定点観測 |
| Report | 前期間比較、月次レポート |
| AI Analyst | データについて自然文で質問 |

特にOverviewは単に10個数字を並べるのではなく、

```text
認知
Reach / Views
   ↓
興味
Engagement
   ↓
プロフィール
Profile Visit
   ↓
関係化
Follow
   ↓
行動
Link Tap
```

というファネルにすると、
既存ツールよりかなり分かりやすくなると思います。

---

# 13. 比較機能は必須

調査したツールにほぼ共通していたのがこれです。

単純に

> Reach 12,000

と言われても、良いか悪いか分かりません。

最低でも、

```text
前7日
前30日
前年同月
直前投稿10件平均
同Content Type平均
同Category平均
```

との比較を入れます。

さらに、

```text
平均
中央値
上位25%
下位25%
```

も持つとよいです。

Laterがレポートの一部で平均ではなく中央値を使っているのは、
SNS投稿には一部のバズ投稿というoutlierがあるためです。 :chatgpt-content-reference{index="29"}

これはかなり良い考え方です。

---

# 14. 「異常に伸びた投稿」を自動検出する

これもぜひ入れたいです。

Brandwatchは、

> 通常よりLikesが50%多い

などのoutlierを自動検出しています。 :chatgpt-content-reference{index="30"}

例えば、

```text
直近20投稿のShare Rate
平均 1.2%
標準偏差 0.4%

今回
3.8%
```

なら、

> 🔥 通常よりShare Rateが非常に高い

と表示する。

AI以前に、統計だけでもできます。

そしてAIには、

> 過去の類似投稿と何が違うか

だけを考えさせる。

この方がかなり信頼できる分析になります。

---

# 15. Meta API対策として必須の非機能要件

ここは普通の分析画面以上に重要です。

Metaはmetricをかなり変更します。実際、
2025年には`impressions`から`views`中心へ大きく変更されています。 :chatgpt-content-reference{index="31"}

したがって、

| 要件 | 理由 |
|---|---|
| Raw API response保存 | 後から再計算できる |
| metric定義テーブル | API変更対応 |
| formula version | Engagement Rate定義変更対応 |
| API version管理 | Graph API version up対応 |
| token状態監視 | token切れ検出 |
| permission状態表示 | 権限不足の切り分け |
| Rate Limit監視 | throttling回避 |
| retry/backoff | Meta API障害対策 |
| Last updated表示 | 数値が古いことを明示 |
| timezone統一 | 日次集計ずれ防止 |
| Organic/Paid区別 | 数字を混在させない |

Instagram Platform APIにはrate limitがあり、
Business DiscoveryやHashtag Searchも制限対象です。 :chatgpt-content-reference{index="32"}

---

# 16. Facebook Login方式で進めるメリット

今作ろうとしているような分析ツールなら、
**Facebook Login方式を使う理由はかなりあります。**

Meta公式のPostmanによるとFacebook Login方式では、

- Own media
- Insights
- Comments
- Mention
- Hashtagged media
- 他のBusiness/Creatorの基本データ

などを扱えます。 :chatgpt-content-reference{index="33"}

一方、Instagram Login方式はFacebook Pageとの連携が不要になった反面、
**AdsとTaggingにはアクセスできない**という制限があります。 :chatgpt-content-reference{index="34"}

将来、

```text
Organic
+
Boosted post
+
Ads
+
UGC
+
Competitor
```

まで一つにするなら、
現在試しているFacebook側の認証ルートはかなり理にかなっています。

---

# 17. 私ならMVPはここまでにする

全機能を最初から作る必要はありません。

### Phase 1

**データを失わない基盤**

```text
OAuth
Account metrics
Media取得
Media Insights
Daily Account Snapshot
Post Snapshot
Story定期取得
DB保存
```

ここが最優先です。

画面がなくてもいいくらいです。

### Phase 2

**分析ツールとして最低限面白くする**

```text
Overview
投稿一覧
Feed / Reels / Story分類
期間比較
初速graph
Save rate
Share rate
Engagement rate
Follower growth
CSV
```

### Phase 3

**既存サービスとの差別化**

```text
独自Tag
Content Pillar
AI画像分類
Caption分析
類似投稿比較
Outlier detection
AI Analyst
```

### Phase 4

```text
Competitor
Business Discovery
UGC
Hashtag
Industry benchmark
Meta Ads
```

です。

---

# 18. 特に「最初から実装すべき収集頻度」

これは仕様として先に決めておくことをおすすめします。

| データ | 推奨 |
|---|---:|
| Account | 1日1回 |
| Followers | 1日1回 |
| 新規Feed/Reel | 最初24hは1時間ごと |
| Feed/Reel 2〜7日 | 1日1回 |
| Feed/Reel 8〜30日 | 1日1回 |
| Story | 30分〜1時間 |
| Competitor profile | 1日1回 |
| Competitor posts | 1日1〜数回 |

SINISも現在、投稿詳細で投稿後1時間単位の初速データを扱っています。 :chatgpt-content-reference{index="35"}

**1時間ごとのデータを永遠に取る必要はありません。**

投稿直後だけ密に取得し、時間が経ったら取得頻度を落とすのが合理的です。

---

# 19. このツールの「中心思想」

調査していて、ここが一番重要だと感じました。

既存分析サービスの多くは、

> 数字を見せる

から、

> 何がよかったか教える

へ進んでいます。

次に作るべきものは、

> **なぜよかったのかを、
> 過去の自分の投稿から学習する**

ツールだと思います。

つまり、

```text
Meta API
       ↓
Performance Data
       ↓
Historical Data
       ↓
Content Metadata
       ↓
Comparison
       ↓
Hypothesis
       ↓
Next Action
```

という構造です。

たとえば最終的に、

> 過去90日の店舗紹介Carousel 18件と比較すると、
> 今回はReachは平均並みですが、
> Save Rateが2.1倍です。
>
> 特に「価格」「住所」「営業時間」を2枚目までに掲載した投稿は
> 同じ傾向があります。
>
> 次回はこの構成を維持しつつ、
> 非フォロワーReachを増やせるか試してみる価値があります。

くらいまで出せる。

これは単にChatGPTに数字を投げるのではなく、

**自分で蓄積したInstagramの構造化データをAIに与える**

からこそ可能になります。

---

## 私が今回の調査から考える最優先機能

優先順位を付けるなら、

**「投稿の時系列Snapshot」  
＋「独自カテゴリによる投稿比較」  
＋「Instagramファネル」**

の3つです。

競合分析やハッシュタグより先です。

特に**投稿時系列SnapshotとStory保存は、
今日保存しなかったデータを半年後に取り戻せない**ので、
UIより先に作るべき部分です。

そして、この方針で進めるのであれば次に、
**実際にMeta Graph APIから取得できる項目をすべて洗い出して、
「API項目 → DB項目 → 派生KPI → 画面」の対応表**
を作るのがよいです。

ここまで作れば、そのまま実装仕様書の土台になります。

------------------
リール動画を投稿した時、APIか何かで動画そのものを得ることはできる？動画を得てから、その動画の長さや画面の切り替わり数などを取れないかなと思って。

------------------
はい、できます。しかも、今回の分析ツールではかなり有力な機能になります。

自分のInstagramプロアカウントのリールであれば、Instagram Graph APIの
メディア取得で`media_url`を取得できます。メディア一覧でも個別メディアでも
`media_url`が取得対象になっていて、動画の場合はそのURLから実体を取得できます。 :chatgpt-content-reference{index="0"}

イメージとしては、

```text
Instagram API
    ↓
Reelのmedia_url取得
    ↓
動画ファイルを一時保存
    ↓
ffprobe / OpenCV などで解析
    ↓
動画特徴量をDB保存
```

という流れです。

例えば、APIでは

```text
GET /{ig-user-id}/media
```

に対して、

```text
id
media_type
media_product_type
media_url
thumbnail_url
timestamp
```

などを取得できます。リールかどうかは`media_product_type`も含めて判定する設計が
よいです。:chatgpt-content-reference{index="1"}

### 動画を取れれば、かなり色々分析できます

まず非常に簡単なのが、

- 動画時間
- 解像度
- FPS
- 縦横比
- ファイルサイズ
- 音声の有無

です。

`ffprobe`なら動画全体をAIに渡す必要すらありません。

さらにOpenCVなどを使えば、

**カット切り替え数**
**平均カット長**
**冒頭3秒以内の切り替え回数**

なども取れます。

これはかなり面白いと思います。

例えば、

```text
Reel A
長さ              18.3秒
カット数          12
平均カット長       1.5秒
最初3秒のカット数   4
```

と、

```text
Reel B
長さ              31.8秒
カット数           5
平均カット長       6.4秒
最初3秒のカット数   1
```

を保存しておき、

```text
動画特徴量
    ×
Instagram Insights
```

を分析できます。

すると、

> 15〜25秒のリールは平均Reachが高い

とか、

> 最初の3秒で3回以上画面が切り替わる動画は、
> 平均視聴時間が長い

とか、

> カットが細かすぎる動画は再生数は多いが保存率が低い

といった分析が可能になります。

これは**Meta APIだけでは絶対に得られない独自データ**なので、
自作ツールのかなり良い差別化になります。

### 「画面の切り替わり数」はどう取るか

最初はAIを使わなくてよいと思います。

動画のフレーム間の画像差分を計算して、

```text
差分が一定値以上
    ↓
scene change
```

と判定します。

FFmpegにもシーンチェンジ検出があります。

概念的には、

```text
frame 100
frame 101
差が小さい
→ 同じscene

frame 150
frame 151
差が大きい
→ cut
```

です。

この方法なら数十秒のReelをかなり高速に処理できます。

ただし、

- フェード
- ズーム
- カメラを振る
- 激しい動き

などでも差分が大きくなるので、

**「編集上のカット数」ではなく
「大きな画面変化回数」**

くらいの指標として扱うのが安全です。

---

さらに一歩進めるなら、動画から一定間隔でフレームを抜き出して、
Visionモデルで解析できます。

例えば、

```text
人物あり
商品あり
料理あり
屋外
文字あり
字幕あり
顔アップ
風景
店舗内
```

などです。

もっとInstagram向けにすると、

```text
冒頭フック
人物登場までの秒数
テロップ開始までの秒数
CTAあり
価格表示あり
場所表示あり
Before/After構成
How-to形式
インタビュー形式
```

のようなメタデータを作れます。

ここまで来ると、

> 「人物が最初の1秒以内に登場するReelは、
> 非フォロワーReachが1.8倍」

のような分析ができるようになります。

これはかなり面白いです。

### さらに「動画時間」は自前解析とAPI指標を組み合わせる

仮に動画が

```text
duration = 20秒
```

で、Instagram Insightsから

```text
average_watch_time = 13秒
```

が取れたなら、

```text
13 / 20 = 65%
```

として、

**平均視聴率 65%**

を自前計算できます。

そして、

```text
duration
cut_count
avg_cut_length
first_3s_cut_count
text_density
people_present
```

と、

```text
views
reach
average_watch_time
shares
saves
follows
```

を結びつけられます。

この設計はかなり強いと思います。

---

ただし、一点だけ注意があります。

`media_url`は**永久保存用のURLだと考えない方がよい**です。

Instagram側のCDN URLなので、そのURL自体をDBに保存して
「半年後もこれで動画を取ろう」とする設計は避け、

```text
投稿検出
 ↓
media_url取得
 ↓
すぐ解析
 ↓
特徴量だけ保存
```

を基本にするのがよいです。

動画そのものまで永久保存する必要はありません。

むしろ、

```text
video_duration = 18.37
cut_count = 12
avg_scene_length = 1.53
first_3s_cut_count = 4
has_audio = true
resolution = 1080x1920
```

のような**分析結果だけ保持する**方が、
ストレージも著作権・個人情報の扱いも軽くなります。

---

今回のInstagram分析ツールなら、私は最初から

```text
media
media_insights
media_snapshots
video_features
```

くらいに分けます。

`video_features`に、/

```text
duration
width
height
fps
scene_count
avg_scene_duration
first_3s_scene_count
has_audio
```

を入れる。

その後AI分析を追加すると、

```text
people_count
has_face
has_text
text_ratio
content_category
hook_type
cta_type
visual_style
```

を追加していく。

**「Instagramの数値」だけでなく、
「その数値を生み出したコンテンツの特徴」までDB化する**
という方向です。

今回調べた既存分析ツールよりも、むしろこの部分を深くやると
面白いツールになると思います。

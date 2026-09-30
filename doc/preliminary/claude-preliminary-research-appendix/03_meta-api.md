# 調査03: Meta 公式 Instagram API で取得できるデータと制約

- 調査日: 2026-09-30
- 参照した最新 API バージョン: Graph API v26.0（2026-07-29 リリース）。ただし Instagram Platform の各リファレンスページは調査時点で「最新版 v25.0」と表示されており、本書のメトリクス表は **v25.0 リファレンス**の記載に基づく
- 一次情報: developers.facebook.com（Instagram Platform docs / Graph API changelog / Platform Terms）。二次情報は明示して補助的に使用
- 表記: メトリクス名・パラメータ名・権限名は英語原文のまま。確認できなかった事項は「未確認」、推測は「推測」と明記

---

## 1. API の種類と違い

### 1.1 現行の 2 系統

| 項目 | Instagram API with Facebook Login（旧 Instagram Graph API） | Instagram API with Instagram Login（2024-07-23 提供開始） |
|---|---|---|
| ホスト | `graph.facebook.com` | `graph.instagram.com`（OAuth は `api.instagram.com/oauth/...`） |
| トークン | Facebook User access token（Page token / System User token も可） | Instagram User access token |
| Facebook ページ | **必須**（プロアカウントをページに接続） | 不要 |
| 基本権限 | `instagram_basic`, `pages_show_list`, `pages_read_engagement` ほか | `instagram_business_basic` ほか |
| インサイト | `instagram_manage_insights` | `instagram_business_manage_insights`（2025-01-21 v22.0 から利用可） |
| Hashtag Search | 可 | **不可** |
| Business Discovery | 可 | **不可**（リファレンスに "Available for the Instagram API with Facebook Login" と明記） |
| タグ付け投稿 (`/tags`) / 広告 / Product Tagging / Partnership Ads | 可 | **不可**（"This API setup cannot access ads or tagging"） |
| `story_insights` Webhook | 可 | **不可**（Facebook Login のみ） |
| `total_likes` / `total_comments` / `total_views`（広告含む合算） | 可 | 不可 |
| メッセージ API | Messenger Platform 経由 | 可（`instagram_business_manage_messages`） |
| 投稿・コメント・メンション | 可 | 可 |

出典:
- https://developers.facebook.com/docs/instagram-platform/ （概要）
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/ （"cannot access ads or tagging"、"does not require a Facebook Page"）
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/migration-guide.md （比較表: Instagram Login は Hashtag search / Product tagging / Partnership Ads 非対応）
- https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery.md
- https://developers.facebook.com/docs/instagram-platform/changelog （2024-07-23、2025-01-21 の項）

### 1.2 Instagram Basic Display API の廃止（2024-12-04）

- 2024-09-04 に告知、**2024-12-04 で全リクエストが失敗**。後継は上記 2 系統
- 影響: **個人（コンシューマー）アカウント向けの Instagram API は消滅**。個人アカウントの自分のメディア取得すら公式 API では不可能になった
- 出典: https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api/ 、changelog 2024-12-04

### 1.3 対象アカウント種別

- 両 API とも **Instagram プロアカウント（ビジネス／クリエイター）専用**。個人アカウントは「対象外」で、メディア一覧もインサイトも取得できない（IG Media リファレンス "Cannot retrieve data for personal Instagram accounts"）
- 分析ツールを作るなら、まず対象アカウントをプロアカウントへ切替える必要がある（無料）
- Facebook Login 系はさらに Facebook ページとの接続が必須。ストーリーズ投稿（Publishing）は Facebook Login 版ドキュメントで「ビジネスアカウントのみ」と記載（クリエイターは不可）
- 出典: https://developers.facebook.com/documentation/instagram-platform/overview.md 、https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/

### 1.4 Graph API バージョンと廃止スケジュール（Graph API changelog より、2026-09-30 時点）

| Version | リリース | 提供終了 |
|---|---|---|
| v26.0 | 2026-07-29 | 未定 |
| v25.0 | 2026-02-18 | 2028-07-29 |
| v24.0 | 2025-10-08 | 2028-02-18 |
| v23.0 | 2025-05-29 | 2027-10-08 |
| v22.0 | 2025-01-21 | 2027-05-20 |
| v21.0 | 2024-10-02 | 2027-01-21 |
| v20.0 | 2024-05-21 | **2026-09-24（既に終了）** |

- 各バージョンは「少なくとも 2 年」サポート。終了したバージョンへの呼び出しは「次に古い利用可能なバージョン」へフォワードされる。バージョン未指定の呼び出しは App Dashboard の既定バージョンが使われるため、**常に明示指定を推奨**
- 出典: https://developers.facebook.com/docs/graph-api/changelog 、https://developers.facebook.com/docs/graph-api/guides/versioning

---

## 2. アカウント（ユーザー）レベルのインサイト `GET /{ig-user-id}/insights`

出典（v25.0 リファレンス）: https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights.md

### 2.1 現行メトリクス表（v25.0）

| metric | period | timeframe | breakdown | metric_type | 備考 |
|---|---|---|---|---|---|
| `reach` | `day` | – | `media_product_type`, `follow_type` | `total_value`, `time_series` | 推定値 |
| `views` | `day` | – | `follower_type`, `media_product_type` | `total_value` | v22.0 で新設（impressions の後継） |
| `accounts_engaged` | `day` | – | – | `total_value` | 推定値 |
| `total_interactions` | `day` | – | `media_product_type` | `total_value` | ブースト投稿分も含む |
| `likes` | `day` | – | `media_product_type` | `total_value` | |
| `comments` | `day` | – | `media_product_type` | `total_value` | |
| `shares` | `day` | – | `media_product_type` | `total_value` | |
| `saves` | `day` | – | `media_product_type` | `total_value` | |
| `replies` | `day` | – | – | `total_value` | ストーリーズ返信 |
| `reposts` | `day` | – | – | `total_value` | 2025-12-03 追加 |
| `follows_and_unfollows` | `day` | – | `follow_type` | `total_value` | フォロワー 100 人未満は返らない |
| `profile_links_taps` | `day` | – | `contact_button_type` | `total_value` | 旧 website_clicks 等の後継 |
| `follower_demographics` | `lifetime` | `this_month`, `this_week` | `age`, `city`, `country`, `gender` | `total_value` | フォロワー 100 人未満は返らない |
| `engaged_audience_demographics` | `lifetime` | `this_month`, `this_week` | `age`, `city`, `country`, `gender` | `total_value` | エンゲージ 100 未満は返らない |
| `impressions` | `day` | – | – | `total_value`, `time_series` | **廃止**（v22.0〜、全バージョン 2025-04-21） |

breakdown の値:
- `media_product_type`: `AD`, `STORY`, `REEL`, `CAROUSEL_CONTAINER`, `POST`, `FEED`
- `follow_type` / `follower_type`: `FOLLOWER`, `NON_FOLLOWER`, `UNKNOWN`
- `contact_button_type`: `BOOK_NOW`, `CALL`, `DIRECTION`, `EMAIL`, `INSTANT_EXPERIENCE`, `TEXT`, `UNDEFINED`
- timeframe: `last_14_days`, `last_30_days`, `last_90_days`, `prev_month` は **v20.0 以降サポート外**。`this_month`（直近 30 日）と `this_week`（直近 7 日）のみ

レスポンス形式: `total_value: { value, breakdowns: [{ dimension_keys, results: [{ dimension_values, value }] }] }`。`time_series` を指定すると `values: [{ value, end_time }]` 形式（`reach` と廃止済み `impressions` のみ対応）。

### 2.2 表に無い（＝現行ドキュメントから消えた）メトリクス

| metric | 状況 |
|---|---|
| `follower_count` (`period=day`, 日次のフォロワー純増) | v25.0 の表に**掲載なし**。ただし制限事項に「`follower_count` と `online_followers` はフォロワー 100 人未満では利用不可」の文が残存。2020-11-10 changelog では「最大 30 日分（従来 2 年）」に短縮と記載。**現行で呼べるかは未確認（実機検証推奨）** |
| `online_followers` (`period=lifetime`, 時間帯別オンラインフォロワー) | 同上。制限事項に「直近 30 日分のみ」の記述が残存。未確認 |
| `profile_views`, `website_clicks`, `email_contacts`, `get_directions_clicks`, `phone_call_clicks`, `text_message_clicks` | v21.0（2024-10-02）で time_series 廃止、全バージョン 2025-01-08。後継は `profile_links_taps`（contact_button_type breakdown）。`profile_views` 相当の後継は現行表に無い（media insights の `profile_visits` はメディア単位で存在） |
| `audience_city/country/gender_age`, `reached_audience_demographics` 等 | v18.0（2023-09-12）以降廃止。後継は `follower_demographics` / `engaged_audience_demographics` |

### 2.3 取得可能な過去期間・since/until

- `since`/`until`: UNIX タイムスタンプ。未指定なら「直近 24 時間」。デモグラ系は `timeframe` が優先される
- **現行 v25.0 リファレンスには「最大レンジ」の明記がない**。旧ドキュメントおよび二次情報（mixedanalytics 等）では「since〜until は最大 30 日」とされ、実装者の間では 30 日刻みで取得するのが通例。→ 実機で確認のこと
- Insights ガイドに **"User Metrics data is stored for up to 90 days"** と明記。つまりアカウント日次メトリクスは**遡れて 90 日**。それ以前は API では復元不能
- データ反映は最大 48 時間遅延。存在しないデータは `0` ではなく空配列で返る
- 出典: 上記リファレンス、https://developers.facebook.com/documentation/instagram-platform/insights.md

### 2.4 フォロワー数などによる制約

- フォロワー 100 人未満: `follows_and_unfollows`, `follower_demographics`（および `follower_count`, `online_followers`）が返らない
- `engaged_audience_demographics` はエンゲージしたアカウントが 100 未満だと返らない
- デモグラは上位 45 件のみ（都市など）
- 一度に 1 ユーザー分のみ取得可。Facebook ページのインサイトとは別物

---

## 3. メディア（投稿）レベルのインサイト `GET /{ig-media-id}/insights`

出典（v25.0）: https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights.md

### 3.1 メディア種別ごとの取得可能メトリクス（v25.0）

| metric | FEED（画像/動画） | REELS | STORY | CAROUSEL_ALBUM（親） | 備考 |
|---|---|---|---|---|---|
| `views` | ○ | ○ | ○ | ○ | v22.0 新設 |
| `reach` | ○ | ○ | ○ | ○ | |
| `likes` | ○ | ○ | – | ○ | オーガニックのみ |
| `comments` | ○ | ○ | – | ○ | オーガニックのみ |
| `shares` | ○ | ○ | ○ | ○ | |
| `saved` | ○ | ○ | – | ○ | |
| `reposts` | ○ | ○ | ○ | ○ | 2025-12-03 追加 |
| `total_interactions` | ○ | ○ | ○ | ○ | |
| `profile_visits` | ○ | – | ○ | ○ | |
| `profile_activity`（breakdown `action_type`: BIO_LINK_CLICKED, CALL, DIRECTION, EMAIL, OTHER, TEXT） | ○ | – | ○ | ○ | |
| `follows` | ○ | – | ○ | ○ | |
| `ig_reels_avg_watch_time` | – | ○ | – | – | ミリ秒 |
| `ig_reels_video_view_total_time` | – | ○ | – | – | ミリ秒 |
| `reels_skip_rate` | – | ○ | – | – | 2025-12-03 追加、冒頭 3 秒でスキップした割合 |
| `crossposted_views` | – | ○ | – | – | IG+FB 合算再生 |
| `facebook_views` | ○ | ○ | ○ | – | **Facebook Login のみ** |
| `navigation`（breakdown `story_navigation_action_type`: SWIPE_FORWARD, TAP_BACK, TAP_EXIT, TAP_FORWARD） | – | – | ○ | – | 旧 taps_forward/taps_back/exits の後継 |
| `replies` | – | – | ○ | – | **欧州・日本のユーザーが作成したストーリーズは常に 0** |
| `link_clicks` | – | – | ○ | – | 2026-06-22 追加、**Facebook Login のみ** |
| `impressions` | ○(廃止) | – | ○ | – | 2024-07-02 以降に作成されたメディアでは廃止 |
| `total_likes` / `total_comments` / `total_views` | ○ | ○ | `total_views` のみ | – | 広告・ブースト分を含む合算。**Facebook Login のみ**（2026-04-22 追加） |

- **カルーセルの子メディア**（children）にはインサイト無し（"Insights data is not available for any media within an Instagram Media album"）
- `period` パラメータ: `day`, `week`, `days_28`, `month`, `lifetime`, `total_over_range` が列挙されているが、メディアインサイトは実質 `lifetime` 累計値
- 廃止済み: `engagement`, `video_views`（v21.0）, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`（v22.0）, `exits`, `taps_forward`, `taps_back`, `carousel_album_*`（v18.0）

### 3.2 ストーリーズの制約

- **ストーリーズのメトリクスは 24 時間のみ取得可**（ハイライトに追加しても API からは消える）。24 時間以内にポーリングするか、`story_insights` Webhook（Facebook Login のみ、期限切れ時に送信）で受け取る
- Webhook ペイロード（Graph API Webhooks reference）: `impressions`, `reach`, `taps_forward`, `taps_back`, `exits`, `replies`, `media_id`。**5 未満の値は `-1`** で返る
- 閲覧者 5 人未満のストーリーズは error code 10 "Not enough viewers for the media to show insights"
- `/stories` エッジは直近 24 時間のストーリーズ ID のみ返す。ライブ配信は含まれない
- 出典: media insights リファレンス、https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/stories.md 、https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram/

### 3.3 保持期間・遅延

- "Metrics data is stored for up to 2 years"（メディアインサイトは 2 年）
- 反映は最大 48 時間遅延
- ライブ動画のインサイトは配信中のみ

---

## 4. その他のエンドポイント

### 4.1 メディア一覧・詳細

- `GET /{ig-user-id}/media`: 直近 **最大 10,000 件**。`since`/`until`（時間ベースページング）、カーソルページング対応。ストーリーズは含まれない（`/stories` を使う）
- IG Media フィールド（v25.0）: `id`, `alt_text`, `caption`, `comments_count`, `is_comment_enabled`, `is_shared_to_feed`, `like_count`, `media_audio_type`（2026-06-01 追加）, `media_product_type`（AD/FEED/STORY/REELS）, `media_type`（CAROUSEL_ALBUM/IMAGE/VIDEO）, `media_url`, `owner`, `permalink`, `shortcode`, `thumbnail_url`, `timestamp`, `username`, `view_count`（2025-06-16 追加）, `reposts_count`, `saved_count`, `shares_count`（2026-04-22 追加）, `total_like_count`, `total_comments_count`, `total_views_count`（FB Login）, `is_ai_generated`（2026-06-22）, `boost_eligibility_info`, `copyright_check_information`, `legacy_instagram_media_id`
- エッジ: `children`, `comments`, `insights`, `collaborators`, `product_tags`
- 制約: `like_count` は所有者が「いいね数非表示」にしていると返らない／著作権フラグ付きメディアは `media_url` が省略／カルーセル子メディアは `permalink`, `reposts_count`, `saved_count`, `shares_count` 無し／`media_url` は有効期限付き URL（期限は未確認）／ライブは配信中のみ
- 出典: https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media.md 、https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md

### 4.2 IG User フィールド

- Public（business_discovery でも読める）: `id`, `username`, `biography`, `website`, `followers_count`, `media_count`, `profile_picture_url`（リファレンス表では Public 表記が確認できず。business_discovery で取れるかは未確認）, `alt_text`
- Non-public: `name`, `follows_count`, `has_profile_pic`, `is_published`, `shopping_product_tag_eligibility`, `legacy_instagram_user_id`
- エッジ: `media`, `stories`, `tags`, `mentioned_media`, `mentioned_comment`, `mentions`, `insights`, `live_media`, `content_publishing_limit`, `business_discovery`, `recently_searched_hashtags`, `connected_threads_user`, `instagram_backed_threads_user`, `collaboration_invites`, `collaborative_media`（FB Login）, `available_catalogs`, `catalog_product_search`, `product_appeal`, `upcoming_events`
- **フォロワー一覧・フォロー中一覧を返すエンドポイントは存在しない**（数値のみ）
- 出典: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user.md

### 4.3 コメント・メンション・タグ付け

- IG Comment: `id`, `from`, `hidden`, `like_count`, `media`, `parent_id`, `text`, `timestamp`, `user`, `username`。GET／`hide` で非表示・再表示／DELETE（メディア所有者のみ）／`/replies` で返信取得・作成。年齢制限メディアやライブ配信のコメントは読めない。権限: `instagram_manage_comments`（FB Login）／`instagram_business_manage_comments`（IG Login）
- Like API（2026-04-22）: 投稿・リール・コメントへの like/unlike。権限 `instagram_manage_engagement`
- `mentioned_media` / `mentioned_comment`: キャプションやコメントで @メンションされたメディア。**ストーリーズのメンションは非対応**、非公開アカウント起点の Webhook は届かない
- `/tags`: 他ユーザーにタグ付けされたメディア（非公開メディアは返らない）。**Facebook Login のみ**（IG Login は "cannot access tagging"。ただし IG Login の Mentions ガイドに `GET /<IG_ID>/tags` の記述があり矛盾 → 未確認）
- Webhooks: `comments`, `live_comments`, `mentions`, `story_insights`, `messages` 系など 14 フィールド。**アプリが Live モードかつ Advanced Access**、対象アカウントが公開であることが必要
- 出典: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md 、.../ig-user/mentioned_media.md 、.../ig-user/tags.md 、https://developers.facebook.com/documentation/instagram-platform/webhooks.md

### 4.4 Hashtag Search（**Facebook Login のみ**）

- `GET /ig_hashtag_search?user_id&q=` → hashtag ID（`id`, `name`）／`GET /{hashtag-id}/top_media`／`GET /{hashtag-id}/recent_media`／`GET /{ig-user-id}/recently_searched_hashtags`
- 制約（公式）:
  - **ローリング 7 日間で最大 30 ユニークハッシュタグ**（アプリ利用者アカウント単位）
  - 公開メディアのみ。広告・ブースト投稿は除外。ストーリーズ非対応。絵文字クエリ不可。センシティブ判定タグは汎用エラー
  - `recent_media` は**クエリ時点から 24 時間以内に公開されたメディアのみ**、時系列順は保証されない。1 ページ最大 50 件、`after` カーソルのみ
  - 取得フィールド: `caption`, `children`, `comments_count`, `id`, `like_count`, `media_type`, `media_url`, `permalink`, `timestamp`。**`username`（投稿者）は取得不可**。`like_count` はいいね数非表示なら省略
  - 発見したメディアへのコメント不可、メディア ID を直接 GET することも不可
- 必要: `instagram_basic` ＋ 機能 **Instagram Public Content Access**（ドキュメント上は App Review 必須と記載）
- Business Discovery / Hashtag Search は BUC ではなく **Platform Rate Limit**（200 calls/時 × ユーザー数）の対象
- 出典: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search.md 、.../reference/ig-hashtag/recent-media.md 、.../top-media.md 、.../ig-hashtag.md

### 4.5 Business Discovery（競合分析、**Facebook Login のみ**）

- `GET /{自分の ig-user-id}?fields=business_discovery.username({相手}){...}`
- 取得可: 相手の Public フィールド（`id`, `username`, `biography`, `website`, `followers_count`, `media_count`; `profile_picture_url` は未確認）と `media{ id, caption, comments_count, like_count, media_type, media_product_type, media_url, permalink, timestamp, username, children, view_count }`（`view_count` は 2025-06-16 追加、リールのみ、有料＋オーガニック合算）
- 取得不可: `follows_count`, `name`（Non-public）、ストーリーズ、インサイト（reach/saves 等）、フォロワー一覧、年齢制限アカウント、個人アカウント、非公開アカウント
- 発見したメディア ID の直接 GET は不可
- 権限: `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`
- 出典: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery.md 、ig-user.md

### 4.6 Content Publishing API

- 対応: 画像（**JPEG のみ**）、動画、リール、ストーリーズ（画像/動画）、カルーセル（最大 10 件）。メディアは公開 URL でホストする必要あり（Resumable Upload も可）。`alt_text`（2025-03-24）、`is_ai_generated`、`trial_params`（トライアルリール）、`branded_content_sponsor_ids`/`is_paid_partnership`、Audio API（2026-06-01）
- **予約投稿の機能は API に無い**（自前スケジューラで時刻になったら publish する。ガイドも「予約を許すならレート制限を自前で管理せよ」と記載）
- 上限: ガイドは「24 時間移動窓で **100 件**（カルーセルは 1 件）」、`content_publishing_limit` リファレンスは `quota_total` "currently 50" と記載 → **食い違いあり、未確認**。実機で `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config` を確認すること
- 2025-12-03 から `DELETE /{ig-media-id}` 可（権限 `instagram_manage_contents`）
- 権限: `instagram_content_publish`（FB Login）／`instagram_business_content_publish`（IG Login）
- 出典: https://developers.facebook.com/documentation/instagram-platform/content-publishing.md 、.../ig-user/content_publishing_limit.md

### 4.7 Threads API との関係

- 完全に別プロダクト。ホスト `graph.threads.net`（`graph.threads.com`）、バージョンは `v1.0` 固定、権限は `threads_basic`, `threads_manage_insights`, `threads_content_publish` 等、トークンも別（短期 1 時間→長期 60 日）
- Threads インサイト: ユーザー `views`(時系列), `likes`, `replies`, `reposts`, `quotes`, `clicks`, `followers_count`, `follower_demographics`（100 フォロワー以上）。投稿 `views`, `likes`, `replies`, `reposts`, `quotes`, `shares`。`since/until` は **2024-04-13 以降のみ**
- IG User に `connected_threads_user` / `instagram_backed_threads_user` エッジがあり紐付けは可能
- 出典: https://developers.facebook.com/docs/threads 、https://developers.facebook.com/docs/threads/insights 、https://developers.facebook.com/docs/threads/overview

---

## 5. 制約・運用面

### 5.1 レート制限

| 対象 | 制限 |
|---|---|
| Instagram Platform 一般（BUC: Business Use Case） | **24 時間あたり 4800 × インプレッション数**（対象プロアカウントのコンテンツが直近 24 時間に表示された回数）。超過時 error code 80002。ヘッダ `X-Business-Use-Case-Usage`（`call_count`, `total_cputime`, `total_time`, `estimated_time_to_regain_access`） |
| Business Discovery / Hashtag Search | Platform Rate Limit: **1 時間あたり 200 × ユーザー数**（アプリ全体）。error code 4/17/32/613。ヘッダ `X-App-Usage` |
| Hashtag | 7 日で 30 ユニークタグ |
| Publishing | 24 時間で 100（または 50、未確認） |
| メッセージ系 | Conversations 2 calls/秒、Send 100 calls/秒 など |

- 注意: フォロワーが少なく表示回数がゼロに近いアカウントでは BUC の枠が極端に小さくなり得る（推測）。分析ツールはポーリング頻度を控えめに設計すべき
- 出典: https://developers.facebook.com/docs/graph-api/overview/rate-limiting 、https://developers.facebook.com/documentation/instagram-platform/overview.md

### 5.2 アクセストークン

| 種別 | 有効期限 | 備考 |
|---|---|---|
| 認可コード | 1 時間 | 1 回のみ使用可 |
| 短期トークン（両系統） | 1 時間 | |
| 長期 Instagram User token（IG Login） | **60 日** | `GET graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=...&access_token=...`（`expires_in`=5184000）。更新は `GET /refresh_access_token?grant_type=ig_refresh_token&access_token=...`、**24 時間以上経過した有効なトークンのみ**更新可。60 日間使わず失効したら再ログイン |
| 長期 Facebook User token | 約 60 日 | `GET oauth/access_token?grant_type=fb_exchange_token...`。失効後は再ログイン |
| 長期 Page token | **無期限** | 長期 User token から `GET /{user-id}/accounts` で取得。Instagram Graph API の多くの呼び出しに使える |
| System User token（Facebook Login for Business / BISU） | 既定は**無期限**（`set_token_expires_in_60_days=true` で 60 日） | Business 型アプリ＋ビジネスポートフォリオが前提。サーバー間バッチ向け |

- 長期トークン交換は app secret を使うため**必ずサーバー側で**実行
- 出典: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login.md 、.../reference/access_token.md 、https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived 、https://developers.facebook.com/docs/facebook-login/facebook-login-for-business

### 5.3 権限と App Review

権限対応表:

| 用途 | Facebook Login | Instagram Login |
|---|---|---|
| 基本情報・メディア | `instagram_basic` + `pages_show_list` + `pages_read_engagement` | `instagram_business_basic` |
| インサイト | `instagram_manage_insights` | `instagram_business_manage_insights` |
| コメント | `instagram_manage_comments` | `instagram_business_manage_comments` |
| 投稿 | `instagram_content_publish` | `instagram_business_content_publish` |
| DM | `instagram_manage_messages` | `instagram_business_manage_messages` |
| Like | `instagram_manage_engagement` | 未確認 |
| Business Manager 経由でページ権限がある場合 | + `ads_management` or `ads_read` / `business_management` | – |

- **Standard Access**（App Review 不要）: 「アプリで役割（Admin/Developer/Tester）を持つユーザー」および「自分が所有・管理するプロアカウント」を対象にする場合。Business/Consumer/Gaming 型アプリで全権限・機能が自動付与。Instagram Platform の App Review ページも "single-business apps with Standard Access: App Review Not required" と明記
- **Advanced Access**（App Review 必須、2023-02-01 以降ビジネス認証が求められる場合あり）: 自分が所有・管理しないアカウントを扱う場合（Tech Provider）。**Webhooks は Advanced Access ＋ Live モード必須**
- 「自分のプロアカウントだけを分析」する用途なら、Business 型アプリを作成し、自分を Admin/Developer（Instagram Login の場合は Instagram Tester 役割で招待し Instagram アプリ側で承認 — この手順の公式記述は本調査では未確認、App Dashboard の通例に基づく推測）にして開発モードのまま運用可能
- ただし Hashtag Search の「Instagram Public Content Access」機能はドキュメント上 App Review が必要と記載されており、開発モードで動くかは未確認
- 出典: https://developers.facebook.com/docs/graph-api/overview/access-levels 、https://developers.facebook.com/documentation/instagram-platform/app-review.md 、https://developers.facebook.com/docs/permissions

### 5.4 Platform Terms / データ保持

- Meta Platform Terms 3.d: Platform Data は「不要になったとき／サービス終了時／Meta の要請／ユーザーの削除要請やアカウント消失／法令」のいずれかで **"as soon as reasonably practicable"（可及的速やかに）削除**。具体的な日数の規定は無い（未確認: 一部ガイドラインに 90 日の言及があるかは確認できず）
- 3.a: Platform Data の販売・ライセンス禁止、同意なきプロファイリング禁止、承認済み目的以外の処理禁止、リバースエンジニアリング・再識別禁止
- 6.a: 業界標準以上のセキュリティ対策
- 自分のアカウントの分析データを自分の DB に蓄積することは「正当なビジネス目的」の範囲内と解釈できる（推測）。他人（Business Discovery / Hashtag）のデータの長期保存・第三者提供は慎重に
- 出典: https://developers.facebook.com/terms/dfc_platform_terms/

### 5.5 スクレイピングのリスク

- Meta 利用規約 3.2: 「事前の許可なく自動化手段で製品のデータにアクセス・取得すること、アクセス許可のないデータへのアクセスを試みることは禁止」。違反時はコンテンツ削除・アクセス制限・アカウント停止
- Instagram 利用規約（help.instagram.com/581066165581870）も同旨の条項（"collecting information in an automated way without our express permission" の禁止）を含むが、ページが JS 描画のため本調査では本文を取得できず **未確認**
- 実務上のリスク: 分析対象の本人アカウントが凍結される、IP ブロック、法的措置。非公式 API（内部エンドポイント）や Selenium 系ツールは規約違反。**公式 API で取れない値（他人のフォロワー一覧、他人の保存数など）を取ろうとしない**のが安全
- 出典: https://www.facebook.com/legal/terms

---

## 6. API 以外で公式に得られるデータ（Download Your Information）

- Accounts Center →「あなたの情報をエクスポート」から申請。**形式 HTML / JSON**、**期間指定**、**メディア画質**を選択可。準備に**最大 30 日**、ダウンロード可能期間は**4 日**、ZIP はパスワード保護（Meta 公式ヘルプ）
- 内容（二次情報。dontfollowback.com、safeunfollow.app、pirg.org 等）: `connections/followers_and_following/followers_1.json`, `following.json`（大規模アカウントは分割）、投稿・ストーリーズ・コメント・いいね・DM・プロフィール変更履歴・検索履歴・広告関連など。JSON は `string_list_data: [{ value, href, timestamp }]` 形式
- **アカウントインサイト（リーチ推移など）がエクスポートに含まれるかは未確認**（検索結果では確認できず）
- 使い道: API では取れない**フォロワー/フォロー中の一覧**の定点取得（手動・月次程度）、過去投稿のメタデータ補完。自動化はできないので DB への取り込みは手動インポート機能として設計
- 出典: https://www.facebook.com/help/instagram/181231772500920 （公式、期間・形式・30 日・4 日）、二次: https://pirg.org/resources/how-to-request-and-download-instagram-data/ 、https://fans.walter-labs.com/blog/where-are-followers-and-following-in-instagram-data-export/

---

## 7. 無料でどこまでできるか

- API 利用料: **無料**（Graph API / Instagram Platform に課金は無い）
- 必要なもの: Meta 開発者アカウント（無料）、Business 型 Meta アプリ（無料）、Instagram プロアカウント（無料）
  - Facebook Login 系: **Facebook ページ**（無料）＋ページとプロアカウントの接続。Business Manager／ビジネスポートフォリオは Advanced Access や System User token を使う場合のみ必要
  - Instagram Login 系: Facebook ページ不要。ただし Hashtag Search / Business Discovery / タグ付け / story_insights Webhook が使えない
- ビジネス認証: Advanced Access（他人のアカウントを扱う）のときのみ。書類提出が必要だが無料
- 結論: 「自分のプロアカウント＋競合の公開情報＋ハッシュタグ」まで全部やるなら **Facebook Login 系 ＋ Facebook ページ接続** が必要。自分のアカウントのインサイトだけなら Instagram Login 系で足りる

---

## 8. まとめ

### 8.1 自分のプロアカウントについて取れるデータ（全体像）

| 分類 | 取れるもの | 粒度・遡及 | 系統 |
|---|---|---|---|
| プロフィール | `followers_count`, `follows_count`, `media_count`, `biography`, `website`, `name`, `username`, `profile_picture_url` | 現在値のみ（履歴なし） | 両方 |
| アカウント日次 | `reach`, `views`, `accounts_engaged`, `total_interactions`, `likes`, `comments`, `shares`, `saves`, `replies`, `reposts`, `follows_and_unfollows`, `profile_links_taps`（各 breakdown 付き） | `period=day`、保存 90 日、1 クエリ最大 30 日（要確認） | 両方 |
| オーディエンス属性 | `follower_demographics`, `engaged_audience_demographics`（age/gender/city/country） | `this_week`/`this_month` の現在スナップショットのみ | 両方（100 フォロワー以上） |
| 時間帯別オンライン | `online_followers` | 直近 30 日（現行可否は未確認） | 両方 |
| メディア一覧 | 全フィールド（caption, permalink, like_count, comments_count, view_count, saved_count, shares_count, reposts_count 等） | 直近 10,000 件、`since/until` 指定可 | 両方 |
| メディアインサイト | FEED: views/reach/likes/comments/shares/saved/reposts/total_interactions/profile_visits/profile_activity/follows。REELS: +avg_watch_time/total_time/skip_rate/crossposted_views。STORY: views/reach/shares/replies/navigation/profile_*/follows/link_clicks | 累計値、保存 2 年。**ストーリーズは 24 時間のみ** | 両方（`facebook_views`, `link_clicks`, `total_*` は FB Login） |
| コメント | 本文・投稿者・いいね数・返信、非表示/削除/返信操作 | 全期間（メディアが残る限り） | 両方 |
| メンション・タグ | `mentioned_media`, `mentioned_comment`（ストーリーズ除く）、`/tags` | 現在返せる範囲 | tags は FB Login |
| Webhook | comments, mentions, story_insights（FB Login）, messages（IG Login） | リアルタイム | Live＋Advanced Access |
| 投稿 | 画像/動画/リール/ストーリーズ/カルーセルの即時公開、削除 | 24h 上限 100 or 50 | 両方 |
| フォロワー一覧 | **API 不可**。DYI エクスポートのみ | 手動 | – |

### 8.2 他人（競合）のアカウントについて取れるデータ

| 手段 | 取れるもの | 取れないもの | 制約 |
|---|---|---|---|
| Business Discovery（FB Login） | `username`, `id`, `biography`, `website`, `followers_count`, `media_count`（`profile_picture_url` 未確認）、メディアの `caption`, `like_count`, `comments_count`, `view_count`(リール), `media_type`, `media_product_type`, `permalink`, `timestamp`, `media_url`, `children` | `follows_count`, `name`, ストーリーズ、インサイト（reach/saves/shares 等）、フォロワー一覧、非公開/個人/年齢制限アカウント | Platform Rate Limit（200/時×ユーザー数）。プロアカウントのみ対象 |
| Hashtag Search（FB Login） | タグ付き公開メディアの `caption`, `like_count`, `comments_count`, `media_type`, `media_url`, `permalink`, `timestamp`, `children` | **投稿者 `username`**、ストーリーズ、広告、非公開、インサイト | 7 日 30 タグ、recent_media は 24 時間以内、50 件/ページ、Instagram Public Content Access 必要 |
| Webhook / mentions / tags | 自分に言及・タグ付けした他人のメディア基本情報 | 相手のインサイト | 非公開アカウントは不可 |
| Threads API | 自分の Threads のみ（他人はキーワード検索の公開投稿） | – | 別トークン |

競合分析としてできること: フォロワー数・投稿数の**日次スナップショット**による推移把握、投稿ごとの like/comments/view_count によるエンゲージメント率推定（`followers_count` で割る）、投稿頻度・種別・時間帯の分析、ハッシュタグ上位投稿の傾向。できないこと: 競合のリーチ・保存数・シェア数・ストーリーズ・フォロワー属性。

### 8.3 日次で蓄積すべきデータ（API では遡れないもの） — DB 設計向け

| 優先 | データ | 理由 | 推奨キー/カラム |
|---|---|---|---|
| ★★★ | 自アカウントの `followers_count`, `follows_count`, `media_count`（IG User フィールド） | 現在値しか返らず履歴は API に無い。`follower_count` メトリクスの現行可否も不明 | `account_id, snapshot_date, followers_count, follows_count, media_count` |
| ★★★ | アカウント日次インサイト（`reach`, `views`, `accounts_engaged`, `total_interactions`, `likes`, `comments`, `shares`, `saves`, `replies`, `reposts`, `follows_and_unfollows`, `profile_links_taps`）＋ breakdown 別値 | **保存 90 日**で消える。1 クエリ 30 日制限（要確認） | `account_id, metric, date, breakdown_key, breakdown_value, value` |
| ★★★ | ストーリーズのメディア情報とインサイト（`views`, `reach`, `replies`, `navigation` 内訳, `shares`, `profile_visits`, `follows`, `link_clicks`） | **24 時間で消滅**。`/stories` を数時間ごとにポーリングし、期限直前の値を確定値として保存。FB Login なら `story_insights` Webhook も併用 | `media_id, account_id, posted_at, fetched_at, metric, value` |
| ★★☆ | `follower_demographics` / `engaged_audience_demographics`（age/gender/city/country, this_week/this_month） | 現在のスナップショットのみで履歴なし | `account_id, snapshot_date, metric, timeframe, dimension, key, value` |
| ★★☆ | `online_followers`（時間帯別） | 直近 30 日のみ | `account_id, date, hour, value` |
| ★★☆ | 各投稿の `like_count`, `comments_count`, `view_count`, `saved_count`, `shares_count`, `reposts_count` ＋メディアインサイト累計値の**日次スナップショット** | 累計値のみ返るため「投稿後 N 日の伸び」は自前差分が必要。インサイト自体は 2 年保存されるが、時系列は残らない | `media_id, snapshot_date, metric, value` |
| ★★☆ | 競合の `followers_count`, `media_count`（Business Discovery） | 現在値のみ | `target_username, snapshot_date, followers_count, media_count` |
| ★☆☆ | 競合の各投稿 `like_count`, `comments_count`, `view_count` スナップショット | 推移を見るなら日次差分が必要 | `target_username, media_id, snapshot_date, ...` |
| ★☆☆ | ハッシュタグ `recent_media` / `top_media` の結果 | recent は 24 時間分しか返らない。30 タグ/7 日制限があるので対象タグは絞る | `hashtag_id, fetched_at, media_id, like_count, comments_count, caption, timestamp` |
| ★☆☆ | コメント本文 | 削除・非表示で消える。感情分析などするなら保存 | `comment_id, media_id, ...` |
| 手動 | フォロワー/フォロー中一覧（DYI エクスポート） | API 不可 | `account_id, export_date, username, followed_since` |

設計上の注意:
- メトリクス名は 2024〜2026 に大きく改名されている（impressions→views、taps_forward→navigation 等）。DB は `metric` を文字列で持ち、**API バージョンと取得時刻**を一緒に保存しておくと後の改名に耐えられる
- インサイトは最大 48 時間遅れて確定するため、日次値は「取得日から 2〜3 日前まで再取得して上書き」する運用にする
- 欠損は `0` でなく空配列で返る点に注意（NULL と 0 を区別）
- ストーリーズの `replies` は日本のアカウントでは常に 0

### 8.4 2024〜2026 年の主な変更点タイムライン

| 日付 | 変更 |
|---|---|
| 2024-05-21 | v20.0。デモグラの `last_14_days`/`last_30_days`/`last_90_days`/`prev_month` timeframe 廃止（`this_week`/`this_month` のみ） |
| 2024-07-02 | 以降に作成されたメディアで `impressions` 廃止 |
| 2024-07-23 | **Instagram API with Instagram Login** 提供開始（`graph.instagram.com`、Facebook ページ不要） |
| 2024-09-04 | Basic Display API 廃止告知 |
| 2024-10-02 | v21.0。`video_views` 廃止。`profile_views`, `website_clicks`, `email_contacts`, `get_directions_clicks`, `phone_call_clicks`, `text_message_clicks` の time_series 廃止（全バージョン 2025-01-08） |
| 2024-12-04 | **Basic Display API 停止**。個人アカウント向け API 消滅 |
| 2025-01-21 | v22.0。`views` メトリクス新設。`impressions`, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count` 廃止（全バージョン 2025-04-21）。Instagram Login でインサイト取得可能に。Instagram v1.0 エンドポイント廃止（2025-05-20） |
| 2025-01-27 | Instagram Login の旧スコープ廃止（`instagram_business_*` に統一） |
| 2025-03-24 | `alt_text` 追加 |
| 2025-04-08 | Meta oEmbed Read 機能へ移行（旧 oEmbed は 2025-11-03 廃止） |
| 2025-05-29 | v23.0 |
| 2025-06-16 | IG Media `view_count` 追加（Business Discovery、リール） |
| 2025-10-08 | v24.0 |
| 2025-12-03 | メディア `reels_skip_rate`, `reposts`, `crossposted_views`, `facebook_views`／ユーザー `reposts` 追加。`DELETE /{ig-media-id}`、トライアルリール、コラボ招待 API |
| 2026-02-18 | v25.0 |
| 2026-04-22 | IG Media `reposts_count`, `saved_count`, `shares_count`、`total_like_count`/`total_comments_count`/`total_views_count`（FB Login）。`facebook_views` をフィード/リール/ストーリーズへ拡張。Like API（`instagram_manage_engagement`）。Partnership Ads ラベル |
| 2026-06-01 | Instagram Audio API、`media_audio_type` |
| 2026-06-22 | `is_ai_generated`、ストーリーズ `link_clicks`（FB Login） |
| 2026-07-29 | v26.0 |
| 2026-09-24 | v20.0 提供終了 |

出典: https://developers.facebook.com/docs/instagram-platform/changelog 、https://developers.facebook.com/docs/graph-api/changelog

---

## 9. 未確認事項（実機検証が必要）

1. `follower_count`（period=day）と `online_followers` が v25/v26 で現在も返るか
2. ユーザーインサイトの `since`〜`until` の最大レンジ（30 日か）
3. Content Publishing の 24 時間上限（100 か 50 か）
4. `profile_picture_url` が Business Discovery で取れるか
5. Instagram Login で `/tags` が使えるか（ドキュメント間で矛盾）
6. Hashtag Search の「Instagram Public Content Access」が開発モード（Standard Access）で動作するか
7. Download Your Information にアカウントインサイトが含まれるか
8. Instagram Tester 招待の正確な手順（公式ページを取得できず）
9. Instagram 利用規約の自動収集禁止条項の原文（Meta 利用規約 3.2 で代替確認済み）

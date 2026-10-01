# R0: Meta API の実機検証結果

| 項目 | 内容 |
|---|---|
| 実施日 | 2026-09-30（1〜3 章）、2026-10-01（4 章の追加検証） |
| 対象 | 本人管理の Instagram プロアカウント 1 つ（Facebook Login 方式、ユーザーアクセストークン） |
| Graph API | v25.0 |
| 方法 | 収集ワーカーの `verify-api` コマンド（`apps/worker/src/commands/verify-api.ts`）。指標を 1 つずつ要求し、取得の可否とエラー内容を記録した |
| 要件 | 要件定義 F-COL-00、確認事項 C1 |

この文書には、アカウントの ID、ユーザー名、指標の値を含めていない（NF-SEC-07）。詳細はローカルの `.local/api-verification/` にある。

---

## 1. 要件に影響する発見

事前調査（`doc/preliminary/`）の記述と異なる点、または調査では未確認だった点。

| No | 発見 | 事前調査の記述 | 要件への影響 |
|---|---|---|---|
| V1 | **アカウントの日次指標は 2 年前まで取得できる**。reach の日次推移と、views などの 1 日分の合計値の両方で確認した。2 年より前を指定すると「Metrics data is available for the last 2 years」のエラーになる | 90 日まで | 初回接続時のバックフィルを 90 日から最大 2 年に広げる（F-COL-12） |
| V2 | **1 回のリクエストで指定できる期間は最大 30 日** | 30 日（二次情報） | バックフィルは 30 日ずつに分けて取得する |
| V3 | **views などの total_value 型の指標は、期間の合計値しか返らない**。日ごとの値にするには 1 日ずつ取得する必要がある。time_series で日ごとに取れるのは reach だけ | 未確認 | 日次指標とバックフィルは 1 日 1 リクエストの設計にする。2 年分のバックフィルはリクエスト数が多いので、数日に分けて進める |
| V4 | **API の「日」は米国太平洋時間の 0 時で区切られる**。end_time の時刻部分が T07:00:00+0000（太平洋夏時間の 0 時）だった。冬時間は T08:00:00+0000 になる見込み | UTC-7 で判定される模様（二次情報） | 日次指標は日本時間の日付に変換できない。API の日付（太平洋時間）のまま保存し、画面でその旨を示す（5.5 章） |
| V5 | **follower_count（1 日ごとの新規フォロワー数）は直近 30 日しか取れない**。30 日より前を指定するとエラー | 最大 30 日（2020 年の changelog） | 毎日保存する。バックフィルは 30 日まで |
| V6 | **online_followers（時間帯別のオンラインフォロワー数）は、成功するが中身が空** | 直近 30 日（現行可否は未確認） | 時間帯別オンライン数のヒートマップ（F-UI-41）は API では作れない。自分の投稿の時刻別の成果で代替する |
| V7 | **リールでは profile_visits、profile_activity、follows が取れない**。エラー「does not support ... for this media product type」。フィード画像では取れる | 資料間で記載が揺れる | リールは投稿単位のファンネル（リーチ → プロフィール訪問 → フォロー）を作れない。リールの評価は視聴系の指標とシェア・保存で行う |
| V8 | **views の内訳の指定は follow_type**。follower_type はエラーになる | follower_type | 実装では follow_type を使う |
| V9 | **自分の投稿では view_count フィールドが使えない**（Business Discovery 専用というエラー）。saved_count は値が返らない。total_views_count、shares_count、reposts_count は取れる | 取得可 | 閲覧数と保存数はメディアのインサイトから取る |
| V10 | **engaged_audience_demographics（反応したユーザーの属性）は、成功するが結果が空**。反応したアカウント数が少ないためと推測 | 100 未満だと返らない | 週次で収集は続け、取れたときだけ表示する |

## 2. 取得できた項目

### 2.1 プロフィール

id、username、name、biography、website、followers_count、follows_count、media_count、profile_picture_url のすべてを取得できた。

### 2.2 アカウントの日次指標（metric_type=total_value、period=day）

| 指標 | 内訳 | 結果 |
|---|---|---|
| reach | なし、follow_type、media_product_type | 取得できた |
| views | なし、follow_type、media_product_type | 取得できた（follower_type は不可） |
| accounts_engaged | なし | 取得できた |
| total_interactions | なし、media_product_type | 取得できた |
| likes、comments、shares、saves、replies、reposts | なし | 取得できた |
| follows_and_unfollows | follow_type | 取得できた |
| profile_links_taps | contact_button_type | 取得できた |
| follower_count | なし（period=day） | 直近 30 日のみ取得できた |
| online_followers | なし（period=lifetime） | 中身が空 |

### 2.3 オーディエンス属性（timeframe=this_month）

| 指標 | 年齢 | 性別 | 国 | 都市 |
|---|---|---|---|---|
| follower_demographics | 取得できた | 取得できた | 取得できた | 取得できた（上位 45 件） |
| engaged_audience_demographics | 空 | 空 | 空 | 空 |

### 2.4 メディアのインサイト

| 指標 | リール | フィード画像 | ストーリーズ |
|---|---|---|---|
| views、reach、shares、reposts、total_interactions | 取得できた | 取得できた | 取得できた |
| likes、comments、saved | 取得できた | 取得できた | 対象外 |
| profile_visits、profile_activity、follows | **取れない** | 取得できた | 取得できた |
| ig_reels_avg_watch_time、ig_reels_video_view_total_time | 取得できた（ミリ秒） | 対象外 | 対象外 |
| reels_skip_rate | 取得できた（パーセント） | 対象外 | 対象外 |
| crossposted_views、facebook_views | 取得できた | facebook_views はエラー | 未検証 |
| replies | 対象外 | 対象外 | 取得できた（値は 0。日本のアカウントの仕様どおり） |
| navigation（tap_forward、tap_back、tap_exit、swipe_forward） | 対象外 | 対象外 | 取得できた |
| link_clicks | 対象外 | 対象外 | 取得できた |

取得できた指標は、まとめて 1 回のリクエストで取得できた（リール 13 指標、フィード画像 10 指標、ストーリーズ 9 指標）。投稿ごとのスナップショットは 1 投稿 1 リクエストで済む。

カルーセルとフィード動画は、対象アカウントに該当する投稿がなかったため未検証。

### 2.5 リールの動画ファイル

- media_url から動画ファイル（video/mp4）をダウンロードできた。
- ffprobe とシーン検出での解析に成功した。
- URL の有効期限は、取得時点から約 32 時間後だった（URL の `oe` パラメータから読み取った値）。取得したらすぐ解析する方針（F-VID-01）で問題ない。

### 2.6 レート制限

約 110 回の呼び出しで、X-Business-Use-Case-Usage の使用率は call_count、total_cputime、total_time とも 1% だった。通常の収集には十分な余裕がある。2 年分のバックフィルでは使用率を監視しながら進める。

### 2.7 トークンの種類

ユーザーアクセストークンと、期限のないページアクセストークンの両方で検証し、取得できる項目は同じだった。

| 項目 | ページトークンでの結果 |
|---|---|
| debug_token の種類 | PAGE |
| 有効期限 | 期限なし |
| データアクセス期限 | 約 90 日 |
| me/permissions、me/accounts | 使えない（ページトークンでは me がページ自身を指すため）。Instagram アカウントの ID を別に指定する必要がある |

注意点は次の 2 つ。

- ページトークンは、Instagram アカウントを接続した Facebook ページのものでなければならない。接続していないページのトークンでは、Instagram のデータにアクセスできない。
- 期限のないトークンでも、データアクセス期限（約 90 日）を過ぎるとデータを取得できなくなる。R1 では、期限が近づいたら再接続を促す（F-COL-03、F-SYS-14）。

## 3. 未検証の項目

| 項目 | 理由 | 確かめる時期 |
|---|---|---|
| カルーセルの指標、子メディアのインサイト、親の `media_url`（4 章 P9） | 対象アカウントにカルーセルがない | カルーセルを投稿したとき `verify-api` を再実行する、または R1 の収集で |
| フィード動画の指標 | 対象アカウントに該当する投稿がない | 同上 |
| 動画ストーリーズの `media_url` からのダウンロードと解析（4 章 P2） | 公開中の動画ストーリーズに `media_url` が返らなかった（原因は不明） | R1 の 3 日間の実機確認で `no_video_url` の割合を見る。`media_url` が返る動画ストーリーズがあれば `verify-api` を再実行する |
| 2 年より前の投稿と、プロアカウントに切り替える前の投稿の指標（4 章 P10） | 対象アカウントの最も古い投稿が約 1 年前 | 該当する投稿ができたとき。R1 では古い投稿の失敗は `fatal`（null の行）として扱う（設計 5.5 章） |
| レート制限に当たったときのエラーコード（4 章 P12） | 意図的に当てられない | R1 のバックフィル中に `rate` で止まった `job_runs` の記録で |
| 冬時間の日付の区切り（T08:00:00+0000 になるか） | 検証時点が夏時間 | 2026-11 以降の収集データで |
| Facebook Login の戻り先に localhost を使えるか（C2） | トークンは Graph API エクスプローラで発行した | R1 の接続機能の実装時 |

「複数の total_value 指標を 1 回のリクエストで取れるか」は 4 章の P1 で確認した（取れる）。

## 4. R1 実装前の追加検証（2026-10-01）

| 項目 | 内容 |
|---|---|
| 実施日 | 2026-10-01 |
| 対象 | 1 章と同じアカウント。期限のないページアクセストークンを使用 |
| 方法 | `verify-api` に収集ジョブの設計書（`doc/design/r1-collection-jobs.md`）11.1 章の確認項目 P1〜P12 を追加して実行した。R0 の項目も同時に再実行した |
| 出力 | `.local/api-verification/verify-api-2026-10-01T05-58-00-262Z.md`（要約）と同名の `.json`（詳細。Git 管理外） |

この章にも、アカウントの ID、ユーザー名、指標の値、URL を含めていない。

### 4.1 確認項目の結果と設計への反映

| No | 確かめたこと | 結果 | 設計への反映 |
|---|---|---|---|
| P1 | アカウント日次指標を、設計 5.2 章の 4 グループ（内訳なし 12 指標、`follow_type` 3 指標、`media_product_type` 3 指標、`contact_button_type` 1 指標）それぞれ 1 リクエストで取れるか。米国太平洋時間（PT）の 2 日前の 1 日分 | **4 グループとも、要求した指標がすべて返った**。R0 で試していなかった `follows_and_unfollows` と `profile_links_taps` の内訳なしも取れた | `ACCOUNT_METRIC_GROUPS` は設計 5.2 章のまま（1 日 4 リクエスト ＋ follower_count 1 リクエスト） |
| P2 | 動画ストーリーズの `media_url` から動画をダウンロードして解析できるか。`thumbnail_url` が返るか。URL のホスト名 | 公開中のストーリーズは 2 件（動画 1、画像 1）。**動画の `media_url` が返らなかった**（`thumbnail_url` はあった）ため、ダウンロードと解析は未検証。画像には `media_url` があった。ホスト名の末尾は `media_url`、`thumbnail_url` とも `cdninstagram.com`。R0 の投稿一覧（リール、フィード画像）の `media_url` と `thumbnail_url` も今回はすべて `cdninstagram.com` だった（R0 の時点では `fbcdn.net` も見られた） | 原因は不明。音楽入りの動画では著作権の判定で `media_url` が省かれる可能性がある。設計 5.6 章の `no_video_url` の記録で扱う。要件 F-COL-23（ストーリーズの動画解析）の見直しが要るかは、R1 の 3 日間の実機確認で `no_video_url` の割合を見て決める。ダウンロードの許可リスト（設計 3.7 章）は `cdninstagram.com`、`fbcdn.net` で確定 |
| P3 | 1 日分の `since`/`until` の正しい指定。PT の 3 日前について `reach` を、(a) `total_value` で `since` = PT 0 時、`until` = 翌日 PT 0 時 − 1 秒、(b) 同じ範囲で `time_series`、(c) `until` = 翌日 PT 0 時ちょうど、(d) `until` = `since` + 86399、(e) `since` = `until` = 当日 PT 12 時、で取得 | (a) と (b) は **1 日分だけ返り、`total_value` の値と `time_series` の値が一致した**。(c) は 2 件返る（対象日と翌日）。(d) は 1 件。(e) は 0 件。`end_time` は対象日の PT 0 時（`T07:00:00+0000`）で、**`end_time` の PT の日付がそのまま指標の日付** | `pacificDayRange` は初期値のまま確定（`since` = PT 0 時、`until` = 翌日 PT 0 時 − 1 秒）。`metricDateFromEndTime` は初期値の「`end_time` の PT の日付の前日」をやめ、同日に修正済み |
| P4 | 内訳つきのレスポンスで、値が 0 の区分が `results` に含まれるか | **含まれない**。`follow_type` は FOLLOWER と NON_FOLLOWER の 2 区分、`media_product_type` は REEL の 1 区分だけ（フィード投稿の区分は返らない）、`profile_links_taps`（`contact_button_type`）は `results` が空で `total_value.value` だけがある。`follows_and_unfollows` の内訳つきは `total_value.value` がない | 設計 5.2 章の「印の行」の規則（内訳の値の行がなく、同じ breakdown の印の行があれば 0）が必要だと確認できた。`follows_and_unfollows` の印の行の `value` は null になる |
| P5 | 内訳つきの指標（`profile_activity`、`navigation`）を内訳なしの指標と同じリクエストに入れられるか | **入れられない**。フィード投稿、ストーリーズとも code 100 `Incompatible breakdowns (...) for metric (views)` | 設計 5.5 章、5.6 章のとおり、内訳つきは別のリクエストにする |
| P6 | コンテナからローカル Supabase の Postgres に `postgres` ロールで接続し Vault を読み書きできるか。`vault.secrets.name` の一意制約。サーバーログの設定。Storage の REST にサービスロールキーでアップロードできるか。postgres.js の `date` 型の変換 | `postgres` ロール（**スーパーユーザーではない**）で、Vault の作成・復号（`vault.decrypted_secrets`）・更新・削除がすべてできた。`vault.secrets.name` に一意索引 `secrets_name_idx` がある。`log_statement = ddl`、`log_parameter_max_length_on_error = 0`、`log_min_error_statement = error`（パラメータに乗せたトークンはサーバーログに出ない設定）。Storage の REST（サービスロールキー）でアップロード、上書き（`x-upsert`）、`authenticated` 経由の読み出し、削除がすべて HTTP 200。postgres.js の既定では `date` が JS の `Date`（UTC 0 時）になる | 設計 3.1 章（Postgres 直結）、3.3 章（Vault）、3.6 章（Storage の REST）のとおり。`date` は設計 3.5 章のとおり文字列に変える（実装済み）。R2 の Supabase Cloud でも同じ確認を行う |
| P7 | コラボ、お試しリール、ブーストを判定できるフィールドがあるか（リールで 10 フィールドを 1 つずつ） | 取れる: `boost_eligibility_info`（`eligible_to_boost`）、`is_shared_to_feed`、`owner`、`username`、`is_comment_enabled`、`copyright_check_information`（`status`）。値が返らない: `boost_ads_list`、`legacy_instagram_media_id`、`collaborators`。存在しない: `is_trial` | 判定できるフィールドは確認できず、R1 では `is_collab`、`is_trial_reel`、`is_boosted` は null のまま（設計 5.4 章）。ブースト済みの投稿があれば `boost_ads_list` に値が入る可能性があるので、R3 で再確認する |
| P8 | `{ig_user_id}/stories` にページングがあるか | `paging` あり。最終ページでも `cursors.after` を持ち、`next` はない | ページングの終了判定は `paging.next` の有無で行う（`JobGraphClient.pages` に反映。URL は使わずカーソルだけを渡す） |
| P9 | カルーセルの親に `media_url` が返るか | 対象アカウントにカルーセルがなく**未検証** | カルーセルを投稿したら `verify-api` を再実行する（3 章） |
| P10 | 2 年超の日付を指定したときのエラー。最も古い投稿で指標が取れるか | 2 年超は `reach`、`views` とも code 100、`error_subcode` なし、type `OAuthException`、メッセージ `(#100) since param is not valid. Metrics data is available for the last 2 years`。投稿一覧は 1 ページ 24 件で、最も古い投稿は約 1 年前（2025-10）。その `views`、`reach` は取れた | `isHistoryLimitError` の判定（code 100 かつメッセージに `available for the last 2 years`）は設計 5.3 章のまま。2 年より前の投稿は対象アカウントにないため未検証（3 章） |
| P11 | `access_token` をクエリでなく `Authorization: Bearer` ヘッダで送っても受け付けるか | **受け付けた**（HTTP 200、返った `id` が `IG_USER_ID` と一致） | 採用。`GraphClient` をヘッダ送信に変更済み。URL にトークンが載らない |
| P12 | Business Use Case のレート制限に当たったときのエラーコード | 意図的に当てられないため未検証 | R1 のバックフィル中に `rate` で止まった `job_runs` の記録で確かめる（3 章） |

### 4.2 R0 の項目の再実行で分かったこと

- 1 章の V1〜V5、V7〜V10 は同じ結果だった（2 年の制限、30 日の上限、`total_value` は期間の合計のみ、PT 0 時区切り、follower_count は 30 日、リールで `profile_visits`/`profile_activity`/`follows` 不可、`follower_type` 不可、`view_count` 不可、`engaged_audience_demographics` は空）。
- **V6（online_followers）は結果が変わった**。R0（2026-09-30）では中身が空だったが、今回は `period=lifetime` で 1 件の値が返り、その中身は 0〜23 時の 24 の時間帯すべてに 0 でない人数が入っていた。常に空とは限らず、日によって取れる可能性がある。R1 の収集対象には入っていない（設計 5.2 章）。毎日 1 リクエストで取ってみて安定して取れるなら、F-UI-41（時間帯別オンライン数）の代替方針（V6）を見直す余地がある。収集に入れるかはユーザーと相談する。
- 投稿一覧は 24 件（リール 18、フィード画像 6）で、カルーセルとフィード動画はまだない。
- 約 130 回の呼び出しで、`X-Business-Use-Case-Usage` の使用率は 1% だった（2.6 章と同じ）。
- ページアクセストークンのデータアクセス期限は残り約 89 日だった（`doc/progress.md` の 2026-12-29 ごろと一致）。

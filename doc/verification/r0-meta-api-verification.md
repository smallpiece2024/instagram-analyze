# R0: Meta API の実機検証結果

| 項目 | 内容 |
|---|---|
| 実施日 | 2026-09-30 |
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

## 3. 未検証の項目

| 項目 | 理由 | 確かめる時期 |
|---|---|---|
| カルーセルの指標と子メディアのインサイト | 対象アカウントにカルーセルがない | カルーセルを投稿したとき、または R1 の収集で |
| フィード動画の指標 | 対象アカウントに該当する投稿がない | 同上 |
| 複数の total_value 指標を 1 回のリクエストで取れるか | 今回は 1 指標ずつ確かめた | R1 の実装時 |
| 冬時間の日付の区切り（T08:00:00+0000 になるか） | 検証時点が夏時間 | 2026-11 以降の収集データで |
| Facebook Login の戻り先に localhost を使えるか（C2） | トークンは Graph API エクスプローラで発行した | R1 の接続機能の実装時 |

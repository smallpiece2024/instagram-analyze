# R1: DB のテーブル設計

| 項目 | 内容 |
|---|---|
| 版 | 0.1（案） |
| 作成日 | 2026-10-01 |
| 対象 | 要件定義 4.2 章（F-COL-01〜22、F-UI-01〜03）、5.1 章、5.2 章、5.4 章、5.5 章 |
| 入力 | `doc/requirements/requirements-definition.md`（版 0.4）、`doc/verification/r0-meta-api-verification.md` |
| 状態 | ユーザーの確認待ち。確認後にマイグレーションを書く |

---

## 1. 決めること: 指標の持ち方

要件 5.1 章の末尾で、指標を「JSON 型の列に一式を入れる」か「1 行 1 指標の縦持ち」にするかを基本設計で決めることになっている。

### 1.1 案

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| A. すべて縦持ち | アカウント日次指標も投稿のスナップショットも、1 行 1 指標 | 形がそろう。指標ごとの集計が SQL で素直に書ける | 投稿一覧のような「投稿 × 指標」の表を作るたびに行を列に組み替える必要がある。スナップショットの行数が指標の数だけ増える（月 2 万行台） |
| B. すべて JSON | どちらも、取得 1 回ごとに 1 行で、指標は JSON の列 | 行数が少ない。取得した形のまま入る | アカウント日次指標は指標ごと・日ごとに別のリクエストで取り、内訳の形も指標ごとに違う（R0 検証 V3）。1 行の JSON に組み立てると、直近 3 日の上書きや欠損の扱いが複雑になる |
| **C. 併用（推奨）** | アカウント日次指標は縦持ち。投稿とストーリーズのスナップショットは JSON | それぞれの取り方と使い方に合う | 2 つの形を扱う |

### 1.2 案 C を推す理由

**アカウント日次指標は縦持ちが合う。**

- API は指標ごと、日ごとに別のリクエストで返す（V3）。取得の単位と行の単位が一致する。
- 内訳の種類が指標ごとに違う（views は follow_type と media_product_type、profile_links_taps は contact_button_type など）。縦持ちなら「内訳の種類」と「内訳の値」の列で、どの指標の内訳も同じ形で入る。
- 直近 3 日の取り直しは、同じキーの行の上書き（upsert）で済む。
- 行数は 1 日 50 行前後で、2 年分のバックフィルを含めても 4 万行程度。

**スナップショットは JSON が合う。**

- 投稿の指標は 1 回のリクエストで一式が同じ時刻に返る（検証 2.4 章）。1 回の取得を 1 行にすると、「その時点の値の組」がそのまま残る。
- 投稿の種類ごとに取れる指標の組が違う（リールは follows が取れない、ストーリーズは navigation がある）。JSON なら種類ごとに列を用意しなくてよい。
- 画面は「投稿 × 指標」の表が中心（投稿一覧、F-UI-03、F-UI-21）。行を列に組み替えなくてよい。
- 「欠損」と「対象外」と「0」を区別できる（F-COL-22）。JSON のキーがない＝その種類では取れない指標（対象外）、キーがあって値が null＝取れるはずが取れなかった（欠損）、0＝実際に 0。
- 指標が増えても列を足さずに入る（NF-MNT-01）。

この規模（投稿は月 30 件程度）では、JSON の中の値で並べ替えたり集計したりしても速度の問題は出ない見込み。必要になったら、よく使う指標だけを生成列やビューで取り出す。

---

## 2. テーブル一覧

| テーブル | 内容 | 要件 |
|---|---|---|
| `accounts` | 対象の Instagram アカウントと接続した Facebook ページ | 5.1 |
| `private.credentials` | アクセストークンと期限、権限。API から見えないスキーマに置く | F-COL-02、NF-SEC-01 |
| `profile_daily` | プロフィールの日次記録（フォロワー数、フォロー数、投稿数） | F-COL-10 |
| `account_daily_metrics` | アカウント日次指標（縦持ち）。follower_count も含む | F-COL-11、F-COL-12 |
| `media` | 投稿とストーリーズのメタ情報 | F-COL-13、F-COL-16、F-COL-17 |
| `media_insight_snapshots` | 投稿とストーリーズの指標のスナップショット（JSON） | F-COL-14〜16 |
| `raw_api_responses` | API の生レスポンス | F-COL-18 |
| `job_runs` | ジョブの実行記録 | F-COL-19、5.4 |
| `job_state` | 中断から再開するための状態（バックフィルの進み具合など） | F-COL-12 |
| `metric_definitions` | 指標の定義 | 5.1、7 章 |
| `video_analyses` | 動画の解析結果（長さ、カットの数などの特徴量）。解析条件ごとに 1 行 | 5.3、F-VID-02〜04、F-COL-23 |
| `video_cuts` | カットのタイミング（1 カット 1 行、ミリ秒） | 5.3、F-VID-03 |
| `video_text_extractions` | 画面の文字の読み取り 1 回分（方式、版、文字の特徴量、費用）。**R4.1 で作る** | 5.3、F-VID-22〜26 |
| `video_text_segments` | 文字の表示区間（文字、開始と終了のミリ秒、位置）。**R4.1 で作る** | 5.3、F-VID-23 |

動画の 4 つの表は 5 章、分析用のデータセットは 6 章に書く。

ストレージ: 非公開のバケット `thumbnails` にサムネイルを置く（F-COL-17）。

ストーリーズは投稿と同じ `media` と `media_insight_snapshots` に入れる。API でも同じメディアとして扱われ、指標の取り方も同じだからである。区別は `media_product_type = 'STORY'` で行い、日の中の順番は投稿日時から求める。

---

## 3. テーブル定義

型は Postgres の型。時刻はすべて `timestamptz`（UTC で保存し、画面で日本時間に変換する。要件 5.5 章）。

### 3.1 `accounts`

| 列 | 型 | 説明 |
|---|---|---|
| id | uuid PK | 内部の ID |
| ig_user_id | text UNIQUE NOT NULL | Instagram アカウントの数値 ID |
| username | text | ユーザー名（表示用。プロフィール取得のたびに更新） |
| name | text | 表示名 |
| fb_page_id | text | 接続した Facebook ページの ID |
| status | text NOT NULL | `active`（収集中）、`paused`（停止）、`disconnected`（接続解除） |
| created_at | timestamptz NOT NULL | 登録日時 |
| updated_at | timestamptz NOT NULL | 更新日時 |

接続を解除してデータを消すとき（NF-CMP-02）は、このテーブルの行を消すと関連するデータがすべて消えるようにする（外部キーに ON DELETE CASCADE）。

### 3.2 `private.credentials`

`private` スキーマは Supabase の API（REST）に公開しない。読めるのはワーカーとサーバー側の処理だけにする。

| 列 | 型 | 説明 |
|---|---|---|
| account_id | uuid PK FK | アカウント |
| token_type | text NOT NULL | `PAGE`、`USER` |
| token_secret_id | uuid NOT NULL | トークン本体。Supabase Vault に暗号化して保存し、ここには Vault の ID だけを持つ |
| expires_at | timestamptz | トークンの有効期限。期限なしは null |
| data_access_expires_at | timestamptz | データアクセス期限（ページトークンでも約 90 日で切れる） |
| scopes | text[] | 付与された権限 |
| status | text NOT NULL | `valid`、`expired`、`insufficient_scope`、`error` |
| last_checked_at | timestamptz | debug_token で最後に確かめた日時 |
| last_error | text | 最後のエラー（トークンは含めない） |
| updated_at | timestamptz NOT NULL | 更新日時 |

R1 の最初は `.env` のページトークンを登録するコマンドを用意して、このテーブルに入れる。Facebook Login による接続画面（F-COL-01）も同じテーブルに書き込む。

画面に出す期限と状態は、この表を直接見せずに、トークンを含まないビュー（`account_connection_status`）経由で返す。

### 3.3 `profile_daily`

| 列 | 型 | 説明 |
|---|---|---|
| account_id | uuid FK | アカウント |
| captured_on | date | 記録した日（**日本時間**の日付） |
| captured_at | timestamptz NOT NULL | 実際に取得した時刻 |
| followers_count | integer | フォロワー数。取れなければ null |
| follows_count | integer | フォロー数 |
| media_count | integer | 投稿数 |
| raw_response_id | bigint FK | 元の生レスポンス |

主キーは (account_id, captured_on)。同じ日に 2 回実行したら後の値で上書きする（F-COL-20）。

プロフィールは「その時点の値」なので、API の日次指標と違い、日本時間の日付で持てる。フォロワー純増（要件 7.3 章）はこの表の前日差で計算する。

### 3.4 `account_daily_metrics`

| 列 | 型 | 説明 |
|---|---|---|
| account_id | uuid FK | アカウント |
| metric_date | date | 指標の日付（**API の日付＝米国太平洋時間**。要件 5.5 章） |
| metric | text | 指標名（`reach`、`views`、`follower_count` など） |
| breakdown | text | 内訳の種類。内訳なしは空文字 `''`（例: `follow_type`、`media_product_type`、`contact_button_type`） |
| breakdown_value | text | 内訳の値。内訳なしは空文字 `''`（例: `FOLLOWER`、`NON_FOLLOWER`、`REEL`） |
| value | bigint | 値。API が値を返さなかったときは null（欠損。F-COL-22） |
| fetched_at | timestamptz NOT NULL | 取得した時刻 |
| raw_response_id | bigint FK | 元の生レスポンス |

主キーは (account_id, metric_date, metric, breakdown, breakdown_value)。直近 3 日の取り直しとバックフィルは、どちらもこのキーで上書きする。内訳なしを null でなく空文字にするのは、主キーに含めて上書きの判定を単純にするため。

行の有無と値の意味:

| 状態 | 意味 |
|---|---|
| 行がない | まだ取得していない |
| 行があり value が null | 取得したが値が返らなかった（欠損） |
| 行があり value が 0 | 実際に 0 |

follower_count（1 日ごとの新規フォロワー数）もこの表に `metric = 'follower_count'` で入れる。日付の意味は他の日次指標と同じく API の日付。

### 3.5 `media`

| 列 | 型 | 説明 |
|---|---|---|
| id | text PK | Instagram のメディア ID |
| account_id | uuid FK | アカウント |
| media_type | text | `IMAGE`、`VIDEO`、`CAROUSEL_ALBUM` |
| media_product_type | text | `FEED`、`REELS`、`STORY` |
| posted_at | timestamptz NOT NULL | 投稿日時 |
| caption | text | キャプション |
| permalink | text | 投稿の URL |
| thumbnail_path | text | Storage 上のサムネイルのパス |
| expires_at | timestamptz | ストーリーズが消える予定の時刻（投稿日時 ＋ 24 時間）。投稿は null |
| is_collab | boolean | コラボ投稿か。判定できなければ null |
| is_trial_reel | boolean | お試しリールか。判定できなければ null |
| is_boosted | boolean | ブースト投稿か。判定できなければ null |
| first_seen_at | timestamptz NOT NULL | 最初に検出した時刻 |
| last_synced_at | timestamptz NOT NULL | 最後にメタ情報を同期した時刻 |
| gone_at | timestamptz | 投稿一覧から消えたのを検出した時刻（削除やアーカイブ）。データは残す |

コラボ、お試しリール、ブーストの 3 つのフラグ（F-UI-28）は、API で判定できるかを R1 の実装時に確かめる。取れなければ R3 で手で設定できるようにする。どちらにしても列は R1 で用意しておく。

カルーセルの子メディアは R1 では表にしない。生レスポンスには残るので、カルーセルの検証（未検証項目）が済んでから必要なら追加する。

### 3.6 `media_insight_snapshots`

| 列 | 型 | 説明 |
|---|---|---|
| id | bigint PK（自動採番） | |
| media_id | text FK | メディア |
| fetched_at | timestamptz NOT NULL | 取得した時刻 |
| elapsed_seconds | integer NOT NULL | 投稿からの経過秒数（fetched_at − posted_at）。実際の取得時刻から計算する（要件 5.2 章） |
| metrics | jsonb NOT NULL | 指標一式。例 `{"views": 1520, "reach": 980, "saved": 31, "follows": null}` |
| raw_response_id | bigint FK | 元の生レスポンス |
| job_run_id | bigint FK | 取得したジョブの実行 |

一意制約は (media_id, fetched_at)。

`metrics` の中の値の意味:

| 状態 | 意味 |
|---|---|
| キーがない | その種類の投稿では取れない指標（対象外。例: リールの follows） |
| キーがあり値が null | 取れるはずが取れなかった（欠損） |
| 数値 | 取得した値。0 は実際に 0 |

ストーリーズの navigation のように内訳がある指標は、`{"navigation": {"tap_forward": 120, "tap_back": 8, "tap_exit": 15, "swipe_forward": 30}}` のように入れ子にする。

ストーリーズの確定値（F-COL-16）は「消える前の最後のスナップショット」とし、ビュー `story_final_metrics` で取り出す。

スナップショットのスケジュール（1 時間ごと → 1 日 1 回 → 週 1 回 → 月 1 回）は表に持たない。ワーカーが「投稿日時」と「最後のスナップショットの時刻」から、取得すべき投稿を毎回計算する。表に予定を持たないので、予定と実績が食い違うことがない。

### 3.7 `raw_api_responses`

| 列 | 型 | 説明 |
|---|---|---|
| id | bigint PK（自動採番） | |
| account_id | uuid FK | アカウント |
| job_run_id | bigint FK | ジョブの実行 |
| endpoint | text NOT NULL | 呼び出したパス（例 `{ig_user_id}/insights`）。トークンは含めない |
| params | jsonb NOT NULL | クエリのパラメータ。トークンは含めない |
| api_version | text NOT NULL | 例 `v25.0` |
| fetched_at | timestamptz NOT NULL | 取得した時刻 |
| http_status | integer NOT NULL | HTTP の状態コード |
| body | jsonb | レスポンス本文（エラーのときはエラーの本文） |

R1 ではすべて残す。容量の上限（NF-CAP-02）に備えて、R2 で「180 日を過ぎたら消す」処理を加える。概算は 1 日 300 件前後、1 件 2KB とすると 1 年で 200MB 前後になる見込み（推測値。R1 の実測で見直す）。無料枠 500MB に対して大きいので、保存期間は R1 の実測を見て決める。

### 3.8 `job_runs`

| 列 | 型 | 説明 |
|---|---|---|
| id | bigint PK（自動採番） | |
| job_name | text NOT NULL | `profile_daily`、`account_daily`、`account_backfill`、`media_sync`、`media_snapshot`、`stories` など |
| account_id | uuid FK | アカウント |
| started_at | timestamptz NOT NULL | 開始時刻 |
| finished_at | timestamptz | 終了時刻。実行中は null |
| status | text NOT NULL | `running`、`success`、`partial`（一部失敗）、`failed`、`skipped`（レート制限などで見送り） |
| items_fetched | integer | 取得件数 |
| api_calls | integer | API の呼び出し回数 |
| error | text | エラーの内容（トークンや取得データは含めない） |
| rate_usage | jsonb | 終了時のレート制限の使用率（X-Business-Use-Case-Usage） |

収集ログ画面（F-UI-02）と、収集停止の通知（F-SYS-14）の元になる。

### 3.9 `job_state`

| 列 | 型 | 説明 |
|---|---|---|
| account_id | uuid FK | アカウント |
| job_name | text | ジョブ名 |
| state | jsonb NOT NULL | ジョブごとの状態。例: バックフィルなら `{"next_date": "2025-06-14", "oldest_date": "2024-10-01"}` |
| updated_at | timestamptz NOT NULL | 更新日時 |

主キーは (account_id, job_name)。2 年分のバックフィル（F-COL-12）を数日に分けて進め、中断しても続きから再開するために使う。

### 3.10 `metric_definitions`

| 列 | 型 | 説明 |
|---|---|---|
| scope | text | `account_daily`、`media`、`story` |
| metric | text | API の指標名 |
| label_ja | text NOT NULL | 画面の表示名 |
| description | text | 意味 |
| unit | text | `count`、`ms`、`percent` |
| media_product_types | text[] | 取れる投稿の種類（scope が media のとき） |
| available_from | date | 使えるようになった日 |
| deprecated_on | date | 廃止された日 |
| successor | text | 後継の指標 |

主キーは (scope, metric)。初期データは R0 の検証結果（検証 2.2 章、2.4 章）から入れる。2025-04-21 の views への統一のような定義の変更（F-UI-25）もここに記録する。

派生指標（保存率など）の計算式と版（NF-MNT-02）は R3 で別に設計する。

---

## 4. ビュー

| ビュー | 内容 | 使う画面 |
|---|---|---|
| `media_analysis_dataset` | 投稿 1 件 1 行の分析用データセット（6 章） | 画面では使わない。SQL、CSV、Python などで分析する |
| `account_connection_status` | アカウント、トークンの種類、有効期限、データアクセス期限、残り日数、状態、最終収集時刻。トークン本体は含めない | 接続状態（F-UI-01） |
| `media_latest_metrics` | 投稿ごとの最新のスナップショット | 投稿の簡易一覧（F-UI-03） |
| `story_final_metrics` | ストーリーズごとの消える前の最後のスナップショット | R5 のストーリーズ画面 |
| `job_latest_runs` | ジョブごとの直近の実行結果 | 収集ログ（F-UI-02） |

---

## 5. 動画の解析結果

### 5.1 方針

目的は、ある指標（目的変数。例: 閲覧数、リーチ、シェア率）の伸びを、動画の特徴（説明変数。例: カットの数とタイミング、長さ、文字の出方）で説明できるようにすること。分析の画面は作らないが、データは後から SQL や Python で分析できる形で残す（6 章）。

そのために次の 3 点を守る。

1. **カットのタイミングは 1 カット 1 行で全部残す。** 「冒頭 3 秒のカット数」のような特徴量は後から何通りでも作れるようにする。特にストーリーズは動画を取り直せないので、生のタイミングを残すことが重要になる。
2. **解析条件（しきい値、プログラムの版）ごとに結果を別の行で持つ。** しきい値を変えて解析し直しても、前の結果を消さずに比べられる（F-VID-04）。
3. **動画ファイルは保存しない**（NF-CAP-03）。解析したら消す。

### 5.2 ストーリーズの動画は R1 で解析する

リールの動画は API からいつでも取り直せるので、解析は R4 でまとめて行える（要件 3 章）。一方ストーリーズは 24 時間で消え、消えた後は動画を取得できない。R4 まで待つと、それまでのストーリーズの動画特徴量は永久に取れない。

そこで R1 で、**ストーリーズの動画を検出したらすぐ、長さとカットを解析して保存する**（要件 F-COL-23 として追加）。ffprobe とシーン検出は R0 で動作を確認済み（`apps/worker/src/lib/ffmpeg.ts`）。リールの解析は R4 のまま。表は共通なので、R4 ではリールの解析結果を同じ表に入れるだけでよい。

ストーリーズの動画の media_url がダウンロードできるかは、R0 ではリールでしか確かめていない。R1 の実装の最初に確かめる。

### 5.3 `video_analyses`

| 列 | 型 | 説明 |
|---|---|---|
| id | bigint PK（自動採番） | |
| media_id | text FK | メディア（リール、ストーリーズ、フィード動画） |
| analyzer_version | text NOT NULL | 解析プログラムの版 |
| scene_threshold | numeric NOT NULL | シーン検出のしきい値（既定 0.3） |
| status | text NOT NULL | `success`、`no_video_url`（URL が取れない）、`failed` |
| error | text | 失敗の理由 |
| analyzed_at | timestamptz NOT NULL | 解析した時刻 |
| duration_ms | integer | 動画の長さ |
| width、height | integer | 解像度 |
| fps | numeric | フレームレート |
| bitrate | integer | ビットレート |
| file_size | integer | ファイルサイズ（バイト） |
| has_audio | boolean | 音声の有無 |
| cut_count | integer | カットの数（大きな画面変化の回数） |
| avg_scene_ms | integer | 平均シーン長 |
| first_cut_ms | integer | 最初のカットまでの時間。カットがなければ null |
| cuts_in_first_3s | integer | 冒頭 3 秒のカット数 |

一意制約は (media_id, analyzer_version, scene_threshold)。同じ条件で 2 回解析したら上書きする。

カット数などの特徴量は `video_cuts` から計算できるが、よく使うのでこの表にも持つ。計算し直したいときは `video_cuts` から作り直せる。

### 5.4 `video_cuts`

| 列 | 型 | 説明 |
|---|---|---|
| analysis_id | bigint FK | 解析結果 |
| seq | integer | 何番目のカットか（1 から） |
| at_ms | integer NOT NULL | 動画の開始からのミリ秒 |
| scene_score | numeric | 画面変化の大きさ（0〜1）。取れれば保存する |

主キーは (analysis_id, seq)。精度はフレーム単位（30fps なら約 33 ミリ秒刻み。要件 4.5 章）。

### 5.5 `video_text_extractions` と `video_text_segments`（R4.1 で作る）

文字の読み取りは方式を R4.1 で比べて決める（F-VID-20）ため、表は R4.1 のマイグレーションで作る。形は次を予定する。

`video_text_extractions`（読み取り 1 回分）: media_id、方式（ocr_method）、版、フレームを取り出した間隔、状態、処理時刻、費用、文字の特徴量（first_text_ms、has_text_in_first_3s、text_coverage_ratio、total_text_chars）。一意制約は (media_id, ocr_method, ocr_version, frame_interval_ms)。同じ条件で二度処理しない（F-VID-25）。

`video_text_segments`（表示区間 1 つで 1 行）: extraction_id、seq、文字、表示開始ミリ秒、表示終了ミリ秒、表示位置（上・中・下）、画面に占める大きさ、確信度。

ストーリーズの文字は、R4.1 の時点では動画が消えていて読み取れない。過去のストーリーズの文字も分析したい場合は、R1 から解析用の静止画を残しておく必要がある（10 章の確認事項 D2）。

---

## 6. 分析用のデータセット

### 6.1 目的変数をそろえる

投稿の指標は累計値で、取得のたびに増える。投稿から 2 日の投稿と 90 日の投稿の「最新の閲覧数」を比べても公平にならない。そこで、**投稿からの経過時間をそろえた値**を目的変数にする。

スナップショットは実際の取得時刻で記録しているので（3.6 章）、「経過時間が基準以上になった最初のスナップショット」の値を、その基準での値とする。実際の経過時間も一緒に出し、ずれの大きいものは分析から外せるようにする。

| 基準 | 対象 | 取れる根拠 |
|---|---|---|
| 1 時間、3 時間、6 時間、24 時間 | 投稿、ストーリーズ | 投稿後 24 時間は 1 時間ごとに取得する |
| 3 日、7 日、30 日 | 投稿 | 2〜30 日目は 1 日 1 回取得する |
| 最終値 | ストーリーズ | 消える前の最後のスナップショット |
| 最新値 | 投稿 | 最新のスナップショット（参考。経過時間がそろわない） |

### 6.2 `media_analysis_dataset`（ビュー）

投稿 1 件 1 行。列は次のとおり。

| まとまり | 列の例 |
|---|---|
| 投稿の属性 | media_id、種類（media_product_type、media_type）、投稿日時、日本時間の曜日と時刻、キャプションの文字数、ハッシュタグの数、コラボ・お試し・ブーストのフラグ |
| ストーリーズの属性 | その日の何枚目か、その日の枚数 |
| 動画の特徴（説明変数） | 長さ、カットの数、平均シーン長、最初のカットまでの時間、冒頭 3 秒のカット数、音声の有無（現在の解析条件の結果） |
| 目的変数 | 基準ごとの views、reach、shares、saved、likes、comments、total_interactions、平均視聴時間、スキップ率、ストーリーズの navigation とリンククリック。それぞれ実際の経過時間を添える |
| 派生値 | 保存率、シェア率など（R3 で計算式を決めたら加える） |

列が多くなるので、基準ごとに分けた縦長のビュー（`media_metrics_at_horizon`: media_id、基準、実際の経過時間、指標一式）も用意し、`media_analysis_dataset` はそれを横に並べたものにする。

カットのタイミングそのもの（何秒目に切り替わったか）を使う分析は、`video_cuts` を直接使う。例えば「1〜2 秒目にカットがある動画とない動画で閲覧数を比べる」は、`video_cuts` と `media_metrics_at_horizon` を結合すれば SQL で書ける。

### 6.3 分析の手段（画面は作らない）

- Supabase Studio の SQL エディタで直接問い合わせる
- ビューを CSV で書き出し、表計算ソフトや Python（pandas など）で読む。書き出しはワーカーのコマンドとして用意する（`export-dataset`）。CSV は自分のデータなので `.local/` に出し、コミットしない
- Python から Postgres に直接つないで読む

---

## 7. 権限（行レベルセキュリティ）

- すべてのテーブルで行レベルセキュリティを有効にする（NF-SEC-03）。
- R1 では、匿名（anon）とログインユーザー（authenticated）に許可を与えない。読み書きできるのは、サービスロールのキーを使うワーカーと Next.js のサーバー側の処理だけにする。ブラウザから DB を直接読まない。
- R2 でログインを入れるときに、本人だけが読めるポリシーを追加する（F-SYS-13）。
- トークンは `private` スキーマと Vault に置き、サービスロールでも REST API からは読めないようにする。ワーカーは DB に直接接続して読む。

---

## 8. 行数と容量の見込み

月 30 投稿、ストーリーズ 1 日 5 枚の場合の概算（推測値。R1 の実測で見直す）。

| テーブル | 1 か月 | 備考 |
|---|---|---|
| account_daily_metrics | 約 1,500 行 | バックフィル 2 年分で別に約 3.6 万行 |
| profile_daily | 30 行 | |
| media | 約 180 行 | 投稿 30 ＋ ストーリーズ 150 |
| media_insight_snapshots | 約 5,400 行 | 投稿 1,800 ＋ ストーリーズ 3,600（要件 8.3 章の概算） |
| raw_api_responses | 約 9,000 行 | 容量の大半を占める。3.7 章 |
| job_runs | 約 2,000 行 | 1 時間ごとのジョブが 2〜3 種類 |
| video_analyses | 約 150 行 | ストーリーズの動画（R1 から）。R4 からリール約 20 行が加わる |
| video_cuts | 約 1,000 行 | 1 本あたり数個〜十数個 |

---

## 9. この設計で決めないこと

- ワーカーから DB への接続方法（Postgres に直接つなぐか、Supabase のクライアントを使うか）。収集ジョブの設計で決める。トークンを `private` スキーマから読むため、直接接続が有力。
- 派生指標の計算式と版（R3）。
- 独自タグ、属性データの表（R5）。文字の読み取りの表（R4.1。形は 5.5 章）。

---

## 10. 確認事項

| No | 内容 | 状態 |
|---|---|---|
| D1 | 指標の持ち方（1 章の案 C） | 了承済み（2026-10-01） |
| D2 | ストーリーズの画面の文字を後から読み取れるように、解析用の静止画を残すか | 確認中 |

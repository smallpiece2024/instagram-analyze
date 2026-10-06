# R4 動画分析（長さとカット）の設計

- 版: 0.1（2026-10-06）。実装前にユーザーの確認を受ける。確認事項は 9 章

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-06 | 起草（親のセッション） |

- 要件: `doc/requirements/requirements-definition.md` 3 章（R4）、4.5 章（F-VID-01〜14）、5.3 章、7.2 章、10 章（R4 の完了条件）
- 既存: R1 の動画解析（`supabase/migrations/20261001100200_r1_video.sql`、`apps/worker/src/lib/video-analysis.ts`、`lib/ffmpeg.ts`、`db/video.ts`、`jobs/stories.ts`）、R1 のビュー（`20261001100400_r1_views.sql` の `media_analysis_dataset`）、R2 の `web_app` ロール（`20261002005926_r2_web_role.sql`。`video_analyses` と `video_cuts` の select のポリシーは R2 で済み）、R3 のビューと画面（`20261005000000_r3_analysis_views.sql`、`doc/design/r3-analysis-screens.md`）
- デザイン: `doc/design-system.md`、`doc/design-lab/v3/render.js` の `S.reels`（リール分析）と `S["media-detail"]` の `cutTimeline`（投稿詳細のタイムライン）

この文書で「未確認」と書いたものは、起草時に確かめられなかった事実。実装の前に確かめる。

---

## 1. 目的と範囲

### 1.1 R4 でやること

| 区分 | 内容 | 要件 |
|---|---|---|
| 収集 | リールとフィード動画を自動で解析するジョブ `video_analysis` を毎時のグループに足す。新しい投稿も既存の投稿も同じジョブで順に解析する（まとめ解析の専用の仕組みは作らない） | F-VID-01〜06 |
| 調整 | シーン検出のしきい値を決めるための手元のコマンド `video-tune`。数本のリールで、しきい値ごとのカットの時刻を出し、目視と比べる | 10 章の完了条件 |
| DB | 再試行の打ち切りに使う列、画面用のビュー（動画の特徴量と視聴維持率） | F-VID-04、F-VID-11 |
| 画面 | 投稿詳細に動画の特徴量とカットのタイムライン。リール分析の画面（`/reels`）を新しく作る | F-VID-10〜14 |

### 1.2 R4 でやらないこと

- 画面の文字（OCR）。R4.1 で方式を比べてから行う。見本（design-lab v3）にある「最初の文字まで」「冒頭 3 秒の文字」「総文字数」「文字の表示割合」と、タイムラインの文字の区間は R4 では出さない
- カルーセルの中の動画。カルーセルの子のメディアの指標は API で取れず（R0）、動画の特徴量を指標と結び付けられないため
- ストーリーズの解析の変更。R1 の `stories` ジョブのまま（ストーリーズは 24 時間で消えるので、毎時のジョブの中で必ず先に解析する）
- 動画やフレームの保存（NF-CAP-03）

---

## 2. R1 で済んでいるもの

| もの | 内容 |
|---|---|
| 表 | `video_analyses`（解析条件ごとに 1 行。`unique (media_id, analyzer_version, scene_threshold)`、状態 `success`／`no_video_url`／`failed`）と `video_cuts`（1 カット 1 行、ミリ秒） |
| 解析 | `analyzeVideo`（ダウンロード → ffprobe → シーン検出 → 特徴量。例外を投げない。一時ディレクトリは `finally` で消す） |
| 再試行 | `isAnalysisRetryDue`（`failed` と `no_video_url` は 3 時間後に再試行） |
| 実行環境 | GitHub Actions の `collect.yml` で ffmpeg を apt で入れている（入らなくても収集は進む） |
| ビュー | `media_analysis_dataset` が投稿ごとに最新の `success` の解析結果をつないでいる（`v.*`） |
| 権限 | `web_app` は `video_analyses` と `video_cuts` を読める |

リールの解析に要る部品はほぼそろっている。R4 で作るのは、対象の選び方、`media_url` の取り直し、打ち切り、画面。

---

## 3. 収集: `video_analysis` ジョブ

### 3.1 対象

- `media_product_type` が `REELS` のもの、または `FEED` で `media_type` が `VIDEO` のもの（フィード動画。今の本番にはない）
- `gone_at` が null（消えた投稿は動画を取れない）
- 今の解析条件（`ANALYZER_VERSION`、採用したしきい値）の行がないか、`isAnalysisRetryDue` が true で、打ち切り（3.4）に達していないもの
- 並びは投稿の新しい順。新しいリールを先に解析し、既存のリールは残りの枠で進む

### 3.2 グループの中の位置と 1 回の上限

- hourly グループを `stories` → `media_sync` → `media_snapshot` → **`video_analysis`** → `account_backfill` にする。新しい投稿は `media_sync` が `media` に入れた後なので、その回のうちに解析できる。指標の収集（`media_snapshot`）を先に済ませ、動画の遅れで指標を取りこぼさないようにする
- 1 回に解析する本数の上限を `WORKER_VIDEO_MAX_PER_RUN`（既定 5）で決める。上限に達したら残りは次の回に回す。本番のリールは 20 本台（R0 時点で 18 本）なので、既存分は数時間で終わる（F-VID-05 の「リリース時にまとめて解析」はこれで満たす）
- 時間の見積もり（未確認。段階 1 で計測する）: ダウンロードは 1 本数十 MB、シーン検出は 1 分の動画で数十秒程度とみている。5 本で 5 分前後なら、`collect.yml` の `timeout-minutes: 30` に収まる。計測で長ければ上限を下げる
- `signal` で中断されたら、実行中の 1 本を終えて止まる（`groups.ts` の作法に合わせる）

### 3.3 `media_url` の取り直し

`media_url` は期限付きで、DB に保存していない（要件の「動画の URL」の制約、F-VID-01）。解析の直前に 1 本ずつ取り直す。

- `GET /{media-id}?fields=id,media_type,media_product_type,media_url`（`ctx.graph`。レート制限と再試行は既存の枠組みに任せる）
- `media_url` がない（著作権の判定を受けたものなど）→ `no_video_url` を記録する。失敗には数えず `warn` だけ
- API がエラー → `transient` は行を書かずに次の回へ。`fatal`（削除済みなど）は `failed` を記録する
- 取り直した `media_type` が `VIDEO` でなければ解析しない（`warn`）
- ダウンロードの制限は `stories` と同じ `videoDownloadLimits`（200 MB、60 秒、許可するホストは `config.downloadAllowedHosts`）
- URL は DB、ログ、例外に入れない（`stories` と同じ）

### 3.4 再試行と打ち切り

ストーリーズは 24 時間で一覧から消えるので、3 時間ごとの再試行で自然に止まる。リールは消えないので、`no_video_url` や `failed` のまま 3 時間ごとに永久に再試行してしまう。

- `video_analyses` に `attempt_count integer not null default 1` を足す。同じ条件の行を上書きするたびに 1 増やす（`upsertVideoAnalysis` の `on conflict` で `attempt_count = video_analyses.attempt_count + 1`）
- `success` 以外で `attempt_count` が `VIDEO_MAX_ATTEMPTS`（既定 5）に達したら、そのジョブの対象から外す。3 時間ごと 5 回で約半日試す
- 打ち切った投稿をやり直すときは、その行を消すか（手元の SQL）、しきい値か版を変えて全体を解析し直す。専用のコマンドは作らない
- `stories` も同じ列を使うが、打ち切りは掛けない（どうせ 24 時間で止まる）

### 3.5 失敗の数え方とログ

- `success` → `ctx.progress.items += 1`
- `no_video_url` → `warn`（`NO_VIDEO_URL_WARNING` に相当するリール用の文言）。失敗に数えない
- `failed` → `ctx.recordFailure`（`failureClass` をそのまま）。打ち切りに達した回は `warn` も 1 行出す
- 最後に `info` で `candidates`、`analyzed`、`no_video_url`、`failed`、`skipped_by_limit`（上限で次の回に回した数）を出す
- ffmpeg が入っていない（apt の失敗）ときは、すべて `failed` になり GitHub の失敗メールで分かる（今の `stories` と同じ）。ただし 1 本目の失敗の時点で `ffmpeg` の有無を確かめ、ないならその回の残りを飛ばす（毎回 5 本分のダウンロードを無駄にしない）

### 3.6 ストーリーズとの共通化

`stories.ts` の動画解析の部分（`latestAnalysis` → `analyzeVideo` → `upsertVideoAnalysis` → 結果の数え上げ）を、`jobs/video-analysis.ts` の関数 `analyzeAndStore(ctx, { mediaId, videoUrl }, deps)` に移し、`stories` と `video_analysis` の両方から呼ぶ。挙動は変えない（`stories` のテストがそのまま通ること）。

---

## 4. しきい値の決め方: `video-tune`

完了条件（要件 10 章）は「数本について、カットのタイミングを目視と比べて妥当なしきい値を決めた」。

### 4.1 コマンド

`worker video-tune <media-id> [<media-id> ...] [--thresholds 0.2,0.25,0.3,0.4,0.5]`

1. `media_url` を取り直し、一時ファイルに落とす（3.3 と同じ制限）
2. シーン検出を低いしきい値（0.1）で 1 回だけ走らせ、各フレームの `scene_score` と時刻を取る（ffmpeg のフィルタ `select='gt(scene,0.1)',metadata=print:key=lavfi.scene_score`。しきい値ごとに ffmpeg を走らせ直さない）
3. しきい値ごとに、そのしきい値を超えたカットの数と時刻（秒、小数 1 桁）を表で標準出力に出す
4. DB には書かない。一時ファイルは消す

### 4.2 使い方

- 手元の Docker のワーカーで動かす（トークンは手元の Supabase のもの。R1 で登録済みで期限は約 60 日）。GitHub Actions では動かさない（公開ログに投稿の ID が出るため）
- 目視は Instagram のアプリでリールを再生し、編集で切ったところの秒数と表を比べる。種類の違うリールを 3〜5 本（カットの多いもの、少ないもの、動きの激しいもの）
- 決めたしきい値を `DEFAULT_SCENE_THRESHOLD` に入れ、決めた理由と使ったリールの本数をこの文書に書く（投稿の ID は書かない）
- しきい値を 0.3 から変えた場合、R1 からのストーリーズの解析結果（0.3）は条件が違う行として残る。ストーリーズは動画を取り直せないので解析し直せない。画面とビューは「投稿ごとに最新の `success`」を使うので、条件の違う行が混ざることは画面には出さない（確認事項 Q3）

### 4.3 シーンの点数の保存

`video_cuts.scene_score` は列があるのに R1 では常に null。`detectSceneChanges` のフィルタに `metadata=print` を足して点数も拾い、保存する（カットの時刻は今と同じになるので `ANALYZER_VERSION` は上げない。確認事項 Q4）。点数があれば、後でしきい値を上げたときのカットを解析し直さずに SQL で出せる。

---

## 5. DB

### 5.1 マイグレーション（手書き。`supabase/migrations/20261007000000_r4_video.sql` の案）

1. `alter table public.video_analyses add column attempt_count integer not null default 1 check (attempt_count >= 1)`
2. ビュー `public.media_video_features`（下）と `web_app` への `grant select`
3. 打ち切りの判定と対象の選び方に使う索引は、今の `video_analyses_media_idx (media_id, analyzed_at desc)` で足りる見込み（リールは数十本）

### 5.2 `media_video_features`

投稿 1 件 1 行。投稿ごとに最新の `success` の解析結果と、最新のスナップショットの視聴系の指標をつなぐ。

| 列 | 内容 |
|---|---|
| `media_id`、`account_id`、`kind`（`media_kind()`）、`posted_at` | 投稿の属性 |
| `analysis_id`、`analyzer_version`、`scene_threshold`、`analyzed_at` | 使った解析結果 |
| `duration_ms`、`width`、`height`、`fps`、`has_audio` | ffprobe の値 |
| `cut_count`、`avg_scene_ms`、`first_cut_ms`、`cuts_in_first_3s` | カットの特徴量 |
| `avg_watch_time_ms` | 最新のスナップショットの `ig_reels_avg_watch_time` |
| `retention_rate` | `avg_watch_time_ms / nullif(duration_ms, 0)`（F-VID-11。1 を超えることがある。繰り返し再生のため。丸めない） |
| `analysis_status` | 最新の解析の状態（`success` がなくても `no_video_url`／`failed` を見せるため。`attempt_count` も） |

- リーチ率、閲覧数などはこのビューに入れず、画面のクエリで R3 の `media_list_metrics` とつなぐ（同じ指標を 2 か所で定義しない）
- `media_analysis_dataset` は今のまま（すでに最新の `success` をつないでいる）。`retention_rate` を足すかは確認事項 Q5

---

## 6. 画面

### 6.1 投稿詳細（`/media/[id]`）

リールとフィード動画のとき、「リーチの伸び方」の下に全幅のカード「カットのタイムライン」を足す（見本の `cutTimeline` から文字の区間を除いたもの）。

- 上段の数字: 動画の長さ（秒、小数 1 桁）、画面変化（回）、平均シーン長（秒）、冒頭 3 秒の画面変化（回）、最初の画面変化まで（秒）。用語は要件 4.5 章の注意に従い「カット」でなく「画面変化」と書く。ヒントは「画面が大きく切り替わった回数。編集上のカットと一致しないことがある（フェードやズームにも反応する）」
- タイムライン: 横軸は 0〜動画の長さ。シーンを交互の濃淡の帯で描き、カットの位置に三角の印。帯にマウスを乗せると「シーン n: x.x 秒」
- 「質の指標」の視聴維持率、「量の指標」の動画の長さは、解析結果があれば値を出す（R3 では「—」）。比べる相手は同じ種類の、解析結果のある投稿
- 解析結果がないとき: カードは出し、本文に状態だけ書く。`no_video_url` は「動画を取得できなかった」、`failed` は「解析に失敗した」、まだ解析していないときは「まだ解析していない」。エラーの文面（`error` 列）は出さない

### 6.2 リール分析（`/reels`）

見本（design-lab v3 の `S.reels`）から文字の要因を除いて作る。既定の期間は過去 1 年間（365 日。要件 4.5 章）。対象はリールだけ（フィード動画は件数が 0 で、リールと混ぜると比べ方が変わるため入れない）。

| カード | 内容 | 要件 |
|---|---|---|
| 見出し | 「リール n 件（過去 1 年間）・目的変数: リーチ率」 | — |
| 要因との関係 | 要因（動画の長さ、画面変化の回数、平均シーン長、冒頭 3 秒の画面変化、最初の画面変化まで、キャプションの長さ、投稿の時刻）と目的変数の順位相関と、ブートストラップの 95% の幅。幅が 0 をまたぐものは薄く「まだわからない」 | F-VID-13 の代わりの要約 |
| 上位と下位 | 目的変数の上位 25% と下位 25% のサムネイルと、要因の中央値の表 | — |
| 散布図 | 数値の要因 × 目的変数（6 枚）。点にマウスを乗せると題名と値。点を押すと投稿詳細 | F-VID-13 |
| 区分 | 長さの区分（0〜15、15〜30、30〜60、60 秒超）、冒頭 3 秒の画面変化（0 回／1 回以上）、曜日（平日／土日）、時間帯（朝／昼／夜）ごとの目的変数の中央値。棒の下に件数。3 件未満の区分は薄く | F-VID-12 |
| 視聴と反応 | 視聴維持率、スキップ率、シェア率、保存率 × 目的変数の散布図 | F-VID-11 |
| 一覧 | リールの表: サムネイル、題名、投稿日、経過日数、長さ、画面変化、平均シーン長、冒頭 3 秒、閲覧数、リーチ、平均視聴時間、視聴維持率、スキップ率、シェア率、保存率、リーチ率。列の見出しで並べ替え。見本にはない（確認事項 Q2） | F-VID-10 |

- 計算（順位相関、ブートストラップ、中央値）はサーバーで行い、数値だけを描画に渡す。ブートストラップは種を固定し、同じデータなら毎回同じ幅にする
- 解析結果のないリールは要因の計算から外し、見出しの下に「動画を解析していないリール n 件は除いた」と件数だけ書く
- 件数による手法の切り替えはしない（相関の幅で「まだわからない」を示す。2026-10-06 のユーザーの決まり「比べ方を自動で切り替えない」）
- グラフは R3 と同じく SVG を自作する（`components/charts/`）。散布図と、横向きの幅のグラフ（フォレスト）を足す
- ナビゲーションに「リール分析」を足す（投稿詳細の次。見本の順）

#### 目的変数（確認事項 Q1）

リーチ率（7 日時点のリーチ ÷ 投稿時のフォロワー数）は、投稿時のフォロワー数の記録がある投稿（収集開始の 2026-10-01 以降）にしか出ない。今の本番では、リーチ率のあるリールはほとんどない（未確認。段階 0 で数える）。このままでは画面の大半が空になる。

案:
- A. リーチ率に固定（要件どおり）。数か月は空に近い
- B. 右上に目的変数の選択を置く（リーチ率、最新のリーチ、最新の閲覧数、視聴維持率）。既定はリーチ率。投稿時刻の画面（F-UI-42）の指標の選択と同じ形。選択は見る人が決め、データの状況で自動では変えない
- C. B と同じで、既定を最新の閲覧数にする

推奨は B。

### 6.3 投稿一覧（`/media`）

変えない。動画の特徴量はリール分析の一覧（6.2）に出す。

---

## 7. テスト

| 区分 | 内容 |
|---|---|
| 単体（worker） | 対象の選び方（種類、`gone_at`、打ち切り、新しい順、上限）、`media_url` の取り直しの各場合（なし、`transient`、`fatal`、`VIDEO` でない）、`attempt_count` の加算、ffmpeg がないときに残りを飛ばす、`video-tune` のしきい値ごとの集計（純関数）、`metadata=print` の出力の解析 |
| 結合（worker と DB） | `upsertVideoAnalysis` の `attempt_count`、`stories` の既存のテストがそのまま通る |
| DB | `media_video_features` の 1 投稿 1 行、最新の `success` を選ぶ、`retention_rate` の分母 0、`web_app` で読める（`web-role.test.ts` に足す） |
| 画面 | 順位相関とブートストラップ（既知の値、同順位、件数 0〜2）、長さの区分の境界（15、30、60 秒ちょうど）、タイムラインのシーンの幅、解析結果のない投稿の表示 |
| 実機 | 手元の Supabase で数本、本番で既存のリールすべてに結果が入ること（完了条件） |

---

## 8. 段階

| 段階 | 内容 | 担当の案 |
|---|---|---|
| 0 | 本番のリールの本数、リーチ率のあるリールの本数を数える（Q1 の判断の材料） | 親（読むだけの SQL をユーザーに頼む） |
| 1 | マイグレーション、`video_analysis` ジョブ、`video-tune`、共通化、テスト。手元で数本を解析して時間を計測 | `node-worker-developer`、SQL は `postgres-sql-reviewer` がレビュー |
| 2 | しきい値を決める（ユーザーの目視） | ユーザーと親 |
| 3 | 本番に反映（`db push`、main にマージ）。既存のリールが数時間で解析されることを確かめる | 親とユーザー |
| 4 | 画面（投稿詳細のタイムライン、リール分析） | `nextjs-developer` |
| 5 | テストの不足、セキュリティレビュー、ユーザーの画面の確認 | `quality-engineer`、`security-engineer`、ユーザー |

段階 1〜3 と段階 4 は並べて進められる（画面は手元の Supabase の解析結果で作る）。

---

## 9. 確認事項

| # | 問い | 推奨 |
|---|---|---|
| Q1 | リール分析の目的変数（6.2 節） | B: 選択を置き、既定はリーチ率 |
| Q2 | F-VID-10 のリールの一覧をリール分析の画面の下に置くか | 置く（見本にはないが要件にある） |
| Q3 | しきい値を変えたとき、条件の違う解析結果（R1 のストーリーズ）が混ざることを画面で示すか | 示さない。データセットのビューには `scene_threshold` の列があるので、分析するときに分けられる |
| Q4 | `scene_score` を拾うようにしても `ANALYZER_VERSION` を上げないか | 上げない（カットの時刻は同じ） |
| Q5 | `media_analysis_dataset` に `retention_rate` を足すか | 足す（CSV や SQL で使う機会が多い） |
| Q6 | 1 回の上限 5 本、打ち切り 5 回 | このまま。段階 1 の計測で見直す |

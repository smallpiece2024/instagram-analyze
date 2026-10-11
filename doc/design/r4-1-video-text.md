# R4.1 動画分析（画面の文字）の設計

- 版: 0.2（2026-10-11）。4 本のレビュー（DB、セキュリティ、品質、画面）の指摘を反映した。ユーザーの確認待ち（10 章）

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-11 | 起草（`node-worker-developer`） |
| 0.2 | 2026-10-11 | 4 本のレビューの指摘をすべて反映。DB: D1〜D17（ビューは一意キーの 4 列で結合し特徴量だけ版で null、(b) は `update`、`ocr_usage.analysis_id` は最初から埋まる、revoke、`create or replace view` の全文と `security_invoker`、フレームの check、列名 `vertical_position`／`elapsed_ms`、月の範囲を JS で渡す、`lock_timeout`、`search_path`、(b) を本数の上限に数えない、原子性の前提）。セキュリティ: S1〜S18（鍵の固定文言と検査、`add-mask` と `ctx.mask` の二重化、鍵のライフサイクル、途中落ちの備え (a)(b)(c)、月の上限の範囲を 1,000 まで、検索の正規化は TS、`scope` は `cloud-vision`、`visionKey` は 2 項目、`redirect: "error"`、Secret は hourly だけ、テストの鍵は生成、`video_text_frames` の権限を作らない、表示と大きさの上限、`spawn` の `env`、鍵が不正でもほかのジョブを止めない、再送のユニット、`.local/ocr-check` の削除）。品質: T1〜T26（最後のフレームを含めない、計画の安定、最悪の時間と再送の条件、長さ 0、文字数の単位、短い文字の揺れ、決定性、既知の挙動、見落としの定義、1 本で上限を超える本、失敗した要求のユニット、2026-10 の変数、段階の手順と合格条件、種データ、固定データの作り方、テストの追加、検索の並びと上限、画像の大きさの出所、`max_chars_per_frame` の定義、`MAX_PER_RUN = 0`、期日）。画面: U1〜U26（`y` と同じ指標の図を出さない、`FACTORS` は 3 つ、重なる区間の描き方、時刻のクリップ、新しい文言を足さない、`q` の保持、並びと上限、`Suspense`、定数の置き場所、`hide-m`、散布図 10 枚、色と線、code point、JSON の列、見出し、`labels`、折り返し、区分の配置、列名と並べ替えのキー、検索の位置、強調しない、`no-store`、今月の行、「画面変化」、`Promise.all`） |

- 検討メモ: `doc/ai-decisions/r4-1-video-text-ocr.md`（方式は Google Cloud Vision の `DOCUMENT_TEXT_DETECTION` に決定。2026-10-11、ユーザー。動作確認の結果と上限は同メモ 5〜6 章。AI-07 の記録は同メモ 4 章と 7 章）
- 要件: `doc/requirements/requirements-definition.md` 4.5.1 章（F-VID-20〜32）、5.1 章「AI・OCR の利用記録」、5.3 章「画面の文字（R4.1）」、8.7 章（AI-01〜07）、9 章「AI・OCR の利用状況」、10 章（R4.1 の完了条件）
- 既存: R4 の `video_analysis`（`doc/design/r4-video-analysis.md`、`apps/worker/src/jobs/video-analysis.ts`、`jobs/video-store.ts`、`lib/video-analysis.ts`、`lib/ffmpeg.ts`、`db/video.ts`）、`video_analyses`／`video_cuts`（`supabase/migrations/20261001100200_r1_video.sql`、`20261007000000_r4_video.sql`）、投稿詳細（`apps/web/src/lib/queries/media-detail.ts`、`components/charts/CutTimeline.tsx`、`app/media/[id]/_detail/CutTimelineCard.tsx`、`lib/video-timeline.ts`）、リール分析（`lib/reels.ts` の `FACTORS`、`lib/queries/reels.ts`、`app/reels/`）、収集ログ（`app/jobs/`）、`check-alerts`（R2 設計 5.2 章。`commands/check-alerts.ts`、`jobs/alerts.ts`）
- デザイン: `doc/design-system.md`。既存の部品（`Card`、`Callout`、`MetricHint`、`MissingValue`、`SortHeader`、`Loading`、`components/charts/`）を使い、新しい見た目と説明文を足さない

この文書で「未確認」と書いたものは、起草時に確かめられなかった事実。実装の前（段階 0）に確かめる。

---

## 1. 目的と範囲

### 1.1 R4.1 でやること

| 区分 | 内容 | 要件 |
|---|---|---|
| 収集 | ジョブ `video_text` を hourly グループの `video_analysis` の次に足す。`video_analysis` が成功したリールとフィード動画からフレームを取り出し、Google Cloud Vision の `DOCUMENT_TEXT_DETECTION` に送り、フレームごとの読み取り結果、文字の区間、特徴量、API の利用記録を保存する。新しい投稿も既存の投稿も同じジョブで順に処理する（R4 と同じく、まとめ処理の専用の仕組みは作らない） | F-VID-20〜26 |
| 上限 | 月のユニット（無料枠 1,000）と月の本数（30）の上限。達したら処理を止め、`check-alerts` で通知する | F-VID-26、AI-04 |
| DB | 表 4 つ（動画ごとの解析、フレームごとの結果、区間、API の利用記録）、今の条件を返す関数、`media_video_features` と `media_analysis_dataset` への列の追加、月ごとの利用のビュー | 5.1 章、5.3 章、AI-03 |
| 画面 | 投稿詳細のタイムラインに文字の区間、リール分析に文字の要因と区分、文字で探す、収集ログに「AI・OCR の利用状況」 | F-VID-30〜32、9 章 |

### 1.2 R4.1 でやらないこと

- 方式の比較（検討メモ 7 章で決定済み）。Tesseract、PaddleOCR、Claude は使わない
- テロップと背景の文字の区別を OCR に求めない（API は区別しない。要件 4.5.1 章の注記）。区間ごとの「テロップらしさ」は位置と大きさからの推定（4.3 節）で、確かな分類ではない
- 見た目がほぼ同じ連続フレームの間引き（要件 8.7.3 章末尾、AI-05）。無料枠に収まる見込みなので版 0.2 では行わず、後の最適化の案だけ書く（3.4 節、Q2）
- 縦書き、手書き風、看板と重なった文字の読み取りの精度の改善（API の結果をそのまま使い、区間化で前後のフレームから補うだけ）
- フレームと動画の保存（NF-CAP-03）。残すのは読み取りの結果だけ
- ストーリーズとカルーセルの中の動画の文字（R4 と同じ理由。ストーリーズは 24 時間で消え、カルーセルの子は指標と結び付かない）
- 文字の意味の分類、要約、タグ付け（R7 以降の LLM の用途）

---

## 2. R4 までで済んでいるもの

| もの | 内容 |
|---|---|
| 表 | `video_analyses`（今の条件の `success` の行から `duration_ms` を使う）、`video_cuts`（カットの時刻 `at_ms`） |
| ジョブの作法 | `video_analysis` の、`media_url` の取り直し（`GET /{media-id}?fields=id,media_type,media_url`。ID は `isMediaId` で確かめる）、ダウンロード（`downloadToFile`。https、ホストの後方一致、200 MB、60 秒、`content-type` が `video/`、`redirect: "error"`）、一時ディレクトリ（`mkdtemp` と `finally`）、本数と時間の予算、打ち切り（`attempt_count`）、ログの決まり（`media_id` と URL を出さない）。`video_text` は同じ作法で書く |
| ffmpeg | `lib/ffmpeg.ts` の `runOrThrow(tool, args, timeoutMs)`、`toolVersion`、`CommandError`、`resizeImageArgs`（1 枚の JPEG。`scale=<width>:-2 -frames:v 1 -q:v 4`）。R4 設計 3.5 節の入力の制限（`-protocol_whitelist file -f mp4`） |
| 条件の持ち方 | `current_video_condition()`（今の条件を DB の関数に持ち、画面のビューはその条件の行だけを使う。変えるたびにマイグレーションで作り直す） |
| 枠組み | `JobContext` の `jobRunId`（文字列）、`startedAt`、`now()`、`mask`（`sanitizeForLog`。起動時の secrets を置換）、`recordFailure`（`errorClass` は `rate`／`auth`／`db`／`download`／`unknown` と項目の分類 `fatal`／`transient`） |
| 画面 | 投稿詳細の「カットのタイムライン」（`CutTimeline`、`TimelineModel`、`timelineModel`、`videoAnalysisMissing`、`getVideoFeatures`）、リール分析の要因（`FACTORS` は 8 個。`cuts_in_last_3s` が R4 設計の後に増えた。散布図は `scatter: true` の 7 枚）、「視聴と反応」（`RESPONSE_METRICS` = 視聴維持率、スキップ率、シェア率、保存率 × `y`）、区分（1 行目 `動画の長さ col-6 / 冒頭 3 秒 col-3 / 最後 3 秒 col-3`、2 行目 `平日と土日 col-3 / 曜日 col-6 / 時間帯 col-3`）、一覧（17 列。横スクロールの枠、`hide-m`）、目的変数の選択 `y`（`ObjectiveChips`、`objectiveHint`、`OBJECTIVE_LABEL`）、`reelsQuery`（`y`、`sort`、`dir`）。`/jobs` は各カードを `<Suspense>` で包み、失敗はカードの中（R3 4.5 節）。`/reels` は `next.config.ts` の `NO_STORE_PAGES` に入っている |
| 通知 | `check-alerts --scope hourly\|daily`。判定は `jobs/alerts.ts` の `evaluateAlerts`（純関数）。該当があれば `WARN alert=…` と終了コード 1 で GitHub の失敗メールになる |
| 権限 | `web_app` ロール。表は `revoke all … from public, anon, authenticated`（Supabase が `public` の新しい表に配る既定の権限を外す。R5 の 203〜205 行）→ `grant select … to web_app` → `create policy web_app_select on … for select to web_app using (true)`。ビューは `with (security_invoker = true)`、`revoke all`、`grant select`。関数は `revoke execute … from public` と `grant execute … to web_app`（`web-role.test.ts` が棚卸しする） |
| SQL | `normalize(text, NFKC)` は R5 の `caption_hashtags()`（`20261009000000_r5_analysis.sql` 122 行）で使用済み（本番にも 2026-10-08 に反映済み。親が確認） |
| 実行の直列 | `collect.yml` の `concurrency` は `group: instagram-analyze-collect`、`cancel-in-progress: false` で、実行は常に 1 本。手元の常駐ワーカーは止めている（R2） |
| 鍵と API の確認 | `scripts/ocr-check.mjs` が `node:crypto` だけで JWT → アクセストークン → `images:annotate` を通した（2026-10-11。11 章） |

---

## 3. 収集: `video_text` ジョブ

### 3.1 対象と選び方

対象は次をすべて満たす投稿。選ぶのは `db/video-text.ts` に足す `listVideoTextCandidates` の SQL 1 本で、再試行と打ち切りの判定もこの SQL に置く（R4 3.1 節と同じ）。

- `media_type = 'VIDEO'` かつ `media_product_type in ('REELS', 'FEED')`、`gone_at` が null
- `video_analyses` に今のカットの条件（`ANALYZER_VERSION`、`DEFAULT_SCENE_THRESHOLD`）の `success` の行があり、`duration_ms` が **0 より大きく** `VIDEO_TEXT_MAX_DURATION_MS`（3 分。3.2 節）以下（R4 は長さ 0 の `success` を許すので 0 を除く。長すぎる動画はフレームが多すぎて無料枠を使い切るので対象にしない）
- 今の OCR の条件の `video_text_analyses` の行がない、または **(a)** `status <> 'success'` かつ `attempt_count < 上限` かつ `analyzed_at <= now − 3 時間`、または **(b)** `status = 'success'` かつ `segmenter_version` が今の版と違う（区間化と特徴量だけ計算し直す。ダウンロードも API も使わない）

**条件の列**。「同じ入力を同じ条件で二度処理しない」（F-VID-25、AI-03）の「条件」を次の 5 つに分ける。

| 列 | 値（版 0.2） | 変えたときの影響 |
|---|---|---|
| `ocr_method` | `google_vision` | 方式を変えたら全件を再処理（ユニットを使う） |
| `ocr_version` | `v1/DOCUMENT_TEXT_DETECTION` | API の版か機能を変えたら全件を再処理 |
| `frame_interval_ms` | `1000` | 間隔を変えたら全件を再処理 |
| `analyzer_version` | `1` | フレームの取り出し方（カット直後のずらし、重ねない幅、JPEG の幅と品質）と要求の作り方の版。変えたら全件を再処理 |
| `segmenter_version` | `1` | 区間化の規則と特徴量の定義の版。変えても API は呼ばず、保存したフレームの結果から計算し直す（AI-03「使い回す」） |

一意キーは前の 4 つ `(media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version)`。`segmenter_version` は同じ行の列で、計算し直したら上書きする。カットの条件（しきい値）は OCR の条件に含めない（しきい値を変えてもユニットを使って再処理しない）。使ったカットの解析の行は `video_analysis_id` に残し、**再試行 (a) と再区間化 (b) の計画はこの行から作る**（3.6 節。今のカットの条件が変わっても計画が変わらず、API を呼ばない）。しきい値の変更に合わせて読み直したいときは `analyzer_version` を上げる。

```sql
select m.id, m.posted_at,
       va.id as video_analysis_id, va.duration_ms,
       vt.id as text_analysis_id, vt.status as text_status, vt.segmenter_version,
       vt.video_analysis_id as stored_video_analysis_id, vt.duration_ms as stored_duration_ms
from public.media m
join public.video_analyses va
  on va.media_id = m.id and va.analyzer_version = $2 and va.scene_threshold = $3 and va.status = 'success'
left join public.video_text_analyses vt
  on vt.media_id = m.id and vt.ocr_method = $4 and vt.ocr_version = $5
 and vt.frame_interval_ms = $6 and vt.analyzer_version = $7
where m.account_id = $1
  and m.gone_at is null
  and m.media_type = 'VIDEO'
  and m.media_product_type in ('REELS', 'FEED')
  and va.duration_ms > 0 and va.duration_ms <= $8
  and (vt.id is null
       or (vt.status <> 'success'
           and vt.attempt_count < $9
           and vt.analyzed_at <= $10::timestamptz - make_interval(hours => $11))
       or (vt.status = 'success' and vt.segmenter_version <> $12))
order by m.posted_at desc, m.id
```

- 全件を返し（数十本）、JS で先頭から処理する。残りの数を `skipped_by_limit`、`skipped_by_budget`、`skipped_by_unit_limit`、`skipped_by_monthly_cap` としてログに出す（3.7 節）
- カットの時刻は 1 本ずつ `video_cuts` から `seq` 順に読む（候補の SQL に配列で含めない。対象は数十本なので往復は問題にならない）
- 結合は両方とも一意制約の索引（`video_analyses` は `(media_id, analyzer_version, scene_threshold)`、`video_text_analyses` は 5.2 節の一意制約）が使われる。新しい索引は要らない
- `now` は `ctx.now()` を渡す（R4 と同じ。SQL の `now()` は使わない）
- (b) の本はダウンロードも API も使わないので、本数の上限（3.2 節の `WORKER_VIDEO_TEXT_MAX_PER_RUN`）には数えず、時間の予算だけ見る（`segmenter_version` を上げた後、既存の全本が 1 回の hourly で計算し直される）

### 3.2 グループの中の位置と、本数・時間・ユニットの予算

- hourly グループを `stories` → `media_sync` → `media_snapshot` → `video_analysis` → **`video_text`** → `account_backfill` にする。新しい投稿は同じ回に `video_analysis` の後で処理できる
- ジョブの途中では止めない（R4 3.2 節と同じ作法）。長さと費用は次で抑える。いずれも「新しい 1 本を始める前」（と再送の前。下）にだけ見る

| 設定 | 既定 | 範囲 | 意味 |
|---|---|---|---|
| `WORKER_VIDEO_TEXT_MAX_PER_RUN` | 5 | 0〜100 | 1 回に OCR する本数（(b) の本は数えない）。**0 のときは候補を数えて `info` を出すだけで終わる**（鍵と ffmpeg の確認もトークンの取得もしない。本番で一時的に止めるときに GitHub の変数で 0 にする。R4 の `WORKER_VIDEO_MAX_PER_RUN` は下限 1） |
| `WORKER_VIDEO_TEXT_BUDGET_MS` | 8 分 | 0〜30 分 | 時間の予算。ジョブの開始からの経過がこれを超えていたら、新しい 1 本を始めず、**失敗した要求の再送もしない**（3.6 節） |
| `WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN` | 200 | 1〜1,000 | 1 回のユニット。**この本の送る枚数だけで超える本は飛ばして次へ進み**、`warn`（固定文言「1 回の上限より枚数が多い」）を出し `skipped_by_unit_limit` に数える（行は書かない。先頭の本が毎回全体を止めないため）。「この回で使ったユニット ＋ この本の枚数」が超えるなら、この本と残りを始めず `skipped_by_unit_limit` に数える。枚数は長さとカットから計算でき、ダウンロードの前に分かる（3.4 節）。**再送の分は判定に含めない**（記録には含める。3.3 節） |
| `VIDEO_TEXT_MAX_DURATION_MS`（定数） | 3 分 | — | 対象にする動画の長さの上限（3.1 節の SQL）。リールの最長は 3 分（未確認）。1,000 ms 間隔で最大約 185 枚 |
| `VIDEO_TEXT_EXTRACT_BUDGET_MS`（定数） | 3 分 | — | 1 本のフレームの取り出し全体の制限（1 枚は 15 秒）。超えたらこの本は `failed`（固定文言「フレームの取り出しが長すぎる」） |

`config.ts` は `integerInRange(env, "WORKER_VIDEO_TEXT_MAX_PER_RUN", 既定, 下限, 上限)` の形で読む（R4 の `videoMaxPerRun`、`videoBudgetMs` と同じ）。

**1 本の順**: 計画（3.4 節。長さとカットから）→ 1 回と月の上限の判定 → （この回の最初の本なら）トークンの取得 → 取り掛かりの記録（3.6 節 (a)）→ `media_url` の取り直し → ダウンロード → 取り出し → 送信（要求ごとに保存）→ 区間化 → 結果の書き込み。トークンの取得はダウンロードの前に行う（認証の失敗でダウンロードしない）。

**時間の見込み**: ダウンロード（R4 の計測ではシーン検出を含めて 1 本約 2.4 秒）、フレームの取り出し 22〜30 枚 × 0.1〜0.5 秒（未確認）、Vision 3〜4 要求 × 1〜3 秒（未確認）で、1 本 10〜30 秒。5 本で 1〜3 分。

**最悪の時間**（制限時間: ダウンロード 60 秒、取り出し全体 3 分、`images:annotate` 1 要求 30 秒、再送は 429 と 5xx だけで 2 回まで、待ち 2 秒と 8 秒、予算を超えたら再送しない）:

- 予算（8 分）の直前に始めた 1 本: 60 秒 ＋ 3 分 ＋ 4 要求 × 30 秒（予算を超えているので再送なし）= 6 分 → ジョブ全体で約 14 分
- 予算の中で再送を使い切る 1 本: 60 秒 ＋ 3 分 ＋ 4 要求 × (30 ＋ 2 ＋ 30 ＋ 8 ＋ 30) 秒 = 約 10.7 分。予算の 8 分より前に始めた本しか再送しないので、ジョブ全体でこれを超えない組み合わせはない

R4 の `video_analysis` の最悪（約 15 分）と重なっても、両方が同時に最悪になることは考えにくい。`collect.yml` の 30 分に対し、ほかのジョブは合わせて 1 分に満たない（R4 3.2 節）。段階 0 で実測し、Q6 で見直す。

### 3.3 月の上限と月の境目

| 設定 | 既定 | 範囲 | 意味 |
|---|---|---|---|
| `WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT` | 1,000 | **0〜1,000** | 月のユニットの上限。範囲の上限は無料枠と同じ（打ち間違いで有料の領域に入らない。超えたいときはコードを変える） |
| `WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS` | 30 | 0〜1,000 | 月の本数の上限（検討メモ 5.3 節） |

- **月は UTC の暦月**（Q4）。Google の無料枠の「月」がどの時刻で切り替わるかは未確認（請求アカウントの暦月。時間帯は未確認）。UTC は DB の `timestamptz` と `job_runs` と同じ基準。JST と最大 9 時間ずれるが、月末の数時間に処理が集中することはなく、上限の余裕で吸収する
- **判定**: 1 本を始める前に `ocr_usage`（5.2 節）から今月の合計を読む（`db/video-text.ts` の `monthlyOcrUsage(db, accountId, monthStart, nextMonthStart)`）。月の始まりと次の月の始まりは JS で `Date.UTC(y, m, 1)` から作って `timestamptz` として渡し、SQL は `where account_id = $1 and requested_at >= $2 and requested_at < $3` の範囲で `coalesce(sum(units), 0)` と `count(distinct media_id)` を取る（索引 `(account_id, requested_at)` が効く。列に `date_trunc` を掛けない）。`使用済み + この本の送る枚数 > ユニットの上限`、または `本数 >= 本数の上限` なら、この本も残りも始めず `skipped_by_monthly_cap` に数え、`warn` を 1 行出す（固定文言「月の上限に達した」）。`recordFailure` はしない（ジョブの失敗ではない）。(b) の本はユニットを使わないので上限の判定をせず処理する
- **本数の数え方**: `count(distinct media_id)` は「その月に要求を送った本」。消えた投稿（`on delete set null`）、(b) の本、送る枚数が 0 の本は数えない（表とビューの comment に書く）
- **失敗した要求のユニット**（`ocr_usage.units`）: 429、401、403（Google が処理していない）は 0。5xx、制限時間切れ、2xx（1 枚ごとの `error` を含む）、その他の 4xx（400 など）は `image_count`（多めに数える側に倒す。Google が課金するかは未確認）。再送は 1 要求 1 行なので、記録のユニットは 1 回の上限（3.2 節）を超えうる
- **原子性**: 月の判定は「読んでから書く」で原子的でなく、応答の後に `ocr_usage` を書くので、その間に落ちるとユニットが数えられない。実行元が 1 つ（2 章「実行の直列」）なので許容する（7 章）
- **手動の確認は数えない**: `scripts/ocr-check.mjs` の利用（2026-10 に 93 ユニット。段階 0 で 100 以内、段階 2 の手元の処理で 60〜90）は `ocr_usage` に入らない。手動で使ったユニットは段階 0 と段階 2 で検討メモ 6.2 節に記録する。2026-10 の本番の変数は 700 にし（Q4）、11 月にずれたら 1,000 に戻す（9 章）
- **通知**: `jobs/alerts.ts` の `evaluateAlerts` に種類 `ocr_monthly_cap` を足す。`check-alerts --scope daily` が `ocr_usage` の今月（UTC）の合計と上限（`WorkerConfig` の 2 つ）を比べ、ユニットか本数が上限以上（`>=`）なら `WARN alert=ocr_monthly_cap units=<n> videos=<n>` と終了コード 1。`hourly` に入れると月が替わるまで毎時の失敗メールになるので `daily`（1 日 1 通）にする（Q11）。`check-alerts` は鍵を使わない（DB と設定だけ）

### 3.4 フレームの取り出し

**時刻の決め方**（`lib/video-text.ts` の純粋関数 `frameTimes(durationMs, cutsMs, { intervalMs: 1000, cutOffsetMs: 100, mergeWindowMs: 300 })`）:

1. カット直後: 各カットの `at_ms + 100`。**`duration_ms` 以上は捨てる**（`at_ms < duration_ms`。最後の時刻は復号するフレームがなく出力が空になりうる）。互いに 300 ms 未満しか離れていなければ先のものだけ残す
2. 一定間隔: `0, 1000, 2000, …`（**`duration_ms` 未満**。0 を含める。冒頭のテロップは 0 ms から出ている）
3. 2 の各時刻は、1 のいずれかと 300 ms 未満の差なら捨てる（カット直後を優先する。要件 8.7.3 章末尾）
4. 昇順に並べ、各フレームに `source`（`cut`／`interval`）を付ける。`duration_ms` が 0 以下なら空（3.1 節で除いているので通常は来ない）

例: R4 で目視した 21.2 秒のリール（カット 19 回。1.0〜19.0 秒に 1 秒ごと）は、カット直後 19 枚（1.1〜19.1 秒）＋ 間隔 0、20、21 秒の 3 枚 = 22 枚。1 秒ごとだけの 22 枚と同じ枚数で、位置がカットの直後に寄る。動作確認の 3 本（21〜27 秒）では 1 本 22〜30 枚の見込み。

**計画の安定**（再試行と再区間化で API を呼ばないために）: 新しい本の計画は今のカットの条件の `video_analyses` から作る。再試行 (a) の計画は `vt.video_analysis_id` の行の `duration_ms`（`vt.duration_ms` に写してある）と `video_cuts` から作る（`video_analysis_id` が `set null` になっていたら今の条件で作り直し、その旨を `warn`。保存済みで計画にないフレームは消す）。再区間化 (b) は `frameTimes` を呼ばず、保存済みのフレームの集合をそのまま計画にする。

**間隔と費用**（1 本 25 秒、カット直後の重なりを含めた概算）:

| 間隔 | 1 本 | 既存 18 本の一括 | 毎月（4〜8 本） |
|---|---|---|---|
| **1,000 ms（推奨）** | 約 26〜30 枚 | 約 470〜540 ユニット | 約 100〜240 ユニット |
| 500 ms | 約 51〜55 枚 | 約 920〜990 ユニット | 約 200〜440 ユニット |

500 ms だと一括処理だけで無料枠をほぼ使い切り、同じ月に投稿したリールが処理できない。テロップは 1 秒以上出続けるので、1,000 ms で区間の開始と終了の誤差は ±1 秒（カット直後の分でカットの直後は 100 ms に縮む）。F-VID-21 の「例: 0.5 秒ごと」は例であり、要件は間隔を調整できること（Q1）。

**類似フレームの間引き**（版 0.2 では行わない。Q2）: 行うなら `analyzer_version` を 2 にして、(a) ffmpeg の `mpdecimate` フィルタで前のフレームとほぼ同じフレームを落とす、または (b) 取り出した JPEG を幅 32 の灰色画像に縮めて前のフレームとの差分の平均が閾値未満なら送らない、のどちらか。動きのないカットが続くリールで 20〜40% 減る見込み（未計測）。無料枠に収まる間は複雑さに見合わない。

**取り出し**（ffmpeg。1 枚ずつ）:

```
ffmpeg -hide_banner -loglevel error -protocol_whitelist file -f mp4 -ss <秒> -i video.mp4 \
  -frames:v 1 -vf scale='min(1080,iw)':-2 -q:v 4 -y frame-<at_ms>.jpg
```

- `lib/ffmpeg.ts` に `extractFrameArgs(input, atMs, output, maxWidth = 1080)` を足す（`resizeImageArgs` と同じ形で引数の配列を返す純粋関数。`-ss` を `-i` の前に置き、キーフレームまで飛んでから目的の時刻まで復号する）。1 枚の制限時間は 15 秒（`runOrThrow`）、1 本の取り出し全体は 3 分（3.2 節）。1 枚 0.1〜0.5 秒の見込み（未確認。段階 0 で計る）
- **出力ファイルがない**（ffmpeg が終了コード 0 でもファイルを作らない、または 0 バイト）はこの本の `failed`（固定文言「フレームを取り出せない」。3.6 節）
- 1 回の ffmpeg で `select` フィルタを使って全枚数を出す方法は採らない（カット直後の時刻が不規則で式が長くなる。`-ss` の方が R4 で実績のある引数の形に近い）
- 入力の制限は R4 3.5 節と同じ（`-protocol_whitelist file -f mp4`）。`spawn` には最小の `env`（`PATH` だけ）を渡す（3.8 節。`process.env` の鍵を子プロセスに渡さない）
- フレームは動画と同じ一時ディレクトリ（`mkdtemp`）に置き、`finally` で動画ごと消す（F-VID-21、NF-CAP-03）
- **幅と品質**（Q5）: 幅 1080（元が 1080 未満なら拡大しない。`min(1080,iw)`）、JPEG 品質 `-q:v 4`。動作確認は 1080×1920 のままで確信度 0.96〜1.00 だったので、読み取りに実績のある大きさを保つ。ユニットは枚数で決まり画像の大きさに依らないので、縮小しても費用は変わらない。送る量（1 本 22〜30 枚 × 200〜400 KB = 5〜12 MB）と 10 MB の制限は 1 要求の枚数で解く（3.5 節）。1 枚の大きさは段階 0 で実測する（未確認。品質 4 で 200〜400 KB の見込み）
- **送った画像の大きさ**（`image_width`、`image_height`）は Vision の応答の `fullTextAnnotation.pages[0].width`／`height` から取る（取り出した JPEG を自分で読まない。文字のないフレームで `pages` がないときは最初に取れた値を使い、全フレームで取れなければ null）

### 3.5 Vision への要求

`lib/vision-client.ts` に `createVisionClient(key, { fetch, now, sleep })` を置く。`fetch` と `sleep`（再送の待ち）はテストで差し替える。

- **宛先**: `POST https://vision.googleapis.com/v1/images:annotate`（コードの定数。設定で変えられない）。本文は `{ requests: [{ image: { content: <base64> }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }, …] }`。`imageContext.languageHints` は付けない（Google の文書の推奨。動作確認もヒントなし。未確認: 動作確認のスクリプトがヒントを付けていないこと）。`parent`（処理地域）は付けない（Q12）。`fetch` は `redirect: "error"`（`download.ts` と同じ）
- **分割**（純粋関数 `splitRequests(frames, { maxImages: 8, maxBodyBytes: 6 MB })`）: 時刻順に詰め、8 枚か、base64 の合計（`ceil(bytes / 3) × 4`）が 6 MB を超える手前で切る。1 枚で 6 MB を超えるフレームは送らず、そのフレームを失敗（固定文言「画像が大きすぎる」）にする。API の上限（16 枚、JSON 10 MB）に対して半分の余裕を取る
- **認証**: 鍵（`config.visionKey` = `{ clientEmail, privateKey }`。3.8 節）から RS256 の JWT を作る（純粋関数 `createServiceAccountJwt(key, now)`: `iss` = `clientEmail`、`scope` = **`https://www.googleapis.com/auth/cloud-vision`**（`cloud-platform` より狭い。段階 0 で通ることを確かめ、通らなければ `cloud-platform` に戻す）、`aud` = トークンの URL、`iat`、`exp` = `iat + 3600`。署名は `node:crypto` の `createSign("RSA-SHA256")`）。`POST https://oauth2.googleapis.com/token`（コードの定数。鍵の `token_uri` との一致は `config.ts` が検査する）に `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` を送り、`access_token` と `expires_in` を得る。トークンはクライアントの中に持ち、`expires_in − 300 秒`まで使い回す。取得したトークンは `ctx.addSecret`（3.8 節）で `ctx.mask` の置換対象に足す。トークンは引数にも戻り値にもログにも乗せない（R1 10.5 章の決まりと同じ）。署名の失敗（OpenSSL の例外）は `auth` 分類の固定文言「Vision の鍵で署名できない」（3.6 節）
- **制限時間**: トークン 15 秒、`images:annotate` 1 要求 **30 秒**（`AbortSignal.timeout`）
- **応答の解釈**（純粋関数 `parseAnnotateResponse(json, imageCount)`）: 本文が JSON でない、`responses` がない、長さが枚数と違えば要求全体を失敗（`transient` 扱い）にする。各要素は `error` があればそのフレームの失敗（`code` だけ保存）、なければ `fullTextAnnotation` から 4.1 節の形に切り詰める（語数と文字数の上限もここで掛ける）。`fullTextAnnotation` がない（文字なし）は `text = ''`、`words = []` の成功
- **頻度**: 1 分あたり 1,800 要求の上限に対し、1 回のジョブで多くて 20〜25 要求。待ちは入れない。429 は 3.6 節
- 新しい npm 依存は足さない（`@google-cloud/vision` は使わない。11 章の事実票）

### 3.6 失敗の分類、再試行、打ち切り

| 事象 | 分類（`recordFailure` の `errorClass`） | 扱い |
|---|---|---|
| `WORKER_VIDEO_TEXT_MAX_PER_RUN = 0` | — | 候補を数えて `info` を出すだけで終わる（鍵と ffmpeg の確認をしない。失敗の記録なし） |
| 鍵がない（`config.visionKey` が `{ ok: false, reason: "missing" }`） | `unknown`。固定文言「Vision の鍵がない」 | ジョブの最初に判定。行を書かず、ダウンロードもせず、`recordFailure` を 1 回だけ記録して終わる（ffmpeg がないときと同じ。`attempt_count` は増えない） |
| 鍵の形が不正（`{ ok: false, reason: "invalid" }`） | `unknown`。固定文言「Vision の鍵の形が不正」 | 同上（起動は失敗させない。3.8 節） |
| ffmpeg がない | `unknown`。`NO_FFMPEG_ERROR` | 同上 |
| 署名できない | `auth`。固定文言「Vision の鍵で署名できない」 | 行を書かず `recordFailure` 1 回で、この回は終わる |
| トークンの取得が 400／401／403、`images:annotate` が 401／403 | `auth`。固定文言「Vision の認証に失敗（status n）」 | 行を書かず `recordFailure` 1 回で、この回は終わる（残りは次の回。鍵の失効は毎回の通知で分かる）。トークンは最初の本のダウンロードの前に取るので、認証が失敗した回はダウンロードしない |
| 429 | `rate`。固定文言「Vision の頻度の上限（status 429）」 | 2 秒、8 秒待って 2 回まで再送（`ocr_usage` の `units` は 0）。予算を超えていれば再送しない。だめなら行はそのまま（取り掛かりの記録 (a) で `failed` のまま）、この回は終わる |
| 5xx、ネットワークの失敗 | `transient`。固定文言「Vision の要求に失敗（status n／なし）」 | 同じ再送（`units` は `image_count`）。予算を超えていれば再送しない。だめならこの本は `failed`（送れたフレームは保存済み）。2 本続けて失敗したらこの回は終わる |
| 制限時間切れ（30 秒） | `transient`。同じ固定文言 | **再送しない**（この本は `failed`。`units` は `image_count`） |
| 400 など 4xx（要求の形、大きさ） | `fatal`。同じ固定文言 | この本は `failed`。再試行で同じ結果になるので `attempt_count` で打ち切られる |
| 1 枚ごとの `responses[].error` | — | そのフレームを `error_code` 付きで保存する。1 枚でもあればこの本は `failed`（固定文言「読めないフレームがある（n 枚）」、`recordFailure` は `unknown`）。次の回は足りないフレームだけ送る（下） |
| `ocr_usage` の書き込みの失敗 | `db` | 以後の送信を止め、この本は `failed`（固定文言「利用記録を書けない」）。この回は終わる（数えられないユニットを増やさない） |
| `media_url` がない | — | `no_video_url`。`warn` のみ（R4 3.4 節） |
| 取り直しの `fatal`／`transient`、`media_type` が `VIDEO` でない | R4 3.4 節と同じ | 同じ固定文言（`mediaFetchFailedError`、`NOT_VIDEO_ERROR` を再利用）。`transient` は行を取り掛かりの記録のまま残す（次の回に再び選ばれる） |
| ダウンロード、ffmpeg の失敗、出力ファイルなし、取り出し全体の制限（3 分） | `download`／`unknown` | `failed`。`error` 列は `DownloadError` の固定文言、`ctx.mask` 済みの文字列、または固定文言「フレームを取り出せない」「フレームの取り出しが長すぎる」 |

**途中落ちの備えと使い回し**（`collect.yml` の `timeout-minutes` やランナーの取り消しで途中で止まっても、送った分を捨てず、打ち切りも効くように）。1 本の処理は次の順。

1. **計画**: 3.4 節の「計画の安定」のとおり。(b) は保存済みのフレームの集合
2. **取り掛かりの記録** (a): `video_text_analyses` を upsert する（なければ挿入、あれば `status = 'failed'`、`error = '処理の途中で止まった'`（固定文言）、`analyzed_at = now`、`attempt_count + 1`、`planned_frame_count`、`video_analysis_id`、`duration_ms`、`segmenter_version` を今の版に）。これで行の `id` が決まり、途中で落ちても `failed` と `attempt_count` が残る（3 時間後に再試行、5 回で打ち切り）。(b) の本はこの手順を飛ばす
3. **必要なフレーム** = 計画 − 保存済み（`error_code` が null の `at_ms`）。計画にない保存済みの行は消す。0 枚なら、ダウンロードせず区間化だけして 7 へ（ユニット 0）
4. 必要なフレームだけ取り出して `splitRequests` で分け、要求ごとに送る
5. **要求ごとに 1 トランザクションで書く** (b)(c): `ocr_usage` に 1 行（`analysis_id` は 2 の `id`）、`video_text_frames` に応答の各フレームを `at_ms` で upsert、`video_text_analyses.units_used` に `units` を足す。この書き込みが失敗したら以後の要求を送らない
6. 全要求の後、保存済みのフレーム（計画のもの）を読み直し、区間化と特徴量を計算する（4 章）
7. **結果の書き込み**（1 トランザクション）: (a) は `update … set status, error, analyzed_at, ocr_frame_count, image_width, image_height, segmenter_version, 特徴量 where id = $1`（`attempt_count` と `units_used` は触らない。5 で足し済み）。`video_text_segments` はその `analysis_id` の行を消して入れ直す。(b) は `update … set segmenter_version, 特徴量, analyzed_at where id = $1`（`attempt_count`、`units_used`、`status`、`error` は触らない）と区間の入れ直しだけ
8. `success` は、計画したすべてのフレームに `error_code` が null の結果があるときだけ

**打ち切り**: `VIDEO_TEXT_MAX_ATTEMPTS = 5`（ジョブの定数。R4 と同じ）。`success` 以外で達した回に `warn` を 1 行。やり直すときは行を手元の SQL で消すか版を上げる（専用のコマンドは作らない）。

### 3.7 ログと利用記録

- `info`、`warn`、`debug`、`recordFailure` に `media_id`、URL、鍵、トークン、読み取った文字を入れない。件数、固定文言、HTTP の status だけ（公開ログに出るため）。Vision の `error.message` もログに出さない（`code` だけ）
- 最後に `info` で `candidates`、`processed`（`success` の本数）、`resegmented`（(b) の本数）、`no_video_url`、`failed`、`requests`、`units`（この回に記録したユニット。再送の分を含む）、`month_units`（この回の後の今月の合計）、`skipped_by_limit`、`skipped_by_budget`、`skipped_by_unit_limit`、`skipped_by_monthly_cap` を出す
- `success` は `ctx.progress.items += 1`（`items_fetched` は成功した本数）
- **`ocr_usage`**（5.2 節）: 1 要求 1 行。応答を受けた直後に、フレームと同じトランザクションで書く（3.6 節の 5）。失敗した要求も `ok = false` と `http_status`（ネットワークの失敗と制限時間切れは null）で書く。`units` は 3.3 節の規則。`job_run_id` は `ctx.jobRunId`（文字列。`bigint` の列にそのまま渡す）、`analysis_id` は取り掛かりの記録の `id`（初回から埋まる）。要件 5.1 章の「入出力の量」は `image_count`、`request_bytes`、`response_bytes`、`word_count`、「費用」はユニット（単価は画面で掛ける。6.4 節）

### 3.8 鍵の扱い

| 場所 | 持ち方 |
|---|---|
| GitHub Actions | Secret `GCP_VISION_KEY_JSON`（鍵の JSON ファイルの中身そのまま）。`collect.yml` の **hourly のステップ**の `env` にだけ渡す（`daily` と `check-alerts` のステップには渡さない） |
| 手元の Docker | `.env` に `GCP_VISION_KEY_FILE=.local/gcp-vision-key.json`（ユーザーが置いた場所）。compose でこのファイルをコンテナに読み取り専用でマウントする（未確認: compose の書き方。実装時に合わせる） |
| `config.ts` | `visionKey: { ok: true; key: { clientEmail: string; privateKey: string } } \| { ok: false; reason: "missing" \| "invalid" }`。`GCP_VISION_KEY_JSON` があれば JSON として読み、なければ `GCP_VISION_KEY_FILE` のファイルを読む（`process.env` とこのファイルを読むのは `config.ts` だけ）。`JSON.parse` とファイルの読み込みは try/catch で握り、例外の文面（入力の断片やパスを含む）を捨てて `reason: "invalid"` にする。検査: `client_email` が `/@[a-z0-9-]+\.iam\.gserviceaccount\.com$/` に合う、`private_key` が `-----BEGIN PRIVATE KEY-----` で始まる、`token_uri` が定数 `https://oauth2.googleapis.com/token` と一致（値は持たない）。合わなければ `reason: "invalid"`。**起動は失敗させない**（Vision は任意の機能。`video_text` 以外のジョブを止めない。3.6 節の表） |
| `check-env` | 「Vision の鍵: あり／なし／形が不正」だけを出す |
| マスク（二重化） | (a) `collect.yml` に、既存の「mask db host」のステップにならって、`jq -r` で `.client_email`、`.project_id`、`.private_key_id`、`.private_key` の各行（`-----` で始まる行と空行を除く）を `::add-mask::` に登録するステップを足す（GitHub のマスクは Secret の値そのもの（各行）にしか効かず、`JSON.parse` 後の値は別の文字列になるため）。(b) ワーカー側は、`config.ts` が読んだ `clientEmail` と `privateKey` の各行（`-----` の行を除く）を枠組みの secrets（`sanitizeForLog` の置換対象）に加え、アクセストークンはクライアントが取得時に `ctx.addSecret(value)` で加える（`framework.ts` に `addSecret` を足す。小さな変更。段階 2） |
| 子プロセス | `runOrThrow` の `spawn` に `env: { PATH: process.env.PATH }` を渡す（`process.env` の `GCP_VISION_KEY_JSON` と既存の `META_APP_SECRET` を ffmpeg に引き継がない。`ffmpeg-real.test.ts` で動くことを確かめる。段階 2） |

- 鍵の値、`private_key`、アクセストークンをログ、例外の文面、`recordFailure`、DB、生の応答の保存に入れない。失敗の文面は固定文言と HTTP の status だけ
- API キー方式（`?key=`）は使わない（用途で絞れず、ログの URL に出る恐れがある）
- 推奨（ユーザーの作業。コードの外）: Vision 専用のプロジェクトにし、他の API を有効にしない（Vision には IAM の権限の定義がなく、鍵が漏れると同じプロジェクトの有効な API を呼べる）。サービスアカウントにロールを付けない（動作確認でロールなしで呼べた）。Google Cloud の予算アラート（$1）と、Vision API のクォータを下げられるなら必要量付近（1 日 300 要求程度）にする（段階 0 で確認）

**鍵のライフサイクル**

| 場面 | 手順 |
|---|---|
| 差し替え（周期の目安 90 日） | Google Cloud で新しい鍵を作る → Secret `GCP_VISION_KEY_JSON` と `.local/gcp-vision-key.json` を替える → 旧鍵を Google Cloud で削除 → 次の hourly の `video_text` が成功することを `/jobs` で確かめる |
| 漏えいの疑い | 鍵を削除 → サービスアカウントを無効化 → Google Cloud の利用量（Vision の要求数）で不正な利用がないか確かめる → 新しい鍵で差し替え |
| 手元の鍵 | 手元と CI で同じ鍵を使う。段階 0 と段階 2 が終わったら手元の鍵を消すか、手元用に別の鍵を作る（Q10） |
| 別案（Q10） | Secret を `GCP_VISION_CLIENT_EMAIL`、`GCP_VISION_PRIVATE_KEY`、`GCP_VISION_PROJECT_ID` の 3 つに分ける（GitHub のマスクが各値にそのまま効く。`add-mask` のステップが要らない） |

### 3.9 ファイルの担当

R1 設計 10.3 章にならい、触るファイルを分ける。

| ファイル | 内容 | 段階 |
|---|---|---|
| `apps/worker/src/jobs/video-text.ts` | ジョブ本体（`createVideoTextJob(deps)` と `export const job`）。対象、予算と上限の判定、取り直し、1 本の流れ、ログ | 2 |
| `apps/worker/src/lib/video-text.ts` | 純粋関数: `frameTimes`、`normalizeText`、`codePoints`、`editDistance`、`frameLines`、`segmentFrames`、`summarizeSegments`、定数（版、`SEGMENTER_PARAMS`） | 2 |
| `apps/worker/src/lib/vision-client.ts` | JWT、トークン、`images:annotate`、`splitRequests`、`parseAnnotateResponse` | 2 |
| `apps/worker/src/lib/ffmpeg.ts` | `extractFrameArgs` を足す。`runOrThrow` の `spawn` に最小の `env` | 2 |
| `apps/worker/src/jobs/framework.ts` | `ctx.addSecret`（共有ファイル。親が承認） | 2 |
| `apps/worker/src/db/video-text.ts` | `listVideoTextCandidates`、`listCutsForAnalysis`、`listStoredFrames`、`beginVideoTextAttempt`、`writeOcrRequest`、`finishVideoTextAttempt`、`resegmentVideoText`、`monthlyOcrUsage` | 2 |
| `apps/worker/src/config.ts` | 3.2 節と 3.3 節の環境変数、`visionKey` | 1 |
| `apps/worker/src/jobs/groups.ts`、`index.ts` | hourly への登録（段階 2 の最後） | 2 |
| `apps/worker/src/jobs/alerts.ts`、`commands/check-alerts.ts`、`commands/check-env.ts` | `ocr_monthly_cap`、鍵の有無 | 2 |
| `apps/worker/test/fixtures/vision/` | 固定データ（8 章） | 2 |
| `.github/workflows/collect.yml` | Secret を hourly のステップの `env` に、`add-mask` のステップ | 4 |
| `supabase/migrations/20261012000000_r4_1_video_text.sql` | 5 章 | 1 |
| `supabase/seed/`（または手元用の SQL） | 段階 3 の画面用の種データ（9 章） | 1 |
| `apps/web/src/lib/queries/media-detail.ts`、`lib/video-timeline.ts`、`components/charts/CutTimeline.tsx`、`app/media/[id]/_detail/CutTimelineCard.tsx` | 6.1 節 | 3 |
| `apps/web/src/lib/reels.ts`、`lib/text-search.ts`、`lib/queries/reels.ts`、`app/reels/` | 6.2〜6.3 節 | 3 |
| `apps/web/src/lib/ocr-usage.ts`、`lib/queries/ocr-usage.ts`、`app/jobs/` | 6.4 節 | 3 |

---

## 4. 区間化と特徴量

すべて `lib/video-text.ts` の純粋関数で、保存したフレームの結果（4.1 節）だけから計算する。入力が同じなら出力が同じ（`segmenter_version` を上げたときに API を呼ばずに計算し直せる。3.1 節）。しきい値は `SEGMENTER_PARAMS` の定数にまとめ、変えたら `segmenter_version` を上げる。

**文字数の単位**: この章の「文字数」と「長さ」は、NFKC 正規化後の Unicode のコードポイント数（`Array.from(s).length`）。編集距離もコードポイントの列で計算する（JS の `length` は UTF-16 単位で、絵文字が 2 になる）。

### 4.1 フレームの結果の整え方

**保存する形**（`video_text_frames.words`。jsonb）。API の `fullTextAnnotation.pages[].blocks[].paragraphs[].words[]` を語ごとに次に切り詰める。

| 鍵 | 内容 |
|---|---|
| `b`、`p` | block と paragraph の番号（0 から。行の復元に使う） |
| `t` | 語の文字（`symbols[].text` を連結） |
| `c` | 語の `confidence`（0〜1。小数 3 桁に丸める。欠けていれば 0） |
| `l` | `property.detectedLanguages[0].languageCode`。なければ null |
| `x0`、`y0`、`x1`、`y1` | `boundingBox.vertices` の最小と最大（省略された座標は 0）。送った画像の画素 |
| `br` | 最後の symbol の `property.detectedBreak.type`（`SPACE`、`SURE_SPACE`、`EOL_SURE_SPACE`、`HYPHEN`、`LINE_BREAK`）。なければ null |

- `text` 列には `fullTextAnnotation.text`（全文）を入れる。**上限**: `words` は 1 枚 2,000 語、`text` は 20,000 文字（コードポイント）。超えた分は切り詰め、`word_count` には切り詰める前の数を入れる（外部由来の値を無制限に保存しない）
- 保存しないもの: symbol ごとの矩形と確信度（語より細かい単位は使わない）、page／block／paragraph の矩形（語の矩形の和で復元できる）、`textAnnotations`（同じ情報の別の形）。生の応答をそのまま保存する案は、symbol の分で 4〜5 倍の大きさになる（1 枚 60 KB、1 本 1.8 MB の見込み）ので採らない。切り詰めた形で 1 枚 10〜15 KB、1 本 300〜450 KB、18 本で 8 MB 以内（未確認。段階 0 で実測）。2 年で 70〜100 MB（TOAST の圧縮前）。`words` は SQL で引かず（GIN は作らない）、再計算の入力としてだけ使う
- 送った画像の大きさは解析の行の `image_width`、`image_height` に持つ（出所は 3.4 節。矩形を比率に直すため）

**行の復元**（`frameLines(frame, imageWidth, imageHeight)`）: 同じ `(b, p)` の語を順に連結して段落にし、`br` が `LINE_BREAK` か `EOL_SURE_SPACE` の語の後で行に分ける（2 行のテロップは 2 行になる）。`SPACE` と `SURE_SPACE` は空白 1 つで連結し、`HYPHEN` はハイフンを付けて連結し、それ以外は空白なしで連結する（日本語の語は空白なし）。行ごとに次を持つ。

- `text`: 連結した文字（表示用）
- `norm`: `normalizeText(text)` = NFKC 正規化 → 空白（`/\s/gu`。全角 U+3000 を含む）をすべて除く → ASCII を小文字にする。句読点や記号は残す
- `box`: 行の語の矩形の和（`x0`、`y0`、`x1`、`y1`）
- `confidence`: 語の確信度の平均
- `charHeight`: 語の高さ（`y1 − y0`）の中央値
- `lang`: 語の言語の最頻値（null を除く。全部 null なら null）

行の順は `(y0, x0, norm)` の昇順（決定性のため）。

**前処理**: `norm` が空の行と、`confidence < 0.5` の行（ちょうど 0.5 は残す）は区間化に使わない（Q3。動作確認ではテロップが 0.96〜1.00、背景の文字が多いフレームでも 0.67〜0.91 だったので、0.5 で落ちるのは読み損ないの断片）。

### 4.2 区間にまとめる規則

`segmentFrames(frames, { durationMs, imageWidth, imageHeight, params })`。`frames` は計画した全フレーム（文字のないフレームを含む）を時刻順に並べたもの。「開いている区間」の一覧を持つ。

1. フレーム `k`（添字）の各行（4.1 節の順）について、開いている区間のうち、**最後に見えたフレームの添字が `k − 2` 以上**（計画したフレームで 1 枚までの見落としを許す。ミリ秒でなく添字で定義し、間隔の設定やカット直後の挿入で意味が変わらないようにする）のものから、次の両方を満たす区間を探す
   - **文字が同じ**: `a`、`b` を `norm` として、(1) 一方が他方を含み、短い方の長さ ÷ 長い方の長さ ≥ 0.5（看板と重なって一部が欠けた例「から徒歩4分」⊂「溝口から徒歩4分」= 6/8 に対応）、または (2) `max(|a|, |b|) ≤ 4` なら編集距離 ≤ 1、それ以外は `1 − 編集距離 ÷ max(|a|, |b|) ≥ 0.7`（短い文字の濁点の落ちや 1 文字の読み違いに対応）
   - **位置が近い**: 行の矩形の中心 y と区間の中心 y（これまでの観測の平均）の差が画像の高さの 15% 以内。横の重なりは求めない（背景の看板はカメラの動きで横に動く）
2. 候補が複数なら、文字の一致（包含を優先、次に編集距離の比率の高い順）、同じなら中心 y が近いもの、それも同じなら先に開いた区間。1 つの行は 1 つの区間にだけ、1 つの区間は 1 フレームで 1 つの行にだけ結び付ける
3. 結び付いたら観測を足す。結び付かなければ新しい区間を開く
4. 最後に見えたフレームの添字が `k − 2` より前の区間は閉じる
5. 最後に次の雑音を捨てる
   - 観測が 1 フレームだけで、その行の矩形が「同じフレームで観測を足した区間の矩形（観測の平均）」と、自分の面積の 50% 以上重なるもの（看板と重なって割れた断片「MU溝」。本体の区間「溝口から徒歩4分」は前後のフレームで続いている）
   - 観測が 1 フレームだけで、`norm` が 2 文字以下のもの

**既知の挙動**（テストで固定し、段階 5 の目視で頻度を見て Q3 で扱う）:

- 同じ文字が同時に 2 か所（上と下）に出ると、位置が違うので 2 つの区間になる。`total_text_chars` では `text_norm` が同じなので 1 回だけ数える
- 2 段落に割れたテロップ（API が 1 行を 2 つの paragraph にした）が 2 フレーム以上続くと、2 つの区間として残る。1 フレームだけなら規則 5 で落ちる
- 見落としを許した間（1 枚見えないフレーム）も表示中として数える（`end_ms` は最後の観測から決まる）

区間の値:

| 値 | 定義 |
|---|---|
| `text` | 観測の `text` の最頻値。同数なら長いもの、それも同じなら先に観測したもの |
| `text_norm` | `text` の `normalizeText` |
| `start_ms` | 最初の観測のフレームの時刻 |
| `end_ms` | 最後の観測の次に計画したフレームの時刻（最初に見えなくなったフレーム）。次がなければ `duration_ms`。計画は `duration_ms` 未満なので常に `end_ms > start_ms` |
| `frame_count` | 観測の数 |
| `confidence` | 観測の確信度の平均 |
| `lang` | 観測の言語の最頻値 |

並びは `(start_ms, center_y_ratio, center_x_ratio, text_norm)` の昇順で、`seq` を 1 から付ける。開始と終了の精度は取り出した間隔（±1 秒。カット直後は 100 ms）で、要件 5.3 章の「表示開始ミリ秒」「表示終了ミリ秒」はこの精度の値（画面のヒントに書く）。

### 4.3 位置、大きさ、テロップらしさ

| 値 | 定義 |
|---|---|
| `center_x_ratio`、`center_y_ratio` | 観測の矩形の中心の平均 ÷ 画像の幅、高さ（小数 4 桁。0〜1 に収める） |
| `vertical_position` | `center_y_ratio < 1/3` なら `top`、`< 2/3` なら `middle`、それ以外は `bottom`（要件 F-VID-23 の「上・中・下」。列名は PG の keyword `position` を避ける） |
| `char_height_ratio` | 観測の `charHeight` の中央値 ÷ 画像の高さ（要件 F-VID-23 の「画面に占める文字の大きさ」） |
| `is_caption_like` | `char_height_ratio ≥ 0.025`（1920 px で 48 px 以上）かつ `|center_x_ratio − 0.5| ≤ 0.2`（横に中央寄り）かつ `frame_count ≥ 2` |

テロップらしさの基準は、動作確認の「白い文字に黒い縁取り、上から 1/3 あたり、1 行 4〜12 文字」から置いた仮の値。文字の高さの実測はしていない（未確認。段階 0 で `.local/ocr-check` の結果から測り、Q3 で決める）。縦書きのポスターの文字は行の高さが大きく出るので、`is_caption_like` が真になりうる（横幅 ÷ 高さが 1 未満の行を除く条件を段階 0 で検討する）。

### 4.4 特徴量の定義

`summarizeSegments(segments, frames, durationMs)`。要件 5.3 章の 4 つと、「背景を含めた文字の情報量」のための 3 つ、テロップだけの 4 つ。

| 列 | 定義 | 値がないとき |
|---|---|---|
| `first_text_ms` | 区間の `start_ms` の最小 | 区間がなければ null |
| `has_text_in_first_3s` | `start_ms < 3000` の区間があるか（`cuts_in_first_3s` と同じ境界。3000 ちょうどは含めない） | 区間がなければ false |
| `text_coverage_ratio` | 区間の `[start_ms, end_ms)` の和集合の長さ ÷ `duration_ms`（重なりは 1 回だけ数える）。小数 4 桁に丸める | 区間がなければ 0。`duration_ms` が 0 なら null |
| `total_text_chars` | `text_norm` が同じ区間を 1 つに数え（「重複を除く」の定義）、`text_norm` の文字数の合計 | 区間がなければ 0 |
| `segment_count` | 区間の数 | 0 |
| `max_chars_per_frame` | フレームごとの「前処理（4.1 節末尾。空と確信度 0.5 未満の除外）を通った行の `norm` の文字数の合計」の最大。**区間化の前の値で、規則 5 で落とす断片も含む**（一度に目に入る文字の量なので断片も含めてよい） | 0 |
| `avg_chars_per_frame` | 同じ値の全フレーム（文字のないフレームを 0 として）の平均。小数 2 桁 | 0 |
| `caption_first_text_ms`、`caption_has_text_in_first_3s`、`caption_coverage_ratio`、`caption_total_chars` | `is_caption_like` の区間だけで上の 4 つと同じ定義 | 同上 |

- 主にするのは全部の文字から計算する値（ユーザーの決定: 背景の文字も情報として扱う）。`caption_*` は保存し、投稿詳細に出す。リール分析の要因に入れるかは Q7
- `text_coverage_ratio` は 1 を超えない（和集合なので）。`success` 以外の行では全部 null

---

## 5. DB

### 5.1 マイグレーション（手書き。`supabase/migrations/20261012000000_r4_1_video_text.sql`）

先頭に `set lock_timeout = '5s';`（R5 の作法）。

1. 表 4 つ（5.2 節）と索引、RLS
2. 今の条件を返す関数 `current_video_text_condition()`（5.3 節）
3. ビュー: `media_video_features` に列を足す、`media_analysis_dataset` に列を足す、`ocr_monthly_usage` を作る（5.4 節）
4. 権限（5.5 節）
5. ロールバック（5.6 節。末尾のコメント）

R5 のマイグレーション（`20261009000000_r5_analysis.sql`）と R2 の修正（`20261011000000_…`）より後の版にする。既存の表は変えない（`video_analyses` に列を足さない。文字の解析は別の表にする。理由: 条件の組が違い、1 本に複数の行がありうる）。

### 5.2 表

```sql
create table public.video_text_analyses (
  id bigint generated always as identity primary key,
  media_id text not null references public.media (id) on delete cascade,
  ocr_method text not null,
  ocr_version text not null,
  frame_interval_ms integer not null check (frame_interval_ms > 0),
  analyzer_version text not null,
  segmenter_version text not null,
  video_analysis_id bigint references public.video_analyses (id) on delete set null,
  status text not null check (status in ('success', 'no_video_url', 'failed')),
  error text,
  analyzed_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count >= 1),
  duration_ms integer check (duration_ms > 0),
  image_width integer check (image_width > 0),
  image_height integer check (image_height > 0),
  planned_frame_count integer check (planned_frame_count >= 0),
  ocr_frame_count integer not null default 0 check (ocr_frame_count >= 0),
  units_used integer not null default 0 check (units_used >= 0),
  first_text_ms integer check (first_text_ms >= 0),
  has_text_in_first_3s boolean,
  text_coverage_ratio numeric(5, 4) check (text_coverage_ratio between 0 and 1),
  total_text_chars integer check (total_text_chars >= 0),
  segment_count integer check (segment_count >= 0),
  max_chars_per_frame integer check (max_chars_per_frame >= 0),
  avg_chars_per_frame numeric(8, 2) check (avg_chars_per_frame >= 0),
  caption_first_text_ms integer check (caption_first_text_ms >= 0),
  caption_has_text_in_first_3s boolean,
  caption_coverage_ratio numeric(5, 4) check (caption_coverage_ratio between 0 and 1),
  caption_total_chars integer check (caption_total_chars >= 0),
  unique (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version)
);

create table public.video_text_frames (
  analysis_id bigint not null references public.video_text_analyses (id) on delete cascade,
  at_ms integer not null check (at_ms >= 0),
  source text not null check (source in ('interval', 'cut')),
  text text,
  words jsonb,
  word_count integer check (word_count >= 0),
  error_code integer,
  fetched_at timestamptz not null,
  primary key (analysis_id, at_ms),
  check ((error_code is null and text is not null and words is not null)
      or (error_code is not null and words is null))
);

create table public.video_text_segments (
  analysis_id bigint not null references public.video_text_analyses (id) on delete cascade,
  seq integer not null check (seq >= 1),
  text text not null,
  text_norm text not null,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  vertical_position text not null check (vertical_position in ('top', 'middle', 'bottom')),
  center_x_ratio numeric(5, 4) check (center_x_ratio between 0 and 1),
  center_y_ratio numeric(5, 4) check (center_y_ratio between 0 and 1),
  char_height_ratio numeric(5, 4) check (char_height_ratio between 0 and 1),
  confidence numeric(5, 4) check (confidence between 0 and 1),
  frame_count integer not null check (frame_count >= 1),
  lang text,
  is_caption_like boolean not null,
  primary key (analysis_id, seq),
  check (end_ms > start_ms)
);

create table public.ocr_usage (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  media_id text references public.media (id) on delete set null,
  analysis_id bigint references public.video_text_analyses (id) on delete set null,
  job_run_id bigint references public.job_runs (id) on delete set null,
  ocr_method text not null,
  ocr_version text not null,
  requested_at timestamptz not null,
  elapsed_ms integer check (elapsed_ms >= 0),
  image_count integer not null check (image_count > 0),
  units integer not null check (units >= 0),
  request_bytes integer check (request_bytes >= 0),
  response_bytes integer check (response_bytes >= 0),
  word_count integer check (word_count >= 0),
  http_status integer,
  ok boolean not null,
  check (not ok or http_status is not null)
);
create index ocr_usage_account_requested_idx on public.ocr_usage (account_id, requested_at);
```

- `video_text_analyses`: 1 本 × OCR の条件で 1 行。`units_used` はこの行に使ったユニットの累計（再試行と再送の分を含む。要求ごとに足す。参考値。正はいつも `ocr_usage`）。`planned_frame_count` は計画した枚数、`ocr_frame_count` は `error_code` が null の結果のある枚数。`error` 列は固定文言か `mask` 済み（R1 と同じ）。画面のクエリは `error` を select しない。**書き込み**（3.6 節）: 取り掛かりは `insert … on conflict (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version) do update set status = 'failed', error = excluded.error, analyzed_at = excluded.analyzed_at, attempt_count = public.video_text_analyses.attempt_count + 1, planned_frame_count = excluded.planned_frame_count, video_analysis_id = excluded.video_analysis_id, duration_ms = excluded.duration_ms, segmenter_version = excluded.segmenter_version returning id, attempt_count`。要求ごとに `update … set units_used = units_used + $2 where id = $1`。結果と再区間化は `update … where id = $1`（列は 3.6 節の 7）
- `video_text_frames`: 1 フレーム 1 行。`error_code` が入っている行は読み取りに失敗したフレーム（次の回に送り直す）。check で「成功なら `text` と `words` がある、失敗なら `words` がない」を守る（文字なしの成功は `text = ''`、`words = '[]'`）。`words` は 4.1 節の形。comment: 「SQL では引かない。再計算の入力」
- `video_text_segments`: 1 区間 1 行。`text` は表示用、`text_norm` は検索と重複除去用。検索は `ilike`（数十〜数百行。索引は要らない）
- `ocr_usage`: 1 要求 1 行（要件 5.1 章）。投稿や解析の行を消しても残す（`on delete set null`。費用の記録は消さない。`analysis_id` は取り掛かりの記録があるので初回から埋まる）。`account_id` は `media` を経由せずに持つ（投稿が消えても月の合計を出せる）。`job_runs` を消す仕組みはないので `job_run_id` の `set null` は形だけ。`elapsed_ms` は要求の往復時間（動画の `duration_ms` と区別する）。月の集計はこの表の `requested_at` から（3.3 節）。comment に `units` の規則（3.3 節）と `videos` の数え方を書く
- 既存の `video_analyses` と `video_cuts` は変えない
- 4 つの表すべてで `enable row level security`

### 5.3 今の条件を返す関数

```sql
create or replace function public.current_video_text_condition(
  out ocr_method text, out ocr_version text, out frame_interval_ms integer,
  out analyzer_version text, out segmenter_version text)
language sql immutable parallel safe
set search_path = ''
as $$ select 'google_vision'::text, 'v1/DOCUMENT_TEXT_DETECTION'::text, 1000, '1'::text, '1'::text $$;
comment on function public.current_video_text_condition() is
  '今の画面の文字の解析条件。ワーカーの OCR_METHOD、OCR_VERSION、FRAME_INTERVAL_MS、TEXT_ANALYZER_VERSION、SEGMENTER_VERSION と同じ値。画面のビューは前の 4 つで結合し、segmenter_version が違う行は特徴量を null にする';
revoke execute on function public.current_video_text_condition() from public;
grant execute on function public.current_video_text_condition() to web_app;
```

ワーカーの定数と一致することを結合テストで突き合わせる。どれかを変えるたびに、この関数を新しいマイグレーションで作り直す（決めた記録にもなる。R4 5.1 節と同じ）。

### 5.4 ビュー

`create or replace view` の注意（2 つのビューに共通）: マイグレーションには断片でなく R4 の定義（`20261007000000_r4_video.sql` の 69〜101 行と 117〜264 行）を丸ごと写し、`with (security_invoker = true)` を必ず書く（`with` を省くと reloptions が置き換わり `security_invoker` が外れる）。既存の列の名前・型・順は変えず、末尾に足すだけ。R4 と同じく「定義は … 行と同じで末尾に n 列を足しただけ」のコメントを添える。`comment on view`／`comment on column` と grant は `create or replace` で残る。

1. **`media_video_features` に列を足す**。結合は**一意キーの 4 列**（`segmenter_version` を含めない）。`text_status` は常に行の値で、特徴量だけ `segmenter_version` が今の版と違えば null（打ち切り済みの `failed`／`no_video_url` が版を上げた後も失敗のまま見え、`success` で古い版は「まだ」として扱える）

   ```sql
   -- from 句に足す
   cross join public.current_video_text_condition() t
   left join public.video_text_analyses vt
     on vt.media_id = m.id
    and vt.ocr_method = t.ocr_method and vt.ocr_version = t.ocr_version
    and vt.frame_interval_ms = t.frame_interval_ms and vt.analyzer_version = t.analyzer_version
   -- select の末尾に足す
   vt.id as text_analysis_id,
   vt.status as text_status,
   vt.attempt_count as text_attempt_count,
   vt.analyzed_at as text_analyzed_at,
   (vt.segmenter_version = t.segmenter_version) as text_segmenter_current,
   case when vt.segmenter_version = t.segmenter_version then vt.first_text_ms end as first_text_ms,
   case when vt.segmenter_version = t.segmenter_version then vt.has_text_in_first_3s end as has_text_in_first_3s,
   case when vt.segmenter_version = t.segmenter_version then vt.text_coverage_ratio end as text_coverage_ratio,
   case when vt.segmenter_version = t.segmenter_version then vt.total_text_chars end as total_text_chars,
   case when vt.segmenter_version = t.segmenter_version then vt.segment_count end as segment_count,
   case when vt.segmenter_version = t.segmenter_version then vt.max_chars_per_frame end as max_chars_per_frame,
   case when vt.segmenter_version = t.segmenter_version then vt.avg_chars_per_frame end as avg_chars_per_frame,
   case when vt.segmenter_version = t.segmenter_version then vt.caption_first_text_ms end as caption_first_text_ms,
   case when vt.segmenter_version = t.segmenter_version then vt.caption_has_text_in_first_3s end as caption_has_text_in_first_3s,
   case when vt.segmenter_version = t.segmenter_version then vt.caption_coverage_ratio end as caption_coverage_ratio,
   case when vt.segmenter_version = t.segmenter_version then vt.caption_total_chars end as caption_total_chars
   ```

   `text_status` が null は「まだ読んでいない」。`success` 以外の行と、`success` でも `text_segmenter_current` が偽の行では特徴量は null。文字の解析はカットの条件と独立で、カットの条件を変えた直後は `analysis_status` が null でも `text_status` が残る（文字の列は OCR の条件だけで結合する）

2. **`media_analysis_dataset` に列を足す**（末尾。R4 と同じ制約）: `ocr_method`、`ocr_version`、`frame_interval_ms`、`text_analyzer_version`、`segmenter_version`、`first_text_ms`、`has_text_in_first_3s`、`text_coverage_ratio`、`total_text_chars`、`segment_count`。動画の特徴量と同じく「最新の `success`（条件をまたぐ）」を `left join lateral … where status = 'success' order by analyzed_at desc limit 1` で取る（分析用。条件の列があるので分けられる）

3. **`ocr_monthly_usage`**（画面用。6.4 節）

   ```sql
   create view public.ocr_monthly_usage with (security_invoker = true) as
   select
     account_id,
     (date_trunc('month', requested_at at time zone 'UTC'))::date as month_utc,
     count(*)::integer as requests,
     count(*) filter (where not ok)::integer as failed_requests,
     sum(image_count)::integer as images,
     sum(units)::integer as units,
     count(distinct media_id)::integer as videos
   from public.ocr_usage
   group by 1, 2;
   comment on view public.ocr_monthly_usage is 'Vision API の月ごとの利用（ocr_usage の集計）。利用が 0 の月は行が出ない（画面で補う）';
   comment on column public.ocr_monthly_usage.month_utc is 'UTC の月の初日（ワーカーの月の上限と同じ境目）';
   comment on column public.ocr_monthly_usage.videos is 'その月に要求を送った本（消えた投稿、区間化だけの本、0 枚の本は数えない）';
   ```

   単価は持たない（画面の定数で掛ける）

### 5.5 権限

R2 の決まりどおり。`video_text_frames` は画面で使わないので `web_app` の権限を作らない（最小権限。必要になったときに足す）。

```sql
revoke all on table public.video_text_analyses, public.video_text_frames, public.video_text_segments, public.ocr_usage
  from public, anon, authenticated;
grant select on table public.video_text_analyses, public.video_text_segments, public.ocr_usage to web_app;
create policy web_app_select on public.video_text_analyses for select to web_app using (true);
create policy web_app_select on public.video_text_segments for select to web_app using (true);
create policy web_app_select on public.ocr_usage for select to web_app using (true);
revoke all on table public.ocr_monthly_usage from public, anon, authenticated;
grant select on table public.ocr_monthly_usage to web_app;
```

- `media_video_features` と `media_analysis_dataset` の grant は `create or replace` で残る
- `web-role.test.ts` の関数とビューの棚卸しに `current_video_text_condition()` と `ocr_monthly_usage` を足す

### 5.6 ロールバック（末尾のコメントに書く。順番が大事）

```sql
-- 1. 先にワーカーを R4.1 より前の版に戻し、hourly から video_text を外す
-- 2. ビューの作り直しは drop function と drop table より前（ビューが関数と表に依存する）
-- drop view if exists public.ocr_monthly_usage;
-- -- media_video_features と media_analysis_dataset は足した列を create or replace で消せないので、
-- -- drop して 20261007000000_r4_video.sql の定義で作り直し、comment on view media_video_features、
-- -- comment on column media_video_features.retention_rate、comment on column media_analysis_dataset.retention_rate、
-- -- grant select … to web_app をやり直す
-- drop function if exists public.current_video_text_condition();
-- -- 3. ocr_usage は利用記録（費用の根拠）なので、消す前に copy で .local/ に退避する
-- drop table if exists public.ocr_usage;
-- drop table if exists public.video_text_segments;
-- drop table if exists public.video_text_frames;
-- drop table if exists public.video_text_analyses;
-- delete from supabase_migrations.schema_migrations where version = '20261012000000';
```

---

## 6. 画面

デザインは `doc/design-system.md` に従い、既存の部品を使う。グラフは R3、R4 と同じく自作の SVG（Server Component。値は `<title>` と `aria-label`。吹き出しは作らない）。読み取った文字は自分の投稿の内容なので画面に出してよいが、ログには出さない。外部由来の値なので JSX の自動エスケープに任せ、`dangerouslySetInnerHTML` を使わない（SVG の `<title>` と `aria-label` も JSX で渡す）。新しい UI 文言は「画面変化」を使い「カット」を使わない（既存の `aria-label`「カットのタイムライン: …」は画面名なので据え置き）。Server Action は使わない（検索も GET）。

### 6.1 投稿詳細（`/media/[id]`）

「カットのタイムライン」のカード（`CutTimelineCard`）に足す。カードの題名は変えない（要件の画面名「タイムライン」）。

- **上段の数字**: 既存の 6 つの下に 2 段目として「最初の文字まで」「冒頭 3 秒の文字」「文字の表示割合」「総文字数」を置く（見出しに値の形を入れず、値を「12.3 秒」「あり」「12%」「240 文字」にする）。`FACTORS` には `first_text`、`text_coverage`、`total_text_chars` の 3 つを足し（`FactorDef.unit` に `percent` を足して `formatFactor` に書式を追加）、`TOP_FACTORS` に並べる。「冒頭 3 秒の文字」は 2 値なので `FACTORS` に入れず、`TOP_FACTORS` と別に 1 枚（`has_text_in_first_3s` を「あり／なし」で）出す。値はビューの列をそのまま使い、画面で計算し直さない。ヒントは `first_cut` と同じ形: 「最初の文字まで = 動画の開始から最初に文字が出るまでの秒数。文字がなければ値なし」「冒頭 3 秒の文字 = 開始から 3 秒未満に文字が出たか」「文字の表示割合 = 文字が画面に出ている時間 ÷ 動画の長さ」「総文字数 = 表示された文字の数（同じ文字は 1 回）」。共通の注記として「文字 = 画面に表示された文字（テロップと背景の看板などを含む）。開始と終了の精度は約 1 秒」を「総文字数」のヒントの末尾に 1 回だけ書く
- **テロップらしい文字の数字**: 「テロップらしい文字」の 4 つ（`caption_*`）は、上段には出さず、区間の表の `sub` の末尾に「うちテロップらしい区間: n（総文字数 m）」と出す（Q7。見た目を増やさない）
- **タイムライン**（`CutTimeline`）: `timelineModel(cutTimes, durationMs, segments)` に `texts: TextSpan[]`（`start`、`end`、`text`、`position`、`captionLike`。タイムライン用で確信度は持たない）を足す。クリップの規則: `start >= duration` と `start >= end` の区間は捨て、`end > duration` は `duration` に丸める（タイムラインだけの規則。表の行はそのまま出す）。シーンの帯の下に `top`／`middle`／`bottom` の 3 本の段（各 14 px）を置き、区間を `rect` で描く。帯は `kindColor` の薄い塗り（`.25`〜`.45`。帯の中に文字を出すため）、文字は `var(--color-text)`。テロップらしい区間は塗りを濃くし、加えて `stroke` で縁を描く（色だけに頼らない）。同じ段で `[start, end)` が重なる区間は `seq` 順に `rect` を描き、先の区間と重なるものは帯の文字を出さない（全文は `<title>` と `aria-label` に残る。この判定は `lib/video-timeline.ts` の純粋関数 `textLabelsFit` にしてテストする）。帯の文字は幅に入らない分をコードポイント（`Array.from(text)`）で数えて切り「…」を付ける（幅は全角換算 11 px で保守的に。半角が多いと余白が出るが許容）。`aria-label` に「文字の区間 n 本」を足す。高さは 52 から約 100 になる。`CutTimeline` に `labels?: boolean` の prop を足し、`CutTimelineCard` の `only-m`（幅 340）側で false にして帯の文字を出さない（表で読む）
- **区間の表**: SVG の下に表「文字の区間」（`sub` に「n 本」。列は開始〜終了（秒、小数 1 桁）、文字、位置（上・中・下）、確信度（%）、テロップらしさ（印））。並びは `seq`。ビューの `text_segments`（JSON）を直接読む。「文字」の `td` は `overflow-wrap: anywhere` と `max-width: 28em`（看板の長い文字は空白なしになりうる）。行数の上限は設けない（1 本の値なので数十行まで許容）。**区間が 0 本のときは新しい文言を足さない**: `sub` の「0 本」、上段の数字（総文字数 0、表示割合 0%、冒頭 3 秒「なし」）、`aria-label`「文字の区間 0 本」で読める。表の本体は出さず、3 段の帯は空で描く
- **状態**: カットの解析がない・失敗のときは R4 6.1 節のまま（文字の部分も出さない）。カットが `success` で文字の状態が次のとき

| `text_status`、`text_segmenter_current` | `MissingReason` | 表示 |
|---|---|---|
| null（まだ読んでいない） | `not_yet` | 数字は「—」、段と表は出さない |
| `success` で `text_segmenter_current` が偽（計算し直し待ち） | `not_yet` | 同上 |
| `no_video_url`、`failed`（打ち切りを含む） | `missing` | 「取得できなかった」 |
| `success` で `text_segmenter_current` が真 | — | 数字、段、表 |

- **クエリ**（`getVideoFeatures`）: `media_video_features` の `text_status`、`text_segmenter_current`、`first_text_ms`、`has_text_in_first_3s`、`text_coverage_ratio`、`total_text_chars`、`segment_count`、`caption_segment_count`（`is_caption_like` の数。`text_segments` から数える）、`caption_total_chars` を足し、`text_segments` を `coalesce((select json_agg(json_build_object('seq', s.seq, 'start_ms', s.start_ms, 'end_ms', s.end_ms, 'text', s.text, 'position', s.vertical_position, 'is_caption_like', s.is_caption_like, 'confidence', s.confidence::float8) order by s.seq) from public.video_text_segments s where s.analysis_id = f.text_analysis_id and f.text_status = 'success' and f.text_segmenter_current), '[]')` で同じ 1 行に載せる（カットの `cut_times_ms` と同じ形）。`error` 列は読まない。`words` は読まない

### 6.2 リール分析（`/reels`）

R4 設計 6.2 節の形に、文字の要因を足す（見本 design-lab v3 の `S.reels` にあった文字の要因を戻す）。

| カード | 足すもの |
|---|---|
| 要因との関係 | 要因に「最初の文字まで（秒）」「文字の表示割合」「総文字数」の 3 つ（`FACTORS` は 8 → 11）。`first_text` は文字のない動画で null（`first_cut` と同じ扱い。その要因の n から除く）。「冒頭 3 秒の文字」は 2 値なので要因に入れない |
| 上位と下位 | 要因の中央値の表に 3 つと、「冒頭 3 秒の文字がある割合」を `isEdgeCutFactor` と同じ特別扱いで 1 行足す |
| 散布図 | 3 枚を足す（`scatter: true` の 7 → 10 枚。PC の 3 列で最後の行が 1 枚になるのは許容。スマートフォンは 2 列で 5 行） |
| 区分 | 「冒頭 3 秒の文字（なし／あり）」の区分を足す（2 区分の棒。3 件未満は薄く）。配置: 1 行目は今のまま `動画の長さ col-6 / 冒頭 3 秒の画面変化 col-3 / 最後 3 秒の画面変化 col-3`、2 行目を `冒頭 3 秒の文字 col-3 / 平日と土日 col-3 / 時間帯 col-6`、3 行目を `曜日 col-12`（棒 7 本。幅に余裕が出るが許容）。解析済みが 0 件のときは「冒頭 3 秒の文字」も長さ・冒頭・最後と同じく「—」にし、配置は変えない。F-VID-31 の例「冒頭 3 秒に文字があるリールはスキップ率が低いか」に答える形 |
| 一覧 | 列に「冒頭 3 秒の文字」「文字の表示割合」「総文字数」を足す（17 → 20 列。PC では 3 列とも出す。一覧は横スクロールの枠に入っている）。スマートフォンは「文字の表示割合」「総文字数」を `hide-m` |

- **列名と判定**: `ReelRow`、`getReels` の SQL、`FactorSource` の Pick に `text_status`、`text_segmenter_current`、`first_text_ms`、`has_text_in_first_3s`、`text_coverage_ratio`、`total_text_chars` を足す。「文字の解析が済んでいる」は `text_status === 'success' && text_segmenter_current`（ビューが特徴量を null にするので、値の有無で判定しても同じ）。`REEL_SORT_KEYS` に `has_text_in_first_3s`（0／1）、`text_coverage`、`total_text_chars` を足し、`sortValue` に case を書く（`text_coverage` は列名 `text_coverage_ratio` と違う）
- **目的変数 `y`**: 「スキップ率」を選択肢に足す（Q8）。R4 6.2 節が視聴維持率を除いた理由は 2 つで、「分母が動画の長さ」はスキップ率に当たらないが、「視聴と反応で同じ値どうしの図になる」は当たる。そこで規則: **「視聴と反応」は `y` と同じ指標の 1 枚を出さない**（スキップ率を選ぶと 3 枚）。これは選択に応じた固定の規則で、データの状況による切り替えではない。`OBJECTIVE_LABEL` の文言は `METRIC_DEFINITIONS.skip_rate.label` と同じにし、`objectiveHint`（`cards.tsx`）に「スキップ率は低いほどよい（上位と下位は値の大小のまま）」を足す。選択肢の文言は「スキップ率（n 件）」。既定はリーチ率のまま
- **母集団**: 文字の要因は「今の条件で文字の解析が済んでいるリール」。カットは `success` だが文字がまだのリールは、文字の要因の n から除く（R4 の「要因ごとに null を除く」と同じ規則。新しい文言は足さない）
- データの状況で比べ方を変えない（指標と比較対象は固定。経過日数などの前提は表示して委ねる）

### 6.3 文字で探す

F-VID-32。`/reels` の一覧のカードの上（一覧の `sub` の横）にカード「文字で探す」を置く（Q9。文字があるのは動画だけで、投稿一覧 `/media` は変えない。R4 6.3 節と同じ。位置は `q` の有無で動かさない）。

- 入力は `<form method="get">` の 1 欄（検索パラメータ `q`）。`y`、`sort`、`dir` は hidden で保つ。`page` は持たない（1 ページ目に戻る。並べ替えと同じ）。逆方向も保つ: `ReelsParams` に `q: string | null` を足し、`reelsQuery` の戻りに `q` を入れる（既定 null は出さない）ので、`SortHeader`、`Pager`、`ObjectiveChips` のリンクが `q` を保つ
- **正規化は TS で行う**（`lib/text-search.ts`。ワーカーの `normalizeText` と同じ処理 `normalize("NFKC")` → `/\s/gu` を除く → ASCII を小文字。別パッケージなので複製し、同じ入出力のテストを両方に置く）。順は**正規化 → 空白除去 → 長さの検査 → エスケープ**（NFKC は `％`→`%`、`＿`→`_`、`＼`→`\` に変換するので、エスケープは正規化の後）。正規化後に 1〜100 コードポイントでなければ既定の画面（空白だけの `q` もここで空になる）。`\`、`%`、`_` を `\` でエスケープし、`'%' + escaped + '%'` を SQL に渡して `s.text_norm ilike $1 escape '\'`。SQL では正規化しない（`normalize()` は `text_norm` を作るワーカー側の定義に対応する TS 関数で済む）
- 対象は自分のアカウントのリールとフィード動画の、今の条件で文字の解析が済んでいる区間（`media_video_features` の `text_analysis_id`、`text_status = 'success'`、`text_segmenter_current` 経由で `video_text_segments` を結合し、投稿ごとに `json_agg` と `count`）。期間は限らない
- 結果: 一致した投稿の一覧（サムネイル、題名、投稿日、一致した区間の `text` と開始秒を `start_ms` の昇順で 3 つまで。強調（`<mark>`）はしない。`text` と `text_norm` がずれるため）。並びは `posted_at desc, media_id desc`、上限 50 件（超えたら `sub` に「n 件中 50 件」。新しい文言は件数だけ）。投稿詳細へのリンク。0 件は「—」（R3 の空の状態の決まり）。入力が空ならカードは入力欄だけ
- 一覧のほかのカード（要因、散布図、区分、一覧）は `q` で絞らない（比べ方を検索で変えない）
- クエリは `lib/queries/reels.ts` に `searchTextSegments(accountId, pattern)` を足す。`page` の中では `getReels` と `Promise.all` で並べる（直列に待たない）
- `/reels` は `NO_STORE_PAGES` に入っているので追加の設定は要らない。検索語は URL に入り、ホスティングのアクセスログに残る（OCR の結果ではない。許容。7 章）

### 6.4 収集ログ（`/jobs`）の「AI・OCR の利用状況」

要件 9 章。`/jobs` の `RunsCard` の下に `col-12` のカード「AI・OCR の利用状況」を `<Suspense fallback={<Loading className="col-12" />}>` で足す（R3 4.5 節の形。`QueryResult` の失敗はカードの中の `Callout bad`）。クエリは `lib/queries/ocr-usage.ts`（`ocr_monthly_usage` を `account_id` で必ず絞る）。

- **定数と計算**は `lib/ocr-usage.ts`（純粋関数。`remainingFreeUnits(units)`、`estimatedCostUsd(units)`、`fillMonths(rows, now, 12)`。テスト付き）。`VISION_FREE_UNITS_PER_MONTH = 1000`、`VISION_USD_PER_1000_UNITS = 1.5` のコメントに 11 章の事実票の確認日（2026-10-11）と出典（cloud.google.com/vision/pricing）を書く。画面の 1,000 はワーカーの上限（`WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT`）とは別の値で、片方を変えても同期しない（ワーカーの上限は画面に出さない）
- **今月（UTC）**: ユニット／無料枠 1,000、残り、処理した本数、要求数、失敗した要求数。今月の行がなければ 0 として出す。残りが 100 未満なら `Callout`（`warn`）
- **月ごとの表**: 直近 12 か月（利用が 0 の月は画面で補って 0 の行にする）。見出し「月（UTC）」、各行は `2026-10`。列は要求、画像、ユニット、本数、失敗、推定費用（`$0.00` の形。USD）。「ユニット」に `MetricHint`（「ユニット = Vision API の課金の単位。画像 1 枚 = 1 ユニット」）。推定費用 = `max(units − 1,000, 0) ÷ 1,000 × $1.50`。表の下に「推定。請求は Google Cloud の明細で確かめる。手動の確認（`scripts/ocr-check.mjs`）の分は含まない」。スマートフォンは「要求」「画像」を `hide-m`
- 全期間で利用が 0 件なら「まだ利用がありません」（R3 の空の状態の決まり）
- `/jobs` は `NO_STORE_PAGES` に足さない（個人の指標も署名付き URL も含まない）
- `video_text` の行はジョブの表にほかのジョブと同じ形で出る（`items_fetched` は成功した本数）

---

## 7. セキュリティと公開ログ

| 項目 | 決まり |
|---|---|
| 鍵 | 3.8 節。Secret は hourly のステップの `env` にだけ渡す。ワーカーは `config.ts` でだけ読む。値、`private_key`、アクセストークンをログ、例外、`recordFailure`、DB、生の応答に入れない。`check-env` は有無だけ。マスクは `add-mask` のステップと `ctx.mask` の二重化。鍵の形が不正でも起動は失敗させず、`video_text` だけが固定文言で失敗する |
| 宛先 | `images:annotate` とトークンの URL はコードの定数。鍵の `token_uri` が定数と違えば使わない。`fetch` の宛先を環境変数や DB の値から作らない。`redirect: "error"` |
| 送るデータ | 自分の投稿のフレームだけ（`media_url` は Graph API から取り直し、`downloadToFile` のホストの許可一覧を通る）。送るのは JPEG の内容だけで、`media_id`、キャプション、ファイル名を要求に入れない。フレームには人の顔が写りうる。Google は送った画像を学習に使わず、数時間以内に消す（AI-07。記録は検討メモ 4 章と 7 章） |
| 残さないもの | 動画とフレームは `mkdtemp` の一時ディレクトリに置き、`finally` で消す（NF-CAP-03）。DB に画像は入れない |
| 子プロセス | `spawn` に `env: { PATH }` だけを渡す（`process.env` の秘密を ffmpeg に渡さない） |
| ログ | `media_id`、URL、鍵、トークン、読み取った文字、Vision の `error.message` を出さない。件数、固定文言、HTTP の status だけ（3.7 節）。GitHub Actions の公開ログに出る前提で書く |
| 生の応答 | Vision の応答は `raw` の表に入れない（`graph-client.ts` の保存は Graph API だけ）。保存先は `video_text_frames`（4.1 節の切り詰めた形。語数と文字数に上限） |
| 例外 | R1 10.5 章の規約（`console.error(error)` と `String(error)` の禁止、`sanitizeForLog(error.message)` だけ、`error.cause` などを参照しない）。`fetch` の失敗の `cause` には URL が入りうるので見ない。`JSON.parse`、ファイルの読み込み、署名の例外は文面を捨てて固定文言にする |
| 入力の検査 | 候補の `media_id` は `isMediaId`。`at_ms` は整数で 0 以上 `duration_ms` 未満。ffmpeg の引数に動画の中身の値を入れない（時刻は数値から作る）。Vision の応答は JSON として形を確かめてから使う（`words` の各値の型、`responses` の長さ） |
| 画面 | 読み取った文字は本人のデータとして表示するが、外部由来の値として JSX の自動エスケープに任せ `dangerouslySetInnerHTML` を使わない。SVG の `<title>`／`aria-label` も JSX で渡す。1 区間の帯の表示文字数と `q` の表示（正規化後 100 コードポイント）に上限。双方向制御文字（U+202E など）の見え方は段階 5 で確かめる。`q` は正規化 → 長さ → エスケープの順で、パラメータとして渡す。検索語は URL に入りホスティングのアクセスログに残る（OCR の結果ではない。許容）。`/reels` は `private, no-store` のまま |
| 費用の歯止め | 3.2 節（1 回のユニット、1 本で超える本は飛ばす）、3.3 節（月のユニットと本数。範囲の上限は無料枠と同じ）、長さの上限、失敗した要求のユニットの規則、再送は 2 回まで、`ocr_usage` が書けなければ送らない、`check-alerts` の通知。コードの外では Google Cloud の予算アラートとクォータ（3.8 節） |
| 原子性の前提 | 月の上限の判定は「読んでから書く」で、応答と `ocr_usage` の書き込みの間に落ちるとユニットが数えられない。実行元が 1 つ（`collect.yml` の `concurrency` で CI は常に 1 本、手元の常駐ワーカーは停止）なので許容する。手元で動かすときは `COLLECT_ENABLED=false` を確かめる（R4 3.6 節と同じ） |

---

## 8. テスト

R4 設計 7 章にならう。Vision は偽の `fetch` で差し替え、本物の API はテストで呼ばない（ユニットを使わない）。

**固定データ**（`apps/worker/test/fixtures/vision/`。段階 2 で 1 回作る）: (1) 4.1 節の切り詰めた形のフレームの列（動作確認の 3 本から。テロップの行は残し、背景の語は合成した文字（店名、電話番号を含まない）に置き換える。ファイル名に投稿の ID を入れない）、(2) `parseAnnotateResponse` 用の生の応答を 3 つ手で作る（文字あり、文字なし、`responses[].error`）。`segmentFrames` と `summarizeSegments` は (1) に対するゴールデン テストにし、`segmenter_version` を上げるときは差分を検討メモに記録する。`.local/ocr-check/` の応答をそのまま置かない（git 管理外で、背景の文字と投稿の ID を含む）。

**テストの鍵**: JWT のテストは `generateKeyPairSync("rsa", { modulusLength: 2048 })` でテストの中に作り、`createVerify` で検証する（PEM をコミットしない）。

| 区分 | 内容 |
|---|---|
| 単体（worker、純粋関数） | `frameTimes`（0 を含む、`duration_ms` ちょうどは含めない、カット直後の優先、300 ms の重ね方、300 ms 未満のカットが 3 連続、カットが 0 ms、カットが `duration_ms` の直前、カット 0 回、`duration_ms` 0 で空）。`normalizeText`（NFKC の全角英数、全角空白 U+3000、大文字、結合濁点 U+3099 が合成される、半角カナ、絵文字、記号だけ）。`codePoints`／`editDistance`（絵文字 1 文字、結合文字）。`frameLines`（段落と行の分け方、`SPACE`／`SURE_SPACE`／`EOL_SURE_SPACE`／`HYPHEN`／`LINE_BREAK`、座標の省略、`confidence` 欠落、`detectedLanguages` 空、縦書き、`fullTextAnnotation` なし、行の順 `(y0, x0, norm)`）。`segmentFrames`（同じ文字が続く、1 枚の見落とし（カット直後のフレームを含む計画で添字の差 2）、包含の例「から徒歩4分」、編集距離の例、2〜5 文字の 1 文字違い、位置が違えば別の区間、同じ文字が上下 2 か所、断片「MU溝」の除去、割れた断片が 2 フレーム続くと残る、1 フレーム 2 文字以下の除去、2 文字が 2 フレーム続く、縦にずれていくテロップ、空白を含む英文、確信度ちょうど 0.5、全フレーム文字なし、最後の計画フレームでだけ観測した `end_ms = duration_ms`、見落としを含む区間の `end_ms`、入力の行の順を変えても同じ結果、空の入力）。`summarizeSegments`（和集合の表示割合（上下 2 か所の区間）、重複除去の総文字数、`start_ms = 2999` と 3000、区間なし、`duration_ms` 0、`caption_*`、`max_chars_per_frame` に断片を含む、小数 4 桁の丸め）。`createServiceAccountJwt`（生成した鍵で署名が検証できる、`exp`、`scope`、`private_key` の `\n` がエスケープされた JSON）。`splitRequests`（8 枚、6 MB の手前で切る、1 枚で超える）。`parseAnnotateResponse`（枚数の不一致、`responses` がない、JSON でない本文、1 枚ごとの `error`、文字なし、型の不正、語数と文字数の上限、`pages[0].width`／`height`） |
| 単体（worker、`vision-client`） | `token_uri` 不一致で通信しない。`expires_in − 300` の使い回しと再取得。待ちは `deps.sleep` で差し替え。`redirect: "error"`。429 と 5xx だけ再送（2 回で止まる）、制限時間切れは再送しない。トークンがどの戻り値・例外の文面にも出ない |
| 単体（worker、ジョブ） | `createVideoTextJob` に偽の `fetch`、ffmpeg、DB を渡す。`MAX_PER_RUN = 0` のとき `fetch` も ffmpeg も呼ばず候補を数えるだけ。鍵がない・形が不正・ffmpeg がない回は行を書かず `attempt_count` が増えない。トークンの失敗でダウンロードしない。本数（(b) は数えない）、時間、1 回のユニット（上限 100 で計画 185 の本が先頭にあると飛ばして次へ、累計で超えたら残りを始めない）、月のユニットと月の本数の各上限で次の回に回す（境界の値、`warn` が 1 回だけ、`recordFailure` なし）。予算を超えた後は再送しない。(b) の本はユニット 0 で上限の判定をせず、偽の `fetch` の呼び出しが 0 回、`ocr_usage` に行が増えず、`units_used` と `attempt_count` が変わらない（カットの条件を変えた後も同じ）。(a) の再試行の計画が `vt.video_analysis_id` のカットから作られ、`set null` なら今の条件で作り直して `warn`。足りないフレームだけ送る（保存済み、`error_code` の行、0 枚なら送らない）。取り掛かりの記録で `failed` と `attempt_count + 1` が先に書かれ、途中で例外が起きてもその行と送った分のフレームと `ocr_usage` が残る。要求ごとの書き込みが失敗したら以後送らない。401／403 で行を取り掛かりのまま終わる、429 → 429 → 成功で `ocr_usage` が 3 行で `units` の合計が 8、5xx で `failed` と 2 本続けて止まる、制限時間切れで `failed`、400 で `failed`、1 枚ごとの `error` で `failed` とフレームの保存。再試行後の `units_used`／`planned_frame_count`／`ocr_frame_count`。取り出しの制限時間（1 枚、全体）、出力ファイルなし。打ち切りの `warn` が 1 回だけ。ログに `media_id`、URL、鍵、トークン、文字がない。`media_url` の取り直しの各場合（R4 と同じ） |
| 結合（worker と DB） | `listVideoTextCandidates`（カットの条件、`success` のみ、古いカットの条件の `success` は選ばない、`media_product_type`、長さ null と 0 と上限超えは選ばない、`gone_at`、3 時間、打ち切り、`segmenter_version` の違い、新しい順）。`beginVideoTextAttempt`（挿入と衝突時の `attempt_count + 1`）、`writeOcrRequest`（`ocr_usage` とフレームと `units_used` が 1 トランザクション）、`finishVideoTextAttempt`（`attempt_count` と `units_used` を触らない、区間の入れ直し）、`resegmentVideoText`（`attempt_count`、`units_used`、`status` を触らない）。`monthlyOcrUsage`（UTC 月初 00:00 ちょうどの行は当月、`media_id` が null の行は本数に入らない、`count(distinct)`、範囲の索引）。ワーカーの定数と `current_video_text_condition()` の一致。`extractFrameArgs` で実際の ffmpeg が色の切り替え動画（`generateColorTestVideo`）から指定の時刻の色のフレームを出し、最後の時刻の直前の 1 枚が出る（`test/ffmpeg-real.test.ts`）。`runOrThrow` の最小の `env` で ffmpeg が動く |
| DB | `media_video_features` の文字の列が一意キーの 4 列で結合される（`success` で `segmenter_version` が古い行は `text_status = 'success'`、`text_segmenter_current` 偽、特徴量 null。古い版の `failed` は `text_status = 'failed'`、特徴量 null。カットの条件を変えた後も `text_status` が残る）。`media_analysis_dataset` の最新 `success`。`ocr_monthly_usage` の月の境目と失敗の数。`video_text_frames` の check（成功と失敗の形）。`web_app` で 3 表と 2 ビューを読め、`video_text_frames` は読めず、anon と authenticated では 4 表とも読めない。関数とビューの棚卸し（`web-role.test.ts`）。ロールバックの順。種データ（9 章）が入る |
| `check-alerts` | `evaluateAlerts` の `ocr_monthly_cap`（ユニットと本数の境界 `>=`、ちょうど上限、上限 0、`daily` だけ） |
| 画面 | `FACTORS` の 3 つ（null の除き方、単位 `percent` の書式）。「冒頭 3 秒の文字」が要因に入らず上位と下位に割合で入る。区分「冒頭 3 秒の文字」と配置。`y` にスキップ率（不正値で既定、件数の文言、「視聴と反応」が 3 枚になる）。並べ替えのキー 3 つ。タイムライン（`texts` のクリップ規則、3 段、`textLabelsFit`、省略の文字数がサロゲートペアを割らない、0 本、`captionLike` の塗りと `stroke`、`labels` 偽で文字を出さない）。区間の表（0 本で本体なし、`sub` の本数、テロップらしい区間の行）。`text_status`／`text_segmenter_current` から `MissingReason` への対応。検索（`q` の全角の NFKC、空白だけで既定、長さ、エスケープの順（`％` を含む `q`）、空、0 件、結果の並びと上限 50、`y`／`sort`／`dir` を保つ、リンクが `q` を保つ）。`lib/text-search.ts` とワーカーの `normalizeText` の同じ入出力の表。利用状況（0 件、今月の行がない、残りが 100 未満の `Callout`、推定費用の式と `$0.00`、12 か月の補い）。既存の R4 の画面のテストがそのまま通る |
| 実機 | 段階 0 の計測（9 章）。本番で既存の 18 本すべてに結果か理由が入り、月のユニットが上限以内（完了条件）。段階 5 の目視（合格条件の表）。スマートフォン幅の見た目はユーザーの確認 |

---

## 9. 段階

| 段階 | 内容 | 担当の案 |
|---|---|---|
| 0 | 計測と確認（ユニット 100 以内。使ったユニットを検討メモ 6.2 節に記録する）: 本番のリールの本数とフィード動画の本数、`video_analysis` が `success` の本数。手元で 1 本について、`extractFrameArgs` の 1 枚あたりの時間、JPEG（幅 1080、品質 4）の大きさ、8 枚の要求の往復時間、`words` の切り詰めた形の 1 枚の大きさ。`.local/ocr-check` の結果からテロップの文字の高さの比と中心 x を測り、4.3 節のしきい値を決める。JWT の `scope` を `cloud-vision` にして通ること。鍵の JSON の `token_uri` が定数と一致すること。Google Cloud 側で Vision API のクォータを下げられるか（下げられれば 1 日 300 要求程度に）。`scripts/ocr-check.mjs` が `languageHints` を付けていないこと | 親とユーザー |
| 1 | マイグレーション（5 章）、`config.ts`、`current_video_text_condition()`、権限、DB のテスト。**種データ**: 手元の DB の投稿 2〜3 本（ID は手元のもの。リポジトリに入れない）に対する `video_text_analyses`／`video_text_segments`／`ocr_usage` の偽の行を SQL で用意し、DB テストと段階 3 の画面の両方で使う | `node-worker-developer`。SQL は `postgres-sql-reviewer` がレビュー |
| 2 | ワーカー（3 章、4 章）: `lib/video-text.ts`、`lib/vision-client.ts`、`db/video-text.ts`、`jobs/video-text.ts`、`extractFrameArgs`、`runOrThrow` の `env`、`ctx.addSecret`、`check-alerts`、`check-env`、hourly への登録、固定データの作成（8 章）、テスト。手元で 2〜3 本を処理して区間を目視（使ったユニットを検討メモに記録）。終わったら手元の鍵を消すか別の鍵にする | `node-worker-developer`。`security-engineer` が 7 章の観点でレビュー |
| 3 | 画面（6 章）: 投稿詳細、リール分析、文字で探す、利用状況。段階 1 の種データで作る（段階 2 の完了を待たない） | `nextjs-developer` |
| 4 | **本番に反映（2026-10 中）**。手順: (1) GitHub に Secret `GCP_VISION_KEY_JSON`、変数 `WORKER_VIDEO_TEXT_MAX_PER_RUN=0`、`WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT=700` を登録 → (2) `db push` → main にマージ → 次の hourly で `video_text` が候補を数えて終わることを `/jobs` で確かめる（`items 0`、ログに `candidates=18`） → (3) 変数を 5 にして次の hourly を 1 回待つ → 0 に戻す → 投稿詳細で 5 本の区間と上段の数字を見る → (4) 問題がなければ 5 に戻し、残り 13 本が 3 回（約 3 時間）で処理されるのを待つ。**完了の確認**: `select text_status, text_segmenter_current, count(*) from public.media_video_features where account_id = … group by 1, 2` で `success`／真 が 18、null が 0。`/reels` の一覧の文字の 3 列に「—」がない。`/jobs` の 10 月のユニットが 700 以内。11 月にずれたら `WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT` を 1,000 に戻す | 親とユーザー |
| 5 | 目視の確認（下の合格条件）、しきい値の調整（`segmenter_version` を上げる。ユニットを使わない）、双方向制御文字の見え方、テストの不足、セキュリティレビュー、検討メモ 6.2 節への記録、**`.local/ocr-check` を消す** | `quality-engineer`、`security-engineer`、ユーザー |

**段階 5 の目視の合格条件**（直近のリール 3 本。Instagram のアプリで再生して比べる）:

| 項目 | 合格条件 |
|---|---|
| 文字 | 各本のテロップの各行が、区間の `text` と一致する（1 文字違いまで） |
| 時刻 | 各区間の開始と終了が目視の ±1 秒（カット直後に出るテロップの開始は ±0.3 秒） |
| 位置 | テロップの区間の `vertical_position` が目視の上・中・下と一致する |
| テロップらしさ | テロップの区間の 80% 以上が `is_caption_like` 真、背景の区間の 80% 以上が偽（Q7 の判断材料。満たさなければ 4.3 節のしきい値を調整） |
| 雑音 | 1 フレームの断片（看板と重なった割れ）が区間として残っていない。同じテロップが 2 つの区間に割れていない（残っていれば Q3 で調整） |
| 費用 | `/jobs` の 10 月のユニットが 700 以内。`ocr_usage` の合計 ＋ 手動の記録が Google Cloud の利用量と一致する |

段階 1〜2 と段階 3 は並べて進められる（画面は段階 1 の種データで作る）。本番への反映は `db push` → main へのマージの順（R4 と同じ。ビューに列を足すだけなので、古い画面は新しい DB でも動く）。

---

## 10. 確認事項

| # | 問い | 推奨 |
|---|---|---|
| Q1 | フレームの間隔（3.4 節）: 1,000 ms か 500 ms か | 1,000 ms。500 ms は一括処理だけで無料枠をほぼ使い切る。テロップは 1 秒以上出続けるので区間の精度は足りる。足りなければ `frame_interval_ms` を変えて再処理（ユニットを使う） |
| Q2 | 類似フレームの間引き（要件 8.7.3 章末尾）を版 0.2 で行うか | 行わない。無料枠に収まる間は複雑さに見合わない。月の利用が 700 を超える見込みになったら `analyzer_version` 2 で `mpdecimate` を試す |
| Q3 | 区間化のしきい値（確信度 0.5、包含 0.5、編集距離の比率 0.7、4 文字以下は編集距離 1、位置 15%、見落とし 1 枚、1 フレーム 2 文字以下を捨てる）とテロップらしさ（高さ 2.5%、中央 ±20%、2 フレーム以上）、既知の挙動（同じ文字が 2 か所、2 段落に割れたテロップ）の扱い | 設計の値で始め、段階 0 の実測と段階 5 の目視（合格条件の表）で調整する。調整は `segmenter_version` を上げるだけでユニットを使わない |
| Q4 | 月の境目（UTC か JST か）と上限（既定 1,000、範囲の上限 1,000、本数 30） | UTC。コードの既定は 1,000、**2026-10 の本番の変数は 700**（手動の確認 93 ＋ 段階 0 の 100 以内 ＋ 段階 2 の手元 60〜90 ≈ 290 が本番の集計に入らないため）。11 月にずれたら 1,000 に戻す |
| Q5 | JPEG の幅 1080（拡大しない）、品質 4、1 要求 8 枚、本文 6 MB | このまま。読み取りに実績のある大きさを保つ。ユニットは枚数で決まり、大きさでは変わらない |
| Q6 | 1 回 5 本、8 分、200 ユニット、打ち切り 5 回、長さの上限 3 分、取り出し全体 3 分、`images:annotate` 30 秒 | このまま。段階 0 の計測で見直す |
| Q7 | テロップだけの特徴量（`caption_*`）の扱い | 保存し、投稿詳細の区間の表の `sub` に出す。リール分析の要因には入れない（テロップらしさは推定で、全部の文字の指標を主にする決定に沿う）。段階 5 の合格条件を満たしたら要因に足す |
| Q8 | リール分析の `y` にスキップ率を足す | 足す。F-VID-31 の例に答える。「視聴と反応」は `y` と同じ指標の 1 枚を出さない規則にし、ヒントに「低いほどよい」を書き、上位と下位は値の大小のまま |
| Q9 | 文字で探すの置き場所 | 一覧のカードの上（一覧の `sub` の横）。分析のカードを主にするため。`/media` は変えない。**別案**: `PageHead` の直下（ページの先頭）に置くと入力欄が探しやすい（分析のカードより検索を主にするなら） |
| Q10 | 鍵の渡し方: Secret `GCP_VISION_KEY_JSON`（中身）＋ `add-mask` のステップ、手元は `GCP_VISION_KEY_FILE`（パス）。手元の鍵は段階 2 の後に消すか別の鍵にする | このまま。**別案**: Secret を `GCP_VISION_CLIENT_EMAIL`、`GCP_VISION_PRIVATE_KEY`、`GCP_VISION_PROJECT_ID` の 3 つに分ける（GitHub のマスクが各値にそのまま効き、`add-mask` が要らない。登録の手間が増える） |
| Q11 | 月の上限の通知を `check-alerts --scope daily`（1 日 1 通）にする | このまま。`hourly` は月が替わるまで毎時のメールになる |
| Q12 | Vision の `parent`（処理地域 us／eu）を付けるか | 付けない（自動）。データの所在の要件はない。付けるなら `eu` |
| Q13 | 部分的に失敗した本は、保存したフレームを使い回して足りない分だけ送り直す（3.6 節）。途中落ちの備えに取り掛かりの記録と要求ごとの保存を行う | このまま。ユニットの無駄を防ぎ、途中で落ちても打ち切りが効く。複雑さが気になるなら「失敗した本は全フレームを送り直す」に簡略化できる（最大 5 回 × 30 ユニット。取り掛かりの記録は残す） |
| Q14 | `media_analysis_dataset` に文字の列（条件 5 つと特徴量）を足す（R4 Q5 と同じ考え） | 足す |

---

## 11. 事実の確認（事実票。確認日 2026-10-11）

親のセッションが確認した事実をそのまま写す。起草者は Web を取っていない。

**決定（ユーザー。2026-10-11）**

- 文字取得の方式は Google Cloud Vision に決め打ち（比較はしない）。機能は `DOCUMENT_TEXT_DETECTION`（語ごとの確信度が返る。`TEXT_DETECTION` は確信度が 0 のまま。読める文字は同じ、費用も同じ 1 ユニット）
- 背景の文字（看板、メニュー、ポスター、商品の箱）も情報として扱い、テロップとの区別は必須にしない。特徴量は全部の文字から計算するものを主にし、テロップだけの特徴量（位置と大きさから推定）を併せて持つかは設計で提案して確認事項にする
- 費用の上限は無料枠の 1,000 ユニット／月（1 枚 × 1 機能 = 1 ユニット）。有料の領域に入らない。月の処理本数の上限は 30 本。超えたら止めて `check-alerts` で通知

**動作確認の結果（直近のリール 3 本、1 秒ごとの 72 枚、1080×1920 のまま送った。2026-10-11、親）**

- テロップ（白い文字に黒い縁取り、画面の上から 1/3 あたり、1 行 4〜12 文字）は 3 本ともほぼ全フレームで正しく読めた。確信度は 0.96〜1.00
- 背景の文字も同じ応答に混ざり、多いフレームでは 99〜125 語
- テロップが看板と重なった 1 枚で「溝口から徒歩4分」が「MU溝」「から徒歩4分」に割れた（区間にまとめるときに前後のフレームで補う）
- リールの長さは 21〜27 秒。1 本あたり 1 秒ごとで 21〜27 枚。16 枚ずつの 2 要求で送れた。処理時間は未計測
- 手元の DB には 2026-10-06 時点でリール 18 本、全投稿 25 件。投稿の頻度は月 4〜8 本の見込み

**Google Cloud Vision の API（公式文書で確認。2026-10-11）**

- エンドポイント `POST https://vision.googleapis.com/v1/images:annotate`。本文は `{ requests: [{ image: { content: <base64> }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }], imageContext?: { languageHints: [...] } }] }`。言語ヒントは付けない方がよい結果になることが多い（Google の文書）。任意の `parent: "projects/{id}/locations/{us|eu}"` で処理地域を指定できる（asia はない。省略時は自動）
- 上限: 1 要求に画像 16 枚まで、画像 1 枚 20 MB まで、JSON の要求本文 10 MB まで（base64 は元の約 1.37 倍）、1 分あたり 1,800 要求。1080×1920 の JPEG（品質 3）は 1 枚 200〜400 KB なので 16 枚で base64 後に 5〜9 MB になり 10 MB に近い
- 応答: `responses[].fullTextAnnotation.text`（全文）と `pages[] → blocks[] → paragraphs[] → words[] → symbols[]`。block／paragraph／word／symbol に `boundingBox.vertices[{x, y}]`（座標 0 は省略される）、`confidence`（0〜1）、`property.detectedLanguages[{languageCode, confidence}]`、`property.detectedBreak`。`responses[].textAnnotations[0].description` も全文、`locale` は言語。`responses[].error` は 1 枚ごとの失敗
- 料金: 月の最初の 1,000 ユニットは無料。以後 1,000 ユニットごとに $1.50（500 万ユニットまで）（cloud.google.com/vision/pricing）
- データの扱い: 送った画像を Cloud Vision の学習に使わない。解析のために短時間保存し、数時間以内に消す（Google の data-usage の FAQ）
- 認証: サービスアカウントの鍵（JSON。`client_email`、`private_key`、`token_uri`）から RS256 の JWT（scope `https://www.googleapis.com/auth/cloud-platform`、有効 1 時間）を作り、`token_uri` に `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` で送ってアクセストークンを得る。`node:crypto` だけで書ける（`scripts/ocr-check.mjs` で動作確認済み。新しい npm 依存は足さない方針。`@google-cloud/vision` 6.1.1 は Node 22 以上、google-gax に依存し大きい）
- IAM: Vision の画像の読み取りには IAM の権限の定義がなく、API を有効にしたプロジェクトのサービスアカウントならロールなしで呼べた（動作確認で確認）

**既存の仕組み（設計が従うもの）**

- `video_analysis` ジョブ（R4）は hourly グループの `media_snapshot` の次に動き、1 回 5 本・8 分の予算、`media_url` を Graph API で取り直し、動画を一時ディレクトリに落として ffmpeg で解析し、必ず消す。今の解析条件は DB の関数 `current_video_condition()` に持ち、画面のビューはその条件の行だけを使う。同じ条件では再処理しない。`attempt_count` で打ち切る。ログに `media_id` も URL も出さない（公開ログ）。環境変数は `apps/worker/src/config.ts` の `integerInRange(env, "WORKER_VIDEO_MAX_PER_RUN", 既定, 下限, 上限)` の形で読む
- ffmpeg の呼び出しは `apps/worker/src/lib/ffmpeg.ts` の `runOrThrow(tool, args, timeoutMs)` を使う（`resizeImageArgs(input, output, width)` は `scale=<width>:-2 -frames:v 1 -q:v 4` で 1 枚を JPEG に書く。フレームの連番出力は新しい引数の関数を足す）
- GitHub Actions（`collect.yml`）の Secrets は必要なステップの `env` にだけ渡す。収集のステップは `daily` と `hourly` の 2 つ。既存に「mask db host」のステップがある。`concurrency` は `group: instagram-analyze-collect`、`cancel-in-progress: false`。鍵の JSON は Secret として渡し、ワーカーは `env` から読んで値をログに出さない。手元では `.env` に置く（`.local/gcp-vision-key.json` のパスを指す形でもよい）
- `check-alerts` コマンド（R2 設計 5.2 章）は人が見るべき状態なら終了コード 1 で GitHub の失敗メールになる。月の上限に達したことの通知はここに条件を足す
- 要件 5.3 章の保存項目: `text_segments`（文字、表示開始 ms、表示終了 ms、位置、確信度）、`first_text_ms`、`has_text_in_first_3s`、`text_coverage_ratio`、`total_text_chars`、`ocr_method`／`ocr_version`／`frame_interval_ms`。5.1 章の「AI・OCR の利用記録」（処理した対象、方式、モデル名、入出力の量、費用、処理時刻）。9 章の「AI・OCR の利用状況」画面（月ごとの処理件数と費用）。AI-03: AI の出力はデータとして保存して使い回す（同じ入力を同じ条件で二度処理しない）
- 要件 F-VID-21: フレームは各カットの直後と一定間隔（例: 0.5 秒ごと）。取り出したフレームは解析後に削除する。8.7.3 章末尾: 見た目がほぼ同じ連続フレームを除く、カット直後を優先し間隔は調整できるようにする
- Postgres の `normalize(text, NFKC)` は R5 の `caption_hashtags()` で使用済み（本番にも 2026-10-08 に反映済み）。`job_runs` を消す仕組みはない（cron が消すのは `cron.job_run_details` だけ）

**起草時に確かめたこと（コードの `grep`。2026-10-11）**

- `JobContext` に `jobRunId: string` と `startedAt: Date` がある（`jobs/framework.ts`）。`recordFailure` の `errorClass` は `rate`／`auth`／`db`／`download`／`unknown` と項目の分類（`fatal`／`transient`）
- `job_runs.id` と `video_analyses.id` は `bigint`、`accounts.id` は `uuid`、`media.id` は `text`
- `web_app` のポリシーは `create policy web_app_select on … for select to web_app using (true)` の形。R5 は新しい表に `revoke all … from public, anon, authenticated` を明示している
- `check-alerts` は `--scope hourly|daily` を取り、判定は `jobs/alerts.ts` の `evaluateAlerts`（純関数）
- `FACTORS` は 8 個（`cuts_in_last_3s` を含む）、散布図は `scatter: true` の 7 枚、一覧は 17 列、区分は 2 行（画面レビューで確認）
- 最新のマイグレーションは `20261011000000_r2_dispatch_connect_timeout.sql`

**未確認（段階 0 で確かめる）**

- Google の無料枠の「月」が切り替わる時刻（時間帯）。失敗した要求（4xx／5xx）の課金の有無。Vision API のクォータを下げられるか
- JWT の `scope` を `https://www.googleapis.com/auth/cloud-vision` にして通るか
- `extractFrameArgs`（`-ss` 前置き）の 1 枚あたりの時間、幅 1080・品質 4 の JPEG の大きさ、8 枚の要求の往復時間、切り詰めた `words` の 1 枚の大きさ
- テロップの文字の高さの比と中心 x（4.3 節のしきい値）
- `scripts/ocr-check.mjs` が `languageHints` を付けていないこと
- リールの長さの上限（3 分）
- 手元の Docker compose で鍵のファイルをマウントする書き方

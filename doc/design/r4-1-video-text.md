# R4.1 動画分析（画面の文字）の設計

- 版: 0.1（2026-10-11）。起草（`node-worker-developer`）。レビュー前

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-11 | 起草 |

- 検討メモ: `doc/ai-decisions/r4-1-video-text-ocr.md`（方式は Google Cloud Vision の `DOCUMENT_TEXT_DETECTION` に決定。2026-10-11、ユーザー。動作確認の結果と上限は同メモ 5〜6 章）
- 要件: `doc/requirements/requirements-definition.md` 4.5.1 章（F-VID-20〜32）、5.1 章「AI・OCR の利用記録」、5.3 章「画面の文字（R4.1）」、8.7 章（AI-01〜07）、9 章「AI・OCR の利用状況」、10 章（R4.1 の完了条件）
- 既存: R4 の `video_analysis`（`doc/design/r4-video-analysis.md`、`apps/worker/src/jobs/video-analysis.ts`、`jobs/video-store.ts`、`lib/video-analysis.ts`、`lib/ffmpeg.ts`、`db/video.ts`）、`video_analyses`／`video_cuts`（`supabase/migrations/20261001100200_r1_video.sql`、`20261007000000_r4_video.sql`）、投稿詳細（`apps/web/src/lib/queries/media-detail.ts`、`components/charts/CutTimeline.tsx`、`app/media/[id]/_detail/CutTimelineCard.tsx`、`lib/video-timeline.ts`）、リール分析（`lib/reels.ts` の `FACTORS`）、`check-alerts`（R2 設計 5.2 章。`commands/check-alerts.ts`、`jobs/alerts.ts`）
- デザイン: `doc/design-system.md`。既存の部品（`Card`、`Callout`、`MetricHint`、`MissingValue`、`SortHeader`、`components/charts/`）を使い、新しい見た目は足さない

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
- 見た目がほぼ同じ連続フレームの間引き（要件 8.7.3 章末尾、AI-05）。無料枠に収まる見込みなので版 0.1 では行わず、後の最適化の案だけ書く（3.4 節、Q2）
- 縦書き、手書き風、看板と重なった文字の読み取りの精度の改善（API の結果をそのまま使い、区間化で前後のフレームから補うだけ）
- フレームと動画の保存（NF-CAP-03）。残すのは読み取りの結果だけ
- ストーリーズとカルーセルの中の動画の文字（R4 と同じ理由。ストーリーズは 24 時間で消え、カルーセルの子は指標と結び付かない）
- 文字の意味の分類、要約、タグ付け（R7 以降の LLM の用途）

---

## 2. R4 までで済んでいるもの

| もの | 内容 |
|---|---|
| 表 | `video_analyses`（今の条件の `success` の行から `duration_ms`、`width`、`height` を使う）、`video_cuts`（カットの時刻 `at_ms`） |
| ジョブの作法 | `video_analysis` の、`media_url` の取り直し（`GET /{media-id}?fields=id,media_type,media_url`。ID は `isMediaId` で確かめる）、ダウンロード（`downloadToFile`。https、ホストの後方一致、200 MB、60 秒、`content-type` が `video/`）、一時ディレクトリ（`mkdtemp` と `finally`）、本数と時間の予算、打ち切り（`attempt_count`）、ログの決まり（`media_id` と URL を出さない）。`video_text` は同じ作法で書く |
| ffmpeg | `lib/ffmpeg.ts` の `runOrThrow(tool, args, timeoutMs)`、`toolVersion`、`CommandError`、`resizeImageArgs`（1 枚の JPEG。`scale=<width>:-2 -frames:v 1 -q:v 4`）。R4 設計 3.5 節の入力の制限（`-protocol_whitelist file -f mp4`） |
| 条件の持ち方 | `current_video_condition()`（今の条件を DB の関数に持ち、画面のビューはその条件の行だけを使う。変えるたびにマイグレーションで作り直す） |
| 画面 | 投稿詳細の「カットのタイムライン」（`CutTimeline`、`TimelineModel`、`timelineModel`、`videoAnalysisMissing`、`getVideoFeatures`）、リール分析の要因（`FACTORS` の 7 つ）、散布図、区分、一覧、目的変数の選択 `y` |
| 通知 | `check-alerts --scope hourly\|daily`。判定は `jobs/alerts.ts` の `evaluateAlerts`（純関数）。該当があれば `WARN alert=…` と終了コード 1 で GitHub の失敗メールになる |
| 権限 | `web_app` ロール。表は `grant select` と `create policy web_app_select on … for select to web_app using (true)`、ビューは `with (security_invoker = true)`、`revoke all … from public, anon, authenticated`、`grant select … to web_app`（R2、R4、R5 の書き方）。関数は `revoke execute … from public` と `grant execute … to web_app`（`web-role.test.ts` が棚卸しする） |
| 鍵と API の確認 | `scripts/ocr-check.mjs` が `node:crypto` だけで JWT → アクセストークン → `images:annotate` を通した（2026-10-11。11 章） |

---

## 3. 収集: `video_text` ジョブ

### 3.1 対象と選び方

対象は次をすべて満たす投稿。選ぶのは `db/video-text.ts` に足す `listVideoTextCandidates` の SQL 1 本で、再試行と打ち切りの判定もこの SQL に置く（R4 3.1 節と同じ）。

- `media_type = 'VIDEO'` かつ `media_product_type in ('REELS', 'FEED')`、`gone_at` が null
- `video_analyses` に今のカットの条件（`ANALYZER_VERSION`、`DEFAULT_SCENE_THRESHOLD`）の `success` の行があり、`duration_ms` が `VIDEO_TEXT_MAX_DURATION_MS`（3 分。3.2 節）以下（カットの時刻と長さが要る。長すぎる動画はフレームが多すぎて無料枠を使い切るので対象にしない）
- 今の OCR の条件の `video_text_analyses` の行がない、または (a) `status <> 'success'` かつ `attempt_count < 上限` かつ `analyzed_at <= now − 3 時間`、または (b) `status = 'success'` かつ `segmenter_version` が今の版と違う（区間化と特徴量だけ計算し直す。API は呼ばない）

**条件の列**。「同じ入力を同じ条件で二度処理しない」（F-VID-25、AI-03）の「条件」を次の 5 つに分ける。

| 列 | 値（版 0.1） | 変えたときの影響 |
|---|---|---|
| `ocr_method` | `google_vision` | 方式を変えたら全件を再処理（ユニットを使う） |
| `ocr_version` | `v1/DOCUMENT_TEXT_DETECTION` | API の版か機能を変えたら全件を再処理 |
| `frame_interval_ms` | `1000` | 間隔を変えたら全件を再処理 |
| `analyzer_version` | `1` | フレームの取り出し方（カット直後のずらし、重ねない幅、JPEG の幅と品質）と要求の作り方の版。変えたら全件を再処理 |
| `segmenter_version` | `1` | 区間化の規則と特徴量の定義の版。変えても API は呼ばず、保存したフレームの結果から計算し直す（AI-03「使い回す」） |

一意キーは前の 4 つ `(media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version)`。`segmenter_version` は同じ行の列で、計算し直したら上書きする。カットの条件（しきい値）は OCR の条件に含めない（しきい値を変えてもユニットを使って再処理しない。変わるのはカット直後のフレームの位置だけ）。使ったカットの解析の行は `video_analysis_id` に残す。しきい値の変更に合わせて読み直したいときは `analyzer_version` を上げる。

```sql
select m.id, m.posted_at,
       va.id as video_analysis_id, va.duration_ms, va.width, va.height,
       vt.id as text_analysis_id, vt.status as text_status, vt.segmenter_version
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
  and va.duration_ms is not null and va.duration_ms <= $8
  and (vt.id is null
       or (vt.status <> 'success'
           and vt.attempt_count < $9
           and vt.analyzed_at <= $10::timestamptz - make_interval(hours => $11))
       or (vt.status = 'success' and vt.segmenter_version <> $12))
order by m.posted_at desc, m.id
```

- 全件を返し（数十本）、JS で先頭から処理する。残りの数を `skipped_by_limit`、`skipped_by_budget`、`skipped_by_monthly_cap` としてログに出す
- カットの時刻は 1 本ずつ `video_cuts` から `seq` 順に読む（候補の SQL に配列で含めない。対象は数十本なので往復は問題にならない）
- 結合は両方とも一意制約の索引（`video_analyses` は `(media_id, analyzer_version, scene_threshold)`、`video_text_analyses` は 5.2 節の一意制約）が使われる。新しい索引は要らない
- `now` は `ctx.now()` を渡す（R4 と同じ。SQL の `now()` は使わない）

### 3.2 グループの中の位置と、本数・時間・ユニットの予算

- hourly グループを `stories` → `media_sync` → `media_snapshot` → `video_analysis` → **`video_text`** → `account_backfill` にする。新しい投稿は同じ回に `video_analysis` の後で処理できる
- ジョブの途中では止めない（R4 3.2 節と同じ作法）。長さと費用は次の 4 つで抑える。いずれも「新しい 1 本を始める前」にだけ見る

| 設定 | 既定 | 範囲 | 意味 |
|---|---|---|---|
| `WORKER_VIDEO_TEXT_MAX_PER_RUN` | 5 | 0〜100 | 1 回の本数。0 にすると候補を数えるだけで 1 本も始めない（本番で一時的に止めるときに GitHub の変数で 0 にする。R4 の `WORKER_VIDEO_MAX_PER_RUN` は下限 1） |
| `WORKER_VIDEO_TEXT_BUDGET_MS` | 8 分 | 0〜30 分 | 時間の予算。ジョブの開始からの経過がこれを超えていたら新しい 1 本を始めない |
| `WORKER_VIDEO_TEXT_MAX_UNITS_PER_RUN` | 200 | 1〜1,000 | 1 回のユニット。「この回で使ったユニット ＋ この本の送る枚数」が超えるなら始めない（枚数は長さとカットから計算でき、ダウンロードの前に分かる。3.4 節） |
| `VIDEO_TEXT_MAX_DURATION_MS`（定数） | 3 分 | — | 対象にする動画の長さの上限（3.1 節の SQL）。リールの最長は 3 分（未確認）。1,000 ms 間隔で最大約 185 枚 |

`config.ts` は `integerInRange(env, "WORKER_VIDEO_TEXT_MAX_PER_RUN", 既定, 下限, 上限)` の形で読む（R4 の `videoMaxPerRun`、`videoBudgetMs` と同じ）。

1 本の時間の見込み: ダウンロード（R4 の計測ではシーン検出を含めて 1 本約 2.4 秒）、フレームの取り出し 22〜30 枚 × 0.1〜0.5 秒（未確認）、Vision 3〜4 要求 × 1〜3 秒（未確認）で、1 本 10〜30 秒。5 本で 1〜3 分。最悪の時間は、予算の直前に始めた 1 本（ダウンロード 60 秒 ＋ 取り出し 30 枚 × 制限 15 秒 ＋ 要求 4 × 制限 60 秒 = 約 12.5 分）で、R4 の最悪（約 15 分）より短い。段階 0 で実測し、Q6 で見直す。

### 3.3 月の上限と月の境目

| 設定 | 既定 | 範囲 | 意味 |
|---|---|---|---|
| `WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT` | 1,000 | 0〜100,000 | 月のユニットの上限（無料枠。検討メモ 5.3 節） |
| `WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS` | 30 | 0〜1,000 | 月の本数の上限（検討メモ 5.3 節） |

- **月は UTC の暦月**（Q4）。Google の無料枠の「月」がどの時刻で切り替わるかは未確認（請求アカウントの暦月。時間帯は未確認）。UTC は DB の `timestamptz` と `job_runs` と同じ基準で、SQL が `date_trunc('month', requested_at at time zone 'UTC')` で済む。JST と最大 9 時間ずれるが、月末の数時間に処理が集中することはなく、上限の余裕で吸収する
- **判定**: 1 本を始める前に `ocr_usage`（5.2 節）から今月の `sum(units)` と `count(distinct media_id)` を読む（`db/video-text.ts` の `monthlyOcrUsage(db, accountId, now)`）。`使用済み + この本の送る枚数 > ユニットの上限`、または `本数 >= 本数の上限` なら、この本も残りも始めず `skipped_by_monthly_cap` に数え、`warn` を 1 行出す（固定文言「月の上限に達した」）。`recordFailure` はしない（ジョブの失敗ではない）。区間化だけやり直す本（3.1 の (b)）はユニットを使わないので上限の判定をせず処理する
- **失敗した要求の枚数もユニットに数える**（HTTP 4xx／5xx の要求を Google が課金するかは未確認。多めに数える側に倒す）
- **手動の確認は数えない**: `scripts/ocr-check.mjs` の利用（2026-10 に 93 ユニット。段階 0 でさらに 100 以内）は `ocr_usage` に入らない。2026-10 の見込みは、手動 200 以内 ＋ 既存 18 本の一括 470〜540（3.4 節）= 750 以内で 1,000 に収まる。手動の分を見込んで既定を下げる案は Q4
- **通知**: `jobs/alerts.ts` の `evaluateAlerts` に種類 `ocr_monthly_cap` を足す。`check-alerts --scope daily` が `ocr_usage` の今月の合計と上限（`WorkerConfig` の 2 つ）を比べ、ユニットか本数が上限に達していれば `WARN alert=ocr_monthly_cap units=<n> videos=<n>` と終了コード 1。`hourly` に入れると月が替わるまで毎時の失敗メールになるので `daily`（1 日 1 通）にする（Q11）。`check-alerts` は鍵を使わない（DB と設定だけ）

### 3.4 フレームの取り出し

**時刻の決め方**（`lib/video-text.ts` の純粋関数 `frameTimes(durationMs, cutsMs, { intervalMs: 1000, cutOffsetMs: 100, mergeWindowMs: 300 })`）:

1. カット直後: 各カットの `at_ms + 100`。`duration_ms` を超えるものは捨てる。互いに 300 ms 未満しか離れていなければ先のものだけ残す
2. 一定間隔: `0, 1000, 2000, …`（`duration_ms` 以下。0 を含める。冒頭のテロップは 0 ms から出ている）
3. 2 の各時刻は、1 のいずれかと 300 ms 未満の差なら捨てる（カット直後を優先する。要件 8.7.3 章末尾）
4. 昇順に並べ、各フレームに `source`（`cut`／`interval`）を付ける

例: R4 で目視した 21.2 秒のリール（カット 19 回。1.0〜19.0 秒に 1 秒ごと）は、カット直後 19 枚（1.1〜19.1 秒）＋ 間隔 0、20、21 秒の 3 枚 = 22 枚。1 秒ごとだけの 22 枚と同じ枚数で、位置がカットの直後に寄る。動作確認の 3 本（21〜27 秒）では 1 本 22〜30 枚の見込み。

**間隔と費用**（1 本 25 秒、カット直後の重なりを含めた概算）:

| 間隔 | 1 本 | 既存 18 本の一括 | 毎月（4〜8 本） |
|---|---|---|---|
| **1,000 ms（推奨）** | 約 26〜30 枚 | 約 470〜540 ユニット | 約 100〜240 ユニット |
| 500 ms | 約 51〜55 枚 | 約 920〜990 ユニット | 約 200〜440 ユニット |

500 ms だと一括処理だけで無料枠をほぼ使い切り、同じ月に投稿したリールが処理できない。テロップは 1 秒以上出続けるので、1,000 ms で区間の開始と終了の誤差は ±1 秒（カット直後の分でカットの直後は 100 ms に縮む）。F-VID-21 の「例: 0.5 秒ごと」は例であり、要件は間隔を調整できること（Q1）。

**類似フレームの間引き**（版 0.1 では行わない。Q2）: 行うなら `analyzer_version` を 2 にして、(a) ffmpeg の `mpdecimate` フィルタで前のフレームとほぼ同じフレームを落とす、または (b) 取り出した JPEG を幅 32 の灰色画像に縮めて前のフレームとの差分の平均が閾値未満なら送らない、のどちらか。動きのないカットが続くリールで 20〜40% 減る見込み（未計測）。無料枠に収まる間は複雑さに見合わない。

**取り出し**（ffmpeg。1 枚ずつ）:

```
ffmpeg -hide_banner -loglevel error -protocol_whitelist file -f mp4 -ss <秒> -i video.mp4 \
  -frames:v 1 -vf scale='min(1080,iw)':-2 -q:v 4 -y frame-<at_ms>.jpg
```

- `lib/ffmpeg.ts` に `extractFrameArgs(input, atMs, output, maxWidth = 1080)` を足す（`resizeImageArgs` と同じ形で引数の配列を返す純粋関数。`-ss` を `-i` の前に置き、キーフレームまで飛んでから目的の時刻まで復号する）。1 枚の制限時間は 15 秒（`runOrThrow`）。1 枚 0.1〜0.5 秒の見込み（未確認。段階 0 で計る）
- 1 回の ffmpeg で `select` フィルタを使って全枚数を出す方法は採らない（カット直後の時刻が不規則で式が長くなる。`-ss` の方が R4 で実績のある引数の形に近い）
- 入力の制限は R4 3.5 節と同じ（`-protocol_whitelist file -f mp4`）
- フレームは動画と同じ一時ディレクトリ（`mkdtemp`）に置き、`finally` で動画ごと消す（F-VID-21、NF-CAP-03）
- **幅と品質**（Q5）: 幅 1080（元が 1080 未満なら拡大しない。`min(1080,iw)`）、JPEG 品質 `-q:v 4`。動作確認は 1080×1920 のままで確信度 0.96〜1.00 だったので、読み取りに実績のある大きさを保つ。ユニットは枚数で決まり画像の大きさに依らないので、縮小しても費用は変わらない。送る量（1 本 22〜30 枚 × 200〜400 KB = 5〜12 MB）と 10 MB の制限は 1 要求の枚数で解く（3.5 節）。1 枚の大きさは段階 0 で実測する（未確認。品質 4 で 200〜400 KB の見込み）

### 3.5 Vision への要求

`lib/vision-client.ts` に `createVisionClient(key, { fetch, now })` を置く。`fetch` はテストで差し替える。

- **宛先**: `POST https://vision.googleapis.com/v1/images:annotate`（コードの定数。設定で変えられない）。本文は `{ requests: [{ image: { content: <base64> }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }, …] }`。`imageContext.languageHints` は付けない（Google の文書の推奨。動作確認もヒントなし。未確認: 動作確認のスクリプトがヒントを付けていないこと）。`parent`（処理地域）は付けない（Q12）
- **分割**（純粋関数 `splitRequests(frames, { maxImages: 8, maxBodyBytes: 6 MB })`）: 時刻順に詰め、8 枚か、base64 の合計（`ceil(bytes / 3) × 4`）が 6 MB を超える手前で切る。1 枚で 6 MB を超えるフレームは送らず、そのフレームを失敗（固定文言「画像が大きすぎる」）にする。API の上限（16 枚、JSON 10 MB）に対して半分の余裕を取る
- **認証**: 鍵の JSON（`client_email`、`private_key`、`token_uri`）から RS256 の JWT を作る（純粋関数 `createServiceAccountJwt(key, now)`: `iss` = `client_email`、`scope` = `https://www.googleapis.com/auth/cloud-platform`、`aud` = トークンの URL、`iat`、`exp` = `iat + 3600`。署名は `node:crypto` の `createSign("RSA-SHA256")`）。`POST https://oauth2.googleapis.com/token`（コードの定数。鍵の `token_uri` がこれと違えば鍵を使わず失敗にする）に `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` を送り、`access_token` と `expires_in` を得る。トークンはクライアントの中に持ち、`expires_in − 300 秒`まで使い回す。トークンは引数にも戻り値にもログにも乗せない（R1 10.5 章の決まりと同じ）
- **制限時間**: トークン 15 秒、`images:annotate` 1 要求 60 秒（`AbortSignal.timeout`）
- **応答の解釈**（純粋関数 `parseAnnotateResponse(json, imageCount)`）: `responses` の長さが枚数と違えば要求全体を失敗にする。各要素は `error` があればそのフレームの失敗（`code` だけ保存）、なければ `fullTextAnnotation` から 4.1 節の形に切り詰める。`fullTextAnnotation` がない（文字なし）は `text = ''`、`words = []` の成功
- **頻度**: 1 分あたり 1,800 要求の上限に対し、1 回のジョブで多くて 20〜25 要求。待ちは入れない。429 は 3.6 節
- 新しい npm 依存は足さない（`@google-cloud/vision` は使わない。検討メモ 11 章の事実票）

### 3.6 失敗の分類、再試行、打ち切り

| 事象 | 分類（`recordFailure` の `errorClass`） | 扱い |
|---|---|---|
| 鍵がない（`config.visionKey` が undefined） | `unknown`。固定文言「Vision の鍵がない」 | ジョブの最初に判定。行を書かず、ダウンロードもせず、`recordFailure` を 1 回だけ記録して終わる（ffmpeg がないときと同じ。`attempt_count` は増えない） |
| ffmpeg がない | `unknown`。`NO_FFMPEG_ERROR` | 同上 |
| トークンの取得が 400／401／403、`images:annotate` が 401／403 | `auth`。固定文言「Vision の認証に失敗（status n）」 | 行を書かず `recordFailure` 1 回で、この回は終わる（残りは次の回。鍵の失効は毎回の通知で分かる） |
| 429 | `rate`。固定文言「Vision の頻度の上限（status 429）」 | 2 秒、8 秒待って 2 回まで再送。だめなら行を書かず、この回は終わる |
| 5xx、ネットワークの失敗、制限時間 | `transient`。固定文言「Vision の要求に失敗（status n／なし）」 | 同じ再送。だめならこの本は `failed`（送れたフレームは保存する）。2 本続けて失敗したらこの回は終わる |
| 400 など 4xx（要求の形、大きさ） | `fatal`。同じ固定文言 | この本は `failed`。再試行で同じ結果になるので `attempt_count` で打ち切られる |
| 1 枚ごとの `responses[].error` | — | そのフレームを `error_code` 付きで保存する。1 枚でもあればこの本は `failed`（固定文言「読めないフレームがある（n 枚）」、`recordFailure` は `unknown`）。次の回は足りないフレームだけ送る（下） |
| `media_url` がない | — | `no_video_url`。`warn` のみ（R4 3.4 節） |
| 取り直しの `fatal`／`transient`、`media_type` が `VIDEO` でない | R4 3.4 節と同じ | 同じ固定文言（`mediaFetchFailedError`、`NOT_VIDEO_ERROR` を再利用） |
| ダウンロード、ffmpeg の失敗 | `download`／`unknown` | `failed`。`error` 列は `DownloadError` の固定文言か `ctx.mask` 済みの文字列（R1 の `analyzeVideo` と同じ決まり） |

**足りないフレームだけ送る（使い回し）**: フレームの時刻の集合は条件（長さ、カット、`analyzer_version`）から決まるので、再試行のたびに同じになる。1 本の処理は次の順。

1. 候補の行があれば `video_text_frames` から `error_code` が null の `at_ms` を読む
2. 必要なフレーム = 計画した時刻 − 保存済みの時刻。0 枚なら、ダウンロードせず区間化だけして `success`（ユニット 0）
3. 必要なフレームだけ取り出して送る。この本のユニットは必要な枚数（3.2 節の予算と 3.3 節の上限はこの枚数で判定する）
4. 書き込み（1 トランザクション）: `video_text_analyses` を upsert（一意キーで衝突したら全列を上書きし `attempt_count + 1`）、`video_text_frames` は計画にない `at_ms` の行を消し、今回の結果を `at_ms` で upsert、`video_text_segments` は消して入れ直す
5. `success` は、計画したすべてのフレームに `error_code` が null の結果があるときだけ

**打ち切り**: `VIDEO_TEXT_MAX_ATTEMPTS = 5`（ジョブの定数。R4 と同じ）。`success` 以外で達した回に `warn` を 1 行。やり直すときは行を手元の SQL で消すか版を上げる（専用のコマンドは作らない）。

### 3.7 ログと利用記録

- `info`、`warn`、`debug`、`recordFailure` に `media_id`、URL、鍵、トークン、読み取った文字を入れない。件数、固定文言、HTTP の status だけ（公開ログに出るため）。Vision の `error.message` もログに出さない（`code` だけ）
- 最後に `info` で `candidates`、`processed`（`success` の本数）、`resegmented`（区間化だけやり直した本数）、`no_video_url`、`failed`、`requests`、`units`、`month_units`（この回の後の今月の合計）、`skipped_by_limit`、`skipped_by_budget`、`skipped_by_monthly_cap` を出す
- `success` は `ctx.progress.items += 1`（`items_fetched` は成功した本数）
- **`ocr_usage`**（5.2 節）: 1 要求 1 行。応答を受けた直後に、解析の書き込みとは別のトランザクションで書く（後の書き込みが失敗してもユニットは数える）。失敗した要求も `ok = false` で書く。`job_run_id` は `ctx.jobRunId`（`framework.ts` の `JobContext` にある。文字列なので `bigint` の列にそのまま渡す）。要件 5.1 章の「入出力の量」は `image_count`、`request_bytes`、`response_bytes`、`word_count`、「費用」はユニット（単価は画面で掛ける。6.4 節）

### 3.8 鍵の扱い

| 場所 | 持ち方 |
|---|---|
| GitHub Actions | Secret `GCP_VISION_KEY_JSON`（鍵の JSON ファイルの中身そのまま）。`collect.yml` の収集のステップの `env` にだけ渡す（`check-alerts` のステップには渡さない） |
| 手元の Docker | `.env` に `GCP_VISION_KEY_FILE=.local/gcp-vision-key.json`（ユーザーが置いた場所）。compose でこのファイルをコンテナに読み取り専用でマウントする（未確認: compose の書き方。実装時に合わせる） |
| `config.ts` | `visionKey?: { clientEmail: string; privateKey: string; tokenUri: string }`。`GCP_VISION_KEY_JSON` があれば JSON として読み、なければ `GCP_VISION_KEY_FILE` のファイルを読む（`process.env` とこのファイルを読むのは `config.ts` だけ）。3 つの項目がそろわなければ固定文言「Vision の鍵の形が不正」で起動時に失敗にする（中身は出さない）。どちらもなければ undefined（ジョブが 3.6 節のとおり記録する） |
| `check-env` | 「Vision の鍵: あり／なし」だけを出す |

- 鍵の値、`private_key`、アクセストークンをログ、例外の文面、`recordFailure`、DB、生の応答の保存に入れない。失敗の文面は固定文言と HTTP の status だけ
- 鍵の交換: Google Cloud でサービスアカウントの鍵を作り直して Secret を置き換える。コードの変更は要らない
- 推奨（ユーザーの作業。コードの外）: Vision 専用のプロジェクトにし、他の API を有効にしない（Vision には IAM の権限の定義がなく、鍵が漏れると同じプロジェクトの有効な API を呼べる）。Google Cloud の予算アラート（$1）を設定する
- API キー方式（`?key=`）は使わない（HTTP リファラなどで絞れず、ログの URL に出る恐れがある）

### 3.9 ファイルの担当

R1 設計 10.3 章にならい、触るファイルを分ける。

| ファイル | 内容 | 段階 |
|---|---|---|
| `apps/worker/src/jobs/video-text.ts` | ジョブ本体（`createVideoTextJob(deps)` と `export const job`）。対象、予算と上限の判定、取り直し、1 本の流れ、ログ | 2 |
| `apps/worker/src/lib/video-text.ts` | 純粋関数: `frameTimes`、`normalizeText`、`frameLines`、`segmentFrames`、`summarizeSegments`、定数（版、しきい値） | 2 |
| `apps/worker/src/lib/vision-client.ts` | JWT、トークン、`images:annotate`、`splitRequests`、`parseAnnotateResponse` | 2 |
| `apps/worker/src/lib/ffmpeg.ts` | `extractFrameArgs` を足すだけ（既存の関数は変えない） | 2 |
| `apps/worker/src/db/video-text.ts` | `listVideoTextCandidates`、`listCutsForAnalysis`、`listStoredFrames`、`writeVideoTextAnalysis`、`insertOcrUsage`、`monthlyOcrUsage` | 2 |
| `apps/worker/src/config.ts` | 3.2 節と 3.3 節の環境変数、`visionKey` | 1 |
| `apps/worker/src/jobs/groups.ts`、`index.ts` | hourly への登録（段階 2 の最後） | 2 |
| `apps/worker/src/jobs/alerts.ts`、`commands/check-alerts.ts` | `ocr_monthly_cap` | 2 |
| `.github/workflows/collect.yml` | Secret を収集のステップの `env` に足す | 4 |
| `supabase/migrations/20261012000000_r4_1_video_text.sql` | 5 章 | 1 |
| `apps/web/src/lib/queries/media-detail.ts`、`lib/video-timeline.ts`、`components/charts/CutTimeline.tsx`、`app/media/[id]/_detail/CutTimelineCard.tsx` | 6.1 節 | 3 |
| `apps/web/src/lib/reels.ts`、`app/reels/`、`lib/queries/`（リール分析と検索） | 6.2〜6.3 節 | 3 |
| `apps/web/src/app/jobs/`、`lib/queries/ocr-usage.ts` | 6.4 節 | 3 |

---

## 4. 区間化と特徴量

すべて `lib/video-text.ts` の純粋関数で、保存したフレームの結果（4.1 節）だけから計算する。入力が同じなら出力が同じ（`segmenter_version` を上げたときに API を呼ばずに計算し直せる。3.1 節）。しきい値は `SEGMENTER_PARAMS` の定数にまとめ、変えたら `segmenter_version` を上げる。

### 4.1 フレームの結果の整え方

**保存する形**（`video_text_frames.words`。jsonb）。API の `fullTextAnnotation.pages[].blocks[].paragraphs[].words[]` を語ごとに次に切り詰める。

| 鍵 | 内容 |
|---|---|
| `b`、`p` | block と paragraph の番号（0 から。行の復元に使う） |
| `t` | 語の文字（`symbols[].text` を連結） |
| `c` | 語の `confidence`（0〜1。小数 3 桁に丸める） |
| `l` | `property.detectedLanguages[0].languageCode`。なければ null |
| `x0`、`y0`、`x1`、`y1` | `boundingBox.vertices` の最小と最大（省略された座標は 0）。送った画像の画素 |
| `br` | 最後の symbol の `property.detectedBreak.type`（`SPACE`、`EOL_SURE_SPACE`、`LINE_BREAK` など）。なければ null |

- `text` 列には `fullTextAnnotation.text`（全文）をそのまま入れる
- 保存しないもの: symbol ごとの矩形と確信度（語より細かい単位は使わない）、page／block／paragraph の矩形（語の矩形の和で復元できる）、`textAnnotations`（同じ情報の別の形）。生の応答をそのまま保存する案は、symbol の分で 4〜5 倍の大きさになる（1 枚 60 KB、1 本 1.8 MB の見込み）ので採らない。切り詰めた形で 1 枚 10〜15 KB、1 本 300〜450 KB、18 本で 8 MB 以内（未確認。段階 0 で実測）
- 送った画像の大きさは解析の行の `image_width`、`image_height` に持つ（矩形を比率に直すため）
- 1 枚の結果は 1 要求の応答から切り出し、他のフレームと混ぜない

**行の復元**（`frameLines(frame, imageHeight)`）: 同じ `(b, p)` の語を順に連結して段落にし、`br` が `LINE_BREAK` か `EOL_SURE_SPACE` の語の後で行に分ける（2 行のテロップは 2 行になる）。`SPACE` は空白 1 つで連結し、それ以外は空白なしで連結する（日本語の語は空白なし）。行ごとに次を持つ。

- `text`: 連結した文字（表示用）
- `norm`: `normalizeText(text)` = NFKC 正規化 → 空白（全角を含む）をすべて除く → ASCII を小文字にする。句読点や記号は残す
- `box`: 行の語の矩形の和（`x0`、`y0`、`x1`、`y1`）
- `confidence`: 語の確信度の平均
- `charHeight`: 語の高さ（`y1 − y0`）の中央値
- `lang`: 語の言語の最頻値（null を除く）

**前処理**: `norm` が空の行と、`confidence < 0.5` の行は区間化に使わない（Q3。動作確認ではテロップが 0.96〜1.00、背景の文字が多いフレームでも 0.67〜0.91 だったので、0.5 で落ちるのは読み損ないの断片）。

### 4.2 区間にまとめる規則

`segmentFrames(frames, { durationMs, imageHeight, params })`。フレームを時刻順に処理し、「開いている区間」の一覧を持つ。

1. フレーム `k` の各行について、開いている区間のうち、最後に見えたフレームの時刻が `maxGapMs = 2,100 ms` 以内（1,000 ms 間隔で 1 枚の見落としまで許す）のものから、次の両方を満たす区間を探す
   - **文字が同じ**: 一方の `norm` が他方を含み、短い方の長さ ÷ 長い方の長さ ≥ 0.5（看板と重なって一部が欠けた例「から徒歩4分」⊂「溝口から徒歩4分」= 6/8 に対応）。または `1 − 編集距離(a, b) ÷ max(|a|, |b|) ≥ 0.7`（1〜2 文字の読み違いに対応）
   - **位置が近い**: 行の矩形の中心 y と区間の中心 y（これまでの観測の平均）の差が画像の高さの 15% 以内。横の重なりは求めない（背景の看板はカメラの動きで横に動く）
2. 候補が複数なら、文字の一致（包含を優先、次に編集距離の比率）が高いもの、同じなら中心 y が近いもの。1 つの行は 1 つの区間にだけ、1 つの区間は 1 フレームで 1 つの行にだけ結び付ける
3. 結び付いたら観測を足す。結び付かなければ新しい区間を開く
4. `maxGapMs` を超えて見えない区間は閉じる
5. 最後に次の雑音を捨てる
   - 観測が 1 フレームだけで、その行の矩形が「同じフレームで観測を足した区間の矩形（観測の平均）」と、自分の面積の 50% 以上重なるもの（看板と重なって割れた断片「MU溝」。本体の区間「溝口から徒歩4分」は前後のフレームで続いている）
   - 観測が 1 フレームだけで、`norm` が 2 文字以下のもの

区間の値:

| 値 | 定義 |
|---|---|
| `text` | 観測の `text` の最頻値。同数なら長いもの |
| `text_norm` | `text` の `normalizeText` |
| `start_ms` | 最初の観測のフレームの時刻 |
| `end_ms` | 最後の観測の次に計画したフレームの時刻（最初に見えなくなったフレーム）。次がなければ `duration_ms`。常に `end_ms > start_ms` |
| `frame_count` | 観測の数 |
| `confidence` | 観測の確信度の平均 |
| `lang` | 観測の言語の最頻値 |

並びは `start_ms`、同じなら中心 y の順で、`seq` を 1 から付ける。開始と終了の精度は取り出した間隔（±1 秒。カット直後は 100 ms）で、要件 5.3 章の「表示開始ミリ秒」「表示終了ミリ秒」はこの精度の値（画面のヒントに書く）。

### 4.3 位置、大きさ、テロップらしさ

| 値 | 定義 |
|---|---|
| `center_x_ratio`、`center_y_ratio` | 観測の矩形の中心の平均 ÷ 画像の幅、高さ（小数 4 桁） |
| `position` | `center_y_ratio < 1/3` なら `top`、`< 2/3` なら `middle`、それ以外は `bottom`（要件 F-VID-23 の「上・中・下」） |
| `char_height_ratio` | 観測の `charHeight` の中央値 ÷ 画像の高さ（要件 F-VID-23 の「画面に占める文字の大きさ」） |
| `is_caption_like` | `char_height_ratio ≥ 0.025`（1920 px で 48 px 以上）かつ `|center_x_ratio − 0.5| ≤ 0.2`（横に中央寄り）かつ `frame_count ≥ 2` |

テロップらしさの基準は、動作確認の「白い文字に黒い縁取り、上から 1/3 あたり、1 行 4〜12 文字」から置いた仮の値。文字の高さの実測はしていない（未確認。段階 0 で `.local/ocr-check` の結果から測り、Q3 で決める）。縦書きのポスターの文字は行の高さが大きく出るので、`is_caption_like` が真になりうる（横幅 ÷ 高さが 1 未満の行を除く条件を段階 0 で検討する）。

### 4.4 特徴量の定義

`summarizeSegments(segments, frames, durationMs)`。要件 5.3 章の 4 つと、「背景を含めた文字の情報量」のための 3 つ、テロップだけの 4 つ。

| 列 | 定義 | 値がないとき |
|---|---|---|
| `first_text_ms` | 区間の `start_ms` の最小 | 区間がなければ null |
| `has_text_in_first_3s` | `start_ms < 3000` の区間があるか（`cuts_in_first_3s` と同じ境界。3000 ちょうどは含めない） | 区間がなければ false |
| `text_coverage_ratio` | 区間の `[start_ms, end_ms)` の和集合の長さ ÷ `duration_ms`（重なりは 1 回だけ数える）。小数 4 桁 | 区間がなければ 0。`duration_ms` が 0 なら null |
| `total_text_chars` | `text_norm` が同じ区間を 1 つに数え（「重複を除く」の定義）、`text_norm` の文字数の合計（空白を除いた文字数） | 区間がなければ 0 |
| `segment_count` | 区間の数 | 0 |
| `max_chars_per_frame` | フレームごとの「前処理を通った行の `norm` の文字数の合計」の最大（一度に目に入る文字の量） | 0 |
| `avg_chars_per_frame` | 同じ値の全フレーム（文字のないフレームを 0 として）の平均。小数 2 桁 | 0 |
| `caption_first_text_ms`、`caption_has_text_in_first_3s`、`caption_coverage_ratio`、`caption_total_chars` | `is_caption_like` の区間だけで上の 4 つと同じ定義 | 同上 |

- 主にするのは全部の文字から計算する値（ユーザーの決定: 背景の文字も情報として扱う）。`caption_*` は保存し、投稿詳細に出す。リール分析の要因に入れるかは Q7
- `text_coverage_ratio` は 1 を超えない（和集合なので）。`cuts` と同じく、`success` 以外の行では全部 null

---

## 5. DB

### 5.1 マイグレーション（手書き。`supabase/migrations/20261012000000_r4_1_video_text.sql`）

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
  duration_ms integer,
  image_width integer,
  image_height integer,
  planned_frame_count integer,
  ocr_frame_count integer not null default 0,
  units_used integer not null default 0,
  first_text_ms integer,
  has_text_in_first_3s boolean,
  text_coverage_ratio numeric(5, 4),
  total_text_chars integer,
  segment_count integer,
  max_chars_per_frame integer,
  avg_chars_per_frame numeric(8, 2),
  caption_first_text_ms integer,
  caption_has_text_in_first_3s boolean,
  caption_coverage_ratio numeric(5, 4),
  caption_total_chars integer,
  unique (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version)
);

create table public.video_text_frames (
  analysis_id bigint not null references public.video_text_analyses (id) on delete cascade,
  at_ms integer not null check (at_ms >= 0),
  source text not null check (source in ('interval', 'cut')),
  text text,
  words jsonb,
  word_count integer,
  error_code integer,
  fetched_at timestamptz not null,
  primary key (analysis_id, at_ms)
);

create table public.video_text_segments (
  analysis_id bigint not null references public.video_text_analyses (id) on delete cascade,
  seq integer not null,
  text text not null,
  text_norm text not null,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  position text not null check (position in ('top', 'middle', 'bottom')),
  center_x_ratio numeric(5, 4),
  center_y_ratio numeric(5, 4),
  char_height_ratio numeric(5, 4),
  confidence numeric(5, 4),
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
  duration_ms integer,
  image_count integer not null check (image_count > 0),
  units integer not null check (units >= 0),
  request_bytes integer,
  response_bytes integer,
  word_count integer,
  http_status integer,
  ok boolean not null
);
create index ocr_usage_account_month_idx on public.ocr_usage (account_id, requested_at);
```

- `video_text_analyses`: 1 本 × OCR の条件で 1 行。`units_used` はこの行に使ったユニットの累計（再試行の分を含む。参考値。正はいつも `ocr_usage`）。`planned_frame_count` は計画した枚数、`ocr_frame_count` は結果のある枚数。`error` 列は固定文言か `mask` 済み（R1 と同じ）。画面のクエリは `error` を select しない
- `video_text_frames`: 1 フレーム 1 行。`error_code` が入っている行は読み取りに失敗したフレーム（次の回に送り直す）。`words` は 4.1 節の形
- `video_text_segments`: 1 区間 1 行。`text` は表示用、`text_norm` は検索と重複除去用。検索は `ilike`（数十〜数百行。索引は要らない）
- `ocr_usage`: 1 要求 1 行（要件 5.1 章）。投稿や解析の行を消しても残す（`on delete set null`。費用の記録は消さない）。`account_id` は `media` を経由せずに持つ（投稿が消えても月の合計を出せる）。月の集計はこの表の `requested_at` から（3.3 節）
- 既存の `video_analyses` と `video_cuts` は変えない
- 4 つの表すべてで `enable row level security`

### 5.3 今の条件を返す関数

```sql
create or replace function public.current_video_text_condition(
  out ocr_method text, out ocr_version text, out frame_interval_ms integer,
  out analyzer_version text, out segmenter_version text)
language sql immutable parallel safe
as $$ select 'google_vision'::text, 'v1/DOCUMENT_TEXT_DETECTION'::text, 1000, '1'::text, '1'::text $$;
revoke execute on function public.current_video_text_condition() from public;
grant execute on function public.current_video_text_condition() to web_app;
```

ワーカーの定数（`OCR_METHOD`、`OCR_VERSION`、`FRAME_INTERVAL_MS`、`TEXT_ANALYZER_VERSION`、`SEGMENTER_VERSION`）と一致することを結合テストで突き合わせる。どれかを変えるたびに、この関数を新しいマイグレーションで作り直す（決めた記録にもなる。R4 5.1 節と同じ）。

### 5.4 ビュー

1. **`media_video_features` に列を足す**（`create or replace view`。既存の列は名前、型、順を変えず、末尾に足す）。今の条件の 1 行だけをつなぐ（5 つすべてが一致。`segmenter_version` が古い行は「まだ」扱いになり、次の回に計算し直されるまで null）

   ```sql
   -- from 句に足す
   cross join public.current_video_text_condition() t
   left join public.video_text_analyses vt
     on vt.media_id = m.id
    and vt.ocr_method = t.ocr_method and vt.ocr_version = t.ocr_version
    and vt.frame_interval_ms = t.frame_interval_ms and vt.analyzer_version = t.analyzer_version
    and vt.segmenter_version = t.segmenter_version
   -- select の末尾に足す
   vt.id as text_analysis_id, vt.status as text_status, vt.attempt_count as text_attempt_count, vt.analyzed_at as text_analyzed_at,
   vt.first_text_ms, vt.has_text_in_first_3s, vt.text_coverage_ratio, vt.total_text_chars,
   vt.segment_count, vt.max_chars_per_frame, vt.avg_chars_per_frame,
   vt.caption_first_text_ms, vt.caption_has_text_in_first_3s, vt.caption_coverage_ratio, vt.caption_total_chars
   ```

   `text_status` が null は「まだ読んでいない」。`success` 以外の行では特徴量は null。`analysis_status`（カット）が `success` でない投稿は対象にならないので `text_status` も null

2. **`media_analysis_dataset` に列を足す**（末尾。R4 と同じ制約）: `ocr_method`、`ocr_version`、`frame_interval_ms`、`first_text_ms`、`has_text_in_first_3s`、`text_coverage_ratio`、`total_text_chars`、`segment_count`。動画の特徴量と同じく「最新の `success`（条件をまたぐ）」を `left join lateral … order by analyzed_at desc limit 1` で取る（分析用。条件の列があるので分けられる）

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
   group by account_id, 2;
   ```

   `month_utc` は UTC の月の初日（3.3 節の月の境目と同じ定義）。単価は持たない（画面の定数で掛ける）

### 5.5 権限

R2 の決まりどおり。

```sql
grant select on table public.video_text_analyses, public.video_text_frames, public.video_text_segments, public.ocr_usage to web_app;
create policy web_app_select on public.video_text_analyses for select to web_app using (true);
create policy web_app_select on public.video_text_frames for select to web_app using (true);
create policy web_app_select on public.video_text_segments for select to web_app using (true);
create policy web_app_select on public.ocr_usage for select to web_app using (true);
revoke all on table public.ocr_monthly_usage from public, anon, authenticated;
grant select on table public.ocr_monthly_usage to web_app;
```

- `media_video_features` と `media_analysis_dataset` の grant は `create or replace` で残る
- `video_text_frames` の `words` は画面で使わないが、将来の計算し直しの確認用に `web_app` でも読めるようにしておく（読み取りだけ。書くのはワーカー）
- `web-role.test.ts` の関数とビューの棚卸しに `current_video_text_condition()` と `ocr_monthly_usage` を足す

### 5.6 ロールバック（末尾のコメントに書く。順番が大事）

```sql
-- 1. 先にワーカーを R4.1 より前の版に戻し、hourly から video_text を外す
-- drop view if exists public.ocr_monthly_usage;
-- -- media_video_features と media_analysis_dataset は足した列を create or replace で消せないので、
-- -- drop して 20261007000000_r4_video.sql の定義で作り直し、comment と grant をやり直す
-- drop function if exists public.current_video_text_condition();
-- drop table if exists public.ocr_usage;
-- drop table if exists public.video_text_segments;
-- drop table if exists public.video_text_frames;
-- drop table if exists public.video_text_analyses;
-- delete from supabase_migrations.schema_migrations where version = '20261012000000';
```

`ocr_usage` を消すと利用記録（費用の根拠）が消える。戻すときは先に `copy` で `.local/` に退避する。

---

## 6. 画面

デザインは `doc/design-system.md` に従い、既存の部品を使う。グラフは R3、R4 と同じく自作の SVG（Server Component。値は `<title>` と `aria-label`。吹き出しは作らない）。読み取った文字は自分の投稿の内容なので画面に出してよいが、ログには出さない。

### 6.1 投稿詳細（`/media/[id]`）

「カットのタイムライン」のカード（`CutTimelineCard`）に足す。カードの題名は変えない（要件の画面名「タイムライン」）。

- **上段の数字**: 既存の 6 つの下に 2 段目として「最初の文字まで（秒）」「冒頭 3 秒の文字（あり／なし）」「文字の表示割合（%）」「総文字数」を置く（`FACTORS` に 4 つを足し、`TOP_FACTORS` に並べる。`metrics-row` の自動の折り返しで 2 段になる）。値はビューの列をそのまま使い、画面で計算し直さない。ヒントは「文字 = 画面に表示された文字（テロップと背景の看板などを含む）。開始と終了の精度は約 1 秒」
- **テロップらしい文字の数字**: 「テロップらしい文字」の 4 つ（`caption_*`）は、上段には出さず、下の区間の表の末尾に「うちテロップらしい区間: n（総文字数 m）」と 1 行で出す（Q7。見た目を増やさない）
- **タイムライン**（`CutTimeline`）: `TimelineModel` に `texts: TextSpan[]`（`start`、`end`、`text`、`position`、`captionLike`）を足す。シーンの帯の下に `top`／`middle`／`bottom` の 3 本の段（各 14 px）を置き、区間を `rect` で描く。文字は帯の中に出し、幅に入らない分は文字数で切って「…」を付ける（SVG に自動の省略はない。文字数は帯の幅 ÷ 1 文字 11 px で決める）。全文は `<title>` と `aria-label` に持つ。テロップらしい区間は濃く（`.85`）、それ以外は薄く（`.45`。R4 のシーンの濃淡と同じ値）。`aria-label` に「文字の区間 n 本」を足す。高さは 52 から約 100 になる。スマートフォン（幅 340）では帯の文字を出さず、下の表で読む
- **区間の表**: SVG の下に表「文字の区間」（開始〜終了（秒、小数 1 桁）、文字、位置（上・中・下）、確信度（%）、テロップらしさ（印））。並びは `seq`。区間が 0 本なら「文字は読み取れませんでした」の 1 行（新しい文言はこの 1 つ。`MissingReason` の文言は使わない。「文字がない」は欠損ではなく結果）
- **状態**: カットの解析がない・失敗のときは R4 6.1 節のまま（文字の部分も出さない）。カットが `success` で文字の状態が次のとき

| `text_status` | `MissingReason` | 表示 |
|---|---|---|
| null（まだ読んでいない） | `not_yet` | 数字は「—」、段と表は出さない |
| `no_video_url`、`failed`（打ち切りを含む） | `missing` | 「取得できなかった」 |
| `success` | — | 数字、段、表 |

- **クエリ**（`getVideoFeatures`）: `media_video_features` の文字の列を足し、`text_segments` を `coalesce((select json_agg(json_build_object(...) order by s.seq) from public.video_text_segments s where s.analysis_id = f.text_analysis_id and f.text_status = 'success'), '[]')` で同じ 1 行に載せる（カットの `cut_times_ms` と同じ形）。`error` 列は読まない。`words` は読まない

### 6.2 リール分析（`/reels`）

R4 設計 6.2 節の形に、文字の要因を足す（見本 design-lab v3 の `S.reels` にあった文字の要因を戻す）。

| カード | 足すもの |
|---|---|
| 要因との関係 | 要因に「最初の文字まで（秒）」「文字の表示割合」「総文字数」の 3 つ（7 → 10）。`FACTORS` に `first_text`（`first_text_ms / 1000`、`scatter: true`）、`text_coverage`（比率。表示は %）、`total_text_chars`（文字）を足す。`first_text` は文字のない動画で null（`first_cut` と同じ扱い。その要因の n から除く） |
| 上位と下位 | 要因の中央値の表に 3 つと「冒頭 3 秒の文字がある割合」を足す（冒頭 3 秒の画面変化の「1 回以上の割合」と同じ形） |
| 散布図 | 3 枚を足す（6 → 9。スマートフォンは 2 列のまま） |
| 区分 | 「冒頭 3 秒の文字（なし／あり）」の区分を足す（2 区分の棒。3 件未満は薄く）。F-VID-31 の例「冒頭 3 秒に文字があるリールはスキップ率が低いか」に答える形 |
| 一覧 | 列に「冒頭 3 秒の文字」「文字の表示割合」「総文字数」を足す。並べ替えのキーも足す。スマートフォンで隠す列（`hide-m`）に「文字の表示割合」を足す |

- **目的変数 `y`**: 「スキップ率」を選択肢に足す（Q8）。R4 で視聴維持率を除いた理由（分母が動画の長さ）はスキップ率には当たらない。選択肢の文言は「スキップ率（n 件）」。ヒントに「スキップ率は低いほどよい（上位と下位は値の大小のまま）」を足す。既定はリーチ率のまま
- **母集団**: 文字の要因は「今の条件で文字の解析が `success` のリール」。カットは `success` だが文字がまだのリールは、文字の要因の n から除く（R4 の「要因ごとに null を除く」と同じ規則。新しい文言は足さない）
- データの状況で比べ方を変えない（指標と比較対象は固定。経過日数などの前提は表示して委ねる）

### 6.3 文字で探す

F-VID-32。`/reels` の一覧の上にカード「文字で探す」を置く（Q9。文字があるのは動画だけで、投稿一覧 `/media` は変えない。R4 6.3 節と同じ）。

- 入力は `<form method="get">` の 1 欄（検索パラメータ `q`。1〜100 文字。空や不正は無視して既定の画面）。`y`、`sort`、`dir` は保つ
- 検索は `video_text_segments.text_norm` に対する `ilike`。問い合わせ側は SQL で `regexp_replace(normalize($q, NFKC), '\s', '', 'g')` で整え（Postgres の `normalize()`。UTF8 の DB で使える。未確認: Supabase の Postgres で `normalize` が有効なこと。段階 1 で確かめる）、`%`、`_`、`\` はエスケープして `'%' || … || '%'` にする。ワーカーの `normalizeText` と同じ結果になることを結合テストで突き合わせる（`ilike` が大文字小文字を吸収するので、小文字化の差は効かない）
- 対象は自分のアカウントのリールとフィード動画の、今の条件で `success` の区間（`media_video_features.text_analysis_id` 経由）。期間は限らない
- 結果: 一致した投稿の一覧（サムネイル、題名、投稿日、一致した区間の文字と開始秒を 3 つまで）。投稿詳細へのリンク。0 件は「一致する文字がありません」。入力が空ならカードは入力欄だけ
- 一覧のほかのカード（要因、散布図、区分、一覧）は `q` で絞らない（比べ方を検索で変えない）
- クエリは `lib/queries/reels.ts`（R4 で作った場所）に `searchTextSegments(accountId, q)` を足す

### 6.4 収集ログ（`/jobs`）の「AI・OCR の利用状況」

要件 9 章。`/jobs` にカード「AI・OCR の利用状況」を足す（`ocr_monthly_usage` を読む `lib/queries/ocr-usage.ts`）。

- **今月（UTC）**: ユニット（`units`）／無料枠 1,000（画面の定数 `VISION_FREE_UNITS_PER_MONTH`）、残り、処理した本数、要求数、失敗した要求数。残りが 100 未満なら `Callout`（`warn`）で「無料枠の残りが少ない」
- **月ごとの表**: 直近 12 か月（`month_utc` の降順）。月（`2026-10（UTC）`）、要求、画像、ユニット、本数、推定費用。推定費用 = `max(units − 1,000, 0) ÷ 1,000 × $1.50`（画面の定数 `VISION_USD_PER_1000_UNITS`。料金の改定で変える）。表の下に「推定。請求は Google Cloud の明細で確かめる。手動の確認（`scripts/ocr-check.mjs`）の分は含まない」
- ワーカーの上限（3.3 節の環境変数）は画面に出さない（画面はワーカーの設定を知らない。無料枠の 1,000 だけを基準に出す）
- 利用が 0 件なら「まだ利用がありません」（R3 の空の状態の決まり）
- `/jobs` は既にジョブの表を持つので、カードはその下に置く。`video_text` の行はほかのジョブと同じ形で出る（`items_fetched` は成功した本数）

---

## 7. セキュリティと公開ログ

| 項目 | 決まり |
|---|---|
| 鍵 | 3.8 節。Secret は収集のステップの `env` にだけ渡す。ワーカーは `config.ts` でだけ読む。値、`private_key`、アクセストークンをログ、例外、`recordFailure`、DB、生の応答に入れない。`check-env` は有無だけ |
| 宛先 | `images:annotate` とトークンの URL はコードの定数。鍵の `token_uri` が定数と違えば使わない。`fetch` の宛先を環境変数や DB の値から作らない |
| 送るデータ | 自分の投稿のフレームだけ（`media_url` は Graph API から取り直し、`downloadToFile` のホストの許可一覧を通る）。送るのは JPEG の内容だけで、`media_id`、キャプション、ファイル名を要求に入れない。フレームには人の顔が写りうる。Google は送った画像を学習に使わず、数時間以内に消す（AI-07。11 章） |
| 残さないもの | 動画とフレームは `mkdtemp` の一時ディレクトリに置き、`finally` で消す（NF-CAP-03）。DB に画像は入れない |
| ログ | `media_id`、URL、鍵、トークン、読み取った文字、Vision の `error.message` を出さない。件数、固定文言、HTTP の status だけ（3.7 節）。GitHub Actions の公開ログに出る前提で書く |
| 生の応答 | Vision の応答は `raw` の表に入れない（`graph-client.ts` の保存は Graph API だけ）。保存先は `video_text_frames`（4.1 節の切り詰めた形） |
| 例外 | R1 10.5 章の規約（`console.error(error)` と `String(error)` の禁止、`sanitizeForLog(error.message)` だけ、`error.cause` などを参照しない）。`fetch` の失敗の `cause` には URL が入りうるので見ない |
| 入力の検査 | 候補の `media_id` は `isMediaId`。`at_ms` は整数で 0 以上 `duration_ms` 以下。ffmpeg の引数に動画の中身の値を入れない（時刻は数値から作る）。Vision の応答は JSON として形を確かめてから使う（`words` の各値の型） |
| 画面 | `q` は長さを制限し、`ilike` のエスケープ。読み取った文字は本人のデータとして表示する（他人の投稿は扱わない）。`/reels` はサムネイルの署名付き URL を含むので `Cache-Control: private, no-store` のまま |
| 費用の歯止め | 3.2 節（1 回のユニット）、3.3 節（月のユニットと本数）、長さの上限、失敗した要求もユニットに数える、`check-alerts` の通知。コードの外では Google Cloud の予算アラート（推奨。3.8 節） |
| 手元とのすれ違い | 手元の Docker のワーカーと GitHub Actions が同時に動くと同じ本を 2 回読んでユニットを 2 倍使う。R2 から手元のワーカーは止めている（`COLLECT_ENABLED=false`）。手元で動かすときはこの設定を確かめる（R4 3.6 節と同じ） |

---

## 8. テスト

R4 設計 7 章にならう。Vision は偽の `fetch` で差し替え、本物の API はテストで呼ばない（ユニットを使わない）。

| 区分 | 内容 |
|---|---|
| 単体（worker、純粋関数） | `frameTimes`（0 を含む、カット直後の優先、300 ms の重ね方、`duration_ms` ちょうど、カット 0 回、カットが `duration_ms` の直前）。`normalizeText`（NFKC の全角英数、全角空白、大文字）。`frameLines`（段落と行の分け方、`SPACE` と `LINE_BREAK`、座標の省略、`fullTextAnnotation` なし）。`segmentFrames`（同じ文字が続く、1 枚の見落とし、包含の例「から徒歩4分」、編集距離の例、位置が違えば別の区間、断片「MU溝」の除去、1 フレーム 2 文字以下の除去、`end_ms` が次のフレームと `duration_ms`、入力の順を変えても同じ結果、空の入力）。`summarizeSegments`（和集合の表示割合、重複除去の総文字数、`start_ms = 3000` ちょうど、区間なし、`duration_ms` 0、`caption_*`）。`createServiceAccountJwt`（固定の鍵と時刻で署名が検証できる、`exp`）。`splitRequests`（8 枚、6 MB の手前で切る、1 枚で超える）。`parseAnnotateResponse`（枚数の不一致、1 枚ごとの `error`、文字なし、型の不正） |
| 単体（worker、ジョブ） | `createVideoTextJob` に偽の `fetch`、ffmpeg、DB を渡す。鍵がない・ffmpeg がない回は行を書かず `attempt_count` が増えない。本数、時間、1 回のユニット、月のユニット、月の本数の各上限で次の回に回す（境界の値）。区間化だけやり直す本はユニット 0 で上限の判定をしない。足りないフレームだけ送る（保存済み、`error_code` の行、0 枚なら送らない）。401／403 で行を書かず終わる、429 の再送と打ち切り、5xx で `failed` と 2 本続けて止まる、400 で `failed`、1 枚ごとの `error` で `failed` とフレームの保存。`ocr_usage` が失敗した要求にも書かれ、解析の書き込みの失敗で消えない。打ち切りの `warn` が 1 回だけ。ログに `media_id`、URL、鍵、トークン、文字がない。`media_url` の取り直しの各場合（R4 と同じ） |
| 結合（worker と DB） | `listVideoTextCandidates`（カットの条件、`success` のみ、長さの上限、`gone_at`、3 時間、打ち切り、`segmenter_version` の違い、新しい順）。`writeVideoTextAnalysis`（upsert と `attempt_count`、フレームの差し替え、区間の入れ直し、1 トランザクション）。`monthlyOcrUsage`（UTC の月の境目、`media_id` が null の行、`count(distinct)`）。ワーカーの定数と `current_video_text_condition()` の一致。`normalizeText` と SQL の `normalize(…, NFKC)` の一致。`extractFrameArgs` で実際の ffmpeg が色の切り替え動画（`generateColorTestVideo`）から指定の時刻の色のフレームを出す（`test/ffmpeg-real.test.ts`） |
| DB | `media_video_features` の文字の列が今の条件（5 つ）の行だけを使う（`segmenter_version` が古い行は null）。`ocr_monthly_usage` の月の境目と失敗の数。`web_app` で 4 表とビューを読め、anon と authenticated では読めない。関数とビューの棚卸し（`web-role.test.ts`）。ロールバックの順 |
| `check-alerts` | `evaluateAlerts` の `ocr_monthly_cap`（ユニットと本数の境界、`daily` だけ、上限 0 の扱い） |
| 画面 | `FACTORS` の 3 つ（null の除き方、単位）。区分「冒頭 3 秒の文字」。`y` にスキップ率（不正値で既定、件数の文言）。タイムラインの文字の段（3 段、省略の文字数、0 本、`captionLike` の濃淡、スマートフォンで文字を出さない）。区間の表（0 本の文言）。`text_status` から `MissingReason` への対応。検索（`q` の長さ、エスケープ、空、0 件、`y`／`sort`／`dir` を保つ）。利用状況（0 件、残りが 100 未満の `Callout`、推定費用の式、12 か月）。既存の R4 の画面のテストがそのまま通る |
| 実機 | 段階 0 の計測（下）。本番で既存の 18 本すべてに結果か理由が入り、月のユニットが 1,000 以内（完了条件）。数本について読み取った文字と表示時刻を目視と比べ、結果を検討メモ 6.2 節に書く。スマートフォン幅の見た目はユーザーの確認 |

---

## 9. 段階

| 段階 | 内容 | 担当の案 |
|---|---|---|
| 0 | 計測と確認（ユニット 100 以内）: 本番のリールの本数とフィード動画の本数、`video_analysis` が `success` の本数。手元で 1 本について、`extractFrameArgs` の 1 枚あたりの時間、JPEG（幅 1080、品質 4）の大きさ、8 枚の要求の往復時間を計る。`.local/ocr-check` の結果からテロップの文字の高さの比と中心 x を測り、4.3 節のしきい値を決める。`words` の切り詰めた形の 1 枚の大きさ。Supabase の `normalize()` の有無。鍵の JSON の `token_uri` | 親とユーザー |
| 1 | マイグレーション（5 章）、`config.ts`、`current_video_text_condition()`、権限、DB のテスト | `node-worker-developer`。SQL は `postgres-sql-reviewer` がレビュー |
| 2 | ワーカー（3 章、4 章）: `lib/video-text.ts`、`lib/vision-client.ts`、`db/video-text.ts`、`jobs/video-text.ts`、`extractFrameArgs`、`check-alerts`、hourly への登録、テスト。手元で 2〜3 本を処理して区間を目視 | `node-worker-developer`。`security-engineer` が 7 章の観点でレビュー |
| 3 | 画面（6 章）: 投稿詳細、リール分析、文字で探す、利用状況 | `nextjs-developer` |
| 4 | 本番に反映: Secret を登録 → `db push` → main にマージ → `collect.yml` の次の回から既存の 18 本が 4 回（5 本 × 4 時間）で処理されることを `/jobs` の利用状況で確かめる。最初の回の結果（5 本）を投稿詳細で見てから残りを流す（問題があれば GitHub の変数 `WORKER_VIDEO_TEXT_MAX_PER_RUN` を 0 にして止める。3.2 節） | 親とユーザー |
| 5 | 目視の確認（数本の文字と表示時刻）、しきい値の調整（`segmenter_version` を上げる。ユニットを使わない）、テストの不足、セキュリティレビュー、検討メモ 6.2 節への記録 | `quality-engineer`、`security-engineer`、ユーザー |

段階 1〜2 と段階 3 は並べて進められる（画面は手元の Supabase の結果で作る。手元の処理には鍵が要るので、段階 3 の担当には段階 2 で手元に作った結果を使ってもらう）。本番への反映は `db push` → main へのマージの順（R4 と同じ。ビューに列を足すだけなので、古い画面は新しい DB でも動く）。

---

## 10. 確認事項

| # | 問い | 推奨 |
|---|---|---|
| Q1 | フレームの間隔（3.4 節）: 1,000 ms か 500 ms か | 1,000 ms。500 ms は一括処理だけで無料枠をほぼ使い切る。テロップは 1 秒以上出続けるので区間の精度は足りる。足りなければ `frame_interval_ms` を変えて再処理（ユニットを使う） |
| Q2 | 類似フレームの間引き（要件 8.7.3 章末尾）を版 0.1 で行うか | 行わない。無料枠に収まる間は複雑さに見合わない。月の利用が 700 を超える見込みになったら `analyzer_version` 2 で `mpdecimate` を試す |
| Q3 | 区間化のしきい値（確信度 0.5、包含 0.5、編集距離の比率 0.7、位置 15%、見落とし 2,100 ms、1 フレーム 2 文字以下を捨てる）とテロップらしさ（高さ 2.5%、中央 ±20%、2 フレーム以上） | 設計の値で始め、段階 0 の実測と段階 5 の目視で調整する。調整は `segmenter_version` を上げるだけでユニットを使わない |
| Q4 | 月の境目（UTC か JST か）と上限の既定（ユニット 1,000、本数 30） | UTC、1,000、30。手動の確認の分（2026-10 は 93 ＋ 段階 0 の 100 以内）を見込んでも 10 月は 750 以内に収まる。余裕を持たせたいなら GitHub の変数で 900 にする（コードは変えない） |
| Q5 | JPEG の幅 1080（拡大しない）、品質 4、1 要求 8 枚、本文 6 MB | このまま。読み取りに実績のある大きさを保つ。ユニットは枚数で決まり、大きさでは変わらない |
| Q6 | 1 回 5 本、8 分、200 ユニット、打ち切り 5 回、長さの上限 3 分 | このまま。段階 0 の計測で見直す |
| Q7 | テロップだけの特徴量（`caption_*`）の扱い | 保存し、投稿詳細の区間の表に 1 行で出す。リール分析の要因には入れない（テロップらしさは推定で、全部の文字の指標を主にする決定に沿う）。目視でテロップらしさの判定が妥当と分かったら要因に足す |
| Q8 | リール分析の `y` にスキップ率を足す | 足す。F-VID-31 の例に答える。ヒントに「低いほどよい」を書き、上位と下位は値の大小のまま |
| Q9 | 文字で探すの置き場所 | `/reels` の一覧の上。`/media` は変えない |
| Q10 | 鍵の渡し方: Secret `GCP_VISION_KEY_JSON`（中身）、手元は `GCP_VISION_KEY_FILE`（パス） | このまま |
| Q11 | 月の上限の通知を `check-alerts --scope daily`（1 日 1 通）にする | このまま。`hourly` は月が替わるまで毎時のメールになる |
| Q12 | Vision の `parent`（処理地域 us／eu）を付けるか | 付けない（自動）。データの所在の要件はない。付けるなら `eu` |
| Q13 | 部分的に失敗した本は、保存したフレームを使い回して足りない分だけ送り直す（3.6 節） | このまま。ユニットの無駄を防ぐ。複雑さが気になるなら「失敗した本は全フレームを送り直す」に簡略化できる（最大 5 回 × 30 ユニット） |
| Q14 | `media_analysis_dataset` に文字の列を足す（R4 Q5 と同じ考え） | 足す |

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
- 料金: 月の最初の 1,000 ユニットは無料。以後 1,000 ユニットごとに $1.50（500 万ユニットまで）
- データの扱い: 送った画像を Cloud Vision の学習に使わない。解析のために短時間保存し、数時間以内に消す（Google の data-usage の FAQ）
- 認証: サービスアカウントの鍵（JSON。`client_email`、`private_key`、`token_uri`）から RS256 の JWT（scope `https://www.googleapis.com/auth/cloud-platform`、有効 1 時間）を作り、`token_uri` に `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` で送ってアクセストークンを得る。`node:crypto` だけで書ける（`scripts/ocr-check.mjs` で動作確認済み。新しい npm 依存は足さない方針。`@google-cloud/vision` 6.1.1 は Node 22 以上、google-gax に依存し大きい）
- IAM: Vision の画像の読み取りには IAM の権限の定義がなく、API を有効にしたプロジェクトのサービスアカウントならロールなしで呼べた（動作確認で確認）

**既存の仕組み（設計が従うもの）**

- `video_analysis` ジョブ（R4）は hourly グループの `media_snapshot` の次に動き、1 回 5 本・8 分の予算、`media_url` を Graph API で取り直し、動画を一時ディレクトリに落として ffmpeg で解析し、必ず消す。今の解析条件は DB の関数 `current_video_condition()` に持ち、画面のビューはその条件の行だけを使う。同じ条件では再処理しない。`attempt_count` で打ち切る。ログに `media_id` も URL も出さない（公開ログ）。環境変数は `apps/worker/src/config.ts` の `integerInRange(env, "WORKER_VIDEO_MAX_PER_RUN", 既定, 下限, 上限)` の形で読む
- ffmpeg の呼び出しは `apps/worker/src/lib/ffmpeg.ts` の `runOrThrow(tool, args, timeoutMs)` を使う（`resizeImageArgs(input, output, width)` は `scale=<width>:-2 -frames:v 1 -q:v 4` で 1 枚を JPEG に書く。フレームの連番出力は新しい引数の関数を足す）
- GitHub Actions（`collect.yml`）の Secrets は必要なステップの `env` にだけ渡す。鍵の JSON は Secret として渡し、ワーカーは `env` から読んで値をログに出さない。手元では `.env` に置く（`.local/gcp-vision-key.json` のパスを指す形でもよい）
- `check-alerts` コマンド（R2 設計 5.2 章）は人が見るべき状態なら終了コード 1 で GitHub の失敗メールになる。月の上限に達したことの通知はここに条件を足す
- 要件 5.3 章の保存項目: `text_segments`（文字、表示開始 ms、表示終了 ms、位置、確信度）、`first_text_ms`、`has_text_in_first_3s`、`text_coverage_ratio`、`total_text_chars`、`ocr_method`／`ocr_version`／`frame_interval_ms`。5.1 章の「AI・OCR の利用記録」（処理した対象、方式、モデル名、入出力の量、費用、処理時刻）。9 章の「AI・OCR の利用状況」画面（月ごとの処理件数と費用）。AI-03: AI の出力はデータとして保存して使い回す（同じ入力を同じ条件で二度処理しない）
- 要件 F-VID-21: フレームは各カットの直後と一定間隔（例: 0.5 秒ごと）。取り出したフレームは解析後に削除する。8.7.3 章末尾: 見た目がほぼ同じ連続フレームを除く、カット直後を優先し間隔は調整できるようにする

**起草時に確かめたこと（コードの `grep`。2026-10-11）**

- `JobContext` に `jobRunId: string` と `startedAt: Date` がある（`jobs/framework.ts`）。`recordFailure` の `errorClass` は `rate`／`auth`／`db`／`download`／`unknown` と項目の分類（`fatal`／`transient`）
- `job_runs.id` と `video_analyses.id` は `bigint`、`accounts.id` は `uuid`、`media.id` は `text`
- `web_app` のポリシーは `create policy web_app_select on … for select to web_app using (true)` の形（R2、R5）
- `check-alerts` は `--scope hourly|daily` を取り、判定は `jobs/alerts.ts` の `evaluateAlerts`（純関数）
- 最新のマイグレーションは `20261011000000_r2_dispatch_connect_timeout.sql`

**未確認（段階 0 で確かめる）**

- Google の無料枠の「月」が切り替わる時刻（時間帯）。失敗した要求（4xx／5xx）の課金の有無
- `extractFrameArgs`（`-ss` 前置き）の 1 枚あたりの時間、幅 1080・品質 4 の JPEG の大きさ、8 枚の要求の往復時間、切り詰めた `words` の 1 枚の大きさ
- テロップの文字の高さの比と中心 x（4.3 節のしきい値）
- Supabase の Postgres で `normalize(text, NFKC)` が使えること
- `scripts/ocr-check.mjs` が `languageHints` を付けていないこと
- リールの長さの上限（3 分）
- 手元の Docker compose で鍵のファイルをマウントする書き方

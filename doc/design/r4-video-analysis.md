# R4 動画分析（長さとカット）の設計

- 版: 0.3（2026-10-06）。確認事項（9 章）はすべて推奨どおりと回答を得た

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-06 | 起草（親のセッション） |
| 0.2 | 2026-10-06 | 4 本のレビュー（ワーカー、DB、画面、セキュリティ）の指摘を反映。今の解析条件を DB の関数に持たせ、画面のビューはその条件の行だけを使う（DB 高-1）。ビューの行を動画だけに絞り、状態は今の条件の行から取る（DB 高-2）。ffmpeg の有無をジョブの最初に 1 回だけ確かめ、ないときは行を書かない（ワーカー高 1）。ジョブの途中では止めず、本数と時間の予算で抑える（ワーカー高 2、3）。共通化は解析と書き込みだけ（ワーカー中 4、5）。対象は SQL 1 本で選ぶ。`media_url` の取り直しの失敗の扱いとログの決まり、ffmpeg の入力の制限（セキュリティ中 1〜5）。相関の計算できない場合、ブートストラップの再現、カードごとの母集団、スマートフォンの見せ方、検索パラメータ（画面高 1〜4、中 5〜13） |
| 0.3 | 2026-10-06 | 段階 0 の数を記録（リール 18 本、リーチ率のあるリール 0 本、ジョブの最長 23 秒）。確認事項 Q1〜Q7 はすべて推奨どおり（ユーザー） |

- 要件: `doc/requirements/requirements-definition.md` 3 章（R4）、4.5 章（F-VID-01〜14）、5.3 章、7.2 章、10 章（R4 の完了条件）
- 既存: R1 の動画解析（`supabase/migrations/20261001100200_r1_video.sql`、`apps/worker/src/lib/video-analysis.ts`、`lib/ffmpeg.ts`、`lib/download.ts`、`db/video.ts`、`jobs/stories.ts`）、R1 のビュー（`20261001100400_r1_views.sql` の `media_analysis_dataset`）、R2 の `web_app` ロール（`20261002005926_r2_web_role.sql`。`video_analyses` と `video_cuts` の select のポリシーは R2 で済み）、R3 のビューと画面（`20261005000000_r3_analysis_views.sql`、`doc/design/r3-analysis-screens.md`）
- デザイン: `doc/design-system.md`、`doc/design-lab/v3/render.js` の `S.reels`（リール分析）と `cutTimeline`（投稿詳細のタイムライン）

この文書で「未確認」と書いたものは、起草時に確かめられなかった事実。実装の前に確かめる。

---

## 1. 目的と範囲

### 1.1 R4 でやること

| 区分 | 内容 | 要件 |
|---|---|---|
| 収集 | リールとフィード動画を解析するジョブ `video_analysis` を毎時のグループに足す。新しい投稿も既存の投稿も同じジョブで順に解析する（まとめ解析の専用の仕組みは作らない） | F-VID-01〜06 |
| 調整 | シーン検出のしきい値を決めるための手元のコマンド `video-tune` | 10 章の完了条件 |
| DB | 今の解析条件を返す関数、再試行の打ち切りに使う列、画面用のビュー（動画の特徴量と視聴維持率） | F-VID-04、F-VID-11 |
| 画面 | 投稿詳細に動画の特徴量とカットのタイムライン。リール分析の画面（`/reels`）を新しく作る | F-VID-10〜14 |

### 1.2 R4 でやらないこと

- 画面の文字（OCR）。R4.1 で方式を比べてから行う。見本（design-lab v3）の文字の要因（最初の文字まで、冒頭 3 秒の文字、総文字数、文字の表示割合）とタイムラインの文字の区間は出さない
- カルーセルの中の動画。子のメディアの指標は API で取れず（R0）、特徴量を指標と結び付けられないため
- ストーリーズの解析の変更。R1 の `stories` ジョブのまま（ストーリーズは 24 時間で消えるので毎時のジョブの先頭で解析する）
- 動画やフレームの保存（NF-CAP-03）

---

## 2. R1 で済んでいるもの

| もの | 内容 |
|---|---|
| 表 | `video_analyses`（解析条件ごとに 1 行。`unique (media_id, analyzer_version, scene_threshold)`、状態 `success`／`no_video_url`／`failed`）と `video_cuts`（1 カット 1 行、ミリ秒、`scene_score numeric(5, 4)` は R1 では常に null） |
| 解析 | `analyzeVideo`（ダウンロード → ffprobe → シーン検出 → 特徴量。例外を投げない。`error` 列は固定文言か `mask` 済み。一時ディレクトリは `finally` で消す） |
| ダウンロード | `downloadToFile`（https のみ、ホストの後方一致で `cdninstagram.com` と `fbcdn.net` だけ、リダイレクトを拒む、大きさの上限、失敗時に消す、URL を例外に入れない） |
| 生の応答 | `graph-client.ts` が `media_url` の値を消してから保存する（139 行、166 行。レビューで確認） |
| 実行環境 | GitHub Actions の `collect.yml` が ffmpeg を apt で入れる（入らなくても収集は進む）。`concurrency` で Actions の実行は重ならない |
| ビュー | `media_analysis_dataset` が投稿ごとに最新の `success` の解析結果（条件をまたぐ）をつなぐ |
| 権限 | `web_app` は `video_analyses` と `video_cuts` を読める |

---

## 3. 収集: `video_analysis` ジョブ

### 3.1 対象と選び方

対象は次をすべて満たす投稿。選ぶのは `db/video.ts` に足す `listVideoAnalysisCandidates` の SQL 1 本で、再試行と打ち切りの判定もこの SQL に置く（TS の `isAnalysisRetryDue` と二重にしない）。

- `media_type = 'VIDEO'` かつ `media_product_type in ('REELS', 'FEED')`（リールとフィード動画）
- `gone_at` が null
- 今の条件（`ANALYZER_VERSION`、`DEFAULT_SCENE_THRESHOLD`）の行がない、または `status <> 'success'` かつ `attempt_count < 上限` かつ `analyzed_at <= now - 3 時間`

```sql
select m.id, m.posted_at
from public.media m
left join public.video_analyses va
  on va.media_id = m.id and va.analyzer_version = $2 and va.scene_threshold = $3
where m.account_id = $1
  and m.gone_at is null
  and m.media_type = 'VIDEO'
  and m.media_product_type in ('REELS', 'FEED')
  and (va.id is null
       or (va.status <> 'success'
           and va.attempt_count < $4
           and va.analyzed_at <= $5::timestamptz - make_interval(hours => $6)))
order by m.posted_at desc, m.id
```

- 全件を返し（数十本）、JS で先頭から解析する。残りの数を `skipped_by_limit` としてログに出す
- この結合には一意制約の索引 `(media_id, analyzer_version, scene_threshold)` が使われる。新しい索引は要らない
- `now` は `ctx.now()` を渡す（テストで時刻を固定するため。SQL の `now()` は使わない）

### 3.2 グループの中の位置と長さの抑え方

- hourly グループを `stories` → `media_sync` → `media_snapshot` → **`video_analysis`** → `account_backfill` にする。新しい投稿は `media_sync` の後なので同じ回に解析できる。指標の収集を先に済ませ、動画の遅れで指標を取りこぼさない
- ジョブの途中では止めない（`JobContext` に `signal` はなく、`groups.ts` はジョブとジョブの間でだけ止める作法。それに合わせる）。長さは次の 2 つで抑える
  - 本数の上限 `WORKER_VIDEO_MAX_PER_RUN`（既定 5）
  - 時間の予算 `WORKER_VIDEO_BUDGET_MS`（既定 8 分）。ジョブの開始からの経過が予算を超えていたら、新しい 1 本を始めない
- ffprobe とシーン検出の制限時間（今は `TOOL_TIMEOUT_MS` = 5 分。ストーリーズの最長 60 秒が前提）をリール用に見直す。ffprobe は 30 秒、シーン検出は `max(60 秒, 動画の長さ × 3)` で 5 分を上限にする（未確認。段階 1 の計測で決める）
- ffprobe の後、動画の長さが 15 分を超えていたらシーン検出をせず `failed`（固定文言）にする（リールの長さの上限より長いものは想定外の入力）
- 最悪の時間: 予算 8 分の直前に始めた 1 本（ダウンロード 60 秒 + ffprobe 30 秒 + 検出 5 分）で約 15 分。`collect.yml` の 30 分には、ほかに apt、daily（JST 05 時台）、stories などが入る。直近 3 日の `job_runs` の 1 回あたりの最長は、`account_daily` 23 秒、`stories` 9 秒、`media_sync` 8 秒、`media_snapshot` 4 秒、`token_check` と `profile_daily` 各 2 秒で、ほかのジョブは合わせて 1 分に満たない（2026-10-06、段階 0）。30 分のうち残りは apt と予算の分で足りる

### 3.3 ffmpeg の有無

ジョブの最初に 1 回だけ `toolVersion("ffprobe")` と `toolVersion("ffmpeg")` を呼ぶ。どちらかがなければ（spawn の ENOENT か終了コードで判定。文面では判定しない）、行を書かず、ダウンロードもせず、`recordFailure`（`unknown`、固定文言「ffmpeg がない」）を 1 回だけ記録して終わる。行を書かないので `attempt_count` は増えない（apt の失敗が続いても全リールが打ち切りに達しない）。

### 3.4 `media_url` の取り直し

`media_url` は期限付きで、DB に保存していない（要件の「動画の URL」の制約、F-VID-01）。解析の直前に 1 本ずつ取り直す。

- `ctx.graph.get` で `GET /{media-id}?fields=id,media_type,media_url`。ID は `/^\d+$/` で確かめてからパスに入れる
- 生の応答は既定どおり保存する（`media_url` は `graph-client.ts` が消してから保存する）。応答の本文はログに出さない。`media_url` は `analyzeVideo` に渡すだけにし、変数のほかに残さない
- `RateLimitExceeded` と `AuthError` は捕まえず枠組みに任せる（`stories` と同じ）

| 結果 | 行 | 失敗の記録 |
|---|---|---|
| `media_url` がある | 解析して `success` か `failed` | `failed` なら `recordFailure`（`failureClass` のまま） |
| `media_url` がない（著作権の判定など） | `no_video_url` | なし。`warn` のみ |
| 取り直した `media_type` が `VIDEO` でない | `failed`（固定文言「動画ではない」） | `recordFailure`（`fatal`） |
| API の `transient`（再試行を使い切った） | 書かない（次の回に再び選ばれる） | `recordFailure`（`errorClass` は `Tracked.errorClass`、`code` を渡す） |
| API の `fatal`（削除済みなど） | `failed`（固定文言「メディア情報の取得に失敗（code n）」） | `recordFailure`（同じ固定文言。API の `message` は入れない） |

`fatal` の削除済みの投稿は、`media_sync --full`（毎日）が `gone_at` を付けるので、そこで対象から外れる。それまでは打ち切りの回数で止まる。

### 3.5 ffmpeg に渡す入力の制限

- ffprobe とシーン検出の両方に `-protocol_whitelist file` と `-f mp4` を付ける（中身が HLS などでも別の URL やファイルを読みに行かない）
- ダウンロードの `content-type` が `video/` で始まらなければ `DownloadError` にする（`stories` にも効くが、動画ストーリーズの `content-type` は `video/mp4` で挙動は変わらない見込み。未確認）
- ダウンロードの制限は `stories` と同じ `videoDownloadLimits`（200 MB、60 秒、許可するホスト）

### 3.6 再試行と打ち切り

リールは消えないので、`no_video_url` や `failed` のまま 3 時間ごとに永久に再試行してしまう。

- `video_analyses` に `attempt_count` を足す（5.1）。同じ条件の行を書くたびに 1 増える（`success` で上書きしても増える。数えているのは「同じ条件で書いた回数」）
- 打ち切りの判定は `status <> 'success' and attempt_count >= VIDEO_MAX_ATTEMPTS`（既定 5）。`no_video_url` も回数に数える（失敗には数えないが、打ち切りには数える）
- 打ち切りに達した回（書いた結果 `attempt_count` が上限になった回）に `warn` を 1 行出す
- `stories` も同じ列を書くが、打ち切りは掛けない（24 時間で一覧から消える）
- 打ち切った投稿をやり直すときは、その行を手元の SQL で消すか、しきい値か版を変えて全体を解析し直す。専用のコマンドは作らない
- 手元の Docker のワーカーと GitHub Actions が同時に動くと、同じ投稿が 2 回解析され `attempt_count` が 2 増える。R2 から手元のワーカーは止めているので起きない。手元で動かすときは `COLLECT_ENABLED` を `false` にしてから（R2 設計 7.3 章）

### 3.7 ログ

- `info`、`warn`、`debug`、`recordFailure` には `media_id` も URL も入れない。件数と固定文言だけ（`stories` と同じ。公開ログに出るため）
- 最後に `info` で `candidates`、`analyzed`、`no_video_url`、`failed`、`skipped_by_limit`、`skipped_by_budget` を出す
- `success` は `ctx.progress.items += 1`（`video_analysis` の `items_fetched` は解析できた本数）

### 3.8 ストーリーズとの共通化

共通にするのは「`analyzeVideo` → `upsertVideoAnalysis`（1 トランザクション）→ `failed` なら `recordFailure`」だけ。関数 `analyzeAndStore(ctx, { mediaId, videoUrl }, deps)` は状態（`success`／`no_video_url`／`failed`）を返す。

- 対象の判定（`stories` は `latestAnalysis` と `isAnalysisRetryDue`、`video_analysis` は 3.1 の SQL）、ffmpeg の事前の確認、件数の数え上げ、`warn` の文言は各ジョブに残す。`stories` の `items_fetched`（スナップショットの枚数）は変わらない
- 置き場所は `jobs/video-store.ts`（`lib/video-analysis.ts` と名前が紛らわしくならないように）
- `stories` の既存のテストがそのまま通ること

---

## 4. しきい値の決め方: `video-tune`

完了条件（要件 10 章）は「数本について、カットのタイミングを目視と比べて妥当なしきい値を決めた」。

### 4.1 コマンド

`worker video-tune <media-id> [<media-id> ...] [--thresholds 0.2,0.25,0.3,0.4,0.5]`

1. 環境変数 `CI` か `GITHUB_ACTIONS` があれば何もせず終わる。最初に接続先の DB のホスト名を 1 行出す（手元か本番かを目で確かめる）
2. ID を `/^\d+$/` で確かめ、`media_url` を取り直し（3.4）、一時ファイルに落とす（3.5 の制限）
3. シーン検出を低いしきい値（0.1）で 1 回だけ走らせ、各フレームの時刻と `scene_score` を取る（`select='gt(scene,0.1)',metadata=print:key=lavfi.scene_score`。点数は直前のフレームとの比較なので、0.1 で選んだ後にしきい値で絞っても、しきい値ごとに走らせた結果と同じになる）
4. しきい値ごとに、`score > t`（本番の `gt` と同じく「より大きい」）のカットの数と時刻（秒、小数 1 桁）を表で標準出力に出す
5. DB には書かない。一時ファイルは消す

出力の解析: `metadata=print` は標準エラーにフレーム 1 枚につき `[Parsed_metadata_1 @ …] frame:N pts:P pts_time:T` と `[Parsed_metadata_1 @ …] lavfi.scene_score=S` の 2 行を出す（ffmpeg の動作の記憶。段階 1 で実機で確かめる）。`pts_time` と次の行の点数を組にする。ログの水準は既定（info）のままにする。

### 4.2 使い方

- 手元の Docker のワーカーで動かす（トークンは手元の Supabase のもの。R1 で登録済み）。GitHub Actions では動かさない（公開ログに投稿の ID が出るため）
- 出力はリポジトリ、Issue、PR に貼らない
- 目視は Instagram のアプリでリールを再生し、編集で切ったところの秒数と表を比べる。種類の違うリールを 3〜5 本（カットの多いもの、少ないもの、動きの激しいもの）
- 決めたしきい値を `DEFAULT_SCENE_THRESHOLD` と DB の関数 `current_video_condition()`（5.1）の両方に入れ、決めた理由と本数をこの文書に書く（投稿の ID は書かない）
- しきい値を 0.3 から変えると、R1 からのストーリーズの解析結果（0.3）は条件が違う行として残る（ストーリーズは動画を取り直せない）。画面のビュー（5.2）は今の条件の行だけを使うので、古いストーリーズの行は画面に出ない（ストーリーズは画面のビューの対象でもない）。分析用の `media_analysis_dataset` には `scene_threshold` の列があり、分析するときに分けられる

### 4.3 シーンの点数の保存

`detectSceneChanges` のフィルタを `select='gt(scene,T)',metadata=print:key=lavfi.scene_score` にし、時刻と点数を `metadata` の行から取る（showinfo はやめる）。点数を `video_cuts.scene_score` に保存する。

- カットの時刻が今と同じになることを、既存の色の切り替え動画（`generateColorTestVideo`）の結合テストで確かめる。同じなら `ANALYZER_VERSION` は上げない（Q4）
- `scene_score` は `numeric(5, 4)` に丸めて入る（ffmpeg は小数 6 桁）。しきい値ちょうどの点が丸めで上下しうることを列の comment に書く。後で SQL でしきい値を上げたカットを出す用途には足りる

---

## 5. DB

### 5.1 マイグレーション（手書き。`supabase/migrations/20261007000000_r4_video.sql`）

1. 今の解析条件を返す関数。しきい値を変えるたびにマイグレーションで作り直す（決めた記録にもなる）

   ```sql
   create or replace function public.current_video_condition(out analyzer_version text, out scene_threshold numeric)
   language sql immutable parallel safe
   as $$ select '1'::text, 0.300::numeric $$;
   revoke execute on function public.current_video_condition() from public;
   grant execute on function public.current_video_condition() to web_app;
   ```

   ワーカーの `ANALYZER_VERSION` と `DEFAULT_SCENE_THRESHOLD` と一致することを結合テストで突き合わせる。R2 の決まりで、関数の棚卸しのテスト（`web-role.test.ts`）にも足す

2. `attempt_count`

   ```sql
   alter table public.video_analyses
     add column attempt_count integer not null default 1 check (attempt_count >= 1);
   comment on column public.video_analyses.attempt_count is
     '同じ条件で書いた回数。success 以外で上限（ワーカーの VIDEO_MAX_ATTEMPTS）に達したら video_analysis の対象外。ストーリーズは打ち切らない';
   ```

   既存の行（ストーリーズだけ）は 1 になる。定数の既定値なので表は書き直されない。`upsertVideoAnalysis` は挿入の列に `attempt_count` を入れず、`on conflict (media_id, analyzer_version, scene_threshold) do update set ..., attempt_count = public.video_analyses.attempt_count + 1` にする。`latestAnalysis` と `VideoAnalysisSummary` にも `attempt_count` を足す

3. ビュー `public.media_video_features`（5.2）。`with (security_invoker = true)` で作り（R3 のビューと同じ）、`revoke all ... from public, anon, authenticated` の後に `grant select ... to web_app` だけを付ける

4. `media_analysis_dataset` に `retention_rate` を足すか（Q5）。足すなら `create or replace view` で末尾に列を足し、式は 5.2 と同じにして comment でお互いを参照させる

5. ロールバック（末尾のコメントに書く。順番が大事）

   ```sql
   -- 1. 先にワーカーを R4 より前の版に戻す（upsertVideoAnalysis が attempt_count を書くので、逆にすると stories を含む毎時のジョブが失敗する）
   -- drop view if exists public.media_video_features;
   -- （Q5 で media_analysis_dataset に列を足した場合は、drop して R1 の定義で作り直し、comment と grant をやり直す）
   -- drop function if exists public.current_video_condition();
   -- alter table public.video_analyses drop column if exists attempt_count;
   -- delete from supabase_migrations.schema_migrations where version = '20261007000000';
   ```

### 5.2 `media_video_features`

**行は動画の投稿だけ**（`m.media_type = 'VIDEO' and m.media_product_type in ('REELS', 'FEED')`）。ストーリーズは入れない（R3 の `media_list_metrics` が `<> 'STORY'` なので、つなぐ相手がない）。解析結果は**今の条件の 1 行**（`current_video_condition()`）だけを使い、特徴量と状態を同じ行から取る（条件をまたいだ行が混ざらない）。

```sql
create view public.media_video_features with (security_invoker = true) as
select
  m.id as media_id, m.account_id, m.media_product_type, m.media_type, m.posted_at,
  va.id as analysis_id, va.status as analysis_status, va.attempt_count, va.analyzed_at,
  va.duration_ms, va.width, va.height, va.fps, va.has_audio,
  va.cut_count, va.avg_scene_ms, va.first_cut_ms, va.cuts_in_first_3s,
  lt.avg_watch_time_ms::numeric / nullif(va.duration_ms, 0) as retention_rate
from public.media m
cross join public.current_video_condition() c
left join public.video_analyses va
  on va.media_id = m.id
 and va.analyzer_version = c.analyzer_version
 and va.scene_threshold = c.scene_threshold
left join public.media_horizon_metrics lt
  on lt.media_id = m.id and lt.horizon = 'latest'
where m.media_type = 'VIDEO'
  and m.media_product_type in ('REELS', 'FEED');
```

- `analysis_status` が null は「まだ解析していない」。`success` 以外の行では特徴量は null
- 打ち切ったかどうかは、上限がワーカーの設定値なのでビューでは判定しない（画面でも出さない。6.1）
- 平均視聴時間はこのビューに持たせない。`retention_rate` だけを R3 と同じ源（`media_horizon_metrics` の `latest`）から作る（同じ指標を 2 か所で定義しない）。1 を超えることがある（繰り返し再生）。丸めない。`avg_watch_time_ms` の型は実装時に確かめ、`::numeric` を明示する
- リーチ率、閲覧数などは画面のクエリで `media_list_metrics` とつなぐ
- `first_cut_ms` は画面変化 0 回のとき null のまま（R1 の定義どおり）

---

## 6. 画面

### 6.1 投稿詳細（`/media/[id]`）

リールとフィード動画のとき、「リーチの伸び方」の下に全幅のカード「カットのタイムライン」を足す（見本の `cutTimeline` から文字の区間を除いたもの）。

- **上段の数字**: 動画の長さ（秒、小数 1 桁）、画面変化（回）、平均シーン長（秒）、冒頭 3 秒の画面変化（回）、最初の画面変化まで（秒）。値はビューのものをそのまま使い、画面で計算し直さない。用語は要件 4.5 章の注意に従い「カット」でなく「画面変化」と書く（カードの題名の「カット」は要件の画面名どおり）。ヒントは「画面が大きく切り替わった回数。編集上のカットと一致しないことがある（フェードやズームにも反応する）」
- **動画の長さは上段の数字だけに出す。** 「量の指標」には足さない（長さには良し悪しの向きがなく、帯グラフの「右ほどよい」に合わない。F-UI-22 の「各指標は画面に 1 回だけ」）
- **質の指標の視聴維持率**: R3 の「—」を値に変える。比べる相手は同じ種類で `retention_rate` のある投稿。フィード動画は平均視聴時間が API で取れないので `unsupported`
- **タイムライン**: 横軸は 0〜動画の長さ。カットの時刻の先頭に 0 を足してシーンの帯を描く（画面変化 0 回なら帯は 1 本）。長さ以上の時刻と重複は捨てる。`duration_ms` が null なら描かない。シーンは交互の濃淡、カットの位置に三角の印。値は SVG の `<title>` と `aria-label` で持つ（R3 5.3 節の「吹き出しは作らない」）。目盛の間隔は動画の長さから決める（R3 の `labelStep` の考え方）。スマートフォンでは幅 340 の `viewBox` を `only-m` で出し分け、印が詰まるときは三角を省いて帯の濃淡だけにする
- **解析結果がないとき**: カードは出し、上段の数字とタイムラインを「—」にする。理由は R3 の `MissingReason` に当てはめ、新しい理由や文言は足さない

| 状態（今の条件の行） | `MissingReason` | 表示 |
|---|---|---|
| 行がない（まだ解析していない） | `not_yet` | 「—」だけ |
| `no_video_url` | `missing` | 「取得できなかった」 |
| `failed`（打ち切りを含む） | `missing` | 「取得できなかった」 |

画面のクエリは `error` 列を select しない（`select *` を使わない）。

### 6.2 リール分析（`/reels`）

見本（design-lab v3 の `S.reels`）から文字の要因を除いて作る。期間は過去 1 年間（365 日。要件 4.5 章）の固定で、選択は置かない（見本の「期間: 過去 1 年間」は選択の見た目をやめて文字にする）。対象はリールだけ（フィード動画は今 0 件で、リールと混ぜると比べ方が変わる）。

#### カード

| カード | 内容 | 要件 |
|---|---|---|
| 見出し | 「リール n 件（過去 1 年間）」と目的変数の選択（Q1） | — |
| 要因との関係 | 7 つの要因（動画の長さ、画面変化の回数、平均シーン長、冒頭 3 秒の画面変化、最初の画面変化まで、キャプションの長さ、投稿からの経過日数）と目的変数の順位相関と、ブートストラップの 95% の幅。幅が 0 をまたぐものは薄く。各行に n | F-VID-13 の要約 |
| 上位と下位 | 目的変数の上位 25% と下位 25% のサムネイルと、要因の中央値の表（冒頭 3 秒の画面変化は「1 回以上の割合」） | — |
| 散布図 | 数値の要因 × 目的変数の 6 枚（動画の長さ、画面変化の回数、平均シーン長、冒頭 3 秒の画面変化、最初の画面変化まで、キャプションの長さ）。点は投稿詳細へのリンク | F-VID-13 |
| 区分 | 長さ（0〜15、15〜30、30〜60、60 秒超）、冒頭 3 秒の画面変化（0 回／1 回以上）、曜日（平日／土日）、時間帯（朝／昼／夜）ごとの目的変数の中央値。棒の下に件数。3 件未満の区分は薄く | F-VID-12 |
| 視聴と反応 | 視聴維持率、スキップ率、シェア率、保存率 × 目的変数の散布図 | F-VID-11 |
| 一覧 | リールの表（Q2）: サムネイル、題名、投稿日、経過日数、長さ、画面変化、平均シーン長、冒頭 3 秒、閲覧数、リーチ、平均視聴時間、視聴維持率、スキップ率、シェア率、保存率、リーチ率。列の見出しで並べ替え。ページ送りなし（数十件） | F-VID-10 |

- 見本の「投稿の時刻」は要因から外す（0 時と 23 時が隣り合う環状の値で、順位相関に向かない。時間帯は区分のカードで見る）。代わりに「投稿からの経過日数」を入れる（最新の値を目的変数にしたときの経過日数の影響を、見る人が読めるように。新しい文言は足さない）
- 見本の「リーチとリーチ率の推移」は入れない（投稿ごとの推移は投稿一覧と概要で見られる。Q7）

#### 区分の境界

- 長さ: 15 秒未満、15 秒以上 30 秒未満、30 秒以上 60 秒未満、60 秒以上（下端を含む）。表示は「0〜15 秒」「15〜30 秒」「30〜60 秒」「60 秒〜」
- 曜日と時間帯は投稿日時の日本時間で判定する。朝は 11 時より前、昼は 11 時以上 17 時未満、夜は 17 時以上（見本と同じ）

#### カードごとの母集団

| カード | 母集団 |
|---|---|
| 要因との関係、上位と下位、散布図 | 今の条件で `success` があり、目的変数の値があるリール。要因ごとに、その要因が null のもの（画面変化 0 回の「最初の画面変化まで」など）を除く |
| 区分（長さ、冒頭 3 秒） | 同上 |
| 区分（曜日、時間帯）、視聴と反応 | 目的変数の値があるリール（動画の解析は要らない） |
| 一覧 | 期間内のすべてのリール（値のない欄は「—」） |

各カードの件数は n として添える（R3 と同じ。除いた理由ごとの説明の文言は出さない）。

#### 計算

- 計算（順位相関、ブートストラップ、中央値、分位）はサーバーで行い、数値だけを描画に渡す
- 順位相関は同順位を平均の順位にする（見本の `ranks`）。n が 3 未満、または要因か目的変数の分散が 0 なら null を返し「—」にして、幅も描かない（計算できないものを 0 と表示しない。R3 の n の決まりと同じ考え方で、手法の切り替えではない）
- ブートストラップの再現性
  - 入力を `media_id` の順に並べる
  - 乱数は Park-Miller（見本と同じ。種は固定の定数）。再標本の index の組を B = 1000 回分 1 回だけ作り、全要因で使い回す（要因の数や順に左右されない）
  - 分散 0 になった回は捨てる。幅は残った回の 2.5% と 97.5% の分位（`percentile_cont` と同じ線形補間）
- 上位と下位: n が 4 未満なら表を出さず件数だけにする。並べて位置で切り（`q = floor(n / 4)`）、同じ値のときは `media_id` の順で決める

#### 空のとき

R3 の空の状態の決まり（3.1 節）に合わせる。期間内のリールが 0 件なら「まだ投稿がありません」、解析済みが 0 件なら「—」と `/jobs` へのリンク。

#### 検索パラメータ

| 名前 | 値 | 既定 |
|---|---|---|
| `y` | `reach_rate`、`reach`、`views`（Q1） | `reach_rate` |
| `sort` | 一覧の列のキー | 投稿日 |
| `dir` | `asc`、`desc` | `desc` |

- 不正な値は既定に戻す（R3 4.7 節）
- 並べ替えのリンク（`SortHeader`）は `y` を保ち、`y` の選択は `sort` と `dir` を保つ
- 並べ替えのたびにページ全体を計算し直す（件数が少ないので許容）

#### 部品とスマートフォン

- グラフは R3 と同じく SVG を自作する（`components/charts/`）。Server Component で、題名は文字として描く（`dangerouslySetInnerHTML` を使わない）
  - `Scatter`: X 軸と Y 軸の範囲をデータから決める（下端を 0 に固定しない）。視聴維持率は 1 を超えるので上限を固定しない。点 0 個、1 個、全部同じ値でも `NaN` を出さない。点の当たり判定は R3 の `MARKER_HIT` 相当の大きさ。値は `<title>` と `aria-label`
  - `Forest`: 範囲は -1〜1 の固定。r が null の行は「—」
- スマートフォン
  - フォレストはラベルを上の行に、その下に数値と幅のグラフ
  - 散布図は 2 列（`col-6`、幅の狭い `viewBox`、高さ 150）
  - 一覧は横スクロールの枠に入れ、サムネイルと題名の列を固定する。隠す列（`hide-m`）は経過日数、平均シーン長、スキップ率、平均視聴時間
- ナビゲーションに「リール分析」を足す（投稿詳細の次。見本の順）

#### 目的変数（Q1）

リーチ率（7 日時点のリーチ ÷ 投稿時のフォロワー数）は、投稿時のフォロワー数の記録がある投稿（収集開始の 2026-10-01 以降）にしか出ない。2026-10-06 の本番では、リール 18 本のうちリーチ率のあるものは 0 本（段階 0 で確認）。空になる理由は 2 つある。分母の投稿時のフォロワー数は、投稿より前 3 日以内の `profile_daily` の記録から取るが、記録は収集を始めた 2026-10-01 からしかなく、API でも過去のフォロワー数は取れない（R0 の V5。`follower_count` は新規フォロワー数で、直近 30 日のみ）。分子の 7 日時点のリーチも、収集開始より前の投稿にはその時点のスナップショットがない。2026-10-01 以降に投稿したリールは、投稿から 7 日たつと値が出る。このままでは画面の大半が空になる。

- A. リーチ率に固定（要件どおり）。数か月は空に近い
- B. 見出しの右に目的変数の選択を置く（リーチ率、最新のリーチ、最新の閲覧数）。既定はリーチ率。投稿時刻の画面（F-UI-42）の指標の選択と同じ形。選択肢の文言に件数を出す（例: 「リーチ率（2 件）」「最新の閲覧数（20 件）」）。データの状況で自動では変えない
- C. B と同じで、既定を最新の閲覧数にする

**B に決定（2026-10-06、ユーザー）。** 視聴維持率は選択肢に入れない（「視聴と反応」で同じ値どうしの図になり、分母が動画の長さなので長さとの相関が式の上で負に出るため）。

### 6.3 投稿一覧（`/media`）

変えない。動画の特徴量はリール分析の一覧（6.2）に出す。

---

## 7. テスト

| 区分 | 内容 |
|---|---|
| 単体（worker） | 対象の SQL の結果からの選び方（上限、予算で次の回に回す）。`media_url` の取り直しの各場合（ある、ない、`VIDEO` でない、`transient` で行なし、`fatal` で `failed`）。ffmpeg がない回は行を書かず `attempt_count` が増えない。打ち切りの `warn` が 1 回だけ出る。ログに `media_id` と URL がない。動画の長さが 15 分を超えたら検出しない。ダウンロードの上限超えと制限時間、`content-type` が動画でない、ffmpeg の制限時間（`CommandError` の `code` が null）、ffprobe の長さが 0。`video-tune` のしきい値ごとの集計（純関数、「ちょうど t」は含めない）、`metadata=print` の出力の解析、CI では動かない、ID の形の検査 |
| 結合（worker と DB） | `listVideoAnalysisCandidates`（種類、`gone_at`、3 時間、打ち切り、新しい順）。`upsertVideoAnalysis` の `attempt_count`。`ANALYZER_VERSION` と `DEFAULT_SCENE_THRESHOLD` が `current_video_condition()` と一致。色の切り替え動画でカットの時刻が R1 と同じ。`stories` の既存のテストがそのまま通る |
| DB | `media_video_features` が動画だけで 1 投稿 1 行、今の条件の行だけを使う（古い条件の `success` と今の条件の `failed` があれば `failed` の状態で特徴量は null）、`retention_rate` の分母 0。`web_app` で読め、anon と authenticated では読めない。関数の棚卸し（`web-role.test.ts`） |
| 画面 | 順位相関（既知の値、同順位、n = 3 未満と分散 0 で null）。ブートストラップ（分散 0 の回を捨てる、入力の順を変えても・要因を足しても他の要因の幅が同じ）。要因ごとの n とカードごとの母集団。上位と下位（n = 1〜5、境目に同じ値）。区分の境界（15、30、60 秒ちょうど、日本時間の曜日と時間帯で UTC 15:00 をまたぐ投稿）。検索パラメータ（不正値で既定、並べ替えのリンクが `y` を保つ）。タイムライン（画面変化 0 回、0 ms の画面変化、長さ以上の時刻、`duration_ms` が null、目盛の間隔）。状態から `MissingReason` への対応。`Scatter` と `Forest` の点 0 個、1 個、x が全部同じ、値が 1 超え、r が null。ページ全体の空の状態。ナビゲーションの「リール分析」 |
| 実機 | 手元で数本の解析時間を計測。本番で既存のリールすべてに結果か理由が入る（完了条件）。スマートフォン幅の見た目はユーザーの確認 |

---

## 8. 段階

| 段階 | 内容 | 担当の案 |
|---|---|---|
| 0 | 本番のリールの本数、リーチ率のあるリールの本数、`job_runs` の所要時間を数える。**済み（2026-10-06）**: リール 18 本、リーチ率のあるリール 0 本、フィード動画 0 本、ジョブの最長は 23 秒 | 親とユーザー |
| 1 | マイグレーション、`video_analysis` ジョブ、共通化、ffmpeg の入力の制限と制限時間、`video-tune`、テスト。手元で数本を解析して時間を計測 | `node-worker-developer`。SQL は `postgres-sql-reviewer` がレビュー |
| 2 | しきい値を決める（ユーザーの目視） | ユーザーと親 |
| 3 | 本番に反映（`db push`、main にマージ）。既存のリールが数時間で解析されることを確かめる | 親とユーザー |
| 4 | 画面（投稿詳細のタイムライン、リール分析） | `nextjs-developer` |
| 5 | テストの不足、セキュリティレビュー、ユーザーの画面の確認 | `quality-engineer`、`security-engineer`、ユーザー |

段階 1〜3 と段階 4 は並べて進められる（画面は手元の Supabase の解析結果で作る）。

---

## 9. 確認事項

| # | 問い | 推奨 |
|---|---|---|
| Q1 | リール分析の目的変数（6.2 節） | B: 選択（リーチ率、最新のリーチ、最新の閲覧数。件数つき）を置き、既定はリーチ率 |
| Q2 | F-VID-10 のリールの一覧をリール分析の画面の最下部に置くか | 置く（見本にはないが要件にある） |
| Q3 | しきい値を変えたとき、画面は今の条件の結果だけを使い、古い条件の結果は分析用のデータセットにだけ残す | このまま |
| Q4 | `scene_score` を拾うようにしても `ANALYZER_VERSION` を上げない | 上げない（カットの時刻が同じことを結合テストで確かめる） |
| Q5 | `media_analysis_dataset` に `retention_rate` を足すか | 足す（CSV や SQL で使う機会が多い） |
| Q6 | 1 回の上限 5 本、時間の予算 8 分、打ち切り 5 回 | このまま。段階 1 の計測で見直す |
| Q7 | 見本の「リーチとリーチ率の推移」と要因の「投稿の時刻」を外し、要因に「投稿からの経過日数」を入れる | このまま |

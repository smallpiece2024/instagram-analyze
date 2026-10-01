# R1: 収集ジョブの設計

| 項目 | 内容 |
|---|---|
| 版 | 0.3 |
| 作成日 | 2026-10-01 |
| 更新履歴 | 0.1 初版案。0.2 セキュリティと品質のレビューを反映（秘密情報の記録とマスクの規則、消失判定の条件と余裕、内訳の「印」の行、スナップショットの欠損行、接続数、日次指標の窓を 4 日に、follower_count の窓を PT 0 時基準に、「今日」はジョブ開始時刻で固定、再試行は合計 3 回、レート制限のコード 80000〜80009、`numeric` の型、スケジューラの判定、実装の分割とファイルの担当、テストケースの具体化、R2 への申し送り）。0.3 段階 1（土台と検証）の実装で確定・変更した事項を 13 章に追記（11.1 章の P1〜P12 の結果、Bearer ヘッダ、ページングの終了判定、`metricDateFromEndTime`、`sanitizeForLog` の順序、エラー文のマスク、`deriveJobStatus`、Dockerfile） |
| 対象 | 要件定義 4.2 章（F-COL-02、F-COL-03、F-COL-10〜24）、5.2 章、5.4 章、5.5 章、8.1 章、8.2 章 |
| 入力 | `doc/requirements/requirements-definition.md`（版 0.4）、`doc/design/r1-db-design.md`（版 0.3）、`doc/verification/r0-meta-api-verification.md`、`supabase/migrations/20261001100000〜20261001100400`、`apps/worker/src/` |
| 範囲外 | Facebook Login の接続画面（F-COL-01）、画面（F-UI-01〜03）、R2 の通知（F-SYS-14）、`export-dataset` コマンド |
| 状態 | 実装中。11.2 章の Q1〜Q9 は回答済み。段階 1（土台と検証）は実装済みで、確定・変更した事項は 13 章 |

---

## 0. 前提

- R1 の完了条件は「ローカルで 3 日間収集を続け、プロフィール、アカウント日次指標、投稿スナップショット、ストーリーズが欠けずに DB に入っている。収集ログ画面で成否を確認できる」（要件 10 章）。この文書はそのうちワーカー側を扱う。
- トークンは `.env` のページアクセストークン（有効期限なし、データアクセス期限あり。R0 検証 2.7 章）を DB に登録して使う。Facebook Login は R1 の後半で別に設計する。
- DB の形は確定済み（`r1-db-design.md`）。この文書ではテーブルを変えない。ジョブ名は `job_runs.job_name` の例（DB 設計 3.8 章）に合わせる。
- 既存のワーカーは `worker <command>` の形で、`index.ts` の `COMMANDS` にコマンドを登録する。Graph API クライアントは `lib/graph.ts`、ffmpeg は `lib/ffmpeg.ts` にある。これらを拡張して使い、作り直さない。
- 実装は複数の担当者が **同じ作業ツリー** で並列に進める（git worktree は使わない）。担当ごとに触るファイルを分ける（10.3 章）。

用語: この文書で「PT の日付」は米国太平洋時間の日付（API の日次指標の区切り。R0 検証 V4）、「JST の日付」は日本時間の日付を指す。

---

## 1. 全体構成

### 1.1 コマンドの構成

既存の `worker <command>` に、ジョブを 1 つずつコマンドとして載せる。**ジョブは 1 回実行して終わる**。これに加えて、ジョブをまとめて順に実行する「グループ」のコマンドと、ローカルで常駐してグループを決まった時刻に起動する `schedule` を置く。R2 の GitHub Actions からはグループのコマンドを cron で 1 回ずつ呼ぶ（2.4 章）。

| コマンド | 種類 | 内容 | job_name |
|---|---|---|---|
| `register-token` | 設定 | `.env` のトークンを `debug_token` で調べ、`accounts`、`private.credentials`、Vault に登録する（4.1 章） | なし |
| `token-check` | ジョブ | トークンの期限と状態を確かめて `private.credentials` を更新する（4.2 章） | `token_check` |
| `profile-daily` | ジョブ | プロフィールの日次記録（5.1 章） | `profile_daily` |
| `account-daily` | ジョブ | アカウント日次指標の直近 4 日と follower_count（5.2 章） | `account_daily` |
| `account-backfill` | ジョブ | アカウント日次指標の 2 年分のバックフィル。`job_state` で再開（5.3 章） | `account_backfill` |
| `media-sync [--full]` | ジョブ | 投稿一覧の同期。`--full` で全ページを読み、消えた投稿を検出する（5.4 章） | `media_sync` |
| `media-snapshot` | ジョブ | 投稿指標のスナップショット（5.5 章） | `media_snapshot` |
| `stories` | ジョブ | ストーリーズの一覧、指標、動画解析（5.6 章） | `stories` |
| `run-hourly` | グループ | `stories` → `media-sync` → `media-snapshot` → `account-backfill` を順に実行（6 章） | 各ジョブ |
| `run-daily` | グループ | `token-check` → `profile-daily` → `account-daily` → `media-sync --full` を順に実行（6 章） | 各ジョブ |
| `schedule` | 常駐 | 1 時間ごとに `run-hourly`、1 日 1 回 `run-daily` を同じプロセス内で実行する（2 章） | なし |
| `check-env`、`verify-api` | 既存 | `verify-api` には 11.1 章の検証項目を追加する | なし |

コマンド名は既存に合わせてケバブケース、`job_runs.job_name` は DB 設計に合わせてスネークケースにする。`index.ts` の `run` の型を `(args: string[]) => Promise<boolean>` に広げ、引数は `node:util` の `parseArgs` で読む（依存を増やさない）。

各ジョブのファイルは `export const job: JobDefinition` を出すだけにし、`index.ts` への登録は統合の段階（10.4 章）で 1 人がまとめて行う。

ジョブのコマンドは `accounts.status = 'active'` のアカウントすべてについてジョブを実行し、アカウントごとに独立して成否を記録する（NF-REL-01。R1 では 1 アカウント）。終了コードは、すべてのアカウントで `success` か `skipped` なら 0、それ以外は 1 とする。グループのコマンドは、途中のジョブが失敗しても次のジョブに進み、1 つでも `failed` があれば終了コード 1 を返す。

### 1.2 ジョブ共通の枠組み（`jobs/framework.ts`）

ジョブは「名前」と「実行関数」を持つ定義（`JobDefinition`）で、枠組み（`runJob`）が次を共通に行う。ジョブの実装は API の呼び出しと行の変換と書き込みだけに集中する。

| 項目 | 枠組みがすること | 根拠 |
|---|---|---|
| 実行記録 | 開始時に `job_runs` に `running` の行を入れ、終了時に `status`、`finished_at`、`items_fetched`、`api_calls`、`error`、`rate_usage` を更新する。見送り（`skipped`）のときは開始と終了を同時に書く | F-COL-19、5.4 章 |
| 二重起動の防止 | Postgres のアドバイザリロック `pg_try_advisory_lock(hashtext(job_name), hashtext(account_id))`（2 キー版）を取る。取れなければ `skipped`（error: `同じジョブが実行中`）で終わる（6 章） | F-COL-20 |
| 取り残しの整理 | ロックを取ったあと、同じ `job_name` と `account_id` で `running` のままの行を**すべて** `failed`（error: `中断（プロセスが終了した）`）にする。ロックが取れた時点で、同じキーのジョブは動いていないと言えるため、経過時間の条件は付けない | 収集ログ画面の正確さ |
| 認証情報 | `private.credentials` と Vault からトークンを読み、ジョブ用の Graph API クライアント（`JobGraphClient`）を作る。トークンはクライアントの中だけに置き、ジョブの実装には渡さない。読んだトークンは秘密の一覧（8.1 章）に登録する | NF-SEC-01 |
| 生レスポンスの保存 | `JobGraphClient.get` が呼び出しごとに `raw_api_responses` に 1 行入れ、その `id` を返す。**自動コミット**（トランザクションの外）で入れ、項目の行は `raw_response_id` で参照するだけにする。保存前に `params` は `stripSecretParams`、`body` は `stripVolatileFields` を通す（1.3 章）。`persist: false` を渡すと保存しない（`debug_token` に使う） | F-COL-18、NF-SEC-01 |
| 再試行 | 一時的なエラーだけを、待ち時間を伸ばしながら合計 3 回試す（1.4 章） | F-COL-21 |
| レート制限 | 呼び出しごとにヘッダを読み、しきい値を超えたら `RateLimitExceeded` を投げてジョブを止める（7 章） | F-COL-21 |
| 計数 | `ctx.progress`（items、failures、apiCalls）を枠組みが持ち、ジョブが増やす。例外で止まっても途中までの件数が記録に残る | F-COL-19 |
| 状態の決定 | 1.5 章の規則で `success`、`partial`、`failed`、`skipped` を決める | 5.4 章 |
| 失効の検出 | Graph API のコード 190（トークン無効）を受けたら、`private.credentials.status` を `expired`、`last_error` を `トークンが無効（コード 190）` にし、ジョブを `failed` で止める。他のジョブは止めない | F-COL-03 |
| エラーの隔離 | ジョブの中で投げられた例外はすべて枠組みが受け、`job_runs.error` に残して戻る。呼び出し側（グループ、スケジューラ）には投げない | NF-REL-01 |
| 例外の記録 | 例外から記録するのは **`sanitizeForLog(error.message)` だけ**。`stack`、`cause`、postgres.js の `PostgresError.query` と `parameters`、オブジェクト全体は、ログ、`job_runs.error`、`private.credentials.last_error`、`video_analyses.error` のどこにも出さない。DB の接続・認証・Vault の失敗は `normalizeDbError` で「DB 接続に失敗（SQLSTATE 28P01）」「Vault への登録に失敗（SQLSTATE 42501）」のような固定文言にし、接続先のホストやユーザー名（`postgres.<ref>`）を含めない | NF-SEC-06 |
| プロセスの保険 | `index.ts` の起動時に `process.on('unhandledRejection')` と `process.on('uncaughtException')` を登録し、同じ規則で 1 行出して終了コード 1 で終わる | NF-SEC-06 |
| 一時ファイル | 起動時に `os.tmpdir()` 配下の `worker-*` の古いディレクトリ（1 日以上前）を消す。各処理は `finally` で自分の一時ディレクトリを消す | NF-CAP-03 |
| ログ | ジョブの開始と終了を 1 行ずつ出す（8 章） | NF-SEC-06 |

### 1.3 生レスポンスに入れる前の加工（`jobs/graph-client.ts`）

| 関数 | 対象 | 内容 |
|---|---|---|
| `stripSecretParams(params)` | `raw_api_responses.params` | `access_token`、`input_token`、`appsecret_proof` のキーを常に除く。純粋関数。入力は変更しない |
| `stripVolatileFields(body)` | `raw_api_responses.body` | JSON 全体を**再帰的に**走査し、キー名が `access_token`、`media_url`、`thumbnail_url`、`profile_picture_url` に一致する値、および `paging` 配下の `next` と `previous`（URL にアクセストークンが含まれる）を文字列 `"<omitted>"` に置き換える。`paging.cursors` は残す。`data[]` と `children.data[]` の入れ子にも効く。純粋関数。入力は変更しない |

`media_url` などの署名付き URL は期限付きで（R0 検証 2.5 章）、要件 2.2 章の「URL は保存しない」に従う。

### 1.4 再試行とバックオフ

Graph API のエラーを 4 つに分類し、分類ごとに振る舞いを決める。分類は純粋関数 `classifyGraphError(status, error)` にして単体テストする。

| 分類 | 条件 | 振る舞い | `get` の挙動 |
|---|---|---|---|
| `transient` | ネットワークエラー（`fetch` の例外）、HTTP 5xx、レスポンス本文が JSON でない（既存の `GraphClient.get` は `ok: true, data: undefined` を返しうる。これも `transient` にする）、Graph のコード 1（unknown）、2（service unavailable） | 同じリクエストを**合計 3 回**試す（最初の 1 回 ＋ 再試行 2 回）。待ち時間は 1 回目の再試行の前に 2 秒、2 回目の前に 8 秒（4 倍ずつ）に 0〜1 秒の乱数を足す。3 回とも失敗したらその項目を失敗として次へ進む | 使い切ったら `ok: false, errorClass: 'transient'` を**返す** |
| `rate` | Graph のコード 4、17、32、613、80000〜80009（Business Use Case のレート制限。Instagram は 80004 とされる。実機で確かめる。11.1 章 P12）、または HTTP 429 | 再試行しない。ジョブを止める（7 章） | `RateLimitExceeded` を**投げる** |
| `auth` | Graph のコード 190（トークン無効）、10 と 200〜299（権限不足） | 再試行しない。`private.credentials` を更新してジョブを `failed` で止める（コード 190 は `expired`、権限不足は `insufficient_scope`） | `AuthError` を**投げる** |
| `fatal` | それ以外（コード 100 の不正なパラメータ、存在しないメディアなど） | 再試行しない。その項目を失敗として記録し、次の項目へ進む | `ok: false, errorClass: 'fatal'` を**返す** |

既存の `GraphClient` には 1 回あたり 200 ミリ秒の間隔が入っている（`requestIntervalMs`）。これはそのまま使う。

### 1.5 ジョブの状態の決め方（`deriveJobStatus`）

| 状態 | 条件 |
|---|---|
| `failed` | `auth` で止まった（書けた件数に関係なく。`error` にコード）。何も書き込めずに失敗した。予期しない例外で止まった |
| `skipped` | 何も書き込む前にレート制限で止まった。または二重起動で見送った |
| `partial` | 1 件以上書き込めたが、失敗した項目がある、またはレート制限で途中で止まった |
| `success` | 失敗 0 件で、レート制限で止まっていない |

上から順に判定する。`partial` の意味はジョブごとに 5 章で書く。共通の考え方は「書けた分は正しい。次の実行で埋まる」で、`partial` が続くときだけ調べればよい。

### 1.6 1 ジョブの流れ

```text
runJob(def, account)
  ├─ 接続を 1 本予約（reserve）してロック取得（取れなければ skipped の行を書いて終了）
  ├─ 同じキーの running をすべて failed に
  ├─ shouldRun → false なら終了（行を作らない）
  ├─ job_runs に running を insert
  ├─ 認証情報を読む → 秘密の一覧に登録 → JobGraphClient を作る
  ├─ 直近 1 時間の job_runs.rate_usage を RateMonitor の初期値にする
  ├─ def.run(ctx)
  │     ├─ ctx.graph.get(...) → 再試行、生レスポンス保存（自動コミット）、レート監視、apiCalls++
  │     ├─ ctx.db.begin(tx => 項目の行の upsert)   … 項目ごとに短いトランザクション
  │     └─ ctx.progress.items++ / failures++
  ├─ 例外を分類（RateLimitExceeded、AuthError、その他）
  ├─ job_runs を更新（status、件数、error、rate_usage）
  ├─ ログ 1 行
  └─ ロック解放、予約した接続を返す
```

---

## 2. 定期実行

### 2.1 候補の比較

| 候補 | 利点 | 欠点 |
|---|---|---|
| **A. コンテナ内で常駐するスケジューラ（採用）** `worker schedule` を `docker compose up -d` で動かす | 既存の Docker 構成だけで済む。ホストが Windows でも cron が要らない。コンテナが落ちても `restart: unless-stopped` で戻る。再起動後に取りこぼした回を補える（2.3 章） | コンテナが常に起動している必要がある。PC のスリープ中は止まる（R2 で解消） |
| B. ホストのタスクスケジューラ（Windows）から `docker compose run --rm worker run-hourly` | ジョブは常に 1 回実行で終わる。R2 と同じ形 | Windows のタスクスケジューラの設定がリポジトリに残らない。コンテナ起動のオーバーヘッドが毎時かかる。ログが散る |
| C. cron 用のコンテナ（ofelia など）を compose に足す | cron の書式で書ける | イメージが 1 つ増える。Docker ソケットの共有が要る |
| D. Supabase の pg_cron から呼ぶ | DB の中で完結 | ワーカーのコンテナ（ffmpeg）を起動できない |

A を採る。理由は、Windows のホストで追加の仕組みが要らず、設定が `docker-compose.yml` に残り、R2 で GitHub Actions に移すときも同じグループのコマンドを呼ぶだけで済むため。

cron 式のライブラリ（`croner` など）は入れない。予定は「毎時 N 分」と「毎日 JST の HH:MM」の 2 つだけで、判定は純粋関数 1 つで書ける（2.3 章）。

### 2.2 `docker-compose.yml` と `Dockerfile` の変更

```yaml
services:
  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    command: ["schedule"]          # docker compose up -d で常駐。run --rm worker <job> は上書きできる
    restart: unless-stopped
    stop_grace_period: 10m         # 実行中のジョブ（初回の取り込みは数分）を終えてから止まる
    env_file: [{ path: .env, required: false }]
    environment: { WORKER_OUTPUT_DIR: /app/.local }
    volumes: ["./.local:/app/.local"]
    extra_hosts: ["host.docker.internal:host-gateway"]
```

`Dockerfile` の実行イメージに `USER node` を加え、root で動かさない（公式イメージに `node` ユーザーがある。`/app` と `/tmp` の書き込み権限を確かめる）。

ルートの `package.json` に次を足す。

| スクリプト | 内容 |
|---|---|
| `worker:up` | `docker compose up -d worker`（常駐を開始） |
| `worker:down` | `docker compose stop worker` |
| `worker:logs` | `docker compose logs -f worker` |
| `worker:job` | `docker compose run --rm worker`（例: `npm run worker:job -- media-sync --full`） |
| `worker:register-token` | `docker compose run --rm worker register-token` |

### 2.3 スケジューラの動き（`commands/schedule.ts`、`jobs/scheduler.ts`）

- 30 秒ごとに起きて、`dueGroups(now, lastStarted, config)` を呼び、実行すべきグループを順に実行する（同じプロセス内で `runGroup(HOURLY_JOBS)`、`runGroup(DAILY_JOBS)` を呼ぶ。別プロセスは起動しない）。
- `lastStarted` は、起動時に `job_runs` から読む（hourly は `stories`、daily は `profile_daily` の最新の `started_at`）。以降はメモリで更新する。
- 判定（純粋関数、単体テスト対象）。hourly と daily を同じ形にする:
  - hourly: `lastStarted.hourly` が undefined（初回）なら即実行。そうでなければ、`now` の分が `WORKER_HOURLY_MINUTE`（既定 5）**以降**で、`now` と同じ時間帯（同じ時刻の「時」）にまだ実行していない。
  - daily: `lastStarted.daily` が undefined なら即実行。そうでなければ、JST の時刻が `WORKER_DAILY_TIME_JST`（既定 `05:30`）以降で、JST の今日にまだ実行していない。
  - 両方が同時に due なら daily → hourly の順。グループは同時に走らせない（ジョブは直列）。
- 「以降」にするのは、コンテナの再起動や PC の復帰で予定の分を過ぎていても、その時間帯の分を 1 回だけ実行するため。
- `WORKER_HOURLY_MINUTE` は 0〜59 の整数、`WORKER_DAILY_TIME_JST` は `HH:MM`（00:00〜23:59）であることを `config.ts` の読み込み時に検証し、不正なら変数名だけを示して起動を止める（値は出さない）。
- SIGTERM を受けたら、実行中のジョブを終えてからループを抜ける（`stop_grace_period` 内）。
- 既定の時刻の理由: 日次指標の「日」は PT の 0 時（JST 16 時または 17 時）で区切られる（V4）。JST 05:30 は PT の前日 12:30〜13:30 で、PT の前日分が閉じてから 12 時間以上経っている。プロフィール（JST の日付で記録）は要件 5.2 章の「日本時間の早朝」に合う。hourly の 5 分は、daily の 05:30 と重ならないように選んだ。

### 2.4 R2（GitHub Actions）への対応

GitHub Actions では、hourly 用（`5 * * * *`）と daily 用（`30 20 * * *` UTC = JST 05:30）の 2 つのワークフローから、同じイメージで `run-hourly` と `run-daily` を 1 回ずつ呼ぶ。`concurrency` グループで同じワークフローの重複を防ぎ、ジョブ側のアドバイザリロック（6 章）で 2 つのワークフローの重なりも防ぐ。実行の遅れは、投稿スナップショットが実際の取得時刻で経過時間を計算する設計（DB 設計 3.6 章）で吸収する。R2 の設計で決めることは 12 章にまとめる。

---

## 3. DB アクセス

### 3.1 接続の方式

ワーカーは **Postgres に直接接続する**（DB 設計 9 章の有力案を採る）。理由は、トークンを `vault.decrypted_secrets` から読む必要があり、Supabase の REST には `private` スキーマも Vault も公開していないため（DB 設計 7 章）。

| 環境 | 接続先 | 備考 |
|---|---|---|
| ローカル | `postgresql://postgres:postgres@host.docker.internal:54322/postgres` | Supabase CLI の DB（`supabase/config.toml` の `[db].port = 54322`）。コンテナからは `host.docker.internal`（`docker-compose.yml` の `extra_hosts`） |
| R2（GitHub Actions） | Supabase の接続プーラー（Supavisor）の**セッションモード**（ポート 5432）。ユーザー名は `postgres.<project-ref>`。`sslmode=verify-full` と Supabase の CA 証明書を使う（12 章） | GitHub Actions のランナーは IPv4 だけで、Supabase の直接接続は IPv6 のため。セッションモードならプリペアドステートメントとアドバイザリロックがそのまま使える |

接続文字列は環境変数 `DATABASE_URL` 1 つで与える。ローカルと R2 で同じ形になる。接続文字列はパスワード、ユーザー名、ホストを秘密の一覧に登録し（8.1 章）、エラーにも出さない。

### 3.2 ライブラリの比較

| 候補 | 利点 | 欠点 |
|---|---|---|
| **`postgres`（postgres.js 3.4、採用）** | 依存パッケージなし、ESM ネイティブ。タグ付きテンプレートでパラメータが自動で `$1` になり、SQL 注入の余地が少ない。`sql(rows)` で複数行の insert、`sql.json()` で jsonb が書ける。`reserve()` で接続を 1 本固定でき、セッション単位のアドバイザリロックと相性がよい | 利用者が `pg` より少ない。`date` 型の既定の変換が落とし穴になる（3.5 章）。`PostgresError` が `query` と `parameters` を持つので、そのまま記録してはいけない（1.2 章） |
| `pg`（node-postgres 8.23） | 最も使われていて情報が多い | `$1, $2` を手で書く。`bigint`、`date` の型変換に `pg-types` の設定が要る。Supabase の例でも `postgres` の方が多い |
| `@supabase/supabase-js` | Web と同じクライアント | REST 経由なので `private` スキーマと Vault を読めない。採れない |

`postgres` を採る。接続は **`max: 2`**（ロック用に `reserve()` で 1 本固定し、ジョブのクエリと `begin` にもう 1 本）、`connect_timeout: 10`、`idle_timeout: 30` とする。R2 の `sslmode` は URL で渡る。

### 3.3 Vault の読み書き（`db/accounts.ts`）

| 操作 | SQL |
|---|---|
| 読む | `select decrypted_secret from vault.decrypted_secrets where id = ${tokenSecretId}` |
| 既存を探す | `select id from vault.secrets where name = ${name}`（`name` は `ig-token-<accounts.id>`。内部の uuid で、Instagram の ID は含めない） |
| 作る | `select vault.create_secret(${token}, ${name}, ${description}) as id` |
| 更新 | `select vault.update_secret(${id}, ${token})` |

ローカルの `postgres` ロールはスーパーユーザーなので読める。R2 の Supabase Cloud でも `postgres` ロールは Vault を読める前提だが、R2 の最初に確かめる（11.1 章 P6）。`vault.secrets.name` に一意制約があるかも P6 で確かめる（なければ `name` での検索は先頭の 1 件を使い、重複はエラーにする）。トークンの値は `JobGraphClient` の中にだけ持ち、戻り値、ログ、`job_runs.error`、`raw_api_responses` に入れない（NF-SEC-01、NF-SEC-06）。Vault の操作の失敗は固定文言（1.2 章）で記録する。

### 3.4 トランザクションの単位

「API の呼び出し 1 回で得た項目の行」を 1 つのトランザクションにする。生レスポンスは**自動コミットで先に入れ**、項目の行から `raw_response_id` で参照する（項目の書き込みが失敗しても、生レスポンスは残る）。

| 処理 | 1 トランザクション |
|---|---|
| register-token | `accounts` の upsert ＋ Vault の作成または更新 ＋ `private.credentials` の upsert（`vault.create_secret` は `vault.secrets` への insert なので、同じトランザクションでロールバックされ、孤児が残らない） |
| profile_daily | `profile_daily` の upsert ＋ `accounts.username/name` の更新 |
| account_daily、account_backfill | 1 日 1 グループ（5.2 章）の指標の行の upsert。日が終わるごとに `job_state` の更新（backfill） |
| media_sync | 1 ページ分の `media` の upsert。全ページ読み切った後の `markGone`。サムネイルはトランザクションの外で保存し、成功したら `thumbnail_path` を別に更新 |
| media_snapshot、stories | 1 メディア分の `media_insight_snapshots` 1 行。動画解析は `video_analyses` 1 行 ＋ `video_cuts` 全行で 1 トランザクション |

`job_runs` の insert と update もトランザクションの外（自動コミット）で行い、途中で失敗しても `running` → `failed` の記録が残るようにする。

### 3.5 型の扱い（`db/client.ts`、`db/types.ts`）

- 行の型は `db/types.ts` に手で書く（コード生成は入れない）。12 表すべての行の型を土台の段階で書き切る（10.4 章）。
- `bigint`（`job_runs.id`、`raw_api_responses.id` など）は postgres.js の既定どおり **文字列** で扱う。四則演算はしないので十分。
- `timestamptz` は `Date`。書き込みも `Date` で渡す。
- `date`（`profile_daily.captured_on`、`account_daily_metrics.metric_date`）は **`YYYY-MM-DD` の文字列**で扱う。postgres.js の既定では `date` も `Date`（UTC 0 時）に変換され、日本時間に直すと日付がずれる。`types` オプションで `date`（oid 1082）の変換を外し、文字列のまま返す。結合テストで `select '2026-10-01'::date` が文字列で返ることを確かめる。
- `jsonb` は既定でオブジェクトになる。書き込みで型が推定できない場所は `sql.json(value)` を使う。
- `numeric`（`video_analyses.scene_threshold`、`fps`、`video_cuts.scene_score`、ビューの `metric_value()` の戻り）は postgres.js では**文字列**で返る。行の型では `number` にし、`db/*.ts` の読み出しで `Number()` に変換する。書くときは数値を渡す。
- 列名は DB のスネークケースのまま行の型にし、変換しない（SQL とのずれをなくす）。

### 3.6 サムネイルの保存先（Storage）

バケット `thumbnails`（非公開。マイグレーション `20261001100100`）に入れる。入れ方の比較。

| 候補 | 利点 | 欠点 |
|---|---|---|
| **A. Storage の REST API を `fetch` で呼ぶ（採用）** `POST {SUPABASE_URL}/storage/v1/object/thumbnails/{path}`、ヘッダ `Authorization: Bearer <サービスロールキー>`、`apikey: <同じキー>`、`x-upsert: true` | 依存パッケージなし。ローカルと R2 で URL とキーを替えるだけ | 署名などを自分で書かない分、機能は最小 |
| B. `@supabase/supabase-js` の `storage.from().upload()` | 書きやすい | ワーカーに依存が増える。他で使わない |
| C. S3 互換プロトコル | 汎用ツールが使える | S3 のアクセスキーの発行と署名（AWS SDK）が要る。ローカルでも設定が増える |

A を採る。環境変数は `SUPABASE_URL`（ローカルは `http://host.docker.internal:54321`）と `SUPABASE_SERVICE_ROLE_KEY`（`supabase status` の service_role キー）。パスは `{account_id}/{media_id}.jpg`。`account_id` は内部の uuid、`media_id` は Instagram のメディア ID（非公開のバケットなのでパスに使ってよい）。

縮小は ffmpeg で行う（`ffmpeg -y -i in -vf scale=320:-2 -frames:v 1 -q:v 4 out.jpg`）。画像ライブラリ（sharp など）を入れずに、既にイメージにある ffmpeg を使う。幅 320 ピクセルは一覧表示用（NF-CAP-03）。元の画像のダウンロードは `lib/download.ts`（3.7 章）で行い、一時ファイルは `saveThumbnail` の `finally` で削除する（DB 設計 5.1 章）。

接続解除時のサムネイルの削除（`storage.objects` の `bucket_id = 'thumbnails' and name like '{account_id}/%'`）は接続画面の設計（F-COL-01、NF-CMP-02）で扱う。R1 では README に SQL の手順を書く（10.4 章の段階 3）。R2 でサービスロールキーの代替を検討する（12 章）。

### 3.7 外部からのダウンロード（`lib/download.ts`）

動画（5.6 章）とサムネイルの元画像（5.4 章）のダウンロードは、1 つの関数 `downloadToFile(url, destPath, limits)` にまとめ、次の制限を掛ける。

| 制限 | 内容 |
|---|---|
| スキーム | `https:` のみ |
| ホスト | 許可リストに後方一致（初期値 `*.cdninstagram.com`、`*.fbcdn.net`。R0 の `media_url` は `scontent-*.cdninstagram.com` と `scontent-*.xx.fbcdn.net` だった。P2 で実機の `media_url` のホストを記録して確定する） |
| リダイレクト | `redirect: 'error'`（追わない） |
| 時間 | `AbortSignal.timeout(60_000)` |
| 大きさ | 受信バイト数の上限 200MB。超えたら中断して一時ファイルを消す |
| 失敗の記録 | `DownloadError` の `message` は固定文言（`許可されていない URL`、`サイズ上限を超過`、`タイムアウト`、`HTTP <status>`）。URL を含めない |

判定は純粋関数 `isAllowedDownloadUrl(url, allowedHosts)` に切り出して単体テストする。

---

## 4. トークンの登録と確認

### 4.1 `register-token` コマンド（`commands/register-token.ts`）

入力は `.env` の `META_ACCESS_TOKEN`、`META_APP_ID`、`META_APP_SECRET`（`debug_token` に必要）、`IG_USER_ID`（ページトークンでは必須。R0 検証 2.7 章）。`config.ts` の `loadRegisterTokenConfig()` で読む。`META_ACCESS_TOKEN` を読むのはこのコマンドと `verify-api` だけで、ジョブは読まない。登録が済めば `.env` から消してよい（README に書く。段階 3）。

1. `GET debug_token?input_token=<token>` をアプリトークン（`appId|appSecret`）で呼ぶ（`verify-api.ts` の `checkToken` と同じ）。`is_valid` が false なら登録せずに終わる。この呼び出しは `raw_api_responses` に保存しない。
2. `GET {IG_USER_ID}?fields=id,username,name` を登録するトークンで呼び、アカウントに届くことを確かめる。
3. **1 つのトランザクション**で: `accounts` を `ig_user_id` で upsert（`username`、`name`、`fb_page_id` は `debug_token` の `profile_id`（ページトークンのとき）、`status = 'active'`）→ Vault を `name = ig-token-<accounts.id>` で探し、あれば `update_secret`、なければ `create_secret` → `private.credentials` を upsert（`token_type`、`expires_at`（0 なら null）、`data_access_expires_at`、`scopes`、`status = 'valid'`、`last_checked_at = now()`）。
4. 標準出力には、種類、有効期限、データアクセス期限の残り日数、権限だけを出す（トークンと ID は出さない）。失敗は固定文言（1.2 章）で出す。

同じトークンで 2 回実行しても結果は同じになる（F-COL-20）。再承認で新しいトークンを得たときも、このコマンドで入れ替える。

必要な権限は `instagram_basic`、`instagram_manage_insights`、`pages_read_engagement` の 3 つとする（`pages_show_list` は `me/accounts` にだけ要り、収集では使わない。NF-SEC-05）。不足していれば警告を出すが、登録は行う（`status = 'insufficient_scope'`）。

### 4.2 `token_check` ジョブ（`jobs/token-check.ts`）

| 項目 | 内容 |
|---|---|
| 頻度 | 1 日 1 回。daily グループの先頭 |
| 入力 | `private.credentials` と Vault のトークン、`META_APP_ID`、`META_APP_SECRET`（必須。11.2 章 Q5） |
| API | `GET debug_token?input_token=<token>`（アプリトークンで。`persist: false` で生レスポンスを保存しない） |
| 書き込み | `private.credentials` の `expires_at`、`data_access_expires_at`、`scopes`、`status`、`last_checked_at`、`last_error` |
| items_fetched | 1 |

条件ごとの振る舞い:

| `debug_token` の結果 | `private.credentials` | ジョブの状態 |
|---|---|---|
| `transient` で失敗（再試行後） | 触らない | `failed` |
| `fatal` で失敗（アプリシークレットの誤りなど） | `status = 'error'`、`last_error = 'debug_token に失敗（コード N）'`、`last_checked_at` | `failed` |
| 応答が `is_valid: false` | `status = 'expired'`、`last_error = 'トークンが無効（debug_token）'`、期限、`last_checked_at` | `success`（確認は済んだ）。`warn` の行を出す |
| 必要な権限が足りない | `status = 'insufficient_scope'`、`scopes`、期限、`last_checked_at` | `success`。`warn` の行を出す |
| 有効で権限も足りる | `status = 'valid'`、`scopes`、期限、`last_checked_at`、`last_error = null` | `success`。データアクセス期限の残りが 14 日以下なら `warn` の行を足す（R2 で通知に変える） |

### 4.3 ジョブ実行中の失効の検出

どのジョブでも、Graph API がコード 190 を返したら `private.credentials.status = 'expired'`、`last_error` を更新してジョブを `failed` で止める（1.4 章）。次の `token_check` が `valid` に戻すまで、他のジョブは最初の呼び出しで止まる（API を 1 回呼んで失敗を記録する）。収集ログ画面（F-UI-02）には `failed` が並び、接続状態の画面（F-UI-01）には `expired` が出る。

---

## 5. ジョブごとの仕様

### 5.0 共通

- アカウントの ID は `accounts.ig_user_id` を DB から読む。`.env` の `IG_USER_ID` は `register-token` だけが使う。
- 「取れなかった値は null、対象外はキーなし（JSON）または行なし、0 は 0」（DB 設計 3.4 章、3.6 章）。
- ジョブが使う「今日」（`account_daily` の D、`profile_daily` の `captured_on`、follower_count の窓）は、**ジョブ開始時刻 `ctx.startedAt` から 1 回だけ**求める。JST 23:59 や PT 23:59 に実行しても、途中で日付が変わらない。
- 時刻の計算は `lib/time.ts` の純粋関数で行う。
  - `zonedDate(d: Date, tz: 'America/Los_Angeles' | 'Asia/Tokyo'): string` → `YYYY-MM-DD`
  - `zonedMidnightUtc(date: string, tz): Date` → その日の 0 時（タイムゾーン付き）を UTC の `Date` で
  - `pacificDayRange(date: string): { since: number; until: number }` → API の `since`/`until`（UNIX 秒）。初期値は `since = zonedMidnightUtc(date, PT)`、`until = zonedMidnightUtc(翌日, PT) − 1 秒`（夏時間の切り替え日は 1 日が 23 時間または 25 時間なので、`since + 86399` にしない）。正しい範囲は実装の最初に確かめて確定する（11.1 章 P3）
  - `metricDateFromEndTime(endTime: string): string` → time_series の `end_time` から PT の日付へ。初期値は「`end_time` の PT の日付の前日」。P3 で確定する
  - `elapsedSeconds(postedAt: Date, fetchedAt: Date): number`
  - `storyExpiresAt(postedAt: Date): Date` → 24 時間後
  - `addDays(date: string, n: number): string`
  - Node 24 の公式イメージは ICU を含むので `Intl.DateTimeFormat` のタイムゾーン変換が使える。ライブラリは入れない。夏時間の切り替わり（2026-03-08、2026-11-01）をテストに入れる

### 5.1 プロフィール日次（`profile_daily`）

| 項目 | 内容 |
|---|---|
| 頻度 | 1 日 1 回（daily グループ）。F-COL-10、要件 5.2 章 |
| 入力 | なし |
| API | `GET {ig_user_id}?fields=id,username,name,followers_count,follows_count,media_count`（1 回） |
| 書き込み | `profile_daily` を (account_id, captured_on) で upsert。`captured_on` はジョブ開始時刻の **JST の日付**（DB 設計 3.3 章。5.0 章）。`captured_at` は取得時刻。`accounts.username`、`name` も更新 |
| 欠損 | 返らなかったフィールドは null |
| 失敗 | API が失敗したら `failed`。同じ日に再実行すれば上書きされる |
| partial | 起きない（1 件のみ） |
| items_fetched | 1 |

### 5.2 アカウント日次指標（`account_daily`）と follower_count

| 項目 | 内容 |
|---|---|
| 頻度 | 1 日 1 回（daily グループ）。F-COL-11 |
| 対象の日 | ジョブ開始時刻の PT の日付を D として、**D−4 から D−1 の 4 日**（完結した日だけ。進行中の D は取らない）。反映遅延が最大 48 時間あるため毎回取り直して上書きする（要件 2.2 章）。4 日にするのは、daily を 1 日欠かしても、どの日も「閉じてから 48 時間以上後」に 1 回は取り直されるようにするため（3 日では、欠かした回の D−3 が 48 時間未満の値のまま固定される）。`--days N` で日数を変えられる |
| API（指標） | `GET {ig_user_id}/insights?metric=<指標>&period=day&metric_type=total_value[&breakdown=<内訳>]&since=<秒>&until=<秒>`。1 日あたり、内訳の種類ごとにまとめた 4 リクエスト（下表）。まとめて取れない場合は 1 指標 1 リクエスト（17 回） |
| API（follower_count） | `GET {ig_user_id}/insights?metric=follower_count&period=day&since=<zonedMidnightUtc(D−29, PT) の UNIX 秒>&until=<ジョブ開始時刻>`（1 回）。`since` を PT の 0 時基準にするのは、`now − 30×86400 秒` だと夏時間の切り替え（2026-03-08）をまたぐ窓で PT の暦日が 30 日を超え、API のエラー（V5「last 30 days excluding the current day」）になりうるため。`values[]` の各要素を `metric_date = metricDateFromEndTime(end_time)` の行にする。直近 30 日しか取れない（V5）ので毎日取り直す |
| 書き込み | `account_daily_metrics` を主キー (account_id, metric_date, metric, breakdown, breakdown_value) で upsert |
| items_fetched | upsert した行数 |

リクエストのまとめ方（`jobs/account-metrics.ts` の定数 `ACCOUNT_METRIC_GROUPS`）。`breakdown` はリクエスト全体に効くので、内訳の種類ごとに分ける。

| グループ | breakdown | metric | 書き込む行 |
|---|---|---|---|
| 内訳なし | なし | reach, views, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, reposts, follows_and_unfollows, profile_links_taps | `(date, metric, '', '', total_value.value)` |
| フォロワー別 | `follow_type` | reach, views, follows_and_unfollows | 印の行 `(date, metric, 'follow_type', '', total_value.value)` と、内訳の値ごとに `(date, metric, 'follow_type', dimension_values[0], value)` |
| 投稿の種類別 | `media_product_type` | reach, views, total_interactions | 同上 |
| ボタン別 | `contact_button_type` | profile_links_taps | 同上 |

R0 では 1 指標ずつ検証した（2.2 章）。複数指標を 1 回で取れるかは未検証（3 章）なので、実装の最初に確かめる（11.1 章 P1）。`follows_and_unfollows` と `profile_links_taps` の内訳なしも R0 では試していないので P1 に含める。取れないものは内訳なしグループから外す。

まとめて取るリクエストがコード 100 で失敗したら、そのグループを 1 指標ずつ取り直す（新しい廃止があっても、その指標だけが欠けて済む）。1 指標ずつでも失敗した指標は、内訳なしの行を `value = null` で書く（欠損）。

**内訳の行の意味づけ**（DB 設計 3.4 章にも記す）:

- **内訳なしの行** `(metric, '', '')` が「その日その指標を取得した」印。行がなければ未取得。
- **内訳つきのリクエストの印の行** `(metric, breakdown, '')`: 内訳つきのリクエストが成功したら 1 行書き、`value` にはそのレスポンスの `total_value.value` を入れる（内訳なしの行とは主キーが衝突しない）。
- 内訳の値の行は API が返した値だけ書く。規則は「**内訳の値の行がなく、同じ breakdown の印の行があれば 0。印の行がなければ未取得**」。
- 内訳のリクエストだけが失敗した日は、印の行も内訳の行も書かれない（未取得）。`partial` になり、翌日の取り直しで埋まる。4 日の窓を過ぎても埋まらなければ `account-daily --days N` で手で取り直す。
- API が 0 の区分を返すかどうか（P4）はこの規則に影響しない。返すなら 0 の行が入り、返さないなら印の行から 0 と判る。

| 失敗の扱い | 内容 |
|---|---|
| 一部の日やグループが失敗 | 書けた分は upsert し、`partial` |
| レート制限で停止 | 書けた分まで。`partial` または `skipped` |
| follower_count の失敗 | 他の指標とは独立。失敗したら `partial` |

### 5.3 アカウント日次指標のバックフィル（`account_backfill`）

| 項目 | 内容 |
|---|---|
| 頻度 | hourly グループの最後（レート制限の余裕があるときだけ進む）。F-COL-12、要件 5.2 章 |
| 範囲 | **D−1** から過去へ向かって、API が「2 年」のエラー（V1）を返すか、D−730 に達するまで。新しい日から古い日へ進める（新しい日の方が分析で先に使うため）。daily の 4 日の窓と重なるが upsert なので無害で、`metric_date` が D−1 から途切れずに続くことを保証できる。follower_count は対象外（30 日分は 5.2 章で取る） |
| 状態 | `job_state`（job_name = `account_backfill`）の `state`: `{"next_date": "YYYY-MM-DD", "oldest_date": "YYYY-MM-DD", "done": false, "days_done": 123, "failed_dates": [{"date": "YYYY-MM-DD", "attempts": 1}]}`。`next_date` が次に取る日。1 日終えるごとに更新する（中断しても続きから） |
| shouldRun | `done` が true なら実行しない（`job_runs` に行を作らない） |
| 1 回の上限 | `WORKER_BACKFILL_MAX_DAYS`（既定 30 日）。1 日 4 リクエストなら 120 回、1 指標ずつなら 510 回。R0 では 110 回で使用率 1%（2.6 章）なので、どちらでも 1 回の実行は 5% 以内に収まる見込み |
| レート制限 | 開始時と各日の前に使用率を見て、`WORKER_RATE_SOFT_LIMIT`（既定 50%）以上なら止める（7 章）。通常の収集に余裕を残すため、他のジョブより低いしきい値にする |
| 取り方と書き込み | 5.2 章と同じ関数（`fetchAccountDay(ctx, date)`）を 1 日ずつ呼ぶ |
| 失敗した日 | その日の一部でも失敗したら `failed_dates` に加えて（既にあれば `attempts` を増やして）次の日へ進む。通常の日をすべて終えたら、`attempts < 3` の日を取り直す。3 回失敗した日はそのまま残して `done = true` にし、ログに件数を出す。残った日は `account-daily --days N` の手動実行か、下の手順で埋める |
| 終了 | 2 年のエラーが返ったら、その日は取らずに `done = true`。D−730 に達しても `done = true` |
| partial | 途中の日まで進んで止まった。`job_state` に残っているので次回に続く。`error` に止まった理由（レート制限、API エラー） |

「2 年」のエラーの判定（純粋関数 `isHistoryLimitError(error)`）: R0 の生レスポンスでは `code` が 100、`error_subcode` なし、メッセージが `(#100) since param is not valid. Metrics data is available for the last 2 years` だった（「does not support」のエラーも同じく code 100、subcode なし。subcode では区別できない）。判定は「`code === 100` かつ メッセージに `available for the last 2 years` を含む」とする。文言の変更に備え、`next_date` が D−700 より古い日で `code === 100` のエラーがこの判定に当たらなかったときは、`warn` の行（`2 年の判定に失敗した可能性 error_code=100`）を出し、その日を `failed_dates` に入れて先へ進む（`done` にはしない。3 回失敗で止まる）。実装の最初に同じエラーをもう一度起こして確かめる（11.1 章 P10）。

やり直しの手順: `delete from public.job_state where job_name = 'account_backfill' and account_id = '<accounts.id>'` を実行すると、次の実行で D−1 から始まる（すべて upsert なので既存の行は上書きされるだけ）。

見込み: 730 日 ÷ 30 日 = 25 回の実行。hourly なら 1〜2 日で終わる。昼間に PC を止めていても再開できる。

### 5.4 投稿一覧の同期（`media_sync`）

| 項目 | 内容 |
|---|---|
| 頻度 | 1 時間ごと（hourly グループ、差分）。1 日 1 回（daily グループ、`--full`）。F-COL-13、F-COL-17 |
| API | `GET {ig_user_id}/media?fields=id,media_type,media_product_type,timestamp,caption,permalink,thumbnail_url,media_url&limit=50`。次のページは `paging.cursors.after` を `after` に渡す（`paging.next` は使わない。URL にトークンが含まれる） |
| 差分（既定） | ページを順に読み、**新しい ID が 1 つもないページ**が来たら止める。初回は `media` が空なので全ページを読む（F-COL-14 の前提） |
| `--full` | 全ページを読む。**全ページを失敗なく読み切り、レート制限でも止まらなかったときだけ** `markGone` を呼び、一覧に**なかった**投稿（`media_product_type` が `FEED` か `REELS` で `gone_at` が null）に `gone_at = now()` を入れる。1 ページでも失敗したら消失判定をせず `partial`。一覧に戻ってきた投稿（アーカイブ解除）は upsert で `gone_at = null` に戻す |
| 書き込み | `media` を `id` で upsert。insert 時: 全列、`first_seen_at = now()`。update 時: `caption`、`permalink`、`media_type`、`media_product_type`、`last_synced_at = now()`、`gone_at = null`。`first_seen_at` と `thumbnail_path` は update で触らない。戻り値にサムネイル未保存（`thumbnail_path` が null）の ID を含める |
| サムネイル | `thumbnail_path` が null の投稿だけ保存する。元の URL は `IMAGE` では `media_url`、`VIDEO` では `thumbnail_url`、`CAROUSEL_ALBUM` では親の `media_url`（返らなければ `{media_id}/children?fields=media_url` の先頭。11.1 章 P9）（純粋関数 `thumbnailSource(item)`）。`downloadToFile`（3.7 章）→ ffmpeg で縮小 → Storage に upsert → `thumbnail_path` を更新。失敗しても投稿の行は残し、次回に再試行する（null のまま）。`failures` は増やす |
| フラグ | `is_collab`、`is_trial_reel`、`is_boosted` は R1 では null（DB 設計 3.5 章）。判定できるフィールドがあるかは実装時に見る（11.1 章 P7） |
| items_fetched | 一覧で読んだ投稿の数。ログには `new=` と `gone=` も出す |
| partial | あるページの取得が失敗した（それより前のページは書けている。消失判定はしない）。または、サムネイルの保存の失敗（投稿の行は書けている） |

投稿一覧には**ストーリーズは含まれない**。ストーリーズは 5.6 章で別に扱う。

カルーセルの子メディアは R1 では取らない（DB 設計 3.5 章）。

### 5.5 投稿指標のスナップショット（`media_snapshot`）

| 項目 | 内容 |
|---|---|
| 頻度 | 1 時間ごと（hourly グループ）。F-COL-14、F-COL-15 |
| 対象 | `media_product_type` が `FEED` か `REELS` で `gone_at` が null の投稿のうち、下の規則で「今回取るべき」もの。新しい投稿から順に処理する |
| API | 1 投稿 1〜2 リクエスト。`GET {media_id}/insights?metric=<種類ごとの一覧>`（内訳なし）。`FEED` では加えて `GET {media_id}/insights?metric=profile_activity&breakdown=action_type` |
| 書き込み | `media_insight_snapshots` に 1 行（`fetched_at` はリクエスト直前の時刻、`elapsed_seconds = elapsedSeconds(posted_at, fetched_at)`、`metrics` は JSON、`raw_response_id`、`job_run_id`）。一意制約 (media_id, fetched_at) に当たったら何もしない（`insertSnapshot` は false を返す） |
| 複数リクエストの一部が失敗 | 内訳なしのリクエストが成功していれば行を書き、失敗した内訳の指標は null にする。`raw_response_id` は内訳なしのレスポンス。`failures` は増やす |
| `fatal` で失敗した投稿 | **期待する指標をすべて null にしたスナップショット行を書く**（`raw_response_id` にはエラーのレスポンスを結ぶ）。取得したが取れなかった＝欠損（F-COL-22）。この行が「前回」になるので、次回は通常の間隔で再試行される |
| `transient` を使い切った投稿 | 行を書かない（レスポンスがない）。次回の対象になる。`failures` は増やす |
| items_fetched | 書いたスナップショットの数（null だけの行も含む） |
| partial | 一部の投稿で失敗した。またはレート制限で途中で止まった |

**取得対象の選定**（純粋関数 `isSnapshotDue(postedAt, lastFetchedAt, now)`。単体テストの中心）:

1. スナップショットが 1 つもない投稿は常に対象（初回の全投稿の取り込み。F-COL-14。初回は投稿数だけリクエストが出る。R0 の実績から 300 投稿で 3% 程度）。
2. それ以外は、**前回のスナップショット時点の経過時間**（`last_fetched_at = max(fetched_at)`）で間隔を決め、前回から「間隔 − 10 分」以上経っていれば対象にする。10 分は実行時刻のゆれの吸収。

| 前回時点の経過時間 | 間隔 | 要件 5.2 章 |
|---|---|---|
| 24 時間まで | 1 時間 | 投稿後 24 時間まで 1 時間ごと |
| 30 日まで | 1 日 | 2〜30 日目 |
| 90 日まで | 1 週間 | 31〜90 日目 |
| 90 日超 | 30 日 | 91 日目以降 |

「前回時点」で決めるのは、境目をまたいだ直後の取得を落とさないため。例: 前回が 23 時間時点（間隔 1 時間）なら 24 時間時点で取る。その次は 24 時間時点が前回になり、間隔 1 日で 48 時間時点になる。

**指標の一覧**（`jobs/media-metrics.ts` の定数 `MEDIA_METRICS_BY_TYPE`。R0 検証 2.4 章と `metric_definitions` に合わせる）:

| 種類 | 内訳なしで 1 回 | 内訳つきで別に 1 回 |
|---|---|---|
| `FEED`（IMAGE、CAROUSEL_ALBUM、VIDEO） | views, reach, likes, comments, saved, shares, reposts, total_interactions, profile_visits, follows | profile_activity（action_type） |
| `REELS` | views, reach, likes, comments, saved, shares, reposts, total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time, reels_skip_rate | なし |

カルーセルとフィード動画は未検証（R0 検証 3 章）なので、まとめた取得がコード 100 で失敗したら 1 指標ずつ取り直す。「does not support」のエラー（R0 では code 100、subcode なし、メッセージ `The Media Insights API does not support ...`。純粋関数 `isUnsupportedMetricError`）が返った指標はキーなし（対象外）、それ以外のエラーは null（欠損）にする。1 指標ずつに落ちたことと、code 100 なのに「does not support」に当たらなかったことは `warn` の行（`error_code=100`）で出し、定数と判定を直す材料にする。2 年より前の投稿や、プロアカウントに切り替える前の投稿で指標が取れるかは未検証（11.1 章 P10）。

**JSON の組み立て**（純粋関数 `toMediaMetrics(expected, responses)`）: 種類ごとの期待する指標をキーにし、レスポンスの `data[].values[0].value` を値にする。期待したのに返らなかった指標は null。内訳つきは `{"profile_activity": {"bio_link_clicked": 3, ...}}` のように入れ子にし、内訳の値（`dimension_values[0]`）は小文字にする（ビューの `{navigation,tap_exit}` に合わせる）。

### 5.6 ストーリーズ（`stories`）

| 項目 | 内容 |
|---|---|
| 頻度 | 1 時間ごと（hourly グループの先頭。24 時間で消えるため最優先）。F-COL-16、F-COL-23 |
| API（一覧） | `GET {ig_user_id}/stories?fields=id,media_type,media_product_type,timestamp,caption,permalink,media_url,thumbnail_url`。ページングがあれば `after` で追う（11.1 章 P8） |
| API（指標） | 1 枚 2〜3 リクエスト。内訳なし: views, reach, replies, shares, reposts, total_interactions, profile_visits, follows, link_clicks（R0 で 9 指標を 1 回で取れた）。内訳つき: navigation（story_navigation_action_type）、profile_activity（action_type） |
| 書き込み（一覧） | `media` を upsert（`media_product_type = 'STORY'`、`expires_at = posted_at + 24h`）。サムネイルは 5.4 章と同じ扱い |
| 書き込み（指標） | 一覧にある**すべて**のストーリーズについて毎回 `media_insight_snapshots` に 1 行（5.5 章の間隔の規則は使わない）。`stories` を続けて 2 回実行すると同じストーリーズに 2 行入るが、これは「実行ごとに 1 行」という仕様で、F-COL-20 の重複ではない（`fetched_at` が違う別の時点の値。確定値は最後の行）。失敗の扱いは 5.5 章と同じ（`fatal` は null の行、一部失敗は null の指標） |
| 確定値 | 消える前の最後の行が確定値で、ビュー `story_final_metrics` と `media_metrics_at_horizon` の `latest` で取り出す（DB 設計 3.6 章、6.1 章）。**24 時間時点の値は構造的に取れない**（一覧にある間しか取れず、経過時間は最大 23 時間 59 分）。1 時間ごとの取得なので確定値は消える 0〜60 分前の値になる |
| 消えたものの扱い | **一覧を全ページ失敗なく読み切ったときだけ**、`expires_at` が **10 分以上先**なのに一覧にないストーリーズ（手で削除）に `gone_at = now()` を入れる（`markGone` に `onlyExpiresAfter: now + 10 分` を渡す。API 側の消える時刻が数分ずれても「手で削除」と誤記録しないための余裕）。一覧の取得が一部でも失敗したら消失判定はしない。`expires_at` が 10 分以内か過去のものは何もしない（それが正常） |
| 動画の解析 | `media_type = 'VIDEO'` で、(media_id, `ANALYZER_VERSION`, `DEFAULT_SCENE_THRESHOLD`) の最新の `video_analyses` が `success` でないものを解析する（下記）。`failed` と `no_video_url` は、前回の `analyzed_at` から **3 時間以上**経っていれば再試行する（純粋関数 `isAnalysisRetryDue`。一覧にある間の再試行を最大 7 回程度に抑える） |
| items_fetched | スナップショットを書いた枚数。ログに `videos_analyzed=` も出す |
| partial | 一部の枚の指標取得か動画解析が失敗した。一覧の取得が一部失敗した。一覧の取得が最初から失敗したら `failed` |

**動画の解析**（`lib/video-analysis.ts`）:

1. `media_url` がなければ `video_analyses` に `status = 'no_video_url'` で upsert して終わる。
2. `downloadToFile`（3.7 章）で一時ディレクトリ（`mkdtemp`、接頭辞 `worker-video-`）に落とす。
3. `probeVideo` と `detectSceneChanges`（`lib/ffmpeg.ts`。しきい値 `DEFAULT_SCENE_THRESHOLD = 0.3`）を実行する。
4. `video_analyses` を一意キー (media_id, analyzer_version, scene_threshold) で upsert し、`video_cuts` をその `analysis_id` で削除してから全行 insert（1 トランザクション）。特徴量は純粋関数 `summarizeCuts(durationMs, cutTimesMs)` で計算する（`cut_count`、`avg_scene_ms`、`first_cut_ms`、`cuts_in_first_3s`）。
5. `finally` で一時ディレクトリを削除する（F-COL-23、NF-CAP-03。動画は残さない）。
6. 失敗したら `status = 'failed'`、`error` に `sanitizeForLog(error.message)`（`DownloadError` は固定文言。URL を含めない）。

`ANALYZER_VERSION` は `lib/video-analysis.ts` の定数（初期値 `"1"`）。シーン検出の方法を変えたら上げる（F-VID-04）。R4 でリールを解析するときも同じ関数を使う。

ストーリーズの `media_url` から動画をダウンロードできるかは R0 ではリールでしか確かめていない（DB 設計 5.2 章）。実装の最初に確かめる（11.1 章 P2）。取れない場合は、`no_video_url` が記録されるだけで、他の処理は影響を受けない。

### 5.7 トークンの確認（`token_check`）

4.2 章のとおり。

---

## 6. 実行順と同時実行

### 6.1 グループの中の順番

| グループ | 順番 | 理由 |
|---|---|---|
| hourly（毎時 5 分） | 1. `stories` 2. `media_sync` 3. `media_snapshot` 4. `account_backfill` | ストーリーズは消えるので最優先。投稿一覧を先に同期してから新しい投稿のスナップショットを取る。バックフィルは余ったレート制限で進める |
| daily（JST 05:30） | 1. `token_check` 2. `profile_daily` 3. `account_daily` 4. `media_sync --full` | トークンの状態を先に更新する。残りは独立 |

グループの中のジョブは直列に動く。前のジョブが `failed` でも次に進む（NF-REL-01）。

### 6.2 二重起動の防止

| 層 | 方法 |
|---|---|
| スケジューラ内 | グループを直列に実行する。同時に due でも順に動かす |
| ジョブ | アドバイザリロック（1.2 章）。`postgres.js` の `reserve()` で接続を 1 本固定し、その接続でロックを取り、ジョブの間保持する。ジョブのクエリと `begin` はもう 1 本の接続で動く（`max: 2`）。プロセスが落ちると接続が切れてロックが自動で外れる |
| R2 の GitHub Actions | ワークフローの `concurrency` グループに加え、上のロックで別ワークフローの重なりも防ぐ |

ロックが取れなかったときは `skipped` で記録し、ログに出す。R1 のスケジューラでは起きないはずなので、起きたら設定の問題として調べる。

API の呼び出しはジョブの中でも直列（並列にしない）。1 時間ごとの処理量（ストーリーズ数枚 × 3 回 ＋ 投稿一覧 1〜2 ページ ＋ 直近投稿 数回）は 1 分以内に終わる。初回の全投稿の取り込みだけ数分かかる（300 投稿で約 4 分）。

---

## 7. レート制限

### 7.1 ヘッダの読み方（`lib/graph.ts` の `parseRateUsage`）

| ヘッダ | 形 | 使い方 |
|---|---|---|
| `X-Business-Use-Case-Usage` | `{"<business_id>": [{"type": "instagram", "call_count": 1, "total_cputime": 1, "total_time": 1, "estimated_time_to_regain_access": 0}]}` | 配列のすべての要素の 3 つの百分率の最大値を「使用率」とする。`estimated_time_to_regain_access`（分）があれば保持する |
| `X-App-Usage` | `{"call_count": 1, "total_cputime": 1, "total_time": 1}` | 同様に最大値を取り、上と合わせた最大を使用率にする |

`job_runs.rate_usage` には、ID を除いた `{"call_count": 1, "total_cputime": 1, "total_time": 1, "estimated_time_to_regain_access": 0}` を入れる（`verify-api.ts` の `usagePercentages` と同じ方針）。ヘッダがなければ null。

### 7.2 しきい値と振る舞い（`jobs/rate.ts` の `RateMonitor`）

| しきい値 | 既定 | 対象 | 超えたとき |
|---|---|---|---|
| `WORKER_RATE_HARD_LIMIT` | 90% | すべてのジョブ | 次の呼び出しの前に `RateLimitExceeded` を投げてジョブを止める。書けた分は残す（`partial` または `skipped`） |
| `WORKER_RATE_SOFT_LIMIT` | 50% | `account_backfill` | 開始時と各日の前に確かめ、超えていれば止める |

- 使用率は呼び出しのたびに更新する。ジョブの開始時には、直近 1 時間に終わった `job_runs.rate_usage` の最新値を初期値にする（GitHub Actions のように毎回新しいプロセスでも前の状態を引き継ぐ）。グループの中では、前のジョブの最終値をそのまま次のジョブに渡す。
- Graph API がレート制限のエラー（コード 4、17、32、613、80000〜80009、HTTP 429）を返したら、使用率に関係なくジョブを止める。`estimated_time_to_regain_access` があれば `job_runs.error` に残す。
- 止まったジョブは次の定期実行で再開する。投稿スナップショットは選定の規則で、バックフィルは `job_state` で、それぞれ続きから進む。

R0 の実測（110 回で 1%）から、通常の収集（1 日 300〜500 回）は 5% 程度と見込む。しきい値に当たるのは初回の取り込みとバックフィルの重なりだけのはずで、R1 の実測で見直す。

---

## 8. ログと通知

### 8.1 ログ（`lib/log.ts`）

標準出力に 1 行ずつ出す。GitHub Actions の実行ログは公開されるため（要件 2.3 章）、R1 から同じ規則で出す。

```text
2026-10-02T20:05:01.000Z INFO  job=stories status=success items=4 calls=13 failures=0 duration_ms=5120 rate=2%
2026-10-02T20:05:07.000Z WARN  job=media_snapshot status=partial items=12 calls=15 failures=1 error_code=100 class=fatal
2026-10-02T20:05:07.000Z DEBUG job=media_snapshot error="[100] Unsupported get request. Object with ID '***' does not exist"
```

| 出してよいもの | 出さないもの（NF-SEC-06） |
|---|---|
| ジョブ名、状態、件数、呼び出し回数、所要時間、使用率、`error_code=<コード> class=<分類>`、残り日数 | トークン、API のレスポンス本文、キャプション、URL、接続文字列、アカウントやメディアの ID、ユーザー名、例外の `stack` と `cause` |

- エラーの行には `error_code=<Graph のコードまたは SQLSTATE> class=<分類>` を**常に**出す。エラーメッセージの全文（マスク後）は `WORKER_LOG_LEVEL=debug` のときだけ `DEBUG` の行に出す。`job_runs.error` にはマスク後の全文を入れる（ログの `debug` と同じ文字列）。**GitHub Actions では `debug` を使わない**。
- ジョブごとの項目単位の行（1 投稿ごとなど）は出さない。`debug` では項目数の進み（`progress=120/300`）だけを出す。
- `schedule` はグループの開始と終了を 1 行ずつ出す。

**`sanitizeForLog(text)` は 2 段**で行う。ログ、`job_runs.error`、`private.credentials.last_error`、`video_analyses.error` に入れる文字列はすべてこの関数を通す。

1. 設定値ベース（`SecretRegistry`）: 起動時に `META_ACCESS_TOKEN`、`META_APP_SECRET`、`SUPABASE_SERVICE_ROLE_KEY`、`DATABASE_URL` のパスワード・ユーザー名・ホスト、`SUPABASE_URL` のホストを秘密の一覧に登録し、Vault から読んだトークンも読んだ時点で登録する。文字列に一致した部分を `***` に置き換える。
2. パターンベース（順に適用）:
   - `https?://\S+` → `<url>`
   - `postgres(ql)?://\S+` → `<db-url>`
   - `(access_token|input_token|appsecret_proof)=[^&\s]+` → `$1=***`
   - `Bearer \S+` → `Bearer ***`
   - 10 桁以上の数字列 → `***`（Graph API のエラー文にはメディア ID が入ることがある。10 桁の UNIX 秒や 13 桁のミリ秒も隠れるが、ログに時刻を数字で出す必要はないので許容する）

### 8.2 通知（R2 につなげる形）

R1 では通知を作らない。R2 の通知（F-SYS-14、NF-REL-03）は `job_runs` と `private.credentials` から判定できるように、必要な情報をすべて DB に残す。

| 通知したいこと | R2 で見る場所 |
|---|---|
| 収集が止まった | `job_latest_runs` の `started_at` が古い。または `stories` が 2 回続けて `failed`（`job_runs` を `started_at desc` で 2 行見る） |
| トークンの期限 | `account_connection_status.data_access_days_left`、`credential_status` |
| レート制限 | `job_runs.status = 'skipped'` が続く、`rate_usage` が高い |

---

## 9. テストの方針

### 9.1 単体テスト（vitest。`apps/worker/test/`）

純粋関数に切り出してテストする。DB と API に触らない。

| 関数（場所） | 確かめること |
|---|---|
| `isSnapshotDue`、`snapshotIntervalFor`（`jobs/media-snapshot.ts`） | 境目をまたぐ直後に取る: 前回 24h ちょうど／24h+1 秒、前回 30d ちょうど、90d ちょうど（「24 時間まで」が ≤ か < かをテストで固定する）。`now − last = interval − 10 分` ちょうど。スナップショットなしは常に対象。null だけの行も「前回」になる。停止後（前回 20h、now は 5 日後 → 対象。次の間隔は前回時点で決まるので 1h、その次は 1d）。`lastFetchedAt > now`（時計のずれ → 対象外）。`postedAt > now` → 対象外。`gone_at` は SQL 側の条件なので 9.2 章で確かめる |
| `elapsedSeconds`、`storyExpiresAt`、`zonedDate`、`zonedMidnightUtc`、`pacificDayRange`、`metricDateFromEndTime`、`addDays`（`lib/time.ts`） | `pacificDayRange('2026-11-01')` = [2026-11-01T07:00:00Z, 2026-11-02T07:59:59Z]、`pacificDayRange('2026-03-08')` = [2026-03-08T08:00:00Z, 2026-03-09T06:59:59Z]（`until` は翌日 0 時 − 1 秒で、`since + 86399` ではない）。`metricDateFromEndTime('2026-11-02T08:00:00+0000')` = `2026-11-01`、`('2026-11-01T07:00:00+0000')` = `2026-10-31`。JST の境界（UTC 14:59:59 → 当日、15:00:00 → 翌日）。PT の境界（PDT は UTC 06:59:59／07:00:00、PST は 07:59:59／08:00:00）。年末年始（PT の 12/31 と JST の 1/1）。月末の `addDays`。`elapsedSeconds` の切り捨て。follower_count の窓（D−29 の PT 0 時）が 2026-03-08 をまたいでも PT の暦日が 30 日を超えない |
| `toAccountDailyRows`（`jobs/account-metrics.ts`） | 内訳なしと内訳つきのレスポンスから行へ。印の行 `(metric, breakdown, '')` ＋ 値の行。値 0 は 0。`total_value` なし → null。`results` が空 → 印の行だけ。複数指標の順序に依存しない |
| `toMediaMetrics`、`isUnsupportedMetricError`（`jobs/media-metrics.ts`） | 期待した指標が返らなければ null、対象外（does not support）はキーなし、期待外の指標が返ったら無視する、`values[0]` なし → null、`value` が文字列 → 数値に変換できれば数値、内訳の入れ子と小文字化、内訳つきのリクエストの失敗で null、`fatal` のときに全部 null の JSON |
| `toMediaRow`、`thumbnailSource`、`shouldContinuePaging`（`jobs/media-sync.ts`）、`storagePath`（`storage/thumbnails.ts`） | 一覧の項目から `media` の行へ。種類ごとのサムネイルの元 URL。パスは `{uuid}/{media_id}.jpg`。差分の「新しい ID が 1 つもないページで止まる」（全部既知 → false、1 つでも新規 → true、空ページ → false） |
| `summarizeCuts`、`isAnalysisRetryDue`（`lib/video-analysis.ts`） | カットなし（`cut_count` 0、`avg_scene_ms` = 長さ、`first_cut_ms` null）、3000ms ちょうどのカット（冒頭 3 秒に含めるかを固定）、0ms のカット、長さを超えるカット（無視）。`failed` と `no_video_url` は 3 時間後に再試行、`success` は再試行しない、解析なしは対象 |
| `classifyGraphError`、`backoffDelay`（`lib/graph.ts`）、`isHistoryLimitError`（`jobs/account-backfill.ts`） | 4 分類: HTTP 500 本文なし、`fetch` の例外、本文が JSON でない、コード 1／2 → transient。4／17／32／613／80004、HTTP 429 本文なし → rate。190（subcode 463）、10／200／299 → auth。100（subcode 33）、300、未知のコード → fatal。「does not support」と「2 年」のメッセージ判定（code 100、subcode なし）。`backoffDelay`: 乱数を注入し、1 回目 2000〜3000ms、2 回目 8000〜9000ms、3 回目はなし |
| `parseRateUsage`、`RateMonitor`（`lib/graph.ts`、`jobs/rate.ts`） | 2 ヘッダの最大値、配列が複数要素、JSON でない文字列、片方だけ、ヘッダなし。ID を含めない。しきい値ちょうど（`exceeds` は ≥）。`estimated_time_to_regain_access` の保持。初期値は 1 時間より古い `job_runs` を使わない |
| `stripSecretParams`、`stripVolatileFields`（`jobs/graph-client.ts`） | `params` の `access_token`、`input_token`、`appsecret_proof` の除去。`data[].media_url`、`children.data[].media_url`、`thumbnail_url`、`profile_picture_url`、`access_token`、`paging.next`／`previous`（`paging.next` がない場合も）が `"<omitted>"` になり、`cursors` は残る。入力が変更されない |
| `sanitizeForLog`、`SecretRegistry`（`lib/log.ts`） | 登録した秘密（トークン、アプリシークレット、サービスロールキー、接続文字列のパスワード・ユーザー名・ホスト、`SUPABASE_URL` のホスト、Vault のトークン）が `***` になる。各パターン（`https://`、`postgresql://`、`access_token=`、`input_token=`、`appsecret_proof=`、`Bearer`）。数字: 9 桁は残る、10 桁は隠す、URL 内の数字、同じ行に複数回、`_` 区切りの数字。短い数字（コード、件数）と SQLSTATE は残る |
| `normalizeDbError`（`db/client.ts`） | 接続・認証・権限の失敗が固定文言 ＋ SQLSTATE になり、ホスト、ユーザー名、`query`、`parameters` を含まない |
| `isAllowedDownloadUrl`（`lib/download.ts`） | `https` のみ。`*.cdninstagram.com`、`*.fbcdn.net` の後方一致。`http`、別ホスト、`cdninstagram.com.evil.example` を拒む |
| `nextBackfillWindow`（`jobs/account-backfill.ts`） | `job_state` から次の日付の列（D−1 から）。上限日数。2 年の下限。`failed_dates` の取り直しと `attempts` の上限 3 |
| `dueGroups`（`jobs/scheduler.ts`） | `last` が undefined → 即実行。両方 due のときは daily → hourly。同じ時間帯に 2 回走らない。JST 05:29:59 は走らず 05:30:00 で走る。JST の日付が変わる UTC 15:00。再起動直後に DB から読んだ `last` が今日（JST）なら daily は走らない |
| `deriveJobStatus`（`jobs/framework.ts`） | 1.5 章の表。0 件 0 失敗 → success、全件失敗 → failed、rate 停止で 0 件 → skipped、rate 停止で 1 件以上 → partial、auth 停止 → 件数に関係なく failed |
| `loadWorkerConfig`（`config.ts`） | `WORKER_HOURLY_MINUTE`（60、−1、空）、`WORKER_DAILY_TIME_JST`（`5:30`、`24:00`、`05:60`）、しきい値（0、101）の書式検証。エラーに値が含まれない |
| `JobGraphClient`、`pages`（偽の `fetch`） | `transient` の試行回数（合計 3 回）と待ち時間、`rate` と `auth` を投げる、`fatal` を返す、`persist: false` で保存しない、レスポンスなしのとき `status: 0` と `rawResponseId: undefined`。ページング: `cursors.after` がなければ止まる、`after` を渡す、2 ページ目のエラーで止まる、`data` が空 |
| `token_check`（偽の `fetch` と偽の DB 関数） | 4.2 章の 5 条件 |

Graph API を呼ぶ処理は、`GraphClient` に `fetch` を注入できるようにして（コンストラクタの省略可能な引数）、偽の `fetch` でテストする。

### 9.2 結合テスト（ローカル Supabase）

`TEST_DATABASE_URL` が設定されているときだけ動かす（`describe.skipIf(!process.env.TEST_DATABASE_URL)`）。ホストから `npm run test -w worker` で実行し、接続先は `127.0.0.1:54322`。架空のアカウント（`ig_user_id` は `'000000000000'` のような偽の値）を作り、終了時に `accounts` の行を消す（CASCADE で関連する行も消える。NF-SEC-07）。Storage に作ったテスト用のオブジェクトも後始末する。

| 範囲 | 確かめること |
|---|---|
| `db/client.ts` | `date` が文字列で返る。`bigint` が文字列。`jsonb` がオブジェクト。接続失敗のエラーが固定文言になる |
| 各 upsert（`db/*.ts`） | 同じ入力で 2 回実行して行数が増えない（F-COL-20、NF-REL-02）。`media` の update で `first_seen_at` と `thumbnail_path` が変わらない。`insertSnapshot` が 2 回目に false を返す |
| `db/accounts.ts` | Vault に作る → 読む → 更新 → 読む。`name` で既存を見つける。`private.credentials` の insert を失敗させると Vault に孤児が残らない（同じトランザクション）。`private.credentials` を消すと Vault からも消える |
| `db/job-runs.ts` | running → success の流れ。`skipped` の行を開始と同時に書ける。ロック取得後に同じキーの `running` がすべて `failed` になる。ロックの取得と、別接続からの取得失敗。**ロック保持中に、もう 1 本の接続で通常のクエリと `begin` が完了する**（`max: 2`） |
| `db/media.ts` | `markGone` が `seenIds` にない行だけを対象にし、`onlyExpiresAfter` でストーリーズを絞れる |
| `jobs/framework.ts` | 偽の `fetch` と本物の DB で: 生レスポンスの保存（項目のトランザクションが失敗しても残る）、`partial` の判定、`RateLimitExceeded` での停止、コード 190 での `credentials.status` の更新と `failed`、`persist: false` で `raw_api_responses` に行がない |
| 秘密の非混入 | ジョブを偽の `fetch`（`paging.next` と `media_url` を含む応答、`access_token` を含むエラー）で動かし、`raw_api_responses` の `params` と `body`、`job_runs.error` を文字列化してもトークン、`access_token=`、署名付き URL を含まない。`job_runs.error` がマスク済み（10 桁以上の数字列と `://` を含まない） |
| `jobs/media-sync.ts` | ページの途中で `fatal` を返す偽の `fetch` で `--full` を動かすと `markGone` が呼ばれず `partial` になる。全ページ成功なら `gone_at` が入る |
| `db/snapshots.ts` | `listSnapshotCandidates` が `gone_at` のある投稿とストーリーズを返さず、`last_fetched_at` が最大の `fetched_at` になる |
| 各ジョブの書き込み経路 | 7 つのジョブそれぞれを同じ偽レスポンスで 2 回流して、どの表も行数が変わらない（`stories` は実行ごとに 1 行が仕様なので、`now` を固定して 2 回目の `insertSnapshot` が false になることで確かめる） |
| `storage/thumbnails.ts` | ローカル Supabase に 1 回アップロードし、同じパスへの upsert で上書きされる。テスト後に削除する |

ffmpeg が要るテスト（縮小、動画解析）はホストに ffmpeg がないので単体テストに入れず、コンテナ内の `check-env` で動作を確かめる。

### 9.3 3 日間の実機確認（R1 の完了条件）

`npm run worker:up` で 3 日間動かし、次を SQL で確かめる。

- `job_latest_runs` に 7 つのジョブがあり、`stories` と `media_snapshot` が毎時、`profile_daily` と `account_daily` が毎日ある。`running` のまま残っている行がない。
- `profile_daily` に 3 日分。`account_daily_metrics` の内訳なしの行が D−4〜D−1 の各日にそろい、内訳つきの印の行 `(metric, breakdown, '')` もある。
- `account_backfill` の `job_state.done` が true で、`account_daily_metrics` の `metric_date` が **D−1 から途切れずに**続いている（`failed_dates` が空）。
- 投稿後 24 時間以内の投稿に 1 時間ごとのスナップショットがある（`media_metrics_at_horizon` で 1h、3h、6h、24h が埋まる）。
- その間に投稿したストーリーズに毎時のスナップショットがあり、`media_metrics_at_horizon` で **1h、3h、6h と latest** が埋まる（24h は構造的に埋まらない）。動画なら `video_analyses` が `success` で `video_cuts` がある。
- `raw_api_responses` の `body` を文字列検索して `access_token=` と `cdninstagram.com` が含まれない。`job_runs.error` に 10 桁以上の数字列と `://` が含まれない。
- `docker compose logs worker` に `DEBUG` の行がなく、トークン、URL、ID が含まれない。
- 2 年より前の投稿など、指標が `fatal` で取れない投稿（P10）が毎時再試行されていない（null の行が 1 回入り、次は通常の間隔）。
- コンテナを 2 時間止めてから `npm run worker:up` すると、起動直後に hourly が走った記録が `job_runs` にある。
- 投稿を 1 件アーカイブして `media-sync --full` を実行すると `gone_at` が入り、戻して再実行すると null に戻る。
- 経過時間の基準値（1h〜7d）の確認は、収集を始めた後に投稿したもので行う（それより前の投稿は初回のスナップショットが最初の値になり、1h〜7d の基準値はその値で埋まるため）。

---

## 10. 実装の分割

### 10.1 モジュール

```text
apps/worker/src/
  index.ts                  コマンド登録（既存を拡張: 引数、プロセスの保険、ジョブとグループの登録）
  config.ts                 環境変数（11.3 章の全変数。process.env を読む唯一の場所）
  lib/graph.ts              既存 + fetch 注入、classifyGraphError、backoffDelay、parseRateUsage
  lib/ffmpeg.ts             既存 + resizeImage（サムネイル縮小）
  lib/log.ts                Logger、SecretRegistry、sanitizeForLog
  lib/time.ts               日付の純粋関数（PT、JST）
  lib/download.ts           downloadToFile、isAllowedDownloadUrl、DownloadError
  lib/video-analysis.ts     動画のダウンロード → 解析 → 行。ANALYZER_VERSION、summarizeCuts、isAnalysisRetryDue
  db/client.ts              postgres.js の接続（max: 2）、型の設定、normalizeDbError
  db/types.ts               12 表の行の型
  db/accounts.ts            accounts、private.credentials、Vault
  db/job-runs.ts            job_runs、job_state、アドバイザリロック
  db/raw.ts                 raw_api_responses
  db/profile.ts             profile_daily
  db/account-daily.ts       account_daily_metrics
  db/media.ts               media（upsert、thumbnail_path、markGone）
  db/snapshots.ts           media_insight_snapshots（listSnapshotCandidates、insertSnapshot）
  db/video.ts               video_analyses、video_cuts
  storage/thumbnails.ts     Storage REST へのアップロード、パス、saveThumbnail
  jobs/framework.ts         JobDefinition、JobContext、runJob、runJobsForActiveAccounts、deriveJobStatus
  jobs/rate.ts              RateMonitor、RateLimitExceeded
  jobs/graph-client.ts      JobGraphClient（再試行、生レスポンス保存、レート監視、ページング）、AuthError、stripSecretParams、stripVolatileFields
  jobs/account-metrics.ts   ACCOUNT_METRIC_GROUPS、fetchAccountDay、toAccountDailyRows
  jobs/media-metrics.ts     MEDIA_METRICS_BY_TYPE、fetchMediaInsights、toMediaMetrics、isUnsupportedMetricError
  jobs/token-check.ts       export const job
  jobs/profile-daily.ts     export const job
  jobs/account-daily.ts     export const job
  jobs/account-backfill.ts  export const job、nextBackfillWindow、isHistoryLimitError
  jobs/media-sync.ts        export const job、toMediaRow、thumbnailSource、shouldContinuePaging
  jobs/media-snapshot.ts    export const job、isSnapshotDue、snapshotIntervalFor
  jobs/stories.ts           export const job
  jobs/groups.ts            HOURLY_JOBS、DAILY_JOBS、runGroup
  jobs/scheduler.ts         dueGroups、常駐ループ
  commands/register-token.ts
  commands/schedule.ts
  commands/run-job.ts       ジョブ名からコマンドを作るヘルパ
apps/worker/test/           単体テスト（純粋関数）と db/*.test.ts（結合テスト）
```

### 10.2 モジュール間のインターフェース（型の例）

```ts
// config.ts（process.env を読むのはこのファイルだけ）
export interface WorkerConfig {
  databaseUrl: string; supabaseUrl: string; supabaseServiceRoleKey: string;
  graphApiVersion: string; metaAppId: string; metaAppSecret: string;
  hourlyMinute: number;                        // 0〜59
  dailyTimeJst: { hour: number; minute: number };
  backfillMaxDays: number; rateHardLimit: number; rateSoftLimit: number;   // 1〜100
  logLevel: 'info' | 'debug'; outputDir: string;
  downloadAllowedHosts: string[];              // 定数。環境変数にしない
}
export function loadWorkerConfig(): WorkerConfig;                       // 書式が不正なら変数名だけを示して throw
export function loadRegisterTokenConfig(): WorkerConfig & { accessToken: string; igUserId: string };

// lib/log.ts
export type LogFields = Record<string, string | number | boolean | undefined>;
export interface Logger { info(f: LogFields): void; warn(f: LogFields): void; debug(f: LogFields): void }
export class SecretRegistry { add(value: string | undefined): void; addUrlParts(url: string): void; mask(text: string): string }
export function sanitizeForLog(text: string, secrets: SecretRegistry): string;
export function createLogger(level: 'info' | 'debug', secrets: SecretRegistry): Logger;

// db/client.ts
export type Db = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type ReservedSql = postgres.ReservedSql;      // reserve() が返す 1 本固定の接続
export function connectDb(url: string): Db;          // max: 2、date は文字列
export function normalizeDbError(e: unknown): string; // 固定文言 + SQLSTATE。ホストや query を含めない

// db/accounts.ts
export interface AccountRow { id: string; ig_user_id: string; username: string | null; status: 'active' | 'paused' | 'disconnected' }
export function listActiveAccounts(db: Db): Promise<AccountRow[]>;
export function upsertAccount(tx: Tx, a: { ig_user_id: string; username?: string; name?: string; fb_page_id?: string }): Promise<AccountRow>;
export interface CredentialInfo { token_type: 'PAGE' | 'USER'; expires_at: Date | null; data_access_expires_at: Date | null; scopes: string[]; status: 'valid' | 'expired' | 'insufficient_scope' | 'error' }
export function readCredential(db: Db, accountId: string): Promise<{ token: string; info: CredentialInfo } | undefined>;
export function upsertCredential(tx: Tx, accountId: string, token: string, info: CredentialInfo): Promise<void>;   // Vault の作成/更新を含む
export function updateCredentialStatus(db: Db, accountId: string, patch: Partial<CredentialInfo> & { last_error?: string | null; last_checked_at?: Date }): Promise<void>;

// db/job-runs.ts
export function startJobRun(db: Db, jobName: JobName, accountId: string, init?: { status: 'skipped'; error: string }): Promise<string>;  // skipped は finished_at も同時に
export function finishJobRun(db: Db, id: string, r: { status: JobStatus; items_fetched: number; api_calls: number; error?: string; rate_usage?: RateUsage | null }): Promise<void>;
export function failRunningRuns(db: Db, jobName: JobName, accountId: string): Promise<number>;
export function latestRateUsage(db: Db, since: Date): Promise<RateUsage | undefined>;
export function getJobState<T>(db: Db, accountId: string, jobName: JobName): Promise<T | undefined>;
export function setJobState<T>(db: Db, accountId: string, jobName: JobName, state: T): Promise<void>;
export function tryLock(conn: ReservedSql, jobName: JobName, accountId: string): Promise<boolean>;   // pg_try_advisory_lock(hashtext, hashtext)
export function unlock(conn: ReservedSql, jobName: JobName, accountId: string): Promise<void>;

// db/raw.ts
export function insertRawResponse(db: Db, row: { account_id: string; job_run_id: string; endpoint: string; params: Record<string, unknown>; api_version: string; fetched_at: Date; http_status: number; body: unknown }): Promise<string>;   // 自動コミット

// db/profile.ts
export function upsertProfileDaily(tx: Tx, row: { account_id: string; captured_on: string; captured_at: Date; followers_count: number | null; follows_count: number | null; media_count: number | null; raw_response_id: string }): Promise<void>;

// db/account-daily.ts
export interface AccountDailyMetricRow { account_id: string; metric_date: string; metric: string; breakdown: string; breakdown_value: string; value: number | null; fetched_at: Date; raw_response_id: string }
export function upsertAccountDailyMetrics(tx: Tx, rows: AccountDailyMetricRow[]): Promise<number>;

// db/media.ts
export interface MediaUpsert { id: string; account_id: string; media_type: string; media_product_type: string; posted_at: Date; caption: string | null; permalink: string | null; expires_at: Date | null }
export function upsertMedia(tx: Tx, rows: MediaUpsert[], now: Date): Promise<{ inserted: string[]; missingThumbnail: string[] }>;
export function setThumbnailPath(db: Db, mediaId: string, path: string): Promise<void>;
export function markGone(tx: Tx, args: { accountId: string; productTypes: string[]; seenIds: string[]; now: Date; onlyExpiresAfter?: Date }): Promise<number>;

// db/snapshots.ts
export interface SnapshotCandidate { id: string; media_type: string; media_product_type: string; posted_at: Date; last_fetched_at: Date | null }   // last_fetched_at = max(fetched_at)
export function listSnapshotCandidates(db: Db, accountId: string): Promise<SnapshotCandidate[]>;   // FEED/REELS、gone_at が null
export function insertSnapshot(tx: Tx, row: { media_id: string; fetched_at: Date; elapsed_seconds: number; metrics: Record<string, unknown>; raw_response_id: string; job_run_id: string }): Promise<boolean>;   // 一意制約に当たれば false

// db/video.ts
export interface VideoAnalysisRow { media_id: string; analyzer_version: string; scene_threshold: number; status: 'success' | 'no_video_url' | 'failed'; error: string | null; analyzed_at: Date; duration_ms: number | null; width: number | null; height: number | null; fps: number | null; bitrate: number | null; file_size: number | null; has_audio: boolean | null; cut_count: number | null; avg_scene_ms: number | null; first_cut_ms: number | null; cuts_in_first_3s: number | null }
export function upsertVideoAnalysis(tx: Tx, row: VideoAnalysisRow, cuts: { seq: number; at_ms: number; scene_score: number | null }[]): Promise<void>;
export function latestAnalysis(db: Db, mediaId: string, version: string, threshold: number): Promise<{ status: VideoAnalysisRow['status']; analyzed_at: Date } | undefined>;

// lib/download.ts
export interface DownloadLimits { maxBytes: number; timeoutMs: number; allowedHosts: string[] }
export function isAllowedDownloadUrl(url: string, allowedHosts: string[]): boolean;
export function downloadToFile(url: string, destPath: string, limits: DownloadLimits, fetchImpl?: typeof fetch): Promise<{ bytes: number; contentType: string | undefined }>;
export class DownloadError extends Error {}         // message は固定文言

// storage/thumbnails.ts
export interface StorageConfig { url: string; serviceRoleKey: string; bucket: 'thumbnails' }
export function storagePath(accountId: string, mediaId: string): string;
export function saveThumbnail(cfg: StorageConfig, sourceUrl: string, path: string, limits: DownloadLimits): Promise<void>;   // ダウンロード → 縮小 → アップロード。finally で一時ファイル削除

// jobs/rate.ts
export interface RateUsage { call_count: number; total_cputime: number; total_time: number; estimated_time_to_regain_access?: number }
export class RateMonitor { constructor(initial?: RateUsage); update(h: RateLimitHeaders): void; usage(): RateUsage | undefined; percent(): number; exceeds(threshold: number): boolean }
export class RateLimitExceeded extends Error {}

// jobs/graph-client.ts
export class AuthError extends Error { code: number }
export interface Tracked<T> {
  ok: boolean;
  status: number;                                // レスポンスなし（ネットワーク失敗）は 0
  data: T | undefined;
  error: GraphError | undefined;
  errorClass: 'transient' | 'fatal' | undefined; // ok: false のときだけ
  rawResponseId: string | undefined;             // persist: false またはレスポンスなしのときは undefined
  fetchedAt: Date;
}
export interface JobGraphClient {
  get<T>(path: string, params: GraphParams, opts?: { persist?: boolean }): Promise<Tracked<T>>;   // rate と auth は投げる。transient（再試行後）と fatal は返す
  pages<T>(path: string, params: GraphParams): AsyncIterable<Tracked<{ data: T[]; paging?: { cursors?: { after?: string } } }>>;   // 失敗したページで止まる
}

// jobs/framework.ts
export type JobName = 'token_check' | 'profile_daily' | 'account_daily' | 'account_backfill' | 'media_sync' | 'media_snapshot' | 'stories';
export type JobStatus = 'success' | 'partial' | 'failed' | 'skipped';
export interface JobDeps { db: Db; config: WorkerConfig; log: Logger; secrets: SecretRegistry; fetchImpl?: typeof fetch; now?: () => Date }
export interface JobOptions { full?: boolean; days?: number }
export interface JobProgress { items: number; failures: number; apiCalls: number }
export interface JobPrecheckContext { account: AccountRow; db: Db; config: WorkerConfig; log: Logger; now: () => Date; options: JobOptions }
export interface JobContext extends JobPrecheckContext { graph: JobGraphClient; rate: RateMonitor; progress: JobProgress; jobRunId: string; startedAt: Date }   // startedAt: 「今日」の計算に使う（5.0 章）
export interface JobDefinition { name: JobName; rateThreshold?: number; shouldRun?: (ctx: JobPrecheckContext) => Promise<boolean>; run: (ctx: JobContext) => Promise<void> }
export function deriveJobStatus(p: JobProgress, stop: 'none' | 'rate' | 'auth' | 'error'): JobStatus;
export function runJob(def: JobDefinition, deps: JobDeps, account: AccountRow, options: JobOptions): Promise<JobStatus>;
export function runJobsForActiveAccounts(def: JobDefinition, deps: JobDeps, options: JobOptions): Promise<boolean>;

// jobs/media-sync.ts、jobs/media-metrics.ts（純粋関数）
export function shouldContinuePaging(pageIds: string[], knownIds: Set<string>): boolean;   // 新しい ID が 1 つもなければ false
export function isUnsupportedMetricError(error: GraphError | undefined): boolean;         // code 100 かつ「does not support」

// jobs/groups.ts
export const HOURLY_JOBS: JobDefinition[]; export const DAILY_JOBS: (JobDefinition & { options?: JobOptions })[];
export function runGroup(defs: (JobDefinition & { options?: JobOptions })[], deps: JobDeps): Promise<boolean>;   // 全ジョブを順に。failed があれば false

// jobs/scheduler.ts
export function dueGroups(now: Date, last: { hourly?: Date; daily?: Date }, cfg: Pick<WorkerConfig, 'hourlyMinute' | 'dailyTimeJst'>): ('daily' | 'hourly')[];
```

### 10.3 ファイルの担当（同じ作業ツリーで並列に作業するため）

担当ごとに触るファイルを完全に分ける。表にないファイルは触らない。共有するファイル（`index.ts`、`config.ts`、`db/types.ts`、`lib/*`、`jobs/framework.ts`、`jobs/rate.ts`、`jobs/graph-client.ts`、`db/client.ts`、`db/job-runs.ts`、`db/raw.ts`、`db/accounts.ts`）は段階 1 で完成させ、**段階 2 では編集禁止**にする。足りない関数があれば段階 1 の担当に依頼する。

| 担当 | 触ってよいファイル（`apps/worker/` 以下） |
|---|---|
| 段階 1（土台。1 人） | `src/index.ts`、`src/config.ts`、`src/lib/graph.ts`、`src/lib/log.ts`、`src/lib/time.ts`、`src/lib/download.ts`、`src/db/client.ts`、`src/db/types.ts`、`src/db/accounts.ts`、`src/db/job-runs.ts`、`src/db/raw.ts`、`src/jobs/framework.ts`、`src/jobs/rate.ts`、`src/jobs/graph-client.ts`、`src/commands/register-token.ts`、`Dockerfile`、`package.json`（依存の追加）、`test/{graph,log,time,download,framework,graph-client,config}.test.ts`、`test/db/{client,accounts,job-runs,raw,framework}.test.ts` |
| 段階 1（検証。1 人） | `src/commands/verify-api.ts`（11.1 章の P 項目）、`doc/verification/r0-meta-api-verification.md` への追記 |
| A（日次指標） | `src/jobs/account-metrics.ts`、`src/db/account-daily.ts`、`src/jobs/account-daily.ts`、`src/jobs/account-backfill.ts`、`test/account-*.test.ts`、`test/db/account-daily.test.ts` |
| B（投稿同期） | `src/db/media.ts`、`src/storage/thumbnails.ts`、`src/lib/ffmpeg.ts`（`resizeImage` の追加のみ）、`src/jobs/media-sync.ts`、`test/media-sync.test.ts`、`test/thumbnails.test.ts`、`test/db/media.test.ts`、`test/db/thumbnails.test.ts` |
| C（スナップショット） | `src/db/snapshots.ts`、`src/jobs/media-metrics.ts`、`src/jobs/media-snapshot.ts`、`test/media-metrics.test.ts`、`test/media-snapshot.test.ts`、`test/db/snapshots.test.ts` |
| D（ストーリーズ） | `src/lib/video-analysis.ts`、`src/db/video.ts`、`src/jobs/stories.ts`、`test/video-analysis.test.ts`、`test/stories.test.ts`、`test/db/video.test.ts` |
| E（プロフィールとトークン） | `src/db/profile.ts`、`src/jobs/profile-daily.ts`、`src/jobs/token-check.ts`、`test/token-check.test.ts`、`test/db/profile.test.ts` |
| 段階 3（統合。1 人） | `src/index.ts`（ジョブとグループの登録）、`src/jobs/groups.ts`、`src/jobs/scheduler.ts`、`src/commands/schedule.ts`、`src/commands/run-job.ts`、`test/scheduler.test.ts`、ルートの `docker-compose.yml`、`package.json`、`.env.example`、`README.md`、`doc/progress.md` |

### 10.4 依存関係と実装順

```text
段階 1（土台と検証。並列 2 人）
  土台: config.ts（11.3 章の全変数）→ db/types.ts（12 表すべて）→ lib/time.ts → lib/log.ts
        → db/client.ts → db/job-runs.ts、db/raw.ts、db/accounts.ts
        → lib/graph.ts の拡張、lib/download.ts → jobs/rate.ts、jobs/graph-client.ts → jobs/framework.ts
        → commands/register-token.ts → index.ts（register-token の登録とプロセスの保険）→ Dockerfile（USER node）
  検証: verify-api に P1〜P11 を追加して実行し、結果を doc/verification に追記する

段階 2（並列。土台の完成後）
  A、B、C、E は土台だけに依存するので同時に始める
  D は lib/video-analysis.ts と db/video.ts を先に作り、B の storage/thumbnails.ts と db/media.ts、
    C の jobs/media-metrics.ts が完成してから jobs/stories.ts を書く
  各ジョブは export const job だけを出し、index.ts には登録しない
  各担当が自分の純粋関数の単体テストと upsert の結合テストを書く

段階 3（統合。1 人）
  index.ts に全ジョブとグループを登録 → jobs/groups.ts → jobs/scheduler.ts → commands/schedule.ts
  → docker-compose.yml、package.json、.env.example
  → README（登録後は .env の META_ACCESS_TOKEN を消してよい、接続解除時のサムネイル削除の SQL、
     ローカルの 54321〜54324 を LAN に公開しない）
  → .env.example の「必要な権限」を 4.1 章の 3 つに直す（pages_show_list を外す）
  → 3 日間の実機確認（9.3 章）→ progress.md の更新
```

### 10.5 コード規約（秘密情報の扱い）

| 規約 | 内容 |
|---|---|
| 例外の出力 | `console.error(error)` と `String(error)` は禁止。例外は `sanitizeForLog(error.message)` だけを記録する（1.2 章）。`error.stack`、`error.cause`、`error.query`、`error.parameters` を参照しない |
| 環境変数 | `process.env` を読むのは `config.ts` だけ。他のモジュールは `WorkerConfig` を受け取る |
| URL とトークン | `paging.next` を使わない。トークンを引数や戻り値に乗せない（`JobGraphClient` の中だけ）。URL を `error.message` に入れない |
| ログ | `console.log` を直接使わず `Logger` を使う（`index.ts` の使い方の表示を除く）。`LogFields` に文字列を入れるときは `sanitizeForLog` を通す |
| 一時ファイル | `mkdtemp` で作り、`finally` で消す |

---

## 11. 実装の最初に確かめることと、確認事項

### 11.1 実装の最初に確かめること（`verify-api` に追加して実行する）

既存の `verify-api` の `Recorder` の仕組みに項目を足し、結果を `.local/api-verification/` に出す（取得データを含む JSON は Git 管理外）。要約は `doc/verification/r0-meta-api-verification.md` に追記する。

| No | 確かめること | 結果で変わる設計 |
|---|---|---|
| P1 | アカウント日次指標で、複数の指標を 1 回のリクエストで取れるか（5.2 章の 4 グループそれぞれ）。`follows_and_unfollows` と `profile_links_taps` を内訳なしで取れるか | 取れれば 1 日 4 リクエスト。取れなければ 1 指標 1 リクエスト（17 回）。`ACCOUNT_METRIC_GROUPS` の定数を直すだけで切り替わる |
| P2 | 動画ストーリーズの `media_url` から動画をダウンロードできるか。`thumbnail_url` が返るか。`media_url` と `thumbnail_url` のホスト名を記録する（許可リストの確定。3.7 章）。公開中の動画ストーリーズが必要なので、ユーザーに 1 本投稿してもらってから実行する | 取れなければ F-COL-23 は `no_video_url` の記録だけになり、要件の見直しが要る |
| P3 | 1 日分の `since`/`until` の正しい指定。`reach` を `time_series` で同じ範囲を取り、返る `end_time` が 1 日だけか、`total_value` の値と一致するか。`end_time` と PT の日付の対応（前日か当日か） | `pacificDayRange` と `metricDateFromEndTime` の初期値を確定する |
| P4 | 内訳つきのレスポンスで、値が 0 の区分が `results` に含まれるか（R0 の生レスポンスを見る） | 5.2 章の規則（印の行）には影響しない。ドキュメントの注記に使う |
| P5 | ストーリーズとフィードで、内訳つきの指標（navigation、profile_activity）を内訳なしの指標と同じリクエストに入れられるか | 入れられれば 1 枚 1 リクエストに減る。入れられなければ 5.5 章、5.6 章のとおり分ける |
| P6 | コンテナから `host.docker.internal:54322` に `postgres` ロールで接続し、`vault.decrypted_secrets` を読めるか。`vault.secrets.name` に一意制約があるか。Postgres の `log_statement` と `log_parameter_max_length_on_error` の設定（ローカルと R2 で、パラメータ（トークン）がサーバーログに出ないか）。`host.docker.internal:54321` の Storage にサービスロールキーでアップロードできるか | 読めなければ接続方式の見直し（R2 の Cloud でも同じ確認を行う） |
| P7 | 投稿のフィールドで、コラボ、お試しリール、ブーストを判定できるものがあるか（`boost_ads_list`、`boost_eligibility_info`、`is_shared_to_feed` など） | あれば `media_sync` で埋める。なければ null のまま（DB 設計 3.5 章） |
| P8 | `{ig_user_id}/stories` にページングがあるか | あれば `pages()` で追う。なければ 1 回 |
| P9 | カルーセルの親に `media_url` が返るか（サムネイルの元）。カルーセルを投稿したときに確かめる | 返らなければ `children` の先頭を使う（カルーセル 1 件につき 1 リクエスト増） |
| P10 | 2 年超の日付を指定したときのエラーの `code`、`error_subcode`、メッセージ（R0 は code 100、subcode なし）。2 年より前の投稿と、プロアカウントに切り替える前の投稿で指標が取れるか。取れないときの `code` と `error_subcode` | `isHistoryLimitError` の条件を確定する。古い投稿は `fatal` として null の行になる（5.5 章）か、選定の対象から外す条件を足す |
| P11 | `access_token` をクエリでなく `Authorization: Bearer` ヘッダで送っても Graph API が受け付けるか | 受け付ければ採用する（URL にトークンが載らず、`paging.next` やエラーに混入しにくい）。`GraphClient.get` の 1 か所の変更で済む |
| P12 | Business Use Case のレート制限に当たったときに Instagram が返すエラーコード（80004 とされる）。意図的に当てるのは難しいので、バックフィル中に `rate` で止まった記録があればそのコードを確かめる | `classifyGraphError` の `rate` の範囲（80000〜80009）を確定する |

### 11.2 ユーザーに確認したい事項

| No | 内容 | この文書の案 |
|---|---|---|
| Q1 | 定期実行の時刻。hourly は毎時 5 分、daily は JST 05:30 でよいか | 2.3 章の理由で提案。`.env` で変えられる |
| Q2 | バックフィルを hourly グループに入れ、1 回 30 日、使用率 50% 未満のときだけ進めてよいか（1〜2 日で終わる見込み） | 要件は「数日に分けて」。hourly で進めれば早く終わり、レート制限のしきい値で守る |
| Q3 | ストーリーズのサムネイルも保存してよいか（F-COL-17 は投稿とストーリーズを区別していない。1 枚 20KB 程度、月 3MB） | 保存する。R5 のストーリーズ画面で使う |
| Q4 | `profile_activity`（内訳 action_type）を R1 で取るか。フィードとストーリーズで 1 枚 1 リクエスト増える | 取る。`metric_definitions` にあり、量も少ない |
| Q5 | `META_APP_ID` と `META_APP_SECRET` を `.env` の必須項目にしてよいか（`register-token` と `token_check` が `debug_token` に使う） | 必須にする。ないと期限の確認（F-COL-02）ができない |
| Q6 | 生レスポンスは、ページングの各ページとエラーのレスポンスも含めてすべて保存してよいか（1 日 300〜500 行の見込み） | 保存する。保存期間は R1 の実測を見て決める（DB 設計 3.7 章） |
| Q7 | PC のスリープ中は収集が止まる（R2 で解消）。R1 の 3 日間の確認では PC を起動したままにできるか | 3 日間はスリープを切る |
| Q8 | `account_backfill` の完了後、`job_state` を見て実行しない（`job_runs` に行を作らない）でよいか。収集ログ画面には完了時の行が最後に残る | 作らない。毎時の空の行で画面が埋まるのを避ける |
| Q9 | 投稿の指標が `fatal` で取れなかったとき、すべて null のスナップショット行を書いてよいか（5.5 章。欠損として残り、画面には「取得したが値なし」として出る） | 書く。F-COL-22 と、次回の再試行の間隔が通常どおりになる利点がある |

### 11.3 環境変数（`.env.example` に追加する）

| 変数 | 既定・例（ローカル） | 用途 | 秘密 |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@host.docker.internal:54322/postgres` | 3.1 章。R2 ではプーラーの URL | あり |
| `SUPABASE_URL` | `http://host.docker.internal:54321` | 3.6 章 | ホストは秘密扱い |
| `SUPABASE_SERVICE_ROLE_KEY` | （`supabase status` の値） | 3.6 章 | あり |
| `META_APP_ID`、`META_APP_SECRET` | 既存。必須にする（Q5） | `debug_token` | シークレットはあり |
| `META_ACCESS_TOKEN` | 既存 | `register-token` と `verify-api` だけが読む。登録後は消してよい | あり |
| `IG_USER_ID`、`META_GRAPH_API_VERSION` | 既存 | `register-token`、API のバージョン固定 | なし |
| `WORKER_HOURLY_MINUTE` | `5`（0〜59） | 2.3 章 | なし |
| `WORKER_DAILY_TIME_JST` | `05:30`（`HH:MM`） | 2.3 章 | なし |
| `WORKER_BACKFILL_MAX_DAYS` | `30` | 5.3 章 | なし |
| `WORKER_RATE_HARD_LIMIT` | `90`（1〜100） | 7.2 章 | なし |
| `WORKER_RATE_SOFT_LIMIT` | `50`（1〜100） | 7.2 章 | なし |
| `WORKER_LOG_LEVEL` | `info`（`info` か `debug`。GitHub Actions では `debug` にしない） | 8.1 章 | なし |
| `TEST_DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres`（ホストから。`.env` でなくシェルで渡す） | 9.2 章の結合テスト | あり |

書式はすべて `config.ts` で検証し、不正なら変数名だけを示して起動を止める。ローカルの DB パスワード `postgres` は Supabase CLI の既定値で秘密ではないが、`.env` は引き続き Git 管理外にする。

---

## 12. R2 設計への申し送り

R1 の設計で決めず、R2（クラウド稼働）の設計で扱う事項。

| 項目 | 内容 |
|---|---|
| GitHub Actions に渡す秘密 | `DATABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`META_APP_ID`、`META_APP_SECRET` の 4 つだけ。**`META_ACCESS_TOKEN` は置かない**（トークンは Vault にある）。それぞれが漏れたときの影響（DB の全読み書き、Storage の全操作、`debug_token` の実行とアプリの偽装）と、取り消しの手順を R2 の設計に書く |
| DB の TLS | `sslmode=verify-full` と Supabase の CA 証明書を使う（中間者攻撃でトークンや接続文字列が読まれないため） |
| Storage の鍵 | サービスロールキーは DB 全体に効く強い鍵なので、Storage だけに効く代替（S3 互換のアクセスキーなど）を検討する |
| `appsecret_proof` | Graph API の呼び出しに `appsecret_proof` を付けるかを検討する（アプリ設定で必須にすると、トークンが漏れても単独では使えない） |
| ワークフローのトリガー | `schedule` と `workflow_dispatch` だけにする（`pull_request` など、他人が起こせるトリガーを付けない） |
| ログ | `WORKER_LOG_LEVEL` を `debug` にしない。ログに出すものの規則は 8.1 章のまま |
| ローカルからの移行 | R2 に移すときは `npm run worker:down` でローカルの常駐を止めてから切り替える（二重収集を避ける。ロックはローカルと Cloud で DB が別なので効かない） |
| ローカルのポート | README に「Supabase CLI の 54321〜54324 を LAN に公開しない（サービスロールキーの既定値が公知のため）」と書く（段階 3） |
| 接続解除時の削除 | サムネイル（`storage.objects`）の削除を接続画面の設計（F-COL-01、NF-CMP-02）で扱う。R1 は README の SQL の手順 |
| Vault の権限 | Supabase Cloud の `postgres` ロールで `vault.decrypted_secrets` を読めるか、サーバーログにパラメータが出ないか（P6 と同じ確認を Cloud で行う） |

---

## 13. 段階 1 の実装で確定・変更した事項（2026-10-01）

段階 1（土台と検証）の実装と、セキュリティ・品質レビューで、この文書の案から確定または変更した点。本文の各章は案のままなので、食い違うときはこの章が正。実機確認の結果は `doc/verification/r0-meta-api-verification.md` の 4 章。

### 13.1 実機確認（11.1 章）で確定したこと

| No | 結果 | 反映先 |
|---|---|---|
| P1 | 4 グループとも 1 リクエストでまとめて取れた | 5.2 章の `ACCOUNT_METRIC_GROUPS` のまま（1 日 4 リクエスト ＋ follower_count 1 回） |
| P2 | 公開中の動画ストーリーズに `media_url` が返らなかった（`thumbnail_url` はある）。音楽入りの動画では著作権の判定で省かれる可能性 | 5.6 章の `no_video_url` の記録で扱う。3 日間の実機確認で割合を見て F-COL-23 の見直しを判断。許可ホストは `cdninstagram.com`、`fbcdn.net` で確定（`config.ts` の `DOWNLOAD_ALLOWED_HOSTS`） |
| P3 | `since = PT 0 時`、`until = 翌日 PT 0 時 − 1 秒` で 1 日分だけ返る。`end_time` の PT の日付が**そのまま**指標の日付（前日ではない） | `pacificDayRange` は初期値のまま確定。`metricDateFromEndTime` は「前日」をやめ、`end_time` の PT の日付を返す。オフセットのない文字列は `RangeError` |
| P4 | 値 0 の区分は `results` に含まれない。`follows_and_unfollows` の内訳つきは `total_value.value` がない（印の行の `value` は null） | 5.2 章の印の行の規則のまま |
| P5 | 内訳つきと内訳なしは同じリクエストに入れられない | 5.5 章、5.6 章のまま分ける |
| P6 | `postgres` ロール（非スーパーユーザー）で Vault の作成・復号・更新・削除ができる。`vault.secrets.name` に一意索引あり。`log_parameter_max_length_on_error = 0`。Storage の REST でアップロード・上書き・読み出し・削除ができる | 3.3 章、3.6 章のまま。R2 の Cloud でも同じ確認を行う（12 章） |
| P7 | コラボ・お試しリール・ブーストを判定できるフィールドは見つからず（`boost_eligibility_info` などは取れる） | 5.4 章のとおり R1 は null。R3 で再確認 |
| P8 | 最終ページでも `paging.cursors.after` が付き、`paging.next` がない | `pages()` は `paging.next` がない、`cursors.after` がない、`data` が空、同じ `after` が続く、のいずれかで止める（URL は使わない） |
| P9、P12 | 未検証（カルーセルがない。レート制限は当てられない） | 変更なし |
| P10 | 2 年超は `code 100`、`error_subcode` なし、メッセージは 5.3 章のとおり | `isHistoryLimitError` のまま |
| P11 | `Authorization: Bearer` ヘッダだけで受け付けた | 採用。`GraphClient` はトークンをヘッダで送り、URL に載せない。`stripSecretParams` と `access_token=` のマスクは防御として残す |

### 13.2 設計から変えたこと

| 章 | 変更 | 理由 |
|---|---|---|
| 1.3 | `raw_api_responses.body` に入れる前に、キー名の置換（`stripVolatileFields`）に加えて、エラー応答の `error.message` を `sanitizeForLog` でマスクする | Graph API のエラー文にトークンやメディア ID が入ることがある。9.2 章の「秘密の非混入」を満たすため |
| 1.5 | `items = 0` かつ `failures ≥ 1` は、停止の種類に関係なく `failed` | 「何も書き込めずに失敗した → failed」を機械的に判定するため。例: `media_sync` が最初のページから失敗したら `failed` |
| 2.2 | Dockerfile は `deps` 段階（`npm ci --workspace worker --omit=dev --ignore-scripts`）の `node_modules` を実行イメージに入れる。`USER node` で動かし、`chown` は `/app/.local` だけ | postgres.js を実行時に使うため。root 時代に作られた `.local` 配下のディレクトリは `node` が書けないので、README に対処を書く |
| 3.5 | 計測値の `bigint`（`account_daily_metrics.value`、`video_analyses.bitrate`、`file_size`）は行の型を `number` にし、`db/*.ts` の読み出しで `Number()` に変換する（ID 列の `bigint` は文字列のまま） | `numeric` と同じ扱いにそろえる。段階 2 の `db/account-daily.ts`、`db/video.ts` のテストに含める |
| 5.0 | `metricDateFromEndTime` は `end_time` の PT の日付そのもの | P3 |
| 8.1 | `sanitizeForLog` の順序を「URL のパターン（`https?://`、`postgres(ql)?://`）→ 登録値のマスク → 残りのパターン」にする。パターンに JSON 形の `"access_token":"…"`、Meta のトークン形（`EAA…`）、JWT 形（`eyJ…`）を加える。数値の項目もマスクを通す | ローカルの接続文字列（ユーザー名・パスワードが `postgres`）を登録すると `postgresql://` の語が先に壊れて `<db-url>` に置き換わらないため。登録値のマスクは引き続き全体に効くので安全性は落ちない |
| 1.4 | `GraphClient.get` に 30 秒のリクエストタイムアウト（`AbortSignal.timeout`）。中断は `transient` | undici の既定（5 分）に頼ると、応答が止まったときにロックを持ったまま最長 15 分固まる |
| 3.7 | `isAllowedDownloadUrl` はユーザー情報付きの URL と非標準ポートも拒む。本文が空なら `本文がない` の `DownloadError` | 契約を単純にする |
| 11.3 | `config.ts` は `META_GRAPH_API_VERSION` の形（`v<数字>.<数字>`）、`DATABASE_URL` と `SUPABASE_URL` が URL として読めること、`WORKER_RATE_SOFT_LIMIT ≤ WORKER_RATE_HARD_LIMIT` も検証する | 不正な設定を起動時に止める |
| 10.3 | `config.ts` は段階 1 の最初にオーケストレータが書き、`register-token` と `verify-api` が共有する形にした。`verify-api` の DB・Storage の確認（P6）は `db/client.ts` の `connectDb` を使う | 並列作業の依存を切るため |
| 7.2 | `job_runs.rate_usage` は、その実行で API を 1 回以上呼んだときだけ書く（`api_calls = 0` なら null）。`latestRateUsage` も `api_calls > 0` の行だけを見る | 直近 1 時間の値がしきい値以上だと API を呼ばずに `skipped` になるが、引き継いだ値をそのまま書き戻すと次の実行もそれを拾い、実際の使用率が回復しても永久に `skipped` のままになる（品質レビューで発見） |
| 1.2、8.1 | `JobContext` に `recordFailure({ code?, errorClass, message })` と `mask(text)` を足す。ジョブは項目の失敗ごとに `recordFailure` を呼び（`failures` は枠組みが増やす）、例外なしで `failures ≥ 1` の `partial` でも `job_runs.error` に最後の失敗のマスク済みメッセージが入り、ログは `WARN` で `error_code=` と `class=` が出る。ジョブが DB（`video_analyses.error` など）やログに書く文字列は `ctx.mask` を通す | `partial` の理由が収集ログ画面に残らず、ジョブ側から登録済みの秘密（Vault のトークン）でマスクする手段もなかったため |
| 1.3 | `Tracked.error.message` は出所（`JobGraphClient.get`）でマスク済み。保存するエラー応答は `message`（マスク済み）、`type`、`code`、`error_subcode`、`fbtrace_id` だけ | `error_user_msg` などの自由文に URL や ID が入りうる |
| 1.2 | プロセス全体の秘密の一覧 `processSecrets`（`jobs/framework.ts`）を `createJobDeps` が使い、`index.ts` のプロセスの保険もそれでマスクする。一時ディレクトリの接頭辞は `TMP_DIR_PREFIX = 'instagram-worker-'`（`worker-*` から変更。ホストで動かしたときに他のツールのディレクトリを消さない） | — |
| 8.1 | ログの `account=` は内部 uuid の断片でなく、`runJobsForActiveAccounts` が渡す連番（`1/1`） | 「アカウントの ID を出さない」の規則に合わせる |
| 4.1 | `register-token` は `toCredentialInfo`（純粋関数）と `registerToken(args, deps?)`（`env`、`fetchImpl`、`now` を注入）に分け、単体テストと結合テストを持つ | 4.1 章の分岐が未検証だったため |
| 5.2 | アカウント日次指標に `online_followers` を加える（ユーザー指示 2026-10-01）。`GET {ig_user_id}/insights?metric=online_followers&period=lifetime&since=<PT 0 時>&until=<翌日 PT 0 時 − 1 秒>` を 1 日 1 リクエスト。`values[0].value` は時間帯（キー `0`〜`23`）→ 人数のオブジェクト。行は印の行 `(date, 'online_followers', 'hour', '', null)` と `(date, 'online_followers', 'hour', '<時間帯>', 人数)`。**オブジェクトが空か `values` がなければ何も書かず、失敗にも数えない**（取れない日がある）。API のエラーは他の指標と同じく失敗。時間帯のキーのタイムゾーンは未確認（UTC と思われる。画面にするときに確かめる）。バックフィルの対象には入れない（2 年分取れるかは未検証） | R0 では空だったが、2026-10-01 の再実行で 24 時間帯すべてに値が返った日があった。取れる日だけ蓄積する |
| 4.2 | `token_check` が `debug_token` を呼ぶために、`JobGraphClient` に `debugToken()` を足す。中で自分のトークンを `input_token` に、アプリトークン（`appId|appSecret`）を Bearer にして呼び、`persist: false`。ジョブはトークンの値に触れない。`debug_token` 自体の認証失敗（190 など）は `auth` でなく `fatal` として返す（`private.credentials` は `token_check` が `error` にする） | ジョブからトークンの値を読めない設計のため |
| 5.1、4.2 | 1 件だけを扱うジョブ（`profile_daily`、`token_check`）も、API の失敗で固定文言を投げず `ctx.recordFailure` だけ呼んで戻る（`items 0 かつ failures ≥ 1` → `failed`）。`job_runs.error` にはマスク済みの API の文言、ログに `error_code=<Graph のコード> class=<分類>` が残る | 8.1 章の「エラーの行には常に `error_code=` と `class=`」を満たすため |
| 5.5 | `isUnsupportedMetricError` は `code 100` かつ `/does not support the \S+ metric/`（存在しないメディアの `code 100`、`error_subcode 33`、文言 `does not support this operation` と区別する）。内訳つきのリクエストが「does not support」なら null でなくキーなし（対象外）で、失敗に数えず `warn`。まとめた取得が `code 100`・`error_subcode 33`（存在しない・権限のないメディア）なら 1 指標ずつ取り直さず、全指標 null の行を書く（API 1 回、`recordFailure` 1 回）。`code 100` のそれ以外は 1 指標ずつ取り直し、1 メディアにつき `warn` 1 行（`unsupported=`、`unexpected=`） | 削除済みの投稿が `media_sync --full` で `gone_at` になるまでの毎時の取り直し（1 件 12 リクエスト）を避ける。`{}` の行を書かない |
| 5.5、5.6 | `fetchMediaInsights(ctx, media, { job? })` の第 3 引数でログの `job=` を切り替える（`stories` が共用する） | — |
| 5.2、5.3 | `fetchAccountDay(ctx, date, { jobName?, includeOnlineFollowers? })` を `account_daily` と `account_backfill` で共用し、バックフィルは `online_followers` を呼ばない。1 指標ずつの取り直しで `transient` の指標は行を書かず、`fatal` だけ null の行。内訳つきのリクエストが成功したのに指標が `data` にないときは印の行を `value = null` で書く。`oldest_date` に達しても `attempts < 3` の失敗日が残っていれば `done` にせず、取り直せる日がなくなった時点で `done = true`。`rateSoftLimit` の判定は `run` の中で各日の前に `ctx.rate.exceeds(config.rateSoftLimit)`（`JobDefinition.rateThreshold` には設定値を載せられないため）。リクエスト数は `account_daily` が 1 日 5 回 × 日数 ＋ follower_count 1 回（既定 21 回）、`account_backfill` が 1 日 4 回 | 13.2 章の `online_followers` と 5.3 章の `done` の条件を両立させるため |
| 5.6 | `stories` はストーリーズを毎回全枚 upsert するので、サムネイルの再試行は `upsertMedia` の `missingThumbnail` で足りる（`listMediaWithoutThumbnail` は使わない）。空の一覧でも `onlyExpiresAfter`（10 分）で絞られるので消失判定の保護は不要。`analyzeVideo` の結果に `failureClass`（`download` か `unknown`）を持ち、`recordFailure` の分類に使う。`no_video_url` は `warn` 1 行で失敗に数えない。ジョブは `createStoriesJob(deps?)` で作る | — |
| 7.2 | `latestRateUsage(db, since, until?)` に `until` を足し、枠組みはジョブの開始時刻を渡す（開始時刻より未来に終わった行は使わない） | 時計のずれやテストの仕込みの行を拾わないため |
| 5.3 | 2 年のエラーが返ったときも `done` を直接 true にせず、`oldest_date` をその翌日に確定し、それ以前の `failed_dates` を除いたうえで、`attempts < 3` の失敗日が残っていれば次回の取り直しの回に進む（`finishByHistoryLimit`）。取り直せる日がなくなった時点で `done = true` | 2 年の境界は日単位でずれうるので、その前の失敗日を放置しないため（品質レビュー） |
| 5.4、5.6 | 一覧の項目が読めなくても（種類や日時が不正）、`id` が数字列なら「一覧にあった」として消失判定の `seenIds` に入れる。`id` が `/^\d{1,40}$/` に合わない項目は飛ばして `seenIds` にも入れない。`stories` も `media_sync` と同じく、一覧が空で `gone_at` が null のストーリーズが残っているときは消失判定を見送る（空は正常なので失敗には数えない） | 読めない項目が混ざると既存の行に誤って `gone_at` が入る（品質レビューで再現） |
| 1.1 | ジョブとグループのコマンドの終了コードは、`failed` があるときだけ 1（`partial` と `skipped` は 0）。`runGroup` の `failed=` は `failed` の数。`runGroup(name, entries, deps, runJobs?, signal?)` で、SIGTERM 後は実行中のジョブを終えたら残りのジョブを飛ばす | 設計 1.1 章の文言どおり。`partial` のたびに GitHub Actions が失敗扱いになるのを避ける |
| 2.2 | `docker-compose.yml` に `tmpfs: ["/tmp:size=512m"]`、`read_only: true`、`security_opt: ["no-new-privileges:true"]`、`pids_limit: 256`、`cap_drop: [ALL]`、`mem_limit: 1g` を足す。書けるのは `/tmp` と `/app/.local` だけ | 強制終了時に解析中の動画が書き込み層に残らないため。ffmpeg が外部のメディアを扱うため |
| 5.6 | ffmpeg/ffprobe の失敗は `CommandError`（コマンド名と終了コード）にし、`video_analyses.error` には固定文言 `動画の解析に失敗（<command>、終了コード N）` を入れる（stderr は入れない）。子プロセスには 5 分の制限時間（超えたら SIGKILL） | stderr に一時ファイルのパスが入るため。固まった ffmpeg でロックを持ち続けないため |
| 4.2 | `token_check` は `insufficient_scope` のとき `last_error` に `権限が足りない（<権限名>）` を入れる。`register-token` は `last_error = null` のまま標準出力に警告を出す | 翌日の確認で理由が画面に残る方が有用。登録直後は標準出力で分かる |
| 5.4 | `media_sync` は `listMediaWithoutThumbnail` を使わない（`upsertMedia` の `missingThumbnail` が今回の一覧にあった未保存の行をすべて返すため） | 冗長な問い合わせの削除 |
| 7.1 | `follower_count` の time_series は PT の当日（進行中）の値も返す。当日の行は翌日の `account_daily` で上書きされる | 実機で確認（2026-10-01） |
| 5.3 | バックフィルで遡る日数を `WORKER_BACKFILL_HISTORY_DAYS`（1〜730、既定 730）で指定できる。既に `job_state` があっても、`oldest_date` は「保存済みの値」と「今日 − 設定日数」の遅い方に縮む | ユーザー指示（2026-10-02）: アカウントは開設 1 年未満なので 2 年分は不要。ローカルは 400 日 |
| 2.1 | 常時起動でない PC での運用: Docker Desktop をログイン時に自動起動する設定にすれば、Supabase とワーカーのコンテナ（いずれも `restart: unless-stopped`）が自動で戻り、スケジューラは起動直後にその時間帯の hourly と当日未実行の daily を 1 回ずつ実行する。停止中の hourly は取り戻せない（ストーリーズと投稿後 24 時間以内のスナップショットに欠け）。日次指標は 4 日の窓で埋まるが、それより長く止めたら `account-daily --days N` で埋める | 開発環境は常時起動でないため（R2 で解消） |
| 5.4 | `media_sync --full` は、全ページ成功でも一覧が空（`seenIds` が空）で DB に `gone_at` が null の投稿があるときは消失判定を見送り、`warn` を出して失敗に数える（行を書けていないので `failed` になる）。カルーセルの子は `fields=media_type,media_url,thumbnail_url` で引き、元 URL のある最初の子（動画なら `thumbnail_url`）を使う。`listMediaWithoutThumbnail` は `gone_at is null` に絞る。サムネイルの元画像の上限は 20MB。ジョブは `createMediaSyncJob(deps?)` で作り、テストで `fetch`、`resize` を差し替える（`index.ts` に登録するのは既定の `job`） | API の一時的な異常で全投稿を消失扱いにしないため |

### 13.3 段階 2 への申し送り

- `JobContext` の使い方、`begin` の中で禁止のこと（`ctx.db`、`ctx.graph.get`、`insertRawResponse`、入れ子の `begin`）、`Tracked` の読み方、`recordFailure` と `mask` の使い方は `jobs/framework.ts` と `jobs/graph-client.ts` の doc コメントに書いてある。`max: 2` のため、トランザクションの中で API を呼ぶと空き接続を待ち続けて止まる（エラーにならない）。
- `rate` と `auth` は `RateLimitExceeded` と `AuthError` として投げられる。ジョブの `try/catch` で項目の失敗を数えるときは、この 2 つを再 throw する。
- 一時ディレクトリは `mkdtemp(join(tmpdir(), TMP_DIR_PREFIX + '<用途>-'))` で作り、`finally` で消す。
- `DownloadLimits` の既定値は `download.ts` にない。`maxBytes: 200 * 1024 * 1024`、`timeoutMs: 60_000`、`allowedHosts: config.downloadAllowedHosts` を呼び出し側で渡す。
- 結合テストは `test/db/framework.test.ts` の形（偽 `fetch` の応答キュー、`createLogger` に `write` を注入、架空アカウントを `afterAll` で削除）にならう。`runJobsForActiveAccounts` はローカル DB の実アカウントに行を書くので結合テストで呼ばない。

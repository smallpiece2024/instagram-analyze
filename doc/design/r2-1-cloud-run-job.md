# R2.1: 収集ワーカーを Cloud Run ジョブへ移す設計

| 項目 | 内容 |
|---|---|
| 版 | 0.2（2026-11-21。レビュー 2 本を反映。ユーザーの決定待ち: 14 章） |
| 課題 | ia-jfy |
| 対象 | 収集ワーカーの実行場所と起動、通知、デプロイ。R2 設計（`r2-cloud.md`）の 5 章を置き換える |
| 変えないもの | ワーカーの各ジョブの中身、DB のスキーマ、Web（Vercel）、Supabase の構成、収集の頻度（毎時） |
| レビュー | セキュリティと運用（`general-purpose`）、ワーカーの実装（`node-worker-developer`）。2026-11-21 |

---

## 0. 前提と目的

- 収集は GitHub Actions の `collect.yml` で毎時 1 回動いている。1 回の実時間は 40〜70 秒だが、Actions は 1 回ごとに分単位へ切り上げて数える。組織の請求の使用量には、このリポジトリの分が 10 月に 814 分、11 月は 20 日までに 522 分（月およそ 780 分）載っている（2026-11-20 に請求の API で確認）。
- 1 回 40 秒ほどのうち、ワーカー自身の処理は 27 秒ほど（`daily-due` 2 秒、`run-hourly` 23 秒、`check-alerts` 2 秒。2026-11-20 11:17 UTC の実行）。残りは毎回のチェックアウト、`npm ci`、ビルド。
- **目的**: 毎時の収集を保ったまま、GitHub Actions の消費を「ワーカーを変えたときのデプロイ」だけに減らす。
- **未確認の前提**: R2 設計 13 章 G4 は「公開リポジトリの標準ランナーは無料」としており、実行ごとの API も課金対象時間 0 ms を返す。組織の無料枠（月 2,000 分）にこのリポジトリの分が数えられているかは、GitHub の Billing の画面でしか確かめられない。数えられていなければ、この移行で無料枠の残りは変わらない（請求の使用量の表示は減る）。

## 1. 全体構成

```
今:  Supabase の pg_cron（毎時 17 分）→ GitHub の API（workflow_dispatch）→ collect.yml
       → checkout、npm ci、build、ffmpeg の復元 → daily-due → run-daily → run-hourly → check-alerts → ping

後:  Cloud Scheduler（毎時 17 分 UTC）→ Cloud Run Admin API（jobs.run）→ Cloud Run ジョブ `collect`
       → コンテナ（ビルド済みのワーカー ＋ ffmpeg）で `worker collect`
          （開始の ping → daily の判定 → run-daily → run-hourly → check-alerts → 成功か失敗の ping）
```

| 役割 | 今 | 後 |
|---|---|---|
| 実行場所 | GitHub Actions のランナー（毎回ビルド） | Cloud Run ジョブ（ビルド済みのイメージ） |
| 起動 | Supabase の pg_cron ＋ http 拡張機能 ＋ GitHub のトークン | Cloud Scheduler（サービスアカウントの OAuth。長期の鍵なし） |
| 手順の組み立て | `collect.yml` のステップ | ワーカーの新しいコマンド `collect`（4 章） |
| 秘密 | GitHub の Environment `Production` の Secrets | Secret Manager |
| 失敗の通知 | GitHub の失敗メール | Healthchecks の開始と失敗の ping（7 章） |
| 起動されないことの検知 | Healthchecks（ping が 3 時間来ない） | Healthchecks（猶予を縮める。7 章） |
| コードの反映 | 毎回 `main` をチェックアウト | `main` へのマージでイメージを作り直してジョブを更新（8 章） |

## 2. Google Cloud の構成

プロジェクトの ID、番号、サービスアカウントのメールアドレスはリポジトリに書かない。手順のコマンドは環境変数（`$PROJECT_ID` など）で受ける。

| 項目 | 内容 |
|---|---|
| プロジェクト | Vision で使っている既存のプロジェクト「instagram-analyze」（Q1） |
| リージョン | `asia-northeast1`（Q2）。Cloud Run ジョブ、Artifact Registry、Cloud Scheduler を同じリージョンに置く |
| 有効にする API | Cloud Run、Cloud Scheduler、Secret Manager、Artifact Registry、IAM Credentials（デプロイの連携用） |
| 予算アラート | プロジェクトに 1 ドルの予算アラートを付ける（R4.1 設計 3.8 節の推奨と同じもの。未設定なら付ける）。Cloud Run が無料枠に収まる前提の額で、超えたら知らせが来ること自体が目的 |

### 2.1 サービスアカウントと権限

| サービスアカウント | 使う場面 | 付ける権限 |
|---|---|---|
| `collect-runner` | ジョブの実行時の ID | 使う秘密それぞれへの `roles/secretmanager.secretAccessor` だけ。プロジェクト全体のロールは付けない |
| `collect-scheduler` | Cloud Scheduler がジョブを起動する ID | ジョブ `collect` への `roles/run.invoker` だけ（引数を変えて起動する権限 `roles/run.developer` は付けない。F3）。Scheduler がこの ID を使うのに追加の権限が要るかは段階 0 で確かめる（F1 に明記なし） |
| `collect-deployer` | GitHub Actions からのデプロイ（8 章） | Artifact Registry のリポジトリへの書き込み、ジョブ `collect` への `roles/run.developer`、`collect-runner` への `roles/iam.serviceAccountUser` |
| （`collect-deployer` を使える主体） | 8 章の連携 | Workload Identity のプール全体ではなく、このリポジトリの属性を持つ主体だけに `roles/iam.workloadIdentityUser` を付ける |

- 既存の Vision 用のサービスアカウント（鍵つき、ロールなし）はそのまま。Cloud Run には IAM の権限の定義があるので、ロールのないこの鍵が漏れてもジョブや秘密は操作できない。
- R4.1 設計 3.8 節は「Vision 専用のプロジェクトにし、他の API を有効にしない」を勧めている。同じプロジェクトに載せるとこの推奨から外れる。残る危険は、Vision のように IAM の権限の定義がない API をこのプロジェクトで有効にした場合に、漏れた Vision の鍵で呼べること。今回有効にする 5 つは IAM で守られる（未確認: 段階 0 で各 API について確かめる）。気になるなら Q1 の別案か、Q8（鍵をなくす）を取る。
- `collect-deployer` はジョブのイメージを差し替えられるので、実質的にすべての秘密を読める。入口の門は 8 章のプロバイダの条件だけになる。

### 2.2 ジョブ `collect` の設定

| 設定 | 値 | 理由 |
|---|---|---|
| コンテナの引数 | `collect` | イメージの `ENTRYPOINT` は `node dist/index.js` のまま |
| CPU、メモリ | 1 vCPU、1 GiB | Actions のランナー（4 vCPU）より小さい。段階 0 で、動画 1 本の解析中のメモリの山と所要時間を測る。一時ファイルは `os.tmpdir()` の下（`framework.ts` の `TMP_DIR_PREFIX`）で、Cloud Run ではメモリに数えられる（未確認: 段階 0）。手元の Docker も `/tmp` が tmpfs 512 MB、メモリ 1 GB で形は近い |
| タスク数 | 1 | |
| タスクの制限時間 | 30 分 | `collect.yml` の `timeout-minutes: 30` と同じ。既定は 10 分（F5）。`videoBudgetMs` と `videoTextBudgetMs`（各 8 分）にストーリーズと daily を足して収まるかを段階 0 で見る |
| 再試行 | 0 回 | 既定は 3 回（F6）。失敗した回は次の毎時の回が埋める（今と同じ）。再試行すると Meta の呼び出しと通知が重なる |
| 実行の重なり | 仕組みでは防がない | Cloud Run が重なりを防ぐかは文書にない（F4）。重なっても、各ジョブが取る Postgres の advisory lock（`db/job-runs.ts` の `tryLock`）で後から来た方が `skipped` になる。`stories` の `skipped` は `stories_skipped` の判定に数えられるので、手で実行するのは毎時 17 分の前後を避ける（今と同じ注意） |

## 3. コンテナイメージ

`apps/worker/Dockerfile`（手元の Docker 用に既にある）を本番でも使う。

- **ffmpeg を本番と同じ版に固定する。** 今の Dockerfile は Debian の `apt-get install ffmpeg` で、本番（`collect.yml`）は BtbN/FFmpeg-Builds の静的ビルド（n8.1.2、URL と SHA-256 で固定）を使っている。版が変わるとカットの検出結果が変わりうるので、Dockerfile でも同じ URL と SHA-256 のものを使う。手元の Docker も同じ版になる。
  - ビルド用の段を足す: `apt-get` で `curl`、`xz-utils`、`ca-certificates` を入れ、`curl` → `sha256sum -c` → `tar` で `ffmpeg` と `ffprobe` を取り出す。その段の中で `ffmpeg -version` と `ffprobe -version` を実行し、動かなければビルドを落とす（BtbN のビルドが bookworm の glibc で動くかは未確認。今の本番は `ubuntu-latest`）。
  - 実行の段は `ffmpeg` の apt をやめ、`ca-certificates` は残す。`ffmpeg` と `ffprobe` の `COPY` は `node_modules` と `dist` より前に置く（デプロイごとに変わらないレイヤにする）。
  - 対象は `linux/amd64` だけ（BtbN の linux64 が amd64 用）。
  - 片付け（9 章）までは、URL と SHA-256 が `collect.yml` と Dockerfile の 2 か所にある。
- イメージの置き場は Artifact Registry の Docker リポジトリ（1 つ）。タグはコミットの SHA、ジョブにはダイジェストで指定する。動いているコミットは `gcloud run jobs describe collect` のイメージとタグの対応で分かる。
- 古いイメージは Artifact Registry の削除のポリシーで消す（直近 3 つを残す。未確認: ポリシーの書き方は段階 0）。無料枠は 0.5 GB（F9）で、イメージの大きさは段階 0 で測る。

## 4. ワーカーの変更: `collect` コマンド

`collect.yml` のステップが担っていた手順の組み立てを、ワーカーのコマンド 1 つに移す（`apps/worker/src/commands/collect.ts`）。既存のコマンドの入口（`dailyDue()`、`groupCommand().run`、`checkAlerts()`）は、標準出力への書き込みや接続の開け閉めを自分で行うのでそのままは呼ばず、その内側の関数を呼ぶ。既存の関数は変えない。

```
worker collect [--daily=auto|force] [--simulate-alert]
```

| 順 | 処理 | 呼ぶもの | `collect.yml` での対応 |
|---|---|---|---|
| 0 | ping の URL を読む（ほかの設定より先）。開始の ping（`/start`）を送る | `config.ts` に足す読み込みの関数 | — |
| 1 | `--simulate-alert` または `WORKER_SIMULATE_ALERT=true` なら、設定は `loadCheckAlertsConfig` だけを読み、収集を飛ばして 4 へ（scope は `hourly`） | | `env.SIMULATE` |
| 2 | 設定と依存を作る（1 回だけ）。daily を含めるかを決める: `--daily=force`、または開始時刻の UTC の時が 20、または前回の日次の成功から 24 時間超。24 時間超の判定で DB を読めなくても先へ進む（含めない） | `loadWorkerConfig`、`createJobDeps`、`latestCompletedStartedAt` と `isDailyDue` | `slot`、`due` のステップ。時の判定は pg_cron の関数にあった |
| 3 | daily を含めるなら daily のグループ、続けて hourly のグループ。前が失敗しても例外でも次へ進む | `runGroup(name, entries, deps, undefined, signal)`（`schedule` コマンドと同じ形） | `daily`、`hourly` のステップ |
| 4 | `check-alerts`。scope は「daily を含めた回は `daily`、ほかは `hourly`」。同じ DB の接続を使う | `runCheckAlerts(scope, …)` | `alerts` のステップ |
| 5 | 終わりの ping。2〜4 がすべて成功なら成功の URL、失敗か例外が 1 つでもあれば `/fail`。DB の接続を閉じる前に送る | | `ping` のステップ |
| 6 | DB の接続を閉じる（1 回）。失敗があれば終了コード 1 | `closeJobDeps` | ジョブの成否 |

**失敗しても ping を送るための作り**

- 順 2〜4 はそれぞれ `try/catch` で囲み、例外を「その手順の失敗」として次へ進む。全体を `try/finally` で囲み、設定の不備（`ConfigError`）や `createJobDeps` の失敗でも `/fail` を送る。
- `SIGTERM`（制限時間の到達など）を受けたら、`signal` を abort し、その場で `/fail` を送って終了コード 1 で終わる。`runGroup` の `signal` はジョブの切れ目でしか見られず、固まったジョブは止まらないため、ハンドラが自分で送る。`SIGTERM` から強制終了までの猶予は段階 0 で確かめる。
- Cloud Run の制限時間（30 分）より短い自前の期限（25 分）を置き、過ぎたら `SIGTERM` と同じ扱いにする（猶予の仕様に頼らない）。
- abort の後は `check-alerts` を飛ばす（今の `!cancelled()` と同じ）。
- ping は `fetch` と `AbortSignal.timeout`（10 秒）で送り、3 回まで試す（今の `curl --max-time 10 --retry 3` と同じ）。失敗は `warn` に固定の文言と HTTP の状態コードだけを出す（例外の文言は URL を含みうる）。URL は秘密として登録し（`processSecrets`）、ログに出さない。`/start` と `/fail` は URL の末尾のスラッシュの有無をそろえてから付ける。
- `HEALTHCHECKS_PING_URL` が未設定なら ping を送らず `info` を 1 行出す（手元の実行用）。
- 未捕捉の例外（`index.ts` の `uncaughtException` は即終了）とメモリ不足の強制終了では ping は出ない。これは開始の ping の後に終わりの ping が来ないこととして Healthchecks が拾う（7 章）。

**そのほか**

- 時の判定を起動側から実行側に移す。Cloud Scheduler からの起動は引数を変えられない権限（`roles/run.invoker`）で行うため。ずれても「24 時間超」が次の回で補う。
- 手で daily を補うときは `gcloud run jobs execute collect --args=collect,--daily=force`（F3。ユーザーの権限で行う）。UTC 20 時台に手で実行すると、`auto` でも daily がもう 1 回動く。
- 設定を読んだ後に、秘密の環境変数を `process.env` から消す（依存のコードから読めないようにする。設定の読み込みが 1 回で済む `collect` だけで行う）。
- 既存の `schedule` コマンド（手元の常駐用）と、個別のコマンドは変えない。

**失うもの**

- `collect.yml` はステップごとに渡す秘密を分けていた（Vision の鍵は `run-hourly` だけ、`check-alerts` には DB の接続だけ）。1 つのプロセスになるので、この分け方はなくなる。ffmpeg の子プロセスに環境変数を渡さない守り（R4.1 設計 3.8 節）は残り、上の「`process.env` から消す」を足す。
- 今は ping の送信に失敗するとジョブが失敗になりメールが来る。後は `warn` だけで、ping が届かないこと自体を Healthchecks が拾う。
- 公開ログ向けのマスクのステップ（`::add-mask::`）はなくなる。Cloud Logging のログはプロジェクトの権限を持つ人しか読めない。ワーカー自身のマスク（`sanitizeForLog`）と「本番で `debug` にしない」決まりは変えない。

## 5. 起動（Cloud Scheduler）

| 項目 | 内容 |
|---|---|
| ジョブ | 1 つ（`collect-hourly`）。スケジュール `17 * * * *`、タイムゾーン UTC |
| 宛先 | `POST https://run.googleapis.com/v2/projects/<プロジェクト>/locations/<リージョン>/jobs/collect:run`（F1）。本文なし |
| 認証 | OAuth。サービスアカウント `collect-scheduler`（F1） |
| 再試行 | しない（未確認: 既定の回数は段階 0 で確かめ、0 に明示する）。起動の抜けは Healthchecks が拾う |
| 止め方 | `gcloud scheduler jobs pause collect-hourly`（今の `COLLECT_ENABLED=false` に当たる） |

pg_cron から Cloud Run を直接起動する案は取らない。Google の API を呼ぶにはサービスアカウントの鍵で署名したトークンが要り、長期の鍵を Supabase の Vault に置いて DB の中で署名することになる（Q3）。

## 6. 秘密と設定

| 名前 | 置き場 | 備考 |
|---|---|---|
| `DATABASE_URL` | Secret Manager | |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret Manager | |
| `META_APP_SECRET` | Secret Manager | |
| `HEALTHCHECKS_PING_URL` | Secret Manager | 未設定なら ping を送らない（4 章） |
| `GCP_VISION_KEY_JSON` | Secret Manager | 鍵をなくす案は Q8 |
| `SUPABASE_URL`、`META_APP_ID` | ジョブの環境変数 | GitHub では Variables が公開ログに出るので Secrets にしていた。ジョブの設定はプロジェクトの権限を持つ人しか読めない。デプロイの公開ログに出さないことが条件（8 章） |
| `DATABASE_SSL_CA`、`META_GRAPH_API_VERSION`、`WORKER_BACKFILL_HISTORY_DAYS`、`WORKER_LOG_LEVEL`、`WORKER_VIDEO_TEXT_MAX_PER_RUN`、`WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT` | ジョブの環境変数 | 値は今の `collect.yml` と GitHub の Variables と同じ |
| `WORKER_SIMULATE_ALERT` | 置かない | 通知の試験は引数 `--simulate-alert` で行う |

- 秘密は環境変数として渡し、版は番号で固定する（`--set-secrets NAME=SECRET:版`。文書の推奨。F7）。差し替えは「新しい版を足す → ジョブの版の番号を更新 → 古い版を破棄」。無効にしただけの版も課金の数に入るので破棄まで行う（F8）。
- 秘密の登録はファイルから渡す（`gcloud secrets versions add <名前> --data-file=<.local/ のファイル>`。登録の直後にファイルを消す）。PowerShell のパイプは末尾に改行を足すので使わない。ファイルの末尾に改行を入れない。段階 2 で、貼ればそのまま動くコマンドを親が用意する。
- 環境変数は YAML のファイル（`--env-vars-file`）で渡す。`DATABASE_SSL_CA` が複数行のため。実際のファイルは `.local/` に置き、リポジトリにはひな形だけを置く。
- 秘密が読めないとコンテナは起動しない（F7）。この場合は開始の ping も出ない（7 章の「起動されない」と同じ検知になる）。

## 7. 通知と監視

GitHub の失敗メールがなくなるので、Healthchecks に開始と失敗を知らせる。チェックの猶予を 3 時間から 45 分に縮める（Q9）。

| 事象 | 今 | 後 |
|---|---|---|
| ジョブの `failed`、`check-alerts` の該当（トークンの期限、ストーリーズの連続失敗など） | GitHub の失敗メール（続く間は毎時） | `/fail` の ping → Healthchecks のメール |
| 設定の不備、制限時間の到達 | GitHub の失敗メール | `/fail` の ping（4 章）→ Healthchecks のメール |
| 始まったが終わりの ping が出ない（メモリ不足の強制終了、未捕捉の例外） | GitHub の失敗メール | 開始の ping から猶予（45 分）の間に終わりの ping が来ない → Healthchecks のメール（F10） |
| 起動されない、コンテナが起動しない（秘密やイメージが取れない） | Healthchecks（3 時間来ない） | Healthchecks（1 時間 ＋ 猶予 45 分来ない） |
| 何が失敗したか | GitHub の実行ログ | Web の `/jobs` 画面と、Cloud Logging のログ |

変わる点（未確認: Healthchecks は状態が変わったときに知らせる作りと見ているが、文書には書かれていない。F10。段階 0 で試験用のチェックに `/start`、`/fail`、成功を送って確かめる）:

- 1 回だけの失敗（Meta の 5xx など）は、失敗と復旧の 2 通になる。
- 失敗が続く間は毎時のメールにならない。その間に別の異常が加わっても新しいメールは出ないので、**失敗のメールが来たら復旧のメールが来るまで毎日 `/jobs` を見る**。
- トークンの期限の知らせ（daily の回だけ判定する）は、毎日 05 時台に失敗、06 時台に復旧と届く。復旧のメールは「直った」ではなく「毎時の回は通った」の意味になる。
- ping に本文は付けない（ログを外部のサービスに置かない）。
- 通知の試験は `gcloud run jobs execute collect --args=collect,--simulate-alert` で行う（収集を飛ばし、`/fail` が届いてメールが来ることを見る）。

Cloud Monitoring のアラートを使う案は Q4。

## 8. デプロイ

ワークフロー `.github/workflows/deploy-worker.yml` を足す。

| 項目 | 内容 |
|---|---|
| きっかけ | `main` への push のうち `apps/worker/**`、`package.json`、`package-lock.json` が変わったもの。手動（`workflow_dispatch`）も可 |
| 手順 | チェックアウト → イメージのビルド → `docker run <イメージ> check-env` → Google Cloud への認証 → Artifact Registry への push（タグはコミットの SHA）→ `gcloud run jobs update collect --image <ダイジェスト>`。ビルドを認証より前に置く（依存の導入が、デプロイの権限を持った状態で動かないようにする。Dockerfile の `npm ci` は `--ignore-scripts` 付き） |
| 認証 | Workload Identity Federation（`google-github-actions/auth`。長期の鍵を GitHub に置かない。F11）。ワークフローの権限は `contents: read` と `id-token: write` |
| 入口の制限 | プロバイダの条件で、このリポジトリの `main` に限る。**段階 0 の合格条件**: ブランチで絞れること（できればワークフローのファイルと Environment でも）、リポジトリを名前でなく数値の ID で絞れること（`google-github-actions/auth` の `docs/SECURITY_CONSIDERATIONS.md` を読む）。ブランチで絞れなければ Q5 の別案（手元からデプロイ）に切り替える |
| 識別子 | プロバイダの名前、サービスアカウント、プロジェクト ID、リージョンつきのイメージのパスは Environment `Production`（`main` だけ）の Secrets に置き、ログのマスクを効かせる |
| 公開ログ | `docker push` と `gcloud` の出力は捨てる（ジョブの設定に `SUPABASE_URL` などがあり、`gcloud run jobs update` が何を出すかは未確認）。最初の実行のログを目で確かめる |
| 重なり | `concurrency` を付け、取り消さずに順に流す（古い実行が後に終わって古いイメージに戻らないように） |
| 失敗 | GitHub の失敗メール（push した人に届く）。失敗の間は `main` と本番がずれる。手動で再実行する |
| アクション | コミットの SHA で固定する。Dependabot の対象に Dockerfile（docker）を足す |
| 消費 | 1 回数分（未確認: 段階 1 で測る）。ワーカーを変えたときだけ |

- マイグレーションとコードの順序は今と同じ扱い（本番の DB への `db push` を先に行ってからマージする）。今は「マージの次の毎時の回」から新しいコードが動き、後は「デプロイが終わった次の回」から動く。
- 手元の PC からデプロイする案は Q5。

## 9. 片付け（確認の期間の後）

ここから先は 10.4 の 3 手では戻せない。戻すには、起動用のトークンの作り直しと Vault への登録、Secrets の再登録、`collect.yml` と起動の関数の復元が要る。次の順で行う。

| 順 | 対象 | 内容 |
|---|---|---|
| 1 | pg_cron の起動 | マイグレーションを 1 本足す: `cron.unschedule('collect-dispatch')`、`drop function private.dispatch_collect()`、`drop extension http`（ほかに使っていない）。`cron-history-purge` は残す |
| 2 | 起動用の GitHub トークン | クラウドの Supabase の Vault の `collect-dispatch-token` を削除し、GitHub でトークンを失効させる |
| 3 | `collect.yml` | 削除する（Q7） |
| 4 | GitHub の Secrets と Variables | Environment `Production` のワーカー用の Secrets 7 つと、Variables（`COLLECT_ENABLED` など）を削除する |
| 5 | 文書 | README（サービス情報の「インフラ」に Google Cloud、4〜5 章の手順）、R2 設計の 5 章・5.3 章（通知の経路）・6 章（秘密の置き場、漏えい時の取り消し、Secrets の数。2 要素認証を必須にする資格情報に Google アカウントを足す）、R4.1 設計 3.8 節（鍵の置き場と差し替え）、要件定義の R2 の記述、`doc/progress.md` |

- 起動用のトークンの期限が確認の期間の中に来ないかを、切り替えの前に見る（ロールバックに要る）。
- Supabase の一時停止の対策（R2 設計 2.3 章）は変わらない（ワーカーが毎時 DB を読み書きする）。

## 10. 切り替えとロールバック

### 10.1 準備（収集は GitHub のまま）

| # | 手順 | 担当 |
|---|---|---|
| 1 | API の有効化、サービスアカウント、Artifact Registry、予算アラート | 親（`gcloud`。作る前にコマンドを見せて了承を得る） |
| 2 | 秘密 5 つの登録（6 章の方法） | ユーザー（値を持っているのはユーザーだけ） |
| 3 | イメージのビルドと push、ジョブ `collect` の作成 | 親 |
| 4 | `gcloud run jobs execute collect --args=check-env` で、ffmpeg の版（期待する版の文字列と照合する）と解析、`/tmp` への書き込みを確かめる | 親 |
| 5 | 通知の試験（7 章）。Healthchecks の猶予を 45 分に変える | 親とユーザー（メールの確認） |
| 6 | **本物の収集を 1 回**: GitHub の毎時の回が終わった直後に `gcloud run jobs execute collect` を手で実行し、`/jobs` 画面で各ジョブの成功を確かめる（DB、Meta、Storage、Vision への接続と、`DATABASE_SSL_CA` の渡し方を通す。重なっても advisory lock が守る） | 親とユーザー |
| 7 | Cloud Scheduler のジョブを **止めた状態**で作る（止めた状態で作れなければ、17 分を避けて作り、すぐ止める。段階 0 で確かめる） | 親 |

### 10.2 切り替え（毎時 17 分の実行が終わった直後に、連続して行う）

| # | 手順 |
|---|---|
| 1 | **GitHub** の Variables で `COLLECT_ENABLED=false`（`collect.yml` が skip になる） |
| 2 | **クラウドの Supabase** の SQL エディタで pg_cron のジョブ `collect-dispatch` を止める（R2 設計 5.8 章のロールバックの SQL） |
| 3 | `gcloud scheduler jobs resume collect-hourly` |
| 4 | 次の 17 分の実行を T0 とし、`/jobs` 画面と Healthchecks で確かめる |

欠損は出ない（1 時間の間に済ませる）。

### 10.3 確認の期間（3 日間。Q6）

- 毎時の実行が抜けない（72 回）。daily が 3 回動く。
- 実行時間とメモリの最大値（Cloud Run の指標）。動画のある回が 25 分に収まる。
- Google Cloud の請求が 0 円のまま。

### 10.4 ロールバック（片付けの前まで）

1. `gcloud scheduler jobs pause collect-hourly`
2. **GitHub** の Variables で `COLLECT_ENABLED=true`
3. **クラウドの Supabase** で pg_cron のジョブ `collect-dispatch` を再開

Healthchecks の猶予は 3 時間に戻す（`collect.yml` は開始の ping を送らない）。

## 11. 費用

| 項目 | 月の使用量の見込み | 無料枠（請求先アカウントで共有） | 無料枠がないときの額 |
|---|---|---|---|
| Cloud Run ジョブ | 720 回。1 回は最低 1 分と数えられる（F2）。1 vCPU・1 GiB で 43,200〜65,000 vCPU 秒 | 200,000〜240,000 vCPU 秒、375,000〜450,000 GiB 秒（F2。値に揺れあり） | 約 1.3 ドル |
| Cloud Scheduler | ジョブ 1 つ | 3 つ（F8） | 0.10 ドル |
| Secret Manager | 有効な版 5 つ、読み出し月 3,600 回 | 版 6 つ、読み出し 10,000 回（F8） | 0.30 ドル |
| Artifact Registry | イメージ 3 つ分（大きさは段階 0 で測る） | 0.5 GB（F9） | 1 GB 超過あたり 0.10 ドル |
| GitHub Actions | デプロイ 1 回数分 × 回数、Dependabot と CodeQL の月数十分 | — | — |

- 無料枠はどれも請求先アカウントの単位で、同じ請求先のほかのプロジェクトと分け合う。ほかのプロジェクトが使い切っていても、合計は月 2 ドル未満の見込み。段階 0 で **Google Cloud** の請求のレポートを見て、今の使用を確かめる。
- Cloud Run も 1 回を最低 1 分と数えるが、無料枠が月 3,300〜4,000 分相当あるので収まる。

## 12. 実装の分割

| 段階 | 内容 | 担当 |
|---|---|---|
| 0 | ユーザーの決定（14 章）と、未確認の事項の確認（下の一覧） | 親とユーザー |
| 1A | `collect` コマンドとテスト（4 章、13 章） | `node-worker-developer` |
| 1B | Dockerfile の ffmpeg の固定（3 章）、`deploy-worker.yml`（8 章）、手順書（`gcloud` のコマンドを README に足す。Terraform は使わない） | 親 |
| 2 | Google Cloud の構築と準備（10.1） | 親とユーザー |
| 3 | 切り替えと確認の期間（10.2、10.3） | 親とユーザー |
| 4 | 片付け（9 章） | 親（マイグレーションは `postgres-sql-reviewer` がレビュー） |

1A と 1B はファイルが重ならないので並列にできる。

**段階 0 で確かめること**

| # | 事項 | 方法 |
|---|---|---|
| 1 | Cloud Run の料金と無料枠（F2）、請求先アカウントのほかのプロジェクトの使用 | **Google Cloud** の料金のページと請求のレポート |
| 2 | Healthchecks の `/start`、`/fail`、成功の後の状態とメールの出方（7 章） | 試験用のチェックに送る |
| 3 | Workload Identity Federation をブランチ、ワークフロー、リポジトリの ID で絞れるか（8 章の合格条件） | `google-github-actions/auth` の `docs/SECURITY_CONSIDERATIONS.md` |
| 4 | Cloud Scheduler: 既定の再試行の回数、止めた状態で作れるか、`collect-scheduler` を使うのに要る権限 | 文書 |
| 5 | Cloud Run: `SIGTERM` から強制終了までの猶予、一時ファイルがメモリに数えられること、node ユーザーで `/tmp` に書けること | 文書と、10.1 の 4 |
| 6 | 今回有効にする API が IAM で守られること（2.1 節）、Artifact Registry の削除のポリシーの書き方 | 文書 |
| 7 | イメージの大きさ、1 vCPU での動画の解析時間とメモリの山 | 手元の Docker と、10.1 の 6 |

## 13. テスト

- `collect` の単体テスト（既存のコマンドの内側の関数は差し替えて、呼び出しだけを確かめる）:
  - daily の判定と scope の表（引数 × UTC の時 × 24 時間超 × simulate）。24 時間超の判定が DB を読めないときに先へ進むこと。
  - 各手順が失敗や例外でも次へ進み、`/fail` と終了コード 1 になること。
  - 設定の不備でも `/fail` を試みること。
  - abort のとき、残りと `check-alerts` を飛ばして `/fail` と終了コード 1 になること。
  - ping の宛先（`/start`、成功、`/fail`）、ping が応答しなくても上限時間で終わること、ping の失敗で終了コードが変わらないこと、URL がログに出ないこと、URL が未設定のときに送らないこと。
  - `--simulate-alert` だけ（環境変数なし）で収集を呼ばず `alert=simulated` になること。
  - 引数の不正が固定の文言になること。DB の接続を 1 回だけ閉じること。
- 手元: `docker compose run --rm worker check-env`（読み取り専用、node ユーザー）。手元の Supabase に向けて `collect` を 1 回通す。
- イメージ: デプロイのワークフローが push の前に `check-env` を通す（8 章）。
- 本番: 10.1 の 4〜6、10.3。

## 14. 確認事項（ユーザーに決めてもらうこと）

| # | 事項 | 推奨 | 別案 |
|---|---|---|---|
| Q1 | プロジェクト | 既存の「instagram-analyze」に載せる（R4.1 の「Vision 専用」の推奨からは外れる。2.1 節） | 収集用に新しいプロジェクトを作る（Vision 専用のまま保てる。管理が 1 つ増える） |
| Q2 | リージョン | `asia-northeast1`（東京） | クラウドの Supabase のリージョンに合わせる（東京でなければ） |
| Q3 | 起動 | Cloud Scheduler（R2 で「外部の cron を増やさない」とした方針から外れるが、同じ Google Cloud の中で、鍵が要らない） | pg_cron のまま（Google の鍵を Vault に置き DB の中で署名する。勧めない） |
| Q4 | 失敗の通知 | Healthchecks の開始と失敗の ping（新しいサービスの設定が要らない。メールの出方が 7 章のとおり変わる） | Cloud Monitoring のアラートでメール（失敗の内容をメールに出せるが、設定が増える） |
| Q5 | デプロイ | `main` へのマージで GitHub Actions が行う（1 回数分。段階 0 の合格条件つき） | 手元の PC から `gcloud` で行う（Actions の消費は 0。忘れると `main` と本番がずれる） |
| Q6 | 確認の期間 | 3 日間 | 7 日間（R2 と同じ） |
| Q7 | 確認の後の `collect.yml` | 削除する（2 つの経路を保守しない） | 手動の予備として残す |
| Q8 | Vision の鍵をなくす（ジョブの ID でトークンを取る） | 今回は見送り、別の課題にする（切り替えを小さく保つ） | 今回いっしょに行う（1 プロセスにまとめる分の守りになる） |
| Q9 | Healthchecks の猶予 | 45 分（制限時間 30 分より長く、異常を 2 時間以内に知らせる） | 3 時間のまま |

## 15. 事実票（確認日 2026-11-21）

| # | 事実 | 出典 |
|---|---|---|
| F1 | Cloud Scheduler からジョブを起動する宛先は `https://run.googleapis.com/v2/projects/PROJECT_ID/locations/CLOUD_RUN_REGION/jobs/JOB:run`、メソッドは POST、`--oauth-service-account-email` で指定する。Scheduler のリージョンはジョブと違ってよい。起動するサービスアカウントに要るロールはページに明記がない（実行には `roles/run.invoker`） | https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule |
| F2 | ジョブは実行中ずっと CPU が割り当てられる料金で、起動した 1 つにつき最低 1 分。無料枠はジョブで 240,000 vCPU 秒と 450,000 GiB 秒（us-central1 の料金にもとづく）、ほかのリージョンの表に 200,000 と 375,000 の記載もある。請求先アカウントの単位で合算し、毎月戻る。Tier 1 で 1 vCPU 秒 約 0.000018 ドル、1 GiB 秒 約 0.000002 ドル。**料金のページ本体は取得できず、検索結果の抜粋による。段階 0 でページを直接確かめる** | https://cloud.google.com/run/pricing |
| F3 | 1 回の実行だけ引数、環境変数、タスク数、制限時間を変えられる（`gcloud run jobs execute JOB --args …`、REST は `overrides.containerOverrides[].args`）。変えて実行するには `roles/run.developer`、そのままの実行は `roles/run.invoker` | https://docs.cloud.google.com/run/docs/execute/jobs |
| F4 | 同じジョブの実行が重なったときの扱い（並行、待ち、拒否）は書かれていない | 同上 |
| F5 | タスクの制限時間は既定 10 分、最大 168 時間。実行全体の制限時間はない | https://docs.cloud.google.com/run/docs/configuring/task-timeout |
| F6 | 再試行は既定 3 回、0〜10。0 にすると 1 回だけ動く | https://docs.cloud.google.com/run/docs/configuring/max-retries |
| F7 | 秘密は `--set-secrets ENV=SECRET:VERSION` で環境変数にできる。環境変数は起動時に解決されるので、`latest` でなく版の固定を勧める。取得に失敗するとインスタンスは起動しない。実行の ID に `roles/secretmanager.secretAccessor` が要る | https://docs.cloud.google.com/run/docs/configuring/jobs/secrets |
| F8 | Cloud Scheduler は 1 ジョブ月 0.10 ドル、無料は請求先アカウントで 3 つ。Secret Manager は有効な版（有効と無効の両方）1 つ月 0.06 ドル、読み出し 10,000 回 0.03 ドル、無料は版 6 つと読み出し 10,000 回（請求先アカウントで合算）。**検索結果の抜粋による** | https://cloud.google.com/scheduler/pricing 、https://cloud.google.com/secret-manager/pricing |
| F9 | Artifact Registry の保存は 0.5 GB まで無料、超過は 1 GiB 月 約 0.10 ドル。同じリージョンの中の転送は無料。**検索結果の抜粋による** | https://cloud.google.com/artifact-registry/pricing |
| F10 | Healthchecks の ping は、成功 `https://hc-ping.com/<uuid>`、失敗 `…/fail`、開始 `…/start`、終了コード `…/<0〜255>`。1 つのチェックに 1 分 5 回まで。POST の本文は 100 kB まで保存される。開始の ping の後、猶予の間に成功の ping が来なければ「down」にして知らせる。`/fail` が来たときの状態と通知の出方（状態の変化のときだけか）は文書に書かれていない | https://healthchecks.io/docs/signaling_failures/ 、https://healthchecks.io/docs/measuring_script_run_time/ 、https://healthchecks.io/docs/http_api/ |
| F11 | `google-github-actions/auth`（README の例は `@v3`）は `workload_identity_provider` と `service_account` を受ける。ワークフローに `id-token: write` が要る。プロバイダには必ず条件（Attribute Condition）を付ける。例は組織で絞る `assertion.repository_owner`、IAM の束縛ではリポジトリで絞る `attribute.repository`。ブランチで絞る書き方は README にない | https://github.com/google-github-actions/auth |
| F12 | Cloud Run のジョブの標準出力と標準エラーは Cloud Logging に入る（リソースの種類 `cloud_run_job`）。指標に「Completed executions」などがある（正確な名前とラベルはページにない） | https://docs.cloud.google.com/run/docs/logging 、https://docs.cloud.google.com/run/docs/monitoring |
| F13 | 今の本番の実行: 2026-11-12〜11-20 の `collect` 194 回、作成から完了まで平均 68 秒、最長 2,970 秒（待機を含む）、成功以外 3 回 | `gh run list`（2026-11-20） |

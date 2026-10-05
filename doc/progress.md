# 進捗と次の作業

作業を再開するときは、まずこの文書を読む。区切りごとに更新する。

| 項目 | 内容 |
|---|---|
| 最終更新 | 2026-10-05 |
| 現在地 | **R2（クラウド稼働）は 2026-10-03 23:29 JST に切り替えを終え、収集は GitHub Actions（クラウドの Supabase の pg_cron が毎時起動）で本番の DB に入っている。手元のワーカーは停止中。7 日間の確認中（T0 は 2026-10-04 00:17 JST、終わりは 10-11 00:17 JST。5 章）。通知の試験は 2026-10-05 に実施。R2.5 はデザインシステムを v3 の 01 に決め、画面ごとの検討の残りは接続と収集ログ** |
| 要件定義 | [requirements/requirements-definition.md](requirements/requirements-definition.md)（版 0.4） |

---

## 1. リリースの状況

| リリース | 内容 | 状況 |
|---|---|---|
| R0 | ローカル開発環境と API 検証 | **完了**（2026-09-30） |
| R1 | 収集基盤（ローカル） | 仕上げ中。DB、ワーカー（7 ジョブとスケジューラ）、最小限の画面、Facebook Login の接続まで実装し実機確認済み（2026-10-02）。残りは 3 日間の収集確認（2026-10-01 深夜開始）の結果の記録 |
| R2 | クラウド稼働（Supabase Cloud、Vercel、GitHub Actions） | 仕上げ中。段階 A〜D と README の手順 1〜5 まで完了（2026-10-02）。GitHub の schedule が動かないため、毎時の起動をクラウドの Supabase の pg_cron に移した（2026-10-03。README 5.1 まで本番に適用済み）。2026-10-03 23:29 JST に切り替えを終え、本番で収集中。残りは 7 日間の確認（T0 は 2026-10-04 00:17 JST） |
| R2.5 | 画面設計（架空のデータのプロトタイプ、デザインシステムの比較） | 第 1 ラウンド完了（design-lab v1、2026-10-02）。フィードバックを受けて第 2 ラウンド（v2）の方針を決めた。次は v2 の 10 案を作る。R3 の前に終える |
| R3 | 基本分析（概要、投稿一覧、初速、期間比較） | 未着手 |
| R4 | 動画分析（長さとカット） | 未着手。ffmpeg による解析は R0 で動作確認済み |
| R4.1 | 動画分析（画面の文字） | 未着手。方式は比較して決める（要件 8.7 章） |
| R5 | 投稿分類、ストーリーズ、オーディエンス、投稿時刻の分析 | 未着手 |
| R6 | 月次レポート（画面表示）、伸びた投稿の検出 | 未着手 |

## 2. これまでにやったこと

### 2.1 調査と要件定義

- 事前調査: `doc/preliminary/`（Claude の調査と付録 5 本、ユーザーが追加した ChatGPT の調査）
- 要件定義: `doc/requirements/requirements-definition.md`
  - 0.1 初版、0.2 確認事項 Q1〜Q7 の回答を反映、0.3 R0 の実機検証の結果を反映、0.4 R2.5（画面設計）を追加

### 2.2 R0 で作ったもの

| 対象 | 内容 |
|---|---|
| ルート | npm workspaces（`apps/*`）、Supabase CLI（2.118.0 固定）、`docker-compose.yml`（ワーカー用）、`.env.example` |
| `supabase/` | `supabase init` の設定。analytics と Edge Functions は無効。マイグレーションはまだない |
| `apps/web` | Next.js 16.3。トップページにローカル Supabase（Auth、REST、Storage）への接続状態を表示するだけ |
| `apps/worker` | Node.js 24 と ffmpeg の Docker イメージ。コマンドは `check-env`（ffmpeg で長さとカットのミリ秒を確認）と `verify-api`（Meta API の実機検証）。単体テスト 10 件 |
| README | 環境構築、起動、ワーカー、Meta API 検証の手順 |

### 2.3 R0 の Meta API 検証で分かったこと

詳細は `doc/verification/r0-meta-api-verification.md`。要件に効くものは次のとおり。

- アカウントの日次指標は **2 年前まで**取れる（事前調査の「90 日」は誤り）。1 回のリクエストは最大 30 日。
- views などは期間の合計しか返らない。日次にするには **1 日 1 リクエスト**。日ごとの推移で返るのは reach だけ。
- API の「日」は **米国太平洋時間の 0 時**で区切られる。日次指標は API の日付のまま保存し、画面で注記する（要件 5.5 章）。
- follower_count（1 日ごとの新規フォロワー数）は **直近 30 日のみ**。毎日保存する。
- online_followers（時間帯別オンライン数）は **中身が空**。投稿時刻別の初速の比較で代替する（F-UI-42）。
- リールでは **profile_visits と follows が取れない**。投稿単位のファンネルはフィードとストーリーズのみ。
- views の内訳は `follow_type` を使う（`follower_type` はエラー）。
- 投稿の指標は 1 投稿 1 リクエストでまとめて取れる。約 110 回の呼び出しでレート制限の使用率は 1%。
- リールの動画は media_url からダウンロードして解析できた。URL の期限は約 32〜35 時間。
- 未検証: カルーセル、フィード動画（該当投稿がなかった）、冬時間の日付の区切り。Facebook Login の戻り先に `http://localhost:3000` を使えるかは 2026-10-02 に確認済み（開発モードでは登録なしで使えた。4.3 章）。

## 3. 手元の環境の状態

- `.env`（Git 管理外）に、期限のない **ページアクセストークン**、Instagram アカウントの数値 ID（`IG_USER_ID`）、Meta アプリの ID とシークレットを設定済み。
- トークンの **データアクセス期限は 2026-12-29 ごろ**（2026-09-30 時点で残り約 90 日）。過ぎるとアプリの再承認が必要。R1 で期限の表示と通知を作る。
- `.env` に `DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（ローカルの Supabase CLI の既定値）も追加済み（2026-10-01）。
- ローカル DB に `register-token` でページトークンを登録済み（`accounts`、`private.credentials`、Vault に 1 件ずつ。`status = valid`）。収集ジョブはこれを使い、`.env` のトークンは `register-token` と `verify-api` だけが読む。README の手順どおり `.env` の `META_ACCESS_TOKEN` と `IG_USER_ID` は消してよい（`verify-api` を使うときだけ戻す）。
- 常駐のワーカーは `npm run worker:up` で起動中（2026-10-01 深夜）。止めるときは `npm run worker:down`、ログは `npm run worker:logs`。開発 PC は常時起動でないので、Docker Desktop をサインイン時に起動する設定にしておけば PC 起動で収集が再開する（README「常時起動でない PC での運用」）。止まっていた間のストーリーズと投稿後 24 時間以内のスナップショットは補えない。3 日間の確認は PC が起きている時間で行う。
  - 2026-10-02 朝に確認: PC を 02:07〜07:52 JST の約 5 時間 45 分止めたあと、Docker Desktop の起動でワーカーが自動で再開し、DB が上がるまでの `ECONNREFUSED`／`57P03` を再試行してから、起動直後に daily（05:30 JST を過ぎていたため）と hourly を続けて実行した（設計書 9.3 章の「止めてから起動」の項目は確認済み）。
- `.env` に `WORKER_BACKFILL_HISTORY_DAYS=400` を設定済み（アカウントは開設 1 年未満。ユーザー指示 2026-10-02）。
- `apps/web/.env.local`（Git 管理外）に、ローカル Supabase の URL と publishable key を設定済み。
- ワーカーの実行結果は `.local/`（Git 管理外）に出る。自分のデータを含むので、コミットしないこと。ワーカーは非 root（`node`）で動くので、root 時代に作られた `.local` 配下のディレクトリは README の手順で権限を直す。

### 再開の手順

```bash
npm install                 # 依存関係（初回や package.json 変更時）
npm run db:start            # Supabase を Docker で起動
npm run dev:web             # http://localhost:3000
npm run worker:image        # ワーカーのイメージを作り直す（ワーカーのコードを変えたとき）
npm run worker:check-env    # ffmpeg の動作確認
npm run worker:verify-api   # Meta API の検証（トークンの有効性の確認にも使える）
npm run worker:register-token   # .env のトークンを DB（Vault）に登録（冪等）
npm run worker:job -- <command> # ワーカーのコマンドを 1 回実行
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test -w worker   # 結合テスト込み
```

## 4. 次にやること（R1: 収集基盤）

要件定義 4.2 章（F-COL-01〜22、F-UI-01〜03）と 5 章。完了条件は「ローカルで 3 日間収集を続け、欠けずに DB に入っている」。

進め方の案。

1. **DB のテーブル設計とマイグレーション**（要件 5.1 章）
   - **完了（2026-10-01）**。設計は `doc/design/r1-db-design.md`（版 0.2）、マイグレーションは `supabase/migrations/` の 5 本。ローカルで適用と架空データでの検証を済ませた
   - 決めたこと: アカウント日次指標は縦持ち、投稿とストーリーズのスナップショットは JSON。ストーリーズの動画解析（長さとカット）は 24 時間で消えるため R1 で行う（F-COL-23）。画像や動画のコンテンツは残さず解析結果だけを残す。分析用データセットのビュー（F-COL-24）を用意した
   - アカウント、認証情報、プロフィールの日次記録、アカウント日次指標、投稿、投稿指標のスナップショット、ストーリーズ、API の生レスポンス、ジョブの実行記録、指標の定義
   - 指標は JSON 型の列か縦持ちかを決める（要件 5.1 章の末尾）
   - 日次指標の日付は API の日付（太平洋時間）で持つ
2. **ワーカーの収集ジョブ**（要件 5.2 章のスケジュール）。**段階 1〜3 が完了（2026-10-01）。3 日間の実機確認中**
   - **段階 2・3 完了（2026-10-01 深夜）**: 7 ジョブ（`token_check`、`profile_daily`、`account_daily`、`account_backfill`、`media_sync`、`media_snapshot`、`stories`）、グループ（`run-hourly`、`run-daily`）、常駐の `schedule`、compose の常駐設定と硬化（`read_only`、`tmpfs`、非 root）。テスト 579 件。セキュリティと品質のレビュー（段階 2〜3 で各 1 本）を反映済み。設計から変えた点は設計書 13 章
   - 実機: `run-daily` と `run-hourly` を手で流し、投稿 24 件（サムネイル 24 枚）、スナップショット 24 件、日次指標は 8 月 1 日まで（バックフィル継続中）、`online_followers` は取れる日だけ、生レスポンスとエラー文に秘密や URL の混入なし
   - `online_followers` はユーザー指示（2026-10-01）で収集対象に入れた（空の日は何も書かない）
   - **3 日間の確認の中間結果（1 日目、2026-10-02 07:55 JST 時点）**。実機の開始は 2026-10-01 23:24 JST
     - `job_runs` 32 件はすべて `success`（`skipped`/`failed`/`partial` なし、`running` の残りなし）。hourly は 23:26、23:47（手動）、00:05、01:05、02:05、07:52（再開直後）の 6 回、daily は 23:24（手動）と 07:52 の 2 回
     - `account_backfill` は 1 時間に 30 日分（120 呼び出し、約 2〜3 分）進み、`days_done=180`、`next_date=2026-04-03`、`oldest_date=2025-08-27`（400 日）、`failed_dates` は空。`account_daily_metrics` は 2026-04-04〜2026-10-01 の 181 日が途切れなし
     - `account_daily` は D−4〜D−1（09-27〜09-30）に内訳なしの 13 指標（`online_followers` の null 1 件を含む）と、`contact_button_type`／`follow_type`／`media_product_type` の印の行がそろう。`hour`（`online_followers`）は 09-27〜09-29 のみで 09-30 は空（取れる日だけ、の想定どおり）
     - `profile_daily` は 10-01 と 10-02 の 2 日分
     - `stories` は毎回 0 件、`media_snapshot` は初回に 24 件を書いたあと `due=0`（最新の投稿が 2026-09-18 で、24 時間以内の投稿がないため）。**初速のスナップショット（1h、3h、6h、24h）とストーリーズの動画解析は、確認期間中に投稿とストーリーズを 1 件ずつ出さないと確かめられない**
     - 秘密情報の混入なし: `raw_api_responses` 808 件（1.6 MB）に `access_token=` と `cdninstagram.com` が 0 件、`job_runs.error` に 10 桁以上の数字列と `://` が 0 件、ワーカーのログに `DEBUG` 行、`://`、10 桁以上の数字列が 0 件
     - `raw_api_responses` の増え方は 1 時間あたり約 125 件（バックフィル 120 件 + hourly 5 件前後）。バックフィルが終われば 1 日 30 件程度に落ちる見込み
     - 未確認: 投稿とストーリーズの初速、アーカイブ → `media-sync --full` → 復帰の往復、2 年より前の投稿の `fatal` の扱い（アカウントが開設 1 年未満のため該当なし）
     - **2026-10-02 08:18 JST に動画のストーリーズが 1 件投稿された**（偶然）。09:05 と 10:05 の hourly（接続し直した新しいトークン）で `stories` が 1 件・4 呼び出しで成功し、スナップショットが 2,809 秒と 6,419 秒の 2 件入った（毎時の取得が効いている。1h／3h／6h と latest は `media_metrics_at_horizon` で後日確認）。動画解析は `no_video_url`（API が動画ストーリーズの `media_url` を返さない。R0 検証 P2 と同じ。F-COL-23 の見直し材料: 動画ストーリーズは解析できない前提になる）
     - **ユーザーの判断（2026-10-02）**: 投稿のタイミングは本人が決められないため、投稿とストーリーズに依存する確認（初速のスナップショット、ストーリーズの動画解析、アーカイブの往復）は保留し、投稿があったときに後から確認する。3 日間の完了判定は自動で動く部分（daily、hourly、バックフィル）が欠けずに入っていることで行う
   - 3 日間の確認で見ること: 設計書 9.3 章。終わったら `job_runs` の `skipped`/`failed`/`partial` の理由、`warn` の `unsupported=`/`unexpected=`、`no_video_url` の割合（F-COL-23 の見直し）、`raw_api_responses` の増え方（保存期間の判断）を記録する
   - 2026-10-01: 設計書 `doc/design/r1-collection-jobs.md`（版 0.3）。backend-architect が起草し、security-engineer と quality-engineer のレビューを反映。11.2 章の Q1〜Q9 は回答済み（Q3 ストーリーズのサムネイルは保存する。他は設計書の案のとおり）。段階 1 で確定・変更した事項は 13 章
   - 決めたこと: Postgres 直結（postgres.js、`max: 2`）、Vault からトークンを読む、コンテナ常駐のスケジューラ（毎時 5 分と JST 05:30）、生レスポンスからトークンと署名付き URL を除く、ログは秘密情報をマスクしたメッセージだけ、トークンは Bearer ヘッダで送る
   - 進め方: 段階 1（土台 + `verify-api` の P1〜P12 の実機確認）→ 段階 2（A〜E を同じ作業ツリーでファイルを分担して並列）→ 段階 3（統合と 3 日間の実機確認）。設計書 10.3 章と 10.4 章
   - **段階 1 完了（2026-10-01）**: `config.ts`、`lib/{graph,log,time,download}.ts`、`jobs/{rate,graph-client,framework}.ts`、`db/{types,client,accounts,job-runs,raw}.ts`、`commands/register-token.ts`、`index.ts`、Dockerfile（`deps` 段階、非 root）、`.env.example`。テスト 278 件（結合 60 件程度を含む）。セキュリティと品質のレビュー（前半・後半の 4 本）を反映済み。`verify-api` の P1〜P12 を実機で実行し、結果は `doc/verification/r0-meta-api-verification.md` の 4 章（P2 の動画ストーリーズは `media_url` が返らず、P9 のカルーセルは未検証）
   - 段階 2 の担当 A〜E は設計書 10.3 章の表のとおり。`JobContext` の `recordFailure` と `mask`、`begin` の中で API を呼ばない、`TMP_DIR_PREFIX` を使う、などの申し送りは設計書 13.3 章と `jobs/framework.ts` の doc コメント
   - プロフィール日次、アカウント日次指標（直近 3 日を上書き、1 日 1 リクエスト）、follower_count
   - 投稿一覧の同期、投稿指標のスナップショット（1 時間ごと → 1 日 1 回 → 週 1 回 → 月 1 回）
   - ストーリーズの 1 時間ごとの取得と、動画ストーリーズの長さとカットの解析（F-COL-23）
   - 初回のバックフィル（日次指標 2 年分を数日に分けて、中断しても再開できるように）
   - 生レスポンスの保存、ジョブの実行記録、再試行、レート制限の監視、NULL と 0 の区別
   - ローカルでの定期実行の方法（ワーカーコンテナ内のスケジューラなど）
3. **Meta との接続**（F-COL-01〜03）。**実装と実機確認が完了（2026-10-02）**
   - 実機の結果（2026-10-02 08:20 JST）: `/connect` →「Meta と接続する」→ Meta の許可 → `/connect?result=ok` で「接続しました」と現在の状態の表が出た。トークン交換は POST 本文で通った（GET への戻しは不要）。`private.credentials`、`accounts`、Vault の 1 件が同じ時刻に更新され（件数は増えない）、データアクセス期限は 2026-12-31（約 90 日先）、権限の不足なし。`npm run worker:job -- token-check` は `valid`（残り 89 日）。開発サーバーのログにトークン、認可コード、`state` は出ず、コールバックの行は `logging.incomingRequests.ignore` で除かれている。`job_runs.error` に秘密なし。次の hourly（09:05 JST）が新しいトークンで `success` になることは、この後の 3 日間の確認で見る
   - 設計は `doc/design/r1-web-screens.md`（版 0.2。セキュリティ・品質・Next.js 16 照合のレビューを反映）。`/connect` → `POST /api/meta/login`（303）→ Meta の認可 → `GET /api/meta/callback` → トークン交換（POST 本文）→ `me/accounts` → ページトークンを `debug_token` で確認 → Vault に登録
   - Meta アプリ側: Facebook ログインの製品を追加し、OAuth ログインを有効にするだけ。**戻り先 `http://localhost:3000/api/meta/callback` は登録不要**（開発モードでは `http://localhost` が自動許可。`127.0.0.1` は HTTPS 必須。要件 C2 は解決）
   - 次回: `npm run dev:web` → ブラウザで `http://localhost:3000/connect`（`localhost` で開く。`127.0.0.1` だと Origin 不一致で 403）→「Meta と接続する」→ 結果の文言を確認。確認項目は設計書 4.4 章（トークン交換が POST で通るか、`result=ok`、`private.credentials` の更新、`token-check` が `valid`）。POST が通らなければ設計 2.1 章の GET への戻しを判断
   - 2026-10-02 朝にブラウザを使わない範囲を確認済み: `apps/web/.env.local` に `META_APP_ID`、`META_APP_SECRET`、`META_GRAPH_API_VERSION`、`APP_URL` を設定済み。`GET /connect` は 200 でフォーム（`POST /api/meta/login`）とボタンが出る。`POST /api/meta/login` は 303 で `https://www.facebook.com/v25.0/dialog/oauth`（`redirect_uri=http://localhost:3000/api/meta/callback`、4 スコープ）へ飛び、`meta_oauth_state` Cookie（HttpOnly、SameSite=Lax、Path=/api/meta、10 分）が付く。Origin が `127.0.0.1` だと 403。接続前の `private.credentials` は `PAGE`／`valid`／データアクセス期限 2026-12-29（`updated_at` 2026-10-01 22:52 UTC）で、接続後にこれが更新されるかで判定する
   - 2026-10-02 のブラウザからの初回は `POST /api/meta/login` が 403 になった。原因は全ルートの `Referrer-Policy: no-referrer`。この値だとブラウザは同一オリジンのフォーム送信でも `Origin: null` を送り（Fetch Standard）、Origin 検査に落ちる。curl では Origin を手で付けていたため気づかなかった。`same-origin` に変更し（Referer は他オリジンに出ないので目的は変わらない）、`test/next-config.test.ts` で固定。設計書 3 章を更新
4. **最小限の画面**（F-UI-01〜03）。**実装済み（2026-10-02）**
   - `/`（接続状態と再接続の帯）、`/jobs`（収集ログ。`?job=` で絞り込み）、`/media`（投稿一覧。署名付き URL のサムネイル、50 件ずつ）。Server Components のみ、Postgres 直結（`apps/web/.env.local` の `DATABASE_URL` など。`.env.example` を参照）。`next dev` は `127.0.0.1` だけで待ち受け、`proxy.ts` で Host を検査
   - テスト: Web 単体と結合（`TEST_DATABASE_URL` 付き）、`npm run typecheck -w web`、`npm run build:web`（全ルート `ƒ`）。実データで 3 画面の表示を確認済み
   - R3 で R2.5 のデザインに作り直す。R2 でログイン必須にし、Web 用の DB ロールを作る（設計書 12 章）

### サブエージェントの導入（2026-10-01）

ユーザーの方針: タスクごとに専門のサブエージェントを探して使い、並列化し、設計 → 並列レビュー → 差し戻しで進める。git worktree は使わない（同じ作業ツリーでファイルを分担する）。

- 14 の提供元を調査し、候補 9 本と Supabase 公式スキル 2 本の本文を読んで評価した結果、次を導入することにした。
  - `.claude/agents/` に 4 本（MIT。出所と改変をファイル先頭に表示、許諾文は `.claude/agents/LICENSES/`）: `postgres-sql-reviewer`（wshobson `sql-pro` を改変）、`node-worker-developer`（VoltAgent `node-specialist` を改変）、`nextjs-developer`（wshobson `frontend-developer` を改変。Next.js 16 の注記）、`dashboard-designer`（wshobson `ui-ux-designer` を改変。R2.5 用）
  - Supabase 公式スキル 2 本（`supabase`、`supabase-postgres-best-practices`）は公式プラグイン（`supabase/agent-skills`）として `.claude/settings.json` に登録する（project スコープ）。ファイルはコピーしない。手順は README
  - 入れないもの: バックエンド設計、テスト、デプロイ、セキュリティの外部エージェント（大規模前提、vitest に触れない、作り物の数値のひな形入り、など）。手元の SuperClaude の同種エージェントで足りる
- SuperClaude は 4.0.8 のまま（手元の 14 エージェントの本文は上流の最新 v4.3.0 と同一で、増える分はこのプロジェクトに効かない）。必要になったら `superclaude install`（上書きなし）で新規分だけ追加する
- マイグレーションは `supabase/migrations/` に手書きする方式を続ける。Supabase の MCP サーバは使わない

### R2.5（画面設計）の準備メモ

2026-10-01 にユーザーから「実際に画面を見ると要望がたくさん出る。架空のデータで見た目だけを確かめる工程がほしい」と要望があり、計画に追加した（要件 3 章）。

- 最初の作業: BI のデザインに向く Claude Code のサブエージェントを探し、`.claude/agents/` にインストールする（2026-10-01 のユーザーの要望）。候補の配布元と中身を確かめて示し、了承を得てから入れる
- 作り方: ユーザーの別プロジェクトの design-lab と同じ構成にする。`doc/design-lab/v1/` に、切り替え用の `index.html`、見本画面、共通 CSS、案ごとのトークン CSS（10 案）を置く。モバイル幅と PC 幅を並べて見られ、10 案を一覧でも比べられる
- 見本画面に入れる画面: 概要、投稿一覧、投稿詳細（リールのカットと文字のタイムライン）、リール分析、ストーリーズ、投稿時刻、接続と収集ログ
- 数字は架空のハードコード。架空のアカウント名を使い、実データは入れない
- 案の方向性の下書き: スタンダード、ナイトモード、グラデーション、経済紙（明朝と罫線）、やわらか（丸ゴシック）、方眼ノート、高密度、北欧ミニマル、ブルータル、藍と朱
- グラフの 4 色（フィード、カルーセル、リール、ストーリーズ）は、配色の検証スクリプトで色覚多様性の判定を通した次の値を下書きとする。赤と緑を隣に置くと判定に落ちるため、並びは「青、橙、緑、黄」か「青、赤、黄、緑」にする

| 案 | グラフの 4 色 | 背景 |
|---|---|---|
| スタンダード | #2a78d6, #eb6834, #1baf7a, #eda100 | #ffffff |
| ナイトモード | #3a7fd6, #d9673a, #1a9e72, #c08a08 | #171e2d |
| グラデーション | #7b4bd6, #e0457b, #ee8a1f, #1c9a96 | #ffffff |
| 経済紙 | #2f66b0, #d0552a, #1d9a6c, #d49800 | #fbf8f1 |
| やわらか | #3f82e0, #ee6c3c, #1aa877, #e59f00 | #ffffff |
| 方眼ノート | #1d4fa3, #d0342c, #d99a00, #2e8b57 | #fffdf6 |
| 高密度 | #1f6fd1, #d9534f, #b98900, #20a070 | #ffffff |
| 北欧ミニマル | #2a7fb8, #d06a3e, #1f9a70, #cf9a12 | #ffffff |
| ブルータル | #2346d8, #ff4f2e, #e0a800, #12a150 | #ffffff |
| 藍と朱 | #2b5d9a, #d0473a, #c99a2e, #4f9a55 | #fbfaf6 |

黄系の色は背景とのコントラストが 3:1 未満になる。また高密度と藍と朱は、隣り合う色の差が下限ぎりぎり（色覚の模擬で ΔE 6.3）。どちらもグラフに数値のラベルか凡例の直接表示を添えることが条件になる。

## 5. R2（クラウド稼働）

要件定義 4.3 章（F-SYS-10〜15）と 6.3 章。完了条件は「クラウドで 7 日間、人手を介さず収集が続く。ログインしないと画面を見られない。収集停止の通知が届くことを確認した」。

- **着手の経緯（2026-10-02）**: 投稿のタイミングは本人が決められず、PC が止まっている間に投稿があるとストーリーズと投稿直後のデータが失われるため、R2.5（画面設計）より先に 24 時間収集を優先することをユーザーが選んだ。R2.5 は R2 と並行してよい（未着手）
- **進め方**: 設計書 `doc/design/r2-cloud.md` → `security-engineer`、`devops-architect`、`postgres-sql-reviewer`、`quality-engineer` が並列にレビュー → 差し戻しを反映 → 確認事項（Q）をユーザーに決めてもらう → 段階 A（DB）→ B（ワーカー）と C（Web）を並列 → D（運用）→ 7 日間の実機確認
- **2026-10-02: 設計書 0.2 まで完了**。0.1 は親（このセッション）が直接起草した。最初に `backend-architect` に起草を任せたが、外部文書 15 本を `curl` と `grep` で掘り続けて文脈が 46 万トークンに膨らみ、40 分で 1 行も書けずに停止させた（原因と対策は CLAUDE.md「サブエージェントへの依頼の決まり」と `.claude/agents/*.md`「読む量と進め方」に反映）。外部の事実は親が抜粋ベースで集めて 13 章に記録した。レビュー 4 本（計 74 件、各 5〜9 分、9〜11 万トークン）を 0.2 に反映済み。Q1〜Q11 は回答済み（Q1: 東京で作り直し。Q3: パスワード 8 文字以上。Q4: Healthchecks.io のアカウント作成済み。他は推奨どおり）
- **段階 A（DB）完了（2026-10-02）**: `supabase/migrations/20261002005926_r2_web_role.sql`（`web_app` ロール、列挙した grant と列単位の update、`private.store_token`、`private.web_users` と `private.is_web_user()`、RLS ポリシー、anon／authenticated の既定権限と関数の PUBLIC 実行権の取り消し、`thumbnails_read`）、`supabase/seed.sql`（ローカル専用パスワードと試験用利用者）、`apps/web/test/db/web-role.test.ts`（26 件）。`postgres-sql-reviewer`（14 件）と `security-engineer`（10 件）のレビューを反映。ローカルの DB には `npx supabase migration up --local` と seed で適用済み（常駐ワーカーがいるので `db reset` はしていない。設計 3.4 章のロールバック手順を 2 回検証した）。確定した事実は設計書 3.2.1 章と 13 章 P9〜P13。**段階 B と C は並列に実装済み（下）**
- **段階 B（ワーカー）実装済み（2026-10-02。`node-worker-developer`、12 分、約 100 回の呼び出し、20 万トークン）**: TLS（`DATABASE_SSL_CA`、フェイルクローズ）、`check-alerts`（純関数 `jobs/alerts.ts`、`--scope hourly|daily`、`WORKER_SIMULATE_ALERT`）、`token_check` の `app_id`／`profile_id` 検査、`appsecret_proof`、`.github/workflows/collect.yml`、`.github/dependabot.yml`。テスト 646 件（新規 63）。確定した差分は設計書 5.7 章
- **段階 C（Web）実装済み（2026-10-02。`nextjs-developer`、27 分、約 140 回の呼び出し、26 万トークン）**: `@supabase/ssr` でログイン（`/login`、Server Action、`proxy.ts` の `getClaims` と `decideAccess`、Route Handler の再確認、ログアウト）、`__Host-` の state Cookie、`DATABASE_POOL_MODE`／`DATABASE_SSL_CA`、`web_app` ロールでの接続、`private.store_token`、利用者セッションでの署名付き URL、`appsecret_proof`、R0 の接続状態表示の削除、`maxDuration`、`engines`。テスト 233 件、lint、型検査、`build:web`（全ルート `ƒ`）。確定した差分は設計書 4.6 章。ローカルの開発用の利用者（メールとパスワードは `.local/stage-C-progress.md`、Git 管理外）を Auth に作り、`private.web_users` と `apps/web/.env.local` の `WEB_ALLOWED_USER_ID` に入れた
- 段階 B・C のレビュー（`security-engineer` 11 件、`quality-engineer` 13 件。各 6〜10 分、12〜13 万トークン）を反映済み（2026-10-02）: ワークフローの `SIMULATE` の一元化（repo Variable でも収集を飛ばす）、`::add-mask::` に project ref と `SUPABASE_URL` のホスト、proxy のテスト `test/proxy.test.ts`（8 件）、403 には Cookie を写さない、リダイレクトの基点は `APP_URL`、認証 Cookie を https で `__Host-sb-auth`、ログイン画面の設定不足は固定文言、ナビは本人だけ、失敗の遅延を Server Action 側で保証、`_next/image` を公開経路から除外、`check-alerts` の `reason` と `days_left=unknown`（期限不明も警告）、`token_check` の `fb_page_id_missing` 警告、テストの補強（Web 242 件、ワーカー 646 件）。確定した内容は設計書 4.6 章と 5.7 章の末尾
- **段階 D 完了（2026-10-02）**: README に「クラウド稼働（R2）」（Supabase の設定、マイグレーションの適用、Vercel の 2 段の環境変数、Meta と Healthchecks、GitHub の Secrets と Variables、切り替え、ロールバック、7 日間の確認、運用）。ワークフローは main に入った時点でスケジュールが有効になるため、repo Variable `COLLECT_ENABLED=true` のときだけ動く門を付けた（未設定なら skip。失敗メールにならない）
- **2026-10-02 午後に判明**: リポジトリの所有者は組織 `smallpiece2024`（API で確認）。Vercel Hobby は組織所有のリポジトリに Git 連携できないため、対応を Q12 としてユーザーに確認中（推奨は個人アカウントへの Transfer）。親の `gh` は別アカウント（読み取りのみ）で、`workflow_dispatch` と Actions のログ取得はユーザー本人が行う。`collect.yml` のスケジュールは 11:17・12:17・13:17 JST の 3 回とも実行が記録されていない（`COLLECT_ENABLED` 未設定なので走っても skip のはず）。YAML は `js-yaml` で構文が通り、GitHub 上も `active`、コミットは `yo16` に紐づき、fork／archived ではない。残る原因は組織の Actions の方針か GitHub 側の都合で、ユーザー（組織の管理者）に Actions タブの表示、組織と リポジトリの Settings → Actions → General、画面からの「Run workflow」を依頼中。Supabase CLI は、新しいプロジェクトが見えないアカウントのままで `db push` が 403（`SUPABASE_DB_PASSWORD` を渡せば回避可）。アクセストークンでのログインを案内中
- **2026-10-02 午後**: クラウドの Supabase に `db push` 済み（6 本）。`\password web_app` と `private.web_users` も設定済み（ユーザー）。GitHub の `collect` は手動起動で `collect` ジョブが skip（`COLLECT_ENABLED` 未設定）になることを確認。repo Variables は `DATABASE_SSL_CA`、`COLLECT_KEEPALIVE=true`。親の `gh` はこのディレクトリ専用の設定ディレクトリ（`GH_CONFIG_DIR`、`.claude/settings.local.json`）に入れた、このリポジトリだけに効く Fine-grained token を使う（ユーザーの要望。他リポジトリの Actions 設定は 403 を確認。期限 2026-12-31 ごろ）
- **2026-10-02 夕方**: `collect.yml` の手動起動後も 15:17 JST の回が記録されず（5 回連続）、cron を 1 行（`17 * * * *`）に簡素化し、daily かどうかは実行時の UTC の時（20 時台）で決める `slot` ステップに変えた（`workflow_dispatch` に `run_daily` を追加）。16:17 JST 以降の回で動くかを確認する。Vercel は Git 連携済みで段 1 の環境変数を入れてデプロイでき、`/login` は出るがログインが「失敗」になる（クラウドの Supabase の利用者のメール確認か資格情報の問題とみて切り分け中）
- **2026-10-02 16 時ごろ: README「クラウド稼働（R2）」の 1〜3 が完了**。Vercel の本番でログインでき、段 2 の変数を入れたあと 3 画面が空の状態で表示された（`web_app`＋トランザクションモード＋TLS 検証つきの接続が通った。設計の U1／U5／U7 を確認済みに）。最初のログイン失敗は Vercel の `NEXT_PUBLIC_SUPABASE_*` に URL とキーを取り違えて入れていたのが原因
- **2026-10-02 16:40 ごろ: README の 1〜5 がすべて完了**（4: Meta のリダイレクト URI と Healthchecks のチェック。5: Secrets 6 つは GitHub の Environment `Production` に置かれたので、`collect` ジョブに `environment: Production` を指定した。Variables はリポジトリ）
- **GitHub のスケジュール実行が 16:17 JST の回まで 6 回連続で記録されない**。cron を 1 行にしても変わらず。切り分け用の一時ワークフロー `schedule-probe.yml`（15 分ごとに echo）を追加して、リポジトリ／組織の側の問題か `collect.yml` の中身の問題かを見た。**結果（2026-10-03 01:00 JST 時点）**: probe は main に入ってから約 33 回動くはずが 1 回（23:08 JST）だけ、collect も 22:52 JST の 1 回だけ。定義の条件（既定のブランチ、UTC、5 分以上、60 日の無効化、実行者）はすべて満たしており、GitHub のコミュニティにも 2026-07〜10 に同じ症状の報告がある（Discussion #206019、#202034。分をずらしても直らず、外部から `workflow_dispatch` を呼ぶのが有効だったとの報告）。GitHub 側の問題と判断して probe は削除した（2026-10-03）。外部からの起動（候補はクラウドの Supabase の `pg_cron`＋`pg_net`。サービスを増やさないため）を検討する
- GitHub の組織 `smallpiece2024` の Actions permissions は「Allow all actions and reusable workflows」（ユーザー確認。原因ではない）
- **毎時の起動を pg_cron に移した（2026-10-03。ユーザーの決定で Supabase に一本化）**: マイグレーション `20261003000000_r2_collect_dispatch.sql`（`pg_cron` ＋ `http` 拡張機能、`private.dispatch_collect()`、ジョブ `collect-dispatch` と `cron-history-purge`）。`collect.yml` は `workflow_dispatch` だけにし、`keepalive` と `COLLECT_KEEPALIVE` を廃止。daily は起動側が `run_daily` で渡す。設計は `r2-cloud.md` 5.8 章、手順は README 5.1。レビュー 2 本（`postgres-sql-reviewer` 2.7 分・12 回・5.8 万トークン、`security-engineer` 2.1 分・8 回・5.8 万トークン）を反映: 当初の pg_net はキューの表を PUBLIC が読めて `web_app` からトークンが見えるため `http` に変更（同期、2xx 以外は例外で `cron.job_run_details` に残る）、`security invoker`、トークンの形の検査、Environment `Production` を `main` に限る、concurrency の待機は 1 本だけ、daily の 1 回きりを既知の制約に。ローカルで適用・再適用・偽トークンで 401 の例外まで確認、テスト（Web 242、ワーカー 646）通過
- **README 5.1 を本番に適用（2026-10-03 01:40 JST ごろ、ユーザー）**: Fine-grained トークンを作成（最初は 30 日で作ってしまったので、同日に Regenerate して Vault の値を差し替え、204 を再確認。期限は GitHub の表示で **2027-01-01（金）**。**12 月中旬に作り直して Vault の値を差し替える**。親の gh 用のトークン（2026-12-31）と同じ時期に更新する）、`db push`（CLI のアカウントが 403 のため前回と同じ回避）、Vault に `collect-dispatch-token`、`select private.dispatch_collect()` が 204 で、`collect` の `workflow_dispatch` 実行（01:39 JST、`skipped`）を確認。Environment `Production` は `main` だけ（API で `custom_branch_policies: true` を確認）、`COLLECT_KEEPALIVE` は削除済み
- **pg_cron の毎時の起動を確認（2026-10-03）**: 02:17〜23:17 JST の 22 回すべて `workflow_dispatch` で記録され、遅れは 1〜2 秒（`COLLECT_ENABLED` 未設定なので `skipped`）。初回は 07:30 JST にクラウドの Claude Code のルーティン（1 回きり）で確かめる予定だったが、実行環境にリポジトリのアクセスがなく GitHub API が拒否して未確認に終わった（ルーティンは停止済み）。手元の確認で代えた。手元のワーカーは PC の停止で 01:05〜07:10 JST に収集が抜けた（02:05〜06:05 の hourly と 05:30 の daily）
- **README 6 の切り替えを実施（2026-10-03 23:05〜23:29 JST）**: README から外した点: サムネイルの rclone は 1 回だけ（25 件、898 kB と小さいため。ワーカーを止める前の 23:05 にコピーし、23:05 の hourly で増えていないことを確認）、流し込みのリハーサルは省略（`--single-transaction` と `ON_ERROR_STOP` で失敗は全体が取り消されるため）。手元の PC に psql がないので、手元の DB コンテナの psql 17.6 で本番に接続した（CA は Variable `DATABASE_SSL_CA` から書き出してコンテナに置いた。接続先は `supabase/.temp/pooler-url`）。Windows PowerShell 5.1 は `'...'` の中の `"..."` を外部コマンドに渡すときに外すので、`sh -c '...'` で接続文字列を渡すと引数が割れて `ENOIDENTIFIER`（ユーザー名に ref がない）になる。コマンドはスクリプトにしてコンテナに置き、`docker exec -it … sh /tmp/import.sh` で動かした。流し込みは INSERT 13,446 件で数分かかり、画面に何も出ないため途中で止めた回がある（1 トランザクションなので取り消されただけ）。件数は 9 表とも手元と一致（`account_daily_metrics` 11,379、`raw_api_responses` 1,841 など）。本番の `/connect` で接続（権限の不足なし、データアクセス期限 2027-01-01）。Repository variable `COLLECT_ENABLED=true` を `gh` で作成（Environment の Variables はジョブの `if:` から見えない）。23:28 JST の手動の hourly が `success`（stories／media_sync／media_snapshot、`check-alerts` の alerts=0、Healthchecks の ping）。一時ファイル（ダンプ、スクリプト、ログ）は削除し、S3 のアクセスキーもクラウドの Supabase で削除した（ユーザー）。`.local/prod-ca-2021.crt`（公開の CA）は残してある。原因が分かっていないこと: 最初の流し込み（`-q` 付き、コンテナの外から接続文字列を渡した回）はエラーを出さずに `set_config` の結果だけ表示して終わり、件数は 0 だった
- **R1 の 3 日間の確認は、切り替えで手元のワーカーを止めたので 2026-10-03 23:05 JST で終わり**。結果（9.3 章の項目）は手元の DB に残っているので、まとめるときは手元の Supabase を `db reset` せずに集計する
- **次**: 2026-10-04 00:17 JST に pg_cron が起動した実行を T0 として 7 日間の確認（README 8）。05:17 JST の回で daily が初めて本番で動く。通知の試験（README 8。`simulate_alert`、`WORKER_SIMULATE_ALERT`、Healthchecks の使い捨てチェック）は T0 の前に済ませる予定だったが未実施なので、確認の期間中に行う。手元のワーカーは止めたまま（`npm run worker:up` はロールバックのときだけ）。7 日間の確認で進めた手順と実際の値（欠損の時間帯、遅延の分布、Usage）をここに記録する
- **7 日間の確認の中間結果（2026-10-05 08:30 JST 時点、`gh run list` による）**: 切り替え後の `collect` 33 回（10-03 23:28 の手動 ～ 10-05 08:17）はすべて `success`、`cancelled` 0、毎時 17 分の抜けなし。pg_cron の 17 分から `createdAt` までの遅れは 1〜2 秒、`startedAt` は `createdAt` と同時刻、所要は 46〜92 秒（daily の回が長い）。daily は 10-04 と 10-05 の 05:17 JST の 2 回（`utc_hour=20 daily=true`）。10-05 の daily の回のログ: `token_check`（データアクセス残り 88 日）、`profile_daily`、`account_daily`（09-30〜10-03、233 件）、`media_sync --full`、hourly 一式が `success`、`check-alerts --scope daily` は `alerts=0`。ログを `://` と 10 桁以上の数字列で検索して、Actions のランナーや apt、GitHub の URL 以外は 0 件。`account_backfill` は走っていない（手元で終わった `job_state` が移っているため）。DB 側の項目（`job_runs` の件数と間隔、`cron.job_run_details`、Usage）は本番 DB に接続して後日まとめて見る
- **通知の試験（2026-10-05、10.3 章）**:
  - GitHub のメール（dispatch）: 08:24 JST に `gh workflow run collect.yml -f simulate_alert=true`。daily と hourly は skip、`check-alerts` が `alert=simulated`／`alerts=1` で終了コード 1、ping は送られた。失敗メール（「Run failed: collect - main」、宛先 `yo16`）が実行の終了から約 20 秒で届いた（ユーザー確認）
  - GitHub のメール（pg_cron の起動）: 08:53 JST ごろに `gh variable set WORKER_SIMULATE_ALERT --body true`。09:17 の pg_cron の起動の実行（`workflow_dispatch`）が `SIMULATE: true` で収集を飛ばし、`alert=simulated` で失敗。失敗メール（「collect / collect Failed in 38 seconds」）がトークンの持ち主に届いた（ユーザー確認。13 章 G3 は確認済み）。Variable はジョブ開始の 1 秒後（00:17:16 UTC）に削除し、飛ばした回の代わりに 09:17:33 JST に通常の hourly を手動で起動して `success`（`SIMULATE: false`、4 ジョブ、`alerts=0`）。このため 10-05 00 時台（UTC）の `media_snapshot` は手動の 1 回で数える
  - Healthchecks: 本番のチェックに毎時 17〜18 分の ping と 08:24 の試験の ping が届いている（ユーザー確認）。使い捨てのチェック（Period 1 分、Grace 1 分）を 1 回 ping し、約 2 分で down のメールが届いた（ユーザー確認）
  - Supabase の一時停止の警告: 7 日間で来ないことを記録する
- **未ログインの確認（2026-10-05、10.2 章）**: 本番の Vercel に curl で、`GET /`、`/jobs`、`/media`、`/connect` がすべて 303 で `/login` へ、`/login` は 200、`POST /api/meta/login`（Origin は本番）が 303 で `/login` へ、`GET /api/meta/callback?code=x&state=y` が 303 で `/login` へ（登録されない）。本人でログインすると 3 画面が本番のデータで出て、サムネイルも出る（ユーザー確認）
- **R2.5 第 1 ラウンドの design-lab v1 を作成（2026-10-02。`dashboard-designer`、25 分、約 50 回の呼び出し、21 万トークン）**: `doc/design-lab/`（README、`v1/index.html` の切り替え・並列表示・10 案一覧、見本画面 7 つ、`lab.css`／`parts.css`、架空データ `data.js`、`render.js`、`variants.js`、`tokens/tokens-01〜10.css`）。配色は 10 案すべて検証 PASS（黄系のコントラスト WARN と、高密度・藍と朱の CVD 6.3 は準備メモどおりで、ラベルと表を添える条件つき）。**ブラウザでの目視はユーザーが行う**（`doc/design-lab/v1/index.html` をダブルクリック）。使い捨ての比較用なので、コードの厳密さは求めない（ユーザーの方針）
  - 画面を作って見えた、要件への反映候補（第 2 ラウンドまでにユーザーと決める）: (1) F-UI-20 の日次推移はフォロワー数とリーチの桁が違うので縦に並べた 2 つのグラフにする、(2) 投稿日（JST）と日次指標（PT）の日付のずれの扱い、(3) モバイルの投稿一覧で出す指標の既定（4 つ）と切替、(4) 中央値・区分比較の最小件数（n<2 か 3 は薄く表示）、(5) ストーリーズ最後の 1 枚の離脱率の扱い、(6) 投稿時刻ヒートマップの時間帯の区切りと空欄、(7) 接続と収集ログに API 使用率・連続失敗回数・次回予定・トークン期限の注意 14 日／重大 7 日を足すか、(8) 画面 15 個のナビを 3 群に分ける、(9) 黄系の系列色と注意色の衝突（案 06・07・10）、(10) サムネイルの URL 期限切れへの R3 の方針
- **R2.5 第 1 ラウンドのフィードバックと第 2 ラウンドの方針（2026-10-02）**: ユーザーの評価は、色合いが 10 藍と朱 > 01 スタンダード > 04 経済紙 > 06 方眼ノート の順。方眼のような背景の模様、明朝、黒い線、影は不要。角丸はあった方がよいが 05 の R は大きすぎる。05 は文字色のコントラストが弱い。これを受けて、見本画面と架空データは v1 のままトークンだけを差し替える v2 の 10 案（藍と朱を軸に、地の色、差し色の有無、ヘッダーの帯、ゴシックの種類、角丸、カードの縁、密度を振る）の方針を `doc/design-lab/README.md`「第 2 ラウンド（v2）の方針」に記載。次は `dashboard-designer` に v2 を作らせ、ユーザーが目視して 1 案に決める。要件への反映候補 (1)〜(10) は選定後にまとめて決める
- **R2.5 のデザインシステムを決定（2026-10-02）**: 第 2 ラウンド（`doc/design-lab/v2/`）と第 3 ラウンド（`v3/`。v2 の 03・05・07 の組み合わせ）を経て、`v3/tokens/tokens-01.css`（スタンダード・朱。白いカードに青と朱、Noto Sans JP、角丸 8px、影なし）に決めた（ユーザー）。次は採用案の `:root` を `doc/design-system.md` に書き出し、R3 で `apps/web` に移す
- **R2.5 の画面ごとの検討（2026-10-02〜03）**: `doc/design-lab/v3/` の見本画面（採用案 01）で、概要、投稿一覧、投稿詳細、リール分析、ストーリーズを 1 画面ずつ見直し、決めたことを要件定義に反映した（F-UI-20〜22、F-UI-29、F-UI-40、用語集のリーチ率）。主な決定: 率の前期間比は pt、概要のファネルは置かない、投稿一覧は並べ替えとページ切り替え（絞り込みなし）、投稿詳細は量と質の指標を帯グラフで同じ種類と比べる、リール分析の目的変数はリーチ率（7 日時点のリーチ ÷ 投稿時のフォロワー数）で件数に応じて手法を切り替える、ストーリーズは 1 件ずつ日をまたいで比べる。残りは投稿時刻と接続と収集ログの画面
- **R2.5 の投稿時刻の画面を検討（2026-10-05）**: `doc/design-lab/v3/` の見本で見直し、要件 F-UI-42 に画面の構成を書いた。曜日 × 時間帯のヒートマップ（全幅）、時間帯別と曜日別の棒グラフ（曜日別を追加）、上位の組み合わせに投稿ごとの帯グラフを追加。見出しは何の数値かを書き、件数 1 件は「※」で示す（半透明は中央値の濃さと区別できないのでやめた）。画面の下の注記と説明文は消した。残りは接続と収集ログの画面
- **ユーザーにお願いすること（設計の確認事項が決まってから）**: Supabase Cloud のプロジェクト作成、Vercel のプロジェクト作成と GitHub 連携、GitHub Secrets と Vercel の環境変数の登録、Meta アプリの「有効な OAuth リダイレクト URI」に本番の callback を追加、ログイン用の利用者の作成
- **2026-10-02: Supabase Cloud と Vercel のプロジェクトはユーザーが作成済み**（設計の確定前。Vercel の Root Directory は `apps/web`）。プロジェクトの ref、本番 URL、DB パスワード、鍵はリポジトリに書かず、ローカルの `.env`／`apps/web/.env.local`（Git 管理外）、GitHub Secrets、Vercel の環境変数にだけ置く。ログイン（F-SYS-13）を実装するまで Vercel に本番 DB の接続文字列と鍵を入れない（画面が誰にでも見えるため）
- **切り替えの順序（R1 の申し送り）**: ローカルの常駐を `npm run worker:down` で止めてから、データ移行 → トークンの再登録 → GitHub Actions の有効化。ローカルと Cloud は DB が別なので、二重収集はロックでは防げない

## 6. 作業の決まりごと

- ユーザーへの応答は日本語。コミットメッセージも日本語。
- Git: ブランチで作業し、まとまった単位でローカルの main に `--no-ff` でマージして push する。マージ済みブランチは削除する。指示を待たずに行ってよい。
- 公開リポジトリなので、秘密情報、取得データ、アカウントの ID やユーザー名をコミットしない（要件 NF-SEC-06、NF-SEC-07）。
- Next.js 16 は従来と API が違うので、コードを書く前に `node_modules/next/dist/docs/` を読む（`apps/web/AGENTS.md`）。
- AI や有料 OCR を使う前に、`doc/ai-decisions/` に検討メモを書いてユーザーの了承を得る（要件 8.7 章）。


# 進捗と次の作業

作業を再開するときは、まずこの文書を読む。区切りごとに更新する。

| 項目 | 内容 |
|---|---|
| 最終更新 | 2026-10-13 |
| 現在地 | **R2（クラウド稼働）は 2026-10-03 23:29 JST に切り替えを終え、収集は GitHub Actions（クラウドの Supabase の pg_cron が毎時起動）で本番の DB に入っている。R2 は 7 日間の確認を 2026-10-11 に終えて完了（5 章）。R3（基本分析）は 2026-10-06 に完了。R4（動画分析：長さとカット）は 2026-10-08 に完了（8 章）。R5（投稿分類、ストーリーズ、オーディエンス、投稿時刻）は 2026-10-09 に完了（9 章）。R4.1（動画分析：画面の文字）は 2026-10-11 に着手し、2026-10-12 に完了（10 章。本番の 19 本すべてに文字の区間が入り、ユーザーが直近 3 本を目視して合格、手元の鍵を削除）。R6（月次レポート、伸びた投稿の検出、低下の通知）は 2026-10-13 に着手し、確認事項の決定、設計 0.4、段階 1〜3 の実装、段階 5 のレビューまで終えた（11 章）。残りは段階 4（ユーザーの `db push` → main のマージ → Vercel）と受け入れ。ほかに、11 月 1 日（UTC）以降に GitHub の変数 `WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT` を 1000 に戻すこと。次回やることは 11 章の末尾。favicon とヘッダーのブランドの印は 2026-10-13 にユーザーの用意した画像（`temp/`、Git 管理外）から作って main に入れた（R6 とは独立。`apps/web/src/app/favicon.ico` は 16・32・48px、`src/components/brand-mark.png` は 88px。`/favicon.ico` と `/_next/static/` は proxy の保護の外なので未ログインでも出る）** |
| 要件定義 | [requirements/requirements-definition.md](requirements/requirements-definition.md)（版 0.5） |

---

## 1. リリースの状況

| リリース | 内容 | 状況 |
|---|---|---|
| R0 | ローカル開発環境と API 検証 | **完了**（2026-09-30） |
| R1 | 収集基盤（ローカル） | 仕上げ中。DB、ワーカー（7 ジョブとスケジューラ）、最小限の画面、Facebook Login の接続まで実装し実機確認済み（2026-10-02）。残りは 3 日間の収集確認（2026-10-01 深夜開始）の結果の記録 |
| R2 | クラウド稼働（Supabase Cloud、Vercel、GitHub Actions） | **完了**（2026-10-11、5 章）。段階 A〜D と README の手順 1〜5 まで完了（2026-10-02）。GitHub の schedule が動かないため、毎時の起動をクラウドの Supabase の pg_cron に移した（2026-10-03。README 5.1 まで本番に適用済み）。2026-10-03 23:29 JST に切り替えを終え、本番で収集中。7 日間の確認（T0 は 2026-10-04 00:17 JST）は 10-11 に終わり、GitHub 側の記録を 5 章に書いた（毎時の枠 169 回のうち実行のない枠 1 回、`media_snapshot` 成功 172 回、daily 7 回）。DB 側は 10-11 にユーザーが SQL で確認（起動 168 成功・1 失敗、残骸 0 行） |
| R2.5 | 画面設計（架空のデータのプロトタイプ、デザインシステムの比較） | **完了**（2026-10-05）。design-lab v1〜v3 を経て v3 の案 01 に決定（`doc/design-system.md`）。7 画面を見直し、決定を要件定義に反映 |
| R3 | 基本分析（概要、投稿一覧、初速、期間比較） | **完了**（2026-10-06）。`doc/design/r3-analysis-screens.md` 版 0.2（2026-10-05。`nextjs-developer` が起草、`postgres-sql-reviewer`・`security-engineer`・`quality-engineer` のレビューを反映）。確認事項 Q1〜Q20 はすべて推奨どおり（版 0.3）。SQL の再レビューで、収集開始前の投稿 24 件には 7 日時点の値がなく比較が空になると分かり、比較は常に各投稿の最新の値どうしで行い、投稿詳細と投稿一覧に投稿からの経過日数を出すことにした（Q21、版 0.5。データの状況で比べ方を自動で切り替えない、説明の文言を増やさない、とユーザー）。段階 0・1（5 画面と CSV）と段階 2 の 1〜3（テスト、セキュリティレビュー、性能計測）を終えた（2026-10-06、6 章）。本番での数値の照合は省き、ユーザーが PC とスマートフォンで画面を確認して完了（2026-10-06） |
| R4 | 動画分析（長さとカット） | **完了**（2026-10-08、8 章）。2026-10-07 に db push と main へのマージ。本番でリール 18 本すべてを解析し、ユーザーが本番の `/reels` と投稿詳細のタイムラインを確認した。ffmpeg による解析は R0 で、ストーリーズの動画の解析（`video_analyses`、`video_cuts`、`lib/video-analysis.ts`）は R1 で実装済み |
| R4.1 | 動画分析（画面の文字） | **完了**（2026-10-12、10 章）。方式は Google Cloud Vision（検討メモ 0.2、要件定義 0.5）。設計書 0.3 → 段階 1〜3 を並列に実装 → 本番に反映（19 本すべて `success`、601 ユニット）→ セキュリティと品質のレビューを反映。ユーザーが本番の画面を確認し、直近 3 本を Instagram のアプリと比べて合格条件 6 項目とも問題なし（2026-10-12）。手元の鍵は削除。11 月 1 日（UTC）以降に月の上限の変数を 1000 に戻す |
| R5 | 投稿分類、ストーリーズ、オーディエンス、投稿時刻の分析 | **完了**（2026-10-09、9 章）。2026-10-08 に本番に反映し、10-09 にユーザーが本番の全画面を確認。オーディエンスは性別と年齢を円グラフにし、推移のカードを外した（完了条件を「属性の内訳」に改めた） |
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
- **7 日間の確認の結果（2026-10-11、親。T0 = 10-04 00:17 JST、終わり = 10-11 00:17 JST。`gh run list` の 176 回と、各実行のログの `job=` の行から集計）**:
  - 毎時の枠 169 回（T0 と終わりを含む）のうち、GitHub の実行がない枠は **1 回**（10-07 09:17 JST）。前後の実行の間隔はちょうど 2 時間で、設計 10.2 章の「2 時間未満」を満たさない。pg_cron が起動を送ったか（送って GitHub が拒んだか、送っていないか）は `cron.job_run_details` で確かめる（下のユーザーの確認待ち）。ほかの 168 枠はすべて 17 分の 1〜2 秒後に起動し、収集は `success`
  - 実行は 176 回（`success` 169、`failure` 6、`cancelled` 1）。`failure` 6 回の内訳: 通知の試験 2 回（10-05 08:24、09:17）、ランナーが割り当てられず 15 分で取り消された 1 回（10-06 05:17。6 章に記録済み。`run_daily=true` の手動起動で補った）、ffmpeg の apt-get の 5 分超過 3 回（10-08 03:17・05:17・22:17 JST。`video_analysis` だけ `failed` で、ほかのジョブは成功。9 章の「収集の ffmpeg の入れ方を変えた」の日付「10-07 03:17・05:17」は正しくは 10-08 03:17・05:17。10-08 22:45 に静的ビルドとキャッシュに変えて以降は再発なし）。`cancelled` 1 回は R4 の反映時の手動起動（10-07 23:42、8 章）
  - ジョブの結果（ログの行）: `media_snapshot` は `success` **172 回**（`partial`・`failed`・`skipped` は 0。収集を飛ばした試験 2 回と取り消し 2 回を除く全実行）。`stories` 172、`media_sync` 179（daily の `--full` を含む）、`video_analysis` 74 成功・3 失敗（上の apt）、`audience_demographics` 2（10-09、10-10）。daily の `token_check`・`profile_daily`・`account_daily` は **7 回ずつ**（10-04、10-05、10-07〜10-10 の 05:17 と、10-06 の 10:59 の補い）。トークンのデータアクセスの残りは 89 日 → 83 日
  - `check-alerts` の行は、取り消された 2 回を除く全実行に 1 回ずつ。`alerts=1` は通知の試験の 2 回だけ
  - 所要は 32〜92 秒が常態（中央値 57 秒）。例外は apt の超過の回（約 6 分）とランナー待ちの回（15 分）。起動の遅れは常態で 1〜2 秒なので、分をずらす必要はない
  - **ユーザーの確認待ち**（本番の DB とダッシュボード。手元からは本番の DB に接続しない）: (1) クラウドの Supabase の SQL エディタで下の SQL を実行して結果を貼る、(2) Supabase の一時停止の警告メールが 10-04〜10-11 に来ていないこと、(3) Supabase の Usage（DB、Storage、egress）と Vercel の Usage の値。(1)〜(3) がそろえば R2 を完了にする

    ```sql
    -- (1) 起動の成否（T0 = 2026-10-03 15:17 UTC、終わり = 2026-10-10 15:17 UTC）
    select status, count(*) from cron.job_run_details
    where jobid = (select jobid from cron.job where jobname = 'collect-dispatch')
      and start_time between '2026-10-03 15:00+00' and '2026-10-10 15:30+00'
    group by status;
    -- (2) 失敗した回と、GitHub に実行の記録がない 10-07 00:17 UTC の回
    select start_time, status, return_message from cron.job_run_details
    where jobid = (select jobid from cron.job where jobname = 'collect-dispatch')
      and (status <> 'succeeded' or start_time between '2026-10-07 00:00+00' and '2026-10-07 01:00+00')
    order by start_time;
    -- (3) job_runs の残骸（0 行なら問題なし）と、media_snapshot の隣り合う実行の最大の間隔
    select job_name, status, count(*) from public.job_runs
    where started_at between '2026-10-03 15:17+00' and '2026-10-10 15:17+00'
      and status in ('running', 'skipped', 'failed', 'partial')
    group by job_name, status;
    select max(gap) from (
      select started_at - lag(started_at) over (order by started_at) as gap
      from public.job_runs where job_name = 'media_snapshot' and started_at >= '2026-10-03 15:17+00'
    ) g;
    -- (4) 表の大きさ
    select n.nspname, c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as size
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc limit 15;
    ```
- **本番の DB の結果（2026-10-11、ユーザーがクラウドの Supabase の SQL エディタで上の SQL を実行）**: (1) `collect-dispatch` は 169 回中 **168 回 `succeeded`、1 回 `failed`**。(2) 失敗は 10-07 00:17 UTC（09:17 JST）の回で、`return_message` は `Failed to connect to api.github.com port 443 after 1002 ms: Timeout was reached`。pg_cron は動いたが、GitHub への接続が 1 秒で打ち切られ、起動が送られなかった。原因は http 拡張機能（pgsql-http）が接続の制限時間 `CURLOPT_CONNECTTIMEOUT_MS` を既定で 1,000 ms にしていること（`http.c` の `http_get_handle()`。2026-10-11 に確認）。`private.dispatch_collect()` は全体の制限時間 `CURLOPT_TIMEOUT` を 15 秒にしているが、接続の制限時間は既定のまま。169 回中 1 回なので R2 の完了は妨げない。再発を減らすなら、新しいマイグレーションで `http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '10')` を足す（ユーザーの判断。設計 5.8 章の「再試行しない」は変えない）。(3) `job_runs` の残骸（`running`・`skipped`・`failed`・`partial`）は 0 行。`media_snapshot` の隣り合う実行の最大の間隔は **2 時間 9 分 33 秒**（10-06 04:18 → 06:28 JST）。原因は GitHub のランナー不足で、05:17 の回が 15 分待って取り消され、06:17 の回も 10 分待ってから動いた（6 章の「日次の収集の取りこぼし」と同じ出来事。pg_cron の起動は両方とも成功）。10-07 09:17 JST の抜けの間隔は 1 時間 59 分 57 秒。(4) 表の大きさは `raw_api_responses` 9.7 MB、`account_daily_metrics` 3.6 MB、`job_runs` 496 kB、`media` 224 kB、ほかは 120 kB 以下で、合計 15 MB 程度。Supabase の一時停止の警告メールは来ていない（2026-10-11、ユーザー確認）。Usage の値は未記録（表の大きさで代える）
- **起動の接続の制限時間を 10 秒にするマイグレーション（2026-10-11、ユーザーの指示）**: `supabase/migrations/20261011000000_r2_dispatch_connect_timeout.sql`。`private.dispatch_collect()` を `create or replace` で定義し直し、`http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '10')` を 1 行足した（本文、再試行しない方針、権限は同じ。取り消しは再掲）。設計 5.8 章の表も直した。**手元で確認済み（2026-10-11、親）**: Docker Desktop を起動（Supabase のコンテナは自動で戻る。手元の常駐ワーカーは止めたまま）し、`npx supabase migration up --local` でこの 1 本だけが当たった。`apps/web/test/db/web-role.test.ts` 36 件が通過（`web_app` などが `dispatch_collect` を実行できない）。関数の定義に `CURLOPT_CONNECTTIMEOUT` が入り、`web_app`・`anon` の実行権は false、Vault 未登録のまま呼ぶと null。**本番に反映済み（2026-10-11、ユーザーが `npx supabase db push`）**。次の毎時 17 分の起動から接続の制限時間 10 秒で動く
- **R2 の完了（2026-10-11）**: 完了条件「クラウドで 7 日間、人手を介さず収集が続く。ログインしないと画面を見られない。収集停止の通知が届くことを確認した」を満たした。毎時の収集は 7 日間続き、抜けは起動の接続の 1 回だけで翌時に自動で続いた。手を入れたのは 10-06 の daily の補い 1 回（同日に `daily-due` で自動化済み）。未ログインの確認と通知の試験は 10-05 に済み
- **未ログインの確認（2026-10-05、10.2 章）**: 本番の Vercel に curl で、`GET /`、`/jobs`、`/media`、`/connect` がすべて 303 で `/login` へ、`/login` は 200、`POST /api/meta/login`（Origin は本番）が 303 で `/login` へ、`GET /api/meta/callback?code=x&state=y` が 303 で `/login` へ（登録されない）。本人でログインすると 3 画面が本番のデータで出て、サムネイルも出る（ユーザー確認）
- **R2.5 第 1 ラウンドの design-lab v1 を作成（2026-10-02。`dashboard-designer`、25 分、約 50 回の呼び出し、21 万トークン）**: `doc/design-lab/`（README、`v1/index.html` の切り替え・並列表示・10 案一覧、見本画面 7 つ、`lab.css`／`parts.css`、架空データ `data.js`、`render.js`、`variants.js`、`tokens/tokens-01〜10.css`）。配色は 10 案すべて検証 PASS（黄系のコントラスト WARN と、高密度・藍と朱の CVD 6.3 は準備メモどおりで、ラベルと表を添える条件つき）。**ブラウザでの目視はユーザーが行う**（`doc/design-lab/v1/index.html` をダブルクリック）。使い捨ての比較用なので、コードの厳密さは求めない（ユーザーの方針）
  - 画面を作って見えた、要件への反映候補（第 2 ラウンドまでにユーザーと決める）: (1) F-UI-20 の日次推移はフォロワー数とリーチの桁が違うので縦に並べた 2 つのグラフにする、(2) 投稿日（JST）と日次指標（PT）の日付のずれの扱い、(3) モバイルの投稿一覧で出す指標の既定（4 つ）と切替、(4) 中央値・区分比較の最小件数（n<2 か 3 は薄く表示）、(5) ストーリーズ最後の 1 枚の離脱率の扱い、(6) 投稿時刻ヒートマップの時間帯の区切りと空欄、(7) 接続と収集ログに API 使用率・連続失敗回数・次回予定・トークン期限の注意 14 日／重大 7 日を足すか、(8) 画面 15 個のナビを 3 群に分ける、(9) 黄系の系列色と注意色の衝突（案 06・07・10）、(10) サムネイルの URL 期限切れへの R3 の方針
- **R2.5 第 1 ラウンドのフィードバックと第 2 ラウンドの方針（2026-10-02）**: ユーザーの評価は、色合いが 10 藍と朱 > 01 スタンダード > 04 経済紙 > 06 方眼ノート の順。方眼のような背景の模様、明朝、黒い線、影は不要。角丸はあった方がよいが 05 の R は大きすぎる。05 は文字色のコントラストが弱い。これを受けて、見本画面と架空データは v1 のままトークンだけを差し替える v2 の 10 案（藍と朱を軸に、地の色、差し色の有無、ヘッダーの帯、ゴシックの種類、角丸、カードの縁、密度を振る）の方針を `doc/design-lab/README.md`「第 2 ラウンド（v2）の方針」に記載。次は `dashboard-designer` に v2 を作らせ、ユーザーが目視して 1 案に決める。要件への反映候補 (1)〜(10) は選定後にまとめて決める
- **R2.5 のデザインシステムを決定（2026-10-02）**: 第 2 ラウンド（`doc/design-lab/v2/`）と第 3 ラウンド（`v3/`。v2 の 03・05・07 の組み合わせ）を経て、`v3/tokens/tokens-01.css`（スタンダード・朱。白いカードに青と朱、Noto Sans JP、角丸 8px、影なし）に決めた（ユーザー）。次は採用案の `:root` を `doc/design-system.md` に書き出し、R3 で `apps/web` に移す
- **R2.5 の画面ごとの検討（2026-10-02〜03）**: `doc/design-lab/v3/` の見本画面（採用案 01）で、概要、投稿一覧、投稿詳細、リール分析、ストーリーズを 1 画面ずつ見直し、決めたことを要件定義に反映した（F-UI-20〜22、F-UI-29、F-UI-40、用語集のリーチ率）。主な決定: 率の前期間比は pt、概要のファネルは置かない、投稿一覧は並べ替えとページ切り替え（絞り込みなし）、投稿詳細は量と質の指標を帯グラフで同じ種類と比べる、リール分析の目的変数はリーチ率（7 日時点のリーチ ÷ 投稿時のフォロワー数）で件数に応じて手法を切り替える、ストーリーズは 1 件ずつ日をまたいで比べる。残りは投稿時刻と接続と収集ログの画面
- **R2.5 の投稿時刻の画面を検討（2026-10-05）**: `doc/design-lab/v3/` の見本で見直し、要件 F-UI-42 に画面の構成を書いた。曜日 × 時間帯のヒートマップ（全幅）、時間帯別と曜日別の棒グラフ（曜日別を追加）、上位の組み合わせに投稿ごとの帯グラフを追加。見出しは何の数値かを書き、件数 1 件は「※」で示す（半透明は中央値の濃さと区別できないのでやめた）。画面の下の注記と説明文は消した。対象の期間は過去 1 年間（リール分析もそろえた）、指標と種類の選択は残す。見た目は確定（ユーザー）。あわせて、モバイル幅のメニューを文字幅に合わせた複数段のタブにした（`lab.css`）。接続と収集ログの画面は、ジョブの記録の説明文と、再接続・トークンの確認のボタンを消した。BI の利用者は Facebook ページの管理者ではなく、誤操作を防ぎたいため（ユーザー）。トークンの更新は本番の `/connect` から行う（ボタンを消しても入口は残る）。誤操作の影響は、コールバックの処理を確かめた結果、他人の Instagram アカウントが 2 つ目として登録されて収集の対象に加わる場合だけだった（今のアカウントのトークンは上書きされない）。管理者と閲覧者に分ける案も検討したが、触るのは本人ともう 1 人でログインの利用者を共有するため、本番の Vercel に `META_TARGET_IG_USER_ID` を入れて他のアカウントを登録させないだけにした（要件 F-SYS-16。2026-10-05 にユーザーが設定して再デプロイ済み）。もう 1 人は Instagram の担当者で、Facebook のアカウントにはアクセスできないので、接続の操作をしても Facebook のログインで止まる。Instagram 側で Facebook ページとの連携やプロアカウントの設定を変えると収集が止まる（メールで分かる）ので、変えないよう伝える。同日、本番のログインのパスワードを忘れたため、クラウドの Supabase で利用者を同じメールで作り直し、`private.web_users` と Vercel の `WEB_ALLOWED_USER_ID` を新しい `id` に差し替えた（ユーザー。ログインを確認済み）。パスワードの再設定の画面はない。**これで R2.5 は完了**
- **ユーザーにお願いすること（設計の確認事項が決まってから）**: Supabase Cloud のプロジェクト作成、Vercel のプロジェクト作成と GitHub 連携、GitHub Secrets と Vercel の環境変数の登録、Meta アプリの「有効な OAuth リダイレクト URI」に本番の callback を追加、ログイン用の利用者の作成
- **2026-10-02: Supabase Cloud と Vercel のプロジェクトはユーザーが作成済み**（設計の確定前。Vercel の Root Directory は `apps/web`）。プロジェクトの ref、本番 URL、DB パスワード、鍵はリポジトリに書かず、ローカルの `.env`／`apps/web/.env.local`（Git 管理外）、GitHub Secrets、Vercel の環境変数にだけ置く。ログイン（F-SYS-13）を実装するまで Vercel に本番 DB の接続文字列と鍵を入れない（画面が誰にでも見えるため）
- **切り替えの順序（R1 の申し送り）**: ローカルの常駐を `npm run worker:down` で止めてから、データ移行 → トークンの再登録 → GitHub Actions の有効化。ローカルと Cloud は DB が別なので、二重収集はロックでは防げない

## 6. R3（基本分析）

ブランチ `r3/stage0` は main にマージ済み（2026-10-06）。設計は `doc/design/r3-analysis-screens.md`。

- **段階 0（土台）**: 分析用のビュー（`supabase/migrations/20261005000000_r3_analysis_views.sql`）、画面の土台と共通部品（`components/`、`components/charts/`）、共通のクエリ（`period-summary.ts` など）、R1 の接続状態の部品の `/jobs` への移動
- **段階 1（画面）**: 概要、投稿一覧、投稿詳細、期間比較、接続と収集ログ、CSV 2 本。その後、期間比較を design-lab v4 の見本の形に直し、プリセットに前 3 か月を足し、投稿の題名で空行と句読点だけの行を飛ばすようにした
- **段階 2 の 1. テストの不足（2026-10-06。`quality-engineer`、約 4.5 分、45 回の呼び出し、12 万トークン）**: 設計 9.1・9.2 節と突き合わせ、削除済みの投稿、2 アカウントの分離、経過の短い比較相手、下の直しの確認を足した。440 → 456 件、結合テストを含めすべて通る。実装の不具合はなし
- **段階 2 の 2. セキュリティレビュー（2026-10-06。`security-engineer`、約 1.5 分、25 回の呼び出し、8 万トークン）**: 高・中なし、低 3 件をすべて直した（日次の CSV のハンドラー全体を try で包む、ログに出すエラーコードを形で検査する、CSV の数値の列で空の文字列を空欄にする）
- **段階 2 の 3. 性能計測（2026-10-06）**: `scripts/r3-perf-check.sql` を手元の Supabase で実行。合成の投稿 1,000 件（スナップショット 14 件ずつ、日次 2 年分）で、主なクエリ 11 本の実行時間は 0.1〜85 ms（最大は投稿一覧のリーチ率の順、85 ms）。判定の 500 ms 以下を満たす
- **静的検査（2026-10-06）**: `next build`（全ルート `ƒ`）、ESLint、型検査が通る
- **本番への反映（2026-10-06）**: main にマージして push。クラウドの Supabase に `db push` 済み（`20261005000000_r3_analysis_views.sql`、ユーザー）。管理 API のログイン用ロールの作成が 403 になったため、`SUPABASE_DB_PASSWORD` に DB パスワードを入れて直接つないだ
- **数値の照合（設計 9.3 節）は省く（2026-10-06、ユーザーの判断）**: API で取った値と Instagram アプリの値の一致は確かめない。画面と DB の一致は結合テストで確かめているので、本番での照合もしない
- **画面の確認（段階 2 の 5）**: ユーザーが PC とスマートフォンで確認し、終了（2026-10-06）。R3 は完了
- **画面の確認での直し（2026-10-06）**: 投稿一覧の最大幅を外す、表の下の基準値の行を外す、ページ送りを 1 ページでも出す、ER の分母の切り替えを一覧と概要の両方から外す（リーチに固定。要件 F-UI-11 も改めた）、縦棒のヒントを列の全体で出す、読み込み中の骨組み（`loading.tsx`）と押したリンクの点滅の印
- **日次の収集の取りこぼし（2026-10-06）**: JST 05:17 の回が GitHub の側で動かなかった（ランナーが割り当てられず取り消し）ため、日次指標が 10-03 で止まり、10-06 のフォロワー数が記録されなかった。`run_daily=true` で手動起動して補った。再発に備え、前回の `account_daily` の成功から 24 時間を過ぎていれば毎時の回でも `run-daily` を行うようにした（`daily-due` コマンドと `collect.yml`）
- **後工程（優先度は低い）**: 本番の画面の応答が遅い。3 倍ほど速くしたい（2026-10-06、ユーザーの要望）。原因（Vercel と Supabase の地域、クエリ、描画）の計測から始める

## 7. 作業の決まりごと

- ユーザーへの応答は日本語。コミットメッセージも日本語。
- Git: ブランチで作業し、まとまった単位でローカルの main に `--no-ff` でマージして push する。マージ済みブランチは削除する。指示を待たずに行ってよい。
- 公開リポジトリなので、秘密情報、取得データ、アカウントの ID やユーザー名をコミットしない（要件 NF-SEC-06、NF-SEC-07）。
- Next.js 16 は従来と API が違うので、コードを書く前に `node_modules/next/dist/docs/` を読む（`apps/web/AGENTS.md`）。
- AI や有料 OCR を使う前に、`doc/ai-decisions/` に検討メモを書いてユーザーの了承を得る（要件 8.7 章）。


## 8. R4（動画分析：長さとカット）

設計は `doc/design/r4-video-analysis.md`。

- **設計 0.1（2026-10-06）**: 親が起草。R1 のストーリーズの動画解析（`video_analyses`、`video_cuts`、`analyzeVideo`）を使い回し、毎時のグループに `video_analysis` ジョブを足して、リールとフィード動画を新しい順に解析する（既存のリールも同じジョブで数時間のうちに終わる）。`media_url` は解析の直前に取り直す。しきい値は手元のコマンド `video-tune` で数本を目視と比べて決める。画面は投稿詳細のカットのタイムラインと、リール分析（`/reels`、design-lab v3 の見本から文字の要因を除く）
- **設計 0.2（2026-10-06）**: 4 本のレビューを反映（`security-engineer` 約 1.5 分・6 万トークン、`postgres-sql-reviewer` 約 2 分・7 万、`node-worker-developer` 約 2.5 分・8 万、`nextjs-developer` 約 3 分・8 万）。主な直し: 今の解析条件を DB の関数 `current_video_condition()` に持たせ、画面のビューはその条件の行だけを使う。ffmpeg がない回は行を書かない（apt の失敗が続いても全リールが打ち切りにならない）。ジョブの途中では止めず、1 回 5 本と時間の予算 8 分で抑える。`attempt_count` で 5 回で打ち切る。ログに投稿の ID と URL を出さない。ffmpeg の入力を mp4 とファイルに限る。相関は n < 3 と分散 0 で「—」、ブートストラップは再標本の組を全要因で共有して再現させる
- **設計 0.3（2026-10-06）**: 段階 0 の数（リール 18 本、リーチ率のあるリール 0 本、フィード動画 0 本、ジョブの最長 23 秒）を記録。確認事項 Q1〜Q7 はすべて推奨どおり（ユーザー）。リール分析は目的変数を選べるようにし、既定はリーチ率。次は段階 1（ワーカー）と段階 4（画面）
- **段階 1（ワーカー、2026-10-06。`node-worker-developer`、約 22 分、101 回の呼び出し、25 万トークン）**: マイグレーション `20261007000000_r4_video.sql`（手元に適用済み）、`video_analysis` ジョブ、`video-tune`、`stories` の共通化、ffmpeg の入力の制限。ワーカーのテスト 682 件、`web-role.test.ts` 28 件が通る
- **段階 4（画面、2026-10-06。`nextjs-developer`、約 16 分、78 回の呼び出し、22 万トークン）**: 投稿詳細のカットのタイムライン、リール分析（`/reels`）、収集ログの `video_analysis`。`next build`、ESLint、型検査、Web のテスト 493 件が通る。ブラウザでの見た目は未確認
- **手元の計測（2026-10-06）**: リール 18 本を 43.6 秒で解析（失敗 0。手元の DB に結果あり）。`video-tune` で 4 本を見て、しきい値 0.3 と 0.4 の違いをユーザーの目視で確かめるところ（段階 2）
- **画面の確認（2026-10-06、ユーザー）**: 手元の画面で PC とスマートフォン幅を確認し、OK。確認の中で直したもの: 全画面の「リーチ」を「リーチ数」に統一、閲覧数のヒントから views への統一の注記を外す、リール分析の指標の選択に「比べる指標」の見出しと選択肢ごとのヒント、「最新の」を外す、要因との関係と上位と下位を半幅で横に並べる、要因ごとの n を外す、「最後 3 秒の画面変化」を追加（DB の列 `cuts_in_last_3s`、マイグレーションで既存の行を埋める）、「区分の要因と〇〇」を「グループ別〇〇」にしてグループを変更（長さ 10 秒ごと、冒頭と最後 3 秒は 0/1/2/3 回以上、各曜日を追加）、棒グラフの文字の大きさをそろえる、散布図の軸の名前の位置、投稿一覧とリールの一覧を 1 ページ 10 件にしてリールの一覧にページ送り、投稿詳細の「Instagram で開く」をサムネイルの下へ、横スクロールの表で左端の列を止める（リールの一覧、期間比較の 2 表）、期間比較のスマートフォン幅で期間の箱が伸びる不具合
- **しきい値（段階 2、2026-10-06）**: ユーザーの目視で 0.3 に決定（設計 0 章「計測と調整の記録」）
- **本番前のレビュー（段階 5、2026-10-06）**: `security-engineer`（約 1.5 分、8.5 万トークン）は高・中なし、低 3 件を直した（子プロセスの出力に上限、不明な例外は固定文言、`ffmpeg -version` に制限時間）。`quality-engineer`（約 2.5 分、11 万トークン）のテストの不足の指摘を受け、ワーカーに 14 件（`node-worker-developer`、約 5 分。既存の行を埋める処理、ストーリーズは打ち切らない、新しい列、アカウントの分離、時間の予算、打ち切りの warn など）、Web に 9 件（`nextjs-developer`、約 2.5 分。ページ送りを純関数に出す、グループの境目、投稿一覧の 10 件と 11 件）を足した。テストはワーカー 697 件、Web 504 件がすべて通る（手元の DB で）
- **今の状態（2026-10-06 終了時）**: すべて `r4/design` ブランチにコミット済み。main へのマージと push はまだ。クラウドの Supabase には R4 のマイグレーション（`20261007000000_r4_video.sql`）をまだ当てていない。手元の Supabase には適用済みで、リール 18 本の解析結果がある（手元の DB は R4 のマイグレーションを途中で書き足したため、手で流し直した。`attempt_count` の列は先に入っていた）
- **次にやること（この順で）**:
  1. **済み（2026-10-07、ユーザー。`SUPABASE_DB_PASSWORD` を `Read-Host -MaskInput` で入れて実行）** ユーザーが手元の PC で `npx supabase db push`（リポジトリの場所で。当たるのは `20261007000000_r4_video.sql` の 1 本だけのはず。ほかが並んだら止める。DB のパスワードを聞かれたら入力）
  2. **済み（2026-10-07）** 親が `r4/design` を main に `--no-ff` でマージして push（Vercel が画面をデプロイし、次の毎時の収集から `video_analysis` が動く）。**順番を逆にしない**: 先にマージすると、新しいワーカーが `attempt_count` などの列を書けず、ストーリーズを含む毎時の収集が失敗する
  3. **ワーカーの側は確認済み（2026-10-07 23:39〜23:57 JST）**: `collect` を手で 4 回起動し（1 回は ffmpeg の apt-get が Ubuntu のミラーからのダウンロードの遅さ（数十〜100 KB/秒）で 11 分たっても終わらなかったので取り消して起動し直した。ステップに `timeout-minutes: 5` を付けた）、`video_analysis` が 5・5・5・3 本を解析してリール 18 本すべてが成功（`no_video_url`・`failed` は 0）。本番の画面の確認はユーザーが済ませた（2026-10-08）。元の手順: 1〜2 回の毎時の収集の後、本番の `job_runs` で `video_analysis` が成功し、リール 18 本が 1 回 5 本ずつ（約 4 時間で）解析されることを確かめる。本番の `/reels` と投稿詳細のタイムラインを開いて確かめる（ユーザー）
  4. **済み（2026-10-08）** 完了条件（要件 10 章「既存のリールすべてに長さとカットの特徴量が入っている。取得できないものは理由が記録されている」）を確かめたら、R4 を完了にする
- **db push とマージは続けて行う**: db push だけ先にしても本番は壊れない（今のワーカーは新しい列を使わない）が、その間にストーリーズの動画を解析すると、その行の `cuts_in_last_3s` は空のまま残る（既存の行を埋めるのはマイグレーションの 1 回だけ）
- **後回しにしたもの**: 設計書と要件定義の中の「リーチ」→「リーチ数」、「区分」→「グループ」の言い換えはしていない（画面だけ変えた）。投稿の CSV の列の名前が「リーチ数」に変わったかは確かめていない

## 9. R5（投稿分類、ストーリーズ、オーディエンス、投稿時刻の分析）

要件定義 4.6 章（F-UI-30〜32、F-UI-40〜42、F-COL-30）。完了条件は「タグを付けた投稿の比較、ストーリーズの離脱ファネル、属性の推移が表示される」。

- **着手（2026-10-08）**: R4.1 と R5 のうち R5 を選んだ（ユーザー）。理由は、ストーリーズは R1 から収集済みで 24 時間で消えるデータを早く活かせること、ストーリーズと投稿時刻の画面は R2.5 で見た目を確定済みであること、R4.1 は方式の比較から始まりリールが 18 本と少ないこと。ブランチは `r5/design`
- **進め方**: 設計書 `doc/design/r5-analysis.md` → `postgres-sql-reviewer`、`security-engineer`、`quality-engineer` が並列にレビュー → 差し戻しを反映 → 確認事項（Q）をユーザーに決めてもらう → DB・ワーカー・画面を並列に実装
- **事実票（2026-10-08、親が Meta 公式の Instagram User Insights の API リファレンス v25.0 で確認）**: `follower_demographics`／`engaged_audience_demographics` は `period=lifetime`、`metric_type=total_value`、`breakdown` は age／city／country／gender のいずれか、`timeframe` は `this_week`／`this_month`（`last_14_days`・`last_30_days`・`last_90_days`・`prev_month` は v20.0 以降不可）。フォロワー（反応）が 100 未満だと返らない。上位 45 件だけ。最大 48 時間遅れる
- **設計書 0.1 の起草（2026-10-08）**: `nextjs-developer` に依頼中（上限 30 分。読むファイルを 8 項目に限定し、上の事実票を渡した）
- **設計書 0.1（2026-10-08。`nextjs-developer`、約 6 分、32 回の呼び出し、17 万トークン）**: 収集（属性の週次ジョブ `audience_demographics`）、DB（タグの 3 表と複合外部キー、属性の 2 表、ハッシュタグの関数とビュー、ストーリーズのビュー）、画面（`/tags`、`/tags/edit`、`/stories`、`/audience`、`/timing`）、確認事項 Q1〜Q16
- **レビュー 3 本（2026-10-08、並列）**: `postgres-sql-reviewer`（約 2.3 分、8 回、9.5 万トークン。高なし）、`security-engineer`（約 1.9 分、9 回、7.2 万トークン。高 1 件は、`checkAccess` が経路を引数で受ける実装（`apps/web/src/lib/auth.ts`）を親が確かめ、Server Action では固定の経路を渡すと明記する中として扱った）、`quality-engineer`（約 2.2 分、10 回、6.9 万トークン。受け入れの具体化など高 4 件）
- **設計書 0.2（2026-10-08。`nextjs-developer`、約 4.9 分、6 回、21 万トークン）**: 指摘 S1〜S13、D1〜D15、T1〜T18 を反映。update は列ごとの grant（`updated_at` はトリガーが入れるので grant しない）、ポリシーは 4 本、`media_tags → tag_values` は `no action`、ハッシュタグは NFKC にしてから抜き出す、ファネルと属性の推移の受け入れの手順と期日。親がナビの並びを design-lab v3 に合わせ（タグ分析、ストーリーズ、投稿時刻、オーディエンス）、既存の関数とテストファイルがあることを確かめた。次は確認事項 Q1〜Q17 をユーザーに決めてもらう
- **確認事項（2026-10-08）**: Q1〜Q17 はすべて推奨どおり（ユーザー）。設計書 0.3。段階 0 で、R1 の検証で保存した属性の応答（`.local/api-verification/`）から形を確かめた（年齢 6 区分、性別 F/M/U、国は 2 文字、都市は 45 区分、反応が 100 未満のときは空でエラーではない）。本番の DB の数（ストーリーズのまとまりなど）は、手元から本番の DB に接続しないので段階 4 で数える
- **段階 1・2a・2b（2026-10-08、並列）**: 段階 1（`node-worker-developer`、約 8 分、37 回、13 万トークン）はマイグレーション `20261009000000_r5_analysis.sql` と DB のテスト（`r5-views.test.ts` など）。段階 2a（`node-worker-developer`、約 6 分、47 回、15 万トークン）は `audience_demographics` ジョブ（daily の `account_daily` の次）。段階 2b（`nextjs-developer`、約 8 分、52 回、15 万トークン）はナビ、`ChoiceChips`、`Strip`、`Heatmap`、`HBars`、`HStack`、`lib/params.ts` の検査、`NO_STORE_PAGES`
- **段階 3（2026-10-08、`nextjs-developer` 5 人を並列）**: 投稿時刻（約 5 分、44 回、12 万トークン。足した注記を R2.5 の決定に合わせて消させた）、オーディエンス（約 5 分、60 回、12 万トークン。性別を女性・男性・不明の表示にさせた。年齢の 5・6 本目の線は色が 4 つしかないので破線）、ストーリーズ（約 6 分、30 回、14 万トークン。期間の前の行はまとまりの 1 件目までさかのぼる）、タグ分析（約 6 分、38 回、13 万トークン。帯グラフは表の下に縦に並べた）、タグの編集（約 12 分、71 回、22 万トークン。Server Action 9 本、`useActionState`）
- **検査（2026-10-08、親）**: Web の型検査・ESLint・単体テスト 580 件、ワーカーの型検査・単体テスト 560 件、`next build` が通った。**DB のテスト（Web 205 件、ワーカー 168 件のスキップ分）は、Docker Desktop が止まっていて手元の DB に R5 のマイグレーションを当てていないので未実行**。次は Docker の起動 → `npx supabase migration up --local`（`db reset` はしない）→ DB のテスト → ブラウザでの確認
- **タグの編集のセキュリティレビュー（2026-10-08、`security-engineer`、約 1.5 分、15 回、7.5 万トークン）**: 高なし。S1〜S12 は実装済み。中 1 件（DB のポリシーがアカウントを隔てないので、別アカウントの id で 0 行になる結合テストで守る）は 9 本の Action すべてにテストがあることを親が確かめた。低のうち先頭が 0 の id は親が直した。ほかの低（同時送信で上限を超えうる、見えない文字の一部が通る、デッドロック）は利用者が 1 人なので受け入れた
- **DB のテスト（2026-10-08）**: ユーザーが Docker Desktop を起動。`npx supabase migration up --local` で R5 のマイグレーションだけを当てた（`db reset` なし、常駐のワーカーは止めたまま）。Web 785 件（DB 205 件を含む）、ワーカー 728 件（DB 168 件を含む）がすべて通過。落ちた 1 件は投稿時刻の結合テストの期待値の誤り（対象 8 件を 9 件としていた）で、テストを直した。次は手元の画面の確認（ユーザー）
- **手元の画面の確認（2026-10-08、ユーザー）で直したもの**: タグの編集の保存が 2 回押さないと「保存しました」にならない（行の `key` にタグを含めていて行が作り直されていた）→ 行の `key` は投稿の id だけにし、選択欄だけを保存済みの値で作り直す（React のフォームのリセットで選択が「なし」に戻るため）。`/tags` と `/timing` の選択に見出し（タグの軸、投稿の種類、比べる指標）を付け、`/timing` の選択を見出しの横から下に移して段を分けた。PC の表で、マウスを乗せた行全体を薄く塗る。確認の手順の注意: 手元は `APP_URL=http://localhost:3000` なので `127.0.0.1` で開くと同一オリジンの検査で書き込みが拒まれる。手元の開発用の利用者のパスワードが記録と違っていたので、手元の Auth で記録どおりに設定し直した
- **本番への反映（2026-10-08 22:30 ごろ）**: ユーザーが `db push`（`20261009000000_r5_analysis.sql` の 1 本）。続けて親が `r5/design` を main に `--no-ff` でマージして push。次は本番の画面の確認、daily（05:17 JST）で `audience_demographics` が動くことの確認、段階 0 の本番の数（ストーリーズのまとまり）、属性の推移は 2 回目の月曜より後に確認（T2）
- **収集の ffmpeg の入れ方を変えた（2026-10-08 22:45 ごろ、main に反映）**: R5 の反映後に `/jobs` で「video_analysis: ffmpeg がない」が出た。原因は R5 ではなく、Ubuntu のミラーからの apt-get が遅く 5 分の上限に当たったこと（10-07 03:17・05:17、10-08 22:17 JST。上限を付けてから約 30 回中 3 回）。`collect.yml` を、BtbN/FFmpeg-Builds の静的ビルド（月末の版 `autobuild-2026-08-31-13-27`、ffmpeg n8.1.2 の LGPL、SHA-256 を固定。月末の版は 2024-11 から残っている）を落として Actions のキャッシュ（`actions/cache/restore`・`save` v6.1.0）に置く形に変えた（ユーザー了承）。手元の Docker の Ubuntu 24.04 で ffmpeg・ffprobe とシーン検出が動くことを確認
- **収集の確認（2026-10-09、親）**: 10-08 23:17 JST の `collect` で ffmpeg の静的ビルドを落としてキャッシュに保存し、10-09 00:17 JST の回はキャッシュから取り出した（ダウンロードなし）。`video_analysis` はどちらも成功（未解析のリールがなく 0 本）。10-09 05:17 JST の daily で `audience_demographics` が成功（8 件、空 0、失敗 0）。10-08 14:17 JST 以降の毎時の 12 回はすべて成功
- **オーディエンスの見直し（2026-10-09、ユーザーが本番で確認）**: 性別と年齢の内訳を横棒から円グラフ（`components/charts/Pie.tsx`）に替えた。直径 200px と周りの余白 16px で表示の幅を止め（`.chart svg` の幅 100% で半幅のカードいっぱいに広がっていた）、割合が 5% 以上の扇に名前と割合を 2 行で書く（黒の文字に白の縁取り。扇の色ごとに文字の色を変えると見づらいため）。推移のカードは、性別と年齢を 100% 積み上げ面にしたあと不要となり、国もほぼ日本だけなのでカードごと外した。推移の計算とテストも消した（git の履歴にある）。属性の週次の収集は続ける。これに合わせて R5 の完了条件を「属性の推移」から「属性の内訳」に改めた（要件定義 F-UI-41 と 10 章、設計書 0.4）
- **本番の画面の確認（2026-10-09、ユーザー）**: ナビ、`/tags/edit`、`/tags`、`/stories`、`/timing`、`/audience` を確認し、OK
- **離脱ファネル（T1、2026-10-09）**: 本番の `/stories` は「期間中に、続けて 2 件以上出したストーリーズはありません。」の表示で、本番にまとまりはない。設計書 7.4 節の決まりどおり、手元の DB のテスト（`test/db/stories.test.ts`。4 件のまとまりでファネルが 1 件目の 100% から描かれる。2026-10-08 に通過）をもって完了とした
- **R5 の完了（2026-10-09）**: 完了条件（タグを付けた投稿の比較、ストーリーズの離脱ファネル、属性の内訳が表示される）を満たした
- **次回やること**: 2026-10-11 に 1 は 5 章に記録し、2 は R4.1 を選んだ。以降は 10 章の末尾

## 10. R4.1（動画分析：画面の文字）

要件定義 4.5.1 章（F-VID-20〜32）、5.3 章「画面の文字（R4.1）」、8.7 章（AI と OCR の利用方針）。完了条件（要件定義 10 章）は「文字取得の方式の比較結果と検討メモが `doc/` にあり、ユーザーが了承した。既存のリールすべてに文字の区間が入っている。数本について、読み取った文字と表示時刻を目視と比べた。月の費用が上限内に収まっている」。

- **着手（2026-10-11）**: R4.1 と R6 のうち R4.1 を選んだ（ユーザー。ブランチ `r4.1/ocr-compare`）。要件 8.7.2 の決まりで、実装の前に検討メモを書いてユーザーの了承を得る
- **検討メモ 0.1（2026-10-11、親が起草）**: `doc/ai-decisions/r4-1-video-text-ocr.md`。候補は Tesseract 5.5、PaddleOCR 3.7.0（PP-OCRv5）、Google Cloud Vision、Claude（Haiku 5.5・Sonnet 5.5）。事実票（確認日 2026-10-11）の要点: PaddleOCR の公式指標は日本語の認識 0.76（mobile）、装飾文字 0.54〜0.64、CPU で 1 枚 1.75〜4.3 秒。Google Cloud Vision は月 1,000 ユニット無料、以後 1,000 ユニットごとに $1.50、画像を学習に使わない。Claude は 1080×1920 で 1 枚 2,691 トークン（Haiku 5.5 で約 $0.0003）、画像を学習に使わない。枚数の見込みは 1 本 20〜40 枚で、既存 18 本の一括 720 枚でも Google は無料枠内、Claude Haiku で約 $0.25。上限の案は月 30 本・$5。手元の PC には Tesseract 5.5.0（`jpn`、`jpn_vert`）と Python 3.13 がある。比較はリール 10 本を手元で行い、CER と区間の検出率で判断する（7 章の目安: オープンソースで CER 10% 以下なら採用）
- **方式の決定（2026-10-11、ユーザー）**: 確認事項 Q1〜Q5 のやり取りの中で、「複数の方式を比較する時間はもったいない。Google Cloud Vision に決め打ち」と決めた。検討メモを版 0.2 にし（7 章に決定と根拠、5.3 の上限を無料枠 1,000 ユニット／月に、6 章の比較は行わない）、要件定義を版 0.5 にした（F-VID-20、8.7.3 章、10 章の完了条件）。鍵は Google Cloud のサービスアカウントの JSON を `.local/gcp-vision-key.json` に置く（ユーザーが準備中）。Anthropic の API キーは不要
- **設計書 0.1（2026-10-11。`node-worker-developer`、18 分、35 回の呼び出し、19 万トークン。読むファイルを 11 本・約 14 万文字に限り、Vision API の上限・応答の形・動作確認の結果・ユーザーの決定を事実票で渡した）**: `doc/design/r4-1-video-text.md`（727 行）。ジョブ `video_text`（hourly の `video_analysis` の次。1 回 5 本・8 分・200 ユニット、月 1,000 ユニット・30 本、月の境目は UTC）、フレームは 1,000 ms 間隔 ＋ カット直後、JPEG 幅 1080・品質 4・1 要求 8 枚、表は `video_text_analyses`・`video_text_frames`（語ごとの矩形と確信度を jsonb）・`video_text_segments`・`ocr_usage`、条件の関数 `current_video_text_condition()`（`segmenter_version` を上げたときは API を呼ばず再計算）、区間化は NFKC と編集距離、テロップらしさは高さと位置で推定、画面はタイムラインの 3 段の帯・`/reels` の要因 3 つと文字検索・`/jobs` の利用状況。確認事項 Q1〜Q14。起草者が踏み込んだ点（条件 5 列と再計算、部分失敗の使い回し、`/reels` の y にスキップ率、月の上限の通知は daily）はレビューで見る
- **レビュー 4 本（2026-10-11、並列。各 10 分程度、設計書と関係ファイルだけ、Web なし）**: `postgres-sql-reviewer`（DB）、`security-engineer`（鍵、公開ログ、送信、検索の入力）、`quality-engineer`（端の場合、テスト、段階、確認事項）、`nextjs-developer`（画面）。結果: 画面（6 分、19 回、11 万トークン。高 3: `y` にスキップ率を足すと「視聴と反応」で同じ指標どうしの図、空白だけの検索語が全件一致、`FACTORS` の数の矛盾。中 9、低 14）、DB（7 分、6 回、11 万トークン。高なし、中 6: ビューの結合を一意キーの 4 列に、upsert の列の明示、`ocr_usage.analysis_id`、新しい表の revoke、ビューの `security_invoker` の再指定、フレームの check。低 11）、セキュリティ（8 分、7 回、12 万トークン。高なし、中 6: 鍵の解析と署名の失敗の文面、マスクの二重化、鍵のライフサイクル、途中落ちでの取り掛かりの記録、月の上限の範囲を 1,000 に、検索のエスケープの順序。低 12）、品質（8 分、7 回、12 万トークン。高 4: 最後のフレーム `at_ms = duration_ms`、カットの条件を変えると再区間化で API を呼ぶ、再送を含めた最悪の時間 21 分、`duration_ms = 0`。中 13、低 9）。親の判断を添えて起草者に差し戻した
- **設計書 0.2（2026-10-11。`node-worker-developer`、約 12 分、7 回、差分で約 9 万トークン・累計 27 万）**: 87 件の指摘をすべて反映（828 行）。要点: ビューは一意キーの 4 列で結合し特徴量だけ版が違えば null、途中落ちに備えて 1 本の最初に取り掛かりを記録し要求ごとにフレームと `ocr_usage` を保存、再区間化は保存済みフレームを計画にして API を呼ばない、再送は 429 と 5xx だけ、1 回の上限を超える本は飛ばす、失敗した要求のユニットは状態で分ける、月の上限の範囲は 1,000 まで、鍵は固定文言・`add-mask`・`ctx.mask` の二重化・ライフサイクルの表・形が不正でもほかのジョブを止めない、検索は TS 側で正規化とエスケープ、段階 4〜5 に手順と合格条件の表。次は確認事項 Q1〜Q14（ユーザー）
- **確認事項の回答（2026-10-11、ユーザー）**: Q1〜Q14 はすべて推奨どおり（Q1 は 1,000 ms、Q4 は UTC と 2026-10 の変数 700、Q8 はスキップ率を足す、Q9 は一覧のカードの上、Q10 は Secret に JSON 1 つ、Q13 は足りない分だけ送り直す）。設計書 0.3
- **段階 0（2026-10-11、親。`scripts/ocr-stage0.mjs`、8 ユニット。手動の合計 101）**: JWT の scope `cloud-vision` で通る。元の動画は 720×1280（1080×1920 ではなかった）。取り出し 1 枚 77〜133 ms、JPEG 62〜145 KB、8 枚の要求 0.92 MB で往復 529 ms、応答 172 KB。テロップの文字の高さは画面の 3.0〜3.5%、確信度 0.98〜1.00。店の看板は 2.4〜2.7% で確信度 0.26〜0.58 なので、テロップらしさの条件に確信度 0.9 以上を足した（設計 4.3 節）。1 本の処理は約 6〜10 秒の見込み。結果は設計書 11 章。**残り（ユーザー）**: 本番のリールとフィード動画の本数と `video_analysis` が `success` の本数（SQL）、Google Cloud で Vision API のクォータ（1 分あたりの要求数）を下げられるかの確認（任意。月の上限はコードで守る）
- **段階 1（DB と設定。2026-10-11、`node-worker-developer`、17 分、65 回）**: `supabase/migrations/20261012000000_r4_1_video_text.sql`（表 4 つ、`current_video_text_condition()`、ビュー 2 つは R4 の定義を全文写して末尾に列を追加、`ocr_monthly_usage`、権限、ロールバックのコメント）、`config.ts`（`videoText*` の 5 項目と `visionKey`。`loadVisionKey` は形が不正でも起動を止めない）、`config.test.ts`、`test/db/video-text.test.ts` 20 件、`web-role.test.ts` の棚卸し、`scripts/r4-1-seed-local.sql`（直近 3 本を動的に選ぶ種データ。ID は書かない）。`WorkerConfig` に必須項目を足したため既存のテスト 12 本に既定値を差し込んだ。手元に適用済み（ビューの `security_invoker` を確認）。ワーカー DB テスト 197 件、Web DB テスト 229 件、ワーカー単体 576 件が通過。申し送り: `CheckAlertsConfig` と `check-env` は段階 2、`video-text.test.ts` の定数と SQL の直書きは段階 2 で参照に替える、手元 DB の直近 3 本には種データの `success` 行が入っている
- **段階 3（画面。2026-10-11、`nextjs-developer`、段階 1 と並列、19 分、66 回、23 万トークン）**: 投稿詳細（2 段目の数字、タイムラインの上・中・下の帯、区間の表）、`/reels`（要因 3 つ、冒頭 3 秒の文字の別扱い、目的変数にスキップ率、区分の配置、一覧の 3 列、「文字で探す」）、`/jobs` の「AI・OCR の利用状況」、`lib/text-search.ts`（NFKC → 空白除去 → 長さ → エスケープ）、`lib/ocr-usage.ts`（定数と純粋関数）。単体 623 件、型検査、ESLint、`next build` が通過。親が手元の DB で Web の DB テスト 233 件（新規 4 件を含む）の通過を確認。判断: スキップ率を選んだときの「視聴と反応」は 3 枚で `col-3` のまま 1 つ空く（段階 5 の目視で見る）、`doc/design-system.md` は読まずに既存の部品とクラスに合わせた
- **段階 2（ワーカー。2026-10-11、`node-worker-developer`、35 分、164 回、38 万トークン。上限 60 分の中だが、起草者の自己申告は 75 分。トークンは R4 の段階 1（25 万）より多く、末尾のフレームの調査と修正を含む）**: `lib/video-text.ts`（定数と純粋関数）、`lib/vision-client.ts`（JWT、分割、応答の解釈、再送の規則）、`db/video-text.ts`、`jobs/video-text.ts`（hourly の `video_analysis` の次）、`extractFrameArgs` と `spawn` の `env`（Windows は `SystemRoot` も）、`ctx.addSecret`、`ocr_monthly_cap` の通知、`check-env`、`collect.yml` の Secret と `add-mask`、固定データ 4 本、テスト（純粋関数 31 件とゴールデン、クライアント、本物の DB と偽の fetch のジョブ）。親が手元で全テスト 825 件の通過を確認。手元で 3 本を処理（73 ユニット。検討メモ 6.2 節）。**設計からの変更**: (1) 末尾のフレーム。リールは映像がコンテナの長さより短く、`duration_ms` 未満でも最後の間隔の時刻で ffmpeg が失敗するので、`at_ms + 1000 >= duration_ms` の時刻の失敗は計画から外して続ける（設計 3.4 節に追記）。(2) 共有ファイル: `ItemFailureClass` に `auth`／`rate`、`JobName` に `video_text`、`CheckAlertsConfig` に月の上限 2 つ（親が承認）。(3) `captionMinFrames` を 2 → 1（1 秒ごとに変わるテロップが 1 フレームにしか写らないため。親の判断。追加作業 9 分・9 回で反映し、手元の 3 本を API を呼ばずに再計算: テロップらしい区間 3 → 26〜32 本、テロップの表示割合 0.07〜0.34 → 0.95〜1.0。電話番号や駅の看板の一部もテロップ扱いになるので段階 5 の目視の材料にする）。親が `collect.yml` の hourly と check-alerts のステップに変数 `WORKER_VIDEO_TEXT_MAX_PER_RUN`、`WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT` の受け渡しを足し、GitHub の変数（0 と 700）を登録した。Secret `GCP_VISION_KEY_JSON` は `gh` のトークンに Environment の権限がなく 403 → ユーザーが登録。
- **段階 4（本番の反映。2026-10-11 17:3x〜17:45 JST）**: ユーザーが Secret を登録し `db push`（`20261012000000_r4_1_video_text.sql`）→ 親が段階 1〜3 を main に `--no-ff` でマージして push → `collect` を手動で起動（変数 0）: `video_text candidates=19 processed=0`、マスクのステップも動作 → 変数を 5 にして手動で 1 回: **5 本 `success`、要求 19、132 ユニット、72 秒（1 本 約 14 秒。GitHub のランナーは手元より遅い）、失敗 0、`check-alerts` は `alerts=0`** → 変数を 0 に戻した。本番の候補は 19 本（リールとフィード動画でカットの解析が `success` のもの。段階 0 の「本番の数」はこれで代える）。ユーザーが本番の画面を確認して OK（投稿詳細、`/reels`、`/jobs` の利用状況 132 ユニット・残り 868）→ 変数を 5 に戻し、17 分の前後を避けて手動で 3 回起動（17:56〜18:02 JST）: 5 本・151 ユニット（83 秒）、5 本・176 ユニット（108 秒）、4 本・142 ユニット（77 秒）。**本番の 19 本がすべて `success`、失敗 0。本番の 2026-10 の利用は 601 ユニット（上限 700、残り 99 ≈ 新しいリール 3 本分）。** Google のプロジェクト全体では手動 174 を足して 775（無料枠 1,000 以内）。1 本あたり 25〜35 枚で、見込み（20〜40 枚）の中。変数は 5 のまま（新しいリールは次の毎時の回で処理される）。10 月中に新しいリールが 3 本を超えると `ocr_monthly_cap` の通知（daily に 1 通）が出るが、仕様どおり。11 月 1 日（UTC）以降に変数を 1000 に戻す
- **段階 5（2026-10-11）**: `security-engineer`（7 章の観点で実装をレビュー）と `quality-engineer`（8 章のテストの不足を補う）を並列に依頼。セキュリティ（7.5 分、40 回、14 万トークン）: 高なし。中 1（Secret の JSON が壊れていると `add-mask` のステップで `collect` 全体が止まる）→ `continue-on-error` と jq の失敗を握る形に直した。低 2 を直した（8 文字未満の行はマスクに登録しない。`.env.example` に `video_text` の変数と鍵のパスの注記）。任意 1 を直した（署名済み JWT もマスクの対象に）。確認のみ 1（`mask vision key parts` が実行されること）は本番の実行ログで実行済みを確認。設計どおりの点（鍵とトークンの経路、公開ログ、宛先の固定、再送と上限、DB の保存内容、画面のエスケープ、AI-05〜07）は問題なし。品質（14 分、45 回、19 万トークン）: テスト 22 件を追加（予算超過後の再送なし、取り出しの制限時間と出力なし、打ち切りの warn、`media_url` の取り直し 4 場合、`ocr_usage` の書き込み失敗、`check-env`、結合濁点と絵文字、代表の文字、位置の境界、トークンの失敗の分類など）。不具合は低 1（ログの `requests`／`units` が記録できなかった要求も数える）→ 記録の後に数える形に直した。全テスト: ワーカー 847 件、Web 単体 623 件・DB 233 件が通過。残り: ユーザーの目視（9 章の合格条件の表。3 本を Instagram のアプリと比べる）、`.local/ocr-check` の削除、手元の鍵の扱い（消すか別の鍵にするか）書いていないテスト（予算超過後の再送なし、取り出しの制限時間、打ち切りの warn の回数、`media_url` 取り直しの各場合、`ocr_usage` の書き込み失敗、`check-env`）は段階 5 の `quality-engineer` へ。compose の鍵のマウントは未着手（手元の常駐ワーカーは止めているので不要）
- **段階 5 の完了と R4.1 の完了（2026-10-12）**: ユーザーが直近のリール 3 本を Instagram のアプリで再生し、設計書 9 章の合格条件 6 項目（文字、時刻、位置、テロップらしさ、雑音、費用）を目視で確認して問題なし。しきい値の調整は不要（`segmenter_version` は変えない）。手元の鍵 `.local/gcp-vision-key.json` はユーザーが削除（手元で鍵を読むのは使い捨てスクリプト 2 本だけで、`.env` は参照していない。Google Cloud 側の鍵は GitHub の Secret が使うので残す。再び手元で要るときは Google Cloud で新しい鍵を作る）。`.local/ocr-check` は削除済み。要件定義 10 章の完了条件を照合: 検討メモとユーザーの決定（済み）、既存のリールすべてに区間（本番 19 本 `success`）、数本の目視（3 本）、月の処理が無料枠内（本番 601、プロジェクト全体 775 ≤ 1,000）。設計書を 0.4 にし、検討メモ 6.2 節に目視の結果を書いた。compose の鍵のマウントは未実装のまま（手元の常駐ワーカーは止めているので不要。必要になったら設計 3.8 節のとおり足す）
- **次回やること**:
  1. **済み（2026-10-11）** R2 の残りを記録し、R2 を完了にした。接続の制限時間のマイグレーションは本番に反映済み
  2. **済み（2026-10-11）** 方式を Google Cloud Vision に決めた
  2.5 **動作確認（ユーザーの希望。2026-10-11）**: 比較ではなく、Google Cloud Vision が自分のリールの文字をそれなりに読めることを確かめる。使い捨てのスクリプト `scripts/ocr-check.mjs`（直近 N 本のリールを手元の DB と Graph API から取り、1 秒ごとのフレームを `TEXT_DETECTION` に送り、時刻と文字を `.local/ocr-check/<id>/result.md` に書く。上限 100 ユニット）。**実施済み（2026-10-11）**: ユーザーが鍵を `.local/gcp-vision-key.json` に置き、直近 3 本・72 枚を `TEXT_DETECTION` で、1 本・21 枚を `DOCUMENT_TEXT_DETECTION` で読んだ（合計 93 ユニット）。テロップは 3 本ともほぼ全フレームで正しく読めた。背景の看板やメニューの文字も混ざるので位置と大きさで分ける規則が要る。確信度は `DOCUMENT_TEXT_DETECTION` でだけ返る（テロップは 0.96〜1.00）ので設計はこちらを使う。詳細は検討メモ 6.2 節。結果は `.local/ocr-check/`（確認後に消す）。**ユーザー確認済み（2026-10-11）**: 精度が高い。背景の文字を拾うのは人が見ても同じで、背景を含めた文字の情報量をリールの評価に入れてよい → テロップと背景の区別は必須にしない（要件 4.5.1 章の注記を改めた）
  3. **済み（2026-10-11）** 設計書 0.1 → レビュー 4 本 → 0.2 → 確認事項の回答（0.3）→ 段階 0 → 段階 1〜3（並列）→ 段階 4（本番の反映。19 本）→ 段階 5 のレビュー 2 本の反映。すべて main に反映済み
  4. **済み（2026-10-12）** 段階 5 の残り（目視は合格条件 6 項目とも問題なし、手元の鍵を削除、完了条件を照合して R4.1 を完了にした）
  5. 11 月 1 日（UTC）以降に GitHub の変数 `WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT` を 1000 に戻す。10 月中に新しいリールが 3 本を超えると `ocr_monthly_cap` の通知（daily に 1 通）が出るが仕様どおり
  6. **済み（2026-10-12）** R6 に着手した（11 章）

## 11. R6（月次レポート、伸びた投稿の検出、低下の通知）

要件定義 4.7 章（F-RPT-01、02、10、11）、9.1 章（月次レポートの 9 節の型）、8.7 章 AI-01（伸びた投稿の検出は統計で行う）。完了条件（要件定義 10 章）は「前月分の月次レポートを画面に表示できる。伸びた投稿の検出が動く」。

- **着手（2026-10-12）**: R4.1 の完了に続けて着手（ユーザー「次をお願いします」）。ブランチは `r6/report`
- **進め方**: 設計書 `doc/design/r6-report.md`（`nextjs-developer` が起草）→ `postgres-sql-reviewer`、`security-engineer`、`quality-engineer` が並列にレビュー → 差し戻しを反映 → 確認事項（Q）をユーザーに決めてもらう → DB・ワーカー・画面を並列に実装 → 本番に反映
- **事実票（2026-10-12、親がリポジトリで確認）**: (1) 投稿単位の指標にフォロワー／非フォロワーの内訳はない（R0 検証 2.4 節、要件 7.1 章「非フォロワーリーチ比率はアカウント単位」）ので、F-RPT-10 の投稿単位の判定はシェア率などの投稿単位の率で行い、非フォロワーリーチ比率は日次指標（`account_daily_wide` の reach_follower／reach_non_follower。日付は太平洋時間）で見る。(2) フォロワー数は `profile_daily`（日本時間の日付）。(3) 投稿一覧は `media_list_metrics`（kind、最新の値、率、reach_7d、followers_at_post、reach_rate）、経過時間の区分は `media_horizon_metrics`。(4) 目標値の表と設定画面はない（要件 9 章の「設定」は未着手）。(5) 通知は `check-alerts`（daily の失敗 = GitHub の失敗メール 1 日 1 通）だけで、ほかの経路はない。(6) design-lab v3 に月次レポートの見本はない。(7) 期間の部品 `lib/period.ts` に `monthOf`、`previousMonth`、`sameMonthLastYear` があり、概要の集計は `lib/queries/period-summary.ts`
- **設計書 0.1（2026-10-12。`nextjs-developer`、約 8 分、24 回の呼び出し、13 万トークン。上限 30 分の中。読むファイルを 10 本・約 14 万文字に限定し、上の事実票と親の方向づけを渡した）**: `doc/design/r6-report.md`（504 行）。判定はビュー `media_outlier_flags`（同じ種類の直前 20 投稿のシェア率の四分位。fence 1.5 × IQR、8 件未満は判定しない、特殊な投稿は比較対象から外す）、通知は `non_follower_reach_drop`（直近 7 日 vs 前 28 日で 10 pt 以上の低下）と `follower_drop`（前日比 10 人以上かつ 1% 以上）、レポートは `/report`（既定は前月、9 節を既存の部品で、2 節は `OverviewKpis` を流用、目標比は出さない）、記入欄は表 `report_notes` と Server Action、ナビは「期間比較」の次、確認事項 Q1〜Q16。起草者が踏み込んだ点（指標をシェア率 1 つに固定、`follower_drop` を「かつ」、通知にフォロワーの人数を持たせない、ワーカーの読み出しは新規 `db/alert-signals.ts`）はレビューで見る。
- **起草者の「未確認」を親が確かめた（2026-10-12）**: ワーカーは `postgres.<ref>`（表の所有者）で接続するので grant は不要。`collect.yml` は `run-daily` → `run-hourly` → `check-alerts` の順（Q12 は解消）。`lib/queries/tags.ts` の `getTagAnalysis` は過去 365 日固定で暦月を受けない。`TypeTag` に色の引数はなく `SpecialTags` がある。概要の日次推移は内訳を描かない。`metric-definitions.test.ts` はない。R5 の文字の check は `[[:cntrl:]]`（設計の `[[:print:]]` と違う）
- **レビュー 4 本（2026-10-12、並列。各 10 分程度、設計書と関係ファイルだけ、Web なし）**: `postgres-sql-reviewer`（ビューの正しさと性能、表、権限）、`security-engineer`（Server Action、権限、公開ログ）、`quality-engineer`（統計、通知の判定、月の扱い、テスト、段階、Q の不足）、`nextjs-developer`（6 章の画面。Next.js 16 の同梱資料 2 本まで）。結果: DB（約 7 分、12 回、11 万トークン。**高 1**: 特殊な投稿のフラグ `is_collab` などは本番で全投稿 null なので `not is_boosted` が偽になり比較対象が常に空で印が 1 件も付かない → `is not true` に。中 6: `share_flag` に `none`、`media_list_metrics` を基にすると重いので `media` ＋ 最新スナップショットの CTE を `materialized` で、文字の check は R5 と同じ `[[:cntrl:]]`、ワーカーの読み出しの SQL、テストの不足。低 8）、セキュリティ（約 6 分、10 回、10 万トークン。高なし。中 4: 通知のログに率や pt を出さない（公開ログに非公開のインサイトが残る）、本文の検査で ZWJ の絵文字が拒まれる、段階 0 で数える本番の値を文書に書かない、フォームの値の検査を R5 の 2 段にそろえる。低 9）、品質（約 7 分、11 回、12 万トークン。**高 1**: シェア率が 0 に張り付く種類では Q3 = 0・IQR = 0 で、シェア 1 件でも「伸びた」になる。中 12: 指標をシェア率に固定した決定に Q がない、同時刻の投稿の条件の矛盾、浮動小数の境目、連日メールは 7 日でなく約 14 日、無投稿の週で鳴る、既定の月が null のとき、今月はフォロワー純増が常に「—」で概要のタイルのフォロワー数は全体の最新、上位・下位 3 件の分け方、担当の割れ、fixture の不足。低 11）、画面（約 8 分、15 回、12 万トークン。**高 2**: 日付の注記が「米国太平洋時間」の語を出さない決定（2026-10-05）に反する → 既存の `DAY_BOUNDARY_NOTE` をそのまま、1 つのフォームで 7 枚のカードを挟む構成 → `form` 属性で関連付ける。中 10: 失敗時に本文が消える、`useActionState` ＋ `revalidatePath` で確定、汎用の検査を `lib/form-input.ts` に出す、ページは proxy が守る、`OverviewKpis` は直接 import、`LineChart` は 2 系列を描ける、5 節の列を固定、印は `SpecialTags` に足して色は付けない、`lib/report-month.ts` と `lib/report.ts` に分ける、`next.config.ts`。低 11）。親が追加で確かめた点: ページは `checkAccess` を呼ばず proxy の matcher が全経路を守る、`getDailySeries` は内訳 4 列を返す、`HBars` は行ごとに値と割合、`MetricHint` のボタンは `type="button"`、`OverviewKpis` のフォロワー数は `latest`。**親の判断**: 75 件すべて反映。規則は固定のまま Q3 = 0 の性質を明記し、段階 0 で種類ごとに「Q3 = 0 か」だけ見て Q5 で決める（推奨は受け入れ。代案はリーチ率だが収集開始前の投稿が判定できない）。Q17（指標の固定）を足す。Q9 に「直近 7 日に投稿がなければ判定しない」を推奨で足す。`OverviewKpis` に月末のフォロワー数を出す引数を足す。段階 0 と受け入れの記録は決定と件数だけ。起草者に差し戻した（0.2、上限 25 分）
- **設計書 0.2（2026-10-12。`nextjs-developer`、約 9 分、12 回、差分で約 7 万トークン・累計 20 万）**: 75 件をすべて反映（640 行）。起草者が独自に決めた点: 投稿がない週は `no_history` と別の見送り理由 `no_posts`（投稿数は `media` を太平洋時間の日付で数える）、`noHistoryKinds` を足して既存の `noHistory` は残す、前日の隣接の検査は純関数で、境目は `BigInt` の交差乗算、`maxLength` は付けない、拒否の文言は 5 種（ユーザーが確かめる）、`getDailyRange` が null なら `NotCollected`、`test/form-input.test.ts` を 2b に。残る未確認は `media_outlier_flags` の実行時間（段階 1 で測る）と React 19 の form のリセットの挙動（実装時に確かめる）の 2 つ。次は確認事項 Q1〜Q17（ユーザー）
- **Q の決定（2026-10-13）**: ユーザーが Q1〜Q17 をすべて推奨どおりに決めた（Q12 は解消済み）。設計書を 0.3 にした。段階 0 の本番の数は Q の判断材料ではなくなったので、段階 5 の受け入れで数える（SQL は親が用意し、ユーザーがクラウドの Supabase の SQL エディタで実行する）。同日に段階 1（DB。`node-worker-developer`）、2a（ワーカー。`node-worker-developer`）、2b（画面の共通。`nextjs-developer`）を並列に着手。手元の Supabase は Docker Desktop を起動して `npm run db:start` で上げた
- **段階 2b（画面の共通。2026-10-13、`nextjs-developer`、約 15 分、56 回、12 万トークン。上限 25 分の中）**: ナビの「レポート」、`SpecialTags` の `shareFlag`、`OverviewKpis` の `followerTile`（純関数 `followerKpi` を切り出してテスト）、`METRIC_DEFINITIONS.share_flag` と `ACCOUNT_METRIC_DEFINITIONS` の 3 項目（設計の 2 項目に `followers_end` を足した。既存の `followers` の説明が月末の値では誤りになるため）、`lib/report-month.ts`（既定の月は選べる月の中に収める。データが今月から始まると前月が範囲の外になるため）、`lib/form-input.ts`（R5 の `_edit/input.ts` は再 export）、`no-store` に `/report`。新規テスト 44 件
- **段階 2a（ワーカー。2026-10-13、`node-worker-developer`、約 17 分、55 回、16 万トークン。上限 30 分の中）**: `jobs/alerts.ts` の 2 種類（`BigInt` の交差乗算、前日は UTC の日数差 1）、`db/alert-signals.ts`（3 関数。`left join` にして使えた日が 0 でも `no_history` を出す。戻り値に `latest` を足した）、`check-alerts.ts`（daily だけ読む。`no_history=<kinds>` と `no_posts=` は該当があっても出す。`no_history` と `no_posts` が重なれば `no_history` を優先）。単体 31 件、結合 6 件。DB が落ちていたため結合は親が後で実行し、既存の結合テスト 3 件の期待値に `no_history=stories` を足した（残り 2 件の失敗はその連鎖）
- **段階 1（DB。2026-10-13、`node-worker-developer`、約 45 分のうち Docker の復旧待ちが約 15 分、61 回、18 万トークン）**: `20261013000000_r6_report.sql`（設計の SQL そのまま。`comment on column` を 2 本足した）、fixture（`postMetrics`、`insertReportNote`、`insertAccountDailyMetrics`、`KIND_COLUMNS`、`insertOutlierPeerSet`）、`r6-views.test.ts` 27 件、`web-role.test.ts` の棚卸し。手元の DB は ICU の照合順序で、U+2028・ZWJ は通り CR・タブ・NEL は拒む（設計どおり。**本番の照合順序は段階 4 で `select E' ' ~ '[[:cntrl:]]'` で確かめる**）。性能（300 件、`web_app`、`analyze` 後）: ビュー単体 18 ms、投稿一覧は結合なし 4 ms → 結合あり 22 ms、基の CTE は 1 回、lateral の loops は 300 で 1 回 0.05 ms、最新スナップショットは索引の逆順走査、内側の `limit 20` の見積もりは 1 行（実際 19 行）。**注意**: 投入直後で統計が古いと一覧＋結合が Nested Loop になり 5.8 秒かかった（`analyze` で解消。本番は autovacuum が効くが、大量投入の直後は遅くなりうる）
- **手元の Docker の障害（2026-10-13 12:04 ごろ）**: WSL の `docker-desktop` が止まりエンジンが落ちた（原因は不明。バックエンドのログは ping の応答なしだけ）。`docker desktop restart` で復旧し、Supabase のコンテナは自動で再起動した。段階 1 と 2a の DB を使う作業はその後に行った
- **親の確認（2026-10-13）**: ワーカー 875 件（結合込み）、Web 911 件（結合込み）、lint、型検査が通過。コミット `5eaee55`。段階 3A（レポート画面）と 3B（印）を `nextjs-developer` × 2 で並列に着手
- **段階 3A・3B（2026-10-13、並列。`nextjs-developer` × 2）**: 3A（レポート。約 30 分、98 回、26 万トークン。上限 45 分の中）: `app/report/*`（9 節のカード、`ReportNotesProvider`、Server Action `saveReportNotes`）、`lib/report.ts`、`lib/queries/report.ts`、`lib/queries/report-notes.ts`、単体 62 件＋結合 13 件。3B（印。約 15〜20 分、82 回、16 万トークン。上限 30 分の中）: 一覧と CSV の SQL に `left join`、投稿詳細の「直前の同種 n 件のシェア率」の行と既存の倍率の行への件数、CSV の末尾 2 列、単体 1 件＋結合 7 件。親の確認: lint、型検査、Web 994 件（結合込み）、`next build` が通過。`ShareFlag` 型の重複を `lib/queries/media.ts` の 1 つに寄せた。設計書を 0.4 にし、設計からの変更（3A 13 点、3B 6 点など）を変更履歴に書いた。次は段階 5 のレビュー（`security-engineer`、`quality-engineer`、`postgres-sql-reviewer` を並列）→ 段階 4（ユーザーの `supabase db push` → main のマージ → Vercel）→ 受け入れ（本番の数は `scripts/r6-production-counts.sql`）
- **段階 5 のレビュー（2026-10-13、並列）**: `security-engineer`（約 10 分、35 回、14 万トークン）: 高・中なし。低 1（正規表現とテストの不可視文字 U+200D／U+202E／U+200B をリテラルで埋めている → エスケープ表記に直した）。確認のみ 4（`[[:cntrl:]]` の照合順序依存、`getDailyRange` の失敗理由のログ、debug ログの `error=`、失敗時の `values`）。6 観点とも問題なし。`postgres-sql-reviewer`（約 9 分、26 回、11 万トークン）: 高なし。**中 1**: `[[:cntrl:]]` の判定は照合順序で変わり、クラウドの Supabase が libc だと U+2028／U+2029 が DB で拒まれ手元（ICU）と差が出る → Action の正規化で U+2028／U+2029 を `
` にそろえた（環境に依存しない形。設計書 6.2 節に反映）。低 5 は見送り（括弧の統一、設計 4.3 節の SQL を実装に合わせる（反映済み）、結合側の `materialized` の CTE、`countRecentPosts` の索引、窓の 2 回の集約）。確認のみ 6。`quality-engineer`（約 15 分、102 回、17 万トークン）: 7 章と照合して 14 件を追記（方針の回帰 5 項目のうち 4、フォーム部品の描画と `<script>` のエスケープ、DB の check と Action の検査の差、`insertAccountDailyMetrics` と `account_daily_wide` の対応と率）。補わなかったのはページ全体の描画（mock が重い。受け入れの目視で見る）。不具合なし（U+2028 の正規化とテストの食い違いは親の変更が原因で、テストを置き換えた）。親の確認: lint、型検査、Web 1006 件（結合込み）、`next build` が通過
- **段階 4（2026-10-13）**: (1) ユーザーが `npx supabase db push`（`20261013000000_r6_report.sql`）→ (2) 親が main に `--no-ff` でマージして push（Vercel の配信）。済み
- **次回やること**: (3) 翌朝の daily の `check-alerts` が `alerts=0`（`no_history=`／`no_posts=` つきでよい）で終わることを `/jobs` と GitHub Actions のログで確かめる → 段階 5 の受け入れ（7.3 節。`/report` を月初 3 日目以降に開く、総評の保存、2,001 文字で失敗時に本文が消えないこと、`scripts/r6-production-counts.sql` の結果を `.local/` に置き件数だけ記録、0 節で本番の照合順序と U+2028 の判定を確認）

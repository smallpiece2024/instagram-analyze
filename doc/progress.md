# 進捗と次の作業

作業を再開するときは、まずこの文書を読む。区切りごとに更新する。

| 項目 | 内容 |
|---|---|
| 最終更新 | 2026-10-01 |
| 現在地 | **R1 の収集ワーカーが完成し、ローカルで常駐を開始（2026-10-01 深夜）。3 日間の実機確認中。次は Facebook Login の接続画面と最小限の画面** |
| 要件定義 | [requirements/requirements-definition.md](requirements/requirements-definition.md)（版 0.4） |

---

## 1. リリースの状況

| リリース | 内容 | 状況 |
|---|---|---|
| R0 | ローカル開発環境と API 検証 | **完了**（2026-09-30） |
| R1 | 収集基盤（ローカル） | 進行中。DB、ワーカー（7 ジョブとスケジューラ）まで完了し、2026-10-01 深夜から 3 日間の実機確認中。残りは Facebook Login の接続画面（F-COL-01）と最小限の画面（F-UI-01〜03） |
| R2 | クラウド稼働（Supabase Cloud、Vercel、GitHub Actions） | 未着手 |
| R2.5 | 画面設計（架空のデータのプロトタイプ、デザインシステムの比較） | 未着手。R1 の収集が動き始めたら着手してよい。R2 と並行可。R3 の前に終える |
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
- 未検証: カルーセル、フィード動画（該当投稿がなかった）、冬時間の日付の区切り、Facebook Login の戻り先に localhost を使えるか。

## 3. 手元の環境の状態

- `.env`（Git 管理外）に、期限のない **ページアクセストークン**、Instagram アカウントの数値 ID（`IG_USER_ID`）、Meta アプリの ID とシークレットを設定済み。
- トークンの **データアクセス期限は 2026-12-29 ごろ**（2026-09-30 時点で残り約 90 日）。過ぎるとアプリの再承認が必要。R1 で期限の表示と通知を作る。
- `.env` に `DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（ローカルの Supabase CLI の既定値）も追加済み（2026-10-01）。
- ローカル DB に `register-token` でページトークンを登録済み（`accounts`、`private.credentials`、Vault に 1 件ずつ。`status = valid`）。収集ジョブはこれを使い、`.env` のトークンは `register-token` と `verify-api` だけが読む。README の手順どおり `.env` の `META_ACCESS_TOKEN` と `IG_USER_ID` は消してよい（`verify-api` を使うときだけ戻す）。
- 常駐のワーカーは `npm run worker:up` で起動中（2026-10-01 深夜）。止めるときは `npm run worker:down`、ログは `npm run worker:logs`。PC のスリープ中は止まるので、3 日間の確認中はスリープを切る（要件 Q7）。
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
3. **Meta との接続**
   - まずは `.env` のページトークンで収集を動かしてよい。Facebook Login による接続画面（F-COL-01）とトークンの DB 保存は R1 の中で作る
   - トークンの有効期限とデータアクセス期限の記録と表示（F-COL-02、F-COL-03）
4. **最小限の画面**（接続状態、収集ログ、投稿の簡易一覧）。見た目は簡素でよい。R2.5 で決めたデザインで R3 に作り直す

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

## 5. 作業の決まりごと

- ユーザーへの応答は日本語。コミットメッセージも日本語。
- Git: ブランチで作業し、まとまった単位でローカルの main に `--no-ff` でマージして push する。マージ済みブランチは削除する。指示を待たずに行ってよい。
- 公開リポジトリなので、秘密情報、取得データ、アカウントの ID やユーザー名をコミットしない（要件 NF-SEC-06、NF-SEC-07）。
- Next.js 16 は従来と API が違うので、コードを書く前に `node_modules/next/dist/docs/` を読む（`apps/web/AGENTS.md`）。
- AI や有料 OCR を使う前に、`doc/ai-decisions/` に検討メモを書いてユーザーの了承を得る（要件 8.7 章）。


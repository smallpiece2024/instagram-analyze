# instagram-analyze

インスタの分析ツール。自分の Instagram プロアカウントのデータを Meta 公式 API から継続的に取得して蓄積し、どんな投稿がなぜ伸びたのかを分析する。

- 要件定義: [doc/requirements/requirements-definition.md](doc/requirements/requirements-definition.md)
- 事前調査: [doc/preliminary/](doc/preliminary/)

## 構成

| ディレクトリ | 内容 |
|---|---|
| `apps/web` | Web アプリ（Next.js 16、TypeScript） |
| `apps/worker` | 収集ワーカー（Node.js 24、TypeScript、ffmpeg）。Docker コンテナで動かす |
| `supabase` | Supabase の設定とマイグレーション（Supabase CLI） |
| `doc` | 調査資料、要件定義など |

npm workspaces で `apps/*` をまとめて管理している。

## 必要なもの

- Docker（Docker Desktop など）
- Node.js 24 以上と npm
- Meta API を検証する場合: Instagram プロアカウントと、それに接続した Facebook ページ、Meta 開発者アプリ

Supabase CLI は npm の開発用依存に含めているので、別途のインストールは不要。

## ローカル環境の起動

リポジトリのルートで実行する。

```bash
# 1. 依存関係のインストール
npm install

# 2. Supabase を Docker で起動（初回はイメージの取得に数分かかる）
npm run db:start

# 3. 接続情報を確認する（API URL、Publishable key、Studio の URL など）
npm run db:status

# 4. Web アプリの環境変数を用意し、NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY に
#    手順 3 の Publishable key を入れる
cp apps/web/.env.example apps/web/.env.local

# 5. Web アプリを起動して http://localhost:3000 を開く
npm run dev:web
```

画面に「すべてのサービスに接続できています」と出れば、Web アプリからローカルの Supabase に接続できている。

| サービス | URL |
|---|---|
| Web アプリ | http://localhost:3000 |
| Supabase Studio（DB の管理画面） | http://127.0.0.1:54323 |
| Supabase API | http://127.0.0.1:54321 |
| Postgres | postgresql://postgres:postgres@127.0.0.1:54322/postgres |

停止するときは `npm run db:stop`。

## 収集ワーカー

ワーカーは ffmpeg を含む Docker イメージとして動かす。

```bash
# イメージのビルド
npm run worker:image

# 実行環境の確認: ffmpeg で検証用動画を作り、長さとカットのタイミング（ミリ秒）を取得できるか確かめる
npm run worker:check-env
```

`結果: OK` と出れば、動画解析に必要な環境が揃っている。

ワーカーは Docker 内で `node` ユーザー（非 root）として動く。ローカル出力先 `.local/` 自体は書けるが、以前の root 時代のイメージが作った配下のディレクトリは書けないことがある。`permission denied` が出たら、一度だけ次で権限を直す。

```bash
docker compose run --rm --user root --entrypoint sh worker -c "chmod 777 /app/.local/api-verification"
```

### トークンの登録（R1）

収集ジョブは `.env` のトークンを直接使わず、ローカル DB（Supabase Vault）に登録したトークンを使う。`.env` に次を設定してから登録する。

| 変数 | 内容 |
|---|---|
| `META_ACCESS_TOKEN` | 期限のないページアクセストークン（下の「Meta API の検証」を参照） |
| `IG_USER_ID` | Instagram アカウントの数値 ID |
| `META_APP_ID`、`META_APP_SECRET` | Meta アプリの ID とシークレット（`debug_token` で期限と権限を調べるのに必須） |
| `DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` | ローカルの Supabase への接続先（`.env.example` の値。キーは `npm run db:status` の `service_role` の値） |

```bash
npm run worker:register-token
```

種類、有効期限、データアクセス期限の残り日数、権限が表示される。同じトークンで何度実行しても結果は同じで、新しいトークンに差し替えるときも同じコマンドを使う。**登録が済んだら `.env` から `META_ACCESS_TOKEN` と `IG_USER_ID` を消す**（常駐コンテナの環境変数に不要なトークンを渡さない。ジョブは DB のトークンだけを使う。`verify-api` を使うときだけ一時的に戻す）。

### 収集の常駐（R1）

ワーカーのコンテナを常駐させると、毎時 `WORKER_HOURLY_MINUTE` 分（既定 5 分）に hourly グループ、毎日 JST `WORKER_DAILY_TIME_JST`（既定 05:30）に daily グループを同じプロセス内で順に実行する。設定は `.env`（`.env.example` を参照）。コンテナの再起動や PC の復帰で予定の時刻を過ぎていても、その時間帯（その日）の分を 1 回だけ実行する。PC のスリープ中は止まる。

```bash
npm run worker:up      # 常駐を開始（docker compose up -d worker）
npm run worker:logs    # ログを追う（Ctrl-C で抜ける。常駐は止まらない）
npm run worker:down    # 常駐を止める（実行中のジョブを終えてから止まる。最大 10 分待つ）
```

コンテナはルートファイルシステムが読み取り専用（`read_only`）で、書けるのは `/tmp`（tmpfs、512MB。動画の一時ファイル。強制終了してもホストに残らない）と `.local`（bind）だけ。権限昇格の禁止、capability の全削除、プロセス数とメモリ（1GB）の上限も `docker-compose.yml` で掛けている。

| グループ | 順番 | 内容 |
|---|---|---|
| hourly | `stories` → `media-sync` → `media-snapshot` → `account-backfill` | ストーリーズ（24 時間で消えるので最優先）→ 投稿一覧の差分 → 投稿指標のスナップショット → 日次指標の過去分のバックフィル（レート制限に余裕があるときだけ進む） |
| daily | `token-check` → `profile-daily` → `account-daily` → `media-sync --full` | トークンの期限と権限の確認 → プロフィールの日次記録 → アカウント日次指標の直近 4 日と follower_count → 投稿一覧の全件同期（消えた投稿の検出） |

バックフィルが遡る日数は `WORKER_BACKFILL_HISTORY_DAYS`（既定 730 = API の上限の 2 年）で変えられる。開設して間もないアカウントでは、開設からの日数より少し多めにしておくと空振りを避けられる。途中で小さくすれば残りが縮んで終わる。大きくし直すときは `delete from public.job_state where job_name = 'account_backfill'` で最初からやり直す。

**常時起動でない PC での運用**: Supabase とワーカーのコンテナはどちらも `restart: unless-stopped` なので、Docker Desktop が起動すれば自動で戻る。Docker Desktop の設定で「サインイン時に起動（Start Docker Desktop when you sign in）」を有効にしておけば、PC を起動するだけで収集が再開し、起動直後にその時間帯の hourly と当日未実行の daily が 1 回ずつ走る。シャットダウンに特別な手順はない（実行中のジョブが中断されても、次回の起動時に `running` の記録は `failed` に整理され、ロックは接続の切断で外れ、一時ファイルは tmpfs ごと消える）。止まっていた間の影響は次のとおり。

| 止めた長さ | 影響 | 補う方法 |
|---|---|---|
| 数時間 | ストーリーズのその時間帯の指標と、投稿後 24 時間以内の投稿の 1 時間ごとのスナップショットが欠ける | 補えない（API に過去の値がない）。日次指標とプロフィールは影響なし |
| 1〜3 日 | 上に加えて、プロフィール日次がその日数分欠ける。日次指標は 4 日の窓で自動的に埋まる | 自動 |
| 4 日以上 | 日次指標にも欠けが出る | 起動後に `npm run worker:job -- account-daily --days N`（N = 止めた日数 + 1。最大 30 日。それより前はバックフィルの `job_state` を消してやり直す） |

ジョブを 1 回だけ動かすには `npm run worker:job -- <command>` を使う（常駐と同時に動かしても、同じジョブは二重に走らない）。

```bash
npm run worker:job -- media-sync --full      # 投稿一覧を全ページ読み、消えた投稿を検出する
npm run worker:job -- account-daily --days 7 # 日次指標を直近 7 日分取り直す
npm run worker:job -- run-hourly             # hourly グループを 1 回
npm run worker:job                           # 引数なしでコマンドの一覧
```

**ログの見方**: 1 ジョブにつき 1 行（`job=`、`status=`、`items=`、`calls=`、`failures=`、`duration_ms=`、`rate=`）。`status` は `success`、`partial`（一部の項目が失敗。次の実行で埋まる）、`failed`、`skipped`（レート制限で見送り、または同じジョブが実行中）。`worker:job` の終了コードは `failed` があれば 1、それ以外は 0。失敗の行には `error_code=`（Graph API のコードか SQLSTATE）と `class=` が付く。エラーメッセージの全文（秘密情報はマスク済み）は `WORKER_LOG_LEVEL=debug` のときだけ出る。**GitHub Actions など公開されるログでは `debug` にしない。** 実行記録は `job_runs` テーブルにも残る（Supabase Studio の `job_latest_runs` ビューで最新を確認できる）。

**バックフィルのやり直し**: 完了した `account-backfill` は `job_state` を見て動かない。最初からやり直すには、次を実行すると次の実行で前日から始まる（すべて upsert なので既存の行は上書きされるだけ）。

```sql
delete from public.job_state where job_name = 'account_backfill' and account_id = '<accounts.id>';
```

**接続解除時のサムネイルの削除**: `accounts` の行を消しても Storage のサムネイルは残るので、次で消す（`<accounts.id>` は内部の uuid）。接続画面からの解除は後のリリースで作る。

```sql
delete from storage.objects where bucket_id = 'thumbnails' and name like '<accounts.id>/%';
```

**注意**: ローカルの Supabase のポート（54321〜54324）を LAN に公開しない。サービスロールキーと DB パスワードの既定値が公知のため、同じネットワークから DB と Storage を読み書きできてしまう。

## Web アプリの画面と Meta との接続（R1）

`npm run dev:web` で `http://localhost:3000` を開く（`127.0.0.1` だけで待ち受ける。LAN には公開しない）。ログインはまだない（R2）。設計は `doc/design/r1-web-screens.md`。

| 画面 | 内容 |
|---|---|
| `/` 接続状態 | アカウント、トークンの種類と期限、データアクセス期限の残り日数、権限、認証情報の状態、最終収集時刻。再接続が必要なら帯で知らせる |
| `/jobs` 収集ログ | ジョブごとの直近の実行と、直近 100 件の実行記録（`?job=<ジョブ名>` で絞り込み） |
| `/media` 投稿一覧 | サムネイル、種類、投稿日時、最新の主要指標（50 件ずつ） |
| `/connect` 接続設定 | Facebook Login で Meta と接続し、Instagram プロアカウントを登録する |

Web アプリのサーバー側は Postgres に直結し、ログイン（Supabase Auth）、サムネイルの署名付き URL（ログインした利用者のセッション）、トークンの登録に次の変数を使う（`apps/web/.env.example` を `apps/web/.env.local` にコピーして入れる。`NEXT_PUBLIC_` が付かない変数はブラウザに渡らない）。

| 変数 | 内容 |
|---|---|
| `DATABASE_URL` | ローカルは `postgresql://web_app:web_app_local@127.0.0.1:54322/postgres`（R2 で Web 用のロール `web_app` に変えた。パスワードはローカル専用の公知の値） |
| `DATABASE_POOL_MODE`、`DATABASE_SSL_CA` | ローカルは省略。本番（プーラーのトランザクションモード）では `transaction` と Supabase の CA 証明書の PEM（`doc/design/r2-cloud.md` 2.2 章） |
| `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ログインと署名付き URL。`npm run db:status` の値 |
| `WEB_ALLOWED_USER_ID` | ログインを許す Supabase Auth の利用者の `id`。未設定なら全画面が 403（フェイルクローズ） |
| `META_APP_ID`、`META_APP_SECRET`、`META_GRAPH_API_VERSION` | ワーカーの `.env` と同じ値 |
| `APP_URL` | `http://localhost:3000`。Meta からの戻り先 `${APP_URL}/api/meta/callback` の元 |
| `META_TARGET_IG_USER_ID` | 任意。指定すると、候補の数にかかわらず一致する Instagram アカウントのページだけを登録し、一致がなければ登録しない（複数のページを管理しているときの保険） |

### Meta アプリ側の設定（Facebook Login を使う前に 1 回）

1. [Meta for Developers](https://developers.facebook.com/apps/) で自分のアプリを開き、「製品を追加」から **Facebook ログイン** を追加する。
2. Facebook ログインの「設定」で「クライアント OAuth ログイン」と「ウェブ OAuth ログイン」を「はい」にして保存する。
3. 戻り先 `http://localhost:3000/api/meta/callback` は **登録しなくてよい**。開発モードのアプリでは `http://localhost` への戻り先が自動的に許可される（Meta の設定画面にその旨が表示される。2026-10-02 に確認）。`127.0.0.1` は HTTPS が必須なので使わない。ブラウザも `http://localhost:3000` で開く（`APP_URL` と同じオリジンでないと接続の開始が 403 になる）。
4. アプリは開発モードのままでよい。ログインする Facebook ユーザーは、アプリの管理者・開発者・テスターのいずれかである必要がある。

`/connect` の「Meta と接続する」で認可画面に進み、許可すると、Instagram プロアカウントの付いた Facebook ページのトークンが DB（Supabase Vault）に登録される。`.env` のトークンを `register-token` で入れていた場合も、同じアカウントなら差し替わる。候補のページが複数あるときは登録せずに戻るので、認可画面で対象のページだけを選び直すか `META_TARGET_IG_USER_ID` を設定する。

## Meta API の検証

要件定義の F-COL-00 に従い、Meta API で実際に何が取れるかを自分のアカウントで確かめる。

1. アクセストークンを用意する。[Graph API エクスプローラ](https://developers.facebook.com/tools/explorer/) で自分の Meta アプリを選び、次の権限を付けてユーザーアクセストークンを発行する。
   - `instagram_basic`
   - `instagram_manage_insights`
   - `pages_read_engagement`
   - `pages_show_list`（ページトークンを `me/accounts` で得るときだけ要る。収集では使わない）
2. ルートの `.env.example` を `.env` にコピーし、`META_ACCESS_TOKEN` にトークンを入れる。`META_APP_ID` と `META_APP_SECRET` も入れると、トークンの種類と有効期限も調べられる。`DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` も入れると、DB と Storage の接続も検証する。
   - ページアクセストークンも使える。その場合は `IG_USER_ID` に Instagram アカウントの数値の ID を入れる（ユーザー名ではない）。ページトークンは、Instagram アカウントを接続した Facebook ページのものを使う。
   - 期限のないページトークンは、長期ユーザートークン（約 60 日）で `me/accounts?fields=name,access_token,instagram_business_account{id,username}` を実行して得る。短期ユーザートークンから作ったページトークンは約 1 時間で切れる。
   - 期限のないトークンでも「データアクセス期限」（約 90 日）があり、過ぎるとアプリの再承認が必要になる。
3. 検証を実行する。

```bash
npm run worker:verify-api
```

結果は `.local/api-verification/` に 2 つのファイルとして出力される。

| ファイル | 内容 | 扱い |
|---|---|---|
| `verify-api-*.json` | API のレスポンスを含む詳細（署名付き URL とページングの URL は `<omitted>` に置き換える） | 自分のデータを含む。Git 管理外 |
| `verify-api-*.md` | 取得できた項目、できなかった項目の要約。ID、指標の値、URL は含まない（10 桁以上の数字と URL は伏せる） | `doc/` に転記してよい |

ストーリーズの検証は、公開中（投稿から 24 時間以内）のストーリーズがあるときだけ行われる。

## クラウド稼働（R2）

設計と理由は `doc/design/r2-cloud.md`。構成は Supabase Cloud（Free）＋ Vercel（Hobby）＋ GitHub Actions（公開リポジトリ）。ローカル環境は開発用に残すが、切り替え後はローカルの常駐（`npm run worker:up`）を使わない（二重収集になる）。プロジェクトの ref、本番の URL、鍵はリポジトリに書かない。

### 1. Supabase Cloud の設定（ダッシュボード）

| 場所 | 設定 |
|---|---|
| Authentication → Sign In / Providers | 「Allow new users to sign up」をオフ。匿名サインインはオフのまま。パスワードの要件を 8 文字以上に |
| Authentication → Users | 利用者を 1 人作る（メール確認済みで作成）。その `id`（uuid）を控える（Vercel の `WEB_ALLOWED_USER_ID` と `private.web_users` に使う） |
| Authentication → URL Configuration | Site URL を `https://<app>.vercel.app` |
| Database → Settings → SSL Configuration | 「Enforce SSL on incoming connections」をオン。CA 証明書（`prod-ca-2021.crt`）をダウンロードする（GitHub Variables と Vercel の `DATABASE_SSL_CA` に PEM の本文を入れる） |
| Data API → Settings | 「Exposed schemas」から `public` を外す（この構成は REST を使わない） |
| Connect | セッションモード（`:5432`、ワーカーと手元の psql 用）とトランザクションモード（`:6543`、Vercel 用）の接続文字列を控える。直接接続は IPv6 なので使わない |

### 2. マイグレーションの適用（手元の PC から）

```bash
npx supabase link --project-ref <project-ref>     # supabase/.temp/ に保存（Git 管理外）
npx supabase db push                              # --include-seed を付けない。db reset --linked も使わない（seed.sql の公知のパスワードが本番に入る）
npx supabase migration list
```

続けて psql（セッションモード）で、`web_app` のパスワードと Storage を読める利用者を入れる。パスワードを SQL 文やコマンドラインに書かない（履歴とサーバーログに残さない）。

```bash
psql -h aws-<n>-ap-northeast-1.pooler.supabase.com -p 5432 -U postgres.<project-ref> -d postgres "sslmode=verify-full sslrootcert=<CA 証明書のパス>"
```

```sql
\password web_app                                  -- 強いパスワード（Vercel の DATABASE_URL に使う）
insert into private.web_users (user_id, note) values ('<利用者の id>', '本人');
\q
```

`web_app` でトランザクションモードに接続できることを確かめてから Vercel に入れる。

```bash
psql -h aws-<n>-ap-northeast-1.pooler.supabase.com -p 6543 -U web_app.<project-ref> -d postgres "sslmode=verify-full sslrootcert=<CA>" -c "select current_user, current_setting('statement_timeout')"
npx supabase logout                                # 作業が終わったら
```

### 3. Vercel（環境変数は 2 段で入れる）

設定: Root Directory `apps/web`、Node.js 24.x、「Include source files outside of the Root Directory」をオン、Settings → Build and Deployment の Ignored Build Step に `if [ "$VERCEL_ENV" = "production" ]; then exit 1; else exit 0; fi`（プレビューを作らない）。

環境変数は Environments を Production だけにして入れる。区分（Vercel の Config／Secret。Secret は保存後に値を読み返せない）は表のとおり。入れたあとは再デプロイしないと効かない。

| 段 | 変数（Production） |
|---|---|
| 1 | `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`、`APP_URL`（`https://<app>.vercel.app`）、`WEB_ALLOWED_USER_ID`。4 つとも Config |
| 2 | `DATABASE_URL`（トランザクションモード、`web_app`。区分は Secret）、`DATABASE_POOL_MODE=transaction`、`DATABASE_SSL_CA`、`META_APP_ID`、`META_APP_SECRET`（区分は Secret）、`META_GRAPH_API_VERSION=v25.0`。区分の指定がないものは Config |

段 1 だけでデプロイし、未ログインで `/` が `/login` に飛ぶこと、本人でログインできること、別の利用者（一時的に作って消す）が 403 になることを確かめてから段 2 を入れて再デプロイする。`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は Vercel に置かない（サムネイルはログインした本人のセッションで署名する）。

### 4. Meta アプリ、Healthchecks

- Meta for Developers → Facebook ログイン → 設定 →「有効な OAuth リダイレクト URI」に `https://<app>.vercel.app/api/meta/callback` を追加する。
- `appsecret_proof` は常に付ける実装になっている。アプリ設定の「App Secret が必要」をオンにするのはワーカーと Web の両方が本番で動いてから。オンにすると Graph API エクスプローラと `verify-api` もプルーフなしでは動かない。
- Healthchecks.io でチェックを 1 つ作る（Period 1 時間、Grace 3 時間、通知はメール）。ping URL を GitHub Secrets の `HEALTHCHECKS_PING_URL` に入れる。

### 5. GitHub の Secrets と Variables（Settings → Secrets and variables → Actions）

Secrets は Environment **`Production`** に置く（`collect.yml` の `collect` ジョブが `environment: Production` を指定している）。Production 環境に保護ルール（承認者、待ち時間、ブランチの制限）を付けるとスケジュール実行が止まるので付けない。Variables はリポジトリの Variables に置く。

| 種類 | 名前 | 値 |
|---|---|---|
| Secret | `DATABASE_URL` | セッションモード、`postgres.<project-ref>`（Vault の復号を含む全権。漏れたら DB パスワードをリセット） |
| Secret | `SUPABASE_URL` | `https://<project-ref>.supabase.co`（ref を公開ログに出さないため Secret） |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` | サムネイルのアップロード用 |
| Secret | `META_APP_ID`、`META_APP_SECRET` | Meta アプリ |
| Secret | `HEALTHCHECKS_PING_URL` | 死活監視 |
| Variable | `DATABASE_SSL_CA` | CA 証明書の PEM（複数行のまま貼る。崩れたら `\n` のリテラルでもよい） |
| Variable | `COLLECT_ENABLED` | **切り替えが終わるまで `false`**。`true` で収集が動く。ローカルへ戻すときも `false` |
| Variable | `COLLECT_KEEPALIVE` | `true`（60 日の無効化対策。試験や停止のときは `false`） |
| Variable | `WORKER_SIMULATE_ALERT` | 普段は未設定。通知の経路の確認で一時的に `true` |

Variables はステップを展開すると平文で見えるので、公開されてよい値だけを置く。失敗メールは「ワークフローを作った人」に届く（cron を編集した人に移る）。GitHub の通知設定で「失敗したときだけ」にしておく。

### 6. 切り替え（深夜に、連続して行う）

事前に 1〜5 を済ませ、サムネイルの 1 回目のコピー（`rclone` でローカルの S3 互換エンドポイントから本番の `thumbnails` へ。S3 キーはダッシュボードで作り、終わったら消す）と、空の本番 DB への流し込みのリハーサル（下の 3〜4 を行い、件数を見て `truncate`）をしておく。

```bash
npm run worker:down                                                   # 1. ローカルの常駐を止める
docker exec supabase_db_instagram-analyze psql -U postgres -d postgres -c "update public.job_runs set status = 'failed', finished_at = now(), error = 'aborted: migration' where status = 'running';"   # 2. 実行中だった記録の整理
docker exec supabase_db_instagram-analyze pg_dump -U postgres -d postgres --data-only --inserts --on-conflict-do-nothing --schema=public --exclude-table-data=public.metric_definitions > .local/r2-migration.sql   # 3. 取得データを含むので .local に
psql -h aws-<n>-ap-northeast-1.pooler.supabase.com -p 5432 -U postgres.<project-ref> -d postgres "sslmode=verify-full sslrootcert=<CA>" -v ON_ERROR_STOP=1 --single-transaction -f .local/r2-migration.sql   # 4. 流し込み（パスワードは対話入力）
rm .local/r2-migration.sql                                            #    終わったら消す
# 5. サムネイルの差分コピー（rclone の 2 回目）→ S3 キーと rclone の設定を削除
# 6. 本番の /connect で Meta に接続（トークンを Vault に登録。accounts は 4 で入っているので更新になる）
# 7. GitHub の Variables で COLLECT_ENABLED=true → Actions の collect を「Run workflow」で 1 回 → job_runs と画面で確認
# 8. 次の毎時 17 分（UTC）のスケジュール実行を T0 とし、7 日間の確認を始める。Healthchecks に ping が届くことを見る
```

Vault（トークン）と `private.credentials` は移さない（鍵がプロジェクトごと）。`job_state`（バックフィルの進み）は移る。

### 7. ローカルへ戻す（本番がうまく動かないとき）

1. GitHub の Variables で `COLLECT_ENABLED=false`（`collect` ジョブが skip になる）。
2. ローカルの DB は 7 日間の確認が終わるまで `db reset` しない。
3. `npm run worker:up`。欠けた日次は `npm run worker:job -- account-daily --days N`。

### 8. 7 日間の確認と通知の試験

項目と期待値は `doc/design/r2-cloud.md` の 10.2 章と 10.3 章。要点: `media_snapshot` の `success`／`partial` が 7 日で 168 行、隣り合う実行の間隔が 2 時間未満、`cancelled` の実行 0、`check-alerts` の行が毎回ある、Supabase の一時停止の警告メールが来ない、未ログインで全画面が `/login` へ、GitHub のログ（`gh run view <id> --log`）にトークン・`://`・10 桁の数字・ユーザー名・ref がない。通知の試験（`workflow_dispatch` の `simulate_alert`、Variable の `WORKER_SIMULATE_ALERT`、Healthchecks の使い捨てチェック）は T0 の前に行う。

### 9. 運用

- トークンのデータアクセス期限が 14 日を切ると daily の `check-alerts` が毎日メールを出す。本番の `/connect` で接続し直す。
- 月 1 回、Supabase の Usage（DB、Storage、egress）と Vercel の Usage を見る。
- 55 日目にワークフローの状態が `active` か確認する（`gh api repos/<owner>/<repo>/actions/workflows/collect.yml --jq .state`）。
- 本番に手で SQL を流すときは `psql -h … -U …` を都度指定し、パスワードを URL や履歴に残さない。本番の接続文字列をローカルの `.env` に書かない。

## 開発用コマンド

| コマンド | 内容 |
|---|---|
| `npm run lint:web` | Web アプリの lint |
| `npm run build:web` | Web アプリのビルド（出力で 4 ルートが `ƒ (Dynamic)` であることを確かめる） |
| `npm run typecheck -w web` | Web アプリの型チェック（`next typegen` のあと `tsc`） |
| `npm run test -w web` | Web アプリの単体テスト。`TEST_DATABASE_URL=...`（ワーカーと同じ）を付けると結合テストも動く。R2 の Web 用ロールの結合テスト（`test/db/web-role.test.ts`）は、さらに `TEST_WEB_DATABASE_URL=postgresql://web_app:web_app_local@127.0.0.1:54322/postgres` を付けたときだけ動く（パスワードは `supabase/seed.sql` のローカル専用の公知の値） |
| `npm run test -w worker` | ワーカーの単体テスト。`TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` を付けるとローカル Supabase への結合テストも動く（架空のアカウントを作って消す）。Storage の結合テストが使うサービスロールキーの既定値は Supabase CLI の公知のローカル用の値で、秘密ではない |
| `npm run typecheck -w worker` | ワーカーの型チェック |
| `npm run build:worker` | ワーカーのビルド（`apps/worker/dist/`。Docker を使わずに `node apps/worker/dist/index.js` で動かすときに使う） |
| `npm run worker:job -- <command>` | ワーカーのコマンドを 1 回実行する（例: `npm run worker:job -- register-token`） |
| `npm run worker:up` / `worker:down` / `worker:logs` | 収集の常駐の開始、停止、ログ |
| `npm run db:reset` | ローカル DB を作り直し、マイグレーションを適用し直す |

## DB

テーブル設計は `doc/design/r1-db-design.md`、マイグレーションは `supabase/migrations/` にある。ローカルの DB にはユーザーの実データが入るので、ダンプやエクスポートをコミットしない。

R2（`doc/design/r2-cloud.md` 3 章）で Web 用のロール `web_app` と、サムネイルを読める利用者の表 `private.web_users` を追加した（`20261002005926_r2_web_role.sql`）。

- パスワードはマイグレーションに書かない。ローカルは `supabase/seed.sql` が `db reset` のたびに公知の値（`web_app_local`）を設定し、結合テスト用の利用者（uuid `…0001`）を `private.web_users` に入れる。ローカルの Supabase Auth で作った自分の利用者でサムネイルを見るには、その `auth.users.id` を `private.web_users` に insert する。
- 実データが入っているローカル DB に `db reset` せずに適用するときは、`npx supabase migration up --local` のあと `docker exec -i supabase_db_instagram-analyze psql -U postgres -d postgres < supabase/seed.sql` で seed を流す。
- 本番（Supabase Cloud）では `seed.sql` を流さない。**`supabase db push --include-seed` と `supabase db reset --linked` は使わない**（公知のパスワードが本番に入る）。本番は `psql` の `\password web_app` で別の値を設定し、`private.web_users` に本人の uuid を入れる。
- 関数を足すマイグレーションは `revoke execute on function … from public` を書く（新しい関数は既定で誰でも実行できる。結合テスト `test/db/web-role.test.ts` が棚卸しする）。テーブルを足すときは `web_app` への grant とポリシーを両方書く。

## Claude Code のサブエージェントとスキル

このリポジトリの `.claude/agents/` に、外部由来のエージェント定義（MIT。出所と改変はファイル先頭、許諾文は `.claude/agents/LICENSES/`）を置いている。

Supabase 公式のスキル 2 本は、ファイルはコピーせず、公式プラグインとして `.claude/settings.json` に登録している（`extraKnownMarketplaces` と `enabledPlugins`）。このリポジトリで Claude Code を初めて開くと、マーケットプレイスの追加とプラグインの導入を求められるので承認する。手で入れる場合は次のとおり。

```bash
claude plugin marketplace add supabase/agent-skills
claude plugin install supabase@supabase-agent-skills --scope project
claude plugin install postgres-best-practices@supabase-agent-skills --scope project
```

## 注意（公開リポジトリ）

このリポジトリは公開している。次のものは絶対にコミットしない。

- `.env`、`apps/web/.env.local` などの秘密情報
- `.local/` 以下の取得データ
- 自分のアカウントの ID、ユーザー名、指標の値

## Graph API のバージョン

`META_GRAPH_API_VERSION` で固定する（既定は `v25.0`）。バージョンは少なくとも 2 年サポートされる。v25.0 の提供終了予定は 2028-07-29。

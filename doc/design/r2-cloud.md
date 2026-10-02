# R2: クラウド稼働の設計

| 項目 | 内容 |
|---|---|
| 版 | 0.1 |
| 作成日 | 2026-10-02 |
| 更新履歴 | 0.1 初版案 |
| 対象 | 要件定義 4.3 章（F-SYS-10〜15）、6.3 章、8.1〜8.3 章、10 章（R2 の完了条件）、11.1 章の C3 |
| 入力 | `doc/requirements/requirements-definition.md`（版 0.4）、`doc/design/r1-db-design.md`（7 章、7.1 章）、`doc/design/r1-collection-jobs.md`（6.2 章、8.2 章、12 章）、`doc/design/r1-web-screens.md`（1.2 章、2.2 章、3 章、12 章）、`supabase/migrations/`（5 本）、`apps/worker/src/`、`apps/web/src/`、`docker-compose.yml`、`apps/worker/Dockerfile`、Supabase・GitHub・Vercel の文書（13 章に確認日と URL） |
| 範囲外 | 画面の見た目（R2.5、R3）、接続解除の画面（R3 に回す。R1 は README の SQL）、生レスポンスの削除ジョブ（12 章の申し送り）、R4 以降の動画解析のクラウド化（ワーカーの実行環境は共通なので R4 で追加のジョブを足すだけ） |
| 状態 | 起草。レビュー前。11 章の Q1〜Q8 は未回答 |

---

## 0. 前提

- R2 の完了条件は「クラウドで 7 日間、人手を介さず収集が続く。ログインしないと画面を見られない。収集停止の通知が届くことを確認した」（要件 10 章）。
- R1 の収集ワーカー（7 ジョブ、`run-hourly`／`run-daily` のグループ）と最小限の画面 3 つ、Facebook Login の接続は実装・実機確認済み。R2 ではこれらを **作り直さず**、接続先と実行環境を差し替え、ログインと通知を足す。
- Supabase Cloud と Vercel のプロジェクトはユーザーが作成済み（2026-10-02。Vercel の Root Directory は `apps/web`）。本番の URL、プロジェクトの ref、鍵はリポジトリに書かない（NF-SEC-07）。この文書ではプレースホルダ（`<project-ref>`、`<region>`、`https://<app>.vercel.app`）を使う。
- ローカル環境（Supabase CLI と `docker-compose.yml` の常駐ワーカー）は開発用に残す。R2 の切り替え後はローカルのワーカーを常駐させない（二重収集を避ける。R1 設計 12 章）。
- インフラの月額は 0 円（NF-CAP-01）。Supabase Free、Vercel Hobby、GitHub Actions（公開リポジトリ）の範囲で設計する。

---

## 1. 全体構成

```text
                 ┌────────────────────────────────┐
  ブラウザ ─────→│ Vercel（Hobby）                 │
  （本人のみ）    │  Next.js 16: 画面、/api/meta/*  │──── Meta Graph API（Facebook Login、debug_token）
                 │  proxy.ts: Host 検査 + ログイン │
                 └──────────┬─────────────────────┘
                            │ プーラー トランザクションモード（6543、web_app ロール、TLS verify-full）
                            ▼
                 ┌────────────────────────────────┐
                 │ Supabase Cloud（Free、東京）      │
                 │  Postgres 17 / Auth / Storage   │
                 └──────────▲─────────────────────┘
                            │ プーラー セッションモード（5432、postgres ロール、TLS verify-full）
                 ┌──────────┴─────────────────────┐
                 │ GitHub Actions（公開リポジトリ）  │──── Meta Graph API（収集）
                 │  collect-hourly.yml（毎時）      │
                 │  collect-daily.yml（JST 05:33）  │──── 死活監視（Healthchecks.io。Q4）
                 └────────────────────────────────┘
```

| 構成要素 | R1（ローカル） | R2（クラウド） |
|---|---|---|
| DB、Auth、Storage | Supabase CLI（Docker） | Supabase Cloud の Free プロジェクト（東京。Q1） |
| 画面 | `next dev -H 127.0.0.1` | Vercel Hobby。本番デプロイのみ |
| 収集ワーカー | compose の常駐コンテナ（`schedule` コマンド） | GitHub Actions の `schedule` で `run-hourly`／`run-daily` を 1 回ずつ実行 |
| ログイン | なし（ループバックのみ） | Supabase Auth（メール＋パスワード、利用者 1 人） |
| 通知 | なし | GitHub Actions の失敗メール ＋ 死活監視の未着メール |

---

## 2. Supabase Cloud

### 2.1 プロジェクトと接続経路

Supabase の文書（13 章 S1）は、GitHub Actions と Vercel を「IPv4 のみの環境」として名指ししている。直接接続（`db.<project-ref>.supabase.co:5432`）は IPv6 なので、どちらからも **共有プーラー（Supavisor）** を使う。

| 用途 | 接続 | 理由 |
|---|---|---|
| ワーカー（GitHub Actions） | セッションモード `aws-<n>-<region>.pooler.supabase.com:5432`、ユーザー `postgres.<project-ref>` | `db/client.ts` が `reserve()` で 1 本を固定してアドバイザリロックを張る（R1 設計 6.2 章）。セッションの意味が要るのでトランザクションモードは使えない |
| Web（Vercel） | トランザクションモード 同ホスト `:6543`、ユーザー `web_app.<project-ref>` | サーバーレスは接続が短命。**プリペアドステートメント不可**なので postgres.js は `prepare: false`（13 章 S1） |
| マイグレーション、データ移行（手元の PC） | セッションモード `:5432`、ユーザー `postgres.<project-ref>` | `supabase db push`、`psql`、`pg_dump` の流し込み |

接続文字列はダッシュボードの「Connect」から取る。無料プランのプーラー接続数は 200（Micro。13 章 S4）で、ワーカー `max: 2` ＋ Web `max: 3`（Vercel の関数インスタンスごと）で十分。

### 2.2 TLS

- 両方とも `sslmode=verify-full` 相当にする。Supabase の CA 証明書（`prod-ca-2021.crt`。ダッシュボードの Database Settings → SSL Configuration からダウンロード。13 章 S2）を使う。
- 渡し方: 環境変数 **`DATABASE_SSL_CA`**（PEM の本文）。ファイルより環境変数の方が GitHub Actions と Vercel で同じ扱いにできる。CA 証明書は秘密ではないので GitHub では Variables、Vercel では通常の環境変数でよい。
- postgres.js には `ssl: { ca: [pem], rejectUnauthorized: true }` を渡す。Node の TLS は `rejectUnauthorized: true` でホスト名も検証するので `verify-full` と同等になる。`DATABASE_SSL_CA` が未設定ならローカル（平文）のまま（既定を変えない）。
- ダッシュボードの「Enforce SSL on incoming connections」を **オン**にする（平文の接続を拒否。設定時に DB が数秒〜数分再起動する。13 章 S2）。

変更箇所: `apps/worker/src/config.ts`（`DATABASE_SSL_CA` を任意で読む）、`apps/worker/src/db/client.ts`（`ssl` オプション）、`apps/web/src/lib/env.ts` と `apps/web/src/lib/db.ts`（同じ。加えて `prepare: false` を **`DATABASE_URL` のポートが 6543 のときだけ**ではなく、環境変数 `DATABASE_POOL_MODE=transaction` で明示する）。

### 2.3 一時停止の対策（C3）

Free プランは「過去 7 日間に十分な利用者の DB 活動がない」プロジェクトを一時停止する。文書は「1 日に数回の DB への要求があれば足りる」「一時停止の約 1 週間前に警告メールが届く」とする（13 章 S3）。ワーカーは毎時 DB を読み書きするので要件を満たす見込み。7 日間の確認（10 章）で警告メールが来ないことを確かめ、C3 を閉じる。来た場合はダッシュボードを開けば回避でき、復元は 90 日以内。

### 2.4 マイグレーションの適用

```bash
npx supabase link --project-ref <project-ref>    # supabase/.temp/ に ref を保存（Git 管理外）
npx supabase db push                              # supabase/migrations/ を順に適用。db pull と --yes は使わない（CLAUDE.md）
npx supabase migration list                       # ローカルとリモートの適用状況を比べる
```

- `supabase login` はブラウザの流れでフルアクセスのトークンを作る。CI では使わない（ローカルの PC からだけ適用する）。
- `db push` は DB パスワードを求める（`SUPABASE_DB_PASSWORD` 環境変数か対話入力）。パスワードはリポジトリに置かない。
- 新しいマイグレーション（3 章）はローカルの Supabase で `supabase db reset` → 結合テストを通してから push する。

### 2.5 Auth の設定（ダッシュボード）

| 設定 | 値 | 理由 |
|---|---|---|
| Allow new users to sign up | **オフ** | 利用者は本人だけ（NF-SEC-02）。オフにすると既存の利用者だけがサインインできる（13 章 S5） |
| 利用者の作成 | ダッシュボードの Authentication → Users で 1 人作る（メール確認済みで作成） | メール送信を使わずに済む。作成した利用者の `id`（uuid）を Vercel の `WEB_ALLOWED_USER_ID` に入れる（4.3 章） |
| Site URL | `https://<app>.vercel.app` | Auth のリダイレクト先の既定 |
| Redirect URLs | 追加しない | パスワードログインだけで、メールのリンクを使わない |
| 匿名サインイン | オフ（既定） | `authenticated` ロールを匿名利用者が持つと Storage のポリシー（3.3 章）が広がる |
| MFA | R2 では使わない | 本人 1 人。必要になったら Q7 |

---

## 3. DB のロールと権限（NF-SEC-03、Web 画面設計 12 章）

### 3.1 現状と方針

- R1 の 5 本のマイグレーションで、すべてのテーブルに RLS が有効（ポリシーなし）。ビューは `security_invoker`。`anon`／`authenticated` には何も許可していない。ワーカーと Web はどちらも `postgres` ロールで直結している（所有者なので RLS の対象外）。
- R2 では **Web 用のロール `web_app`** を作り、Vercel にはこのロールの接続文字列だけを置く。漏れたときの影響を「読み出しと接続情報の更新」に限る。
- ワーカーは `postgres` のまま（GitHub Secrets）。ワーカーは全テーブルの書き込みと Vault の復号が要るので、専用ロールを作っても `postgres` と権限がほぼ変わらない。
- `anon`／`authenticated` には引き続きテーブルの権限を与えない（ブラウザから DB を読まない方針は維持）。例外は Storage の `thumbnails` バケットの `select`（3.3 章）。

### 3.2 マイグレーション `20261002xxxxxx_r2_web_role.sql` の骨子

```sql
-- Web 用ロール。パスワードは付けない（リポジトリに書けない）。適用後にダッシュボードの SQL エディタで
--   alter role web_app with password '<強いパスワード>';
-- を手で実行する（README）。パスワードは scram-sha-256 で保存される
create role web_app login nosuperuser nocreatedb nocreaterole noinherit;

grant usage on schema public, private to web_app;
grant select on all tables in schema public to web_app;          -- security_invoker のビューが基のテーブルを読むため
alter default privileges in schema public grant select on tables to web_app;
grant select, insert, update on public.accounts to web_app;
grant select, insert, update on private.credentials to web_app;
grant execute on function public.metric_value(jsonb, text) to web_app;   -- ビューが使う関数（実際の引数は r1_views.sql に合わせる）

-- Vault: 書けるが読めない
grant usage on schema vault to web_app;
grant execute on function vault.create_secret(text, text, text, uuid) to web_app;
grant execute on function vault.update_secret(uuid, text, text, text, uuid) to web_app;
-- vault.secrets と vault.decrypted_secrets の select は与えない（復号はワーカーだけ）

-- RLS ポリシー（単一利用者なので行の条件は true。ロールで絞る）
create policy web_app_select on public.accounts for select to web_app using (true);
create policy web_app_write  on public.accounts for insert to web_app with check (true);
create policy web_app_update on public.accounts for update to web_app using (true) with check (true);
-- private.credentials に同じ 3 本
-- 残りの public テーブル（profile_daily、account_daily_metrics、media、media_insight_snapshots、job_runs、
-- job_state、raw_api_responses、video_analyses、video_cuts、metric_definitions）に select のポリシー 1 本ずつ
```

- `vault.create_secret`／`update_secret` の正確なシグネチャと、Supabase Cloud の `postgres` ロールが `web_app` に `execute` を与えられるか（関数の所有者が `supabase_admin` の可能性）は **実機で確認**し、与えられなければ Web の接続処理を「`private.credentials` だけ更新し、Vault への書き込みは `security definer` の関数 `private.store_token(…)` 経由」に変える（関数は `private` スキーマに置き、`web_app` だけに `execute`。Supabase スキルの注意どおり `public` には置かない）。
- `web_app` はテーブルの所有者ではないので、RLS が効く。`using (true)` でも「`web_app` という役割に限って全行」という意味になり、`anon`／`authenticated` には影響しない。
- `job_runs.error` は固定文言（R1 設計 8.1 章）なので Web が読んでよい。`raw_api_responses` は画面で使わないが、`media_analysis_dataset` などのビューが参照しないことを確かめたうえで `select` を外してもよい（Q8）。

### 3.3 Storage の権限

| 操作 | R1 | R2 |
|---|---|---|
| サムネイルのアップロード（ワーカー） | サービスロールキーで Storage API | 同じ。鍵は GitHub Secrets（5 章）。S3 互換のアクセスキーは「全バケットの全操作、RLS 無視」で影響範囲が Storage に限られる利点はあるが、ワーカーに S3 署名の実装か `@aws-sdk/client-s3` の追加が要る。R2 では採らず申し送り（12 章） |
| 署名付き URL（Web） | サービスロールキー | **ログインした利用者のセッション**で作る。`storage.objects` に `authenticated` の `select` ポリシー（`bucket_id = 'thumbnails'`）を足せば、`@supabase/ssr` のサーバークライアント（利用者の JWT）で `createSignedUrl` が通る。これで Vercel からサービスロールキーをなくせる |

```sql
create policy thumbnails_read on storage.objects for select to authenticated
  using (bucket_id = 'thumbnails');
```

バケットは非公開のまま。`insert`／`update`／`delete` のポリシーは作らない（ワーカーはサービスロールで書く）。

---

## 4. Web（Vercel）

### 4.1 デプロイ

| 項目 | 内容 |
|---|---|
| プラン | Hobby（個人の非商用。要件 2.3 章） |
| Git 連携 | リポジトリの `main` を本番にデプロイ。**プレビューのデプロイは作らない**（Settings → Git の Ignored Build Step で `VERCEL_ENV != production` のとき `exit 0`。Host 検査（4.3 章）があるのでプレビュー URL では 403 になるだけだが、ビルドの無駄を省く） |
| Root Directory | `apps/web`（設定済み）。npm workspaces の `package-lock.json` はルートにあり、Vercel は monorepo を自動で検出する見込み（初回デプロイで確認。13 章 V3） |
| Node | 24（`apps/web/package.json` の `engines` で固定する） |
| 関数の実行時間 | Hobby の既定は 10 秒（13 章 V1）。画面は DB を 1〜3 回読むだけで足りる。接続（コールバック）は Meta を 4〜5 回呼ぶので 10 秒を超える恐れがある → `export const maxDuration = 60` を `api/meta/callback/route.ts` に付ける（Hobby の上限 60 秒。13 章 V1） |
| ログ | ランタイムログは 1 時間保持、プロジェクトのメンバーだけが見られる。ログの詳細に「Search Params」が出るので、コールバックの `code` は 1 時間だけ Vercel のログに残る（13 章 V2）。`code` は使い捨てで数秒以内に交換するので受け入れる。`state` も同様 |

### 4.2 環境変数（Production のみ）

| 変数 | 置き場 | 内容 |
|---|---|---|
| `DATABASE_URL` | Vercel（Sensitive） | トランザクションモード、`web_app` ロール |
| `DATABASE_POOL_MODE` | Vercel | `transaction`（`prepare: false` にする） |
| `DATABASE_SSL_CA` | Vercel | CA 証明書の PEM |
| `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel | ログインと署名付き URL に使う。ブラウザに出てよい値 |
| `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` | **置かない** | 3.3 章により不要。R0 の接続状態表示（トップ下部）は R2 で消す（Web 画面設計 Q2） |
| `META_APP_ID`、`META_APP_SECRET`（Sensitive）、`META_GRAPH_API_VERSION` | Vercel | 接続とトークン確認 |
| `APP_URL` | Vercel | `https://<app>.vercel.app` |
| `WEB_ALLOWED_USER_ID` | Vercel | ログインを許す Supabase Auth の利用者 `id`（4.3 章） |
| `META_TARGET_IG_USER_ID` | 任意 | R1 と同じ |

ローカルの `apps/web/.env.local` にも `NEXT_PUBLIC_SUPABASE_*` はすでにあり、ローカルの Supabase Auth で同じログインを試せる（`supabase/config.toml` の `[auth] enable_signup` はローカルでは `true` のままでよい。本番はダッシュボードで切る）。

### 4.3 ログイン（F-SYS-13、NF-SEC-02）

依存の追加（Q2）: `@supabase/supabase-js` と `@supabase/ssr`（版を固定し `package-lock.json` をコミット）。

| 層 | 内容 |
|---|---|
| `src/lib/supabase/server.ts` | `createServerClient(url, publishableKey, { cookies: { getAll, setAll } })`。Server Component、Server Action、Route Handler から使う |
| `src/proxy.ts` | 1) Host 検査（R1 のまま）→ 2) `createServerClient` でセッションを更新し `getClaims()` → 3) 未ログインで保護対象なら `/login` へ 303 → 4) `setAll` が最後に作った `supabaseResponse` を返す（別のレスポンスを返すと更新済み Cookie が落ちて次の要求でログアウトする。13 章 S6）。`getSession()` はサーバーで信用しない |
| 保護対象 | `/login`、`/api/health`（Q4 の案 B のときだけ）、`_next/static`、`favicon.ico` 以外のすべて。`/api/meta/callback` も保護対象（Meta からトップレベル GET で戻るとき、同じサイトなので Cookie が付く。未ログインなら登録せず `/login` へ） |
| 本人の確認 | `getClaims()` の `sub` が `WEB_ALLOWED_USER_ID` と一致しなければ 403（サインアップ無効化の設定が誤って戻った場合の二重の守り。`user_metadata` は使わない） |
| Route Handler | `/api/meta/login`（POST）と `/api/meta/callback`（GET）は proxy を通るが、Route Handler の中でも `getClaims()` と `sub` を再確認する（proxy の matcher の漏れに備える） |
| `/login` | Server Component のフォーム（メール、パスワード）＋ Server Action で `signInWithPassword`。失敗は固定文言。成功で `/` へ |
| ログアウト | ヘッダのフォーム（POST の Server Action で `signOut`）→ `/login` |
| Cookie | Supabase の認証 Cookie は `@supabase/ssr` の既定（`secure` は https で自動）。OAuth の `state` Cookie は `__Host-meta_oauth_state`（`secure`、`path=/`、`SameSite=Lax`）に変える。`__Host-` は `path=/` が条件なので R1 の `path=/api/meta` は捨てる。ローカル（http）では `__Host-` が付かないため、名前を `APP_URL` が https のときだけ切り替える |
| CSRF | R1 の `Sec-Fetch-Site`／`Origin` 検査は残す。Server Action は Next.js が Origin を検査する |

### 4.4 Meta アプリ側

- 「有効な OAuth リダイレクト URI」に `https://<app>.vercel.app/api/meta/callback` を追加（本番は開発モードの `localhost` 例外が効かない）。
- アプリは開発モードのまま（利用者は本人だけ。公開は要らない）。
- `appsecret_proof`（Q6）を使う場合は、アプリ設定の「App Secret が必要」をオンにする前に、ワーカーと Web の両方の実装を本番に出す。

---

## 5. 収集ワーカー（GitHub Actions）

### 5.1 ワークフロー

| ファイル | トリガー | 実行 | `timeout-minutes` |
|---|---|---|---|
| `.github/workflows/collect-hourly.yml` | `schedule: '17 * * * *'`、`workflow_dispatch` | `run-hourly` → `check-alerts` → 死活監視へ ping | 30 |
| `.github/workflows/collect-daily.yml` | `schedule: '33 20 * * *'`（JST 05:33）、`workflow_dispatch` | `run-daily` → `check-alerts` → keepalive | 30 |

- `schedule` は UTC。毎時 0 分は GitHub 全体の混雑でキューが遅れ、混みすぎると**落とされる**ことがある（13 章 G1）。R1 の「5 分」ではなく 17 分にずらす。遅延は要件 5.2 章の方式（取得時刻から経過時間を計算）で吸収する。
- トリガーは `schedule` と `workflow_dispatch` だけ（`pull_request` など他人が起こせるものを付けない。R1 設計 12 章）。スケジュールは既定ブランチ（`main`）のファイルだけが動く。
- `concurrency: { group: instagram-analyze-collect, cancel-in-progress: false }` を両方に付ける。同じグループ名はリポジトリ全体で効くので hourly と daily が重ならない。加えてジョブのアドバイザリロックで二重実行は `skipped` になる（R1 設計 6.2 章）。
- `permissions: { contents: read }` を既定にし、keepalive のジョブだけ `actions: write`。
- ジョブは 1 つ、ステップは次のとおり。Docker は使わない（イメージのビルドに毎回 2〜3 分かかる。GHCR に公開する案は別のワークフローと権限が増える）。

```yaml
runs-on: ubuntu-latest
steps:
  - uses: actions/checkout@<sha>            # アクションはタグでなくコミット SHA で固定する
  - uses: actions/setup-node@<sha>
    with: { node-version: 24, cache: npm }
  - run: npm ci --workspace worker --ignore-scripts
  - run: npm run build --workspace worker
  - run: sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg   # ランナーに ffmpeg はない前提（初回に確認）
  - run: node apps/worker/dist/index.js run-hourly
    env: { DATABASE_URL: ${{ secrets.DATABASE_URL }}, DATABASE_SSL_CA: ${{ vars.DATABASE_SSL_CA }}, ... }
  - run: node apps/worker/dist/index.js check-alerts
    env: ...
  - run: curl -fsS --retry 3 "$HEALTHCHECKS_PING_URL" > /dev/null     # 成功時だけ（if: success()）。Q4
    env: { HEALTHCHECKS_PING_URL: ${{ secrets.HEALTHCHECKS_PING_URL }} }
```

- 1 回の所要は、依存の取得とビルドで 1〜2 分 ＋ 収集で 1 分前後（初回の取り込みとバックフィル中は数分）。月の合計は 24 × 30 × 3 分 ≒ 2,200 分だが、公開リポジトリの標準ランナーは無料（13 章 G4）。
- ログは誰でも読める（要件 2.3 章）。ワーカーは件数と成否しか出さず（NF-SEC-06）、GitHub は Secrets をマスクする。`WORKER_LOG_LEVEL` は `info` のまま。`npm ci` の出力に秘密は出ない。`set -x` や `env` の表示は書かない。
- `apt-get install ffmpeg` は 20〜40 秒。遅ければ `actions/cache` で deb をキャッシュする（最初は入れない）。

### 5.2 `check-alerts` コマンド（新規。F-SYS-14、NF-REL-03）

ジョブの `status` を歪めずに「人が見るべき状態」を終了コードで知らせるコマンド。`job_runs` と `private.credentials` だけを読む（R1 設計 8.2 章の表）。

| 判定 | 条件 | ログ |
|---|---|---|
| トークンの期限 | `data_access_expires_at` まで **14 日未満**（`WORKER_TOKEN_WARN_DAYS`、既定 14）、または `credential_status <> 'valid'` | `alert=token days_left=N status=…` |
| ストーリーズの連続失敗 | `stories` の直近 2 回がどちらも `failed`（NF-REL-03） | `alert=stories_failed runs=2` |
| 収集の停滞 | `job_latest_runs` で `media_snapshot` の最終 `success`／`partial` が 3 時間より前（hourly の中で見るので、前回までの失敗を拾う） | `alert=stale job=… age_h=N` |

1 つでも該当すれば終了コード 1。ワークフローのステップが失敗し、GitHub がメールで知らせる。通知の宛先は「ワークフローを最初に作った利用者」（cron を編集した人や再有効化した人に移る。13 章 G3）なので、ワークフローはユーザー本人のアカウントでコミットするか、作成後にユーザーが cron を一度編集する。GitHub の通知設定で「失敗したときだけ」にできる。

`run-hourly`／`run-daily` 自体も `failed` があれば終了コード 1（README）なので、ジョブの失敗もメールになる。失敗が 1 回で済む一時的なもの（Meta の 5xx など）はメールが増えるが、R2 ではこのまま運用して 7 日間で頻度を見る（多ければ `continue-on-error` と `check-alerts` の「2 回連続」判定に寄せる）。

### 5.3 スケジュールが止まったことの検知（NF-REL-05）

公開リポジトリでは「60 日間リポジトリに活動がない」とスケジュール実行が自動で無効になる（13 章 G1、G2）。無効になると失敗メールも出ない。2 段で備える。

| 段 | 内容 |
|---|---|
| 延命 | daily の最後のジョブで `gh api -X PUT repos/${{ github.repository }}/actions/workflows/collect-hourly.yml/enable`（と daily 自身）を呼ぶ（`GITHUB_TOKEN`、`permissions: actions: write`）。無効化の前にこの API を呼ぶと 60 日の起算が戻るとされるが、GitHub の文書は「リポジトリの活動」としか書いていない（**未確認**。13 章 G2）。確実なのはコミットで、開発が続く間は自然に満たす |
| 検知 | **外部の死活監視**（Q4）。案 A: Healthchecks.io（無料枠、メール通知）。hourly の成功時に ping URL を叩き、猶予 3 時間で未着ならメール。URL は GitHub Secrets（漏れても偽の ping ができるだけ）。案 B: cron-job.org から Vercel の `/api/health`（ログイン不要の例外。`job_latest_runs` の最終成功が 3 時間より古ければ 503、本文は `ok`/`stale` のみ）を 1 時間ごとに叩き、失敗でメール。新しい秘密は要らないが、ログイン不要の経路を 1 つ開ける |

推奨は案 A（Web に例外を作らず、GitHub 側の停止と失敗の両方を 1 つの仕組みで拾える）。

### 5.4 ワーカーのその他の変更

| 変更 | 内容 |
|---|---|
| `DATABASE_SSL_CA` | 2.2 章 |
| `appsecret_proof`（Q6） | `lib/graph.ts` の全呼び出しに `appsecret_proof = HMAC-SHA256(token, app_secret)` のクエリを付ける（Web の `meta-graph.ts` も）。アプリ設定で必須にすると、トークンが漏れても単独では使えない |
| `check-alerts` | 5.2 章。`commands/check-alerts.ts`、`index.ts` の `COMMANDS` に登録 |
| `schedule` コマンド | 変えない（ローカル用に残す） |
| `.env.example` | `DATABASE_SSL_CA`、`WORKER_TOKEN_WARN_DAYS` を追記。`DATABASE_URL` の説明に「Cloud はセッションモード」を明記（すでにある） |

---

## 6. 秘密の一覧と漏洩時の対応（NF-SEC-04）

| 秘密 | 置き場 | 漏れたときの影響 | 取り消し |
|---|---|---|---|
| DB パスワード（`postgres`） | GitHub Secrets の `DATABASE_URL`、手元の PC（`db push` 時） | DB の全読み書き（Vault の復号を含む → Meta のトークン） | ダッシュボードで DB パスワードをリセット → Secrets を更新。Meta のトークンも `/connect` で取り直す |
| `web_app` のパスワード | Vercel の `DATABASE_URL` | 全テーブルの読み出し、`accounts`／`credentials` の更新、Vault への書き込み（読めない） | `alter role web_app with password` → Vercel を更新 |
| サービスロールキー | GitHub Secrets | REST／Storage／Auth 管理の全操作（RLS 無視） | ダッシュボードでローテーション（新しい API キーなら個別に失効できる。13 章の未確認 U2） |
| `META_APP_SECRET` | GitHub Secrets、Vercel | `debug_token` の実行、アプリの偽装、`appsecret_proof` の生成 | Meta アプリの設定で再生成 → 両方を更新 |
| Supabase Auth の利用者のパスワード | 本人 | 画面の閲覧と接続操作 | ダッシュボードでパスワード変更、セッション失効 |
| Healthchecks の ping URL（案 A） | GitHub Secrets | 偽の ping で停止を隠せる | Healthchecks で URL を再生成 |
| Vercel の環境変数 | Vercel | 上記の `web_app`、`META_APP_SECRET` | Vercel のアクセスを見直し、各値をローテーション |

秘密でないもの（GitHub Variables、Vercel の通常の環境変数）: `DATABASE_SSL_CA`、`SUPABASE_URL`、`META_APP_ID`、`META_GRAPH_API_VERSION`、`APP_URL`、`WEB_ALLOWED_USER_ID`、`NEXT_PUBLIC_*`。

GitHub Secrets は 4 つ（`DATABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`META_APP_SECRET`、`HEALTHCHECKS_PING_URL`）＋ Variables。R1 の申し送りの「4 つ」から `META_APP_ID` を Variables に移し、ping URL を足した形。`META_ACCESS_TOKEN` は置かない（Vault にある）。

---

## 7. ローカルからの移行と切り替え（F-SYS-15）

順序を守る（二重収集と取りこぼしを避ける）。

| # | 手順 | 備考 |
|---|---|---|
| 1 | 2 章の Supabase の設定（Auth、SSL、利用者の作成）。`supabase link` → `db push`（R1 の 5 本 ＋ R2 の 1 本）。`alter role web_app with password` | DB は空 |
| 2 | Vercel に環境変数を入れて `main` をデプロイ。ブラウザで `/login` → ログイン → 3 画面が「データなし」で出る。未ログインで `/` が `/login` に飛ぶことを確認 | ログイン前に本番の秘密を Vercel に入れない（progress.md 5 章） |
| 3 | ローカルの常駐を止める: `npm run worker:down` | ここから本番の収集開始までの時間帯の 1 時間ごとのデータは欠ける（数時間なら受け入れる。深夜に行う） |
| 4 | データ移行: ローカルの DB から `public` のデータを `pg_dump --data-only --inserts --on-conflict-do-nothing` で出し（`metric_definitions` はマイグレーションで入るので除く。`accounts` → `profile_daily` … の順は `--inserts` なら pg_dump が依存順に出す）、セッションモードの接続で `psql` に流す | Vault と `private.credentials` は移さない（Vault は鍵がプロジェクトごとで復号できない）。`job_state`（バックフィルの進み）は移す |
| 5 | サムネイルの移行: `rclone` か AWS CLI で、ローカル Storage の S3 互換エンドポイント（`supabase status` の S3 キー）から Cloud の S3 互換エンドポイント（ダッシュボードで生成した S3 キー）へ `thumbnails` バケットをコピー。`storage.objects` の行は Storage がコピー時に作る | 失敗しても画面の画像が欠けるだけ。R3 で再取得の手段を作る |
| 6 | 本番の `/connect` で Meta に接続（トークンを Vault に登録） | `accounts` の行は 4 で入っているので `ig_user_id` で一致して更新になる |
| 7 | GitHub Secrets／Variables を登録。`workflow_dispatch` で `collect-daily` → `collect-hourly` を 1 回ずつ手動実行し、`job_runs` と画面で確認 | 初回は `media_sync --full` が全件を読む |
| 8 | スケジュールを待つ（翌時の 17 分）。Healthchecks の ping が届くことを確認 | 7 日間の確認（10 章）を開始 |

ローカルの開発環境はそのまま（`npm run db:start`、`npm run dev:web`）。ローカルの DB はテスト用になり、`.env` の `DATABASE_URL` はローカルのまま。**本番の接続文字列をローカルの `.env` に書かない**（compose の常駐が本番に向くと二重収集になる）。本番に手で SQL を流すときは `psql "<セッションモードの URL>"` を都度指定する。

---

## 8. 容量とコスト（NF-CAP-01〜03）

| 項目 | 見込み | 根拠 |
|---|---|---|
| DB | R1 実測: 1 日目で `raw_api_responses` 808 件 1.6 MB（バックフィル中は 1 時間 125 件）。バックフィル完了後は 1 日 30 件程度 → 年 20 MB 前後。全体で年 50 MB 未満 | 500 MB の 1 割。生レスポンスの削除は R3 以降（12 章） |
| Storage | サムネイル 1 枚 数十 KB × 投稿数 | 1 GB に対し 1 万枚でも余裕 |
| Egress | 画面の閲覧とサムネイルの配信 | 5 GB／月に対し本人 1 人 |
| GitHub Actions | 月 2,200 分前後 | 公開リポジトリは無料（13 章 G4） |
| Vercel | 本人の閲覧のみ | Hobby の範囲 |

---

## 9. 実装の分割（同じ作業ツリーでファイルを分担）

| 段階 | 内容 | 担当エージェント | 触るファイル |
|---|---|---|---|
| A: DB | 3 章のマイグレーション 1 本、ローカルでの適用と結合テスト（`web_app` で接続してビューが読める、`anon` は読めない、`authenticated` は `thumbnails` の `select` だけ） | `postgres-sql-reviewer`（設計とレビュー）、実装は親 | `supabase/migrations/20261002*_r2_web_role.sql`、`apps/web/test/db/*`（結合テスト） |
| B: ワーカー | `DATABASE_SSL_CA`、`check-alerts`、`appsecret_proof`（Q6）、ワークフロー 2 本、`.env.example` | `node-worker-developer` | `apps/worker/src/{config.ts,db/client.ts,lib/graph.ts,commands/check-alerts.ts,index.ts}`、`apps/worker/test/*`、`.github/workflows/*`、`.env.example` |
| C: Web | ログイン、proxy、Route Handler の確認、`__Host-` Cookie、署名付き URL をセッションで、R0 の接続状態表示の削除、`DATABASE_POOL_MODE`／`DATABASE_SSL_CA`、`maxDuration`、`engines` | `nextjs-developer` | `apps/web/src/{proxy.ts,lib/env.ts,lib/db.ts,lib/storage.ts,lib/supabase/*,lib/meta-oauth.ts,lib/meta-graph.ts,app/login/*,app/layout.tsx,app/page.tsx,app/api/meta/*}`、`apps/web/test/*`、`apps/web/.env.example`、`apps/web/package.json` |
| D: 運用 | README（Cloud の設定、Secrets、移行、切り替え、7 日間の確認）、`doc/progress.md` | `technical-writer` または親 | `README.md`、`doc/progress.md` |

B と C は並列にできる（触るファイルが重ならない）。A は B・C の結合テストの前提なので先に行う。D は最後。レビューは各段階で `security-engineer` と `quality-engineer` を並列に当てる。

---

## 10. テストと 7 日間の実機確認

### 10.1 単体・結合（ローカル）

- ワーカー: `check-alerts` の判定（期限 13 日／14 日／15 日、`stories` の `failed, failed`／`failed, success`、停滞 2 時間 59 分／3 時間 1 分）、`ssl` オプションの組み立て（`DATABASE_SSL_CA` あり／なし）、`appsecret_proof` の値（既知のベクトル）。
- Web: proxy の分岐（未ログイン → `/login`、`sub` 不一致 → 403、ログイン済み → 通過、`/login` と静的資産は素通し）、Cookie 名の切り替え（http／https）、`maxDuration` の export、`DATABASE_POOL_MODE=transaction` で `prepare: false`。
- DB（結合）: 3 章の権限（段階 A）。

### 10.2 7 日間の実機確認（R2 の完了条件）

| 項目 | 確かめ方 |
|---|---|
| 7 日間、人手なしで収集が続く | `select date_trunc('hour', started_at), count(*) from job_runs where job_name = 'media_snapshot' and started_at > now() - interval '7 days' group by 1` が 168 行（欠けがあれば GitHub の遅延か落ちか、Actions の履歴と突き合わせる）。daily は 7 行。`running` の残りなし。`skipped`（ロック）は 0 |
| 遅延の分布 | `extract(minute from started_at)` の分布。17 分からの遅れが常態的に 10 分を超えるなら分をずらす |
| ログイン必須 | 未ログインで `/`、`/jobs`、`/media`、`/connect` が `/login` へ。`POST /api/meta/login` が 303（`/login`）。`GET /api/meta/callback?code=x&state=y` も登録せず `/login` へ |
| 本人以外 | 別の利用者を一時的に作ってログイン → 403 → 削除 |
| 通知 | （a）`workflow_dispatch` の入力 `simulate_alert=true` で `check-alerts` を強制失敗させ、メールが届く。（b）hourly を手で無効化して 3 時間後に Healthchecks のメールが届く → 再有効化。（c）Supabase の一時停止の警告メールが来ない（C3） |
| ログの公開範囲 | Actions のログを未ログインのブラウザで開き、トークン、`://`、10 桁以上の数字列、ユーザー名がないことを `grep` で確認（NF-SEC-06） |
| TLS | ワーカーのログに接続エラーがない。`DATABASE_SSL_CA` を壊した値にして `workflow_dispatch` → 証明書エラーで失敗する（検証が効いている証拠）→ 戻す |
| Vercel のログ | コールバックの行に `Search Params` が出ることを確認し、1 時間で消えることを見る |
| 画面 | 3 画面が本番データで出る。サムネイルがセッションの署名付き URL で表示される |

---

## 11. 確認事項（ユーザーに決めてもらうこと）

| No | 内容 | 推奨 | 備考 |
|---|---|---|---|
| Q1 | Supabase のリージョン | 東京（`ap-northeast-1`） | 作成済みなら変更不可。どこで作ったかを教えてほしい |
| Q2 | 依存パッケージの追加: `@supabase/supabase-js`、`@supabase/ssr`（Web） | 追加する | ログインに必須。版を固定 |
| Q3 | ログインの方式 | メール＋パスワード | マジックリンクは組み込み SMTP の送信上限が小さく、毎回のログインに向かない。パスワードはダッシュボードで設定 |
| Q4 | 死活監視 | 案 A: Healthchecks.io（アカウント作成が要る） | 案 B: cron-job.org ＋ `/api/health` |
| Q5 | ワーカーの実行環境 | Docker を使わず、ランナーに ffmpeg を入れて Node で直接実行 | 代替: 毎回 Docker ビルド、GHCR の公開イメージ |
| Q6 | `appsecret_proof` を R2 で入れるか | 入れる（ワーカーと Web の両方。アプリ設定の必須化は両方のデプロイ後） | 後回しにもできる |
| Q7 | Supabase Auth の MFA | R2 では使わない | 必要なら TOTP を後で足せる |
| Q8 | `web_app` に `raw_api_responses` の `select` を与えるか | 与えない（画面で使わない。ビューの依存を確認してから） | 与えないと将来の生データ閲覧画面で変更が要る |

---

## 12. R3 への申し送り

- 生レスポンスの保存期間（NF-CAP-02）: 実測を 7 日間で取り、180 日より古い行を消す daily のステップを R3 で足す。
- Storage のアップロード鍵の限定（S3 互換キー）と新しい API キー（`sb_secret_…`）への切り替え。
- 接続解除の画面（`accounts` とサムネイルの削除）。
- 画面の作り直し（R2.5 のデザイン）時に、`/login` の見た目も合わせる。
- 一時的な失敗（Meta の 5xx）でメールが増えるなら、`continue-on-error` と「2 回連続」の判定に寄せる。
- GitHub の 60 日の無効化対策（API 呼び出しで起算が戻るか）の結果を記録する。

---

## 13. 事実の確認（確認日 2026-10-02）

| ID | 事実 | 出典 |
|---|---|---|
| S1 | 直接接続は IPv6（IPv4 アドオンは有料プランのみ）。共有プーラー（Supavisor）はすべてのプランで IPv4。セッションモードは `:5432`、トランザクションモードは `:6543`、ユーザー名は `postgres.<project-ref>`。トランザクションモードはプリペアドステートメント不可。IPv4 のみの環境として Vercel と GitHub Actions が名指しされている | https://supabase.com/docs/guides/database/connecting-to-postgres 、 https://supabase.com/docs/guides/platform/ipv4-address |
| S2 | SSL 強制はダッシュボードの Database Settings で設定し、DB が短時間再起動する。`verify-full` には Supabase の CA 証明書（`prod-ca-2021.crt`）をダウンロードして使う | https://supabase.com/docs/guides/platform/ssl-enforcement |
| S3 | Free プランは 7 日間の DB 活動が少ないと一時停止。「1 日に数回の要求」で足りる。約 1 週間前に警告メール。90 日以内に復元可 | https://supabase.com/docs/guides/platform/free-project-pausing |
| S4 | Free: DB 500 MB、Storage 1 GB、egress 5 GB、アクティブなプロジェクト 2 つ、プーラー接続 200（Micro） | https://supabase.com/pricing |
| S5 | 「Allow new users to sign up」をオフにすると既存の利用者だけがサインインできる | https://supabase.com/docs/guides/auth/general-configuration |
| S6 | `@supabase/ssr` のサーバークライアントは `cookies.getAll/setAll`。Next.js 16 は `proxy.ts` でセッションを更新し `getClaims()` を使う。`setAll` が最後に作ったレスポンスを返す。`getSession()` はサーバーで信用しない | https://supabase.com/docs/guides/auth/server-side/nextjs |
| S7 | S3 互換のアクセスキーは全バケットの全操作で RLS を無視。サーバー専用。エンドポイントは `https://<project-ref>.storage.supabase.co/storage/v1/s3` | https://supabase.com/docs/guides/storage/s3/authentication |
| S8 | Vault の復号ビューへのアクセスは SQL の権限で守る。どのロールに与えるかを慎重に決める | https://supabase.com/docs/guides/database/vault |
| G1 | `schedule` は UTC。混雑時（毎時の始め）は遅れ、混みすぎるとキューから落ちる。最短 5 分間隔。既定ブランチのファイルだけ動く。公開リポジトリは 60 日間活動がないと自動で無効 | https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows |
| G2 | 再有効化は UI、`gh workflow enable`、REST `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable`（PAT は `repo` スコープ。`GITHUB_TOKEN` で呼べるかは文書に明記なし） | https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow 、 https://docs.github.com/en/rest/actions/workflows |
| G3 | スケジュール実行の通知は「ワークフローを最初に作った利用者」に届く。cron を編集した人、再有効化した人に移る。失敗時だけに設定できる | https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/notifications-for-workflow-runs |
| G4 | 公開リポジトリの標準ランナーは無料。ジョブは最長 6 時間。Free の同時ジョブ 20 | https://docs.github.com/en/actions/administering-github-actions/usage-limits-billing-and-administration 、 https://docs.github.com/en/actions/reference/limits |
| V1 | Hobby の関数の実行時間は既定 10 秒、上限 60 秒（表の読み取り。Fluid compute の有無で変わる可能性があるため初回デプロイで確認）。ビルド 45 分、同時ビルド 1 | https://vercel.com/docs/limits |
| V2 | ランタイムログの保持は Hobby で 1 時間。ログの詳細に Request Path と Search Params が出る。閲覧はプロジェクトのメンバー | https://vercel.com/docs/logs/runtime |
| V3 | Hobby は組織所有の Git リポジトリに接続できない（個人所有は可） | https://vercel.com/docs/limits |
| N1 | Next.js 16 の `proxy.ts` は Node.js ランタイム。`runtime` の指定は不可 | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` |

未確認（実機で確かめる）: U1 `web_app` ロールでプーラーに接続できるか（Supavisor の認証）。U2 新しい API キー（`sb_secret_…`）を Storage のアップロードに使えるか。U3 GitHub-hosted ランナーに ffmpeg が入っているか（なければ apt）。U4 `GITHUB_TOKEN` の `actions: write` で enable API が通るか、通ったとして 60 日の起算が戻るか。U5 Vercel が Root Directory `apps/web` で npm workspaces のルートの lockfile を使ってビルドできるか。U6 Supabase Cloud の `postgres` ロールが `vault.create_secret` の `execute` を `web_app` に与えられるか。

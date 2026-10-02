# R2: クラウド稼働の設計

| 項目 | 内容 |
|---|---|
| 版 | 0.2 |
| 作成日 | 2026-10-02 |
| 更新履歴 | 0.1 初版案。0.2 セキュリティ・運用（CI）・DB 権限・テスト計画の 4 本のレビュー（計 74 件）を反映: ワークフローを 1 本に統合、`check-alerts` の仕様を純関数と scope で確定、トークン警告は daily のみ、keepalive を別ジョブ化し Variable で止められるように、Variables に置くのは公開されてよい値だけ、`web_app` の権限を列挙に変更し Vault は `private.store_token` 経由、`anon`／`authenticated` の既定権限の取り消し、TLS をフェイルクローズに、Cookie 属性、`WEB_ALLOWED_USER_ID` 未設定は 403、ローカルの `web_app` の検証方法、移行の準備と後始末とロールバック、7 日間の確認の SQL と起点、確認事項の追加 |
| 対象 | 要件定義 4.3 章（F-SYS-10〜15）、6.3 章、8.1〜8.3 章、10 章（R2 の完了条件）、11.1 章の C3 |
| 入力 | `doc/requirements/requirements-definition.md`（版 0.4）、`doc/design/r1-db-design.md`（7 章、7.1 章）、`doc/design/r1-collection-jobs.md`（6.2 章、8.1 章、8.2 章、12 章）、`doc/design/r1-web-screens.md`（1.2 章、2.2 章、3 章、12 章）、`supabase/migrations/`（5 本）、`apps/worker/src/`、`apps/web/src/`、`docker-compose.yml`、`apps/worker/Dockerfile`、Supabase・GitHub・Vercel の文書とローカル DB での確認（13 章） |
| 範囲外 | 画面の見た目（R2.5、R3）、接続解除の画面（R3。R1 は README の SQL）、生レスポンスの削除ジョブ（12 章）、R4 以降の動画解析のクラウド化（実行環境は共通。ジョブを足すだけ） |
| 状態 | レビュー反映済み。11 章の Q1〜Q11 は回答済み（2026-10-02）。段階 A から実装中 |

---

## 0. 前提

- R2 の完了条件は「クラウドで 7 日間、人手を介さず収集が続く。ログインしないと画面を見られない。収集停止の通知が届くことを確認した」（要件 10 章）。
- R1 の収集ワーカー（7 ジョブ、`run-hourly`／`run-daily`）、最小限の画面 3 つ、Facebook Login の接続は実装・実機確認済み。R2 ではこれらを **作り直さず**、接続先と実行環境を差し替え、ログインと通知を足す。
- Supabase Cloud と Vercel のプロジェクトはユーザーが作成済み（2026-10-02。Vercel の Root Directory は `apps/web`）。本番の URL、プロジェクトの ref、鍵はリポジトリに書かない（NF-SEC-07）。この文書ではプレースホルダ（`<project-ref>`、`<region>`、`https://<app>.vercel.app`）を使う。
- GitHub のリポジトリは個人アカウントの所有（Vercel Hobby は組織所有のリポジトリに接続できない。13 章 V3）。GitHub、Vercel、Supabase、Meta 開発者の 4 アカウントは 2 要素認証を有効にする（これらのアカウントが全権を握る。6 章）。
- ローカル環境（Supabase CLI と `docker-compose.yml` の常駐ワーカー）は開発用に残す。切り替え後はローカルのワーカーを常駐させない（二重収集を避ける）。
- インフラの月額は 0 円（NF-CAP-01）。Supabase Free、Vercel Hobby、GitHub Actions（公開リポジトリ）の範囲で設計する。

---

## 1. 全体構成

```text
                 ┌────────────────────────────────┐
  ブラウザ ─────→│ Vercel（Hobby）                 │
  （本人のみ）    │  Next.js 16: 画面、/api/meta/*  │──── Meta Graph API（Facebook Login、debug_token）
                 │  proxy.ts: Host 検査 + ログイン │
                 └──────────┬─────────────────────┘
                            │ プーラー トランザクションモード（6543、web_app、TLS verify-full）
                            ▼
                 ┌────────────────────────────────┐
                 │ Supabase Cloud（Free）           │
                 │  Postgres 17 / Auth / Storage   │
                 └──────────▲─────────────────────┘
                            │ プーラー セッションモード（5432、postgres、TLS verify-full）
                 ┌──────────┴─────────────────────┐
                 │ GitHub Actions（公開リポジトリ）  │──── Meta Graph API（収集）
                 │  collect.yml（毎時 17 分。      │──── 死活監視（Healthchecks.io。Q4）
                 │   JST 05:17 の回は daily も）    │
                 └────────────────────────────────┘
```

| 構成要素 | R1（ローカル） | R2（クラウド） |
|---|---|---|
| DB、Auth、Storage | Supabase CLI（Docker） | Supabase Cloud の Free プロジェクト（Q1） |
| 画面 | `next dev -H 127.0.0.1` | Vercel Hobby。本番デプロイのみ |
| 収集ワーカー | compose の常駐コンテナ（`schedule`） | GitHub Actions の `schedule`。1 本のワークフローで `run-hourly` を毎時、JST 05:17 の回だけ `run-daily` → `run-hourly` |
| ログイン | なし（ループバックのみ） | Supabase Auth（メール＋パスワード、利用者 1 人） |
| 通知 | なし | GitHub Actions の失敗メール（ジョブの失敗と `check-alerts`）＋ 死活監視の未着メール（スケジュールの停止） |

---

## 2. Supabase Cloud

### 2.1 プロジェクトと接続経路

Supabase の文書（13 章 S1）は GitHub Actions と Vercel を「IPv4 のみの環境」として名指ししている。直接接続（`db.<project-ref>.supabase.co:5432`）は IPv6 なので、どちらからも **共有プーラー（Supavisor）** を使う。

| 用途 | 接続 | 理由 |
|---|---|---|
| ワーカー（GitHub Actions） | セッションモード `aws-<n>-<region>.pooler.supabase.com:5432`、ユーザー `postgres.<project-ref>` | `db/client.ts` が `reserve()` で 1 本を固定してアドバイザリロックを張る（R1 設計 6.2 章）。セッションの意味が要る |
| Web（Vercel） | トランザクションモード 同ホスト `:6543`、ユーザー `web_app.<project-ref>` | サーバーレスは接続が短命。**プリペアドステートメント不可**なので `prepare: false`（13 章 S1） |
| マイグレーション、データ移行（手元の PC） | セッションモード `:5432`、ユーザー `postgres.<project-ref>` | `supabase db push`、`psql`、`pg_dump` の流し込み |

接続文字列はダッシュボードの「Connect」から取る。無料プランのプーラー接続数は 200（13 章 S4）。ワーカー `max: 2`、Web `max: 3`（関数インスタンスごと）で足りる。

### 2.2 TLS（フェイルクローズ）

- 両方とも `sslmode=verify-full` 相当。Supabase の CA 証明書（`prod-ca-2021.crt`。ダッシュボードの Database Settings → SSL Configuration。13 章 S2）を環境変数 **`DATABASE_SSL_CA`**（PEM の本文）で渡す。GitHub では Variables、Vercel では通常の環境変数（公開されても無害。6 章）。
- postgres.js には `ssl: { ca: [pem], rejectUnauthorized: true }` を **常に自分で組み立てて**渡し、`DATABASE_URL` の `?sslmode=` は無視する（postgres.js は `sslmode=require` を「検証なし」と解釈するため。10.1 章でテスト）。Node の TLS は `rejectUnauthorized: true` でホスト名も検証するので `verify-full` と同等。
- **フェイルクローズ**: `DATABASE_URL` のホストが `127.0.0.1`、`localhost`、`host.docker.internal` 以外のとき `DATABASE_SSL_CA` が未設定なら起動時に `ConfigError` で止める（ワーカー `config.ts`、Web `env.ts`）。ローカルだけが平文。
- PEM は複数行。環境変数の入力経路で改行が `\n` のリテラルになることがあるので、読み込み時に `\\n` → 改行に正規化し、`-----BEGIN CERTIFICATE-----` で始まることを検査する（値はエラーに出さない）。崩れる場合は base64 で渡す方式に切り替える（初回に `wc -l` 相当の行数検査で確かめる。値は出さない）。
- ダッシュボードの「Enforce SSL on incoming connections」を **オン**にする（平文を拒否。設定時に DB が短時間再起動。13 章 S2）。
- 未確認 U7: プーラーの証明書チェーンが `prod-ca-2021.crt` に連なるか（連ならなければ接続が失敗して分かる。フェイルクローズ）。

変更箇所: `apps/worker/src/config.ts`、`apps/worker/src/db/client.ts`、`apps/worker/src/db/errors.ts`（証明書エラーの分類を `normalizeDbError` に追加。ホスト名を含まない固定文言）、`apps/web/src/lib/env.ts`、`apps/web/src/lib/db.ts`（`DATABASE_POOL_MODE=transaction` で `prepare: false`。値は `session`／`transaction` のみ。既定 `session`）、`apps/web/src/lib/db-errors.ts`。

### 2.3 一時停止の対策（C3）

Free プランは「過去 7 日間に十分な利用者の DB 活動がない」プロジェクトを一時停止する。文書は「1 日に数回の要求で足りる」「約 1 週間前に警告メール」とする（13 章 S3）。ワーカーは毎時 DB を読み書きするので満たす見込み（判定はプーラー経由の `postgres` の接続とクエリも含む。13 章 P8）。ただし GitHub の 60 日の無効化（5.4 章）で収集が止まると DB 活動も止まり一時停止に連鎖する。5.4 章の keepalive は C3 の前提でもある。7 日間の確認で警告メールが来ないことを確かめ、C3 を閉じる。

### 2.4 マイグレーションの適用

```bash
npx supabase link --project-ref <project-ref>    # supabase/.temp/ に保存（Git 管理外。確認済み）
npx supabase db push                              # supabase/migrations/ を順に適用。db pull と --yes は使わない（CLAUDE.md）
npx supabase migration list
npx supabase logout                               # 作業が終わったら（ブラウザの流れで作るトークンはフルアクセス）
```

- `supabase login` は CI で使わない（ローカルの PC からだけ適用する）。`db push` の DB パスワードは対話入力（`SUPABASE_DB_PASSWORD` を使うならシェルの履歴に残さない）。
- 新しいマイグレーション（3 章）はローカルで `supabase db reset` → 結合テストを通してから push する。

### 2.5 Auth の設定（ダッシュボード）

| 設定 | 値 | 理由 |
|---|---|---|
| Allow new users to sign up | **オフ** | 利用者は本人だけ（NF-SEC-02）。オフにすると既存の利用者だけがサインインできる（13 章 S5） |
| 利用者の作成 | Authentication → Users で 1 人作る（メール確認済み。パスワードは 8 文字以上。Q3） | メール送信を使わない。利用者の `id`（uuid）を Vercel の `WEB_ALLOWED_USER_ID` に入れる（4.3 章）。Password Requirements で「8 文字以上、文字種の混在」を設定する |
| Site URL | `https://<app>.vercel.app` | Auth のリダイレクト先の既定 |
| Redirect URLs | 追加しない | メールのリンクを使わない |
| 匿名サインイン | オフ（既定のまま） | 匿名の利用者も `authenticated` ロールになり、Storage のポリシー（3.3 章）に影響する |
| MFA | Q7 | 本人 1 人。`/login` の総当たりは Supabase の制限が Vercel の IP 単位なので防げず（4.3 章）、TOTP を R3 までに入れる案 |

### 2.6 Data API の設定（ダッシュボード）

API Settings の「Exposed schemas」から **`public` を外す**。この構成はブラウザからも Web のサーバーからも PostgREST を使わない（Web は Postgres 直結、Storage と Auth は別の API）。公開スキーマがなければ、万一 `authenticated` 向けのポリシーが足されても REST の面がない。3.2 章の既定権限の取り消しと二重の守りになる。R0 の接続状態表示（REST への疎通）はこの時点で消す（Web 画面設計 Q2）。

---

## 3. DB のロールと権限（NF-SEC-03、Web 画面設計 12 章）

### 3.1 現状の正確な記述（ローカルで確認。13 章 P）

- すべてのテーブルで RLS が有効、ポリシーなし。ビューは `security_invoker`。
- **`anon`／`authenticated`／`service_role` には Supabase の既定権限で `public` の全テーブル・ビューに全権限（`arwdDxtm`）が付いている**（R1 設計 7 章の「許可を与えない」は不正確。守っているのは RLS だけ）。R2 で取り消す（3.2 章）。
- `postgres` は superuser ではないが `createrole` と `bypassrls` を持つ。所有者でもあるので RLS の対象外。
- `vault.create_secret`／`update_secret` は `supabase_admin` 所有の `security definer`。`postgres` は `execute` を grant option つきで持つ（U6 はローカルで肯定。Cloud も同じイメージ）。`public.metric_value(jsonb, text[])` は PUBLIC が実行できる。`raw_api_responses` を参照するビューはない（Q8 は「与えない」で問題なし）。
- `storage.objects` は RLS 有効、ポリシーなし。`postgres` から `create policy` できる（supautils の policy_grants）。

### 3.2 マイグレーション `20261002xxxxxx_r2_web_role.sql` の骨子

```sql
-- 1. Web 用ロール。クラスタ単位なので db reset 後も残る → ガードする。パスワードは付けない（3.5 章と README）
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'web_app') then
    create role web_app login nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
alter role web_app set statement_timeout = '15s';   -- Vercel の関数の上限より少し長く、暴走を切る

-- 2. 権限は列挙する（all tables と default privileges は使わない。表を足すときは grant とポリシーを両方書く）
grant usage on schema private to web_app;            -- public は既定で PUBLIC に usage がある
grant select on public.profile_daily, public.account_daily_metrics, public.media, public.media_insight_snapshots,
                public.job_runs, public.video_analyses, public.video_cuts, public.metric_definitions to web_app;
grant select on public.account_connection_status, public.job_latest_runs, public.media_latest_metrics,
                public.media_metrics_at_horizon, public.story_final_metrics, public.media_analysis_dataset to web_app;
grant select, insert, update on public.accounts to web_app;
grant select, insert, update on private.credentials to web_app;
-- raw_api_responses、job_state は与えない（画面で使わない。Q8）

-- 3. Vault は security definer の関数経由（web_app は vault スキーマに触れない）
create function private.store_token(p_account_id uuid, p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := 'ig-token-' || p_account_id::text;
begin
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    v_id := vault.create_secret(p_token, v_name, 'Instagram page access token');
  else
    perform vault.update_secret(v_id, p_token);
  end if;
  return v_id;
end $$;
revoke all on function private.store_token(uuid, text) from public;   -- private には既定 ACL がなく PUBLIC 実行可になるため必須
grant execute on function private.store_token(uuid, text) to web_app;

-- 4. RLS ポリシー（単一利用者なので行の条件は true。ロールで絞る）
create policy web_app_select on public.accounts for select to web_app using (true);
create policy web_app_insert on public.accounts for insert to web_app with check (true);
create policy web_app_update on public.accounts for update to web_app using (true) with check (true);
-- private.credentials に同じ 3 本（insert … on conflict do update … returning に select が要る）
-- 2 で select を与えた 8 テーブルに select のポリシー 1 本ずつ

-- 5. anon / authenticated の既定権限を取り消す（REST の面を消す。2.6 章と二重）
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- service_role はワーカーの Storage 用に残す（テーブルは直結で読むので使わないが、取り消す必要もない）

-- 6. Storage: ログインした本人（匿名でない）だけがサムネイルを読める（3.3 章）
create policy thumbnails_read on storage.objects for select to authenticated
  using (bucket_id = 'thumbnails' and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false);
```

- Web の接続処理（`apps/web/src/lib/queries/register-credential.ts`）は `vault.secrets` を `select` している（レビューで判明）。R2 で `select private.store_token($1, $2)` に差し替える。`private.credentials` の upsert はそのまま。
- `web_app` は `token_secret_id` を更新できるが、`store_token` は `account_id` から名前を引くので、別アカウントの秘密を上書きする経路はない。加えてワーカーの `token_check` に `app_id = META_APP_ID`、`profile_id = accounts.fb_page_id` の確認を足す（現状は未検証。混乱した代理の防止。5.6 章）。
- トリガー関数（`set_updated_at`、`private.delete_token_secret`）は追加の grant 不要（13 章 P9）。

### 3.3 Storage の権限

| 操作 | R1 | R2 |
|---|---|---|
| サムネイルのアップロード（ワーカー） | サービスロールキーで Storage API | 同じ。鍵は GitHub Secrets。S3 互換キーは影響範囲が Storage に限られる利点があるが、S3 署名の実装か SDK の追加が要るので申し送り（12 章） |
| 署名付き URL（Web） | サービスロールキー | **ログインした本人のセッション**（`@supabase/ssr` のサーバークライアント、利用者の JWT）で `createSignedUrls`。3.2 章のポリシーで `thumbnails` の `select` だけ通る。Vercel からサービスロールキーをなくせる |

バケットは非公開のまま。`insert`／`update`／`delete` のポリシーは作らない（ワーカーはサービスロールで書く）。`authenticated` は `storage.objects` に表権限を持つので、守りは RLS ポリシーだけ。前提は「サインアップ無効」「匿名サインイン無効」「ポリシーで匿名を除外」の 3 つ。`WEB_ALLOWED_USER_ID` は Storage API には効かないので、10.2 章で作る試験用の利用者は同じ手順の中で必ず削除する。

### 3.4 ロールバック

```sql
drop policy if exists thumbnails_read on storage.objects;
-- public / private の web_app_* ポリシーを drop
drop owned by web_app;        -- grant をまとめて外す（DB は 1 つ）
drop role web_app;
drop function if exists private.store_token(uuid, text);
```

### 3.5 ローカルでの検証（段階 A の受け入れ）

- `supabase/seed.sql` に **ローカル専用の公知のパスワード**を置く: `alter role web_app with password 'web_app_local';`（Q9。ローカルの Supabase のサービスロールキーや DB パスワードと同じ扱い。README に「本番では使わない」と明記）。`db reset` のたびに seed が流れるので手動の `alter role` が要らない。
- 結合テスト用に `TEST_WEB_DATABASE_URL=postgresql://web_app:web_app_local@127.0.0.1:54322/postgres` を足し、`apps/web/test/db/*` はこちらで流す（`register-credential.test.ts` と `queries.test.ts` は現在 `postgres` で動いており本番と権限が違う）。
- 受け入れ: `web_app` で 6 ビューの `select` が通る。`vault.decrypted_secrets`、`raw_api_responses`、`job_state` の `select` が権限エラー。`job_runs` の `insert` が権限エラー。`private.credentials` の upsert と `private.store_token` で Vault が作成・更新される（`postgres` で `vault.decrypted_secrets` を読んで確認）。`anon` と `authenticated` で `public` のどのテーブル・ビューも権限エラー（RLS ではなく grant で落ちる）。`authenticated` の JWT（ローカル Auth で利用者を作り `signInWithPassword`）で `thumbnails` の署名付き URL が作れ、`anon` と他バケットでは作れない。`is_anonymous=true` の JWT では作れない。

---

## 4. Web（Vercel）

### 4.1 デプロイ

| 項目 | 内容 |
|---|---|
| プラン | Hobby（個人の非商用。要件 2.3 章） |
| Git 連携 | `main` を本番にデプロイ。**プレビューは作らない**。Settings → Git の Ignored Build Step に `if [ "$VERCEL_ENV" = "production" ]; then exit 1; else exit 0; fi`（`exit 0` がスキップ、`exit 1` がビルド）。`main` への全 push（ワーカーや文書だけの変更）で本番ビルドが走るのは許容（同時ビルド 1、1 日 100 デプロイ。13 章 V1） |
| Root Directory | `apps/web`（設定済み）。「Include source files outside of the Root Directory in the Build Step」が有効であることを初回に確認（ルートの `package-lock.json` を使うため。U5）。ビルドログの `outputFileTracingRoot` の警告が出ないかを見る |
| Node | `apps/web/package.json` に `"engines": { "node": "24.x" }`（major 指定。範囲指定にしない）。プロジェクト設定の Node.js Version も 24.x |
| 関数の実行時間 | 2026 年作成のプロジェクトは Fluid compute が既定で、Hobby の既定は 300 秒の可能性がある（13 章 V1 の表は非 Fluid の列。初回に Functions の設定で確認して V1 を直す）。`api/meta/callback/route.ts` に `export const maxDuration = 60` を付け、上限を下げる意味で使う。Meta への各 fetch にはタイムアウトがある（ワーカー `graph.ts`、Web `meta-graph.ts` とも `AbortSignal.timeout`） |
| ログ | ランタイムログは 1 時間保持、プロジェクトのメンバーだけが見られる。ログの詳細に Search Params が出るので、コールバックの `code` と `state` は 1 時間だけ残る（13 章 V2）。`code` は数秒で交換され Meta 側で無効化されるので受け入れる。Route Handler の未捕捉エラーは Next.js がメッセージごと出す（postgres.js のホスト名など）。非公開なので許容するが、Web 側も `console.error` は固定文言にする規則を置く（4.5 章） |

### 4.2 環境変数（Production のみ。二段で入れる）

| 段 | 変数 | 内容 |
|---|---|---|
| 1（ログインの確認まで） | `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ログインと署名付き URL。ブラウザに出てよい値 |
| 1 | `APP_URL` | `https://<app>.vercel.app` |
| 1 | `WEB_ALLOWED_USER_ID` | ログインを許す Supabase Auth の利用者 `id`（4.3 章） |
| 2（ログインを確認してから） | `DATABASE_URL`（Sensitive） | トランザクションモード、`web_app` |
| 2 | `DATABASE_POOL_MODE` | `transaction` |
| 2 | `DATABASE_SSL_CA` | CA 証明書の PEM |
| 2 | `META_APP_ID`、`META_APP_SECRET`（Sensitive）、`META_GRAPH_API_VERSION` | 接続とトークン確認 |
| 任意 | `META_TARGET_IG_USER_ID` | R1 と同じ |
| **置かない** | `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` | 3.3 章により不要 |

段 1 だけでデプロイして「未ログインは `/login` へ」「別の利用者は 403」を本番で確かめてから段 2 を入れる（7 章の手順 2）。段 2 の変数が未設定の間、画面は「設定が不足」の固定文言を出す（R1 の `readEnv` の挙動）。

### 4.3 ログイン（F-SYS-13、NF-SEC-02）

依存の追加（Q2）: `@supabase/supabase-js` と `@supabase/ssr`（版を固定し `package-lock.json` をコミット。段階 C だけが lockfile を触る）。

| 層 | 内容 |
|---|---|
| `src/lib/supabase/server.ts` | `createServerClient(url, publishableKey, { cookies: { getAll, setAll }, cookieOptions: { httpOnly: true, secure: APP_URL が https, sameSite: 'lax', maxAge: 7 日 } })`。ブラウザで supabase-js を使わないので `httpOnly` にできる。`strict` にしない（Meta から戻るときに必要） |
| `src/lib/access.ts` | 純関数 `decideAccess(pathname, claims \| undefined, allowedUserId) => 'pass' \| 'login' \| 'forbid'`。`/login` と静的資産は `pass`。それ以外で claims なし → `login`。`allowedUserId` が未設定・空 → **`forbid`**（フェイルクローズ）。`claims.sub !== allowedUserId` → `forbid`。`getClaims()` の失敗（期限切れ、Supabase に届かない）は claims なしとして扱う |
| `src/proxy.ts` | 1) Host 検査（R1）→ 2) `createServerClient` でセッションを更新し `getClaims()` → 3) `decideAccess` → `login` なら `/login` へ 303、`forbid` なら 403 → 4) `setAll` が最後に作った `supabaseResponse` を返す（別のレスポンスを返すと更新済み Cookie が落ちる。13 章 S6）。`getSession()` はサーバーで信用しない |
| 保護対象 | `/login`、`_next/static`、`favicon.ico` 以外のすべて。`/api/meta/callback` も対象。Meta からの戻りは **クロスサイトのトップレベル GET** で、`SameSite=Lax` だから認証 Cookie と `state` Cookie が付く。未ログインなら登録せず `/login` へ |
| Route Handler | `/api/meta/login`（POST）と `/api/meta/callback`（GET）の中でも `getClaims()` と `decideAccess` を再確認（proxy の matcher の漏れに備える） |
| `/login` | Server Component のフォーム（メール、パスワード）＋ Server Action で `signInWithPassword`。失敗は固定文言と固定の遅延（1 秒）。成功で `/` へ。Supabase Auth のレート制限は Vercel の IP 単位なので第三者の総当たりで本人がロックされうる（突破はされない）。パスワードは 20 文字以上の乱数、TOTP は Q7 |
| ログアウト | ヘッダのフォーム（POST の Server Action）で `signOut({ scope: 'global' })` → `/login`。Cookie が消えていることをテスト |
| OAuth の `state` Cookie | `stateCookieName(appUrl)` を 1 つの関数にして login と callback の両方が使う。https → `__Host-meta_oauth_state`（`secure`、`path=/`、`SameSite=Lax`、10 分）。http（ローカル）→ `meta_oauth_state`（`path=/`）。`__Host-` は `path=/` が条件なので R1 の `path=/api/meta` は捨てる |
| CSRF | R1 の `Sec-Fetch-Site`／`Origin` 検査は残す（`Referrer-Policy: same-origin` が前提）。Server Action は Next.js が Origin を検査する |

### 4.4 Meta アプリ側

- 「有効な OAuth リダイレクト URI」に `https://<app>.vercel.app/api/meta/callback` を追加（本番は開発モードの `localhost` 例外が効かない）。
- アプリは開発モードのまま。
- `appsecret_proof`（Q6）を使う場合、「App Secret が必要」をオンにするのはワーカーと Web の両方のデプロイ後。オンにすると Graph API Explorer と R0 の `verify-api` もプルーフなしでは動かなくなる（README に書く）。

### 4.5 ログの規則（Web）

- `console.error`／`console.warn` は固定文言と理由コードだけ（R1 のコールバックと同じ）。例外の `message` と `stack` を出さない（postgres.js のメッセージはホスト名とユーザー名を含む）。
- `logging.fetches` は設定しない（R1 のまま）。

---

## 5. 収集ワーカー（GitHub Actions）

### 5.1 ワークフロー `.github/workflows/collect.yml`（1 本）

| 項目 | 内容 |
|---|---|
| トリガー | `schedule: ['17 0-19,21-23 * * *', '17 20 * * *']` と `workflow_dispatch`（入力 `simulate_alert`: boolean、既定 false）。他のトリガーは付けない |
| ジョブ `collect` | `run-daily`（`github.event.schedule == '17 20 * * *'` のときだけ。JST 05:17）→ `run-hourly` → `check-alerts` → 死活監視へ ping。daily と hourly を同じジョブで順に動かすので重ならない（R1 の `schedule` コマンドと同じ形）。`timeout-minutes: 30`、`permissions: { contents: read }` |
| ジョブ `keepalive` | `needs: collect`、`if: ${{ !cancelled() && github.event.schedule == '17 20 * * *' && vars.COLLECT_KEEPALIVE == 'true' }}`、`permissions: { actions: write }`（5.4 章） |
| `concurrency` | `group: instagram-analyze-collect`、`cancel-in-progress: false`。1 本なので「実行中 1 ＋ 待ち 1」で足りる（GitHub の遅延が 30 分を超えて 3 つ目が来たときだけ待ちがキャンセルされる。10.2 章で `cancelled` を数える） |
| 分 | 毎時 0 分は GitHub 全体の混雑でキューが遅れ、混みすぎると落とされる（13 章 G1）。17 分にずらす。遅延は要件 5.2 章の方式（取得時刻から経過時間を計算）で吸収 |

```yaml
jobs:
  collect:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions: { contents: read }
    concurrency: { group: instagram-analyze-collect, cancel-in-progress: false }
    env:
      WORKER_LOG_LEVEL: info                       # 明示（debug にしない）
    steps:
      - run: echo "::add-mask::$(node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname)')"
        env: { DATABASE_URL: ${{ secrets.DATABASE_URL }} }   # ホスト名とユーザー名を部分文字列としてマスク（接続エラーの文言対策）
      - run: echo "::add-mask::$(node -e 'console.log(new URL(process.env.DATABASE_URL).username)')"
        env: { DATABASE_URL: ${{ secrets.DATABASE_URL }} }
      - uses: actions/checkout@<sha>               # タグでなくコミット SHA で固定（横に # vX.Y.Z）
        with: { persist-credentials: false }
      - uses: actions/setup-node@<sha>
        with: { node-version: 24, cache: npm }
      - run: npm ci --workspace worker --ignore-scripts
      - run: npm run build --workspace worker
      - name: ffmpeg
        continue-on-error: true                    # 入らなくても収集は進める（stories の動画解析だけ failed になり、メールで分かる）
        run: |
          for i in 1 2 3; do sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg && break; sleep 15; done
      - id: daily
        if: github.event.schedule == '17 20 * * *' && !inputs.simulate_alert
        run: node apps/worker/dist/index.js run-daily
        env: { DATABASE_URL: ${{ secrets.DATABASE_URL }}, DATABASE_SSL_CA: ${{ vars.DATABASE_SSL_CA }}, SUPABASE_URL: ${{ secrets.SUPABASE_URL }}, SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}, META_APP_ID: ${{ secrets.META_APP_ID }}, META_APP_SECRET: ${{ secrets.META_APP_SECRET }}, META_GRAPH_API_VERSION: v25.0, WORKER_BACKFILL_HISTORY_DAYS: '400' }
      - id: hourly
        if: ${{ !cancelled() && !inputs.simulate_alert }}
        run: node apps/worker/dist/index.js run-hourly
        env: { …同上… }
      - id: alerts
        if: ${{ !cancelled() }}
        run: node apps/worker/dist/index.js check-alerts --scope ${{ github.event.schedule == '17 20 * * *' && 'daily' || 'hourly' }}
        env: { DATABASE_URL: …, DATABASE_SSL_CA: …, WORKER_SIMULATE_ALERT: ${{ inputs.simulate_alert || vars.WORKER_SIMULATE_ALERT || 'false' }} }
      - name: ping
        if: ${{ !cancelled() }}                    # 走ったことを知らせる（成否は GitHub のメールが担う。5.3 章）
        run: curl -fsS --max-time 10 --retry 3 "$HEALTHCHECKS_PING_URL" > /dev/null
        env: { HEALTHCHECKS_PING_URL: ${{ secrets.HEALTHCHECKS_PING_URL }} }
```

- 秘密は必要なステップの `env` にだけ渡す（ジョブレベルに置かない）。`ACTIONS_STEP_DEBUG` を有効にしない。`set -x` や `env` の表示を書かない。
- ランナーは使い捨てで `read_only`／非 root などの R1 の硬化はないが、守る資産は Secrets（`DATABASE_URL` は Vault の復号を含む全権）で、脅威はサプライチェーン経由の漏洩。対策は上の SHA 固定、lockfile、`--ignore-scripts`、`persist-credentials: false`、ステップ単位の `env`。`.github/dependabot.yml` に `github-actions` を足して SHA の更新を受ける。
- Docker は使わない（毎回のビルドに 2〜3 分。GHCR の公開イメージは別のワークフローと権限が増える）。ランナーに ffmpeg がなければ apt（U3）。Ubuntu 24.04 の ffmpeg（6 系）は bookworm（5 系）と版が違い、カット検出の結果が変わりうる（12 章）。
- 1 回の所要は依存の取得とビルドで 1〜2 分 ＋ 収集で 1 分前後（バックフィル中は数分）。月の合計は 24 × 30 × 3 分 ≒ 2,200 分だが、公開リポジトリの標準ランナーは無料（13 章 G4）。
- 公開ログに出るもの: ステップを展開すると `env:` の値が表示される。Secrets は `***` にマスクされるが **Variables はされない**。だから Variables に置くのは公開されてよい値だけ（6 章）。ワーカーは件数と成否しか出さない（NF-SEC-06）。

### 5.2 `check-alerts` コマンド（新規。F-SYS-14、NF-REL-03）

ジョブの `status` を歪めずに「人が見るべき状態」を終了コードで知らせる。純関数と DB 読み出しを分ける（R1 の `evaluateDebugToken(res, now)` と同じ形）。

```ts
// jobs/alerts.ts（純関数。I/O なし）
interface AlertInput {
  accounts: { ordinal: number; status: string; credential: { status: string; dataAccessExpiresAt: Date | null } | null;
               recentStoriesRuns: { status: string }[];   // started_at desc、running を除く、最大 3 件
             }[];
}
evaluateAlerts(input: AlertInput, now: Date, scope: 'hourly' | 'daily', simulate: boolean): Alert[]
```

| 判定 | scope | 条件 | ログ |
|---|---|---|---|
| シミュレーション | 両方 | `simulate` が true | `WARN alert=simulated` |
| トークンの期限 | daily のみ | `accounts.status = 'active'` で、credential がない、`credential.status <> 'valid'`、または残り日数が 14 日未満（`token_check` と同じ計算: UTC、切り捨て。定数 `DATA_ACCESS_WARN_DAYS` を共用し、新しい環境変数は作らない。14 日ちょうどは警告しない） | `WARN alert=token account=1/N days_left=13 status=valid` |
| ストーリーズの連続失敗 | hourly（daily の回も hourly を含む） | `active` のアカウントで、`stories` の直近 2 回（`running` を除く）がどちらも `failed`（`partial`／`skipped` は数えない） | `WARN alert=stories_failed account=1/N runs=2` |
| 見送りの連続 | hourly | `stories` の直近 3 回がすべて `skipped`（レート制限かロック。R1 設計 8.2 章） | `WARN alert=stories_skipped account=1/N runs=3` |
| 履歴なし | 両方 | 該当ジョブの記録が足りない（初回、移行直後）→ 判定しない | `INFO alerts=0 reason=no_history` |

- 「停滞」の判定は入れない。収集が走っていないことは死活監視（5.5 章）が、走って失敗したことは `run-*` の終了コード 1 と GitHub のメールが拾う。重複させない。
- 該当なしでも必ず `INFO alerts=0` を出す（7 日間の確認で「走った」ことを確かめる）。該当は全件出し、1 件でもあれば終了コード 1。DB 接続の失敗は `ERROR error_code=<SQLSTATE か cert> class=db` で終了コード 1（alert と区別できる）。アカウントは `account=1/N` の連番（ID やユーザー名は出さない）。
- DB 読み出しは `db/job-runs.ts` に `listRecentRuns(accountId, jobName, limit)` を足し、`db/accounts.ts` の `listAccounts` を使う。結合テストは `deps.listAccounts` の注入で自分の架空アカウントに限る（他の担当のテストと衝突しない）。
- `WORKER_SIMULATE_ALERT=true`（`workflow_dispatch` の入力か repo Variable）のときは収集ステップを飛ばし、`check-alerts` だけが `simulated` で失敗する（本番のデータを増やさない）。

### 5.3 通知の経路（どの事象がどのメールになるか）

| 事象 | 検知 | 届くもの |
|---|---|---|
| ジョブの `failed`（Meta の 5xx など 1 回の失敗を含む） | `run-hourly`／`run-daily` の終了コード 1 | GitHub の失敗メール |
| トークンの残り 14 日未満、認証情報の異常 | daily の `check-alerts` | GitHub の失敗メール（1 日 1 通。hourly では出さない） |
| `stories` の 2 回連続失敗、3 回連続見送り | hourly の `check-alerts` | GitHub の失敗メール（続く間は毎時） |
| スケジュールが動いていない（無効化、落ち、キャンセル、ランナー不調） | 死活監視の ping が 3 時間（猶予）届かない | Healthchecks のメール |
| Supabase の一時停止の予告 | Supabase | Supabase のメール（C3） |

- GitHub の失敗メールの宛先は「ワークフローを最初に作った利用者」で、cron を編集した人、再有効化した人に移る（13 章 G3）。**ワークフローのファイルはユーザー本人のアカウントでコミットするか、作成後にユーザーが cron を一度編集する**（Q10）。GitHub の通知設定で「失敗したときだけ」にする。
- 一時的な失敗でメールが増えるなら、7 日間の頻度を見て `continue-on-error` と「2 回連続」の判定に寄せる（12 章）。

### 5.4 スケジュールの延命（NF-REL-05）

公開リポジトリでは「60 日間リポジトリに活動がない」とスケジュール実行が無効になる（13 章 G1、G2）。無効になると失敗メールも出ない。

- `keepalive` ジョブ（daily の回だけ）で `gh api -X PUT repos/${{ github.repository }}/actions/workflows/collect.yml/enable`（`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`、`permissions: actions: write`）を呼ぶ。repo Variable `COLLECT_KEEPALIVE=true` のときだけ動かし、ロールバックや試験で意図的に無効化したワークフローを勝手に戻さないようにする。
- 無効化の前にこの API を呼ぶと 60 日の起算が戻るとされるが、GitHub の文書は「リポジトリの活動」としか書いていない（U4。7 日間では検証できないので、`progress.md` に「55 日目にワークフローの `state` を確認」を残す）。確実なのはコミットで、開発が続く間は自然に満たす。
- 検知は 5.5 章の死活監視。

### 5.5 死活監視（Q4）

| 案 | 内容 |
|---|---|
| **A: Healthchecks.io（推奨）** | 無料枠、メール通知。`collect` ジョブの最後に（成否を問わず）ping。猶予 3 時間で未着ならメール。URL は GitHub Secrets（漏れても偽の ping ができるだけ）。Web に例外を作らず、無効化・落ち・キャンセル・ランナー不調を 1 つで拾う |
| B: cron-job.org ＋ `/api/health` | Vercel にログイン不要の例外を 1 つ開け、`job_runs` の最終成功が 3 時間より古ければ 503。新しい秘密は要らないが、無認証の経路が増える |

A の ping は「走った」ことだけを知らせる（失敗時に `/fail` を送ると GitHub のメールと二重になるので送らない）。

### 5.6 ワーカーのその他の変更

| 変更 | 内容 |
|---|---|
| `DATABASE_SSL_CA` とフェイルクローズ | 2.2 章 |
| `check-alerts` | 5.2 章。`commands/check-alerts.ts`、`jobs/alerts.ts`、`index.ts` の `COMMANDS` に登録 |
| `token_check` の検証の追加 | `debug_token` の `app_id = META_APP_ID`、`profile_id = accounts.fb_page_id` を確認し、違えば `credentials.status = 'error'`（Web の接続処理と同じ基準。3.2 章） |
| `appsecret_proof`（Q6） | 呼び出しごとに「そのリクエストに使うトークン」で `HMAC-SHA256(token, app_secret)` を計算してクエリに付ける。ワーカー: 収集（ページトークン）、`debug_token`（アプリトークン `app_id\|app_secret`）。Web: トークン交換（なし。`client_secret` を送る）、`me/accounts` とページトークン取得（長期ユーザートークン）、`debug_token`（アプリトークン）。`sanitizeForLog` の `appsecret_proof=` のマスクは R1 にある。`raw_api_responses.params` から除く（R1 の `stripSecretParams` の対象に追加） |
| `schedule` コマンド | 変えない（ローカル用） |
| `.env.example` | `DATABASE_SSL_CA` を追記。`DATABASE_URL` の説明に「Cloud はセッションモード。ローカル以外のホストでは CA 必須」 |

---

## 6. 秘密の一覧と漏洩時の対応（NF-SEC-04）

置き場の基準: **GitHub Variables と Vercel の通常の環境変数は「公開ログや画面に出てもよい値」だけ**（Variables はステップの展開で平文になる。5.1 章）。「漏れても無害」ではなく「公開されてよい」で判断する。

| 秘密 | 置き場 | 漏れたときの影響 | 取り消し |
|---|---|---|---|
| DB パスワード（`postgres`） | GitHub Secrets `DATABASE_URL`、手元の PC（`db push`、移行） | DB の全読み書き。Vault の復号を含む（→ Meta のトークン） | ダッシュボードで DB パスワードをリセット → Secrets を更新。Meta のトークンも `/connect` で取り直す |
| `web_app` のパスワード | Vercel `DATABASE_URL`（Sensitive） | 画面用テーブルの読み出し、`accounts`／`credentials` の更新、`store_token` での上書き（読めない） | `psql` で `\password web_app` → Vercel を更新 |
| サービスロールキー | GitHub Secrets | REST（公開スキーマなし）、Storage、Auth 管理の全操作 | ダッシュボードでローテーション（新しい API キーなら個別に失効。U2） |
| `SUPABASE_URL`（project ref を含む） | GitHub Secrets（Variables にしない。NF-SEC-07） | エンドポイントの特定 | 変えられない（プロジェクト作り直し） |
| `META_APP_ID` | GitHub Secrets、Vercel（Sensitive でなくてよいが Variables にはしない） | アプリの特定 | 変えられない |
| `META_APP_SECRET` | GitHub Secrets、Vercel（Sensitive） | `debug_token` の実行、アプリの偽装、`appsecret_proof` の生成 | Meta アプリの設定で再生成 → 両方を更新 |
| Healthchecks の ping URL | GitHub Secrets | 偽の ping で停止を隠せる | Healthchecks で URL を再生成 |
| Supabase Auth の利用者のパスワード | 本人 | 画面の閲覧と接続操作 | ダッシュボードでパスワード変更、セッション失効 |
| 移行用の S3 互換キー（7 章） | 手元の PC（`rclone.conf` など） | Storage の全操作 | 移行後にダッシュボードで削除、`rclone` の設定も削除 |
| `supabase login` のトークン | 手元の PC | アカウントの全プロジェクトの管理 | `supabase logout` |
| `pg_dump` の出力（取得データを含む） | `.local/`（Git 管理外） | 取得データとユーザー名の流出 | 流し込み後に削除 |
| 4 アカウント（GitHub、Vercel、Supabase、Meta 開発者）の資格情報 | 本人 | すべて（ワークフローの書き換えで Secrets を読める、再デプロイで env を吐ける） | 2 要素認証を必須にし、パスワードを変更、セッション失効 |

公開されてよいもの（GitHub Variables、Vercel の通常の環境変数）: `DATABASE_SSL_CA`（公開 CA）、`COLLECT_KEEPALIVE`、`WORKER_SIMULATE_ALERT`、`APP_URL`、`WEB_ALLOWED_USER_ID`（uuid。本人以外には無意味）、`NEXT_PUBLIC_*`、`META_GRAPH_API_VERSION`。

GitHub Secrets は 6 つ: `DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`META_APP_ID`、`META_APP_SECRET`、`HEALTHCHECKS_PING_URL`。`META_ACCESS_TOKEN` は置かない（Vault にある）。

---

## 7. ローカルからの移行と切り替え（F-SYS-15）

### 7.1 準備（ローカルの常駐を止める前に済ませる。欠損の時間帯を短くする）

| # | 手順 |
|---|---|
| 1 | 2 章の Supabase の設定（Auth、SSL 強制、Data API、利用者の作成）。`supabase link` → `db push`（R1 の 5 本 ＋ R2 の 1 本）→ `psql`（セッションモード）で `\password web_app`（パスワードを SQL 文に入れない。履歴とサーバーログに残さない）。`supabase logout` |
| 2 | Vercel に段 1 の環境変数を入れて `main` をデプロイ。未ログインで `/` → `/login`、本人でログイン → 3 画面が「設定が不足」、別の利用者（一時的に作る）でログイン → 403 → その利用者を削除。確認できたら段 2 の変数を入れて再デプロイ → 3 画面が「データなし」で出る |
| 3 | 4.4 章（Meta の OAuth リダイレクト URI）、Healthchecks のチェック作成（period 1 時間、grace 3 時間）、GitHub Secrets 6 つと Variables（`DATABASE_SSL_CA`、`COLLECT_KEEPALIVE=true`）の登録 |
| 4 | サムネイルの 1 回目のコピー（不変なので先にできる）: ダッシュボードで S3 互換キーを生成し、`rclone` でローカルの S3 互換エンドポイント（`supabase status` の S3 キー）から Cloud の `thumbnails` バケットへ |
| 5 | データ移行のリハーサル: 7.2 の手順 3〜4 を空の本番 DB に対して行い、件数を確かめてから `truncate`（`metric_definitions` 以外）。`pg_dump` の出力は `.local/` に置き、終わったら削除 |

### 7.2 切り替え（深夜に、連続して行う。欠損は 30 分程度）

| # | 手順 | 備考 |
|---|---|---|
| 1 | `npm run worker:down` | ここから本番の初回実行までの 1 時間ごとのデータは欠ける。実際の欠損時間を `progress.md` に記録 |
| 2 | 実行中だった記録の整理: ローカルで `update public.job_runs set status = 'failed', finished_at = now(), error = 'aborted: migration' where status = 'running';` | `running` のまま移すと 10.2 章の確認と `check-alerts` に紛れる |
| 3 | `docker exec supabase_db_instagram-analyze pg_dump -U postgres -d postgres --data-only --inserts --on-conflict-do-nothing --schema=public --exclude-table-data=public.metric_definitions > .local/r2-migration.sql` | サーバーと同じ 17 系の `pg_dump`。identity 列の `overriding system value`、`setval`、FK 順は自動（13 章 P7）。`auth`、`storage`、`vault`、`supabase_migrations` は含めない |
| 4 | `psql -h aws-<n>-<region>.pooler.supabase.com -p 5432 -U postgres.<project-ref> -d postgres "sslmode=verify-full sslrootcert=<CA のパス>" -v ON_ERROR_STOP=1 --single-transaction -f .local/r2-migration.sql` | パスワードは対話入力か `pgpass.conf`（URL に入れない。履歴に残さない）。終わったら `.local/r2-migration.sql` を削除 |
| 5 | サムネイルの差分コピー（`rclone` の 2 回目）→ S3 互換キーを削除、`rclone` の設定を削除 | Vault と `private.credentials` は移さない（Vault は鍵がプロジェクトごと） |
| 6 | 本番の `/connect` で Meta に接続（Vault に登録） | `accounts` の行は 4 で入っているので `ig_user_id` で一致して更新 |
| 7 | `workflow_dispatch` で `collect.yml` を 1 回（hourly）→ `job_runs` と画面で確認 → もう 1 回 `simulate_alert=false` のまま daily 相当は翌朝のスケジュールに任せる | 初回は `check-alerts` が `no_history` を出す |
| 8 | 次の毎時 17 分のスケジュール実行を **T0** とし、7 日間の確認（10.2 章）を始める。Healthchecks のチェック詳細で ping の到着を確認 | |

### 7.3 ロールバック（本番がうまく動かないとき）

1. repo Variable `COLLECT_KEEPALIVE` を `false` にしてから、`collect.yml` を無効化する（順序を逆にすると daily の回で再有効化される）。
2. ローカルの DB は 7 日間の確認が終わるまで `db reset` しない（そのまま戻せる）。
3. `npm run worker:up` でローカルの常駐に戻す。欠けた日次は `npm run worker:job -- account-daily --days N`（README の表）。
4. 本番側のトークン（Vault）はそのままでよい（同じページトークンがローカルにもある）。本番を捨てるならダッシュボードでプロジェクトを一時停止する。

ローカルの開発環境はそのまま。**本番の接続文字列をローカルの `.env` に書かない**（compose の常駐が本番に向くと二重収集になる）。本番に手で SQL を流すときは `psql -h … -U …` を都度指定し、パスワードを URL に入れない。

---

## 8. 容量とコスト（NF-CAP-01〜03）

| 項目 | 見込み | 根拠と計画 |
|---|---|---|
| DB | R1 実測: 1 日目で `raw_api_responses` 808 件 1.6 MB（バックフィル中は 1 時間 125 件）。バックフィル完了後は hourly 24 回 × 数呼び出しで **1 日 100〜300 件**の可能性がある（0.1 の「30 件」は過小） | 7 日間でテーブル別の `pg_total_relation_size` を 1 日目と 7 日目に取り、× 52 で年の見込みに置き換える。500 MB 超過は読み取り専用化なので、月 1 回 Usage を見る運用項目にする。生レスポンスの削除は 12 章 |
| Storage | サムネイル 1 枚 数十 KB × 投稿数 | 1 GB に対し 1 万枚でも余裕 |
| Egress | 画面の閲覧とサムネイル配信 | 5 GB／月に対し本人 1 人 |
| GitHub Actions | 月 2,200 分前後 | 公開リポジトリは無料（13 章 G4） |
| Vercel | 本人の閲覧のみ | Hobby の範囲。Usage を 7 日目に見る |

---

## 9. 実装の分割（同じ作業ツリーでファイルを分担）

| 段階 | 内容 | 担当 | 触るファイル | 受け入れ |
|---|---|---|---|---|
| A: DB | 3.2 章のマイグレーション、`seed.sql`、`TEST_WEB_DATABASE_URL` | 設計とレビュー `postgres-sql-reviewer`、実装は親 | `supabase/migrations/20261002*_r2_web_role.sql`、`supabase/seed.sql`、`apps/web/test/db/*` | 3.5 章の項目がすべて通る。`supabase db reset` を 2 回続けても失敗しない |
| B: ワーカー | 2.2 章、5.2 章、5.6 章、`collect.yml`、`dependabot.yml`、`.env.example` | `node-worker-developer` | `apps/worker/src/{config.ts,db/client.ts,db/errors.ts,db/job-runs.ts,lib/graph.ts,jobs/alerts.ts,jobs/token-check.ts,commands/check-alerts.ts,index.ts}`、`apps/worker/test/*`、`.github/workflows/collect.yml`、`.github/dependabot.yml`、`.env.example` | `npm run test -w worker`（結合込み）が緑。`workflow_dispatch` で 1 回通る（本番の Secrets を入れた後） |
| C: Web | 2.2 章、4.2〜4.5 章、R0 の接続状態表示の削除、`maxDuration`、`engines`、Vault を `store_token` に | `nextjs-developer` | `apps/web/src/{proxy.ts,lib/access.ts,lib/env.ts,lib/db.ts,lib/db-errors.ts,lib/storage.ts,lib/supabase/*,lib/meta-oauth.ts,lib/meta-graph.ts,lib/queries/register-credential.ts,app/login/*,app/layout.tsx,app/page.tsx,app/api/meta/*}`、`apps/web/test/*`、`apps/web/.env.example`、`apps/web/package.json`、`package-lock.json` | `npm run test -w web`（`TEST_DATABASE_URL` と `TEST_WEB_DATABASE_URL` 付き）が緑。ローカル Auth でログイン → 3 画面 → ログアウト → `/login`。`WEB_ALLOWED_USER_ID` 未設定で 403 |
| D: 運用 | README（Cloud の設定、Secrets、移行、切り替え、ロールバック、7 日間の確認）、`progress.md` | `technical-writer` または親 | `README.md`、`doc/progress.md` | README の手順だけで 7 章を再現できる |

- A の適用（`db reset`）は B と C を始める前に 1 回だけ行う。B と C は並列（触るファイルが重ならない。lockfile は C だけ）。結合テストは同じローカル DB を使うので、各自の架空アカウントに限って読む（`listAccounts` の注入。5.2 章）。
- レビューは各段階で `security-engineer` と `quality-engineer` を並列に当てる（対象のファイルだけ読む。外部文書なし。10 分程度）。

---

## 10. テストと 7 日間の実機確認

### 10.1 単体・結合（ローカル）

| 対象 | ケース |
|---|---|
| `evaluateAlerts` | 残り 13 日／14 日ちょうど／15 日（`token-check.test.ts` のベクトルを流用）、credential なし、`status <> 'valid'`、`stories` の `failed,failed`／`failed,partial`／`failed,skipped`／`running,failed,failed`（running を除いて 2 回）／1 件だけ／0 件（no_history）、`skipped × 3`、`paused` のアカウントは対象外、scope ごとの出し分け、`simulate`、複数アカウントの連番、ログに `://` と 10 桁の数字がない |
| TLS の設定 | `DATABASE_SSL_CA` あり → `ssl: { ca, rejectUnauthorized: true }`。なし ＋ ローカルのホスト → `ssl` なし。なし ＋ それ以外のホスト → `ConfigError`（値を含まない）。URL の `?sslmode=require` を無視。`\\n` の正規化。PEM の先頭検査。不正な CA で接続 → `normalizeDbError` が固定文言 |
| `DATABASE_POOL_MODE` | 未設定 → `prepare` 既定、`transaction` → `prepare: false`、不正値 → `ConfigError` |
| `appsecret_proof` | 既知のベクトル、呼び出しごとの計算元（5.6 章の表）、`raw_api_responses.params` に残らない、ログでマスク |
| `token_check` | `app_id`／`profile_id` の不一致 → `error` |
| `decideAccess` | `/login` と静的資産は `pass`、claims なし → `login`、`allowedUserId` 未設定・空 → `forbid`、`sub` 不一致 → `forbid`、一致 → `pass`、`getClaims` 失敗は claims なしとして `login` |
| Cookie | `stateCookieName`: https → `__Host-meta_oauth_state` ＋ `secure` ＋ `path=/`、http → 接頭辞なし ＋ `path=/`。login が書く名前と callback が読む名前が同じ関数から来る。Supabase 認証 Cookie の `httpOnly`／`secure`／`sameSite` |
| 署名付き URL | `createSignedUrls` を持つ最小のインターフェースを注入して単体。結合は 3.5 章 |
| ログアウト | `signOut({ scope: 'global' })` が呼ばれ、`/login` 到達時に Cookie が消えている |
| DB（結合） | 3.5 章。`check-alerts` の結合は注入した架空アカウントだけ |

### 10.2 7 日間の実機確認（R2 の完了条件）

計測の起点 **T0** は 7.2 章の手順 8（最初のスケジュール実行）。通知の試験（10.3 章）は T0 の前に済ませ、7 日間は収集を止めない。

| 完了条件 | 項目 | 確かめ方（期待値） |
|---|---|---|
| 7 日間、人手なしで収集が続く | 実行の欠け | `select count(*) from job_runs where job_name = 'media_snapshot' and status in ('success','partial') and started_at between T0 and T0 + interval '7 days'` が 168。`failed`／`skipped` の件数を別に出す。隣り合う 2 行の差: `select max(gap) from (select started_at - lag(started_at) over (order by started_at) as gap from job_runs where job_name = 'media_snapshot' and started_at >= T0) g` が 2 時間未満 |
| 同 | daily | `token_check` と `profile_daily` が 7 行、JST 05:17 ＋ 遅延 |
| 同 | 残骸 | `running` の残り 0、`skipped`（ロック）0、Actions の `cancelled` 0 |
| 同 | 遅延と所要 | `gh run list --workflow collect.yml --json createdAt,startedAt,updatedAt,conclusion --limit 200` で「17 分 → createdAt」「createdAt → startedAt」「所要」の 3 つの分布と conclusion の内訳。遅れが常態的に 10 分を超えるなら分をずらす |
| 同 | `check-alerts` | 各実行のログに `alerts=0` か `alert=` が 1 回ずつある |
| 同 | Supabase | 一時停止の警告メールが来ない（C3）。Usage（DB、Storage、egress）とテーブル別 `pg_total_relation_size` を 1 日目と 7 日目に記録 |
| 同 | keepalive | daily の後に `gh api repos/<owner>/<repo>/actions/workflows/collect.yml --jq .state` が `active`（U4 前半） |
| ログインしないと見られない | 本番 | 未ログインで `/`、`/jobs`、`/media`、`/connect` が `/login` へ（curl で 303 と `Location`）。`POST /api/meta/login` が 303（`/login`）。`GET /api/meta/callback?code=x&state=y` が登録せず `/login` へ。本人でログイン → 3 画面が本番データで出る、サムネイルがセッションの署名付き URL で出る |
| 同 | 本人以外 | 7.1 章の手順 2 で済ませた記録を添える（本番で再度やるなら試験用の利用者を同じ手順で削除） |
| 同 | フェイルクローズ | `WEB_ALLOWED_USER_ID` 未設定 → 403 はローカルで確認（10.1 章と段階 C の受け入れ。本番ではやらない） |
| 通知が届く | 10.3 章 | |
| 公開範囲 | Actions のログ | `gh run view <id> --log > .local/run.log` → `grep -E '://|[0-9]{10,}'` と、環境変数で渡した literal（ユーザー名、project ref）の `grep -F` が 0 件。終わったら削除 |
| TLS | ローカル | 10.1 章の単体。本番は T0 の前に 1 回だけ、`DATABASE_SSL_CA` を空にした `workflow_dispatch` が `ConfigError` で止まる（平文に落ちない）ことを確認して戻す。「`sslmode=disable` でプーラーが拒否する」は `psql` で 1 回 |
| Vercel のログ | 本番 | コールバックの行に Search Params が出ることを確認し、1 時間で消えることを見る。Usage（関数の呼び出し数と実行時間）を 7 日目に記録 |

### 10.3 通知の試験（T0 の前に行う）

| 経路 | 手順 | 期待 |
|---|---|---|
| GitHub のメール（dispatch） | `workflow_dispatch` で `simulate_alert=true` | `check-alerts` が `alert=simulated` で失敗し、起動した本人にメール |
| GitHub のメール（schedule） | repo Variable `WORKER_SIMULATE_ALERT=true` を置き、次の 17 分の実行が失敗するのを待って外す | 「cron を最後に編集した人」にメールが届く（宛先の規則の確認。13 章 G3） |
| Healthchecks | チェックの詳細で ping の到着ログを見る。メールの経路は使い捨てのチェック（period 1 分、grace 1 分）を 1 回 ping して 2 分待つ | 収集を止めずに未着メールを確認 |
| Supabase | 警告メールは意図的には起こせない | 7 日間で来ないことを記録 |

---

## 11. 確認事項（ユーザーに決めてもらうこと）

| No | 内容 | 推奨 | 備考 |
|---|---|---|---|
| Q1 | Supabase のリージョン | 東京（`ap-northeast-1`） | **回答: 東京（`ap-northeast-1`）で作り直した**（最初は `ap-south-1` で作っていた）。プーラーのホストは `aws-<n>-ap-northeast-1.pooler.supabase.com` |
| Q2 | 依存パッケージの追加: `@supabase/supabase-js`、`@supabase/ssr`（Web） | 追加する | **回答: 追加する** |
| Q3 | ログインの方式 | メール＋パスワード（20 文字以上の乱数） | **回答: メール＋パスワード、8 文字以上**。推奨より短い分、`/login` の固定遅延と、Supabase 側のパスワード要件（ダッシュボードで 8 文字以上・文字種を設定）、R3 までの TOTP（Q7）で補う |
| Q4 | 死活監視 | 案 A: Healthchecks.io | **回答: 案 A。アカウント作成済み** |
| Q5 | ワーカーの実行環境 | Docker を使わず、ランナーに ffmpeg を入れて Node で直接実行 | **回答: 推奨どおり** |
| Q6 | `appsecret_proof` を R2 で入れるか | 入れる | **回答: 推奨どおり** |
| Q7 | Supabase Auth の TOTP（MFA） | R3 までに入れる | **回答: 推奨どおり** |
| Q8 | `web_app` に `raw_api_responses` の `select` を与えるか | 与えない | **回答: 推奨どおり** |
| Q9 | ローカルの `web_app` のパスワードを `seed.sql` に公知の値で置く | 置く | **回答: 推奨どおり** |
| Q10 | ワークフローのファイルを誰のアカウントでコミットするか | ユーザー本人のアカウントでコミットする | **回答: 推奨どおり**。このリポジトリのコミットはユーザーの git の身元で作られ push されるので、親が作ったコミットでも作成者はユーザーになる。念のためマージ後にユーザーが cron を一度編集して宛先を確定する |
| Q11 | Data API の公開スキーマから `public` を外す（2.6 章） | 外す | **回答: 推奨どおり** |

決定済み（レビューで確定。確認は不要）: `check-alerts` は収集の失敗後も走る（`!cancelled()`）。履歴が足りないときは判定しない。`partial`／`skipped` は失敗に数えない（`skipped` の連続は別の alert）。トークン警告は daily だけ。通知の試験は T0 の前に行う。

---

## 12. R3 への申し送り

- 生レスポンスの保存期間（NF-CAP-02）: 7 日間の実測で見込みを置き換え、180 日より古い行を消す daily のステップを R3 で足す。
- Storage のアップロード鍵の限定（S3 互換キー）と新しい API キー（`sb_secret_…`）への切り替え（U2）。
- 接続解除の画面（`accounts` とサムネイルの削除）。
- サムネイルの再取得の手段（移行でコピーに失敗したときのため）。
- 画面の作り直し（R2.5 のデザイン）時に `/login` の見た目も合わせる。
- 一時的な失敗（Meta の 5xx）でメールが増えるなら、`continue-on-error` と「2 回連続」の判定に寄せる。
- GitHub の 60 日の無効化対策の結果（55 日目に `state` を確認）を記録する。
- Ubuntu 24.04 の ffmpeg（6 系）と bookworm（5 系）でカット検出の結果が変わるかを R4 で確かめる。
- TOTP の導入（Q7）。

---

## 13. 事実の確認（確認日 2026-10-02）

| ID | 事実 | 出典 |
|---|---|---|
| S1 | 直接接続は IPv6（IPv4 アドオンは有料プランのみ）。共有プーラー（Supavisor）はすべてのプランで IPv4。セッションモードは `:5432`、トランザクションモードは `:6543`、ユーザー名は `postgres.<project-ref>`。トランザクションモードはプリペアドステートメント不可。IPv4 のみの環境として Vercel と GitHub Actions が名指しされている | https://supabase.com/docs/guides/database/connecting-to-postgres 、 https://supabase.com/docs/guides/platform/ipv4-address |
| S2 | SSL 強制はダッシュボードの Database Settings で設定し、DB が短時間再起動する。`verify-full` には Supabase の CA 証明書（`prod-ca-2021.crt`）を使う | https://supabase.com/docs/guides/platform/ssl-enforcement |
| S3 | Free プランは 7 日間の DB 活動が少ないと一時停止。「1 日に数回の要求」で足りる。約 1 週間前に警告メール。90 日以内に復元可 | https://supabase.com/docs/guides/platform/free-project-pausing |
| S4 | Free: DB 500 MB、Storage 1 GB、egress 5 GB、アクティブなプロジェクト 2 つ、プーラー接続 200（Micro） | https://supabase.com/pricing |
| S5 | 「Allow new users to sign up」をオフにすると既存の利用者だけがサインインできる | https://supabase.com/docs/guides/auth/general-configuration |
| S6 | `@supabase/ssr` のサーバークライアントは `cookies.getAll/setAll`。Next.js 16 は `proxy.ts` でセッションを更新し `getClaims()` を使う。`setAll` が最後に作ったレスポンスを返す。`getSession()` はサーバーで信用しない | https://supabase.com/docs/guides/auth/server-side/nextjs |
| S7 | S3 互換のアクセスキーは全バケットの全操作で RLS を無視。サーバー専用。エンドポイントは `https://<project-ref>.storage.supabase.co/storage/v1/s3` | https://supabase.com/docs/guides/storage/s3/authentication |
| S8 | Vault の復号ビューへのアクセスは SQL の権限で守る | https://supabase.com/docs/guides/database/vault |
| G1 | `schedule` は UTC。混雑時（毎時の始め）は遅れ、混みすぎるとキューから落ちる。最短 5 分間隔。既定ブランチのファイルだけ動く。公開リポジトリは 60 日間活動がないと自動で無効 | https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows |
| G2 | 再有効化は UI、`gh workflow enable`、REST `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable`（PAT は `repo` スコープ。`GITHUB_TOKEN` で呼べるかは明記なし） | https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow 、 https://docs.github.com/en/rest/actions/workflows |
| G3 | スケジュール実行の通知は「ワークフローを最初に作った利用者」に届く。cron を編集した人、再有効化した人に移る。失敗時だけに設定できる。dispatch の通知は起動した人 | https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/notifications-for-workflow-runs |
| G4 | 公開リポジトリの標準ランナーは無料。ジョブは最長 6 時間。Free の同時ジョブ 20 | https://docs.github.com/en/actions/administering-github-actions/usage-limits-billing-and-administration 、 https://docs.github.com/en/actions/reference/limits |
| V1 | Hobby の関数の実行時間は表で既定 10 秒、上限 60 秒（非 Fluid の列の可能性。初回デプロイで確認）。ビルド 45 分、同時ビルド 1、1 日 100 デプロイ | https://vercel.com/docs/limits |
| V2 | ランタイムログの保持は Hobby で 1 時間。ログの詳細に Request Path と Search Params が出る。閲覧はプロジェクトのメンバー | https://vercel.com/docs/logs/runtime |
| V3 | Hobby は組織所有の Git リポジトリに接続できない | https://vercel.com/docs/limits |
| N1 | Next.js 16 の `proxy.ts` は Node.js ランタイム。`runtime` の指定は不可 | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` |
| P1 | `vault.create_secret(text, text, text, uuid)`、`vault.update_secret(uuid, text, text, text, uuid)`。所有者 `supabase_admin`、`security definer`。`postgres` は `execute` を grant option つきで持つ | ローカル Supabase（Postgres 17）で `\df vault.*` |
| P2 | `public.metric_value(jsonb, text[])`。PUBLIC が実行可 | 同上 |
| P3 | `raw_api_responses` を参照するビューはない | `information_schema.view_table_usage` |
| P4 | `storage.objects` は RLS 有効、ポリシーなし、所有者 `supabase_storage_admin`。`postgres` は supautils の policy_grants で `create policy` できる | ローカルで確認 |
| P5 | `postgres` は `rolsuper=f`、`rolcreaterole=t`、`rolbypassrls=t` | 同上 |
| P6 | `public` の全テーブル・ビューに `anon`、`authenticated`、`service_role` の `arwdDxtm` が付いている（Supabase の既定権限） | 同上 |
| P7 | `pg_dump --data-only --inserts --on-conflict-do-nothing --schema=public --exclude-table-data=public.metric_definitions` は identity 列に `overriding system value` を付け、`setval` を出し、FK 順に並ぶ | ローカルで実行して確認 |
| P8 | 一時停止の判定は Postgres への接続とクエリで、プーラー経由の `postgres` も含まれる（レビューの見解。S3 の文面と整合） | S3 |

未確認（実機で確かめる）: U1 `web_app` ロールでプーラーに接続できるか（Supavisor の認証）。U2 新しい API キー（`sb_secret_…`）を Storage のアップロードに使えるか。U3 GitHub-hosted ランナーに ffmpeg が入っているか（なければ apt）。U4 `GITHUB_TOKEN` の `actions: write` で enable API が通るか、通ったとして 60 日の起算が戻るか（55 日目）。U5 Vercel が Root Directory `apps/web` でルートの lockfile を使ってビルドできるか（「Include source files outside of the Root Directory」）。U6 → P1 で肯定（ただし `store_token` 経由にしたので `web_app` への grant は不要）。U7 プーラーの証明書チェーンが `prod-ca-2021.crt` に連なるか。U8 Vercel の Fluid compute の有無と関数の既定の実行時間。

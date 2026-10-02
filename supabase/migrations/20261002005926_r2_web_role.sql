-- R2: Web（Vercel）用のロール web_app、Vault へ書く関数、anon／authenticated の既定権限の取り消し、
--     ログインした本人だけがサムネイルを読める Storage のポリシー
-- 設計: doc/design/r2-cloud.md 3 章。ロールバックは 3.4 章

-- ---------------------------------------------------------------
-- 1. web_app ロール
-- ロールはクラスタ単位で、supabase db reset で DB を作り直しても残るのでガードする。
-- login／createdb／createrole は既存のロールにも効くよう無条件に揃える。superuser と bypassrls は
-- 非スーパーユーザー（postgres）が alter で触れない（create では既定値として指定できる）ので、
-- 別の定義で先に作られていた場合は手で直す。
-- パスワードはここに書かない（本番は psql の \password web_app、ローカルは supabase/seed.sql）。
-- ---------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'web_app') then
    create role web_app login nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;
alter role web_app with login nocreatedb nocreaterole;

-- 事故対策（暴走したクエリを切る）。セッション内で上書きできるので、資格情報を持つ相手への防御ではない
alter role web_app set statement_timeout = '15s';

comment on role web_app is 'Web（Vercel）用。画面の読み出しと、接続情報（accounts、private.credentials）の更新だけ';

-- ---------------------------------------------------------------
-- 2. 権限は列挙する（all tables と default privileges は使わない）。
-- テーブルやビューを足すときは、ここに grant と 5 のポリシーを両方書く。
-- public スキーマの usage は既定で PUBLIC にある。
-- ---------------------------------------------------------------
grant usage on schema private to web_app;

-- 画面とビューが読むテーブル（raw_api_responses と job_state は与えない）
grant select on table
  public.profile_daily,
  public.account_daily_metrics,
  public.media,
  public.media_insight_snapshots,
  public.job_runs,
  public.video_analyses,
  public.video_cuts,
  public.metric_definitions
to web_app;

-- ビュー（security_invoker なので、基のテーブルの select と 5 のポリシーも要る）
grant select on table
  public.account_connection_status,
  public.job_latest_runs,
  public.media_latest_metrics,
  public.media_metrics_at_horizon,
  public.story_final_metrics,
  public.media_analysis_dataset
to web_app;

-- ビューが使う関数（関数の PUBLIC の実行権は 4 で取り消すため、明示的に与える）
grant execute on function public.metric_value(jsonb, text[]) to web_app;

-- 接続（/connect）で書くテーブル。
-- private.credentials の update は列を限定し、token_secret_id と account_id は書き換えられないようにする
-- （Vault の別の秘密を参照に付け替えてワーカーに使わせる経路を断つ。token_secret_id は 3 の関数が同期する）
grant select, insert, update on table public.accounts to web_app;
grant select, insert on table private.credentials to web_app;
grant update (token_type, expires_at, data_access_expires_at, scopes, status, last_checked_at, last_error)
  on table private.credentials to web_app;

-- ---------------------------------------------------------------
-- 3. Vault への書き込みは security definer の関数経由にする。
-- web_app は vault スキーマに触れない（読めない、任意の秘密を上書きできない）。
-- 名前は accounts.id から決まるので、別アカウントの秘密を書き換える経路はない。
-- ---------------------------------------------------------------
create or replace function private.store_token(p_account_id uuid, p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := 'ig-token-' || p_account_id::text;
  v_id uuid;
begin
  -- Graph API のトークンは印字可能な ASCII で、長くても数百文字
  if p_token is null or p_token = '' or length(p_token) > 1024 or p_token !~ '^[\x21-\x7e]+$' then
    raise exception 'token is invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.accounts where id = p_account_id) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  -- 同じアカウントへの同時呼び出しで create_secret が重ならないようにする
  perform pg_advisory_xact_lock(hashtext(v_name));
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    v_id := vault.create_secret(p_token, v_name, 'instagram-analyze: Graph API のアクセストークン');
  else
    perform vault.update_secret(v_id, p_token);
  end if;
  -- 認証情報の行があれば参照を同期する（web_app は token_secret_id を直接書けない）
  update private.credentials set token_secret_id = v_id
    where account_id = p_account_id and token_secret_id is distinct from v_id;
  return v_id;
end;
$$;

comment on function private.store_token(uuid, text) is
  'アクセストークンを Vault に保存し、vault.secrets.id を返す。名前は ig-token-<accounts.id>。あれば更新、なければ作成。private.credentials.token_secret_id も同期する';

-- ---------------------------------------------------------------
-- 4. 関数の PUBLIC の実行権を取り消す。
-- 関数は作成時に組み込みの既定で PUBLIC が実行できる。スキーマ単位の alter default privileges は組み込みの既定を
-- 打ち消せず（既定に足す方向にしか効かない）、全体の既定を変えると拡張機能の関数にも波及するので、
-- **関数を足すマイグレーションは必ず `revoke execute on function … from public` を書く**（結合テストが棚卸しする）。
-- トリガー関数（set_updated_at、private.delete_token_secret）は発火時に実行権を検査しないので影響しない。
-- ---------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema private from public;
grant execute on function private.store_token(uuid, text) to web_app;

-- ---------------------------------------------------------------
-- 5. RLS ポリシー。利用者は本人 1 人なので行の条件は true で、ロールで絞る。
-- insert … on conflict do update … returning には select、insert、update の 3 本が要る。
-- accounts の insert は件数の上限を付ける（web_app の資格情報が漏れたときに、収集対象を増やし続けられないように）。
-- ---------------------------------------------------------------
create policy web_app_select on public.accounts for select to web_app using (true);
create policy web_app_insert on public.accounts for insert to web_app
  with check ((select count(*) from public.accounts) < 10);
create policy web_app_update on public.accounts for update to web_app using (true) with check (true);

create policy web_app_select on private.credentials for select to web_app using (true);
create policy web_app_insert on private.credentials for insert to web_app with check (true);
create policy web_app_update on private.credentials for update to web_app using (true) with check (true);

create policy web_app_select on public.profile_daily for select to web_app using (true);
create policy web_app_select on public.account_daily_metrics for select to web_app using (true);
create policy web_app_select on public.media for select to web_app using (true);
create policy web_app_select on public.media_insight_snapshots for select to web_app using (true);
create policy web_app_select on public.job_runs for select to web_app using (true);
create policy web_app_select on public.video_analyses for select to web_app using (true);
create policy web_app_select on public.video_cuts for select to web_app using (true);
create policy web_app_select on public.metric_definitions for select to web_app using (true);

-- ---------------------------------------------------------------
-- 6. anon／authenticated の既定権限を取り消す。
-- Supabase の既定で public の全テーブル・ビュー・関数に権限が付いており、守りが RLS だけだった。
-- この構成はブラウザからもサーバーからも PostgREST を使わない（Data API の公開スキーマからも public を外す。設計 2.6 章）。
-- supabase_admin 側の default privileges には anon／authenticated が残るが、supabase_admin が作るオブジェクトにしか効かない
-- （マイグレーションもダッシュボードの SQL も postgres で動く）。service_role はワーカーの Storage 用に残す。
-- ---------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------
-- 7. Storage: 許可した利用者（private.web_users）だけが thumbnails バケットを読める。
-- Web は利用者のセッション（JWT）で署名付き URL を作る（設計 3.3 章）。
-- 判定は security definer の関数で行い、authenticated には private のテーブルを見せない。
-- 許可する利用者は、本番はダッシュボードの SQL エディタで insert、ローカルは seed.sql で入れる。
-- 行がなければ誰も読めない（フェイルクローズ）。insert／update／delete のポリシーは作らない（ワーカーはサービスロールで書く）。
-- ---------------------------------------------------------------
create table private.web_users (
  user_id uuid primary key,
  note text,
  created_at timestamptz not null default now()
);
comment on table private.web_users is 'Storage のサムネイルを読める Supabase Auth の利用者（auth.users.id）。Web の WEB_ALLOWED_USER_ID と同じ値を入れる';
alter table private.web_users enable row level security;   -- ポリシーなし。所有者（postgres）と下の関数だけが読む

create or replace function private.is_web_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.web_users w where w.user_id = (select auth.uid())
  );
$$;
revoke execute on function private.is_web_user() from public;
grant usage on schema private to authenticated;              -- 関数を呼ぶのに要る。テーブルの権限は与えない
grant execute on function private.is_web_user() to authenticated;

comment on function private.is_web_user() is 'ログイン中の利用者が private.web_users にあるか。auth.uid() が null なら false';

create policy thumbnails_read on storage.objects
  for select to authenticated
  using (bucket_id = 'thumbnails' and (select private.is_web_user()));

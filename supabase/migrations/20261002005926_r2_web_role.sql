-- R2: Web（Vercel）用のロール web_app、Vault へ書く関数、anon／authenticated の既定権限の取り消し、
--     ログインした本人だけがサムネイルを読める Storage のポリシー
-- 設計: doc/design/r2-cloud.md 3 章

-- ---------------------------------------------------------------
-- 1. web_app ロール
-- ロールはクラスタ単位で、supabase db reset で DB を作り直しても残るのでガードする。
-- パスワードはここに書かない（本番は psql の \password web_app、ローカルは supabase/seed.sql）。
-- ---------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'web_app') then
    create role web_app login nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

-- Vercel の関数の上限より少し長く取り、暴走したクエリを切る
alter role web_app set statement_timeout = '15s';

comment on role web_app is 'Web（Vercel）用。画面の読み出しと、接続情報（accounts、private.credentials）の更新だけ';

-- ---------------------------------------------------------------
-- 2. 権限は列挙する（all tables と default privileges は使わない）。
-- テーブルやビューを足すときは、ここに grant と 4 のポリシーを両方書く。
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

-- ビュー（security_invoker なので、基のテーブルの select と上のポリシーも要る）
grant select on table
  public.account_connection_status,
  public.job_latest_runs,
  public.media_latest_metrics,
  public.media_metrics_at_horizon,
  public.story_final_metrics,
  public.media_analysis_dataset
to web_app;

-- 接続（/connect）で書くテーブル
grant select, insert, update on table public.accounts to web_app;
grant select, insert, update on table private.credentials to web_app;

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
  if p_token is null or p_token = '' then
    raise exception 'token is empty' using errcode = '22023';
  end if;
  if not exists (select 1 from public.accounts where id = p_account_id) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  select id into v_id from vault.secrets where name = v_name;
  if v_id is null then
    v_id := vault.create_secret(p_token, v_name, 'instagram-analyze: Graph API のアクセストークン');
  else
    perform vault.update_secret(v_id, p_token);
  end if;
  return v_id;
end;
$$;

-- private スキーマには既定の ACL がなく、関数は PUBLIC が実行できてしまうので必ず取り消す
revoke all on function private.store_token(uuid, text) from public;
grant execute on function private.store_token(uuid, text) to web_app;

comment on function private.store_token(uuid, text) is
  'アクセストークンを Vault に保存し、vault.secrets.id を返す。名前は ig-token-<accounts.id>。あれば更新、なければ作成';

-- ---------------------------------------------------------------
-- 4. RLS ポリシー。利用者は本人 1 人なので行の条件は true で、ロールで絞る。
-- insert … on conflict do update … returning には select、insert、update の 3 本が要る。
-- ---------------------------------------------------------------
create policy web_app_select on public.accounts for select to web_app using (true);
create policy web_app_insert on public.accounts for insert to web_app with check (true);
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
-- 5. anon／authenticated の既定権限を取り消す。
-- Supabase の既定で public の全テーブル・ビュー・関数に権限が付いており、守りが RLS だけだった。
-- この構成はブラウザからもサーバーからも PostgREST を使わない（Data API の公開スキーマからも public を外す。設計 2.6 章）。
-- service_role はワーカーの Storage 用に残す。
-- ---------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------
-- 6. Storage: ログインした本人（匿名でない）だけが thumbnails バケットを読める。
-- Web は利用者のセッション（JWT）で署名付き URL を作る（設計 3.3 章）。
-- insert／update／delete のポリシーは作らない（ワーカーはサービスロールで書く）。
-- ---------------------------------------------------------------
create policy thumbnails_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'thumbnails'
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );

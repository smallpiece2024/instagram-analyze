-- R1: アカウントと認証情報
-- 設計: doc/design/r1-db-design.md 3.1 章、3.2 章、7 章

-- updated_at を自動で更新する共通のトリガー関数
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------
-- accounts: 対象の Instagram アカウントと接続した Facebook ページ
-- ---------------------------------------------------------------
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  ig_user_id text not null unique,
  username text,
  name text,
  fb_page_id text,
  status text not null default 'active'
    check (status in ('active', 'paused', 'disconnected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.accounts is '対象の Instagram アカウントと接続した Facebook ページ。行を消すと関連データがすべて消える';
comment on column public.accounts.ig_user_id is 'Instagram アカウントの数値 ID';
comment on column public.accounts.status is 'active: 収集中、paused: 停止、disconnected: 接続解除';

create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

alter table public.accounts enable row level security;

-- ---------------------------------------------------------------
-- private スキーマ: Supabase の API に公開しない
-- supabase/config.toml の [api].schemas に含めないこと
-- ---------------------------------------------------------------
create schema if not exists private;
grant usage on schema private to service_role;

-- トークン本体は Supabase Vault に暗号化して保存する
create extension if not exists supabase_vault;

-- ---------------------------------------------------------------
-- private.credentials: アクセストークンの参照と期限、権限
-- ---------------------------------------------------------------
create table private.credentials (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  token_type text not null check (token_type in ('PAGE', 'USER')),
  token_secret_id uuid not null,
  expires_at timestamptz,
  data_access_expires_at timestamptz,
  scopes text[],
  status text not null default 'valid'
    check (status in ('valid', 'expired', 'insufficient_scope', 'error')),
  last_checked_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table private.credentials is 'アクセストークンの参照と状態。トークン本体は Vault（vault.secrets）にあり、ここには ID だけを持つ';
comment on column private.credentials.token_secret_id is 'vault.secrets.id。トークン本体は vault.decrypted_secrets から読む';
comment on column private.credentials.expires_at is 'トークンの有効期限。期限なしは null';
comment on column private.credentials.data_access_expires_at is 'データアクセス期限。期限なしのページトークンでも約 90 日で切れる';
comment on column private.credentials.last_error is '最後のエラー。トークンを含めない';

create trigger credentials_set_updated_at
  before update on private.credentials
  for each row execute function public.set_updated_at();

alter table private.credentials enable row level security;
grant select on private.credentials to service_role;

-- 認証情報を消したら Vault のトークンも消す（接続解除時のデータ削除、NF-CMP-02）
create or replace function private.delete_token_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.token_secret_id;
  return old;
end;
$$;

create trigger credentials_delete_token_secret
  after delete on private.credentials
  for each row execute function private.delete_token_secret();

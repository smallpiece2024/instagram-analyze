-- R1: 収集したデータとジョブの記録
-- 設計: doc/design/r1-db-design.md 3.3 章〜3.9 章

-- ---------------------------------------------------------------
-- job_runs: ジョブの実行記録（収集ログ画面と通知の元）
-- ---------------------------------------------------------------
create table public.job_runs (
  id bigint generated always as identity primary key,
  job_name text not null,
  account_id uuid references public.accounts (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'success', 'partial', 'failed', 'skipped')),
  items_fetched integer,
  api_calls integer,
  error text,
  rate_usage jsonb
);

comment on table public.job_runs is 'ジョブの実行記録';
comment on column public.job_runs.status is 'running: 実行中、success: 成功、partial: 一部失敗、failed: 失敗、skipped: レート制限などで見送り';
comment on column public.job_runs.error is 'エラーの内容。トークンや取得データを含めない';
comment on column public.job_runs.rate_usage is '終了時のレート制限の使用率（X-Business-Use-Case-Usage）';

create index job_runs_name_started_idx on public.job_runs (job_name, started_at desc);
create index job_runs_account_started_idx on public.job_runs (account_id, started_at desc);

alter table public.job_runs enable row level security;

-- ---------------------------------------------------------------
-- job_state: 中断から再開するための状態（バックフィルの進み具合など）
-- ---------------------------------------------------------------
create table public.job_state (
  account_id uuid not null references public.accounts (id) on delete cascade,
  job_name text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (account_id, job_name)
);

comment on table public.job_state is 'ジョブごとの再開用の状態。例: バックフィルの次に取る日付';

create trigger job_state_set_updated_at
  before update on public.job_state
  for each row execute function public.set_updated_at();

alter table public.job_state enable row level security;

-- ---------------------------------------------------------------
-- raw_api_responses: API の生レスポンス
-- ---------------------------------------------------------------
create table public.raw_api_responses (
  id bigint generated always as identity primary key,
  account_id uuid references public.accounts (id) on delete cascade,
  job_run_id bigint references public.job_runs (id) on delete set null,
  endpoint text not null,
  params jsonb not null default '{}'::jsonb,
  api_version text not null,
  fetched_at timestamptz not null default now(),
  http_status integer not null,
  body jsonb
);

comment on table public.raw_api_responses is 'API のレスポンスを加工前のまま保存する。保存期間は R1 の実測を見て決める';
comment on column public.raw_api_responses.endpoint is '呼び出したパス。トークンを含めない';
comment on column public.raw_api_responses.params is 'クエリのパラメータ。トークンを含めない';
comment on column public.raw_api_responses.body is 'レスポンス本文。エラーのときはエラーの本文';

create index raw_api_responses_fetched_idx on public.raw_api_responses (fetched_at);
create index raw_api_responses_account_endpoint_idx
  on public.raw_api_responses (account_id, endpoint, fetched_at desc);

alter table public.raw_api_responses enable row level security;

-- ---------------------------------------------------------------
-- profile_daily: プロフィールの日次記録
-- ---------------------------------------------------------------
create table public.profile_daily (
  account_id uuid not null references public.accounts (id) on delete cascade,
  captured_on date not null,
  captured_at timestamptz not null default now(),
  followers_count integer,
  follows_count integer,
  media_count integer,
  raw_response_id bigint references public.raw_api_responses (id) on delete set null,
  primary key (account_id, captured_on)
);

comment on table public.profile_daily is 'プロフィールの日次記録。同じ日に 2 回実行したら後の値で上書きする';
comment on column public.profile_daily.captured_on is '記録した日（日本時間の日付）';
comment on column public.profile_daily.followers_count is 'フォロワー数。取れなければ null';

alter table public.profile_daily enable row level security;

-- ---------------------------------------------------------------
-- account_daily_metrics: アカウント日次指標（縦持ち）
-- ---------------------------------------------------------------
create table public.account_daily_metrics (
  account_id uuid not null references public.accounts (id) on delete cascade,
  metric_date date not null,
  metric text not null,
  breakdown text not null default '',
  breakdown_value text not null default '',
  value bigint,
  fetched_at timestamptz not null default now(),
  raw_response_id bigint references public.raw_api_responses (id) on delete set null,
  primary key (account_id, metric_date, metric, breakdown, breakdown_value)
);

comment on table public.account_daily_metrics is 'アカウント日次指標。1 行 1 指標 1 内訳。follower_count もここに入れる';
comment on column public.account_daily_metrics.metric_date is 'API の日付（米国太平洋時間の 0 時区切り）。日本時間に変換しない';
comment on column public.account_daily_metrics.breakdown is '内訳の種類（follow_type など）。内訳なしは空文字';
comment on column public.account_daily_metrics.breakdown_value is '内訳の値（FOLLOWER など）。内訳なしは空文字';
comment on column public.account_daily_metrics.value is '値。行があって null なら取得したが値が返らなかった（欠損）';

create index account_daily_metrics_metric_idx
  on public.account_daily_metrics (account_id, metric, metric_date);

alter table public.account_daily_metrics enable row level security;

-- ---------------------------------------------------------------
-- media: 投稿とストーリーズのメタ情報
-- ---------------------------------------------------------------
create table public.media (
  id text primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  media_type text not null
    check (media_type in ('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM')),
  media_product_type text not null
    check (media_product_type in ('FEED', 'REELS', 'STORY')),
  posted_at timestamptz not null,
  caption text,
  permalink text,
  thumbnail_path text,
  expires_at timestamptz,
  is_collab boolean,
  is_trial_reel boolean,
  is_boosted boolean,
  first_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  gone_at timestamptz
);

comment on table public.media is '投稿とストーリーズのメタ情報。ストーリーズは media_product_type = STORY';
comment on column public.media.id is 'Instagram のメディア ID';
comment on column public.media.thumbnail_path is 'Storage のバケット thumbnails 内のパス';
comment on column public.media.expires_at is 'ストーリーズが消える予定の時刻（投稿日時 + 24 時間）。投稿は null';
comment on column public.media.is_collab is 'コラボ投稿か。判定できなければ null';
comment on column public.media.is_trial_reel is 'お試しリールか。判定できなければ null';
comment on column public.media.is_boosted is 'ブースト投稿か。判定できなければ null';
comment on column public.media.gone_at is '投稿一覧から消えたのを検出した時刻（削除やアーカイブ）。データは残す';

create index media_account_posted_idx on public.media (account_id, posted_at desc);
create index media_account_type_posted_idx
  on public.media (account_id, media_product_type, posted_at desc);

alter table public.media enable row level security;

-- ---------------------------------------------------------------
-- media_insight_snapshots: 投稿とストーリーズの指標のスナップショット
-- ---------------------------------------------------------------
create table public.media_insight_snapshots (
  id bigint generated always as identity primary key,
  media_id text not null references public.media (id) on delete cascade,
  fetched_at timestamptz not null default now(),
  elapsed_seconds integer not null,
  metrics jsonb not null,
  raw_response_id bigint references public.raw_api_responses (id) on delete set null,
  job_run_id bigint references public.job_runs (id) on delete set null,
  unique (media_id, fetched_at)
);

comment on table public.media_insight_snapshots is '取得 1 回で 1 行。指標一式は JSON';
comment on column public.media_insight_snapshots.elapsed_seconds is '投稿からの経過秒数。実際の取得時刻から計算する';
comment on column public.media_insight_snapshots.metrics is '指標一式。キーがない: その種類では取れない指標、値が null: 取れるはずが取れなかった（欠損）、0: 実際に 0。内訳がある指標は入れ子にする';

create index media_insight_snapshots_media_elapsed_idx
  on public.media_insight_snapshots (media_id, elapsed_seconds);

alter table public.media_insight_snapshots enable row level security;

-- ---------------------------------------------------------------
-- Storage: サムネイル（非公開のバケット）
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('thumbnails', 'thumbnails', false)
on conflict (id) do nothing;

-- 上限の警告（課題 ia-6ui）: DB と Storage の容量を 1 日 1 回記録し、収集 1 回の所要をビューで出す。
-- check-alerts（ワーカー）が容量の 8 割と所要 15 分を警告し、/jobs の画面が同じ値を表示する。
-- ロールバックはこのファイルの末尾のコメント
--
-- 1. 容量を測る関数 private.capacity_snapshot()（ワーカーと pg_cron だけが呼ぶ）
-- 2. 日ごとの記録 capacity_daily（画面が読む）
-- 3. pg_cron のジョブ capacity-daily（毎日 1 回 upsert）と、適用した日の 1 行
-- 4. 収集 1 回の所要 collect_run_durations（ビュー）
-- 5. 権限と RLS

-- ---------------------------------------------------------------
-- 0. 前置き。収集のジョブと長く待ち合わないようにする（R5、R6 と同じ）
-- ---------------------------------------------------------------
set lock_timeout = '5s';

-- ---------------------------------------------------------------
-- 1. 容量を測る関数。
-- db_bytes は pg_database_size。ディスクには WAL とシステムの領域も入るので、ディスクの使用量より小さい近似値。
-- storage_bytes は storage.objects の metadata->>'size' の合計（size がない行、数値でない行は数えない）、storage_objects は行数。
-- pg_database_size が volatile なので、関数も volatile（既定）のままにする。
-- security invoker（既定）。呼ぶロールに storage.objects の select が要るので、web_app に実行権を与えても読めない。
-- web_app には与えない（画面は capacity_daily を読む）。呼ぶのは postgres（ワーカーの接続と pg_cron のジョブ）だけ
-- ---------------------------------------------------------------
create or replace function private.capacity_snapshot()
returns table (db_bytes bigint, storage_bytes bigint, storage_objects integer)
language sql
set search_path = ''
as $$
  select
    pg_catalog.pg_database_size(pg_catalog.current_database()) as db_bytes,
    coalesce(sum(case when pg_catalog.jsonb_typeof(o.metadata->'size') = 'number'
                      then (o.metadata->>'size')::numeric end), 0)::bigint as storage_bytes,
    count(*)::integer as storage_objects
  from storage.objects as o
$$;

comment on function private.capacity_snapshot() is
  '今の容量。db_bytes は pg_database_size（WAL とシステムの領域を含まない近似値）、storage_bytes と storage_objects は storage.objects の合計と件数。check-alerts と pg_cron の capacity-daily が呼ぶ';

-- R2 の決まり: 関数を足したら PUBLIC の実行権を取り消す（web-role.test.ts が棚卸しする）。web_app には与えない
revoke execute on function private.capacity_snapshot() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------
-- 2. 日ごとの記録。1 日 1 行（日付は UTC）。同じ日に測り直したら上書きする。
-- 消す仕組みは持たない（1 年で 365 行）
-- ---------------------------------------------------------------
create table public.capacity_daily (
  captured_on date primary key,
  db_bytes bigint not null constraint capacity_daily_db_bytes_nonnegative check (db_bytes >= 0),
  storage_bytes bigint not null constraint capacity_daily_storage_bytes_nonnegative check (storage_bytes >= 0),
  storage_objects integer not null constraint capacity_daily_storage_objects_nonnegative check (storage_objects >= 0),
  captured_at timestamptz not null default now()
);

comment on table public.capacity_daily is
  'DB と Storage の容量の日ごとの記録。1 日 1 行で、captured_on は UTC の日付。pg_cron の capacity-daily が private.capacity_snapshot() の値を upsert する';
comment on column public.capacity_daily.db_bytes is
  'pg_database_size（バイト）。ディスクには WAL とシステムの領域も入るので、ディスクの使用量より小さい近似値';
comment on column public.capacity_daily.storage_bytes is
  'storage.objects の metadata->>''size'' の合計（バイト）';
comment on column public.capacity_daily.storage_objects is
  'storage.objects の行数';
comment on column public.capacity_daily.captured_at is
  '最後に測った時刻。同じ日に測り直すと更新される';

-- ---------------------------------------------------------------
-- 3. ジョブ。cron.timezone は GMT（UTC）。15:07 UTC = 00:07 JST。収集の起動（毎時 17 分）と重ならない分にする。
-- 同じ名前の schedule は上書きになるので、流し直しても重ならない。pg_cron は R2（collect-dispatch）で入れてある。
-- ジョブは所有者の postgres で動く（storage.objects を読め、RLS を通らない）
-- ---------------------------------------------------------------
select cron.schedule(
  'capacity-daily',
  '7 15 * * *',
  $$insert into public.capacity_daily (captured_on, db_bytes, storage_bytes, storage_objects)
    select (now() at time zone 'utc')::date, s.db_bytes, s.storage_bytes, s.storage_objects
    from private.capacity_snapshot() as s
    on conflict (captured_on) do update set
      db_bytes = excluded.db_bytes,
      storage_bytes = excluded.storage_bytes,
      storage_objects = excluded.storage_objects,
      captured_at = now()$$
);

-- 適用した日の行を作る（ジョブと同じ文。画面が最初の 1 日を待たずに表示できる）
insert into public.capacity_daily (captured_on, db_bytes, storage_bytes, storage_objects)
select (now() at time zone 'utc')::date, s.db_bytes, s.storage_bytes, s.storage_objects
from private.capacity_snapshot() as s
on conflict (captured_on) do update set
  db_bytes = excluded.db_bytes,
  storage_bytes = excluded.storage_bytes,
  storage_objects = excluded.storage_objects,
  captured_at = now();

-- ---------------------------------------------------------------
-- 4. 収集 1 回の所要。job_runs には 1 回の実行（GitHub Actions の 1 回）を束ねる列がないので、時刻の並びで束ねる。
-- 終わった行（finished_at is not null）を started_at の順に並べ、それまでの行の finished_at の最大から
-- 次の行の started_at までが 5 分を超えたら新しい回にする。順に動くジョブでは「前の行の finished_at」と同じ値で、
-- 重なって動いた行があっても回が割れない。アカウントでは絞らない（全アカウントの合計）。
-- 所要 = その回の max(finished_at) − min(started_at)。
-- 全表を毎回なめないよう、直近 35 日に絞る（画面と警告が見るのは直近 30 日まで）。窓の端で回が切れることがある
-- ---------------------------------------------------------------
create view public.collect_run_durations
with (security_invoker = true) as
with finished as (
  select
    r.id,
    r.started_at,
    r.finished_at,
    max(r.finished_at) over (order by r.started_at, r.id rows between unbounded preceding and 1 preceding) as prev_finished_at
  from public.job_runs as r
  where r.finished_at is not null
    and r.started_at >= now() - interval '35 days'
),
numbered as (
  select
    f.started_at,
    f.finished_at,
    sum(case when f.prev_finished_at is null or f.started_at - f.prev_finished_at > interval '5 minutes' then 1 else 0 end)
      over (order by f.started_at, f.id) as run_no
  from finished as f
)
select
  min(n.started_at) as began_at,
  max(n.finished_at) as ended_at,
  extract(epoch from max(n.finished_at) - min(n.started_at))::numeric as duration_seconds,
  count(*)::integer as job_count
from numbered as n
group by n.run_no;

comment on view public.collect_run_durations is
  '収集 1 回の所要（全アカウントの合計）。終わった job_runs を started_at の順に並べ、それまでの finished_at の最大から次の started_at までが 5 分を超えたら新しい回とする。duration_seconds = max(finished_at) − min(started_at)。直近 35 日の行だけ';
comment on column public.collect_run_durations.began_at is 'その回の最初の started_at';
comment on column public.collect_run_durations.ended_at is 'その回の最後の finished_at';
comment on column public.collect_run_durations.duration_seconds is '所要（秒）';
comment on column public.collect_run_durations.job_count is 'その回に入る job_runs の行数';

-- ---------------------------------------------------------------
-- 5. 権限と RLS。R2 の決まり（表とビューは列挙して grant し、表には web_app 向けのポリシーを書く）。
-- capacity_daily は読むだけ（書くのは pg_cron の postgres）。ポリシーが using (true) なのは R2／R5／R6 と同じ考え。
-- ビューは security_invoker（基の表 job_runs の select とポリシーは R2 で済み）
-- ---------------------------------------------------------------
alter table public.capacity_daily enable row level security;

revoke all on table public.capacity_daily, public.collect_run_durations from public, anon, authenticated;

grant select on table public.capacity_daily to web_app;
create policy web_app_select on public.capacity_daily for select to web_app using (true);

grant select on table public.collect_run_durations to web_app;

-- ---------------------------------------------------------------
-- ロールバック（手で流す）
--   select cron.unschedule('capacity-daily');
--   drop view public.collect_run_durations;
--   drop table public.capacity_daily;
--   drop function private.capacity_snapshot();
-- ---------------------------------------------------------------

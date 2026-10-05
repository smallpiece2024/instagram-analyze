-- R3 の分析ビューの性能の計測（設計 doc/design/r3-analysis-screens.md 9.2 節「性能の計測」）。
-- 手で 1 回流すもの。自動テストにはしない。判定は「各クエリの実行時間（Execution Time）が 500 ms 以下」。
-- 結果は doc/progress.md に記録する。
--
-- 流し方（手元の Docker の Supabase。ローカル専用。本番には流さない）:
--   docker exec -i supabase_db_instagram-analyze psql -U postgres -v ON_ERROR_STOP=1 -f - < scripts/r3-perf-check.sql
--
-- 架空のアカウント 1 件（ig_user_id の先頭 6 桁が 0、status = 'paused'）に、合成の投稿 1,000 件（うち 5% はストーリーズ）、
-- 投稿ごとのスナップショット 14 件、日次指標 2 年分、プロフィールの日次記録 2 年分を入れ、主なクエリを explain analyze する。
-- 全体を 1 つのトランザクションで流し、最後に rollback するので、合成データは残らない（途中で失敗しても残らない）。
-- postgres で流すので RLS は効かない（テーブルの所有者）。web_app のポリシーは using (true) なので計画への影響は小さい。

\set ON_ERROR_STOP on
\timing off

begin;

set local statement_timeout = 0;

-- ---------------------------------------------------------------
-- 合成データ
-- ---------------------------------------------------------------
create temporary table perf_account on commit drop as
with a as (
  insert into public.accounts (ig_user_id, username, name, fb_page_id, status)
  values ('000000900000001', 'fake_r3_perf', 'Fake R3 Perf', '000000000000095', 'paused')
  returning id
)
select id from a;

-- 投稿 1,000 件。2 年に散らす。種類は リール 40%、フィード 40%、カルーセル 15%、ストーリーズ 5%
insert into public.media (id, account_id, media_type, media_product_type, posted_at, caption)
select
  '0000' || lpad(i::text, 12, '0'),
  (select id from perf_account),
  case when i % 20 = 0 then 'IMAGE' when i % 20 < 9 then 'VIDEO' when i % 20 < 12 then 'CAROUSEL_ALBUM' else 'IMAGE' end,
  case when i % 20 = 0 then 'STORY' when i % 20 < 9 then 'REELS' else 'FEED' end,
  now() - (i * interval '17 hours') - interval '2 hours',
  'synthetic caption ' || i
from generate_series(1, 1000) as i;

-- スナップショット: 1h〜90d の区分の少し後と、それ以降の 30 日おき（投稿の経過時間を超えるものは入れない）
insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
select
  m.id,
  m.posted_at + make_interval(secs => e.elapsed),
  e.elapsed,
  jsonb_build_object(
    'reach', 100 + (e.elapsed / 3600) % 5000,
    'views', 300 + (e.elapsed / 3600) % 9000,
    'likes', 10 + (e.elapsed / 86400) % 200,
    'comments', 1 + (e.elapsed / 86400) % 20,
    'saved', 2 + (e.elapsed / 86400) % 30,
    'shares', 1 + (e.elapsed / 86400) % 15,
    'profile_visits', 5 + (e.elapsed / 86400) % 40,
    'follows', 1,
    'reels_skip_rate', 30 + (e.elapsed % 20)
  )
from public.media m
cross join (values
  (3700), (11000), (22000), (88000), (262000), (610000), (2600000), (7800000),
  (10400000), (13000000), (15600000), (18200000), (20800000), (23400000)
) as e (elapsed)
where m.account_id = (select id from perf_account)
  and m.posted_at + make_interval(secs => e.elapsed) <= now();

-- 日次指標 2 年分（内訳なし 10 指標、follow_type の印と 2 区分を reach と views に）
insert into public.account_daily_metrics (account_id, metric_date, metric, breakdown, breakdown_value, value)
select (select id from perf_account), d::date, x.metric, x.breakdown, x.breakdown_value, (extract(doy from d)::int * 7) % 1000
from generate_series(current_date - 730, current_date - 1, interval '1 day') as d
cross join (values
  ('reach', '', ''), ('views', '', ''), ('accounts_engaged', '', ''), ('total_interactions', '', ''),
  ('likes', '', ''), ('comments', '', ''), ('shares', '', ''), ('saves', '', ''),
  ('follows_and_unfollows', '', ''), ('profile_links_taps', '', ''),
  ('reach', 'follow_type', ''), ('reach', 'follow_type', 'FOLLOWER'), ('reach', 'follow_type', 'NON_FOLLOWER'),
  ('views', 'follow_type', ''), ('views', 'follow_type', 'FOLLOWER'), ('views', 'follow_type', 'NON_FOLLOWER')
) as x (metric, breakdown, breakdown_value);

-- プロフィールの日次記録 2 年分
insert into public.profile_daily (account_id, captured_on, captured_at, followers_count)
select (select id from perf_account), d::date, d + interval '9 hours', 1000 + (current_date - d::date)
from generate_series(current_date - 730, current_date, interval '1 day') as d;

analyze public.media;
analyze public.media_insight_snapshots;
analyze public.account_daily_metrics;
analyze public.profile_daily;

select
  (select count(*) from public.media where account_id = (select id from perf_account)) as media_rows,
  (select count(*) from public.media_insight_snapshots s join public.media m on m.id = s.media_id
    where m.account_id = (select id from perf_account)) as snapshot_rows,
  (select count(*) from public.account_daily_metrics where account_id = (select id from perf_account)) as daily_rows;

-- psql の変数にアカウントと投稿 1 件を入れる
select id as perf_account_id from perf_account \gset
select media_id as perf_media_id from public.media_list_metrics
where account_id = :'perf_account_id' and kind = 'reel' order by posted_at desc limit 1 \gset

-- ---------------------------------------------------------------
-- 投稿一覧: 1 ページ（新しい順、50 件）、リーチ順、総件数、tfoot の基準値
-- ---------------------------------------------------------------
\echo '=== 投稿一覧（投稿日時の新しい順、50 件）'
explain (analyze, buffers, timing off, summary on)
select * from public.media_list_metrics
where account_id = :'perf_account_id'
order by posted_at desc, media_id
limit 50 offset 0;

\echo '=== 投稿一覧（リーチ率の高い順、null は最後、50 件）'
explain (analyze, buffers, timing off, summary on)
select * from public.media_list_metrics
where account_id = :'perf_account_id'
order by reach_rate desc nulls last, media_id
limit 50 offset 0;

\echo '=== 投稿の総件数'
explain (analyze, buffers, timing off, summary on)
select count(*) from public.media_list_metrics where account_id = :'perf_account_id';

\echo '=== 一覧の基準値（全投稿の latest の分位）'
explain (analyze, buffers, timing off, summary on)
select
  count(reach)::int as reach_n,
  percentile_cont(array[0.25, 0.5, 0.75]) within group (order by reach) as reach_q,
  percentile_cont(array[0.25, 0.5, 0.75]) within group (order by er) as er_q,
  percentile_cont(array[0.25, 0.5, 0.75]) within group (order by save_rate) as save_rate_q
from public.media_horizon_metrics
where account_id = :'perf_account_id' and horizon = 'latest';

\echo '=== リーチ率の分位'
explain (analyze, buffers, timing off, summary on)
select count(reach_rate)::int, percentile_cont(array[0.25, 0.5, 0.75]) within group (order by reach_rate)
from public.media_list_metrics
where account_id = :'perf_account_id';

-- ---------------------------------------------------------------
-- 投稿詳細: 1 件、区分ごとの値、同じ種類の比較相手の分位
-- ---------------------------------------------------------------
\echo '=== 投稿詳細（1 件）'
explain (analyze, buffers, timing off, summary on)
select * from public.media_list_metrics
where account_id = :'perf_account_id' and media_id = :'perf_media_id';

\echo '=== 投稿詳細（区分ごとの値）'
explain (analyze, buffers, timing off, summary on)
select horizon, horizon_seconds, elapsed_seconds, within_tolerance, reach, views
from public.media_horizon_metrics
where account_id = :'perf_account_id' and media_id = :'perf_media_id';

\echo '=== 投稿詳細（同じ種類の、自分を除く投稿の分位）'
explain (analyze, buffers, timing off, summary on)
select
  count(reach)::int as reach_n,
  min(reach), max(reach), avg(reach),
  percentile_cont(array[0.25, 0.5, 0.75]) within group (order by reach) as reach_q,
  count(save_rate)::int as save_rate_n,
  percentile_cont(array[0.25, 0.5, 0.75]) within group (order by save_rate) as save_rate_q,
  percentile_cont(array[0.25, 0.5, 0.75]) within group (order by skip_rate) as skip_rate_q
from public.media_horizon_metrics
where account_id = :'perf_account_id' and kind = 'reel' and media_id <> :'perf_media_id'
  and horizon = 'latest';

-- ---------------------------------------------------------------
-- 概要: 日次の範囲、90 日の日次推移、期間の投稿の合計
-- ---------------------------------------------------------------
\echo '=== 概要（日次の範囲）'
explain (analyze, buffers, timing off, summary on)
select min(metric_date), max(metric_date) filter (where reach is not null)
from public.account_daily_wide
where account_id = :'perf_account_id';

\echo '=== 概要（90 日の日次推移）'
explain (analyze, buffers, timing off, summary on)
select * from public.account_daily_wide
where account_id = :'perf_account_id'
  and metric_date between current_date - 90 and current_date - 1
order by metric_date;

\echo '=== 概要（期間の投稿の合計、90 日）'
explain (analyze, buffers, timing off, summary on)
select kind, count(*), sum(reach), sum(views), avg(er)
from public.media_list_metrics
where account_id = :'perf_account_id'
  and posted_date_pt between current_date - 90 and current_date - 1
group by kind;

-- ---------------------------------------------------------------
-- 後始末: 合成データをすべて捨てる
-- ---------------------------------------------------------------
rollback;

select count(*) as leftover_accounts from public.accounts where ig_user_id = '000000900000001';

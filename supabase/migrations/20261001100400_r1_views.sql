-- R1: ビュー
-- 設計: doc/design/r1-db-design.md 4 章、6 章
-- すべて security_invoker にし、呼び出した側の権限と行レベルセキュリティで評価する。
-- anon と authenticated にはポリシーがないので、R1 では何も読めない。

-- ---------------------------------------------------------------
-- 指標の JSON から数値を取り出す
-- 例: metric_value(metrics, '{views}')、metric_value(metrics, '{navigation,tap_exit}')
-- ---------------------------------------------------------------
create or replace function public.metric_value(metrics jsonb, path text[])
returns numeric
language sql
immutable
strict
as $$
  select (metrics #>> path)::numeric
$$;

-- ---------------------------------------------------------------
-- account_connection_status: 接続状態（F-UI-01）。トークン本体は含めない
-- ---------------------------------------------------------------
create view public.account_connection_status
with (security_invoker = true) as
select
  a.id as account_id,
  a.username,
  a.status as account_status,
  c.token_type,
  c.expires_at as token_expires_at,
  c.data_access_expires_at,
  (c.data_access_expires_at::date - current_date) as data_access_days_left,
  c.scopes,
  c.status as credential_status,
  c.last_checked_at,
  c.last_error,
  (
    select max(j.finished_at)
    from public.job_runs j
    where j.account_id = a.id and j.status in ('success', 'partial')
  ) as last_collected_at
from public.accounts a
left join private.credentials c on c.account_id = a.id;

-- ---------------------------------------------------------------
-- job_latest_runs: ジョブごとの直近の実行結果（F-UI-02）
-- ---------------------------------------------------------------
create view public.job_latest_runs
with (security_invoker = true) as
select distinct on (job_name, account_id) *
from public.job_runs
order by job_name, account_id, started_at desc;

-- ---------------------------------------------------------------
-- media_latest_metrics: 投稿ごとの最新のスナップショット（F-UI-03）
-- ---------------------------------------------------------------
create view public.media_latest_metrics
with (security_invoker = true) as
select
  m.*,
  s.fetched_at as metrics_fetched_at,
  s.elapsed_seconds,
  s.metrics
from public.media m
left join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id
  order by s.fetched_at desc
  limit 1
) s on true;

-- ---------------------------------------------------------------
-- story_final_metrics: ストーリーズごとの最後のスナップショットと、日の中での順番
-- ---------------------------------------------------------------
create view public.story_final_metrics
with (security_invoker = true) as
select
  l.*,
  (l.posted_at at time zone 'Asia/Tokyo')::date as story_day_jst,
  row_number() over (
    partition by l.account_id, (l.posted_at at time zone 'Asia/Tokyo')::date
    order by l.posted_at
  ) as story_seq,
  count(*) over (
    partition by l.account_id, (l.posted_at at time zone 'Asia/Tokyo')::date
  ) as story_count_of_day
from public.media_latest_metrics l
where l.media_product_type = 'STORY';

-- ---------------------------------------------------------------
-- media_metrics_at_horizon: 投稿からの経過時間をそろえた指標（縦長）
-- 基準の経過時間を初めて超えたスナップショットの値。実際の経過時間も返す
-- ---------------------------------------------------------------
create view public.media_metrics_at_horizon
with (security_invoker = true) as
with horizons (horizon, horizon_seconds) as (
  values
    ('1h', 3600),
    ('3h', 10800),
    ('6h', 21600),
    ('24h', 86400),
    ('3d', 259200),
    ('7d', 604800),
    ('30d', 2592000)
)
select
  m.id as media_id,
  h.horizon,
  h.horizon_seconds,
  s.fetched_at,
  s.elapsed_seconds,
  s.metrics
from public.media m
cross join horizons h
cross join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= h.horizon_seconds
  order by s.elapsed_seconds
  limit 1
) s
union all
select
  m.id as media_id,
  'latest'::text as horizon,
  null::integer as horizon_seconds,
  s.fetched_at,
  s.elapsed_seconds,
  s.metrics
from public.media m
cross join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id
  order by s.fetched_at desc
  limit 1
) s;

comment on view public.media_metrics_at_horizon is '投稿からの経過時間をそろえた指標。horizon は 1h, 3h, 6h, 24h, 3d, 7d, 30d, latest';

-- ---------------------------------------------------------------
-- media_analysis_dataset: 投稿 1 件 1 行の分析用データセット（F-COL-24）
-- 投稿の属性、動画の特徴量、経過時間をそろえた主な指標を横に並べる
-- ---------------------------------------------------------------
create view public.media_analysis_dataset
with (security_invoker = true) as
select
  -- 投稿の属性
  m.id as media_id,
  m.account_id,
  m.media_product_type,
  m.media_type,
  m.posted_at,
  (m.posted_at at time zone 'Asia/Tokyo') as posted_at_jst,
  extract(isodow from m.posted_at at time zone 'Asia/Tokyo')::integer as posted_isodow_jst,
  extract(hour from m.posted_at at time zone 'Asia/Tokyo')::integer as posted_hour_jst,
  char_length(coalesce(m.caption, '')) as caption_chars,
  (
    select count(*)
    from regexp_matches(coalesce(m.caption, ''), '#[^\s#]+', 'g')
  )::integer as hashtag_count,
  m.is_collab,
  m.is_trial_reel,
  m.is_boosted,
  m.gone_at is not null as is_gone,
  -- ストーリーズの属性
  st.story_seq,
  st.story_count_of_day,
  -- 動画の特徴量（最新の成功した解析）
  v.analyzer_version,
  v.scene_threshold,
  v.duration_ms,
  v.has_audio,
  v.cut_count,
  v.avg_scene_ms,
  v.first_cut_ms,
  v.cuts_in_first_3s,
  -- 1 時間後
  h1.elapsed_seconds as elapsed_1h,
  public.metric_value(h1.metrics, '{views}') as views_1h,
  public.metric_value(h1.metrics, '{reach}') as reach_1h,
  public.metric_value(h1.metrics, '{likes}') as likes_1h,
  public.metric_value(h1.metrics, '{comments}') as comments_1h,
  public.metric_value(h1.metrics, '{shares}') as shares_1h,
  public.metric_value(h1.metrics, '{saved}') as saved_1h,
  public.metric_value(h1.metrics, '{total_interactions}') as total_interactions_1h,
  -- 24 時間後
  h24.elapsed_seconds as elapsed_24h,
  public.metric_value(h24.metrics, '{views}') as views_24h,
  public.metric_value(h24.metrics, '{reach}') as reach_24h,
  public.metric_value(h24.metrics, '{likes}') as likes_24h,
  public.metric_value(h24.metrics, '{comments}') as comments_24h,
  public.metric_value(h24.metrics, '{shares}') as shares_24h,
  public.metric_value(h24.metrics, '{saved}') as saved_24h,
  public.metric_value(h24.metrics, '{total_interactions}') as total_interactions_24h,
  -- 7 日後
  d7.elapsed_seconds as elapsed_7d,
  public.metric_value(d7.metrics, '{views}') as views_7d,
  public.metric_value(d7.metrics, '{reach}') as reach_7d,
  public.metric_value(d7.metrics, '{likes}') as likes_7d,
  public.metric_value(d7.metrics, '{comments}') as comments_7d,
  public.metric_value(d7.metrics, '{shares}') as shares_7d,
  public.metric_value(d7.metrics, '{saved}') as saved_7d,
  public.metric_value(d7.metrics, '{total_interactions}') as total_interactions_7d,
  -- 30 日後
  d30.elapsed_seconds as elapsed_30d,
  public.metric_value(d30.metrics, '{views}') as views_30d,
  public.metric_value(d30.metrics, '{reach}') as reach_30d,
  public.metric_value(d30.metrics, '{likes}') as likes_30d,
  public.metric_value(d30.metrics, '{comments}') as comments_30d,
  public.metric_value(d30.metrics, '{shares}') as shares_30d,
  public.metric_value(d30.metrics, '{saved}') as saved_30d,
  public.metric_value(d30.metrics, '{total_interactions}') as total_interactions_30d,
  -- 最新（ストーリーズでは消えた後は最終値）
  lt.fetched_at as latest_fetched_at,
  lt.elapsed_seconds as elapsed_latest,
  public.metric_value(lt.metrics, '{views}') as views_latest,
  public.metric_value(lt.metrics, '{reach}') as reach_latest,
  public.metric_value(lt.metrics, '{likes}') as likes_latest,
  public.metric_value(lt.metrics, '{comments}') as comments_latest,
  public.metric_value(lt.metrics, '{shares}') as shares_latest,
  public.metric_value(lt.metrics, '{saved}') as saved_latest,
  public.metric_value(lt.metrics, '{total_interactions}') as total_interactions_latest,
  public.metric_value(lt.metrics, '{follows}') as follows_latest,
  public.metric_value(lt.metrics, '{profile_visits}') as profile_visits_latest,
  -- リールの視聴系（最新）
  public.metric_value(lt.metrics, '{ig_reels_avg_watch_time}') as avg_watch_time_ms_latest,
  public.metric_value(lt.metrics, '{ig_reels_video_view_total_time}') as total_watch_time_ms_latest,
  public.metric_value(lt.metrics, '{reels_skip_rate}') as skip_rate_latest,
  -- ストーリーズの操作（最新）
  public.metric_value(lt.metrics, '{replies}') as replies_latest,
  public.metric_value(lt.metrics, '{navigation,tap_forward}') as tap_forward_latest,
  public.metric_value(lt.metrics, '{navigation,tap_back}') as tap_back_latest,
  public.metric_value(lt.metrics, '{navigation,tap_exit}') as tap_exit_latest,
  public.metric_value(lt.metrics, '{navigation,swipe_forward}') as swipe_forward_latest,
  public.metric_value(lt.metrics, '{link_clicks}') as link_clicks_latest
from public.media m
left join lateral (
  select
    count(*) filter (where s2.posted_at <= m.posted_at)::integer as story_seq,
    count(*)::integer as story_count_of_day
  from public.media s2
  where s2.account_id = m.account_id
    and s2.media_product_type = 'STORY'
    and (s2.posted_at at time zone 'Asia/Tokyo')::date = (m.posted_at at time zone 'Asia/Tokyo')::date
) st on m.media_product_type = 'STORY'
left join lateral (
  select v.*
  from public.video_analyses v
  where v.media_id = m.id and v.status = 'success'
  order by v.analyzed_at desc
  limit 1
) v on true
left join lateral (
  select s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= 3600
  order by s.elapsed_seconds
  limit 1
) h1 on true
left join lateral (
  select s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= 86400
  order by s.elapsed_seconds
  limit 1
) h24 on true
left join lateral (
  select s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= 604800
  order by s.elapsed_seconds
  limit 1
) d7 on true
left join lateral (
  select s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= 2592000
  order by s.elapsed_seconds
  limit 1
) d30 on true
left join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id
  order by s.fetched_at desc
  limit 1
) lt on true;

comment on view public.media_analysis_dataset is '投稿 1 件 1 行の分析用データセット。SQL、CSV、Python で分析する。画面では使わない';

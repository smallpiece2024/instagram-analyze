-- R6 の受け入れ（設計 doc/design/r6-report.md 7.3 節、8 章の段階 5）で本番の数を数える SQL。
-- クラウドの Supabase の SQL エディタに貼って実行する（読むだけ。書き込みはない）。
-- 結果は `.local/`（Git 管理外）に置き、文書には決定と件数だけを書く（S3、D14）。
-- アカウントの ID やユーザー名は出さない（group by に account_id を使わない。本番のアカウントは 1 つ）。

-- 0. 照合順序と制御文字の判定（段階 1 の申し送り。手元は ICU で U+2028 と ZWJ が通り、CR とタブは拒む）
select datcollate, datctype, datlocprovider from pg_database where datname = current_database();
select 'U+2028' as ch, E'\u2028' ~ '[[:cntrl:]]' as is_cntrl
union all select 'U+2029', E'\u2029' ~ '[[:cntrl:]]'
union all select 'ZWJ U+200D', E'\u200d' ~ '[[:cntrl:]]'
union all select 'TAB', E'\t' ~ '[[:cntrl:]]'
union all select 'CR', E'\r' ~ '[[:cntrl:]]';

-- 1. 種類ごとの投稿数、判定対象（share_flag が null でない）、印の件数、シェア率 null、直前 20 件の Q3 = 0（T13、D4）
select
  kind,
  count(*)                                        as posts,
  count(share_flag)                               as judged,
  count(*) filter (where share_flag = 'high')     as high,
  count(*) filter (where share_flag = 'low')      as low,
  count(*) filter (where share_flag = 'none')     as none,
  count(*) filter (where share_rate is null)      as share_rate_null,
  count(*) filter (where peer_q3 = 0)             as q3_zero,
  count(*) filter (where peer_n < 8)              as peer_lt_8
from public.media_outlier_flags
group by kind
order by kind;

-- 2. 消えた投稿（gone_at）の数と、投稿から消すまでの日数（T18。件数と日数だけ）
select
  count(*)                                                                  as gone_posts,
  round(min(extract(epoch from (gone_at - posted_at)) / 86400)::numeric, 1) as min_days,
  round((percentile_cont(0.5) within group (order by extract(epoch from (gone_at - posted_at)) / 86400))::numeric, 1) as median_days,
  round(max(extract(epoch from (gone_at - posted_at)) / 86400)::numeric, 1) as max_days
from public.media
where gone_at is not null and media_product_type <> 'STORY';

-- 3. 日次指標の日数と、非フォロワーリーチの内訳がある日数
select
  count(*)                                                                      as days_total,
  count(*) filter (where reach is not null)                                     as days_with_reach,
  count(*) filter (where reach is not null and reach_non_follower is not null)  as days_with_breakdown,
  min(metric_date)                                                              as first_day,
  max(metric_date) filter (where reach is not null)                             as latest_day
from public.account_daily_wide;

-- 4. profile_daily の欠けた日（フォロワー数のある記録の範囲と行数の差）
select
  count(*)                                              as rows_with_followers,
  min(captured_on)                                      as first_day,
  max(captured_on)                                      as last_day,
  (max(captured_on) - min(captured_on) + 1) - count(*)  as missing_days
from public.profile_daily
where followers_count is not null;

-- 5. 直近から 7 日ごとの非フォロワーリーチ比率と投稿数（T6。Q9 の判断は済みだが、通知の鳴り方の見込みに使う）
with latest as (
  select max(metric_date) as d from public.account_daily_wide where reach is not null
),
windows as (
  select k, (select d from latest) - k * 7 as window_end from generate_series(0, 7) as k
)
select
  w.window_end - 6                                                       as window_start,
  w.window_end,
  count(a.metric_date)                                                   as days_used,
  round(100.0 * sum(a.reach_non_follower) / nullif(sum(a.reach), 0), 1) as non_follower_pct,
  (select count(*) from public.media m
     where m.media_product_type <> 'STORY'
       and (m.posted_at at time zone 'America/Los_Angeles')::date between w.window_end - 6 and w.window_end) as posts
from windows w
left join public.account_daily_wide a
  on a.metric_date between w.window_end - 6 and w.window_end
 and a.reach is not null and a.reach_non_follower is not null
group by w.k, w.window_end
order by w.k;

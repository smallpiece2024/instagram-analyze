-- R6: 月次レポート、伸びた投稿の検出、低下の通知
-- 設計: doc/design/r6-report.md 3.2 節（ビューの SQL）、5 章（5.1〜5.4 節）。ロールバックはこのファイルの末尾のコメント
--
-- 1. 記入欄 report_notes（総評と翌月の施策）。Web（web_app）が upsert する
-- 2. 伸びた投稿の判定 media_outlier_flags（ビュー。ワーカーのジョブは足さない）
-- 3. 権限と RLS
-- 関数は足さない（web-role.test.ts の関数の棚卸しは変わらない）

-- ---------------------------------------------------------------
-- 0. 前置き。収集のジョブと長く待ち合わないようにする（R5 と同じ。ビューの作成は基の表の AccessShareLock だけ）
-- ---------------------------------------------------------------
set lock_timeout = '5s';

-- ---------------------------------------------------------------
-- 1. 記入欄。アカウントごと月ごとに 1 行。履歴（版）は持たず上書きだけ（R5 のタグと同じ）。
-- 月の列は date（1 日固定）。列名は report_month（month はキーワードと同じ綴り。D8）。
-- check は extract(day from …) = 1（date_trunc('month', date) は timestamptz 版に解決されてセッションの TZ に依存する）。
-- 文字数の上限 2,000（Q13）。char_length はコードポイントの数で、画面の [...s].length と同じ。
-- 改行（LF）は許し、ほかの制御文字（[[:cntrl:]]。CR、タブを含む）は拒む（D7）。[[:print:]] は照合順序に依存する
-- （C 照合では日本語も絵文字も printable でない）ので使わない。CR は Action が \n に正規化してから書く（6.2 節）。
-- 制約には名前を付ける（D9）。索引は主キーだけ（アカウント × 月で引く）
-- ---------------------------------------------------------------
create table public.report_notes (
  account_id uuid not null references public.accounts (id) on delete cascade,
  report_month date not null
    constraint report_notes_month_is_first_day check (extract(day from report_month) = 1),   -- 月の 1 日（D8）
  summary text not null default ''
    constraint report_notes_summary_length check (char_length(summary) <= 2000)
    constraint report_notes_summary_chars check (translate(summary, E'\n', '') !~ '[[:cntrl:]]'),   -- 改行以外の制御文字を拒む（D7）
  next_plan text not null default ''
    constraint report_notes_next_plan_length check (char_length(next_plan) <= 2000)
    constraint report_notes_next_plan_chars check (translate(next_plan, E'\n', '') !~ '[[:cntrl:]]'),
  updated_at timestamptz not null default now(),
  primary key (account_id, report_month)
);

comment on table public.report_notes is
  '月次レポートの記入欄（総評と翌月の施策）。report_month は月の 1 日。アカウントごと月ごとに 1 行。Web（web_app）が upsert する';

-- updated_at は既存の public.set_updated_at() のトリガーで入れる（Server Action では入れない）。
-- 同じ値で upsert しても on conflict do update は update なので updated_at が進む（D9）
create trigger report_notes_set_updated_at before update on public.report_notes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- 2. 伸びた投稿の判定（3.1 節、3.2 節）。統計だけで判定する（AI-01）。
-- 投稿ごとに、同じアカウント・同じ種類（kind）の直前 20 投稿のシェア率の分布を取り、四分位で外れ値を判定する（Tukey の fence）。
-- share_rate の式は media_list_metrics（R3）と同じ（shares ÷ reach。reach が 0 か null なら null）。
-- 軽い基（media + 最新のスナップショット 1 件）を materialized で 1 回だけ作り、その上で直前 20 件を lateral で切る（D3）。
-- percentile_cont は順序集合の集約で窓関数としては使えず、rows between … の窓は除外する投稿も行として数えるので、
-- lateral の副問い合わせで条件つきの 20 件を切ってから集約する。
-- 式を 2 か所に持つので、全行で media_outlier_flags.share_rate = media_list_metrics.share_rate を結合テストで確かめる（D13 (e)）。
-- 定数（係数 1.5、最小件数 8）は params の 1 か所（D6）。Q5／Q6 で変えたら create or replace view と comment を直す
-- ---------------------------------------------------------------
create view public.media_outlier_flags
with (security_invoker = true) as
with base as materialized (
  select
    m.id as media_id, m.account_id,
    public.media_kind(m.media_product_type, m.media_type) as kind,
    m.posted_at, s.elapsed_seconds as elapsed_latest,
    public.metric_value(s.metrics, '{shares}') / nullif(public.metric_value(s.metrics, '{reach}'), 0) as share_rate,
    -- 本番では 3 列とも null。null は「判定できない」で、特殊とは扱わない（D1）。
    -- not s.is_boosted and … と書くと null → 偽で本番の全投稿が比較対象から消え、印が 1 件も付かない
    (m.is_boosted is true or m.is_collab is true or m.is_trial_reel is true) as is_special
  from public.media m
  left join lateral (
    select s.elapsed_seconds, s.metrics from public.media_insight_snapshots s
    where s.media_id = m.id order by s.fetched_at desc limit 1
  ) s on true
  where m.media_product_type <> 'STORY'
),
params as (select 1.5::float8 as k, 8 as min_n)
select
  b.media_id, b.account_id, b.kind, b.posted_at, b.share_rate, b.elapsed_latest,
  p.n as peer_n, p.q1 as peer_q1, p.median as peer_median, p.q3 as peer_q3,
  p.iqr as peer_iqr, p.upper as peer_upper, p.lower as peer_lower,
  case
    when b.share_rate is null or p.n < params.min_n then null
    when b.share_rate > p.upper then 'high'
    when b.share_rate < p.lower then 'low'
    else 'none'
  end as share_flag
from base b
cross join params
cross join lateral (
  -- fence は副問い合わせで 1 回だけ計算し、列と判定で同じ値を使う（D5）
  select q.n, q.q1, q.median, q.q3, (q.q3 - q.q1) as iqr,
         q.q3 + params.k * (q.q3 - q.q1) as upper,
         q.q1 - params.k * (q.q3 - q.q1) as lower
  from (
    select count(*)::int as n,
      percentile_cont(0.25) within group (order by r.share_rate) as q1,
      percentile_cont(0.5)  within group (order by r.share_rate) as median,
      percentile_cont(0.75) within group (order by r.share_rate) as q3
    from (
      -- 除かれた投稿（シェア率 null、特殊）は 20 件の枠を使わない。消えた投稿（gone_at）は除かない
      select s.share_rate from base s
      where s.account_id = b.account_id and s.kind = b.kind
        and (s.posted_at, s.media_id) < (b.posted_at, b.media_id)   -- 同時刻は id で順を固定（T3）
        and s.share_rate is not null and not s.is_special
      order by s.posted_at desc, s.media_id desc
      limit 20
    ) r
  ) q
) p;

comment on view public.media_outlier_flags is
  '投稿（ストーリーズを除く）ごとのシェア率の外れ値の判定。比較対象は同じ種類の直前 20 投稿（特殊な投稿とシェア率 null を除く。フラグが null の投稿は含む）。fence は 1.5 × IQR。8 件未満は判定しない（share_flag は null）。none は判定したが印なし。share_rate の式は media_list_metrics と同じ';
comment on column public.media_outlier_flags.share_flag is
  'high: share_rate > peer_upper、low: share_rate < peer_lower、none: 判定したが印なし。null: 判定しない（比較対象が 8 件未満かシェア率 null）';
comment on column public.media_outlier_flags.peer_n is
  '比較対象の件数（最大 20）。判定しない行でも出す';

-- ---------------------------------------------------------------
-- 3. 権限と RLS。R2 の決まり（表とビューは列挙して grant し、表には web_app 向けのポリシーを書く）。
-- insert と update は列で与える。updated_at はトリガーが入れるので insert でも update でも書けない（S7）。
-- report_month と account_id は update で変えない。delete は与えない（画面に消す操作がない。空にするのは update）。
-- ポリシーが using (true) なのは R2／R5 と同じ考え（誰が使えるかは proxy と checkAccess、対象のアカウントは SQL の account_id で絞る）。
-- on conflict do update の upsert には insert（列指定）と update（列指定）の両方の権限が要る。列の指定で足りることは結合テストで確かめる。
-- service_role には既定で全権が付く（R2 で意図的に残した方針。D10）
-- ---------------------------------------------------------------
alter table public.report_notes enable row level security;

-- anon／authenticated の revoke は既定で権限がないので冗長だが、R5 と同じ形で書く（害なし。D10）
revoke all on table public.report_notes, public.media_outlier_flags from public, anon, authenticated;

grant select on table public.report_notes to web_app;
grant insert (account_id, report_month, summary, next_plan) on table public.report_notes to web_app;   -- updated_at は insert でも書けない（S7）
grant update (summary, next_plan) on table public.report_notes to web_app;   -- updated_at はトリガー、report_month と account_id は変えない

create policy web_app_select on public.report_notes for select to web_app using (true);
create policy web_app_insert on public.report_notes for insert to web_app with check (true);
create policy web_app_update on public.report_notes for update to web_app using (true) with check (true);
-- delete は与えない（画面に消す操作がない。空にするのは update）

-- ビュー（security_invoker。基の表 media、media_insight_snapshots の select とポリシーは R2／R3 で済み）
grant select on table public.media_outlier_flags to web_app;

-- ---------------------------------------------------------------
-- ロールバック（手で流す。順番が大事）
-- ---------------------------------------------------------------
-- 1. 先に Web を R6 より前の版に戻す
-- 2. 利用者が書いた総評と施策を退避する（D11）: copy (select * from public.report_notes) to stdout with (format csv, header)
-- drop view if exists public.media_outlier_flags;
-- drop table if exists public.report_notes;   -- 利用者が書いた総評と施策も消える
-- delete from supabase_migrations.schema_migrations where version = '20261013000000';

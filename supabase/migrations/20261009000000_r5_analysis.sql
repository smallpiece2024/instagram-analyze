-- R5: 独自タグ、属性の週次記録、ハッシュタグ、ストーリーズの一覧
-- 設計: doc/design/r5-analysis.md 5 章（5.1 節、5.2 節）。ロールバックはこのファイルの末尾のコメント
--
-- 1. 独自タグ（tag_axes、tag_values、media_tags）。Web（web_app）から書く初めての利用者のデータ
-- 2. 属性の週次記録（audience_captures、audience_values）。書くのはワーカー
-- 3. ハッシュタグ（caption_hashtags()、media_hashtags）。保存せずビューで抜き出す
-- 4. ストーリーズの一覧（story_list_metrics）
-- 5. 権限と RLS

-- ---------------------------------------------------------------
-- 0. 前置き。media に一意制約を足すときに、収集のジョブと長く待ち合わないようにする（D3）
-- ---------------------------------------------------------------
set lock_timeout = '5s';

-- ---------------------------------------------------------------
-- 1. 独自タグ。軸ごとに投稿 1 件につき値は 1 つ（確認事項 Q2）。
-- アカウントの食い違い（別のアカウントの投稿に別のアカウントの軸や値を付ける）は複合の外部キーで拒む。
-- 名前の check（D15）は画面の検査（S8）の後ろの守り。char_length はコードポイントの数で、画面の [...s].length と同じ。
-- 件数の上限（軸 10、値 50）は画面だけで検査する（5.1 (5)）
-- ---------------------------------------------------------------
create table public.tag_axes (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  name text not null
    check (char_length(name) between 1 and 30 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (account_id, name),
  unique (id, account_id)            -- media_tags の複合の外部キーの相手
);

comment on table public.tag_axes is '独自タグの軸（テーマ、目的など）。アカウントごと。消すと値と投稿への対応も消える';

create table public.tag_values (
  id bigint generated always as identity primary key,
  axis_id bigint not null references public.tag_axes (id) on delete cascade,
  name text not null
    check (char_length(name) between 1 and 30 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (axis_id, name),
  unique (id, axis_id)               -- media_tags の複合の外部キーの相手
);

comment on table public.tag_values is '独自タグの値。投稿に付いている値は消せない（media_tags の外部キーが no action）';

-- media の (id, account_id) に一意制約を足す（id が主キーなので中身は変わらない。外部キーの相手にするため）
alter table public.media add constraint media_id_account_key unique (id, account_id);

create table public.media_tags (
  media_id text not null,
  account_id uuid not null,
  axis_id bigint not null,
  value_id bigint not null,
  updated_at timestamptz not null default now(),
  primary key (media_id, axis_id),                                                 -- 軸ごとに 1 つ
  foreign key (media_id, account_id) references public.media (id, account_id) on delete cascade,
  foreign key (axis_id, account_id) references public.tag_axes (id, account_id) on delete cascade,
  -- 既定の no action（D2）。文の終わりに検査されるので、軸を消したときの連鎖（軸 → 値、軸 → 対応）は
  -- 消える順に左右されず通る。値だけを消すときは、付いている投稿があれば 23503 で拒む
  foreign key (value_id, axis_id) references public.tag_values (id, axis_id)
);

comment on table public.media_tags is '投稿と独自タグの値の対応（軸ごとに 1 つ）。投稿の種類は DB では問わない（画面はストーリーズに付けない）';

create index media_tags_axis_value_idx on public.media_tags (axis_id, value_id);   -- 軸ごとの集計、値ごとの件数、外部キーの検査（D13）

-- updated_at は既存の public.set_updated_at() のトリガーで入れる（D14。Server Action では入れない）
create trigger tag_axes_set_updated_at before update on public.tag_axes
  for each row execute function public.set_updated_at();
create trigger tag_values_set_updated_at before update on public.tag_values
  for each row execute function public.set_updated_at();
create trigger media_tags_set_updated_at before update on public.media_tags
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- 2. 属性の週次記録。組（指標 × timeframe × 内訳）ごと、週ごとに 1 行。
-- status: ok は値の行が 1 件以上、empty は取ったが区分が返らなかった。行がないのは「その週は取れていない」。
-- check の列挙は、Meta が値を増やしたら書き込みが失敗して分かるようにするため（黙って捨てない）
-- ---------------------------------------------------------------
create table public.audience_captures (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  metric text not null check (metric in ('follower_demographics', 'engaged_audience_demographics')),
  timeframe text not null check (timeframe in ('this_week', 'this_month')),        -- D8
  breakdown text not null check (breakdown in ('age', 'gender', 'country', 'city')),
  week_start date not null check (extract(isodow from week_start) = 1),            -- JST の月曜（D9）
  status text not null check (status in ('ok', 'empty')),
  fetched_at timestamptz not null,
  raw_response_id bigint references public.raw_api_responses (id) on delete set null,
  -- 列の順は、画面の「その組の週の推移」とワーカーの「その週の行があるか」の両方で先頭から使える順（D12）
  unique (account_id, metric, timeframe, breakdown, week_start)
);

comment on table public.audience_captures is
  'フォロワー属性と反応したユーザーの属性の週次の取得記録（audience_demographics ジョブ）。week_start は JST の月曜。ok は値の行が 1 件以上、empty は区分が返らなかった（100 未満など）';

create table public.audience_values (
  capture_id bigint not null references public.audience_captures (id) on delete cascade,
  value_key text not null check (char_length(value_key) between 1 and 200),
  value bigint not null check (value >= 0),
  primary key (capture_id, value_key)
);

comment on table public.audience_values is
  '属性の区分ごとの人数（API が返した上位 45 件まで）。年齢は value_key の文字列の順が若い順（D10）';

-- ---------------------------------------------------------------
-- 3. ハッシュタグ。ビューで抜き出す（保存しない。確認事項 Q5）。
-- 先にキャプション全体を NFKC にする（＃、全角空白、全角の英数と句読点、半角カナがそろう。D6）。
-- タグの文字は英数字、_、ひらがな、カタカナ（長音、ヶ を含む）、漢字、々、〆（Q6）。ほかの文字、絵文字、句読点で終わる。
-- 英数字、_、&、/ の直後の # は数えない（URL の中など）。数字だけのタグは数えない。英字は小文字にそろえ、1 投稿の中の重複は 1 つ
-- ---------------------------------------------------------------
create or replace function public.caption_hashtags(p_caption text)
returns setof text
language sql
stable
parallel safe
as $$
  select distinct lower(m[1])
  from regexp_matches(
    normalize(coalesce(p_caption, ''), NFKC),
    '(?:^|[^0-9A-Za-z_&/])#([0-9A-Za-z_ぁ-ゖァ-ヺー々〆ヶ一-鿿]+)',
    'g'
  ) as m
  where m[1] !~ '^[0-9]+$'
$$;

comment on function public.caption_hashtags(text) is
  'キャプションのハッシュタグ（NFKC、小文字、重複なし）。media_analysis_dataset.hashtag_count（#[^\s#]+ の数）とは数え方が違う。索引には使わない（D5）';

-- R2 の決まり: 関数を足したら PUBLIC の実行権を取り消す（web-role.test.ts が棚卸しする）
revoke execute on function public.caption_hashtags(text) from public;
grant execute on function public.caption_hashtags(text) to web_app;

create view public.media_hashtags
with (security_invoker = true) as
select m.id as media_id, m.account_id, h.tag
from public.media m
cross join lateral public.caption_hashtags(m.caption) as h(tag)
where m.media_product_type <> 'STORY';

comment on view public.media_hashtags is
  '投稿（ストーリーズを除く）ごとのハッシュタグ。1 投稿 1 タグ 1 行。抜き出しの規則は caption_hashtags()';

-- ---------------------------------------------------------------
-- 4. ストーリーズの一覧。確定値（story_final_metrics）と、閲覧率の分母の投稿時のフォロワー数
-- ---------------------------------------------------------------
create view public.story_list_metrics
with (security_invoker = true) as
select
  f.id as media_id, f.account_id, f.media_type, f.posted_at, f.thumbnail_path, f.gone_at,
  f.story_day_jst, f.story_seq, f.story_count_of_day,
  f.metrics_fetched_at, f.elapsed_seconds,
  public.metric_value(f.metrics, '{views}') as views,
  public.metric_value(f.metrics, '{reach}') as reach,
  public.metric_value(f.metrics, '{navigation,tap_forward}') as tap_forward,
  public.metric_value(f.metrics, '{navigation,tap_back}') as tap_back,
  public.metric_value(f.metrics, '{navigation,tap_exit}') as tap_exit,
  public.metric_value(f.metrics, '{navigation,swipe_forward}') as swipe_forward,
  public.metric_value(f.metrics, '{link_clicks}') as link_clicks,
  public.metric_value(f.metrics, '{replies}') as replies,
  pf.followers_count as followers_at_post,
  pf.captured_at as followers_captured_at,
  public.metric_value(f.metrics, '{views}') / nullif(pf.followers_count, 0) as view_rate,
  public.metric_value(f.metrics, '{navigation,tap_exit}') / nullif(public.metric_value(f.metrics, '{views}'), 0) as exit_rate
from public.story_final_metrics f
left join lateral (
  -- media_list_metrics.followers_at_post と同じ規則（投稿より前で 3 日以内の最も近い記録）。
  -- 規則を変えるときは 20261005000000_r3_analysis_views.sql の media_list_metrics も変える
  select p.followers_count, p.captured_at
  from public.profile_daily p
  where p.account_id = f.account_id
    and p.captured_at <= f.posted_at
    and p.captured_at >= f.posted_at - interval '3 days'
  order by p.captured_at desc
  limit 1
) pf on true;

comment on view public.story_list_metrics is
  'ストーリーズ 1 件 1 行の確定値（消える 0〜60 分前の値）。投稿時のフォロワー数は media_list_metrics と同じ規則（投稿より前で 3 日以内の最も近い profile_daily）';
comment on column public.story_list_metrics.view_rate is
  '閲覧率 = views ÷ followers_at_post。どちらかがなければ null';
comment on column public.story_list_metrics.exit_rate is
  '離脱率 = tap_exit ÷ views。閲覧が 0 か null なら null';

-- 規則を 2 か所で持つので、R3 のビューの comment からも参照する（D7。ビューは作り直さない）
comment on view public.media_list_metrics is
  '投稿一覧（ストーリーズを除く）。指標は最新のスナップショット。リーチ率は 7 日時点（許容幅内）のリーチ ÷ 投稿前 3 日以内の記録のフォロワー数。投稿時のフォロワー数の規則を変えるときは story_list_metrics（20261009000000_r5_analysis.sql）も変える';

-- ---------------------------------------------------------------
-- 5. 権限と RLS。R2 の決まり（表とビューは列挙して grant し、表には web_app 向けのポリシーを書く）。
-- update は列で与える（S5）。updated_at はトリガーが入れるので与えない（Server Action が書かない列は書けないほうが狭い）。
-- ポリシーが using (true) なのは R2 と同じ考え（誰が使えるかは checkAccess、対象のアカウントは SQL の account_id で絞る）。
-- identity の列への insert は表の insert の権限だけで足りる（sequence の権限は要らない。結合テストで確かめる）
-- ---------------------------------------------------------------
alter table public.tag_axes enable row level security;
alter table public.tag_values enable row level security;
alter table public.media_tags enable row level security;
alter table public.audience_captures enable row level security;
alter table public.audience_values enable row level security;

revoke all on table public.tag_axes, public.tag_values, public.media_tags,
  public.audience_captures, public.audience_values, public.media_hashtags, public.story_list_metrics
  from public, anon, authenticated;

-- タグ: Web から読み書きする
grant select, insert, delete on table public.tag_axes, public.tag_values, public.media_tags to web_app;
grant update (name, sort_order) on table public.tag_axes to web_app;
grant update (name, sort_order) on table public.tag_values to web_app;
grant update (value_id) on table public.media_tags to web_app;

-- ポリシーは操作ごとに 4 本（R2 の書き方。for all は使わない）
create policy web_app_select on public.tag_axes for select to web_app using (true);
create policy web_app_insert on public.tag_axes for insert to web_app with check (true);
create policy web_app_update on public.tag_axes for update to web_app using (true) with check (true);
create policy web_app_delete on public.tag_axes for delete to web_app using (true);

create policy web_app_select on public.tag_values for select to web_app using (true);
create policy web_app_insert on public.tag_values for insert to web_app with check (true);
create policy web_app_update on public.tag_values for update to web_app using (true) with check (true);
create policy web_app_delete on public.tag_values for delete to web_app using (true);

create policy web_app_select on public.media_tags for select to web_app using (true);
create policy web_app_insert on public.media_tags for insert to web_app with check (true);
create policy web_app_update on public.media_tags for update to web_app using (true) with check (true);
create policy web_app_delete on public.media_tags for delete to web_app using (true);

-- 属性: 読むだけ（書くのはワーカー）
grant select on table public.audience_captures, public.audience_values to web_app;
create policy web_app_select on public.audience_captures for select to web_app using (true);
create policy web_app_select on public.audience_values for select to web_app using (true);

-- ビュー（security_invoker なので、基の表の select とポリシーも要る）
grant select on table public.media_hashtags, public.story_list_metrics to web_app;

-- ---------------------------------------------------------------
-- ロールバック（手で流す。順番が大事）
-- ---------------------------------------------------------------
-- 1. 先にワーカーを R5 より前の版に戻す（audience_demographics が表に書くため）。Web も R5 より前に戻す
-- drop view if exists public.story_list_metrics;
-- drop view if exists public.media_hashtags;
-- drop function if exists public.caption_hashtags(text);
-- drop table if exists public.audience_values, public.audience_captures;
-- drop table if exists public.media_tags, public.tag_values, public.tag_axes;   -- 利用者が付けたタグも消える
-- alter table public.media drop constraint if exists media_id_account_key;
-- comment on view public.media_list_metrics is '投稿一覧（ストーリーズを除く）。指標は最新のスナップショット。リーチ率は 7 日時点（許容幅内）のリーチ ÷ 投稿前 3 日以内の記録のフォロワー数';
-- delete from supabase_migrations.schema_migrations where version = '20261009000000';

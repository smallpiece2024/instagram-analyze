# R5 投稿分類、ストーリーズ、オーディエンス、投稿時刻の分析の設計

- 版: 0.1（2026-10-08）。起草。確認事項（9 章）は未回答

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-08 | 起草（`nextjs-developer`。親が 2026-10-08 に確かめた事実票をもとにする） |

- 要件: `doc/requirements/requirements-definition.md` 4.6 章（F-UI-30〜32、F-UI-40〜42、F-COL-30）、5.1 章（独自タグ、属性データの週次記録）、5.2 章（属性データは週 1 回）、5.5 章（時刻）、7 章（指標の定義）、9 章（画面一覧）、10 章（R5 の完了条件「タグを付けた投稿の比較、ストーリーズの離脱ファネル、属性の推移が表示される」）
- 既存: R1 のビュー（`20261001100400_r1_views.sql` の `story_final_metrics`、`media_analysis_dataset`）、R2 の `web_app` ロール（`20261002005926_r2_web_role.sql`）、R3 のビュー（`20261005000000_r3_analysis_views.sql`）、R4 のビュー（`20261007000000_r4_video.sql`）、R3 と R4 の画面（`doc/design/r3-analysis-screens.md`、`doc/design/r4-video-analysis.md`）、ワーカーの `jobs/profile-daily.ts` と `jobs/groups.ts`
- デザイン: `doc/design-system.md`、`doc/design-lab/v3/render.js` の `S.stories`（ストーリーズ）と `S.timing`（投稿時刻）。タグ分析とオーディエンスは見本がないので、既存の部品の組み合わせで案を書く（見た目は実装後にユーザーが確かめる）

この文書で「未確認」と書いたものは、起草時に確かめられなかった事実。実装の前に確かめる。外部の事実（Meta API）は、親が 2026-10-08 に確かめた事実票（付録 A）だけを根拠にした。

---

## 1. 目的と範囲

### 1.1 R5 でやること

| 区分 | 内容 | 要件 |
|---|---|---|
| 収集 | フォロワー属性と反応したユーザーの属性を週 1 回保存するジョブ `audience_demographics` を daily グループに足す | F-COL-30 |
| DB | 独自タグの表 3 つ（軸、値、投稿との対応）。属性の表 2 つ。ハッシュタグを抜き出す関数とビュー、ストーリーズの一覧のビュー。タグの表だけ `web_app` に書き込みの権限を与える | F-UI-30、F-UI-32、F-UI-40、F-COL-30 |
| 画面 | タグ分析（`/tags`）、タグの編集（`/tags/edit`）、ストーリーズ（`/stories`）、オーディエンス（`/audience`）、投稿時刻（`/timing`）を新しく作る。投稿詳細にタグを表示する。ナビに 4 項目を足す | F-UI-30〜32、F-UI-40〜42 |

### 1.2 R5 でやらないこと

- **AI による自動タグ付け**（要件 4.8 章の「AI による構造化」。R7 以降の候補）。R5 のタグは利用者が手で付ける
- **時間帯別のオンラインフォロワー数**（F-COL-31 は削除済み）。R1 の再確認（V6）で `online_followers` が `period=lifetime` で返った回があったが、R5 では収集も表示もしない。収集を始めるかは確認事項 Q12 に載せる
- **属性の年齢 × 性別の掛け合わせ**。事実票では `breakdown` は `age`／`city`／`country`／`gender` の「いずれか」で、複数を同時に指定できるかは未確認。R5 は 1 リクエスト 1 内訳で取り、画面も内訳ごとに出す
- **ハッシュタグの定点観測**（他人の投稿の収集。要件 4.8 章）。R5 は自分のキャプションから抜き出すだけ。最初のコメントに書いたハッシュタグはコメントを収集していないので数えない
- **分析用データセット（`media_analysis_dataset`）へのタグの列**。軸を利用者が決めるので列が固定できない。CSV や SQL では `media_tags` をつなぐ
- **タグの CSV 出力、タグの一括取り込み**。件数が数十件なので画面で付ける
- **ストーリーズの動画の特徴量の表示**（R1 から解析はしているが、R5 の画面には出さない）
- **特殊な投稿の除外の設定**（R3 の Q4 のまま作らない）
- **タグの変更の履歴**。最後に変えた時刻だけを持つ

---

## 2. 既に済んでいるもの

| もの | 内容 |
|---|---|
| ストーリーズの収集 | `stories` ジョブ（hourly の先頭）が、一覧にある間は毎時 `media_insight_snapshots` に 1 行書く。指標は views、reach、replies、shares、reposts、total_interactions、profile_visits、follows、link_clicks、`navigation`（tap_forward、tap_back、tap_exit、swipe_forward）、`profile_activity`。`replies` は日本では常に 0（事実票） |
| ストーリーズの確定値 | ビュー `story_final_metrics`（最後のスナップショットと、JST の日ごとの順番 `story_seq`、`story_count_of_day`）。確定値は消える 0〜60 分前の値 |
| 投稿時のフォロワー数 | `profile_daily`（daily、JST 05:30 ごろ。`captured_on` は JST の日付）。`media_list_metrics.followers_at_post` は「投稿より前で 3 日以内の最も近い記録」 |
| 経過時間をそろえた値 | `media_horizon_metrics`（`horizon = '24h'` と `within_tolerance`。24 時間の許容幅は + 6 時間） |
| 投稿の種類 | `media_kind()`（feed／carousel／reel／story） |
| ハッシュタグの数 | `media_analysis_dataset.hashtag_count`（`'#[^\s#]+'` の一致の数） |
| 曜日と時刻 | `media_analysis_dataset` の `posted_isodow_jst`、`posted_hour_jst`。R4 の `/reels` の区分（曜日、時間帯）も JST で判定している |
| Web の権限 | `web_app` は表を列挙して `grant` し、各表に `web_app` 向けの RLS のポリシーを書く（R2）。書き込みは `accounts` と `private.credentials`（接続設定）だけ |
| 画面の作り | `getTargetAccount()` で対象のアカウントを決め、`lib/queries/` の関数が `QueryResult` を返す。計算はサーバー（`lib/*.ts` の純関数）、描画は Server Component。入力の検査は不正なら既定に戻す（R3 4.7 節）。選択はリンクのチップ（R4 の `ObjectiveChips`） |

---

## 3. 収集: `audience_demographics` ジョブ

### 3.1 取るもの

事実票（Meta 公式の Instagram User Insights の参照、v25.0）による。

| 指標 | 内訳（`breakdown`） | 条件 |
|---|---|---|
| `follower_demographics` | `age`、`gender`、`country`、`city` を 1 つずつ | フォロワー 100 未満だと返らない |
| `engaged_audience_demographics` | 同上 | 期間中の反応が 100 未満だと返らない。R0 では 4 つとも空（V10） |

- パラメータは `period=lifetime`、`metric_type=total_value`、`timeframe`（確認事項 Q7。推奨は `this_month`）
- 内訳つきの指標は内訳なしの指標と同じリクエストに入れられない（P5）。内訳も 1 リクエスト 1 つにする。1 回で **2 指標 × 4 内訳 = 8 リクエスト**
- 返るのは上位 45 件だけ。計算に使うデータは最大 48 時間遅れる
- 応答の形（`total_value.breakdowns[].results[].dimension_values` と `value` の想定）は未確認。段階 0 で本番の `raw_api_responses` にある R0／R1 の応答を見て決める。年齢の区分（`18-24` など）、性別の値（`F`／`M`／`U` の想定）も同じく確かめる

### 3.2 いつ取るか

- daily グループに足し、`token_check` → `profile_daily` → `account_daily` → **`audience_demographics`** → `media_sync --full` の順にする
- 「週」は JST の月曜始まり（ジョブ開始時刻 `ctx.startedAt` から 1 回だけ求める。R1 5.0 章の決まり）。指標 × 内訳 × timeframe の組ごとに、**その週の行がまだなければ取る**。月曜に失敗した組は火曜以降に取り直せる。取れた週は 2 回目から何もしない（API を呼ばない）
- 空の応答（100 未満など）も「その週は取った」として記録する（3.3 の `status = 'empty'`）。翌日に取り直さない
- 曜日を固定せず「週にまだなければ」にするのは、ジョブの失敗や Actions の止まりで 1 週分が欠けないようにするため

### 3.3 書き込み

- 組ごとに `audience_captures` に 1 行（`status` は `ok` か `empty`）と、`ok` なら `audience_values` に区分ごとの行を 1 トランザクションで書く（5.1）
- API の失敗（`transient` の再試行を使い切った、`fatal`）は行を書かず `recordFailure`（`code` と `errorClass`。API の `message` は固定文言に置き換える）。翌日に同じ週の取り直しになる
- `RateLimitExceeded` と `AuthError` は捕まえず枠組みに任せる（`stories` と同じ）
- 100 未満のときに「空の応答」が返るのか「エラー」が返るのかは未確認（R0 の V10 は空と記録）。エラーが返るなら、そのエラーコードを段階 0 で確かめ、`empty` として扱う
- 値は整数（`toCount` と同じ検査。`profile-daily.ts`）。区分の名前は文字列として 200 文字までに切る（都市の名前など。長さは想定外の入力への備え）
- 生の応答は既定どおり保存する（`raw_response_id` を行に持たせる）
- `items_fetched` は書いた組の数（`empty` を含む）。一部の組が失敗したら `partial`（枠組みの既定の規則）

### 3.4 ログ

`info` で `captured`（ok）、`empty`、`skipped_this_week`、`failed` の件数だけを出す。区分の名前（国、都市）と値はログに出さない（公開ログに出るため）。

---

## 4. 画面の一覧とナビ

| 画面 | URL | 種類 | 要件 |
|---|---|---|---|
| タグ分析 | `/tags` | ページ | F-UI-31、F-UI-32 |
| タグの編集 | `/tags/edit` | ページと Server Action | F-UI-30 |
| ストーリーズ | `/stories` | ページ | F-UI-40 |
| オーディエンス | `/audience` | ページ | F-UI-41 |
| 投稿時刻 | `/timing` | ページ | F-UI-42 |
| 投稿詳細（変更） | `/media/[id]` | ページ | F-UI-30（タグの表示） |

- R2 の proxy の matcher はすべての URL と Server Action の POST を通す（R3 2.1 節）。proxy は変えない。ページと Server Action の中でも `checkAccess` を呼ぶ
- ナビ（確認事項 Q11）: 概要、投稿一覧、リール分析、**タグ分析**、**投稿時刻**、**ストーリーズ**、**オーディエンス**、期間比較、接続と収集ログ（9 項目）。タグの編集はナビに出さず、タグ分析と投稿詳細から移る（現在位置は「タグ分析」）。スマートフォンは R3 の複数段のタブのまま（9 項目で 2〜3 段の見込み。見た目はユーザーが確かめる）。design-lab v3 のナビの並びは今回読んでいない（未確認。実装の前に `render.js` のナビの定義と見比べる）

---

## 5. DB

### 5.1 マイグレーション（手書き。`supabase/migrations/20261009000000_r5_analysis.sql`。日付は実装の日に合わせる）

#### (1) 独自タグ

軸ごとに投稿 1 件につき値は 1 つ（確認事項 Q2）。アカウントの食い違い（別のアカウントの投稿に別のアカウントの値を付ける）を、複合の外部キーで DB が拒むようにする。

```sql
create table public.tag_axes (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (account_id, name),
  unique (id, account_id)            -- 下の複合の外部キーの相手
);

create table public.tag_values (
  id bigint generated always as identity primary key,
  axis_id bigint not null references public.tag_axes (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (axis_id, name),
  unique (id, axis_id)
);

-- media の (id, account_id) に一意制約を足す（id が主キーなので中身は変わらない。外部キーの相手にするため）
alter table public.media add constraint media_id_account_key unique (id, account_id);

create table public.media_tags (
  media_id text not null,
  account_id uuid not null,
  axis_id bigint not null,
  value_id bigint not null,
  updated_at timestamptz not null default now(),
  primary key (media_id, axis_id),                                       -- 軸ごとに 1 つ
  foreign key (media_id, account_id) references public.media (id, account_id) on delete cascade,
  foreign key (axis_id, account_id) references public.tag_axes (id, account_id) on delete cascade,
  foreign key (value_id, axis_id) references public.tag_values (id, axis_id) on delete restrict
);
create index media_tags_value_idx on public.media_tags (value_id);
```

- 値の削除は、付いている投稿があれば拒む（`on delete restrict`）。画面は使っている件数を出し、0 件のときだけ削除のボタンを出す。軸の削除は、付いている対応ごと消える（`cascade`）ので、画面で件数を示して確かめる（6.2）
- 名前の前後の空白は画面で取り除き、DB は長さだけを検査する。名前の比較は大文字小文字を区別する（そのまま）
- 投稿の種類は問わない（ストーリーズにも付けられる。ただし R5 のタグ分析はストーリーズを対象にしない。6.1）。確認事項 Q3
- 列 `updated_at` は Server Action が `now()` を入れる（トリガーは作らない）

#### (2) 属性の週次記録

```sql
create table public.audience_captures (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  week_start date not null,                 -- JST の月曜
  metric text not null check (metric in ('follower_demographics', 'engaged_audience_demographics')),
  timeframe text not null,
  breakdown text not null check (breakdown in ('age', 'gender', 'country', 'city')),
  status text not null check (status in ('ok', 'empty')),
  fetched_at timestamptz not null,
  raw_response_id bigint references public.raw_api_responses (id) on delete set null,
  unique (account_id, week_start, metric, timeframe, breakdown)
);

create table public.audience_values (
  capture_id bigint not null references public.audience_captures (id) on delete cascade,
  value_key text not null check (char_length(value_key) between 1 and 200),
  value bigint not null check (value >= 0),
  primary key (capture_id, value_key)
);
```

- `account_daily_metrics` に入れない理由: 日付の意味（太平洋時間の日）と取り方（週 1 回、timeframe つき）が違い、「空の応答」と「未取得」を分ける行が要るため
- `empty` は「取ったが区分が返らなかった」、行がないのは「その週は取れていない」
- `check` の列挙は、Meta が値を増やしたら書き込みが失敗して分かるようにするため（黙って捨てない）

#### (3) ハッシュタグ

ビューで抜き出す（保存しない。確認事項 Q5）。キャプションが変わっても追いかけられ、抜き出しの規則を変えても作り直すだけで済む。

```sql
create or replace function public.caption_hashtags(p_caption text)
returns setof text
language sql
stable
parallel safe
as $$
  select distinct lower(normalize(m[1], NFKC))
  from regexp_matches(coalesce(p_caption, ''), '#([^\s#、。，．,.!！?？・「」『』()（）【】\[\]]+)', 'g') as m
$$;
revoke execute on function public.caption_hashtags(text) from public;
grant execute on function public.caption_hashtags(text) to web_app;

create view public.media_hashtags with (security_invoker = true) as
select m.id as media_id, m.account_id, h.tag
from public.media m
cross join lateral public.caption_hashtags(m.caption) as h(tag)
where m.media_product_type <> 'STORY';
```

- 1 投稿に同じタグが 2 回あっても 1 回に数える（`distinct`）。英字は小文字に、全角英数は NFKC で半角にそろえる（`#Coffee` と `#coffee` を同じにする）
- 区切りの記号の一覧（句読点、括弧など）は確認事項 Q6。`media_analysis_dataset.hashtag_count`（`'#[^\s#]+'`）とは数え方がずれる。R5 では `hashtag_count` を変えない（ビューの列の意味を変えると作り直しが要るため）。差を関数の comment に書く
- `normalize(text, NFKC)` と `lower` の揮発性の区分（immutable と付けられるか）は未確認。`stable` で書き、段階 1 で確かめる。データベースの文字コードが UTF8 であることも確かめる（`normalize` の前提）
- 抜き出しの性能: 投稿数百件、キャプション数百文字なので、画面のたびに全件を走査しても問題ない見込み（段階 1 で `explain analyze`）

#### (4) ストーリーズの一覧

```sql
create view public.story_list_metrics with (security_invoker = true) as
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
  -- media_list_metrics.followers_at_post と同じ規則（投稿より前で 3 日以内の最も近い記録）
  select p.followers_count, p.captured_at
  from public.profile_daily p
  where p.account_id = f.account_id
    and p.captured_at <= f.posted_at
    and p.captured_at >= f.posted_at - interval '3 days'
  order by p.captured_at desc
  limit 1
) pf on true;
```

- 閲覧率の分母（確認事項 Q8）: リーチ率と同じ規則にする。ストーリーズは収集を始めてから（2026-10-01 以降）のものしかないので、`profile_daily` が欠けた日を除けば分母がある。投稿の後の記録は使わない（R3 の R-10 と同じ）
- 同じ規則を 2 つのビューに書くことになる。comment でお互いを参照させる（R4 の `retention_rate` と同じやり方）。関数にまとめるかは SQL のレビューで決める
- 「次へ」「戻る」などの率（割合）は画面で計算する（分母は 4 つの操作の合計。6.3）。ビューには件数と、要件 7.2 章の定義がある閲覧率と離脱率だけを置く

#### (5) 権限と RLS

R2 の決まり（表とビューは列挙して `grant` し、表には `web_app` 向けのポリシーを書く。関数は PUBLIC の実行権を取り消す）に従う。

```sql
alter table public.tag_axes enable row level security;
alter table public.tag_values enable row level security;
alter table public.media_tags enable row level security;
alter table public.audience_captures enable row level security;
alter table public.audience_values enable row level security;

revoke all on table public.tag_axes, public.tag_values, public.media_tags,
  public.audience_captures, public.audience_values, public.media_hashtags, public.story_list_metrics
  from public, anon, authenticated;

-- タグ: Web から読み書きする（R5 で初めて利用者のデータを Web から書く）
grant select, insert, update, delete on table public.tag_axes, public.tag_values, public.media_tags to web_app;
create policy web_app_all on public.tag_axes   for all to web_app using (true) with check (true);
create policy web_app_all on public.tag_values for all to web_app using (true) with check (true);
create policy web_app_all on public.media_tags for all to web_app using (true) with check (true);

-- 属性: 読むだけ（書くのはワーカー）
grant select on table public.audience_captures, public.audience_values to web_app;
create policy web_app_select on public.audience_captures for select to web_app using (true);
create policy web_app_select on public.audience_values   for select to web_app using (true);

-- ビュー
grant select on table public.media_hashtags, public.story_list_metrics to web_app;
```

- ポリシーが `using (true)` なのは R2 と同じ考え（利用者は本人ともう 1 人で、誰が使えるかは `checkAccess` が決める。対象のアカウントは `getTargetAccount()` と SQL の `account_id = ${accountId}` で絞る）。アカウントの食い違いは 5.1 (1) の複合の外部キーで DB が拒む
- `update` の対象の列は絞らない（`name`、`sort_order`、`updated_at`、`value_id`）。`account_id` と `axis_id` を書き換えられても複合の外部キーが食い違いを拒む。列を絞るかは SQL とセキュリティのレビューで決める
- `generated always as identity` の列に `web_app` が insert するのに、裏の sequence の `usage` が要るかは未確認。段階 1 の結合テストで `web_app` として insert して確かめ、要るなら `grant usage on sequence` を足す
- `web_app` の `statement_timeout`（15 秒）はそのまま
- 関数の棚卸しのテスト（`web-role.test.ts`）に `caption_hashtags` を足す

#### (6) ロールバック（末尾のコメント）

```sql
-- 1. 先にワーカーを R5 より前の版に戻す（audience_demographics が表に書くため）。Web も R5 より前に戻す
-- drop view if exists public.story_list_metrics;
-- drop view if exists public.media_hashtags;
-- drop function if exists public.caption_hashtags(text);
-- drop table if exists public.audience_values, public.audience_captures;
-- drop table if exists public.media_tags, public.tag_values, public.tag_axes;   -- 利用者が付けたタグも消える。先に pg_dump で残す
-- alter table public.media drop constraint if exists media_id_account_key;
-- delete from supabase_migrations.schema_migrations where version = '20261009000000';
```

### 5.2 索引

- `media_tags`: 主キー `(media_id, axis_id)`（投稿ごとのタグ）、`(value_id)`（値ごとの件数と `restrict` の検査）。軸ごとの集計は件数が少ないので主キーと `value_id` で足りる
- `audience_captures`: 一意制約 `(account_id, week_start, metric, timeframe, breakdown)` が「その週の行があるか」とアカウントの推移の両方に使える
- `audience_values`: 主キー `(capture_id, value_key)`
- ストーリーズと投稿時刻は既存の `media (account_id, media_product_type, posted_at desc)` と `media_insight_snapshots (media_id, …)` を使う。新しい索引は足さない

---

## 6. 画面

共通: 対象のアカウント、空とエラーの表示、最終更新、`MissingReason`（「—」の理由）、件数 n の出し方（0／1〜2／3〜9／10 以上）、`MetricHint` は R3 3.1 節のまま。計算はサーバーの純関数（`lib/*.ts`）、描画は Server Component。グラフは SVG を自作（依存を増やさない。R3 の Q2）。分位は `percentile_cont` と同じ線形補間（R4 の `lib/reels.ts` の関数を使う。場所は未確認）。署名付き URL を含むページは `Cache-Control: private, no-store` と `referrerPolicy="no-referrer"`（R3 4.7 節）。

### 6.1 タグ分析（`/tags`）

見本はない。R4 のリール分析と投稿時刻の部品を組み合わせる。

**対象**: 過去 1 年間（365 日）の投稿（ストーリーズを除く）。値は R3 の Q21 のとおり**各投稿の最新の値**（`media_list_metrics`）。リーチ率だけは定義どおり 7 日時点。

**上部の選択**（リンクのチップ。投稿時刻の画面と同じ形）:

| 名前 | 値 | 既定 |
|---|---|---|
| `axis` | 軸の id（`^\d{1,18}$` で、そのアカウントの軸） | 並び順の最初の軸 |
| `kind` | `all`、`reel`、`feed`、`carousel` | `all` |
| `m` | `reach`、`views`、`save_rate`、`share_rate`、`er`、`reach_rate` | `reach` |

- 種類が混ざると比べ方がゆがむ（リールの多いタグが高く見える）が、自動では切り替えない。各行に種類ごとの件数を添えて判断を委ねる
- 不正な値は既定に戻す（R3 4.7 節）。軸が 0 件なら、タグの比較のカードの代わりに「タグの軸がありません」と `/tags/edit` へのリンク

**カード**:

| カード | 内容 | 要件 |
|---|---|---|
| 見出し | 「投稿 n 件（過去 1 年間）・タグ付き m 件」と選択。右に「タグを編集」（`/tags/edit` へのリンク） | — |
| タグごとの比較（全幅） | 選んだ軸の値ごとの行。列は件数（種類の内訳を小さく）、経過日数の中央値、リーチ、閲覧数、ER、保存率、シェア率、リーチ率の**中央値**と、選んだ指標 `m` の帯グラフ（投稿ごとの点、25〜75% の帯、値の中央値の線、全投稿の中央値の灰色の線、目盛は行で共通。投稿時刻の「上位の組み合わせ」と同じ部品）。最後の行は「タグなし」（その軸の値がない投稿。確認事項 Q4） | F-UI-31 |
| 種類ごとの比較（半幅） | 種類（フィード、カルーセル、リール）ごとの同じ列の中央値。`kind` の選択には従わない（種類そのものを比べるカードなので） | F-UI-31 の「種類ごと」 |
| ハッシュタグ（全幅） | ハッシュタグごとの行: 使った投稿の件数、選んだ指標 `m` の中央値、リーチと保存率の中央値、最後に使った日。件数の多い順、同数は中央値の高い順。3 件未満の行は薄く（R3 の n の決まり）。上位 30 行まで出し、残りの行数を書く | F-UI-32 |

- 中央値の n は列ごとに数える（R3 3.1 節。リーチ率は値のある投稿が少ない）。n が 0 の列は「—」
- 経過日数の中央値は「最新の値」が投稿によって違う時点の値であることを読む人が頭に置けるようにするため（R3 の Q21 と同じ考え。説明の文言は足さない）
- 行の並びは値の `sort_order`、「タグなし」は最後
- スマートフォン: 表は横スクロールの枠に入れ、値の名前の列を固定する。隠す列（`hide-m`）は閲覧数、ER、経過日数。帯グラフは表の下に縦に並べる

**クエリ**（`lib/queries/tags.ts`）: `getTagAnalysis(accountId, axisId)` は期間内の投稿を 1 行ずつ返す（`media_list_metrics` に `media_tags` を `axis_id` で left join。値の名前と並び順も）。`getHashtagStats(accountId)` は `media_hashtags` と `media_list_metrics` をつないで投稿ごとに返す。中央値と帯は `lib/tags.ts` で計算する（件数が数百件なので、R4 と同じくページのたびに計算し直す）。

### 6.2 タグの編集（`/tags/edit`）

場所は専用画面（確認事項 Q1）。投稿詳細には付いているタグを表示し、その投稿の行へのリンク（`/tags/edit#m-{id}`）を置く。

**構成**:

1. **軸と値の管理**（カード）: 軸ごとに、名前、並び順、値の一覧（名前と使っている件数）。操作は「軸を足す」「軸の名前を変える」「軸を消す（付いているタグも消える。件数を示す）」「値を足す」「値の名前を変える」「値を消す（0 件のときだけ）」。並び順は上下のボタン
2. **投稿へのタグ付け**（カード）: 投稿の表（新しい順、1 ページ 50 件）。列はサムネイル、題名（キャプションの 1 行目）、投稿日、種類、軸ごとの `<select>`（「なし」と値）、保存のボタン。1 行 1 フォーム（行ごとに保存）。絞り込みは「この軸が未設定の投稿だけ」（`?missing={axis_id}`）

**Server Action**（`app/tags/edit/actions.ts`）:

| 関数 | 入力 | 処理 |
|---|---|---|
| `createAxis`、`renameAxis`、`deleteAxis`、`moveAxis` | 軸の id、名前 | `tag_axes` の insert／update／delete |
| `createValue`、`renameValue`、`deleteValue`、`moveValue` | 軸の id、値の id、名前 | `tag_values`。削除は使っている件数が 0 のときだけ（DB も `restrict` で拒む） |
| `setMediaTags` | 投稿の id、軸の id → 値の id（または空）の組 | 1 トランザクションで、空の軸は `media_tags` を delete、値のある軸は `insert … on conflict (media_id, axis_id) do update set value_id, updated_at` |

- **毎回 `checkAccess` を呼び、`pass` でなければ何もせず固定の文言を返す**（Server Action は公開の POST の口なので、proxy に頼らない）
- `account_id` はフォームから受け取らず、`getTargetAccount()` で決める。軸、値、投稿の id は形（`^\d{1,18}$`、投稿は `^\d{1,25}$`）を検査し、SQL で `account_id = ${accountId}` の行だけを対象にする（そのアカウントのものでなければ 0 行で、固定の文言）
- 名前: 前後の空白を除き、1〜30 文字、制御文字を含まない。`#` で始まる名前は拒まない
- 数の上限: 軸 10 個、1 軸の値 50 個（悪用と誤操作への備え。数を超えたら固定の文言）
- 一意制約の違反（同じ名前）は SQLSTATE `23505` を見て「同じ名前があります」、`restrict` の違反（`23503`）は「使っている投稿があります」。ほかの DB のエラーは固定の文言。DB のエラー文は返さない（R3 4.7 節）
- 成功したら同じページを描き直す。フォームの状態の扱い（`useActionState` を使うか、`redirect` で戻すか）と、Next.js 16 の Server Functions の作法（Origin の検査、`revalidatePath` の要否）は、実装の前に `node_modules/next/dist/docs/` の該当資料（Forms、Server Functions／Mutating data）を読んで決める（この起草では読んでいない）
- ログ: 関数の名前、成否、SQLSTATE だけ。タグの名前、投稿の id は出さない
- JS なしでも動く `<form action>` で作る。保存中の表示は既存の `PendingMark` 相当

**投稿詳細の変更**（`/media/[id]`）: 見出しの下に、付いているタグを「軸: 値」のチップで並べ、右に「タグを編集」のリンク。タグがなければリンクだけ。

### 6.3 ストーリーズ（`/stories`）

見本（`S.stories`）どおりに作る。値は `story_list_metrics`（確定値 = 消える前の最後の取得）。

**期間**: `range` の選択（`30`、`90`、`365`。既定 `30`。確認事項 Q9）。投稿日時（JST）で絞る。

**カード**:

| カード | 内容 |
|---|---|
| 見出し | 「全 n 件（過去 30 日）」と期間の選択 |
| 期間全体の指標 | 件数、閲覧率の中央値、離脱率の中央値、リンクの合計、返信の合計（見本の `metrics-row`。各ラベルに `MetricHint`） |
| ストーリーズの一覧（全幅） | サムネイル、投稿日時、種類（画像／動画）、閲覧、閲覧率、離脱率、次へ、戻る、次のアカウントへ、リンク、返信。列の見出しで並べ替え（`sort`、`dir`）。既定は投稿日時の新しい順。スマートフォンで隠す列は次へ、戻る、次のアカウントへ、返信（見本の `hide-m`）。ページ送りは R4 の一覧と同じ `PAGE_SIZE` |
| 閲覧率の推移（全幅） | 横軸は投稿の順（古い順）、ラベルは月/日。点つきの折れ線（`--chart-4`） |
| 操作の内訳（半幅） | 直近 10 件の横の積み上げ棒。次へ、戻る、離脱、次のアカウントへの割合（分母は 4 つの合計。見本どおり）。値は `<title>` と `aria-label` |
| 離脱ファネル（半幅） | 続けて 2 件以上出したまとまり（前の 1 件から 6 時間以上空いたら別のまとまり）があるときだけ。期間内で最も新しいまとまりの、1 件目の閲覧を 100% にした縦棒。まとまりがなければ、見本の文言「期間中に、続けて 2 件以上出したストーリーズはありません。」。どのまとまりを出すかは確認事項 Q10 |

- 閲覧率の分母がない（投稿の前 3 日以内に `profile_daily` の記録がない）ものは「—」で、理由は `no_baseline_data`（R3 の文言「投稿時のフォロワー数の記録がない」）
- 指標が null（取得の失敗）は「—」（`missing`）。返信は日本では常に 0 だが、そのまま 0 と出す（説明の文言は足さない）
- 中央値と合計は値のあるものだけで計算し、n を添える（閲覧率は分母のあるものだけ）
- まとまりの判定と操作の割合は `lib/stories.ts` の純関数（投稿日時の古い順に並べてから判定。6 時間ちょうどは別のまとまり。見本の `>= 6 * 36e5`）
- 消えた後に手で削除と判定されたもの（`gone_at` あり）も含める（R3 の「データは残す」）

**クエリ**（`lib/queries/stories.ts`）: `getStories(accountId, rangeDays)` が期間内の行を投稿日時の順に返す。`numeric` は SQL で `float8` にする（R4 の `reels.ts` と同じ）。最終更新は `metrics_fetched_at` の最大。

### 6.4 オーディエンス（`/audience`）

見本はない。概要の部品（横棒、折れ線、凡例）を組み合わせる。

**カード**（上から）:

| カード | 内容 |
|---|---|
| 見出し | 「フォロワーの属性（記録 n 週）」。最新の週の記録日 |
| 性別（半幅） | 最新の週の区分ごとの人数と割合の横棒 |
| 年齢（半幅） | 同上（区分は API の順。若い順） |
| 国（半幅） | 上位 10 件の人数と割合の横棒。残りの件数（「ほか n 件」） |
| 都市（半幅） | 同上 |
| 推移（全幅） | 週ごとの性別の割合と年齢の割合の折れ線（2 枚を並べる。半幅ずつ）。国は最新の週の上位 5 か国の割合の折れ線。点は週の月曜の日付。1 週だけなら点だけ |
| 反応したユーザーの属性 | `engaged_audience_demographics` に `ok` の週が 1 つでもあるときだけ、上の 4 枚と同じ形で出す（F-UI-41）。なければ節ごと出さない |

- **割合の分母**: その週・その内訳で返った区分の合計（上位 45 件まで）。カードの下に「分母: 返った区分の合計」と書く（要件 1.3 の原則 4）。国と都市は上位 45 件しか返らないので、フォロワー数とは合わない。人数も並べて出す。確認事項 Q13
- カードの下に時点を書く（R3 3.1 節）: 「2026-10-12 の週（日本時間）の記録・取得 2026-10-13 05:31」。Meta の計算は最大 48 時間遅れる（事実票）が、文言は足さない（ヒントに書く）
- その週が `empty` のときは、そのカードを「—」にする（理由は `missing`。新しい理由は足さない）。記録が 0 週なら「まだ収集されていません」と `/jobs` へのリンク（R3 の空の状態）
- 区分の名前（国コード、都市名）は API の値をそのまま文字として出す（国コードを日本語の国名にする対応表は作らない。確認事項 Q13）

**クエリ**（`lib/queries/audience.ts`）: `getAudience(accountId, metric, timeframe)` が週 × 内訳 × 区分の行と `status` を返す（直近 52 週）。割合と上位の切り出しは `lib/audience.ts`。

### 6.5 投稿時刻（`/timing`）

見本（`S.timing`）と要件 F-UI-42 の構成（2026-10-05 決定）どおりに作る。

**対象**: 過去 1 年間（365 日）の投稿（ストーリーズを除く）。曜日と時間帯は投稿日時の JST。時間帯は 3 時間ごとの 8 区分（0-3、3-6、…、21-24）、曜日は月〜日（ISO の曜日。`media_analysis_dataset` の `posted_isodow_jst` と同じ）。

**上部の選択**:

| 名前 | 値 | 既定 |
|---|---|---|
| `m` | `reach_24h`、`views_24h`、`reach_latest`、`views_latest`（確認事項 Q14） | `reach_24h` |
| `kind` | `all`、`reel`、`feed`、`carousel` | `all` |

- 選択はリンクのチップ。指標の文言に件数を出す（例: 「24 時間リーチ（3 件）」。R4 の Q1 と同じ形）。データの状況で既定を変えない
- 24 時間の値は `media_horizon_metrics` の `horizon = '24h'` かつ `within_tolerance`（24 時間 + 6 時間以内のスナップショット）。収集を始めた 2026-10-01 より前の投稿には 24 時間時点の値がなく、今は大半の投稿が対象から外れる（件数は段階 0 で数える）

**カード**（すべて選んだ指標と種類で描き直す）:

| カード | 内容 |
|---|---|
| 曜日 × 時間帯（全幅） | ヒートマップ。色は中央値、件数 0 は空欄、件数 1 は数字に「※」、カードの下に「※: n=1」。見出しは「曜日 × 時間帯の 24 時間リーチ（中央値）」（指標の名前を入れる。「初速」の語は使わない） |
| 時間帯別（半幅） | 縦棒。棒の下に件数。3 件未満は薄く |
| 曜日別（半幅） | 同上 |
| 上位の組み合わせ（全幅） | 件数 2 件以上の組み合わせを中央値の高い順に 5 行。曜日、時間帯、中央値、件数、投稿ごとの値の帯グラフ（目盛は行で共通、全投稿の中央値の線）。点は投稿詳細へのリンク。カードの補足「件数 1 件の組み合わせは除く」 |

- ヒートマップの色の段階は、表示している値の最小〜最大で決める（指標と種類ごと）。凡例に値の範囲を書く
- 対象が 0 件なら、全カードの代わりに「—」と件数（「24 時間リーチ（0 件）」の選択で分かる）。文言は足さない
- 集計は `lib/timing.ts` の純関数（曜日 × 時間帯の中央値と件数、上位 5）。曜日と時刻は SQL で JST に変換して受け取る（JS で二重に持たない。R3 6 章）

**クエリ**（`lib/queries/timing.ts`）: `getTimingRows(accountId)` が期間内の投稿ごとに `kind`、`extract(isodow from posted_at at time zone 'Asia/Tokyo')`、`extract(hour from …)`、24 時間のリーチと閲覧数（`within_tolerance` のときだけ）、最新のリーチと閲覧数を返す。指標と種類の切り替えは TS でする（1 回の取得で済む）。

### 6.6 部品

| 部品 | 状態 |
|---|---|
| チップの選択（リンク） | R4 の `ObjectiveChips` の形を共通の部品にする（`components/`）。段階 2 の共通の担当 |
| 帯グラフ（投稿ごとの点、帯、中央値、全体の中央値の線） | 新規（`components/charts/Strip`）。タグ分析と投稿時刻で使う |
| ヒートマップ | 新規（`components/charts/Heatmap`） |
| 縦棒（棒の下に件数、薄い表示） | R4 の区分のカードが使っている部品があるか確かめて使う（未確認） |
| 横の積み上げ棒、横棒（割合） | 新規（ストーリーズの操作の内訳、オーディエンス） |
| 折れ線 | R3 の部品を使う |

すべて SVG を Server Component で描き、値は `<title>` と `aria-label`、点 0 個、1 個、全部同じ値で `NaN` を出さない（R3 9.1 節）。

---

## 7. テスト

| 区分 | 内容 |
|---|---|
| 単体（worker） | 週の始まり（JST の月曜。日曜 23:59 と月曜 0:00、UTC 15:00 をまたぐとき）。その週の行がある組を飛ばす。応答の解析（区分あり、空、形の違う応答、値が数でない、区分の名前の長さ）。API の失敗で行を書かず `recordFailure`、固定の文言。ログに区分の名前がない。8 リクエストの組み立て（内訳ごとに 1 つ、`metric_type`、`timeframe`、`period`） |
| 結合（worker と DB） | `audience_captures` と `audience_values` の 1 トランザクションの書き込み。同じ週の 2 回目は何もしない。`empty` の行。`check` の列挙外で失敗する |
| DB | `media_tags` の複合の外部キー（別のアカウントの投稿、別の軸の値を拒む）。軸ごとに 1 つ。値の削除の `restrict`、軸の削除の `cascade`。`caption_hashtags`（重複、大文字小文字、全角英数、句読点で終わる、`#` だけ、null のキャプション、`##`）。`story_list_metrics`（分母の 3 日以内と投稿の後の記録を使わない、閲覧 0 で離脱率 null、`navigation` のキーがない）。`web_app` で読めてタグを書け、属性は書けない。`anon` と `authenticated` は読めない。`web_app` として identity の列に insert できる（sequence の権限の確認）。ビューの `security_invoker`。関数の棚卸し（`web-role.test.ts`） |
| 画面（単体） | 入力の検査（`axis`、`kind`、`m`、`range`、`sort`、`dir`、`missing` の不正値で既定）。Server Action: `checkAccess` が `pass` でないと書かない（`vi.mock`）、別のアカウントの id で 0 行、名前の検査（空白だけ、31 文字、制御文字）、数の上限、SQLSTATE から文言、DB のエラー文を返さない。中央値と n（列ごと）、「タグなし」の行。ハッシュタグの並び（件数、同数の順）。ストーリーズのまとまり（6 時間ちょうど、1 件だけ、日をまたぐ）、操作の割合（合計 0）、閲覧率の「—」。属性の割合（分母 0、`empty` の週）、上位 10 と「ほか n 件」。投稿時刻の曜日 × 時間帯の集計（境目の 3 時、JST の 0 時）、※ の判定、上位 5（同値の順）、件数 1 の除外。グラフの部品の空と 1 点 |
| 画面（結合） | `getTagAnalysis`、`getHashtagStats`、`getStories`、`getAudience`、`getTimingRows` が 2 アカウントのデータを分ける。`setMediaTags` が 1 トランザクションで入れ替える |
| 受け入れ | 要件 10 章の R5 の完了条件: 本番で、タグを数件付けた投稿の比較、ストーリーズの離脱ファネル（まとまりがあれば）、属性の推移（2 週以上の記録の後）が表示される。PC 幅とスマートフォン幅の見た目はユーザーが確かめる。Instagram の担当者がタグを付けられることを確かめる |

---

## 8. 段階

同じ作業ツリーで、段階ごとにファイルを分担する（git worktree は使わない）。各担当は自分のテストも書く。

| 段階 | 内容 | 担当の案 | ファイル |
|---|---|---|---|
| 0 | 本番の数を数える: ストーリーズの件数と続けて出したまとまりの数、24 時間時点の値がある投稿の数、ハッシュタグを含む投稿の数。R0／R1 の属性の生の応答の形（3.1）と、100 未満のときの応答。確認事項の回答 | 親とユーザー | — |
| 1 | マイグレーション、DB のテスト | `postgres-sql-reviewer` が設計とレビュー | `supabase/migrations/…_r5_analysis.sql`、`apps/web/test/db/r5-views.test.ts`、`web-role.test.ts` への追記 |
| 2a | `audience_demographics` ジョブ、グループへの組み込み、テスト | `node-worker-developer` | `apps/worker/src/jobs/audience-demographics.ts`、`apps/worker/src/db/audience.ts`、`jobs/groups.ts`、`index.ts` の登録、`apps/worker/test/…` |
| 2b | 画面の共通: ナビ、チップの部品、`Strip`、`Heatmap`、横棒の部品、`lib/params.ts` への検査の追加 | `nextjs-developer` | `app/layout.tsx`（ナビ）、`components/`、`components/charts/`、`lib/params.ts`、`test/params.test.ts`、`test/charts.test.ts` |
| 3 | 画面（並列。2b の後） | `nextjs-developer` を 4 つ | A: `app/tags/page.tsx`、`app/tags/_tags/*`、`lib/tags.ts`、`lib/queries/tags.ts`。B: `app/tags/edit/*`（`actions.ts` を含む）、`app/media/[id]/_detail/` のタグの表示。C: `app/stories/*`、`lib/stories.ts`、`lib/queries/stories.ts`。D: `app/audience/*`、`lib/audience.ts`、`lib/queries/audience.ts`。E: `app/timing/*`、`lib/timing.ts`、`lib/queries/timing.ts` |
| 4 | 本番に反映（`db push` → main へのマージ。R4 の順）。属性が週 1 回入ることを確かめる | 親とユーザー | — |
| 5 | テストの不足、セキュリティレビュー（Server Action、権限と RLS）、ユーザーの画面の確認 | `quality-engineer`、`security-engineer`、ユーザー | — |

- 段階 1 と 2a と 2b は並べて進められる（表の形は 5.1 で決まっているので、ワーカーは先に書き始め、結合テストはマイグレーションの後に通す）
- 段階 3 の 5 つは触るファイルが重ならない。共通の部品の変更が要るときは段階 3 の中では直さず、親に戻して 2b の担当がまとめて直す（R3 10 章と同じ）。A と B は `lib/queries/tags.ts` を A が持ち、B は自分の `actions.ts` の中に書き込みの SQL を持つ
- 担当 B の Server Action はセキュリティレビューを必ず通す（R5 で初めて Web から利用者のデータを書くため）

---

## 9. 確認事項

| # | 問い | 推奨 |
|---|---|---|
| Q1 | タグを付ける場所（投稿詳細、投稿一覧、専用画面） | 専用画面 `/tags/edit`（軸と値の管理と、投稿の表で軸ごとの選択を行ごとに保存）。既存の 24 件以上に付けるには表が速い。投稿詳細は表示と、編集画面のその行へのリンクだけ |
| Q2 | 1 つの軸に値をいくつ付けられるか | 軸ごとに 1 つ。値ごとの比較で投稿が重ならず、選択（`<select>`）で付けられる。複数にしたい軸が出たら、その軸を分けて作る |
| Q3 | ストーリーズにもタグを付けられるようにするか | DB は種類を問わない。R5 の編集画面とタグ分析はストーリーズを除く（ストーリーズは指標が別で、比べる相手が違う） |
| Q4 | タグ分析で、その軸の値がない投稿を「タグなし」の行として出すか | 出す（比べる基準になる）。行の名前は「タグなし」 |
| Q5 | ハッシュタグの抽出をビューでやるか保存するか | ビュー（関数 `caption_hashtags` とビュー `media_hashtags`）。キャプションの変更と規則の変更にそのまま追いつく。件数が少なく性能の心配がない |
| Q6 | ハッシュタグの区切り（どの記号で終わるか）、大文字小文字と全角半角をそろえるか | 空白、`#`、日本語と英語の句読点、括弧で終わる。小文字と NFKC にそろえる。本番のキャプションで抜き出した結果をユーザーが見て直す |
| Q7 | 属性の `timeframe` | `this_month` だけを取る（R0 で 4 内訳とも取れた）。`this_week` も取るかは、`this_month` の値の変わり方を数週見てから決める。`this_month` が暦の月なのか直近 30 日なのかは未確認（月初めに値が小さくなるなら暦の月） |
| Q8 | ストーリーズの閲覧率の分母（投稿時のフォロワー数の取り方） | リーチ率と同じ「投稿より前で 3 日以内の最も近い `profile_daily`」。前後の記録の補間や投稿の後の記録は使わない |
| Q9 | ストーリーズの期間 | 選択（30、90、365 日。既定 30 日）。見本は「過去 30 日」の固定の表示 |
| Q10 | 離脱ファネルに出すまとまり | 期間内で最も新しいまとまり 1 つ（見本どおり）。ほかのまとまりは一覧で見る |
| Q11 | ナビの並び（9 項目） | 概要、投稿一覧、リール分析、タグ分析、投稿時刻、ストーリーズ、オーディエンス、期間比較、接続と収集ログ（投稿の分析をまとめ、アカウントの分析を後ろに）。design-lab v3 の並びと違えば見本に合わせる |
| Q12 | `online_followers`（時間帯別のオンラインフォロワー数）を収集に入れるか | R5 では入れない（F-COL-31 は削除済み）。返った回があるので、入れるなら R6 以降に確かめてから |
| Q13 | 属性の割合の分母と国の名前 | 分母は「その週に返った区分の合計」と明示する。国はコードのまま（対応表を作らない）。人数も並べる |
| Q14 | 投稿時刻の指標の選択肢 | 24 時間リーチ（既定）、24 時間の閲覧数、最新のリーチ、最新の閲覧数。文言に件数。24 時間の値のある投稿が少ないうちも、既定は変えない（R4 の Q1 と同じ形） |
| Q15 | タグの軸と値の初期値 | 入れない（マイグレーションで利用者のデータを作らない）。要件の例（テーマ、目的、CTA、キャンペーン）を編集画面の空の状態に例として書くだけにし、軸と値は本人と担当者が決めて登録する |
| Q16 | タグの編集をもう 1 人（Instagram の担当者）にも許すか | 許す（`checkAccess` が `pass` の利用者は誰でも書ける）。変更者は記録しない（最後に変えた時刻だけ） |

---

## 付録 A. 読んだ資料

| 資料 | 範囲 |
|---|---|
| `CLAUDE.md`、`doc/progress.md` | 全体、1〜40 行 |
| `doc/requirements/requirements-definition.md` | 1〜60、285〜419、475〜519、626〜675 行 |
| `doc/design/r4-video-analysis.md` | 全体 |
| `doc/design/r3-analysis-screens.md` | 49〜182、388〜420、742〜813、938〜1063 行 |
| `doc/design/r1-collection-jobs.md` | 324〜353、470〜515 行 |
| `supabase/migrations/20261005000000_r3_analysis_views.sql`、`20261007000000_r4_video.sql` | 全体 |
| `supabase/migrations/20261001100400_r1_views.sql` | 1〜250 行 |
| `supabase/migrations/20261002005926_r2_web_role.sql` | 1〜70 行と、ポリシーの行（grep） |
| `supabase/migrations/20261001100100_r1_collection.sql` | 79〜173 行（`profile_daily`、`account_daily_metrics`、`media`） |
| `doc/design-lab/v3/render.js` | 578〜720 行（`S.stories`、`S.timing`） |
| `doc/design-lab/v3/data.js` | 60〜115 行 |
| `apps/web/src/app/reels/page.tsx`、`apps/web/src/lib/queries/reels.ts` | 全体 |
| `apps/worker/src/jobs/profile-daily.ts`、`apps/worker/src/jobs/groups.ts` | 全体 |

**事実票**（親が 2026-10-08 に確認）:

- Meta 公式「Instagram User Insights」API リファレンス（表示は v25.0）: `follower_demographics` と `engaged_audience_demographics` は `period=lifetime`、`metric_type=total_value`、`breakdown` は `age`／`city`／`country`／`gender` のいずれか、`timeframe` は `this_week`／`this_month`（ほかは v20.0 以降使えない）。フォロワー 100 未満、反応 100 未満で返らない。上位 45 件だけ。最大 48 時間遅れる
- `doc/verification/r0-meta-api-verification.md`: follower_demographics（`this_month`）は 4 内訳とも取れた。engaged は 4 つとも空（V10）。`online_followers` は R1 の再確認で返った回があった（V6）。内訳つきの指標は内訳なしと同じリクエストに入れられない（P5）。ストーリーズの `navigation`、`link_clicks`、`replies` は R1 から収集済み

**読んでいないもの（未確認として扱ったもの）**: `node_modules/next/dist/docs/`（Server Functions、Forms。実装時に読む）、`doc/design-system.md`、design-lab v3 のナビの定義、R3 と R4 のグラフの部品の実装、`lib/reels.ts`（分位の関数の場所）、`checkAccess` の実装、属性の生の応答の形

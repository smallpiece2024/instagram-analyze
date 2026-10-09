# R5 投稿分類、ストーリーズ、オーディエンス、投稿時刻の分析の設計

- 版: 0.4（2026-10-09）。確認事項 Q1〜Q17 はすべて推奨どおり（ユーザー）。本番の画面の確認でオーディエンスを見直した（6.4 節）

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-08 | 起草（`nextjs-developer`。親が 2026-10-08 に確かめた事実票をもとにする） |
| 0.2 | 2026-10-08 | レビューを反映した。**3 章（収集）**: D10（`ok` は値が 1 件以上）、D11（`do nothing returning id`）、T5（切り詰めはコードポイント）、T14（例外の扱い、同じ value_key）、S6（fixture は形だけ）、S7（ログにトークンなどを出さない）。**5 章（DB）**: D2（`no action`）、D3（`lock_timeout`）、D4（identity の権限）、D5、D6（先に NFKC）、D7（comment で互いを参照する案を選んだ）、D8〜D9（check）、D10（年齢は value_key の順を選んだ）、D12（一意制約の列の順）、D13（索引）、D14（トリガー）、D15（名前の check）、S5（列ごとの grant と 4 本のポリシー。件数の上限は画面だけにした）、S13（sequence の権限）。**6 章（画面）**: S1（`checkAccess` には固定の経路）、S2（同一オリジンの検査）、S3（SQL は `lib/queries/tag-edit.ts`）、S4（`tag_values` は軸を通してアカウントで絞る）、S8（名前の検査）、S9 と T6（エラーの文言）、S10（軸の削除は 2 段階）、S11（JSX の子として出す）、S12（`no-store`）、T9（最新の週の決め方）、T10（期間の境目）、T11（並び順）、T12（`axis` の検査）。**7 章（テスト）**: T1〜T16 と S1〜S11 のテストを足し、担当ごとのファイルの表を作った（T13）。**8 章（段階）**: D3（db push の時刻）、T1、T2、T13（段階 3 は 5 人）。**9 章**: Q3 に T17、Q6 に T4、Q10 に T7、Q16 に S10 を書き足し、Q17（T18）を足した |
| 0.3 | 2026-10-08 | 確認事項 Q1〜Q17 をすべて推奨どおりに決めた（ユーザー） |
| 0.4 | 2026-10-09 | 本番の画面の確認で、オーディエンスを見直した（ユーザー）。性別と年齢は円グラフにし、推移のカードを外した（国はほぼ日本だけで変わらないため）。属性の週次の収集は続ける。R5 の完了条件の「属性の推移」を「属性の内訳」に替え、受け入れの T2 を改めた（6.4 節、7.4 節、8 章） |

- 要件: `doc/requirements/requirements-definition.md` 4.6 章（F-UI-30〜32、F-UI-40〜42、F-COL-30）、5.1 章（独自タグ、属性データの週次記録）、5.2 章（属性データは週 1 回）、5.5 章（時刻）、7 章（指標の定義）、9 章（画面一覧）、10 章（R5 の完了条件「タグを付けた投稿の比較、ストーリーズの離脱ファネル、属性の内訳が表示される」。2026-10-09 に「属性の推移」から改めた）
- 既存: R1 のビュー（`20261001100400_r1_views.sql` の `story_final_metrics`、`media_analysis_dataset`）、R2 の `web_app` ロール（`20261002005926_r2_web_role.sql`）、R3 のビュー（`20261005000000_r3_analysis_views.sql`）、R4 のビュー（`20261007000000_r4_video.sql`）、R3 と R4 の画面（`doc/design/r3-analysis-screens.md`、`doc/design/r4-video-analysis.md`）、ワーカーの `jobs/profile-daily.ts` と `jobs/groups.ts`、Web の `lib/auth.ts`（`checkAccess(pathname)`）と `lib/request-guard.ts`（`isSameOriginPost`）
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
- **時間帯別のオンラインフォロワー数**（F-COL-31 は削除済み）。R1 の再確認（V6）で `online_followers` が `period=lifetime` で返った回があったが、R5 では収集も表示もしない。収集を始めるかは確認事項 Q12
- **属性の年齢 × 性別の掛け合わせ**。事実票では `breakdown` は `age`／`city`／`country`／`gender` の「いずれか」で、複数を同時に指定できるかは未確認。R5 は 1 リクエスト 1 内訳で取り、画面も内訳ごとに出す
- **ハッシュタグの定点観測**（他人の投稿の収集。要件 4.8 章）。R5 は自分のキャプションから抜き出すだけ。最初のコメントに書いたハッシュタグはコメントを収集していないので数えない
- **分析用データセット（`media_analysis_dataset`）へのタグの列**。軸を利用者が決めるので列が固定できない。CSV や SQL では `media_tags` をつなぐ
- **タグの CSV 出力、タグの一括取り込み**。件数が数十件なので画面で付ける
- **ストーリーズの動画の特徴量の表示**（R1 から解析はしているが、R5 の画面には出さない）
- **特殊な投稿の除外の設定**（R3 の Q4 のまま作らない）
- **タグの変更の履歴と変更者の記録**。最後に変えた時刻だけを持つ（Q16）
- **タグを消す前のバックアップの手順**（`pg_dump` などの手順は作らない。S10）

---

## 2. 既に済んでいるもの

| もの | 内容 |
|---|---|
| ストーリーズの収集 | `stories` ジョブ（hourly の先頭）が、一覧にある間は毎時 `media_insight_snapshots` に 1 行書く。指標は views、reach、replies、shares、reposts、total_interactions、profile_visits、follows、link_clicks、`navigation`（tap_forward、tap_back、tap_exit、swipe_forward）、`profile_activity`。`replies` は日本では常に 0（事実票） |
| ストーリーズの確定値 | ビュー `story_final_metrics`（最後のスナップショットと、JST の日ごとの順番 `story_seq`、`story_count_of_day`）。確定値は消える 0〜60 分前の値 |
| 投稿時のフォロワー数 | `profile_daily`（daily、JST 05:30 ごろ。`captured_on` は JST の日付）。`media_list_metrics.followers_at_post` は「投稿より前で 3 日以内の最も近い記録」 |
| 経過時間をそろえた値 | `media_horizon_metrics`（`horizon = '24h'` と `within_tolerance`。24 時間の許容幅は + 6 時間） |
| 投稿の種類 | `media_kind()`（feed／carousel／reel／story）。`media.media_product_type` は `not null`（R1 のマイグレーションで確認） |
| ハッシュタグの数 | `media_analysis_dataset.hashtag_count`（`'#[^\s#]+'` の一致の数） |
| 曜日と時刻 | `media_analysis_dataset` の `posted_isodow_jst`、`posted_hour_jst`。R4 の `/reels` の区分（曜日、時間帯）も JST で判定している |
| 期間の絞り方 | R4 の `lib/queries/reels.ts` は `posted_at >= now() - make_interval(days => 365)`（今から 365 × 24 時間前以降） |
| Web の権限 | `web_app` は表を列挙して `grant` し、各表に `web_app` 向けの RLS のポリシーを書く（R2）。書き込みは `accounts` と `private.credentials`（接続設定）だけ。`private.credentials` の update は列を絞っている |
| 認可 | `checkAccess(pathname)`（`lib/auth.ts`）は経路を引数で受ける。`/login` は無条件に pass になる（親が確認）。`isSameOriginPost(headers, appUrl)`（`lib/request-guard.ts`） |
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
- 応答の形（段階 0 で確認。2026-10-08、親が `.local/api-verification/` の R1 の検証の応答（2026-10-01）を見た）: `data[0].total_value.breakdowns[0].results[]` の各要素が `dimension_values`（区分の名前 1 つの配列）と `value`（数値）を持つ。`dimension_keys` は指定した内訳の名前 1 つ。年齢は `18-24`、`25-34`、`35-44`、`45-54`、`55-64`、`65+` の 6 区分（`13-17` は返らなかった。文字列の順で若い順になる）、性別は `F`、`M`、`U`。国は 2 文字のコード（10 区分）、都市は「市区町村, 都道府県」の英語の文字列（45 区分、最長 49 文字）。国と都市の `results` は値の大きい順に並んでいない（表示側で並べる）
- **段階 0 で応答を写すときの決まり（S6）**: テストの fixture には応答の**形だけ**を写し、値は架空にする（都市は `CityA`、国は実在のコードでよいが人数は架空）。ID、ユーザー名、URL を入れない。`doc/` に残すのは件数と形だけ

### 3.2 いつ取るか

- daily グループに足し、`token_check` → `profile_daily` → `account_daily` → **`audience_demographics`** → `media_sync --full` の順にする
- 「週」は JST の月曜始まり（ジョブ開始時刻 `ctx.startedAt` から 1 回だけ求める。R1 5.0 章の決まり）。指標 × 内訳 × timeframe の組ごとに、**その週の行がまだなければ取る**。月曜に失敗した組は火曜以降に取り直せる。取れた週は 2 回目から何もしない（API を呼ばない）
- 空の応答（100 未満など）も「その週は取った」として記録する（3.3 の `status = 'empty'`）。翌日に取り直さない
- 曜日を固定せず「週にまだなければ」にするのは、ジョブの失敗や Actions の止まりで 1 週分が欠けないようにするため

### 3.3 書き込み

- 組ごとに 1 トランザクションで、`audience_captures` に 1 行と、`ok` なら `audience_values` に区分ごとの行を書く（5.1）
- **`ok` と `empty` の決まり（D10）**: 値の行が 1 件以上なら `ok`、0 件なら `empty`。`ok` なのに値の行がない、という状態を作らない
- **同じ週の 2 回目（D11、T14）**: `insert … on conflict (account_id, metric, timeframe, breakdown, week_start) do nothing returning id`。行が返らなければ（手元のワーカーと Actions が同時に動いたなど）値を書かず `skipped_this_week` に数える。事前の「その週の行があるか」の確認で通常は API を呼ばずに飛ばす
- API の失敗（`transient` の再試行を使い切った、`fatal`）は行を書かず `recordFailure`（`code` と `errorClass`。API の `message` は固定文言に置き換える）。翌日に同じ週の取り直しになる。一部の組が失敗したら `partial`（枠組みの既定の規則）
- `RateLimitExceeded` と `AuthError` は捕まえず外へ出し、枠組みに任せる（`stories` と同じ）
- 反応が 100 未満のときは、エラーではなく空が返る（段階 0 で確認。`engaged_audience_demographics` の 4 内訳とも、`total_value.breakdowns[0]` に `dimension_keys` だけがあり `results` がない）。これを `empty` とする。フォロワーが 100 未満のときの形は対象アカウントでは確かめられない（同じ形とみて `empty` とし、`data` が空の配列の場合も `empty` とする）
- 値は整数（`toCount` と同じ検査。`profile-daily.ts`）
- 区分の名前は 200 **コードポイント**までに切る（`[...s].slice(0, 200).join("")`。サロゲートペアの途中で切らない。T5）。切り詰めで同じ `value_key` が 2 つできたら、その組は書かずに失敗に数え（`recordFailure`、固定の文言）、件数だけをログに出す（T14）
- 生の応答は既定どおり保存する（`raw_response_id` を行に持たせる）
- `items_fetched` は書いた組の数（`empty` を含む）

### 3.4 ログ

- `info` で `captured`（ok）、`empty`、`skipped_this_week`、`failed` の件数だけを出す。区分の名前（国、都市）と値はログに出さない（公開ログに出るため）
- アクセストークン、`ig_user_id`、リクエストの URL がログと `job_runs` に出ないこと（S7）。既存の枠組み（`graph-client.ts` と `describeError` の `secrets`）が伏せていることを段階 2a で確かめ、テストで固定する

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
- ナビ（確認事項 Q11）: 概要、投稿一覧、リール分析、**タグ分析**、**ストーリーズ**、**投稿時刻**、**オーディエンス**、期間比較、接続と収集ログ（9 項目。design-lab v3 の「リール分析、ストーリーズ、投稿時刻」の順に合わせた。親が 2026-10-08 に確認）。タグの編集はナビに出さず、タグ分析と投稿詳細から移る（現在位置は「タグ分析」）。スマートフォンは R3 の複数段のタブのまま（9 項目で 2〜3 段の見込み。見た目はユーザーが確かめる）。
- **キャッシュ（S12）**: `/tags`、`/tags/edit`、`/stories`、`/audience`、`/timing` の応答はすべて `Cache-Control: private, no-store`（R3 4.7 節の規則。サムネイルの署名付き URL か本人のデータを含む）
- **期間の境目（T10）**: 「過去 N 日」は R4 と同じく `posted_at >= now() - make_interval(days => N)`（今から N × 24 時間前以降。暦の日付では切らない）。曜日、時間帯、日付の表示は JST

---

## 5. DB

### 5.1 マイグレーション（手書き。`supabase/migrations/20261009000000_r5_analysis.sql`。日付は実装の日に合わせる）

先頭に `set lock_timeout = '5s';` を書く（D3。`media` に一意制約を足すときに、収集のジョブと長く待ち合わないように）。

#### (1) 独自タグ

軸ごとに投稿 1 件につき値は 1 つ（確認事項 Q2）。アカウントの食い違い（別のアカウントの投稿に別のアカウントの値を付ける）を、複合の外部キーで DB が拒むようにする。

```sql
create table public.tag_axes (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  name text not null
    check (char_length(name) between 1 and 30 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (account_id, name),
  unique (id, account_id)            -- 下の複合の外部キーの相手
);

create table public.tag_values (
  id bigint generated always as identity primary key,
  axis_id bigint not null references public.tag_axes (id) on delete cascade,
  name text not null
    check (char_length(name) between 1 and 30 and name = btrim(name) and name !~ '[[:cntrl:]]'),
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
  foreign key (value_id, axis_id) references public.tag_values (id, axis_id)   -- 既定の no action（D2）
);
create index media_tags_axis_value_idx on public.media_tags (axis_id, value_id);   -- D13

-- updated_at は既存の public.set_updated_at() のトリガーで入れる（D14。Server Action では入れない）
create trigger tag_axes_set_updated_at before update on public.tag_axes
  for each row execute function public.set_updated_at();
create trigger tag_values_set_updated_at before update on public.tag_values
  for each row execute function public.set_updated_at();
create trigger media_tags_set_updated_at before update on public.media_tags
  for each row execute function public.set_updated_at();
```

- **値の削除**: `media_tags → tag_values` は既定の `no action`（D2）。文の終わりに検査されるので、軸を消したときの連鎖（軸 → 値、軸 → 対応）が消える順に左右されず通る。値だけを消すときは、付いている投稿があれば 23503 で拒む。画面は使っている件数を出し、0 件のときだけ削除のボタンを出す
- **軸の削除**: 付いている対応と値ごと消える（`cascade`）。画面は 2 段階で確かめる（6.2）
- 名前の check（D15）は画面の検査（6.2、S8）の後ろの守り。`char_length` は Postgres ではコードポイントの数で、画面の `[...s].length` と同じ数え方
- 名前の比較は大文字小文字を区別する（そのまま）
- 投稿の種類は DB では問わない。R5 の画面と Server Action はストーリーズに付けさせない（Q3）
- `public.set_updated_at()` は既存の関数（`20261001100000_r1_accounts.sql` で定義。`accounts` のトリガーが使っている。親が 2026-10-08 に確認）

#### (2) 属性の週次記録

```sql
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
  unique (account_id, metric, timeframe, breakdown, week_start)                    -- D12
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
- 一意制約の列の順（D12）は、画面の「その指標・timeframe・内訳の週の推移」とワーカーの「その週の行があるか」の両方で先頭から使える順
- **年齢の並び（D10）**: 列は足さず、`value_key` の文字列の順にする。年齢の区分（`13-17`、`18-24`、…、`65+` の想定）は先頭が 2 桁の数字なので、文字列の順が若い順と一致する。区分の形が想定と違えば（段階 0 で確かめる）、そのときに `position` の列を足す。列を足さないのは、API が返す順を保存する決まりを 1 つ減らせるため

#### (3) ハッシュタグ

ビューで抜き出す（保存しない。確認事項 Q5）。キャプションが変わっても追いかけられ、抜き出しの規則を変えても作り直すだけで済む。

```sql
create or replace function public.caption_hashtags(p_caption text)
returns setof text
language sql
stable
parallel safe
as $$
  -- 先にキャプション全体を NFKC にする（＃、全角空白、全角の英数と句読点が半角になる。D6）。
  -- 区切りと許す文字の一覧は確認事項 Q6 で決める。下は推奨案（許す文字を列挙する）
  select distinct lower(m[1])
  from regexp_matches(
    normalize(coalesce(p_caption, ''), NFKC),
    '(?:^|[^0-9A-Za-z_&/])#([0-9A-Za-z_ぁ-ゖァ-ヺー々〆ヶ一-鿿]+)',
    'g'
  ) as m
  where m[1] !~ '^[0-9]+$'                 -- 数字だけのタグは数えない（Q6）
$$;
comment on function public.caption_hashtags(text) is
  'キャプションのハッシュタグ（NFKC、小文字、重複なし）。media_analysis_dataset.hashtag_count（#[^\s#]+ の数）とは数え方が違う。索引には使わない（D5）';
revoke execute on function public.caption_hashtags(text) from public;
grant execute on function public.caption_hashtags(text) to web_app;

create view public.media_hashtags with (security_invoker = true) as
select m.id as media_id, m.account_id, h.tag
from public.media m
cross join lateral public.caption_hashtags(m.caption) as h(tag)
where m.media_product_type <> 'STORY';
```

- 1 投稿に同じタグが 2 回あっても 1 回に数える（`distinct`）。英字は小文字にそろえる（`#Coffee` と `#coffee` を同じにする）
- 揮発性は `stable` のまま（D5。`immutable` でもよいが、索引に使わないので区別の利益がない）。`lower` の結果は照合順序に左右されうるが、対象は NFKC 後の英字なので影響しない見込み
- 正規表現の文字の範囲（`ぁ-ゖ` など）と、`(?:^|…)` の前置き（URL の中の `#` を拾わないため）の書き方が Postgres の正規表現で意図どおり動くかは未確認。段階 1 で 7 章のテストで確かめる。データベースの文字コードが UTF8 であることも確かめる（`normalize` の前提）
- `media_analysis_dataset.hashtag_count` は変えない（ビューの列の意味を変えると作り直しが要るため）。差は comment に書いた
- 性能: 投稿数百件、キャプション数百文字なので、画面のたびに全件を走査しても問題ない見込み（段階 1 で `explain analyze`）

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
```

- 閲覧率の分母（確認事項 Q8）: リーチ率と同じ規則にする。ストーリーズは収集を始めてから（2026-10-01 以降）のものしかないので、`profile_daily` が欠けた日を除けば分母がある。投稿の後の記録は使わない（R3 の R-10 と同じ）
- **規則を関数にまとめるか（D7）: まとめず、comment で互いを参照させる。** 関数にすると本番で使っている R3 の `media_list_metrics` を作り直すことになり、R5 の範囲で R3 のビューとテストに触れる。使う所は 2 か所だけなので、comment で足りる（R4 の `retention_rate` と同じやり方）。`media_list_metrics` の comment にも、次に作り直すときに `story_list_metrics` を参照する一文を足す
- `metric_value()` は `numeric` を返すので、`view_rate` と `exit_rate` は整数の割り算にならない（50 ÷ 200 = 0.25。7 章のテストで確かめる。T8）。`followers_count` は `integer` だが分子が `numeric` なので結果は `numeric`
- 「次へ」「戻る」などの割合は画面で計算する（分母は 4 つの操作の合計。6.3）。ビューには件数と、要件 7.2 章の定義がある閲覧率と離脱率だけを置く

#### (5) 権限と RLS

R2 の決まり（表とビューは列挙して `grant` し、表には `web_app` 向けのポリシーを書く。関数は PUBLIC の実行権を取り消す）に従う。update は列で与える（S5。R2 の `private.credentials` と同じ）。

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
grant select, insert, delete on table public.tag_axes, public.tag_values, public.media_tags to web_app;
grant update (name, sort_order) on table public.tag_axes to web_app;
grant update (name, sort_order) on table public.tag_values to web_app;
grant update (value_id) on table public.media_tags to web_app;
-- updated_at はトリガー（D14）が入れる。トリガーが書く列に update の権限は要らない

-- ポリシーは操作ごとに 4 本（R2 の書き方。for all は使わない）。3 表とも同じ形
create policy web_app_select on public.tag_axes for select to web_app using (true);
create policy web_app_insert on public.tag_axes for insert to web_app with check (true);
create policy web_app_update on public.tag_axes for update to web_app using (true) with check (true);
create policy web_app_delete on public.tag_axes for delete to web_app using (true);
-- tag_values、media_tags も同じ 4 本

-- 属性: 読むだけ（書くのはワーカー）
grant select on table public.audience_captures, public.audience_values to web_app;
create policy web_app_select on public.audience_captures for select to web_app using (true);
create policy web_app_select on public.audience_values   for select to web_app using (true);

-- ビュー
grant select on table public.media_hashtags, public.story_list_metrics to web_app;
```

- 親のまとめは `updated_at` も列の grant に入れていた（S5）。D14 でトリガーが入れることにしたので、`web_app` には与えない（Server Action が書かない列は書けないほうが狭い）。トリガーの中の代入に列の権限が要らないことは結合テストで確かめる
- ポリシーが `using (true)` なのは R2 と同じ考え（利用者は本人ともう 1 人で、誰が使えるかは `checkAccess` が決める。対象のアカウントは `getTargetAccount()` と SQL の `account_id = ${accountId}` で絞る。6.2）。アカウントの食い違いは 5.1 (1) の複合の外部キーで DB が拒む
- **件数の上限（軸 10、値 50）は画面（Server Action）だけで検査し、ポリシーの `with check` には入れない。** 同じ表を数える副問い合わせのポリシーは、同時の insert では上限を守れず（どちらも上限前の数を見る）、ポリシーの書き方も複雑になる。利用者は 2 人で、上限は誤操作への備えなので画面の検査で足りる
- identity の列への insert（D4、S13）: `generated always as identity` は insert の権限だけで足り、裏の sequence の権限は要らない見込み。結合テストで `web_app` として insert して確かめ、要るなら表ごとに `grant usage on sequence` を列挙する。`serial` は使わない
- `web_app` の `statement_timeout`（15 秒）はそのまま
- 関数の棚卸しのテスト（`web-role.test.ts`）に `caption_hashtags` を足す

#### (6) ロールバック（末尾のコメント）

```sql
-- 1. 先にワーカーを R5 より前の版に戻す（audience_demographics が表に書くため）。Web も R5 より前に戻す
-- drop view if exists public.story_list_metrics;
-- drop view if exists public.media_hashtags;
-- drop function if exists public.caption_hashtags(text);
-- drop table if exists public.audience_values, public.audience_captures;
-- drop table if exists public.media_tags, public.tag_values, public.tag_axes;   -- 利用者が付けたタグも消える
-- alter table public.media drop constraint if exists media_id_account_key;
-- delete from supabase_migrations.schema_migrations where version = '20261009000000';
```

### 5.2 索引

- `media_tags`: 主キー `(media_id, axis_id)`（投稿ごとのタグ）、`(axis_id, value_id)`（軸ごとの集計、値ごとの件数、外部キーの検査。D13）
- `audience_captures`: 一意制約 `(account_id, metric, timeframe, breakdown, week_start)`
- `audience_values`: 主キー `(capture_id, value_key)`
- ストーリーズと投稿時刻は既存の `media (account_id, media_product_type, posted_at desc)` と `media_insight_snapshots (media_id, …)` を使う。新しい索引は足さない

---

## 6. 画面

共通: 対象のアカウント、空とエラーの表示、最終更新、`MissingReason`（「—」の理由）、件数 n の出し方（0／1〜2／3〜9／10 以上）、`MetricHint` は R3 3.1 節のまま。計算はサーバーの純関数（`lib/*.ts`）、描画は Server Component。グラフは SVG を自作（依存を増やさない。R3 の Q2）。分位は `percentile_cont` と同じ線形補間（R4 の `lib/reels.ts` の関数を使う。場所は未確認）。並べ替えは値の null を向きによらず末尾、同順位は投稿日時、さらに id の順（T16。R4 と同じ）。

### 6.1 タグ分析（`/tags`）

見本はない。R4 のリール分析と投稿時刻の部品を組み合わせる。

**対象**: 過去 1 年間（365 日。4 章の期間の境目）の投稿（ストーリーズを除く）。値は R3 の Q21 のとおり**各投稿の最新の値**（`media_list_metrics`）。リーチ率だけは定義どおり 7 日時点。

**上部の選択**（リンクのチップ。投稿時刻の画面と同じ形）:

| 名前 | 値 | 既定 |
|---|---|---|
| `axis` | 軸の id（`^\d{1,18}$` で、そのアカウントの軸） | 並び順の最初の軸 |
| `kind` | `all`、`reel`、`feed`、`carousel` | `all` |
| `m` | `reach`、`views`、`save_rate`、`share_rate`、`er`、`reach_rate` | `reach` |

- `axis` の検査（T12）: 形が違う、消された軸、別のアカウントの軸の id は、どれも既定（最初の軸）に戻す。改名した値は id で引くので新しい名前で出る
- 種類が混ざると比べ方がゆがむ（リールの多いタグが高く見える）が、自動では切り替えない。各行に種類ごとの件数を添えて判断を委ねる
- 不正な値は既定に戻す（R3 4.7 節）。軸が 0 件なら、タグの比較のカードの代わりに「タグの軸がありません」と `/tags/edit` へのリンク

**カード**:

| カード | 内容 | 要件 |
|---|---|---|
| 見出し | 「投稿 n 件（過去 1 年間）・タグ付き m 件」と選択。右に「タグを編集」（`/tags/edit` へのリンク）。m は選んだ軸の値がある投稿の数で、n と同じ条件（期間、ストーリーズを除く、`kind`）で数える | — |
| タグごとの比較（全幅） | 選んだ軸の値ごとの行。列は件数（種類の内訳を小さく）、経過日数の中央値、リーチ、閲覧数、ER、保存率、シェア率、リーチ率の**中央値**と、選んだ指標 `m` の帯グラフ（投稿ごとの点、25〜75% の帯、値の中央値の線、全投稿の中央値の灰色の線、目盛は行で共通。投稿時刻の「上位の組み合わせ」と同じ部品）。投稿が 0 件の値の行も出す（件数 0、ほかは「—」）。最後の行は「タグなし」（その軸の値がない投稿。確認事項 Q4） | F-UI-31 |
| 種類ごとの比較（半幅） | 種類（フィード、カルーセル、リール）ごとの同じ列の中央値。`kind` の選択には従わない（種類そのものを比べるカードなので） | F-UI-31 の「種類ごと」 |
| ハッシュタグ（全幅） | ハッシュタグごとの行: 使った投稿の件数、選んだ指標 `m` の中央値、リーチと保存率の中央値、最後に使った日。件数の多い順、同数は中央値の高い順、さらにタグの文字列の順。3 件未満の行は薄く（R3 の n の決まり）。上位 30 行まで出し、残りの行数を書く | F-UI-32 |

- 中央値の n は列ごとに数える（R3 3.1 節。リーチ率は値のある投稿が少ない）。n が 0 の列は「—」
- 経過日数の中央値は「最新の値」が投稿によって違う時点の値であることを読む人が頭に置けるようにするため（R3 の Q21 と同じ考え。説明の文言は足さない）
- 行の並びは値の `sort_order`、同じなら id。「タグなし」は最後
- スマートフォン: 表は横スクロールの枠に入れ、値の名前の列を固定する。隠す列（`hide-m`）は閲覧数、ER、経過日数。帯グラフは表の下に縦に並べる

**クエリ**（`lib/queries/tags.ts`）: `getTagAnalysis(accountId, axisId)` は期間内の投稿を 1 行ずつ返す。`media_list_metrics l left join media_tags t on t.media_id = l.media_id and t.axis_id = ${axisId} and t.account_id = ${accountId}`（軸の条件は `on` 句に置く。`where` に置くと「タグなし」の投稿が落ちる。主キーが `(media_id, axis_id)` なので投稿は重ならない。T3）。値の名前と並び順は別の問い合わせ（その軸の値の全件）で取る。`getHashtagStats(accountId)` は `media_hashtags` と `media_list_metrics` をつないで投稿ごとに返す。中央値と帯は `lib/tags.ts` で計算する（件数が数百件なので、R4 と同じくページのたびに計算し直す）。

### 6.2 タグの編集（`/tags/edit`）

場所は専用画面（確認事項 Q1）。投稿詳細には付いているタグを表示し、その投稿の行へのリンク（`/tags/edit#m-{id}`）を置く。

**構成**:

1. **軸と値の管理**（カード）: 軸ごとに、名前、値の一覧（名前と使っている件数）。操作は「軸を足す」「軸の名前を変える」「軸を消す」「値を足す」「値の名前を変える」「値を消す（0 件のときだけ）」「上へ」「下へ」
2. **投稿へのタグ付け**（カード）: 投稿の表（ストーリーズを除く、新しい順、1 ページ 50 件）。列はサムネイル、題名（キャプションの 1 行目）、投稿日、種類、軸ごとの `<select>`（「なし」と値）、保存のボタン。1 行 1 フォーム（行ごとに保存）。絞り込みは「この軸が未設定の投稿だけ」（`?missing={axis_id}`。`axis` と同じ検査で、不正なら絞り込みなし）
3. 軸が 0 件のときは、要件の例（テーマ、目的、CTA、キャンペーン）を文字で示し、軸を足すフォームだけを出す（Q15）

**軸の削除は 2 段階（S10）**: 「軸を消す」は確認の表示（「この軸と値 n 個、付いているタグ m 件が消えます」と「消す」「やめる」）に移り、そこの「消す」で削除の Action を呼ぶ。確認の表示は `?confirm_delete={axis_id}` で JS なしに出す。

**並び順（T11）**: 足すときは同じ親（アカウントか軸）の `sort_order` の最大値 + 1（なければ 0）。表示は `sort_order`、同じなら id の順。「上へ」「下へ」は隣と `sort_order` を入れ替える（1 トランザクション）。先頭の「上へ」と末尾の「下へ」は出さない（押されても何もしない）。

**ファイルの分け方（S3）**:

- `app/tags/edit/actions.ts`（`'use server'`）は Server Action の関数だけを export する（定数、型、補助の関数は export しない。export の一覧をテストで固定する）
- 書き込みと読み出しの SQL は `lib/queries/tag-edit.ts`（`import "server-only"`）に置き、Action はそれを呼ぶだけにする。編集画面の読み出し（軸、値、件数、投稿の表）も同じファイル

**Server Action**:

| 関数 | 入力 | 処理 |
|---|---|---|
| `createAxis`、`renameAxis`、`deleteAxis`、`moveAxis` | 軸の id、名前、向き | `tag_axes` の insert／update／delete |
| `createValue`、`renameValue`、`deleteValue`、`moveValue` | 軸の id、値の id、名前、向き | `tag_values`。削除は使っている件数が 0 のときだけ（DB も 23503 で拒む） |
| `setMediaTags` | 投稿の id、`axis_{id}` → 値の id（または空）の組 | 1 トランザクションで、空の軸は `media_tags` を delete、値のある軸は `insert … on conflict (media_id, axis_id) do update set value_id = excluded.value_id` |

**各 Action の先頭で行う検査（順に）**:

1. **同一オリジンの検査（S2）**: `headers()` から `isSameOriginPost(headers, appUrl)`（`lib/request-guard.ts`）を呼び、偽なら何もせず固定の文言。Next.js の Server Action 自身の Origin の検査に重ねる多重の防御。`next.config` の `serverActions.allowedOrigins` は設定しない（別のオリジンを許す理由がない）。サイト全体の `Referrer-Policy` は `same-origin` のまま（署名付き URL の保護は `<img referrerPolicy="no-referrer">` で行う）
2. **認可（S1）**: `checkAccess("/tags/edit")` を**固定の値**で呼び、`pass` でなければ何もせず固定の文言。要求の見出し（`referer`、`next-url` など）から取った経路は渡さない（`checkAccess` は `/login` を無条件に pass にするので、経路を偽られると素通りになる）。Server Action は公開の POST の口なので proxy に頼らない
3. **対象のアカウント**: `account_id` はフォームから受け取らず、`getTargetAccount()` で決める
4. **入力の形**: すべての値が `typeof v === "string"` であること（`FormData` の `File` を拒む）。軸と値の id は `^\d{1,18}$`、投稿の id は `^\d{1,25}$`。`setMediaTags` のキーは `^axis_\d{1,18}$` で 10 個まで、値は空か `^\d{1,18}$`（S8）
5. **名前（S8）**: `normalize("NFC")` → 前後の空白を除く（`trim`）→ `[...s].length` で 1〜30 コードポイント → `/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u` に当たれば拒む。`#` で始まる名前は拒まない。DB の check（D15）が後ろで守る
6. **数の上限**: 軸 10 個、1 軸の値 50 個（画面だけで検査する。理由は 5.1 (5)）

**SQL の絞り方（S4）**: どの文も対象のアカウントの行だけに効くようにする。

- `tag_axes`: `where id = $axis and account_id = $acc`
- `tag_values` には `account_id` がないので、軸を通して絞る: `update public.tag_values v set name = $name from public.tag_axes a where v.axis_id = a.id and a.account_id = $acc and v.id = $id`（delete は `using`、insert は `insert … select … from tag_axes where id = $axis and account_id = $acc`）
- `media_tags`: delete と upsert とも `account_id = $acc`。insert の `account_id` は `getTargetAccount()` の値。投稿がストーリーズなら書かない（`media_product_type <> 'STORY'` の投稿だけを対象にする。Q3）
- 0 行に効いたとき（別のアカウントの id、消された id）は何もせず汎用の固定の文言

**エラーの文言（S9、T6）**:

| 場合 | 文言 |
|---|---|
| 23505（一意制約。同じ名前） | 「同じ名前があります」 |
| 23503 を値の**削除**で受けたとき | 「使っている投稿があります」 |
| それ以外（insert／update の 23503、入力の検査、0 行、同一オリジンでない、認可、ほかの DB のエラー） | すべて 1 つの固定の文言（例: 「保存できませんでした」） |

- DB のエラー文は返さない（R3 4.7 節）。ログは Action の名前、成否、SQLSTATE だけ。タグの名前、投稿の id は出さない
- 成功したら同じページを描き直す。`revalidatePath` を使うなら `/tags/edit` と、`setMediaTags` では `/media/[id]` と `/tags` に限る（S12）。フォームの状態の扱い（`useActionState` か `redirect` か）と Next.js 16 の Server Functions の作法は、実装の前に `node_modules/next/dist/docs/` の該当資料（Forms、Server Functions／Mutating data）を読んで決める（この起草では読んでいない）
- JS なしでも動く `<form action>` で作る。保存中の表示は既存の `PendingMark` 相当

**投稿詳細の変更**（`/media/[id]`）: 見出しの下に、付いているタグを「軸: 値」のチップで並べ、右に「タグを編集」のリンク。タグがなければリンクだけ。

### 6.3 ストーリーズ（`/stories`）

見本（`S.stories`）どおりに作る。値は `story_list_metrics`（確定値 = 消える前の最後の取得）。

**期間**: `range` の選択（`30`、`90`、`365`。既定 `30`。確認事項 Q9）。4 章の期間の境目で絞る。

**カード**:

| カード | 内容 |
|---|---|
| 見出し | 「全 n 件（過去 30 日）」と期間の選択 |
| 期間全体の指標 | 件数、閲覧率の中央値、離脱率の中央値、リンクの合計、返信の合計（見本の `metrics-row`。各ラベルに `MetricHint`） |
| ストーリーズの一覧（全幅） | サムネイル、投稿日時、種類（画像／動画）、閲覧、閲覧率、離脱率、次へ、戻る、次のアカウントへ、リンク、返信。列の見出しで並べ替え（`sort`、`dir`）。既定は投稿日時の新しい順。スマートフォンで隠す列は次へ、戻る、次のアカウントへ、返信（見本の `hide-m`）。ページ送りは R4 の一覧と同じ `PAGE_SIZE` |
| 閲覧率の推移（全幅） | 横軸は投稿の順（古い順）、ラベルは月/日。点つきの折れ線（`--chart-4`） |
| 操作の内訳（半幅） | 直近 10 件（10 件未満ならあるだけ）の横の積み上げ棒。次へ、戻る、離脱、次のアカウントへの割合（分母は 4 つの合計。合計 0 なら棒を描かず「—」）。値は `<title>` と `aria-label` |
| 離脱ファネル（半幅） | 続けて 2 件以上出したまとまりがあるときだけ。1 件目の閲覧を 100% にした縦棒。どのまとまりを出すかは確認事項 Q10。まとまりがなければ見本の文言「期間中に、続けて 2 件以上出したストーリーズはありません。」 |

- 閲覧率の分母がない（投稿の前 3 日以内に `profile_daily` の記録がない）ものは「—」で、理由は `no_baseline_data`（R3 の文言「投稿時のフォロワー数の記録がない」）
- 指標が null（取得の失敗）は「—」（`missing`）。返信は日本では常に 0 だが、そのまま 0 と出す（説明の文言は足さない）
- 中央値と合計は値のあるものだけで計算し、n を添える（閲覧率は分母のあるものだけ）
- **まとまりの判定**（`lib/stories.ts` の純関数。T7）: 入力を投稿日時、さらに id の古い順に並べ直してから、前の 1 件との差が 6 時間以上なら別のまとまり（6 時間ちょうどは別。見本の `>= 6 * 36e5`。同時刻は同じまとまり）。判定は期間で絞る前の全件で行う（Q10）
- **ファネルの値**: 2 件目以降 ÷ 1 件目の閲覧。1 件目の閲覧が null か 0 なら、そのまとまりのファネルは「—」にし、ほかのまとまりに切り替えない（T7、T15。比べ方を自動で変えない）。2 件目が 1 件目より多ければ 100% を超えた棒をそのまま描く（縦軸の上限は値の最大に合わせる）
- 消えた後に手で削除と判定されたもの（`gone_at` あり）も含める（R3 の「データは残す」）

**クエリ**（`lib/queries/stories.ts`）: `getStories(accountId, rangeDays)` が期間内の行を投稿日時の順に返す。ファネル用に、期間の始まりより前の 6 時間ぶんの行も返す（まとまりを期間の境目で切らないため。Q10）。`numeric` は SQL で `float8` にする（R4 の `reels.ts` と同じ）。最終更新は `metrics_fetched_at` の最大。

### 6.4 オーディエンス（`/audience`）

見本はない。概要の部品（横棒、凡例）と円グラフ（`components/charts/Pie.tsx`）を組み合わせる。

**カード**（上から）:

| カード | 内容 |
|---|---|
| 見出し | 「フォロワーの属性（記録 n 週）」。最新の週の記録日 |
| 性別（半幅） | 最新の週の区分ごとの割合の円グラフ（2026-10-09 に横棒から替えた）。12 時から時計回りに女性、男性、不明。割合が 5% 以上の扇には中に名前と割合を 2 行で書く（黒の文字に白の縁取り）。凡例に人数と割合 |
| 年齢（半幅） | 同上（区分は `value_key` の順。5.1 (2)）。扇の色は 4 色で、5 つ目からは同じ色を薄める |
| 国（半幅） | 上位 10 件の人数と割合の横棒。11 件以上あれば「ほか n 件」（10 件ちょうどなら出さない） |
| 都市（半幅） | 同上（S13。上位 10 件と「ほか n 件」） |
| 反応したユーザーの属性 | `engaged_audience_demographics` に `ok` の週が 1 つでもあるときだけ、上の 4 枚と同じ形で出す（F-UI-41）。なければ節ごと出さない |

- **最新の週（T9）**: 指標（フォロワー／反応）ごとに、`audience_captures` の行がある最も新しい `week_start` を全体で 1 つ決める。その週のある内訳が `empty` か行なしなら、そのカードは「—」（理由は `missing`。新しい理由は足さない）。前の週の値で埋めない（T15）
- **割合の分母**: その週・その内訳で返った区分の合計（上位 45 件まで）。カードの下に「分母: 返った区分の合計」と書く（要件 1.3 の原則 4）。国と都市は上位 45 件しか返らないので、フォロワー数とは合わない。人数も並べて出す。確認事項 Q13
- **推移は出さない（2026-10-09、ユーザー）**: 当初は週ごとの性別、年齢、国の割合の折れ線を全幅のカードに出していた。国はほぼ日本だけで週ごとに変わらないので、カードごと外した。属性の週次の収集（`audience_demographics`）は続け、過去の週の行も `audience_captures` に残すので、後で推移を出せる。推移の計算（週の軸、欠けの扱い）は git の履歴にある
- カードの下に時点を書く（R3 3.1 節）: 「2026-10-12 の週（日本時間）の記録・取得 2026-10-13 05:31」。Meta の計算が最大 48 時間遅れることは書かない（Q17）
- 記録が 0 週なら「まだ収集されていません」と `/jobs` へのリンク（R3 の空の状態）
- 区分の名前（国コード、都市名）は API の値をそのまま文字として出す（国コードを日本語の国名にする対応表は作らない。確認事項 Q13）

**クエリ**（`lib/queries/audience.ts`）: `getAudience(accountId, metric, timeframe)` が週 × 内訳 × 区分の行と `status` を返す（直近 52 週）。割合、上位の切り出し、欠けの扱いは `lib/audience.ts`。

### 6.5 投稿時刻（`/timing`）

見本（`S.timing`）と要件 F-UI-42 の構成（2026-10-05 決定）どおりに作る。

**対象**: 過去 1 年間（365 日。4 章の期間の境目）の投稿（ストーリーズを除く）。曜日と時間帯は投稿日時の JST。時間帯は 3 時間ごとの 8 区分（0-3、3-6、…、21-24。下端を含む。3:00 ちょうどは 3-6）、曜日は月〜日（ISO の曜日。`media_analysis_dataset` の `posted_isodow_jst` と同じ）。

**上部の選択**:

| 名前 | 値 | 既定 |
|---|---|---|
| `m` | `reach_24h`、`views_24h`、`reach_latest`、`views_latest`（確認事項 Q14） | `reach_24h` |
| `kind` | `all`、`reel`、`feed`、`carousel` | `all` |

- 選択はリンクのチップ。指標の文言に件数を出す（例: 「24 時間リーチ（3 件）」。R4 の Q1 と同じ形）。24 時間の値が 0 件でも既定を変えない（T15）
- 24 時間の値は `media_horizon_metrics` の `horizon = '24h'` かつ `within_tolerance`（24 時間 + 6 時間以内のスナップショット）。収集を始めた 2026-10-01 より前の投稿には 24 時間時点の値がなく、今は大半の投稿が対象から外れる（件数は段階 0 で数える）

**カード**（すべて選んだ指標と種類で描き直す）:

| カード | 内容 |
|---|---|
| 曜日 × 時間帯（全幅） | ヒートマップ。色は中央値、件数 0 は空欄、件数 1 は数字に「※」、カードの下に「※: n=1」。見出しは「曜日 × 時間帯の 24 時間リーチ（中央値）」（指標の名前を入れる。「初速」の語は使わない） |
| 時間帯別（半幅） | 縦棒。棒の下に件数。3 件未満は薄く |
| 曜日別（半幅） | 同上 |
| 上位の組み合わせ（全幅） | 件数 2 件以上の組み合わせを中央値の高い順（同じなら曜日、時間帯の順）に 5 行。曜日、時間帯、中央値、件数、投稿ごとの値の帯グラフ（目盛は行で共通、全投稿の中央値の線）。点は投稿詳細へのリンク。カードの補足「件数 1 件の組み合わせは除く」 |

- ヒートマップの色の段階は、表示している値の最小〜最大で決める（指標と種類ごと）。最小と最大が同じなら全部同じ色で描き、0 で割らない（T16）。凡例に値の範囲を書く
- 対象が 0 件なら、全カードの代わりに「—」と件数（「24 時間リーチ（0 件）」の選択で分かる）。文言は足さない
- 集計は `lib/timing.ts` の純関数（曜日 × 時間帯の中央値と件数、上位 5）。曜日と時刻は SQL で JST に変換して受け取る（JS で二重に持たない。R3 6 章）

**クエリ**（`lib/queries/timing.ts`）: `getTimingRows(accountId)` が期間内の投稿ごとに `kind`、`extract(isodow from posted_at at time zone 'Asia/Tokyo')`、`extract(hour from …)`、24 時間のリーチと閲覧数（`within_tolerance` のときだけ）、最新のリーチと閲覧数を返す。指標と種類の切り替えは TS でする（1 回の取得で済む）。

### 6.6 部品

| 部品 | 状態 |
|---|---|
| チップの選択（リンク） | R4 の `ObjectiveChips` の形を共通の部品にする（`components/`）。段階 2b の担当 |
| 帯グラフ（投稿ごとの点、帯、中央値、全体の中央値の線） | 新規（`components/charts/Strip`）。タグ分析と投稿時刻で使う |
| ヒートマップ | 新規（`components/charts/Heatmap`） |
| 縦棒（棒の下に件数、薄い表示） | R4 の区分のカードが使っている部品があるか確かめて使う（未確認） |
| 横の積み上げ棒、横棒（割合） | 新規（ストーリーズの操作の内訳、オーディエンス） |
| 折れ線（欠けで線を切る） | R3 の部品を使う。null で線を切れるかは未確認（切れなければ 2b で足す） |

- すべて SVG を Server Component で描き、値は `<title>` と `aria-label`、点 0 個、1 個、全部同じ値で `NaN` を出さない（R3 9.1 節）
- **利用者の文字（キャプション、タグの名前、ハッシュタグ、国と都市の名前）は、SVG も含めて JSX の子や属性として出す。** `dangerouslySetInnerHTML` と、文字列をつないで SVG や HTML を組み立てるやり方は使わない（S11。見本の `render.js` は文字列で組み立てているので、そのまま移さない）
- リンクのクエリは `URLSearchParams`（既存の `buildHref`）で組み立てる。ハッシュタグや名前を URL に入れるときも同じ

---

## 7. テスト

### 7.1 確かめること

| 区分 | 内容 |
|---|---|
| 単体（worker） | 週の始まり（JST の月曜。日曜 23:59 と月曜 0:00、UTC 15:00 をまたぐとき）。その週の行がある組を飛ばす。応答の解析（区分あり、空、形の違う応答、値が数でない）。値の行 0 件で `empty`（D10）。区分の名前の切り詰めがコードポイントで、サロゲートペアの途中で切らない（絵文字を含む 201 コードポイント）。切り詰めで同じ value_key ができたら組を失敗にして件数だけログ（T14）。API の失敗で行を書かず `recordFailure`、固定の文言。`RateLimitExceeded` と `AuthError` を外へ出す。一部の組の失敗で `partial`。ログと `job_runs` に区分の名前、アクセストークン、`ig_user_id`、URL がない（S7）。8 リクエストの組み立て（内訳ごとに 1 つ、`metric_type`、`timeframe`、`period`）。グループの順番 |
| 結合（worker と DB） | 1 トランザクションの書き込み。同じ週の 2 回目は何もしない。`on conflict do nothing` で行が返らないとき値を書かず skipped に数える（D11）。`empty` の行。`check` の列挙外（metric、timeframe、breakdown）と月曜でない `week_start` で失敗する（D8、D9） |
| DB | `media_tags` の複合の外部キー（別のアカウントの投稿、軸 A に軸 B の値の id、消された値の id を拒む。T6）。軸ごとに 1 つ。値の削除は付いていれば 23503、付いていなければ消える。**タグが付いた投稿がある軸を消すと、値と対応が消える**（D2）。名前の check（前後の空白、制御文字、31 文字。D15）。トリガーが `updated_at` を入れる（`web_app` が `updated_at` の列の権限を持たなくても）。`caption_hashtags`（7.2）。`story_list_metrics`: 分母の 3 日の境目（同時刻は使う、ちょうど 3 日前は使う、3 日と 1 秒前は使わない、投稿の後は使わない）、`view_rate` と `exit_rate` が整数の割り算にならない（50 ÷ 200 = 0.25）、閲覧 0 で離脱率 null、`navigation` のキーがない（T8）。権限: `web_app` で読めてタグを書け、列の grant の外の列（`account_id`、`axis_id`、`updated_at`）は update できない、属性は書けない、`anon` と `authenticated` は読めない、`web_app` として identity の列に insert できる（D4）。ビューの `security_invoker`。関数の棚卸し（`web-role.test.ts`）。マイグレーションが `supabase db reset` で通る |
| 画面（単体） | 入力の検査（`axis`、`kind`、`m`、`range`、`sort`、`dir`、`missing`、`confirm_delete` の不正値で既定。消した軸、別のアカウントの軸、改名した値。T12）。Server Action（7.3）。中央値と n（列ごと）、「タグなし」の行、0 件の値の行。ハッシュタグの並び（件数、同数の順）。ストーリーズのまとまり（T7: 5 時間間隔 3 件の鎖は 1 つ、6 時間ちょうどは別、同時刻 2 件、入力の順が乱れている、最新のまとまりの 1 件目が期間外、1 件目の閲覧が null か 0 で「—」にして別のまとまりに切り替えない、2 件目が 1 件目より多い）、操作の割合（合計 0）、「直近 10 件」で 10 件未満、閲覧率の「—」。属性（T9）: 割合の分母 0、`empty` の週、最新の週の決め方、上位 45 件から外れた週を 0 で描かない、年齢の並び、「ほか n 件」の境目（10、11、45 件）。投稿時刻の曜日 × 時間帯の集計（境目の 3 時、JST の 0 時）、※ の判定、上位 5（同値の順）、件数 1 の除外、ヒートマップの全部同じ値（T16）。並べ替えの null は末尾、同順位は投稿日時と id（T16）。グラフの部品の空と 1 点。`#<img src=x onerror=…>` や `<script>` を含むキャプションとタグの名前が文字として出る（S11） |
| 方針の回帰（T15） | 24 時間の値が 0 件でも `/timing` の既定は `reach_24h`、`kind` の既定は `all`。ファネルの 1 件目の閲覧が null でもほかのまとまりに切り替えない。属性が `empty` の週でも前の週の値で埋めない |
| 期間の境目（T10） | 各画面に 1 本: 365 日（ストーリーズは 30 日）× 24 時間ちょうど前の投稿は入り、1 秒前は入らない。JST 0:00 前後（UTC 14:59 と 15:00）の投稿の曜日と日付 |
| 画面（結合） | `getTagAnalysis`: 「タグなし」は `on` 句の条件で落ちない、投稿が重ならない、ストーリーズと 366 日前の投稿は入らない、「タグ付き m 件」も同じ条件（T3）。`getHashtagStats`、`getStories`（期間の前 6 時間の行）、`getAudience`、`getTimingRows` が 2 アカウントのデータを分ける。`lib/queries/tag-edit.ts`: 2 アカウントのデータで、別のアカウントの値の改名・削除・移動、タグの解除が 0 行になる（S4）。`setMediaTags` が 1 トランザクションで入れ替える。ストーリーズの id では書かない |
| 受け入れ | 7.4 |

### 7.2 ハッシュタグ（T4。期待値は Q6 の回答で確定する）

| 入力 | 推奨の期待値 |
|---|---|
| `#Coffee #coffee` | `coffee` 1 つ |
| `＃珈琲`（全角の＃） | `珈琲` |
| `#a　#b`（全角空白）、`#a\n#b`（改行） | `a`、`b` |
| `#コーヒー。`、`#coffee!`、`(#coffee)` | 句読点と括弧の前で終わる |
| `#ｺｰﾋｰ`（半角カナ） | NFKC で `コーヒー` |
| `#coffee☕`、`#👨‍👩‍👧`（ZWJ を含む絵文字） | 絵文字の前で終わる（`coffee`）。絵文字だけは数えない |
| `#2026` | 数えない（数字だけ） |
| `#2026年` | `2026年` |
| `https://example.com/#top` | 数えない（`/` の後の `#`） |
| `a#b` | 数えない（英数字の直後の `#`） |
| `##coffee`、`#` だけ | `coffee` 1 つ、なし |
| キャプションが null | 0 行 |

`media_product_type` は `not null`（R1）なので、null のテストは要らない。

### 7.3 Server Action（単体。`checkAccess` と `headers()` を `vi.mock`）

- `checkAccess` が**固定の値 `"/tags/edit"`** で呼ばれる（要求の見出しの経路を使わない。S1）。`pass` でなければ書かない
- `isSameOriginPost` が偽（別のオリジンの POST）なら書かない（S2）
- `actions.ts` の export が Action の関数だけ（一覧を固定。S3）
- 名前の検査（S8）: 空白だけ、30 と 31 コードポイント（絵文字を含む）、NFC で長さが変わるもの、制御文字、ゼロ幅文字（`\p{Cf}`）、`File` の値
- `setMediaTags` のキー（`axis_x`、11 個、値の形）
- 数の上限（軸 11 個目、値 51 個目）
- エラーの文言（T6）: 23505 は「同じ名前があります」、値の削除の 23503 は「使っている投稿があります」、insert／update の 23503 とほかの SQLSTATE は汎用の固定の文言。DB のエラー文を返さない。ログは SQLSTATE だけ
- 並び順（T11）: 足したときの最大値 + 1、空のときの 0、先頭の「上へ」と末尾の「下へ」で何も変わらない、同順位は id
- 軸の削除は確認の表示を経ないと消えない（S10）

### 7.4 受け入れ（要件 10 章の R5 の完了条件）

- **タグ**: 本番で数件の投稿にタグを付け、タグ分析の比較が表示される。Instagram の担当者もタグを付けられる
- **離脱ファネル（T1）**: (1) 手元の DB に、続けて出したストーリーズの組（3 件、5 時間間隔）を入れ、ファネルが 1 件目の 100% から描かれることを確かめる。(2) 本番では、まとまりの有無に応じた表示（ファネルか見本の文言）を確かめる。段階 0 で本番のまとまりの数を数え、0 件なら (1) をもって完了とする
- **属性の内訳（T2。2026-10-09 に改めた）**: 本番の `/audience` に、最新の週の性別と年齢の円グラフ、国と都市の横棒が出ることを確かめる。推移は画面から外したので確かめない。週次の収集が続くことは `/jobs` の `audience_demographics` で見る
- PC 幅とスマートフォン幅の見た目はユーザーが確かめる

### 7.5 テストファイルの担当（T13）

| 担当（8 章） | ファイル |
|---|---|
| 1（DB） | `apps/web/test/db/r5-views.test.ts`（新規）、`apps/web/test/db/web-role.test.ts`（追記）、`apps/web/test/db/fixtures.ts`（R5 の表の作り方を**最初に**まとめて足す） |
| 2a（ワーカー） | `apps/worker/test/audience-demographics.test.ts`、`apps/worker/test/db/audience.test.ts`（新規）、既存の `groups.test.ts`、`daily-due.test.ts`（追記） |
| 2b（画面の共通） | `apps/web/test/params.test.ts`、`test/charts.test.ts`（追記）、既存の `test/routes.test.ts`（新しい URL と `no-store`） |
| 3A（タグ分析） | `test/tags.test.ts`、`test/db/tags.test.ts` |
| 3B（タグの編集） | `test/tag-edit-actions.test.ts`、`test/db/tag-edit.test.ts`、既存の `test/db/media-detail.test.ts`（タグの表示） |
| 3C（ストーリーズ） | `test/stories.test.ts`、`test/db/stories.test.ts` |
| 3D（オーディエンス） | `test/audience.test.ts`、`test/db/audience.test.ts` |
| 3E（投稿時刻） | `test/timing.test.ts`、`test/db/timing.test.ts` |

- 段階 3 の各担当は `fixtures.ts` を読むだけにし、足りなければ親に戻して段階 1 の担当がまとめて足す
- 既存のテストファイルの名前と場所（`groups.test.ts`、`daily-due.test.ts`、`fixtures.ts`）は親のまとめによる（今回は読んでいない）

---

## 8. 段階

同じ作業ツリーで、段階ごとにファイルを分担する（git worktree は使わない）。各担当は 7.5 の表の自分のテストも書く。

| 段階 | 内容 | 担当の案 | ファイル |
|---|---|---|---|
| 0 | 本番の数を数える: ストーリーズの件数と続けて出したまとまりの数（T1）、24 時間時点の値がある投稿の数、ハッシュタグを含む投稿の数。R0／R1 の属性の生の応答の形（3.1）と、100 未満のときの応答。応答を写すときは 3.1 の決まり（S6）。確認事項の回答 | 親とユーザー | — |
| 1 | マイグレーション、`fixtures.ts`、DB のテスト | `postgres-sql-reviewer` が設計とレビュー | `supabase/migrations/…_r5_analysis.sql` と 7.5 の 1 |
| 2a | `audience_demographics` ジョブ、グループへの組み込み、テスト | `node-worker-developer` | `apps/worker/src/jobs/audience-demographics.ts`、`apps/worker/src/db/audience.ts`、`jobs/groups.ts`、`index.ts` の登録、7.5 の 2a |
| 2b | 画面の共通: ナビ、チップの部品、`Strip`、`Heatmap`、横棒の部品、`lib/params.ts` への検査の追加、`no-store` の対象の追加 | `nextjs-developer` | `app/layout.tsx`（ナビ）、`components/`、`components/charts/`、`lib/params.ts`、7.5 の 2b |
| 3 | 画面（5 人で並列。2b の後） | `nextjs-developer` × 5 | A（タグ分析）: `app/tags/page.tsx`、`app/tags/_tags/*`、`lib/tags.ts`、`lib/queries/tags.ts`。B（タグの編集）: `app/tags/edit/*`（`actions.ts` を含む）、`lib/queries/tag-edit.ts`、`app/media/[id]/_detail/` のタグの表示。C（ストーリーズ）: `app/stories/*`、`lib/stories.ts`、`lib/queries/stories.ts`。D（オーディエンス）: `app/audience/*`、`lib/audience.ts`、`lib/queries/audience.ts`。E（投稿時刻）: `app/timing/*`、`lib/timing.ts`、`lib/queries/timing.ts` |
| 4 | 本番に反映（`db push` → main へのマージ。R4 の順）。`db push` は毎時 17 分ごろに動く収集を避けて行う（D3）。属性が週 1 回入ることと、内訳が表示されることを確かめる（T2） | 親とユーザー | — |
| 5 | テストの不足、セキュリティレビュー（Server Action、権限と RLS）、ユーザーの画面の確認 | `quality-engineer`、`security-engineer`、ユーザー | — |

- 段階 1 と 2a と 2b は並べて進められる（表の形は 5.1 で決まっているので、ワーカーは先に書き始め、結合テストはマイグレーションの後に通す）
- 段階 3 の 5 つは触るファイルが重ならない。共通の部品の変更が要るときは段階 3 の中では直さず、親に戻して 2b の担当がまとめて直す（R3 10 章と同じ）。編集画面の読み書きの SQL は B の `lib/queries/tag-edit.ts` に置き、A の `lib/queries/tags.ts` とは分ける
- 担当 B の Server Action はセキュリティレビューを必ず通す（R5 で初めて Web から利用者のデータを書くため）

---

## 9. 確認事項

| # | 問い | 推奨 |
|---|---|---|
| Q1 | タグを付ける場所（投稿詳細、投稿一覧、専用画面） | 専用画面 `/tags/edit`（軸と値の管理と、投稿の表で軸ごとの選択を行ごとに保存）。既存の 24 件以上に付けるには表が速い。投稿詳細は表示と、編集画面のその行へのリンクだけ |
| Q2 | 1 つの軸に値をいくつ付けられるか | 軸ごとに 1 つ。値ごとの比較で投稿が重ならず、選択（`<select>`）で付けられる。複数にしたい軸が出たら、その軸を分けて作る |
| Q3 | ストーリーズにもタグを付けられるようにするか。Server Action にストーリーズの id が来たら書くか（T17） | 付けない。DB は種類を問わないが、編集画面に出さず、Server Action もストーリーズの id は拒む（汎用の固定の文言）。ストーリーズは指標が別で、比べる相手が違う |
| Q4 | タグ分析で、その軸の値がない投稿を「タグなし」の行として出すか | 出す（比べる基準になる）。行の名前は「タグなし」 |
| Q5 | ハッシュタグの抽出をビューでやるか保存するか | ビュー（関数 `caption_hashtags` とビュー `media_hashtags`）。キャプションの変更と規則の変更にそのまま追いつく。件数が少なく性能の心配がない |
| Q6 | ハッシュタグの区切り、許す文字、大文字小文字と全角半角をそろえるか（T4） | 先にキャプションを NFKC にし、英数字、`_`、ひらがな、カタカナ（長音を含む）、漢字、`々` だけをタグの文字とする（ほかの文字、絵文字、句読点で終わる）。英字は小文字にそろえる。数字だけのタグと、英数字や `/`、`&` の直後の `#`（URL の中など）は数えない。期待値は 7.2 の表。本番のキャプションで抜き出した結果をユーザーが見て直す |
| Q7 | 属性の `timeframe` | `this_month` だけを取る（R0 で 4 内訳とも取れた）。`this_week` も取るかは、`this_month` の値の変わり方を数週見てから決める。`this_month` が暦の月なのか直近 30 日なのかは未確認（月初めに値が小さくなるなら暦の月） |
| Q8 | ストーリーズの閲覧率の分母（投稿時のフォロワー数の取り方） | リーチ率と同じ「投稿より前で 3 日以内の最も近い `profile_daily`」。前後の記録の補間や投稿の後の記録は使わない |
| Q9 | ストーリーズの期間 | 選択（30、90、365 日。既定 30 日）。見本は「過去 30 日」の固定の表示 |
| Q10 | 離脱ファネルに出すまとまりと、期間の境目にかかるまとまりの扱い（T7） | 期間内に 1 件でもあるまとまりのうち最も新しいもの 1 つ（見本どおり）。まとまりの判定は期間で絞る前の全件で行い、1 件目が期間の外でも、そのまとまりは 1 件目から描く（境目でまとまりを切らない）。ほかのまとまりは一覧で見る |
| Q11 | ナビの並び（9 項目） | 概要、投稿一覧、リール分析、タグ分析、ストーリーズ、投稿時刻、オーディエンス、期間比較、接続と収集ログ（投稿の分析をまとめ、アカウントの分析を後ろに。ストーリーズと投稿時刻の順は design-lab v3 に合わせた） |
| Q12 | `online_followers`（時間帯別のオンラインフォロワー数）を収集に入れるか | R5 では入れない（F-COL-31 は削除済み）。返った回があるので、入れるなら R6 以降に確かめてから |
| Q13 | 属性の割合の分母と国の名前 | 分母は「その週に返った区分の合計」と明示する。国はコードのまま（対応表を作らない）。人数も並べる |
| Q14 | 投稿時刻の指標の選択肢 | 24 時間リーチ（既定）、24 時間の閲覧数、最新のリーチ、最新の閲覧数。文言に件数。24 時間の値のある投稿が少ないうちも、既定は変えない（R4 の Q1 と同じ形） |
| Q15 | タグの軸と値の初期値 | 入れない（マイグレーションで利用者のデータを作らない）。要件の例（テーマ、目的、CTA、キャンペーン）を編集画面の空の状態に例として書くだけにし、軸と値は本人と担当者が決めて登録する |
| Q16 | タグの編集をもう 1 人（Instagram の担当者）にも許すか | 許す（`checkAccess` が `pass` の利用者は誰でも書ける）。変更者は記録しない（最後に変えた時刻だけ）。その結果、誰が軸や値を消したかは後から分からない（S10）。消す前の確認（6.2 の 2 段階）で誤操作を減らす |
| Q17 | オーディエンスの画面に、Meta の属性の計算が最大 48 時間遅れることを書くか（T18） | 書かない（端の場合の説明文を足さない方針）。カードの下の記録日と取得時刻だけを出す |

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
| `apps/web/src/lib/auth.ts`、`apps/web/src/lib/request-guard.ts` | export された関数の行だけ（grep。版 0.2） |
| 3 本のレビューのまとめ（親が整理。S1〜S13、D1〜D15、T1〜T18） | 全体（版 0.2） |

**事実票**（親が 2026-10-08 に確認）:

- Meta 公式「Instagram User Insights」API リファレンス（表示は v25.0）: `follower_demographics` と `engaged_audience_demographics` は `period=lifetime`、`metric_type=total_value`、`breakdown` は `age`／`city`／`country`／`gender` のいずれか、`timeframe` は `this_week`／`this_month`（ほかは v20.0 以降使えない）。フォロワー 100 未満、反応 100 未満で返らない。上位 45 件だけ。最大 48 時間遅れる
- `doc/verification/r0-meta-api-verification.md`: follower_demographics（`this_month`）は 4 内訳とも取れた。engaged は 4 つとも空（V10）。`online_followers` は R1 の再確認で返った回があった（V6）。内訳つきの指標は内訳なしと同じリクエストに入れられない（P5）。ストーリーズの `navigation`、`link_clicks`、`replies` は R1 から収集済み

**読んでいないもの（未確認として扱ったもの）**: `node_modules/next/dist/docs/`（Server Functions、Forms。実装時に読む）、`doc/design-system.md`、design-lab v3 のナビの定義、R3 と R4 のグラフの部品の実装、`lib/reels.ts`（分位の関数の場所）、`checkAccess` と `isSameOriginPost` の本体、属性の生の応答の形。`public.set_updated_at()` の定義と既存のテストファイル（`apps/web/test/db/fixtures.ts`、`apps/web/test/routes.test.ts`、`apps/web/test/db/media-detail.test.ts`、`apps/worker/test/groups.test.ts`、`apps/worker/test/daily-due.test.ts`）があることは、親が 2026-10-08 に確かめた

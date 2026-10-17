# R7 複数アカウントの設計

- 版: 0.2（2026-10-17）。レビュー 4 本（画面、ワーカー、セキュリティ、SQL）と親の判断を反映した。確認事項 Q1〜Q12 はユーザーの決定待ち

## 版と変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-17 | 起草（親）。2026-10-16〜17 の検討（複数アカウント化は別リポジトリにせず今のソースを改造する、専用の BI は作らず警告は後回し、今のアカウントは変えない）と、親が 2026-10-17 に確かめた事実票（付録 A）をもとにする |
| 0.2 | 2026-10-17 | レビュー 4 本（`nextjs-developer`、`node-worker-developer`、`security-engineer`、`postgres-sql-reviewer`。各 10 分以内、設計書と関係ファイルだけ、Web なし）と親の判断を反映。**高 2**: 切り替えは本人（`checkAccess` が `pass`）にだけ描く（N1／S1）、`timeout-minutes` の見積もりを daily の回と準備を含めて書き直し、この設計が支えるアカウント数を明記（W1）。**中**: 書き込みのフォームに表示時のアカウント ID を持たせて照合する（S2）、接続はトークンの確認を全候補で先に済ませてから登録する（S3／N2）、`runJob` の `batchStartedAt` は省略可で既定は `startedAt`（W2）、月の本数の上限の Variable を `collect.yml` に通す（W3）、`stories` の動画解析は予算外と明記（W4）、予算の上限は「8 分＋最後の 1 本」（W5）、配列は `::text[]` と `unnest with ordinality`（D1／N9）、環境変数から外したアカウントを止める手順と合計のアカウント数（D2）、既存テストの修正を明記（N3）、空の項目は捨てる（N4）、`/connect` にも戻れる（N5）、Action の検査の順を A6 にそろえ `getTargetAccount()` を呼ばない（N6）、テストの漏れ 5 点（N7）。**低**: Cookie は小文字の uuid の厳密な検査で SQL に渡さない（S4）、一覧は 10 件まで（S5）、`redirect` は try の外（S6）、認可画面で既存のページも選ぶ（S7）、`revalidatePath` の根拠（N8）、`NavLinks` から再 export しない（N10）、`defaultValue`（N11）、候補の重複除去（N12）、「うち、このアカウント」は常に出す（D5／N13）、`summarize` の項目（W6）、`scope` の判定を純粋関数に残す（W7）、`loadAlertAccounts` の `now` を外す（W8）、テストの数値と進む時計（W9／W10）、`order=` は手元の確認用（W11）、`JobContext` の規則（W12）、`.env.example` は段階 1 だけが触る（W13）、`media_id` と `account_id` の前提（D3）、索引の説明（D4）、文書更新の漏れ（D6）、`monthlyOcrUsage` を 1 つの実装に（D7）、先頭が `disconnected` でも既定（D10）。確認のみ: `daily-due` は全アカウントの最新を見る（W15。親が確認）、`React.cache` の中の `cookies()` は成り立つ（N14）、`__Host-` で別ホストから値を置けない（S8）、F-SYS-16 の守りは保たれる（S10）、Q11 は妥当（D8）、マイグレーションなしは成り立つ（D9） |

- 要件: `doc/requirements/requirements-definition.md` 2.1 章（対象アカウント）、3 章（R7）、4.3 章 F-SYS-16、4.8 章（F-ACC-01〜05。0.6 版で追加）、9 章（画面一覧）、10 章（R7 の完了条件）
- 既存: R1 の表（`accounts`、全表の `account_id`）、ワーカーの枠組み（`apps/worker/src/jobs/framework.ts` の `runJobsForActiveAccounts`、`runJob`、`JobContext.startedAt`）、`jobs/groups.ts`、`jobs/video-analysis.ts`、`jobs/video-text.ts`、`db/video-text.ts`（`monthlyOcrUsage`）、`jobs/alerts.ts`、`commands/check-alerts.ts`、`commands/daily-due.ts`、Web の `lib/queries/account.ts`（`getTargetAccount`）、`lib/env.ts`（`readEnv`）、`lib/meta-connect.ts`（`handleCallback`、`selectCandidates`）、`lib/queries/register-credential.ts`、`app/layout.tsx`、`components/AppShell.tsx`、`components/NavLinks.tsx`、`app/report/actions.ts`、`app/tags/edit/actions.ts`（Server Action の形）、`lib/request-guard.ts`、`lib/supabase/cookie-options.ts`、`app/jobs/_components/ocr-usage-card.tsx`、`lib/queries/ocr-usage.ts`、`.github/workflows/collect.yml`
- デザイン: `doc/design-system.md`。切り替えの部品は既存の `topbar__actions` の中に置く（見た目は実装後にユーザーが PC 幅とスマートフォン幅で確かめる）

この文書で「未確認」と書いたものは、起草時に確かめられなかった事実。実装の前（または段階 6 の実測）で確かめる。外部の事実（Next.js 16 の挙動、既存のコードの挙動、GitHub Actions の実測）は、親が 2026-10-17 に確かめた事実票（付録 A）だけを根拠にした。Web ページは取っていない。版 0.2 で残る未確認は 3 つ: **`account_backfill` と daily の 1 アカウントあたりの所要**（5.3 節。段階 6 で実測）、**`stories` の動画解析の 1 本あたりの所要**（5.3 節。同）、**応答が CDN に共有キャッシュされないこと**（3.3 節。実装時に `Cache-Control` を見る）。

---

## 1. 目的と範囲

### 1.1 前提

- 追加するアカウントは、**本人が管理者である Facebook ページに付いた Instagram プロアカウント**とする（要件 2.1 章「他人のアカウントは扱わない」のまま。Q1）。
- 画面のログインは 1 つのまま（本人ともう 1 人で共有。F-SYS-13、F-SYS-16）。利用者の種類や、アカウントごとの閲覧権限は設けない（要件 1.4 章の対象外のまま）。
- **今のアカウントは何も変えない。** 行も認証情報もそのまま。環境変数の値も、2 つ目を足すまで変えない。1 アカウントのときの見え方は今日と同じ。
- この設計が支えるアカウント数は **6 件程度まで**（5.3 節の見積もり。要件 2.1 章の「数個」）。それを超えるときは 5.3 節の手段（予算を下げる、`timeout-minutes` を上げる）を先に当てる。

### 1.2 R7 でやること

| 区分 | 内容 | 要件 |
|---|---|---|
| 画面 | 対象のアカウントを複数から選べるようにする。`META_TARGET_IG_USER_ID` を ID の一覧（カンマ区切り）にし、先頭を既定にする。選択は Cookie に持ち、ヘッダーの切り替えで変える。読み出し関数 20 ファイルは `getTargetAccount()` を経由しているので変えない | F-ACC-01、F-ACC-02 |
| 画面 | 書き込みの Server Action（`/report` の記入欄、`/tags/edit`）のフォームに表示時のアカウント ID を持たせ、送信時に選択と一致することを照合する（別のタブで切り替えた後の古いフォームを拒む） | F-ACC-02 |
| 画面 | `/connect` の Meta との接続で、一覧にあるアカウントのページをすべて登録する（一覧にないものは今までどおり登録しない） | F-ACC-03（F-SYS-16 の改め） |
| ワーカー | 動画解析と文字読み取りの時間の予算を、アカウントごとではなく**ジョブの実行 1 回（全アカウント分）で共有**する。アカウントの順番は実行ごとに回す | F-ACC-04 |
| ワーカー | 文字読み取り（Vision）の月の上限を、アカウントごとではなく**全アカウントの合計**で判定する（`video_text` と `check-alerts`） | F-ACC-05 |
| 画面 | `/jobs` の「AI・OCR の利用状況」を全アカウントの合計にし、選んでいるアカウントの分を 1 行添える | F-ACC-05 |
| 運用 | GitHub Actions の `timeout-minutes` を 30 → 45 にし、`WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS` の Variable を `collect.yml` に通す。README と `.env.example` を更新する | — |

### 1.3 R7 でやらないこと

- **アカウントをまたいだ比較や横断の一覧**（要件 4.9 章の候補にも入れない。必要になったときに別のリリースで）
- **利用者ごとの閲覧権限**（要件 1.4 章の対象外）。将来足すときは、ログアウトで選択の Cookie を消す（3.3 節）
- **環境変数の改名**（`META_TARGET_IG_USER_ID` の名前のまま一覧を受ける。Vercel の設定を触らずに済ませる）
- **DB のマイグレーション**（7 章。表はすべて `account_id` を持っていて、足す列も表もない）
- **手元の `register-token` を本番の DB に向けて実行する運用**（README 9 章「本番の接続文字列をローカルの `.env` に書かない」に反する。追加のアカウントも `/connect` で登録する）
- **上限の警告の追加**（毎時の所要、DB と Storage の容量。2026-10-16 に「後でやる」と決めた別タスク。進捗記録 13 章）

---

## 2. 既に済んでいるもの（変えない）

| 層 | 状態 | 根拠（付録 A） |
|---|---|---|
| DB | `accounts.ig_user_id` は `text not null unique`。収集、解析、タグ、レポートの表はすべて `account_id` を持ち、ビューとポリシーは「対象のアカウントは SQL の `account_id` で絞る」前提で書かれている | A1 |
| ワーカー | `runJobsForActiveAccounts` が `status = 'active'` の全アカウントを登録順に回す。`check-alerts` も全アカウントを読み、ログの `account=` は連番。`daily-due` は `account_daily` の最新の成功を全アカウントで見る（どれか 1 件でも 24 時間以内に成功していれば due にしない。複数でも変えない） | A2、A3、A19 |
| ワーカー | レート制限の使用率は `X-Business-Use-Case-Usage`（アカウント別）を見る。アカウントが増えても互いの枠には影響しない | A4 |
| 画面 | `getTargetAccount()` が対象を 1 か所で決め、読み出し関数はすべて `accountId` を第 1 引数に取る（R3 設計 4.1 節）。呼び出しは 20 ファイル | A5 |
| 画面 | Server Action の検査の順（環境 → 同一オリジン → 認可 → 対象のアカウント → 入力）は R5・R6 で確定 | A6 |
| 実測 | `collect` 1 回（準備、hourly、`check-alerts`、ping を含む）は 1 アカウントで中央値 40 秒（2026-10-12〜16 の 100 回、すべて success、最大 86 秒）。8 分の予算が効くのは、登録直後の積み残しの期間だけ | A7 |

---

## 3. 画面: 対象のアカウントの選択（F-ACC-01、F-ACC-02）

### 3.1 環境変数

`META_TARGET_IG_USER_ID` に Instagram アカウントの数値 ID を **カンマ区切りで複数** 書けるようにする（例: `17841…,17842…`）。

- `readEnv()`（`lib/env.ts`）の `targetIgUserId: string | undefined` を `targetIgUserIds: readonly string[]` に変える。未設定なら `[]`。
- 読み方: カンマで区切り、各項目を trim し、**空の項目は捨てる**（末尾のカンマや改行で全ページが「設定が足りません」にならないように。N4）。残った項目が `NUMERIC_ID_PATTERN` に合わなければ、今までどおり `missing` に `META_TARGET_IG_USER_ID` を入れる（部分的に受け付けない）。重複は先に出た方を残す。**11 件以上なら `missing`**（要件 2.1 章の「数個」。候補のループ、`select` の長さ、配列の大きさに上限が付く。S5）。
- **先頭が既定のアカウント**（Q4）。今の本番の値は 1 件なので、2 つ目を末尾に足すだけで今のアカウントが既定のまま。
- `ConnectEnv.targetIgUserId` も `targetIgUserIds` にする（4 章）。`env.test.ts` と `meta-connect.test.ts` の既存の fixture と期待値を直す（N3）。

### 3.2 選び方（`lib/queries/account.ts`）

```
listTargetAccounts(): QueryResult<TargetAccount[]>
  1. readEnv()。ok でなければ config_missing
  2. ids が空なら TARGET_ACCOUNT_NOT_SET（今と同じ文言）
  3. select a.id, a.ig_user_id, a.username, a.name, a.status
       from unnest(${ids}::text[]) with ordinality as t(ig_user_id, ord)
       join public.accounts a on a.ig_user_id = t.ig_user_id
      order by t.ord
  4. 0 行なら TARGET_ACCOUNT_NOT_SET。環境変数の順に並んだ配列を返す

getTargetAccount(): QueryResult<TargetAccount>
  1. listTargetAccounts()
  2. Cookie の値（3.3 節）を読む。小文字の uuid の厳密な形（正規表現）でなければ無視
  3. pickTargetAccount(rows, cookieValue): rows の中に id が文字列として完全に一致する行があればそれ、なければ rows[0]
```

- 配列は `::text[]` で型を明示し（postgres.js は素の配列を `unknown` で送るので推論に頼らない。D1／N9）、`unnest … with ordinality` で 1 回だけ渡す（`ig_user_id` の一意索引を nested loop で使い、順も保つ）。
- **Cookie の値は SQL に渡さない。** `listTargetAccounts()` の結果（環境変数で絞った行）との文字列の一致だけで照合する。DB にあって環境変数にない行の uuid を Cookie に入れても既定に戻る（S4）。
- どちらも `React.cache`。同じ要求の RSC の描画の中ではレイアウトの切り替え（3.4 節）と各ページが同じ 1 回の読み出しを共有する（Server Action と Route Handler では毎回評価される。読み出しは 1 回なので害はない。N14）。
- 環境変数にあって DB にない ID（まだ接続していない）は配列に出ない。DB にあって環境変数にない行（`register-token` で入れたもの、環境変数から外したもの）は画面に出ない。**収集は環境変数と無関係に `accounts.status = 'active'` の全行で動く**（2 章）。画面から外すだけでは収集も Vision の消費も止まらないので、止める手順を 8.1 節に書く（D2）。
- `status` が `paused`／`disconnected` の行も配列に入れる（蓄積したデータは見られる。状態は `/connect` に出る）。先頭のアカウントが `disconnected` でも既定になる（環境変数の順はユーザーが決める。D10）。
- `pickTargetAccount` は純粋関数（テスト 9 章）。
- 今までの「一致する行がなければ、ほかのアカウントを代わりに選ばず失敗」は、「一覧にあるアカウントの中で環境変数の順に最初に DB にある行」に改める。一覧の外の行を代わりに選ぶことはない。

### 3.3 Cookie

| 項目 | 値 |
|---|---|
| 名前 | https なら `__Host-ig-account`、http（ローカル）なら `ig-account`（`authCookieName` と同じ規則。`lib/account-cookie.ts` の `accountCookieName(appUrl)`） |
| 値 | `accounts.id`（内部の uuid）。Instagram の ID は入れない |
| 属性 | `httpOnly`、`secure`（https のとき）、`sameSite: 'lax'`、`path: '/'`、`maxAge` 365 日（Q9） |
| 読む場所 | `getTargetAccount()` の中で `(await cookies()).get(name)`。Server Component、Server Action、Route Handler（`/export/*`）のすべてで同じ関数が動く（A8） |
| 書く場所 | 切り替えの Server Action（3.5 節）だけ。Server Component では書けない（A8） |
| 消す | 消さない。値が一覧にない（アカウントを外した、別の環境の値）ときは無視して既定に戻る。ログアウトでも消さない（利用者ごとの権限がない前提。1.3 節） |

- `__Host-` はホスト単位で `secure` と `path=/` が必須、`domain` を持てないので、ローカルや Vercel のプレビュー（別ホスト）から本番の値は置けない（S8）。値を改ざんしても一覧の中でしか一致しない（3.2 節）。
- `cookies()` は Request-time API なので、呼んだルートは動的描画になる。`getTargetAccount()` はすでに `markDynamic()` を呼んでいるので変わらない。Cookie で内容が変わるので、応答が CDN に共有キャッシュされないこと（`Cache-Control` が `private` か `no-store`）を実装時に確かめる（未確認。S14）。

### 3.4 切り替えの UI

- 置き場: `AppShell` の `actions`（ログアウトのフォームの左）。`app/layout.tsx` は **`allowed`（`checkAccess("/") === "pass"`）のときだけ** `<Suspense fallback={null}><AccountSwitcher /></Suspense>` を渡す。ログイン済みだが許可外の利用者（`/login` を開くとレイアウトが描かれる）にアカウントの一覧を見せない（N1／S1。R2 設計 4.6 節「ナビゲーションは本人にだけ」と同じ）。多層防御として `AccountSwitcher` 自身も `checkAccess("/") !== "pass"` なら DB を読まずに `null` を返す。`layout.tsx` 25 行の「レイアウトは DB を読まない」と `AppShell.tsx` の `actions` の説明は書き換える。
- `AccountSwitcher`（Server Component、`app/_account/AccountSwitcher.tsx`）: `listTargetAccounts()` と `getTargetAccount()` を読む。**2 件以上のときだけ**描く（Q5）。1 件、0 件、読み出しの失敗は何も描かない（レイアウトを壊さない。失敗はページ側が固定文言を出す）。
- 形: `<form action={switchAccountAction}>` ＋ `<select name="account" defaultValue={current.id}>`（`option` の値は `accounts.id`、文言は `@username`、なければ `name`、なければ「アカウント n」。`selected` 属性は使わない。N11）＋ 隠し項目 `next` ＋ `<button type="submit">切り替え</button>`。JS なしで動く（Q3）。`select` の見た目は `globals.css` の `.select` を当てる。
- `next`: 切り替え後に戻る画面（Q2 の (b)）。`usePathname()` が要るので、隠し項目だけを Client Component `NextPathField` にし、`switchReturnPath(pathname)` の値を入れる。`switchReturnPath` は `activeNavHref(pathname)` に `/connect` を足したもの（`/connect` はナビにないが、8.1 節の手順で切り替えた直後に見る画面。N5）。サーバー側で許可リスト `SWITCH_RETURN_PATHS`（`NAV_ITEMS` の `href` ＋ `/connect`）のどれかと **完全一致**（`===`。前方一致にしない）することを検査し、合わなければ `/`（S9）。
- `NAV_ITEMS`、`activeNavHref`、`SWITCH_RETURN_PATHS`、`switchReturnPath` は **`lib/nav.ts`**（サーバーでも読める純粋なモジュール）に置き、`NavLinks.tsx` と `routes.test.ts` の import 先を変える。`NavLinks.tsx` からの再 export はしない（`"use client"` のモジュールの定数は Server Action から読めない。再 export すると同じ落とし穴が残る。N10）。
- スマートフォン幅（700px 以下）では `topbar__actions` が詰まる。`select` の幅は文言に合わせて `max-width: 10em` 程度で切り（`text-overflow: ellipsis`）、ボタンの文言は「切り替え」で固定。見た目は段階 5 で確かめる。
- ブランド（`Instagram 分析`）は変えない。選んでいるアカウントは `select` の選択状態で分かる。

### 3.5 Server Action `switchAccountAction`（`app/_account/actions.ts`）

検査の順は A6（`saveReportNotes`）にそろえる。どれかで落ちたら Cookie を書かずに `redirect("/")`（失敗の文言は出さない。切り替えは失敗しても害がなく、Cookie が変わらなければ画面も変わらない。S9）。**この Action では `getTargetAccount()` を呼ばない**（`set` の前に `React.cache` に古い選択が載らないように。N6）。

0. 環境（`readEnv()`）→ `reason=config`
1. 同一オリジンの POST（`isSameOriginPost`）→ `origin`
2. 認可（`checkAccess("/")`。固定の経路）→ `access`
3. 一覧（`listTargetAccounts()`。失敗か 0 件）→ `account`
4. 入力の形（`allValuesAreStrings`、`account` と `next` が 1 つずつ、`account` は小文字の uuid の厳密な形）→ `input`
5. `account` が 3 の一覧の `id` のどれかと完全に一致すること（**一覧にない id は Cookie に書かない**）→ `unknown_account`
6. `next` が `SWITCH_RETURN_PATHS` のどれかと完全に一致すること。合わなければ `/`（拒まない）
7. `(await cookies()).set(name, id, options)` → `redirect(next)`

- `redirect` は try の外で呼ぶ（`login/actions.ts` の形。try/catch で包むと `redirect` の例外を飲む。S6）。
- ログは `[account] action=switchAccount result=rejected reason=<config|origin|access|account|input|unknown_account>` だけ。`account` と `next` の値、件数は出さない（R2 設計 4.5 節）。
- `revalidatePath` は呼ばない。Server Action の中で `cookies().set` をすると Router Cache が無効になり、Action の応答で木全体が描き直される（A8 の資料「After you set or delete a cookie in a Server Function, Next.js can return both the updated UI and new data in a single server roundtrip」。N8）。`redirect(next)` 先の描画は新しい Cookie で `getTargetAccount()` が評価される。
- `"use server"` ファイルの export の一覧を固定するテスト（`report/actions.ts` 冒頭の言及）の対象に `_account/actions.ts` を足す（N7e）。

### 3.6 書き込みのフォームとアカウントの照合（S2）

`/report` の記入欄と `/tags/edit` の Server Action は、書き先を `getTargetAccount()` の `id` で決める（フォームから `account_id` を受け取らない。R6 設計 6.2 節）。Cookie で切り替えられるようになると、別のタブで B に切り替えた後に A の画面に残っていたフォームを送ると **A の内容が B に書かれる**。

- フォームに隠し項目 `account`（表示時の `accounts.id`）を足す。Action は入力の検査の後に **`getTargetAccount().id` と完全に一致することを照合だけ**する（選択には使わない。選択は Cookie）。不一致なら `reason=account_changed` でログし、固定文言「アカウントが切り替わりました。画面を読み直してください」を返す（本文は `values` に戻す。R6 の U3 と同じ）。
- `/tags/edit` の Action は、対象の投稿（`media_id`）を `account_id = ${accountId}` で絞っていることも実装時に確かめる（絞っていなければ足す）。
- 隠し項目は秘密ではない（内部の uuid。ログには出さない）。

### 3.7 各画面への影響

| 画面・経路 | 影響 |
|---|---|
| 概要、投稿一覧、投稿詳細、リール分析、タグ分析、ストーリーズ、投稿時刻、オーディエンス、期間比較、レポート | 読み出しは変更なし。`getTargetAccount()` の結果が変わるだけ。`/media/[id]` で別のアカウントの投稿 id を開くと、読み出しが `account_id` で絞るので「見つからない」になる（今と同じ扱い） |
| `/report` の記入欄、`/tags/edit` の Server Action | 3.6 節の照合を足す |
| `/export/daily`、`/export/media` | 変更なし。Route Handler の中でも `cookies()` が読める（A8） |
| `/jobs` | 接続状態、予定、実行の一覧は選んでいるアカウント。「AI・OCR の利用状況」は 6.3 節 |
| `/connect` | 「現在の状態」は選んでいるアカウント。「Meta と接続する」は 4 章 |
| `/login`、ログアウト | 変更なし。ログアウトで `ig-account` は消さない（3.3 節） |

### 3.8 1 アカウントのときの見え方

一覧が 1 件なら切り替えは描かれず、既定 = その 1 件。Cookie はどこにも書かれない。書き込みのフォームの隠し項目は常に一致する。今日と同じ。

---

## 4. 画面: Meta との接続で複数を登録する（F-ACC-03）

`handleCallback`（`lib/meta-connect.ts`）の 6〜9 番を変える。1〜5 番（state、denied、code、トークンの交換）は変えない。

| 場合 | 今 | R7 |
|---|---|---|
| 一覧が空（未設定）で候補 1 件 | 登録 | 変更なし |
| 一覧が空で候補 2 件以上 | `multiple_accounts` | 変更なし |
| 一覧あり、Instagram 付きのページはあるが一致なし | `target_mismatch` | 変更なし |
| 一覧あり、一致 1 件 | 登録 | 変更なし |
| 一覧あり、**一致 2 件以上** | `multiple_accounts` | **一致したページをすべて登録**（下の 2 段階） |

- `selectCandidates(pages, ids)`: Instagram 付きのページのうち `ids` に含まれるもの（`ids` が空ならすべて）。順は `me/accounts` の返り順。同じ `igUserId` が 2 回出たら先勝ちで 1 つにする（N12）。
- **2 段階で行う（S3）。** 第 1 段階: 全候補について 7 番（ページトークン）と 8 番（`debug_token`。`app_id`、`profile_id` の一致）を先に済ませる。1 件でも失敗したら、その理由コードで戻り、**何も登録しない**（途中まで登録された状態を作らない。やり直しは同じ `ig_user_id` への upsert なので害がない）。第 2 段階: 全候補を順に `registerCredential`（候補ごとに 1 トランザクション）。DB で失敗したら `db_failed` で戻る（先に登録できた候補は登録されたまま。残りは接続をやり直せば登録される）。
- ログは `fail` の既存の形に `index=<n>/<total>` を足す（ID、ユーザー名は出さない。S11）。
- 戻り値 `registered` はすでに配列。`/connect?result=ok` へ戻るのは変わらない。`REASON_MESSAGES.ok` の文言は「接続しました。各アカウントの状態は、アカウントを切り替えて確かめてください。」に改める（Q8）。
- **ページの管理者でない人が接続しても、その人のページは一覧に一致しないので `target_mismatch` で何も登録されない。** F-SYS-16 の守りはそのまま（S10）。一覧のページに役割を持つ人が接続するとトークンがその人のものに上書きされるのは今と同じ。
- 一覧に 3 件あって管理者のページが 2 件なら 2 件を登録して `ok`。残り 1 件は未登録のまま（`listTargetAccounts()` に出ない）。
- `meta-connect.test.ts` の既存の期待「一覧あり・一致 2 件 → `multiple_accounts`」は反転する。fixture の `targetIgUserId` も配列に直す（N3）。

---

## 5. ワーカー: 時間の予算の共有とアカウントの順番（F-ACC-04）

### 5.1 今の形と問題

- `runJob` はアカウントごとに `startedAt = now()` を取り、`video_analysis` と `video_text` は `ctx.startedAt` からの経過で予算（既定 8 分ずつ）を見る（A9）。判定は「新しい 1 本を始める前」だけなので、実際の上限は 8 分＋最後の 1 本の所要（W5）。アカウントが N 件なら上限は（8 分＋1 本）× N × 2 ジョブ。
- 登録直後は既存のリールが解析待ちで積み残しがあるため、新しいアカウントを足した直後の数時間〜数日は予算いっぱいまで使う。N = 2 で最大 32 分を超え、`collect.yml` の `timeout-minutes: 30` に当たってジョブが打ち切られ、`check-alerts` と Healthchecks の ping が走らない（失敗メールが来る）。

### 5.2 変更

- `runJobsForActiveAccounts` が、ループの前に **`batchStartedAt = now()`** を 1 回取り、`runJob` に渡す。`runJob` の引数は `batchStartedAt?: Date` を末尾に足し、**省略時は `startedAt` と同じ値**にする（`runJob` を直接呼ぶ既存のテストとの互換。W2）。`JobContext.batchStartedAt` は必須にし、`JobContext` を組み立てる既存の単体テスト（`video_analysis`、`video_text`、`stories` など）を直す。`startedAt` は今までどおりアカウントごと（`job_runs` の記録、ログの `duration_ms`、「今日」の導出は変えない）。
- `JobContext` の doc コメントの規則に 1 行足す: 「時間の予算は `batchStartedAt`（全アカウント分の開始）、「今日」と `job_runs` は `startedAt`（このアカウントの開始）」（W12）。
- `video_analysis`（`video-analysis.ts` 130 行）と `video_text`（`video-text.ts` 633 行）の予算の判定を `ctx.startedAt` → **`ctx.batchStartedAt`** にする。予算の既定値（`WORKER_VIDEO_BUDGET_MS`、`WORKER_VIDEO_TEXT_BUDGET_MS`、各 8 分）は変えない。1 回の本数の上限（`videoMaxPerRun`、`videoTextMaxPerRun`）はアカウントごとのまま。
- 単独のコマンド（`worker video-analysis`）でも同じ（アカウントが 1 件なら `batchStartedAt ≒ startedAt`）。
- **順番を回す**: アカウントの一覧（登録順）を、`offset = floor(batchStartedAt / 1 時間) % N` だけ回した順で実行する（毎時の回ごとに先頭が 1 つずつずれ、N が 24 を超えても全員に回る）。ログの `account=` の連番は**登録順の番号のまま**（回しても同じアカウントは同じ番号。`check-alerts` の連番と一致する）。純粋関数 `rotateAccounts(accounts, batchStartedAt)` にしてテストする。
- 回す理由: 予算を共有すると先頭のアカウントが使い切り、後ろが毎回 `skippedByBudget` になる。回せば積み残しが全アカウントで均等に減る。定常（新しい動画が週に数本）では予算に届かないので順番は効かない。
- `stories` の中の動画解析（ストーリーズ）、`account_backfill`、ほかのジョブは変えない。**`stories` の動画解析は予算を持たず、本数で決まる**（登録直後のアカウントは生きているストーリーズの動画を解析するので、本数しだいで数分かかる。W4）。`account_backfill` はアカウント別のレート制限で進む。

### 5.3 GitHub Actions の `timeout-minutes` と、この設計が支えるアカウント数（W1）

`collect` の 1 回は、準備（checkout、`npm ci`、build、ffmpeg のキャッシュ）→ daily の回だけ `run-daily` → `run-hourly` → `check-alerts` → ping が同じジョブで直列に動く（A16）。`timeout-minutes` はその合計の上限なので、**最も長い回 = daily の回、全アカウントが登録直後（バックフィルと動画の積み残しがある）** で見積もる。

| 項目 | 所要 | 根拠 |
|---|---|---|
| 準備と `check-alerts`、ping | 約 1 分（固定。ffmpeg のキャッシュが外れた回だけ最大 5 分） | A7（1 アカウントの 1 回 40 秒にすべて含まれる）、A16 |
| daily の 5 ジョブ | 約 1 分 × N（未確認。R2 の実測は daily の回で最大 92 秒） | A7、`jobs/groups.ts` |
| hourly の短い 3 ジョブ（`stories`、`media_sync`、`media_snapshot`） | 約 0.5 分 × N。`stories` の動画解析は予算外で本数しだい（未確認） | A7、W4 |
| `video_analysis` | 8 分＋最後の 1 本（約 2 分）。積み残しがある間だけ。全アカウントで共有 | 5.2 節、W5 |
| `video_text` | 同上 | 同上 |
| `account_backfill` | 約 1 分 × N（未確認。バックフィル中だけ） | W14 |

合計 ≒ 21 分 ＋ 2.5 分 × N。N = 2 で 26 分、N = 4 で 31 分、**N = 6 で 36 分**、N = 8 で 41 分、N = 10 で 46 分。

- `timeout-minutes` を **45** にする（Q7）。これで **6 件程度まで** は最悪の回でも余裕がある（1.1 節）。定常は 40 秒なので、値を上げる害はない。次の毎時の起動は `concurrency` で待つので、45 分以内なら枠を失わない。
- 7 件以上にするときの手段（この設計の範囲外。必要になったときに決める）: daily の回だけ `WORKER_VIDEO_BUDGET_MS` と `WORKER_VIDEO_TEXT_BUDGET_MS` を `collect.yml` の `env` で半分にする、`timeout-minutes` を 60 まで上げる（60 を超えると次の毎時の枠と重なり、GitHub は待ちの実行を 1 つしか持たないので枠を失う）。
- 未確認の値（daily、`account_backfill`、`stories` の動画解析の 1 アカウントあたりの所要）は段階 6 で 2 つ目のアカウントの登録直後の実測で裏を取り、この表を直す。
- `WORKER_VIDEO_BUDGET_MS` と `WORKER_VIDEO_TEXT_BUDGET_MS` の説明（`.env.example`、`config.ts` のコメント）を「そのジョブの全アカウント分の開始からの経過」に直す。

### 5.4 ログ

- `runJobsForActiveAccounts` の `debug` に `first=<先頭の番号>` を 1 行足す（手元の確認用。本番は `info` なので出ない。回転の正しさはテストで固定する。W11）。
- 予算で見送った本数（`skippedByBudget`）の出し方は変えない。

---

## 6. 文字読み取り（Vision）の月の上限を全アカウントの合計にする（F-ACC-05）

Vision の無料枠（1,000 ユニット／月）は Google Cloud のプロジェクト単位で、アカウント単位ではない。今はアカウントごとに 1,000 まで使えるので、2 件で無料枠を超えうる。

### 6.1 `video_text` ジョブ

- `db/video-text.ts` の `monthlyOcrUsage(db, accountId, now)` を **`monthlyOcrUsage(db, now, accountId?)`** の 1 つの実装にし、`accountId` を省略したら `account_id` の条件を外す（postgres.js の fragment で条件だけを切り替える。月の範囲 `[start, end)`、`coalesce(sum(units), 0)`、`count(distinct media_id)` を 2 か所に持たない。D7）。
- `video-text.ts` 693 行の判定を合計（`accountId` 省略）にする。**ユニットの上限（`WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT`）と本数の上限（`WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS`）の両方を合計で判定**する（Q6）。本数の上限（既定 30 本）は 2 アカウントだと月の半ばで止まりうるので、**`collect.yml` の hourly と `check-alerts` の両ステップに `WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS: ${{ vars.WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS }}` を足し**、GitHub の Variable で変えられるようにする（未設定なら既定 30。W3）。ユニットの上限が無料枠の守りの本体で、本数の上限はその補助（30 本 × 約 33 ユニット ≒ 1,000）。
- 590 行の `summarize` の `month_units` を合計にし、`account_month_units`（そのアカウントの分）を添える。695 行の `warn` の `month_units`／`month_videos` も合計になる（どれも件数なので公開ログに出してよい。W6）。
- 前提: 1 つの `media_id` は 1 つの `account_id` にしか現れない（`ocr_usage.account_id` は `media` を経由せず独立に持つが、ワーカーは同じ `JobContext` から両方を書く。D3）。

### 6.2 `check-alerts`

- `AlertAccount.ocrMonthly`（アカウント別）をやめ、`AlertInput.ocrMonthly?: { units; videos }`（合計）にする。`loadAlertAccounts(db, accounts, scope)` から Vision の読み出しと `now` 引数を外し（W8）、`runCheckAlerts` が `scope === "daily"` のときに合計を 1 回読む（既存の `try` の中。DB の失敗は `error` ログ＋false にそろえる）。
- `Alert` の `ocr_monthly_cap` から `ordinal`／`total` を外す: `{ kind: "ocr_monthly_cap"; units; videos }`。`evaluateAlerts` はアカウントのループの外で 1 回だけ判定する。**純粋関数の契約として `scope === "daily" && input.ocrMonthly` の判定を関数の中に残す**（hourly で `ocrMonthly` を渡しても判定しない。W7）。`>=` の規則は変えない。`alertFields` は `account=` を出さない。
- `jobs/alerts.ts` の冒頭の表と、R4.1 設計 3.3 節の参照はコメントで直す。既存の `ordinal` 付きの期待値を直す。

### 6.3 `/jobs` の「AI・OCR の利用状況」

- カードを **登録済みの全アカウントの合計** にする（今月のユニットと無料枠の残り、本数、要求、失敗、直近 12 か月の表と推定費用）。合計には環境変数の一覧にない `account_id` の行（画面に出ないアカウント）も含まれるので、サブタイトルを「登録済みの n アカウントの合計（今月）」とし、**アカウント数を出す**（見えないアカウントが収集と Vision を使っていることに気づけるように。D2）。
- 「うち、このアカウント」の 1 行（今月のユニットと本数）を**常に**出す（1 件のときも。一覧が 1 件でも合計と一致しないことがあるため。D5）。`accountId` はこの行にだけ使う。
- `lib/queries/ocr-usage.ts` に `getOcrMonthlyUsageTotal()` を足す（合計の読み出しと `getOcrMonthlyUsage(accountId)` は `Promise.all`）:

```sql
select to_char(month_utc, 'YYYY-MM') as month,
       count(*)::int as accounts,
       sum(requests)::int as requests, sum(failed_requests)::int as failed_requests,
       sum(images)::int as images, sum(units)::int as units, sum(videos)::int as videos
  from public.ocr_monthly_usage
 group by month_utc
 order by month_utc desc
```

- `accounts` はその月に利用があった (account, month) の行数 = アカウント数。`videos` は `count(distinct media_id)` をアカウントごとに取ったものの和で、6.1 節の前提により全体の `count(distinct media_id)` と一致する。
- `lib/ocr-usage.ts` の定数（無料枠、単価、警告のしきい値）と `currentMonthUsage`／`fillMonths` は変えない（同じ列名の行なら合計の結果にそのまま使える）。
- `lib/queries/ocr-usage.ts` 冒頭のコメント「`account_id` で必ず絞る」は、合計の関数が R5・R6 の決まり「対象のアカウントは SQL の `account_id` で絞る」の**意図的な例外**であることを書く（D6）。

### 6.4 SQL と索引

- `ocr_usage` の索引は `(account_id, requested_at)` だけ。合計の読み出しは `requested_at` の範囲だけで引くので、この btree は第 2 列の条件でも使えるが索引全体の走査になり、計画器は表の走査を選ぶ（D4）。行数は月に数百、2 年で 1 万行程度なので許容する。`requested_at` 単独の索引は足さない（Q11。必要になったら 1 本のマイグレーションで足せる）。
- `web_app` は `ocr_usage` と `ocr_monthly_usage` の select を持ち、ポリシーは `using (true)` なので、合計の読み出しに権限の追加は要らない。

---

## 7. DB

- **マイグレーションなし。** 足す列も表もビューもない。`accounts` は複数行を前提に作られていて（`ig_user_id unique`、`status` の既定 `active`）、`register-token` と `/connect` の upsert はどちらも `ig_user_id` で衝突を解き、`private.credentials` は主キー `account_id`、Vault の秘密の名前は `ig-token-<accounts.id>` でアカウントごとに別（D9）。
- `listTargetAccounts` の `unnest … with ordinality` ＋ `join` は `accounts` が数行なので索引を考えない（`ig_user_id` の一意索引は使える）。
- 2 つ目のアカウントの行数の見込み: R1 設計 8 章の表（1 アカウントで月 1.8 万行、大半は `raw_api_responses`）がそのまま 2 倍になる。無料枠（500 MB）に対する現在の使用量は Supabase のダッシュボードで見る（段階 6）。
- RLS は `using (true)` で、アカウントの分離はアプリが渡す `accountId` だけに依存する。複数化で `account_id` の条件漏れが「別アカウントのデータ混入」として現れるようになるので、`lib/queries/*.ts` の SQL に `account_id` の条件があることを機械的に固定するテストを足す（9.2 節。S13）。

---

## 8. 運用と文書

### 8.1 新しいアカウントを足す手順（README に書く。システム名 → 画面の順）

1. **Meta**（Graph API エクスプローラ）: 足すアカウントの Instagram の数値 ID を調べる（`me?fields=instagram_business_account{id,username}`。`.env.example` の案内と同じ）。
2. **Vercel**（Environment Variables）: `META_TARGET_IG_USER_ID` の値の末尾に `,<新しい ID>` を足して再デプロイ。先頭は変えない（既定のアカウント。先頭が `disconnected` でも既定になる）。
3. **本番の画面** `/connect`: ページの管理者の Facebook でログインし「Meta と接続する」。認可画面では **既存のページも含めて対象のページをすべて選ぶ**（外すと 1 つ目の接続が切れることがある。S7）。`ok` の文言が出たら、ヘッダーの切り替えで新しいアカウントを選び、`/connect` の「現在の状態」が `valid` であること、**1 つ目に切り替えて `/connect` の状態が `valid` のまま**であること、`/jobs` の次の毎時の実行に `account=2/2` が出ることを確かめる。失敗の文言が出ても、第 2 段階（DB）の途中なら一部は登録されていることがある。やり直せば同じ `ig_user_id` に上書きされる（4 章）。
4. **GitHub**: 何もしない（Secrets も Variables も変わらない）。月の本数の上限を変えたいときだけ Variable `WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS` を置く（6.1 節。ユニットの上限は無料枠のまま）。
5. 翌日以降: バックフィル（2 年分の日次指標）が `account_backfill` で数日かけて進む。`/jobs` の実行の一覧で `account_backfill` が `success` で進んでいることを見る。登録直後の `collect` の所要を GitHub の Actions で見て、5.3 節の未確認の値を直す。

### 8.2 アカウントを外す手順（README に書く。D2）

画面から外すだけ（Vercel の環境変数から ID を消す）では、収集も Vision の消費も止まらない。止めるには **クラウドの Supabase** の SQL エディタで次を実行する（行を消さない。`accounts` の行を消すと関連データが cascade ですべて消える）:

```sql
update public.accounts set status = 'paused' where ig_user_id = '<ID>';
```

`paused` は `listActiveAccounts` に入らないので収集が止まり、`check-alerts` の判定も外れる。再開は `active` に戻す（`/connect` の再接続は `disconnected` だけを `active` に戻し、`paused` は保つ）。データを消すのは要件 NF-CMP-02 の手順（別途）。

### 8.3 更新する文書

| 文書 | 内容 | 段階 |
|---|---|---|
| `README.md` 149 行〜（Web と Meta との接続） | `META_TARGET_IG_USER_ID` の説明を「カンマ区切りで複数（10 件まで）。先頭が既定」に。例の ID は架空のものにする。8.1 節と 8.2 節の手順を「運用」（364 行〜）に足す | 3 |
| `.env.example` | `IG_USER_ID` の説明に「2 つ目以降のアカウントは本番の `/connect` で登録する（手元の `register-token` を本番に向けない）」を足す。`WORKER_VIDEO_BUDGET_MS`、`WORKER_VIDEO_TEXT_BUDGET_MS`（5.3 節）、`WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT`、`WORKER_VIDEO_TEXT_MONTHLY_MAX_VIDEOS`（全アカウントの合計）の説明。**このファイルの編集は段階 1 だけが行う**（段階 2 は触らない。W13） | 1 |
| `apps/worker/src/config.ts` のコメント | 同上の 4 変数 | 1 |
| `doc/requirements/requirements-definition.md` | 0.6 版で反映済み（2.1 章、3 章、F-SYS-16、4.8 章、9 章、10 章）。F-ACC-04 に「6 アカウント程度まで」を足す | 3 |
| `doc/progress.md` | 13 章（R7）。1 章の表に R7 | 随時 |
| `doc/design/r3-analysis-screens.md` 4.1 節 | 「対象のアカウント」の段落に「R7 で複数から選ぶ形に改めた（`doc/design/r7-multi-account.md` 3 章）」の 1 行 | 3 |

---

## 9. テスト

### 9.1 ワーカー（`apps/worker/test/`）

| 対象 | 確かめること |
|---|---|
| `rotateAccounts`（単体） | N = 1 は回さない。N = 3 で `batchStartedAt` の時刻により先頭が 0、1、2 と巡る。N = 30 でも 30 時間で全員が先頭になる。ラベルの番号は登録順のまま |
| `runJobsForActiveAccounts`（結合 `framework.test.ts`） | `deps.now` を呼ぶたびに進む時計にし、全アカウントの `ctx.batchStartedAt` が同じ値で `startedAt` はアカウントごとに違うこと（W10）。`deps.now` を「時 h の時刻」に固定し、`def.run` のスパイで `ctx.account.id` の呼び出し順が回っていて、ログの `account=` が登録順のままであること（順番＋ラベル） |
| `runJob` を直接呼ぶ既存のテスト | `batchStartedAt` 省略で `startedAt` と同じ値 |
| `video_analysis`、`video_text` の予算（既存の単体） | `batchStartedAt` を基準に `skippedByBudget` が増える。アカウント 2 件で、1 件目が予算を使うと 2 件目は 0 本 |
| `monthlyOcrUsage`（結合 `video-text.test.ts`） | `accountId` ありは今までどおり。省略で 2 アカウントの行の和。月の境目（UTC）。失敗した要求を含む |
| `video_text` の月の上限（結合） | アカウント A が 950 ユニット使っていると、上限 1,000 のとき B の 60 枚の本は見送る（`skippedByMonthlyCap`。枚数は `videoTextMaxUnitsPerRun` 以下にして 1 回の上限に先に当たらないようにする。W9）。今までは通っていた |
| `evaluateAlerts`（単体 `alerts.test.ts`） | `ocr_monthly_cap` はアカウントの数にかかわらず最大 1 件、`account=` なし。`ocrMonthly` 省略で判定しない。hourly で `ocrMonthly` を渡しても判定しない。既存の `ordinal` 付きの期待値を直す |
| `check-alerts`（結合） | daily で合計を 1 回読む。hourly は読まない。`loadAlertAccounts` の既存テストから `now` を外す |

### 9.2 画面（`apps/web/test/`）

| 対象 | 確かめること |
|---|---|
| `readEnv`（`env.test.ts`） | `"1,2"`、`" 1 , 2 "`、`"1,,2"` と `"1,2,"`（空は捨てて `["1","2"]`）、`"1,a"`（不正）、`"1,1"`（重複は 1 つ）、11 件（不正）、未設定（`[]`）。既存の `targetIgUserId` の期待値を直す |
| `pickTargetAccount`（単体） | Cookie 一致、Cookie なし、Cookie が一覧にない、Cookie が uuid でない（大文字、長さ違い）→ 既定 |
| `getTargetAccount`（単体。`next/headers` の `cookies` を `vi.mock`） | Cookie なし → 先頭、一覧外の uuid → 先頭、一致 → その行、読む Cookie の名前が `accountCookieName(appUrl)` と一致（N7a） |
| `accountCookieName`／`accountCookieOptions`（単体） | https で `__Host-`、`secure`、`maxAge` 365 日。http で接頭辞なし |
| `switchAccountAction`（単体。`report.test.ts` と同じく `checkAccess`、`headers`、`cookies`、`readEnv`、`listTargetAccounts` を `vi.mock`） | 拒否の順（config → origin → access → account → input → unknown_account）。一覧にない id は `set` されない。`set` の引数（名前、`secure`、`maxAge`）。`next` が `//evil.example`、`/\evil.example`、`https://…`、`/media?x=1`、`/media/`（末尾スラッシュ）→ `/`。`/connect` → `/connect`。成功で `set` と `redirect`。`redirect` の例外を握りつぶさない |
| `AccountSwitcher`（単体。`renderToStaticMarkup`。`next/navigation` を `vi.mock`） | 1 件では描かない。2 件で `option` が環境変数の順、選択中に `selected`。読み出し失敗で描かない。許可外（`checkAccess` が `forbid`／`login`）では描かず DB を読まない |
| `saveReportNotes`、タグの編集の Action（既存の単体に追加） | 隠し項目 `account` が `getTargetAccount().id` と違えば `account_changed` で拒み、本文は `values` に戻る。一致すれば今までどおり |
| `handleCallback`（`meta-connect.test.ts`） | 一覧 2 件・一致 2 件 → `register` が 2 回、`registered` が 2 件。一覧 2 件・一致 1 件 → 1 回。一覧あり一致なし → `target_mismatch`。一覧なし 2 件 → `multiple_accounts`（既存）。**1 件目の `debug_token` 失敗 → その理由、`register` は 0 回**。2 件目の `register` が DB 失敗 → `db_failed`、1 件目は登録済み。同じ `igUserId` のページが 2 つ → 1 回 |
| `listTargetAccounts`（結合 `test/db/`） | 環境変数の順に並ぶ。DB にない ID は出ない。`paused` も出る。配列が `text[]` で通る |
| `getOcrMonthlyUsageTotal`（結合） | 2 アカウントの和、月ごと、`accounts` 列 |
| `OcrUsageCard`（単体） | サブタイトルにアカウント数。「うち、このアカウント」の行が常に出る |
| `lib/queries/*.ts` の SQL（単体。ソースを読む） | すべての SQL に `account_id` の条件があること。例外（`getOcrMonthlyUsageTotal`、`listTargetAccounts`、`metric_definitions` などアカウントを持たない表）は列挙して固定する（S13） |
| `"use server"` の export 一覧（既存） | `_account/actions.ts` を足す |
| `routes.test.ts` | `NAV_ITEMS` の import 先を `lib/nav` に。並びは変えない |

### 9.3 受け入れ（要件 10 章の R7 の完了条件）

- 本番で 2 つ目のアカウントを `/connect` で登録でき、ヘッダーの切り替えで概要、投稿一覧、レポート、`/jobs`、`/connect` が切り替わる。
- 1 つ目のアカウントの画面と収集は変わらない（切り替えが出る以外）。1 つ目の `/connect` の状態が `valid` のまま。
- 毎時の実行に `account=1/2` と `account=2/2` が出て、両方 `success`。登録の翌日の daily も同様。登録直後の `collect` の所要が 45 分の中に収まり、5.3 節の表を実測で直した。
- `/jobs` の「AI・OCR の利用状況」が合計で、アカウント数が 2、無料枠の残りが減っている。

---

## 10. 段階

| 段階 | 内容 | 担当 |
|---|---|---|
| 0 | 確認事項 Q1〜Q12 の決定 | ユーザー |
| 1 | ワーカー（5 章、6.1〜6.2 節）。`.env.example` と `config.ts` のコメント。`collect.yml` の `timeout-minutes` と Variable | `node-worker-developer` |
| 2 | 画面（3 章、4 章、6.3 節）。`lib/nav.ts` への移動。`.env.example` は触らない | `nextjs-developer`（1 と並列。触るファイルが重ならない） |
| 3 | README、要件定義（F-ACC-04 の件数）、R3 設計 4.1 節の注記 | 親 |
| 4 | レビュー（`security-engineer`: Cookie、Action、照合、接続の 2 段階、ログ。`quality-engineer`: テストの網羅と段階。`postgres-sql-reviewer`: 3.2 節と 6.3 節の SQL の実装） → 反映 | 並列 |
| 5 | main にマージ → Vercel。1 アカウントのまま、見た目と動作が変わらないことをユーザーが確認（切り替えは出ない。`/report` の保存が通る） | 親、ユーザー |
| 6 | 8.1 節の手順で 2 つ目を登録（Vercel の環境変数、`/connect`）。翌日の daily まで見て受け入れ（9.3 節）。登録直後の所要と Supabase の Usage を記録し、5.3 節の表を直す | ユーザー、親 |

段階 5 を 6 より先に行う理由: コードの変更が 1 アカウントの本番で無害であることを先に確かめてから、アカウントを足す。

---

## 11. 確認事項

| No | 内容 | 推奨 |
|---|---|---|
| Q1 | 追加するアカウントは、本人が管理者の Facebook ページに付いたものか。他人のページなら、その人に Meta アプリのテスターの役割を付けて接続してもらう必要があり、画面のログインが 1 つなので互いのデータが見える（要件 2.1 章と 1.4 章の見直しになる） | 前提どおり（本人のページ）。違えば設計をやり直す |
| Q2 | 切り替え後の遷移。(a) 常に概要 `/` へ、(b) 同じナビの画面へ（`/media/123` なら `/media`、`/tags/edit` なら `/tags`。`/connect` はそのまま） | (b)。隠し項目 1 つと許可リストの完全一致で済む |
| Q3 | 切り替えの UI。(a) `select` ＋「切り替え」ボタン（JS なし）、(b) `select` の変更で自動送信（Client Component） | (a)。ほかの画面の選択（`ChoiceChips`）も JS なしの方針 |
| Q4 | 既定のアカウント = `META_TARGET_IG_USER_ID` の先頭 | 推奨どおり。今の値を先頭に残せば今のアカウントが既定 |
| Q5 | 切り替えを出す条件。(a) 一覧が 2 件以上のときだけ、(b) 1 件でもユーザー名を出す | (a)。1 アカウントの見た目を変えない |
| Q6 | 月の本数の上限（既定 30 本）も合計にするか | 合計。ユニットと同じく無料枠を守る値。増やしたいときは GitHub の Variable（6.1 節） |
| Q7 | `collect.yml` の `timeout-minutes` を 45 に | 推奨どおり。定常は 40 秒なので害はなく、6 件程度までを支える（5.3 節） |
| Q8 | `/connect` の `ok` の文言。「接続しました。各アカウントの状態は、アカウントを切り替えて確かめてください。」 | 推奨どおり。登録した件数やユーザー名は URL に載せない（今の決まり） |
| Q9 | Cookie の寿命 365 日。ログアウトで消さない | 推奨どおり。選択は秘密ではなく、消えても既定に戻るだけ |
| Q10 | アカウントの順番を毎時回すか。(a) 回す、(b) 登録順で固定（先頭が予算を使い切ると後ろは翌時以降） | (a)。純粋関数 1 つで済む |
| Q11 | `ocr_usage` に `requested_at` 単独の索引を足すか | 足さない（行数が少ない。SQL レビューも妥当と判断） |
| Q12 | 要件の ID を `F-ACC-01〜05`、章を 4.8「R7: 複数アカウント」（候補は 4.9 章「R8 以降」）に | 推奨どおり（0.6 版で反映済み。違えば戻す） |

---

## 付録 A 事実票（親が 2026-10-17 に確認）

| No | 事実 | 出所 |
|---|---|---|
| A1 | `accounts.ig_user_id text not null unique`、`status` の既定は `active`。R1〜R6 の表はすべて `account_id` を持つ。R5・R6 のポリシーのコメント「対象のアカウントは SQL の `account_id` で絞る」 | `supabase/migrations/20261001100000_r1_accounts.sql` 20〜24 行、`20261009000000_r5_analysis.sql` 194 行、`20261013000000_r6_report.sql` 119 行 |
| A2 | `listActiveAccounts` は `status = 'active'` を `created_at, id` 順。`runJobsForActiveAccounts` は順に `runJob` を呼び、ラベルは `${index + 1}/${accounts.length}`。`runJob(def, deps, account, options = {}, accountLabel?)` は export されていて直接も呼べる | `apps/worker/src/db/accounts.ts` 56 行、`jobs/framework.ts` 315〜321 行、533〜560 行 |
| A3 | `check-alerts` は `listActiveAccounts` → `loadAlertAccounts`（アカウントごとに credential、stories、daily なら `monthlyOcrUsage`）→ `evaluateAlerts`。`ocr_monthly_cap` は `ordinal` 付き。`loadAlertAccounts` の `now` は `monthlyOcrUsage` にしか使わない | `apps/worker/src/commands/check-alerts.ts` 60〜80 行、94〜135 行、`jobs/alerts.ts` 70〜80 行、134〜140 行、231〜255 行 |
| A4 | レート制限は `X-Business-Use-Case-Usage` と `X-App-Usage` の両方を読み、前者が Instagram Platform の一般の制限 | `apps/worker/src/lib/graph.ts` 25〜27 行、178〜179 行 |
| A5 | `getTargetAccount` は `META_TARGET_IG_USER_ID` と一致する 1 行。未設定か一致なしは `TARGET_ACCOUNT_NOT_SET`。呼び出しは 20 ファイル・42 か所 | `apps/web/src/lib/queries/account.ts`、Grep |
| A6 | Server Action の検査の順（環境 → 同一オリジン → 認可（固定の経路）→ 対象のアカウント → 入力の形 → 値）。ログは Action の名前と理由だけ。フォームから `account_id` を受け取らない | `apps/web/src/app/report/actions.ts` |
| A7 | `collect` の直近 100 回（2026-10-11 21:17 UTC〜10-16 00:17 UTC）はすべて success、所要（準備、hourly、`check-alerts`、ping を含む）は最小 34 秒、中央値 40 秒、90 パーセンタイル 50 秒、最大 86 秒。R2 の 7 日間は 32〜92 秒（中央値 57 秒。daily の回が長い） | `gh run list --json startedAt,updatedAt`（2026-10-16）、`doc/progress.md` 199 行、210 行 |
| A8 | Next.js 16 の `cookies()` は async。読むのは Server Component でも可、`set`／`delete` は Server Function か Route Handler の中だけ。Request-time API なので呼んだルートは動的描画。`path` 以外に既定値はない。Server Function で `set` すると、Action の応答で更新された UI とデータが 1 往復で返る | `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md` 1〜91 行 |
| A9 | `video_analysis` は `ctx.now() - ctx.startedAt > config.videoBudgetMs` で新しい 1 本を始めない（ループの先頭で判定）。`video_text` も同じ式。`runJob` の `startedAt` はアカウントごと | `apps/worker/src/jobs/video-analysis.ts` 124〜133 行、`video-text.ts` 633 行、644〜647 行、`framework.ts` 325 行 |
| A10 | `video_text` の月の上限は `monthlyOcrUsage(ctx.db, ctx.account.id, …)` で `units + needed > limit || videos >= maxVideos`（1 回の上限 `needed.length > videoTextMaxUnitsPerRun` の判定が先）。`monthlyOcrUsage` は `account_id` で絞る。`summarize` のログは `month_units` だけ。索引は `(account_id, requested_at)`。`collect.yml` は `WORKER_VIDEO_TEXT_MAX_PER_RUN` と `WORKER_VIDEO_TEXT_MONTHLY_UNIT_LIMIT` だけを渡す | `apps/worker/src/jobs/video-text.ts` 589〜606 行、682〜699 行、`db/video-text.ts` 398〜406 行、`20261012000000_r4_1_video_text.sql` 166 行、`.github/workflows/collect.yml` 186〜200 行 |
| A11 | `ocr_monthly_usage` は `account_id, month_utc` で集計したビュー（`security_invoker`）。`web_app` に `ocr_usage` と同ビューの select あり | 同マイグレーション 445〜470 行 |
| A12 | `handleCallback` は `selectCandidates(pages, targetIgUserId)` → 0 件で `target_mismatch`／`no_instagram_account`、2 件以上で `multiple_accounts`、1 件を登録（7 番ページトークン → 8 番 `debug_token` → 9 番 DB）。`CallbackOutcome.registered` は配列。全体を try/catch で包む | `apps/web/src/lib/meta-connect.ts` 54〜58 行、87〜93 行、135〜172 行 |
| A13 | `registerCredential` は 1 トランザクションで `accounts` → `private.store_token` → `private.credentials` を upsert（`ig_user_id` で衝突を解く。`disconnected` は `active` に戻し `paused` は保つ） | `apps/web/src/lib/queries/register-credential.ts` 42〜50 行 |
| A14 | レイアウトは DB を読まない（ブランドはツール名）。`AppShell` の `actions` はログイン済みなら誰にでも出す（ログアウト）。ナビは `allowed` のときだけ。`NAV_ITEMS` と `activeNavHref` は `"use client"` の `NavLinks.tsx` にあり、`routes.test.ts` が import する。`/connect` と `/jobs` の経路: `/jobs` はナビにあり `/connect` はない | `apps/web/src/app/layout.tsx` 25〜49 行、`components/AppShell.tsx`、`components/NavLinks.tsx` 15〜38 行、`test/routes.test.ts` 17 行 |
| A15 | 認証 Cookie の規則: https で `__Host-` 接頭辞、`httpOnly`、`secure`、`sameSite: 'lax'`、`path: '/'`。ログアウトの Server Action は `redirect` を try の外で呼ぶ | `apps/web/src/lib/supabase/cookie-options.ts`、`app/login/actions.ts` 33〜43 行、`doc/design/r2-cloud.md` 4.3 章 |
| A16 | `collect.yml` は `timeout-minutes: 30`、`concurrency` は `cancel-in-progress: false`。1 つのジョブの中で準備（checkout、`npm ci`、build、ffmpeg のキャッシュ。外れたら最大 5 分）→ `daily-due` → daily の回だけ `run-daily` → `run-hourly` → `check-alerts` → ping が直列。環境変数に予算の指定はない（既定 8 分） | `.github/workflows/collect.yml` 42 行、100〜210 行 |
| A17 | README 9 章「本番の接続文字列をローカルの `.env` に書かない」。1 つ目のアカウントは本番の `/connect` で登録した（2026-10-03） | `README.md` 364〜372 行、`doc/progress.md` 196 行 |
| A18 | 要件 2.1 章「本人が管理する Instagram プロアカウント。最初は 1 つ、将来は数個まで。他人のアカウントは扱わない」（0.6 版で改めた）。F-SYS-16 は `META_TARGET_IG_USER_ID` で他のアカウントの登録を防ぐ | `doc/requirements/requirements-definition.md` 65 行、209 行 |
| A19 | `daily-due` は `latestCompletedStartedAt(db, "account_daily")`（アカウントを絞らない最新の `success`／`partial` の開始）から 24 時間で due。記録がなくても due | `apps/worker/src/commands/daily-due.ts` 20〜24 行、43〜46 行 |

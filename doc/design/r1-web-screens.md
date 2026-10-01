# R1: 最小限の画面と Meta との接続の設計

| 項目 | 内容 |
|---|---|
| 版 | 0.2 |
| 作成日 | 2026-10-02 |
| 更新履歴 | 0.1 初版案。0.2 セキュリティ・品質・Next.js 16 照合のレビューを反映（開始は Route Handler で 303、トークン交換は POST 本文、`-H 127.0.0.1` と `proxy.ts`、複数候補は登録しない、受信ログからコールバックを除外、ビューに足りない列は Web 側の SQL で補う、`connection()` による動的描画、失敗の理由コードの列挙、テスト可能な分割） |
| 対象 | 要件定義 4.2 章（F-COL-01〜03、F-UI-01〜03）、6.1 章、8.1 章、9 章 |
| 入力 | `doc/requirements/requirements-definition.md`（版 0.4）、`doc/design/r1-db-design.md`（版 0.3）、`doc/design/r1-collection-jobs.md`（版 0.3。特に 4.1 章と 13 章）、`apps/web/`（R0 の状態）、`node_modules/next/dist/docs/`（Next.js 16.3） |
| 範囲外 | ログイン（F-SYS-13。R2）、本格的な画面（R3）、通知（F-SYS-14。R2）、接続解除の画面（R2 以降。R1 は README の SQL） |
| 状態 | 実装に入る |

---

## 0. 前提

- R1 の完了条件は「収集ログ画面で成否を確認できる」を含む（要件 10 章）。画面の見た目は簡素でよく、R2.5 で決めたデザインで R3 に作り直す（要件 3 章）。
- Web アプリは `apps/web`（Next.js 16.3、React 19、Tailwind CSS 4、TypeScript）。`next.config.ts` に `cacheComponents` は設定しない（従来モデル。`node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md`）。
- ローカルでは `http://localhost:3000` で動かし、ログインはない（R2 で Supabase Auth を入れる）。**ブラウザに出してよいのは publishable key だけ**で、サービスロールキー、DB の接続文字列、Meta のアプリシークレットとトークンはサーバー側に閉じる（NF-SEC-01、F-COL-02）。
- 収集ワーカー（`apps/worker`）は Postgres 直結（postgres.js）で `private.credentials` と Vault を読み書きしている（収集ジョブ設計 3.1 章）。Web も同じ理由（Vault への書き込み。REST は `private` スキーマと Vault に届かない）で Postgres 直結にする。
- Supabase 公式スキルの指針: `security definer` 関数を `public` に置かない、`security_invoker` のビューを使う、サービスロールキーをブラウザに出さない、依存の版を固定してロックファイルをコミットする。この設計はいずれも満たす。

---

## 1. 構成

### 1.1 画面とルート

| ルート | 画面 | 要件 | 内容 |
|---|---|---|---|
| `/` | 接続状態（トップ） | F-UI-01、F-COL-03 | 1.6 章の項目表のとおり。状態が `valid` でない、認証情報がない、またはデータアクセス期限の残りが 14 日以下なら「再接続」の帯（理由 `last_error` と最終確認時刻つき）を出し、`/connect` へ案内する。アカウントが未登録なら `/connect` へ案内する。R0 の Supabase の接続状態は、この画面の下部に「開発環境」として残す（タイムアウトを 2 秒に短縮） |
| `/jobs` | 収集ログ | F-UI-02 | 上段: ジョブごとの直近の実行（`job_latest_runs` に `accounts` を結合）を実行順（`token_check`、`profile_daily`、`account_daily`、`media_sync`、`media_snapshot`、`stories`、`account_backfill`）に。列はユーザー名、ジョブ名、状態、開始（JST）、所要時間、取得件数、API 呼び出し回数、エラー、使用率。下段: 直近 100 件の実行（`job_runs`。新しい順。ページングなし）。`?job=<name>` は 7 つのジョブ名の許可リストに一致するときだけ絞り込み、未知は無視。表示規則は 1.7 章 |
| `/media` | 投稿の簡易一覧 | F-UI-03 | `media_latest_metrics` を `media_product_type <> 'STORY'` で絞り、投稿日時の新しい順に 50 件ずつ。列はサムネイル（1.4 章）、種類（`media_product_type` と `media_type`）、投稿日時（JST）、主要指標（views、reach、likes、comments、saved、shares）、指標の取得時刻と投稿からの経過（「投稿後 N 時間／日」）、`gone_at`（JST）、`permalink` へのリンク（`https://www.instagram.com/` で始まるときだけ、`target="_blank" rel="noopener noreferrer"`）。`?page=N` は 1 以上の整数に丸め、51 件取って次ページの有無を決める。指標の表示規則は 1.8 章 |
| `/connect` | 接続設定 | F-COL-01 | 「Meta と接続する」ボタン（`<form method="post" action="/api/meta/login">`）と、現在の状態（`account_connection_status` から）、接続で何が起きるかの説明。`?result=<理由コード>` は 2.5 章の対応表で文言にし、未知のコードは汎用文言。**値そのものは描画しない** |
| `/api/meta/login` | Route Handler（POST のみ） | F-COL-01 | OAuth の開始（2 章）。GET は export しない（405） |
| `/api/meta/callback` | Route Handler（GET） | F-COL-01、F-COL-02 | 認可コードを受け取り、トークンの交換と登録を行い、`/connect?result=...` へリダイレクト（2 章） |

共通のレイアウトにナビゲーション（接続状態、収集ログ、投稿一覧、接続設定。`<Link>`）を置く。レイアウトは DB を読まない。

### 1.2 データアクセス

| 項目 | 内容 |
|---|---|
| 方式 | postgres.js 3.4（ワーカーと同じ `^3.4.9`）で Postgres に直結。**サーバー側専用**。`src/lib/env.ts`、`db.ts`、`storage.ts`、`meta-graph.ts`、`queries/*.ts` の先頭に `import "server-only"` を書く（パッケージの追加は不要。Next.js が内部で扱い、型宣言も同梱） |
| 環境変数 | `src/lib/env.ts` の `readEnv()` だけが `process.env` を読む（データアクセス層に閉じる。`02-guides/data-security.md`）。**`connection()` の後**に関数内で読む（ビルド時に焼き込まれないため。`02-guides/upgrading/version-16.md`）。欠落や書式の不備は変数名だけを含む固定文言で返し、値を含めない。`.env.local` は `apps/web/` 直下（Next.js はそこしか読まない。ルートの `.env` は読まれない） |
| 接続 | `src/lib/db.ts` の `getDb(databaseUrl)`。`max: 3`、`idle_timeout: 20`、`connect_timeout: 10`、`application_name: 'instagram-analyze-web'`、`onnotice` 抑止、`types` で `date` を文字列のまま。`bigint`、`numeric` は文字列（表示で `Number()`）。**`debug` は付けない**。`next dev` の HMR で接続が増えないよう `globalThis` に 1 本だけ保持する。`next.config.ts` の `serverExternalPackages: ['postgres']`（Node の `net`／`tls` を使うため。`next build` で確かめる） |
| 動的描画 | DB の読み出しは Request-time API ではないので、それだけでは動的にならず `next build` で焼き込まれる。`src/lib/queries/*.ts` の読み出し関数は **先頭で `await connection()`**（`next/server`）を呼ぶ（`04-functions/connection.md` の例のとおり）。`searchParams` を使うページも同じ関数を通るので二重の保険。`export const dynamic` は使わない（Cache Components 有効化時に削除される設定）。`next dev` では常に動的なので、`npm run build:web` の出力で 4 ルートが `ƒ (Dynamic)` であることを確かめる。同一リクエスト内の重複読み出しは `React.cache` で排除する |
| 読む先 | ビュー `account_connection_status`、`job_latest_runs`、`media_latest_metrics`、表 `job_runs`、`accounts`。すべて `security_invoker` で、`postgres` ロールから読める。ビューに足りない項目は Web 側の SQL で補う（1.6 章） |
| 書く先 | `accounts`、`private.credentials`、Vault（`vault.create_secret`／`update_secret`）。2.4 章の登録だけ。1 つのトランザクション |
| Supabase の REST | 使わない。`@supabase/supabase-js` も入れない |
| エラー | データアクセス層は例外をページに投げず `{ ok: true, data } \| { ok: false, reason }` を返す。`reason` は SQLSTATE か postgres.js のコードだけから作る固定文言（`src/lib/db-errors.ts`。ワーカーの `normalizeDbError` と同じ方針）。`err.query`、`err.parameters`、`err.message`、接続文字列、ホスト名を画面やログに出さない。安全網として `src/app/error.tsx`（Client Component。固定文言と `error.digest` だけを表示し、`error.message` は描画しない） |

ワーカーのコードは import しない（別パッケージで、ビルドの形も違う）。Web 側の SQL は読み出しが中心で小さいので、重複は許容する。

### 1.3 時刻の表示

すべて JST で `YYYY-MM-DD HH:mm`（`Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ... })`。`src/lib/format.ts` の純粋関数）。null は「—」。残り日数は `data_access_expires_at` から JS で `Math.floor((until − now) / 1 日)`（ワーカーの `token_check` と同じ切り捨て。ビューの `data_access_days_left` は UTC の日付基準なので使わない）。アカウント日次指標はこの画面では扱わない（PT の注記は R3）。

### 1.4 サムネイルの表示

バケット `thumbnails` は非公開。サーバー側で Storage の署名付き URL を作って `<img>` に渡す。

| 項目 | 内容 |
|---|---|
| API | `POST {SUPABASE_URL}/storage/v1/object/sign/thumbnails`（本文 `{ expiresIn: 3600, paths: [...] }`、ヘッダ `Authorization: Bearer <サービスロールキー>`、`apikey`、`cache: 'no-store'`）。1 ページ分（最大 50 件）を 1 回で署名する。応答は要素ごとに `error` と `signedURL`（`/object/sign/...` の相対パス。`${SUPABASE_URL}/storage/v1` を前置する）。**応答の形は実装時に実機で確かめる** |
| 環境変数 | `SUPABASE_URL`（サーバー側。ローカルは `http://127.0.0.1:54321`）、`SUPABASE_SERVICE_ROLE_KEY`（サーバー側）。既存の `NEXT_PUBLIC_SUPABASE_URL` は R0 の接続確認に残す |
| 失敗 | 署名に失敗した要素は画像なし（代わりに種類の文字）。ページは出す |
| `<img>` | `next/image` は使わない（署名付き URL は `?token=` を持ち `remotePatterns` の `search` を省く必要があり、`127.0.0.1` は v16 の Local IP 制限で `dangerouslyAllowLocalIP` が要るため）。素の `<img width height loading="lazy" alt>` を使い、その行に `eslint-disable-next-line @next/next/no-img-element` と理由を書く（規則は warn） |

### 1.5 描画と見た目

- 3 画面と `/connect` は Server Components。Client Component は `error.tsx` だけ。
- フォームは `<form method="post">` と Route Handler。絞り込みとページングは `<Link>`。
- 見た目は Tailwind のユーティリティだけ。表は横スクロール可。スマートフォン幅でも読める最低限。`globals.css` のダークモードのブロックは外す（R0 の配色がダークで読みにくいため。R3 で作り直す）。
- 応答ヘッダ（`next.config.ts` の `headers()`、全ルート）: `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。

### 1.6 接続状態の項目とデータの対応（`/`）

| 項目 | 出どころ |
|---|---|
| ユーザー名、表示名 | `account_connection_status.username`、`accounts.name`（`account_id` で結合。ビューに `name` がないため） |
| アカウントの状態 | `account_status`（`active`／`paused`／`disconnected`） |
| トークンの種類、有効期限 | `token_type`、`token_expires_at`（null は「期限なし」） |
| データアクセス期限と残り日数 | `data_access_expires_at` と 1.3 章の計算 |
| 権限と不足 | `scopes` と、必要な 3 つ（`instagram_basic`、`instagram_manage_insights`、`pages_read_engagement`）との差 |
| 認証情報の状態、理由、最終確認 | `credential_status`（null は「未接続」）、`last_error`（ワーカーの固定文言）、`last_checked_at` |
| 最終収集時刻 | **ビューの `last_collected_at` は使わない**（`token_check` の成功でも進むため）。Web 側で `job_runs` から `job_name <> 'token_check' and status in ('success','partial')` の `max(finished_at)` を取る |
| 再接続の要否 | 純粋関数 `needsReconnect({ credential_status, data_access_expires_at, now })`: `credential_status` が null か `valid` 以外、または残り 14 日以下なら true |

### 1.7 収集ログの表示規則（`/jobs`）

| 状態 | 表示 |
|---|---|
| `running` | 「実行中（開始から N 分）」。所要時間は出さない |
| `success` | 所要時間 `finished_at − started_at` |
| `partial`、`failed`、`skipped` | 所要時間に加えて `error` を必ず出す（ワーカーがマスク済み。固定文言か API の文言）。長い文は `<details>` で折りたたむ（JS 不要） |
| `rate_usage` | `call_count`／`total_cputime`／`total_time` の最大を「使用率 N%」で 1 つに（ワーカーの `RateMonitor.percent` と同じ）。`estimated_time_to_regain_access` があれば「回復見込み N 分」。null は「—」 |

### 1.8 投稿一覧の指標の表示規則（`/media`）

`media_latest_metrics.metrics` は JSON で、「キーがない: その種類では取れない、null: 欠損、数値: 値」（F-COL-22）。純粋関数 `metricCell(metrics, key)`: `metrics` が null（スナップショットなし）→「未取得」、キーなし →「—」、null →「欠損」、数値 → 値、オブジェクト（内訳）→「—」。SQL の `metric_value()` は null とキーなしを区別できないので画面では使わない。

---

## 2. Meta との接続（Facebook Login）

### 2.1 流れ

```text
/connect（<form method="post" action="/api/meta/login">）
POST /api/meta/login
  ├─ Sec-Fetch-Site が same-origin／none 以外、または Origin が APP_URL のオリジンと違えば 403
  ├─ state（crypto.randomBytes(32) の base64url）を生成
  ├─ Cookie: name=meta_oauth_state、httpOnly、SameSite=Lax、path=/api/meta、maxAge=600、secure は APP_URL が https のときだけ
  └─ NextResponse.redirect(認可 URL, 303)   ← redirect() だと 307 で POST が再送されるため使わない

Meta の認可画面（ユーザーが許可）

GET /api/meta/callback?code&state   （本文全体を try/catch。例外を投げず、必ず NextResponse.redirect(new URL('/connect?result=<コード>', APP_URL)) を返す）
  ├─ Cookie の state を読んだら、成否にかかわらず最初に削除（使い捨て）
  ├─ state が Cookie と一致しない（長さ比較 → crypto.timingSafeEqual）→ state_mismatch
  ├─ error パラメータがあれば内容を問わず denied（error_description は画面にもログにも出さない。ログは error_reason が ^[a-z_]{1,40}$ に合うときだけ）
  ├─ code が空、512 文字超、^[A-Za-z0-9_-]+$ に合わない → invalid_request
  ├─ code → 短期ユーザートークン: POST graph/{v}/oauth/access_token（本文 x-www-form-urlencoded: client_id、client_secret、redirect_uri、code。cache: 'no-store'）
  ├─ 短期 → 長期ユーザートークン: POST 同（grant_type=fb_exchange_token、client_id、client_secret、fb_exchange_token）
  ├─ GET graph/{v}/me/accounts?fields=id,name,instagram_business_account{id,username,name}&limit=100（Bearer: 長期ユーザートークン。paging.next の有無で続きを判断し cursors.after を after に渡す。最大 10 ページ）
  ├─ instagram_business_account のあるページを候補にし、ig_user_id で重複排除（2.3 章）
  ├─ 選んだページのトークン: GET graph/{v}/{page_id}?fields=access_token（Bearer: 長期ユーザートークン）
  ├─ ページトークンを debug_token で調べる（アプリトークン appId|appSecret を Bearer に、input_token はクエリ。種類、期限、データアクセス期限、権限、app_id、profile_id）
  ├─ app_id が META_APP_ID と違う、profile_id がページの id と違う、is_valid でない、type が PAGE でない → token_invalid
  ├─ DB に登録（2.4 章。1 トランザクション）
  └─ /connect?result=ok
```

`me/accounts` の `fields` に `access_token` を含めず、選んだページだけ別に取るのは、使わないページのトークンを受け取らないため。

トークン交換を POST 本文で行うのは、`client_secret` と `code` を URL に載せないため（Next.js の fetch ログや `ERR_INVALID_URL` の `input` に URL が出る経路がある）。Graph API が POST を受け付けない場合は GET に戻し、`META_GRAPH_API_VERSION` の形式検査（`/^v\d+\.\d+$/`）と `logging.fetches` を設定しないことで代替する（4 章の手動確認で判定）。

### 2.2 設定

| 変数 | 内容 | 秘密 |
|---|---|---|
| `META_APP_ID` | Meta アプリの ID（ワーカーと同じ値） | なし |
| `META_APP_SECRET` | Meta アプリのシークレット | **あり**。サーバー側だけ |
| `META_GRAPH_API_VERSION` | 既定 `v25.0`。`/^v\d+\.\d+$/` を検証 | なし |
| `APP_URL` | 戻り先の元。ローカルは `http://localhost:3000`。オリジンだけ（パス、末尾スラッシュなし）を検証。`redirect_uri` は `${APP_URL}/api/meta/callback`、リダイレクト先の基点にも使う（`request.url` から組み立てない） | なし |
| `META_TARGET_IG_USER_ID` | 任意。候補が複数のとき、この ID の候補だけを登録する | なし（`.env.local` にだけ置く） |
| `DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` | 1.2 章、1.4 章 | あり |

`apps/web/.env.example` に追加する。`NEXT_PUBLIC_` を付けない。値は `apps/web/.env.local` に置く。

要求する権限（scope）: `instagram_basic`、`instagram_manage_insights`、`pages_read_engagement`、`pages_show_list`（`me/accounts` に要る。収集ジョブは使わない。NF-SEC-05）。

Meta アプリ側の設定（ユーザーが行う。README に書く）: 「Facebook ログイン」の製品を追加し、「クライアント OAuth ログイン」と「ウェブ OAuth ログイン」を有効にする。**戻り先の登録は不要**: 開発モードのアプリでは `http://localhost` への戻り先が自動的に許可される（Meta の設定画面に「http://localhost のリダイレクトは開発モードでのみ自動的に許可され、ここに追加する必要はありません」と表示される。2026-10-02 に確認。要件 C2 は解決）。`127.0.0.1` は「すべてのリダイレクト URL で HTTPS が必要」と拒否されるので使わない。ログインするユーザーはアプリの管理者・開発者・テスターである必要がある。R2 の本番 URL は `https` で登録する。

### 2.3 ページの選び方

- `me/accounts` の中で `instagram_business_account` があるページを候補にし、`ig_user_id` で重複排除する。
- 候補が 1 つ: そのページを登録。
- `META_TARGET_IG_USER_ID` があるとき: 候補の数にかかわらず一致するものだけを登録する。一致がなければ登録せず `target_mismatch`（Instagram 付きのページ自体がなければ `no_instagram_account`）。
- 指定がなく候補が複数: **何も登録せず** `multiple_accounts`（「Meta の認可画面で対象の Facebook ページだけを選んでやり直す」と案内）。意図しないアカウントのトークンを保存・収集しないため（要件 2.1 章）。
- 候補が 0: `no_instagram_account`。

### 2.4 DB への登録

ワーカーの `register-token` コマンド（収集ジョブ設計 4.1 章、`apps/worker/src/db/accounts.ts`）と同じ内容を、Web の `src/lib/queries/register-credential.ts` で行う（1 つのトランザクション）。

1. `accounts` を `ig_user_id` で upsert（`username`、`name`、`fb_page_id`。update では null で既存を消さない。**`status` が `disconnected` なら `active` に戻し、`paused` はそのまま**、新規は `active`）。
2. Vault を `name = ig-token-<accounts.id>` で探し、あれば `update_secret`、なければ `create_secret`。
3. `private.credentials` を upsert（`token_type = 'PAGE'`、`expires_at` は 0／未定義なら null、`data_access_expires_at` は 0／未定義なら null、`scopes` は欠落なら空配列、`status` は必要な 3 権限がそろえば `valid` でなければ `insufficient_scope`、`last_checked_at = now()`、`last_error = null`）。

`debug_token` の結果から `CredentialInfo` を作る規則は、ワーカーの `toCredentialInfo` と同じ（Web に複製する）。長期ユーザートークンは保存しない（再接続は同じ OAuth をやり直す）。短期トークン、長期トークン、ページトークン、`code` のいずれも、Cookie、URL、ログ、画面、例外メッセージに出さない。

### 2.5 失敗の扱い（理由コードは閉じた列挙）

| コード | 場面 | 画面の文言（固定） | ログ（`console.warn` 1 行） |
|---|---|---|---|
| `ok` | 成功 | 接続しました。登録したアカウントは上の表のとおり | なし |
| `state_mismatch` | Cookie なし、不一致、再読み込み | 接続をやり直してください（確認用の値が一致しません） | `warn` |
| `denied` | Meta の `error` パラメータ | 接続が許可されませんでした | `error_reason`（形が合うときだけ） |
| `invalid_request` | `code` の形が不正、`state` なし | 接続をやり直してください（要求が不正です） | `warn` |
| `token_exchange_failed` | 交換の HTTP 失敗、JSON でない、`access_token` なし | Meta からトークンを取得できませんでした | Graph のコードだけ |
| `accounts_failed` | `me/accounts` の失敗 | Facebook ページの一覧を取得できませんでした | Graph のコードだけ |
| `no_instagram_account` | 候補 0 | Instagram プロアカウントに接続された Facebook ページが見つかりません | なし |
| `multiple_accounts` | 候補が複数で絞れない | 対象の Facebook ページだけを選んで接続し直してください（複数見つかりました） | 件数だけ |
| `target_mismatch` | `META_TARGET_IG_USER_ID` に一致する候補がない | 指定した Instagram アカウントの付いた Facebook ページが見つかりません（META_TARGET_IG_USER_ID を確認してください） | 件数だけ |
| `page_token_failed` | ページのトークン取得の失敗 | ページのトークンを取得できませんでした | Graph のコードだけ |
| `debug_token_failed` | `debug_token` の失敗 | トークンの確認に失敗しました | Graph のコードだけ |
| `token_invalid` | `is_valid` でない、`app_id`／`profile_id` 不一致、種類が PAGE でない | 取得したトークンが有効ではありません | 理由の種別（固定語） |
| `db_failed` | 登録の失敗 | 登録に失敗しました（DB） | `db-errors.ts` の固定文言 |
| `config_missing` | 環境変数の不足（`APP_URL` 自体が欠けうるので、この場合だけ相対の `Location: /connect?result=config_missing` で戻る） | 設定が足りません（変数名）。ボタンは無効 | 変数名 |
| `unknown` | 上記以外の例外 | 接続に失敗しました | 固定文言のみ（例外オブジェクトを渡さない） |

ログは `console.warn` に 1 行（Next.js の開発サーバーの出力）。トークン、`code`、URL、ID、例外オブジェクト、`error_description` を含めない。`fetch` の例外の `message`（URL を含みうる）も出さない。

`next.config.ts` の `logging: { incomingRequests: { ignore: [/^\/api\/meta\/callback/] } }` で、Next.js 自身の受信ログからコールバック（`?code=...&state=...`）を除外する。`logging.fetches` は設定しない（fetch の URL が出る）。

### 2.6 再接続

`/` の帯と `/connect` の説明は `account_connection_status` から判断する（1.6 章）。再接続は同じボタン。登録済みのアカウントはトークンが差し替わり、`private.credentials.status` は登録時点で更新される（翌日の `token_check` を待たない）。

---

## 3. セキュリティ

| 項目 | 内容 |
|---|---|
| 秘密の置き場 | `DATABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`META_APP_SECRET` は `NEXT_PUBLIC_` を付けず、`server-only` のモジュールからだけ読む。Client Component は `error.tsx` だけ（`error.message` を描画しない） |
| 待ち受け | `next dev` と `next start` は既定で `0.0.0.0` にバインドするので、`package.json` の `dev`／`start` を `-H 127.0.0.1` にしてループバックだけにする（本体）。加えて `src/proxy.ts` で `Host` が `APP_URL` のホスト（と `127.0.0.1:3000`、`[::1]:3000`）以外なら 403（DNS リバインディング対策。LAN の攻撃者には効かないので `-H` の代わりにはならない） |
| CSRF | OAuth の `state` は乱数で、httpOnly の Cookie と照合し、使い捨て。`/api/meta/login` は POST だけで、`Sec-Fetch-Site`／`Origin` を確認する（Route Handler には Next.js の Origin 検査がないため）。`Origin` 検査が働くには文書の `Referrer-Policy` が `no-referrer` でないことが条件（`no-referrer` だと同一オリジンのフォーム送信でも `Origin: null` になる。2026-10-02 の実機で 403 になり、`same-origin` に変更） |
| 認証 | R1 のローカルではログインなし（上の 2 行が前提）。R2 でログイン必須（F-SYS-13）にし、画面と Route Handler の両方で確認する。コールバックは Meta からのトップレベル GET で戻るので、R2 ではそこでもセッションを確認する |
| 入力 | `?result=`、`?job=`、`?page=` は許可リストか整数化で固定し、値を反射しない。Meta からの `code`、`state`、`error*` は 2.1 章の検査 |
| 画面に出す情報 | ユーザー名、表示名、指標、投稿日時、`permalink`（`https://www.instagram.com/` 始まりのみ）、サムネイル。キャプションは出さない。トークンと接続文字列は出さない。エラーは固定文言 |
| 署名付き URL | 1 時間で切れる。`Referrer-Policy: same-origin` で、Referer はアプリ自身にしか送らない（Storage や Meta にアプリの URL を出さない。`no-referrer` は上の CSRF の行の理由で使えない） |
| 依存 | 実行時依存は `postgres`（`^3.4.9`。`package-lock.json` で固定）。開発依存に `vitest`（ワーカーと同じ 5 系）。`server-only` パッケージは入れない。それ以外は入れない |
| DB のロール | ローカルは `postgres` ロール（Vault の復号ができる広い権限）。単一ユーザーのローカルでは許容。R2 で Web 用のロールを作る（12 章） |

---

## 4. テストと確認

### 4.1 分割（テストできる形）

| モジュール | 種別 | 内容 |
|---|---|---|
| `src/lib/meta-oauth.ts` | 純粋（`server-only` なし） | `generateState(random)`、`verifyState(a, b)`、`buildAuthorizeUrl(config, state)`、`parseTokenResponse(body)`、`selectCandidates(pages, targetIgUserId)`、`toCredentialInfo(debugTokenData, expected: { appId, pageId })`、`REASON_MESSAGES`、`validateCode(code)`、`validateCallbackParams(...)` |
| `src/lib/meta-connect.ts` | 注入可能 | `startLogin(deps) → { url, state }`、`handleCallback(input: { code, state, cookieState, error, errorReason }, deps: { fetch, db, env, random, register?, log? }) → { result: ReasonCode, registered? }`（`register` と `log` を差し替えて DB の失敗や例外をテストする）。Route Handler は Cookie の読み書きとリダイレクトだけ。コールバックのすべての応答に Cookie 削除の `Set-Cookie` を付ける |
| `src/lib/request-guard.ts` | 純粋 | `appOrigin(appUrl)`、`isAllowedHost(host, appUrl)`（`APP_URL` のホストと `localhost:3000`、`127.0.0.1:3000`、`[::1]:3000`）、`isSameOriginPost({ secFetchSite, origin }, appUrl)`（`Origin` は必須で完全一致）。`proxy.ts` と `/api/meta/login` で共用。**ブラウザは `APP_URL` と同じオリジンで開く**（`127.0.0.1` で開くと Origin 不一致で 403） |
| `src/proxy.ts` | — | `readEnv` は `server-only` で Proxy から使えないため、ここだけ `process.env.APP_URL` を直接読む（1.2 章の例外）。`APP_URL` が不正でもローカルの既定 3 ホストは許す |
| `src/lib/format.ts` | 純粋 | `formatJst`、`daysLeft`、`needsReconnect`、`metricCell`、`jobRowView`、`parsePage`、`parseJobFilter`、`usagePercent` |
| `src/lib/db-errors.ts` | 純粋 | `describeDbError(e)` |

### 4.2 単体（vitest。`apps/web/test/*.test.ts`）

`vitest.config.mts` は `test: { environment: 'node', include: ['test/**/*.test.ts'] }` と `resolve.alias: { '@': './src', 'server-only': './test/stubs/server-only.ts' }`（`jsdom`、React のプラグイン、testing-library は不要。async Server Components は vitest でテストしない）。

- `format`: JST（UTC 15:00 → 翌日 00:00、null）、`daysLeft`（14 日ちょうど、負、null）、`needsReconnect`（`valid`／14 日超 → false、`expired`、`insufficient_scope`、`error`、null、14 日以下、過ぎた → true）、`metricCell`（1.8 章の全分岐）、`jobRowView`（`running`、所要時間、`rate_usage` null、回復見込み、折りたたみ）、`parsePage`（`abc`、`0`、`-1`、巨大、配列）、`parseJobFilter`（未知は無視）。
- `meta-oauth`: `generateState` の長さと base64url、`verifyState` の長さ違い、`buildAuthorizeUrl`（`client_id`、`redirect_uri` 完全一致、scope 4 つ、`state`、`response_type=code`、`client_secret` を含まない）、`parseTokenResponse`（正常、`error` 本文、JSON でない、`access_token` なし）、`selectCandidates`（0、1、複数、`instagram_business_account` なし混在、重複、`id` が数字列でない、`targetIgUserId` で絞る）、`toCredentialInfo`（ワーカーの `test/register-token.test.ts` と同じケース ＋ `app_id` 不一致、`profile_id` 不一致、`is_valid: false`、PAGE 以外）、`validateCode`、`REASON_MESSAGES`（全コードに文言、未知は汎用、文言にトークン・URL なし）。
- `meta-connect`: 偽 `fetch` の応答キュー（ワーカーの `test/framework.test.ts` の形）で `handleCallback` の全分岐（各理由コード、`state` 不一致、`error=access_denied`、交換失敗、`me/accounts` 2 ページ、候補 0、複数、`debug_token` 失敗、`token_invalid` の各種、DB 失敗）。`fetch` に渡る URL に `client_secret`、`code`、トークンが含まれない。`startLogin` の URL と state。
- `db-errors`: `PostgresError` 風、接続コード、`ERR_INVALID_URL`（`input` を含まない）、普通の Error、Error 以外。

### 4.3 結合（`TEST_DATABASE_URL` があるときだけ）

`register-credential`: 架空 `ig_user_id`（`000000` ＋ 乱数）で登録 → `accounts`、`private.credentials`、`vault.decrypted_secrets` に 1 件ずつ → 2 回目は `token_secret_id` が同じで値が差し替わる → `disconnected` にしてから再登録で `active`、`paused` はそのまま → トランザクション途中の失敗で Vault に孤児が残らない → `afterAll` で削除（トリガーで Vault も消える）。`queries/*`: 各ビューの読み出しが型どおり（`scopes` は `string[]`、`rate_usage` は `RateUsage | null`、`date` は文字列）。

### 4.4 手動と静的

- `npm run lint:web`、`npm run typecheck -w web`（`next typegen` → `tsc --noEmit`）、`npm run build:web`（4 ルートが `ƒ`）。
- R3 への申し送り: `/media` の `offset` ページングと `order by posted_at desc` は全アカウント横断で索引（`account_id` 先頭）を使えない。R1 の件数では問題ないが、R3 で `account_id` の絞り込みかキーセットページングにする。
- `npm run dev:web` で 3 画面を表示（実データ）。署名付き URL の応答形式の確認。
- Meta アプリの設定（2.2 章）のあと `/connect` から接続して登録される（C2 の確認。POST での交換が通ることの確認を兼ねる）。確認項目: トークンがブラウザの URL、端末のログ、`accounts`、`job_runs.error` に出ていない。`data_access_expires_at` が約 90 日先。`npm run worker:job -- token-check` が `valid`。次の hourly が `success`。
  - 2026-10-02 に実機で確認済み。POST での交換は通った。初回は `Referrer-Policy: no-referrer` のため `POST /api/meta/login` が 403 になり、`same-origin` に変更して成功（3 章）。

---

## 5. 確認事項（決定済み）

| No | 内容 | 決定 |
|---|---|---|
| Q1 | 候補のページが複数あるとき | 登録しない（2.3 章）。`META_TARGET_IG_USER_ID` を指定すれば、候補の数にかかわらず一致するものだけを登録し、一致がなければ `target_mismatch` |
| Q2 | 3 画面に R0 の Supabase の接続状態を残すか | トップの下部に残す（タイムアウト 2 秒）。R2 で消す |
| Q3 | Web も Postgres 直結でよいか | 直結。Vault に書く必要があるため。R2 ではプーラーのトランザクションモード |
| Q4 | ログイン開始は Route Handler か Server Action か | Route Handler（303 を明示。コールバックと同じ API で対称。`Sec-Fetch-Site`／`Origin` で CSRF を補う） |
| Q5 | `serverExternalPackages` に `postgres` を入れるか | 入れる（`next build` で確かめる） |
| Q6 | `-H 127.0.0.1` を既定にするか | する |

---

## 12. R2 への申し送り

- Vercel からの DB 接続はプーラーのトランザクションモード（`prepare: false`、`ssl`）。接続文字列と Storage のキーは Vercel の環境変数に置く。
- Web 用の DB ロールを作り、ビューの `select`、`accounts`／`private.credentials` の `insert`／`update`、`vault.secrets` の `select`、`vault.create_secret`／`update_secret` の `execute` だけを与える。
- `APP_URL` を本番の URL にし、Meta アプリの「有効な OAuth リダイレクト URI」に本番の `https://.../api/meta/callback` を追加する。Cookie は `__Host-` 接頭辞と `secure`。
- ログイン（Supabase Auth）を入れ、Route Handler も認証を要求する。コールバックでもセッションを確認し、未ログインなら登録せずログインへ戻す。
- Vercel のリクエストログにコールバックのクエリ（`code`）が残らないかを確かめる。
- 接続解除（`accounts` の削除とサムネイルの削除）の画面。

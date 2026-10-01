# instagram-analyze

インスタの分析ツール。自分の Instagram プロアカウントのデータを Meta 公式 API から継続的に取得して蓄積し、どんな投稿がなぜ伸びたのかを分析する。

- 要件定義: [doc/requirements/requirements-definition.md](doc/requirements/requirements-definition.md)
- 事前調査: [doc/preliminary/](doc/preliminary/)

## 構成

| ディレクトリ | 内容 |
|---|---|
| `apps/web` | Web アプリ（Next.js 16、TypeScript） |
| `apps/worker` | 収集ワーカー（Node.js 24、TypeScript、ffmpeg）。Docker コンテナで動かす |
| `supabase` | Supabase の設定とマイグレーション（Supabase CLI） |
| `doc` | 調査資料、要件定義など |

npm workspaces で `apps/*` をまとめて管理している。

## 必要なもの

- Docker（Docker Desktop など）
- Node.js 24 以上と npm
- Meta API を検証する場合: Instagram プロアカウントと、それに接続した Facebook ページ、Meta 開発者アプリ

Supabase CLI は npm の開発用依存に含めているので、別途のインストールは不要。

## ローカル環境の起動

リポジトリのルートで実行する。

```bash
# 1. 依存関係のインストール
npm install

# 2. Supabase を Docker で起動（初回はイメージの取得に数分かかる）
npm run db:start

# 3. 接続情報を確認する（API URL、Publishable key、Studio の URL など）
npm run db:status

# 4. Web アプリの環境変数を用意し、NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY に
#    手順 3 の Publishable key を入れる
cp apps/web/.env.example apps/web/.env.local

# 5. Web アプリを起動して http://localhost:3000 を開く
npm run dev:web
```

画面に「すべてのサービスに接続できています」と出れば、Web アプリからローカルの Supabase に接続できている。

| サービス | URL |
|---|---|
| Web アプリ | http://localhost:3000 |
| Supabase Studio（DB の管理画面） | http://127.0.0.1:54323 |
| Supabase API | http://127.0.0.1:54321 |
| Postgres | postgresql://postgres:postgres@127.0.0.1:54322/postgres |

停止するときは `npm run db:stop`。

## 収集ワーカー

ワーカーは ffmpeg を含む Docker イメージとして動かす。

```bash
# イメージのビルド
npm run worker:image

# 実行環境の確認: ffmpeg で検証用動画を作り、長さとカットのタイミング（ミリ秒）を取得できるか確かめる
npm run worker:check-env
```

`結果: OK` と出れば、動画解析に必要な環境が揃っている。

## Meta API の検証

要件定義の F-COL-00 に従い、Meta API で実際に何が取れるかを自分のアカウントで確かめる。

1. アクセストークンを用意する。[Graph API エクスプローラ](https://developers.facebook.com/tools/explorer/) で自分の Meta アプリを選び、次の権限を付けてユーザーアクセストークンを発行する。
   - `instagram_basic`
   - `instagram_manage_insights`
   - `pages_show_list`
   - `pages_read_engagement`
2. ルートの `.env.example` を `.env` にコピーし、`META_ACCESS_TOKEN` にトークンを入れる。`META_APP_ID` と `META_APP_SECRET` も入れると、トークンの種類と有効期限も調べられる。
   - ページアクセストークンも使える。その場合は `IG_USER_ID` に Instagram アカウントの数値の ID を入れる（ユーザー名ではない）。ページトークンは、Instagram アカウントを接続した Facebook ページのものを使う。
   - 期限のないページトークンは、長期ユーザートークン（約 60 日）で `me/accounts?fields=name,access_token,instagram_business_account{id,username}` を実行して得る。短期ユーザートークンから作ったページトークンは約 1 時間で切れる。
   - 期限のないトークンでも「データアクセス期限」（約 90 日）があり、過ぎるとアプリの再承認が必要になる。
3. 検証を実行する。

```bash
npm run worker:verify-api
```

結果は `.local/api-verification/` に 2 つのファイルとして出力される。

| ファイル | 内容 | 扱い |
|---|---|---|
| `verify-api-*.json` | API のレスポンスを含む詳細 | 自分のデータを含む。Git 管理外 |
| `verify-api-*.md` | 取得できた項目、できなかった項目の要約。ID や指標の値は含まない | `doc/` に転記してよい |

ストーリーズの検証は、公開中（投稿から 24 時間以内）のストーリーズがあるときだけ行われる。

## 開発用コマンド

| コマンド | 内容 |
|---|---|
| `npm run lint:web` | Web アプリの lint |
| `npm run build:web` | Web アプリのビルド |
| `npm run test -w worker` | ワーカーの単体テスト |
| `npm run typecheck -w worker` | ワーカーの型チェック |
| `npm run db:reset` | ローカル DB を作り直し、マイグレーションを適用し直す |

## DB

テーブル設計は `doc/design/r1-db-design.md`、マイグレーションは `supabase/migrations/` にある。ローカルの DB にはユーザーの実データが入るので、ダンプやエクスポートをコミットしない。

## 注意（公開リポジトリ）

このリポジトリは公開している。次のものは絶対にコミットしない。

- `.env`、`apps/web/.env.local` などの秘密情報
- `.local/` 以下の取得データ
- 自分のアカウントの ID、ユーザー名、指標の値

## Graph API のバージョン

`META_GRAPH_API_VERSION` で固定する（既定は `v25.0`）。バージョンは少なくとも 2 年サポートされる。v25.0 の提供終了予定は 2028-07-29。

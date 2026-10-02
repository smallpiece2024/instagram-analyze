# instagram-analyze

自分の Instagram プロアカウントのデータを Meta 公式 API から蓄積して分析するツール。

## 作業を始める前に

1. `doc/progress.md` を読み、現在地と次の作業を確認する。
2. 要件は `doc/requirements/requirements-definition.md`、Meta API の実機検証結果は `doc/verification/r0-meta-api-verification.md` にある。
3. 作業の区切りで `doc/progress.md` を更新する。

## 決まりごと

- ユーザーへの応答とコミットメッセージは日本語で書く。
- 公開リポジトリなので、秘密情報（`.env` など）、取得データ（`.local/`）、アカウントの ID やユーザー名をコミットしない。
- Next.js 16 は従来と API が違う。`apps/web` のコードを書く前に `node_modules/next/dist/docs/` の該当資料を読む。
- DB のマイグレーションは `supabase/migrations/` に手書きする（`supabase db pull` や `--yes` で生成しない）。Supabase の MCP サーバは使わない。
- git worktree は使わない。並列に作業するときは同じ作業ツリーでファイルを分担する。

## サブエージェント

タスクに合う専門のエージェントに委譲し、設計 → 並列レビュー → 差し戻しで進める。

| エージェント | 用途 | 出所 |
|---|---|---|
| `postgres-sql-reviewer` | スキーマ、マイグレーション、ビュー、索引、分析 SQL の設計とレビュー | `.claude/agents/`（外部由来、改変あり） |
| `node-worker-developer` | `apps/worker` の実装（API クライアント、再試行、ストリーム、子プロセス） | 同上 |
| `nextjs-developer` | `apps/web` の画面の実装 | 同上 |
| `dashboard-designer` | 分析画面のデザインシステムの案づくりと選定（R2.5） | 同上 |
| `backend-architect`、`security-engineer`、`quality-engineer` など | 設計、セキュリティレビュー、テスト設計 | ユーザー設定の SuperClaude |

Supabase 公式スキル（`supabase`、`supabase-postgres-best-practices`）は公式プラグインとして `.claude/settings.json` に登録している（README）。Supabase と Postgres に触る前に読み込む。

### サブエージェントへの依頼の決まり

2026-10-02 に、起草エージェントが外部文書 15 本（HTML で 1 本 1 MB 超）を `curl` と `grep` で掘り続けて文脈が 46 万トークンに膨らみ、40 分で 1 行も書けずに止めた。再発を防ぐための決まり。

- **調査と執筆を分ける。** 外部の事実は、抜粋を返す道具（Supabase の文書検索、WebFetch の要約、`.md` 付きの URL）で親が先に集め、確認日と出典つきの「事実票」にして渡す。エージェントに Web ページを取らせない。
- **読む量に上限を付ける。** 依頼には読むファイルを行範囲つきで列挙する。10 本以内、合計 15 万文字までを目安にする。超えるなら依頼を分ける。
- **骨子を先に書かせる。** 成果物がファイルなら、最初の 5 分で見出しだけ書き、節ごとに埋めさせる。
- **上限と報告を決める。** 依頼に所要時間の上限（例: 20 分）を書き、終了時に所要時間とツール呼び出しの回数を報告させる。親は完了通知の所要時間とトークン数を結果の報告に添える。
- レビューは「設計書と関係する既存ファイルだけを読む。外部文書は取らない。10 分程度」の形にする（2026-10-02 の 4 本はこの形で 5〜9 分、9〜11 万トークンで終わった）。

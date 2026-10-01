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

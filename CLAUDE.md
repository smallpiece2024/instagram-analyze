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

## タスク管理と git（beads）

課題は beads（`bd`）で管理する（2026-10-31 導入）。下の Beads の区画（`bd init` が生成）と食い違うところは、この節が優先する。

- **課題**: 作業を始める前に `bd ready` を見て、対象を `bd update <id> --claim` する。無ければ `bd create` で作ってから始める。途中で分かった後回しの作業も `bd create` で残す。終わったら `bd close <id> --reason="..."`。日付を待つものは `bd defer <id> --until=...`、ユーザーの判断待ちは説明にそう書く。
- **何を書くか**: 課題には「何を、なぜ、どこまでで完了か」を書く。経緯と決定の詳細は今までどおり `doc/progress.md` と設計書に書き、課題からは章番号で指す。課題は `.beads/issues.jsonl` として公開リポジトリに載るので、アカウントの ID、ユーザー名、メディア ID、秘密情報を書かない。
- **記憶**: `bd remember` は使わない。利用者の好みは Claude Code の自動メモリ、プロジェクトの事実は `doc/` に置く。
- **git は自律的に行う**（Beads の区画の「Conservative」の既定は使わない）: 作業はブランチで行い、区切りごとに `git add` と `git commit`（日本語のメッセージ）をする。まとまったら main へ `--no-ff` でマージして main を push する。push の前に `bd dolt push` で課題の DB も GitHub（`refs/dolt/data`）に送る。
- **文脈が消えても残るように**: `/clear`、`/compact`、新しいセッションでは SessionStart のフック（`.claude/settings.json`）が `bd prime` を流す。続きは `bd ready` と `bd list --status=in_progress` で拾う。作業の途中で区切るときは、課題に `bd note <id> "..."` で今の状態と次の 1 手を書いてからコミットする。


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

# 外部由来のサブエージェントの出所と許諾

`.claude/agents/` の 4 本は外部リポジトリ（MIT License）のエージェント定義を、このプロジェクト向けに改変したもの。各ファイルの先頭の HTML コメントに出所と改変の内容を書いている。許諾文の全文はこのディレクトリに置く。

取得日: 2026-10-01。取得時の main HEAD は wshobson/agents が `156b7a5e7a8b93642628a339ee4039c925b34c7f`、VoltAgent/awesome-claude-code-subagents が `82b73821baa7a911d5b14cfb6da238b7f0db6b42`。

| このリポジトリ内のファイル | 出所パス | コミット SHA | 改変の有無 |
|---|---|---|---|
| `.claude/agents/postgres-sql-reviewer.md` | wshobson/agents `plugins/database-design/agents/sql-pro.md` | `24df162978c42ed53b10c5327031d99e13118ef3` | あり |
| `.claude/agents/node-worker-developer.md` | VoltAgent/awesome-claude-code-subagents `categories/02-language-specialists/node-specialist.md` | `5f6bc7fb96a3741b9f6e6ac2a45b77250b4fc6dc` | あり |
| `.claude/agents/nextjs-developer.md` | wshobson/agents `plugins/multi-platform-apps/agents/frontend-developer.md` | `8df77ecd46ae10c3373e6a4b91b29859ef6b560d` | あり |
| `.claude/agents/dashboard-designer.md` | wshobson/agents `plugins/multi-platform-apps/agents/ui-ux-designer.md` | `56848874a27cf0812b20a067ff3cf4eb8e0a7858` | あり |
| `.claude/agents/LICENSES/wshobson-agents.MIT.txt` | wshobson/agents `LICENSE` | `51c85a89771ef6ae2d7e8996c66c953f741caff4` | なし（冒頭に出所の 3 行を追加） |
| `.claude/agents/LICENSES/VoltAgent-awesome-claude-code-subagents.MIT.txt` | VoltAgent/awesome-claude-code-subagents `LICENSE` | `03ca9feb124d11aef964eabc4fde2401b1206dad` | なし（冒頭に出所の 3 行を追加） |

Supabase 公式スキル（`supabase`、`supabase-postgres-best-practices`）はリポジトリにコピーせず、公式プラグイン（`supabase/agent-skills`）でユーザー設定に入れる。手順は README。

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

# 収集ワーカー（Node.js ＋ ffmpeg）
# ビルドコンテキストはリポジトリのルート（docker-compose.yml を参照）

# 依存関係（実行時に要るものだけ。postgres.js など）
FROM node:24-bookworm-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci --workspace worker --omit=dev --ignore-scripts

# ビルド（TypeScript → dist）
FROM node:24-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci --workspace worker --ignore-scripts
COPY apps/worker apps/worker
RUN npm run build --workspace worker

# 実行イメージ。root では動かさない（設計 r1-collection-jobs.md 2.2 章）
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/worker/package.json ./
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
# .local（ローカル出力のマウント先）を node ユーザーが書けるようにしておく
RUN mkdir -p /app/.local && chown node:node /app/.local
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "dist/index.js"]

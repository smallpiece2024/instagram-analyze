# 収集ワーカー（Node.js ＋ ffmpeg）
# ビルドコンテキストはリポジトリのルート（docker-compose.yml を参照）

FROM node:24-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci --workspace worker --ignore-scripts
COPY apps/worker apps/worker
RUN npm run build --workspace worker

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/worker/package.json ./
COPY --from=build /repo/apps/worker/dist ./dist
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/index.js"]

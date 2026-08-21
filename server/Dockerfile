# かけはしノート AIリレーサーバ (Cloud Run用)
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# 依存を先に入れてレイヤキャッシュを効かせる
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY ai-relay.mjs ./

# root で動かさない
USER node

# Cloud Run は PORT 環境変数を注入する(既定 8080)。ai-relay.mjs が PORT を読む
EXPOSE 8080
CMD ["node", "ai-relay.mjs"]

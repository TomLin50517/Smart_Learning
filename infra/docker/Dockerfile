# syntax=docker/dockerfile:1
# =============================================================================
# api 與 worker 共用同一個 image，不同 entrypoint（SA §3.3、ADR-002）
#   api:     node apps/api/dist/main.js      （預設）
#   worker:  node apps/worker/dist/main.js
#   migrate: node tools/migrate.ts            （Node 24 原生剝除型別）
# 建置：docker build -f infra/docker/Dockerfile -t iac-app .
# =============================================================================

FROM node:24-alpine AS build
WORKDIR /app

# 先只複製 manifest，讓依賴層可被快取
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json    packages/domain/
COPY apps/api/package.json           apps/api/
COPY apps/worker/package.json        apps/worker/
# web 不在此 image 內建置（見 Dockerfile.web），但 workspace manifest 須齊全，npm ci 才與 lock 一致
COPY apps/web/package.json           apps/web/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN npx tsc -b && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S iac && adduser -S iac -G iac

COPY --from=build --chown=iac:iac /app/package.json ./
COPY --from=build --chown=iac:iac /app/node_modules node_modules
COPY --from=build --chown=iac:iac /app/packages     packages
COPY --from=build --chown=iac:iac /app/apps         apps
COPY --chown=iac:iac migrations migrations
COPY --chown=iac:iac tools/migrate.ts tools/migrate.ts

USER iac
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

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
COPY --chown=iac:iac tools/backup.ts  tools/backup.ts
# 證書 PDF 的中文字型（Noto Sans TC，SIL OFL；見 assets/fonts/OFL.txt）
COPY --chown=iac:iac assets assets

USER iac
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

# =============================================================================
# worker（SD §6.30）：同一個 image，另裝掃描版 PDF 的 OCR 工具——
#   pdftoppm（poppler-utils）轉圖 + tesseract 辨識（繁中與英文語言包），約 +100 MiB。
#   api 用不到這些二進位，所以獨立成一個 target（與 backup 同模式；layer 共享，磁碟無額外成本）。
#   未裝這些工具時 worker 仍可執行——OCR_ENABLED 預設關閉，行為與加入 OCR 前一致。
#   docker build -f infra/docker/Dockerfile --target worker -t iac-worker .
# =============================================================================
FROM runtime AS worker
USER root
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-chi_tra tesseract-ocr-data-eng
USER iac
CMD ["node", "apps/worker/dist/main.js"]

# =============================================================================
# 備份代理（SD §6.28）：同一個 image，另裝 PostgreSQL client 以使用 pg_dump
#   docker build -f infra/docker/Dockerfile --target backup -t iac-backup .
# =============================================================================
FROM runtime AS backup
USER root
# /backups 由 compose 的具名 volume 掛載；先建好並交給 iac——volume 首次初始化會沿用
# image 中該目錄的擁有者，否則 Docker 以 root 建立，非 root 的 iac 寫不進去（EACCES）
RUN apk add --no-cache postgresql-client \
 && mkdir -p /backups && chown iac:iac /backups
USER iac
CMD ["node", "tools/backup.ts"]

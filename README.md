# Interactive AI Coach System

通用互動式教學平台 + 有證據鏈的 AI Learning Coach。
Modular Monolith（NestJS）+ Worker，PostgreSQL 為 system of record。

## 文件

| 文件 | 內容 |
|---|---|
| [Interactive_AI_Coach_System_Architecture_v1.0.md](Interactive_AI_Coach_System_Architecture_v1.0.md) | 架構基準（ARCH） |
| [docs/sa/](docs/sa/Interactive_AI_Coach_SA_v1.0.md) | 系統分析：Use Case、RBAC、序列圖、STRIDE、驗收條件 |
| [docs/sd/](docs/sd/Interactive_AI_Coach_SD_v1.0.md) | 系統設計：DDL、ES mapping、Guard、Prompt、Job |
| [docs/api/openapi.yaml](docs/api/openapi.yaml) | OpenAPI 3.1（與程式碼的一致性由測試強制） |

## 技術棧

Node 24 · TypeScript 6 · NestJS 12（ESM）· Fastify 5 · PostgreSQL 18 · Vitest 5（SWC）· Vite 8 + React 19 + react-router 8

## 結構

```text
apps/
  api/        NestJS HTTP API — 17 個模組（SA §4.1），Guard 鏈（INV-8）
  worker/     Job consumer — SKIP LOCKED 取件、backoff、DLQ
  web/        React SPA — 登入／密碼、組織與成員、系統授權（SD §7.1.3）
packages/
  contracts/  跨 app 共用型別、錯誤碼、權限碼（由 SA 產生）
  domain/     純領域規則，無 I/O（license capability…）
migrations/   0001–0016 SQL
tools/        migrate.ts、gen-permissions.ts、create-admin.ts、license-*（供應方專用）
tests/        contract/（INV-T4）、e2e/（testcontainers + 行程內 SMTP）、db/（95 項 DB 不變條件）
infra/        Dockerfile（api/worker）、Dockerfile.web（nginx + SPA）、docker-compose、nginx
```

## 常用指令

```bash
npm install
npm run gen:permissions   # SA §6.2 → packages/contracts/src/permissions.generated.ts
npm run build             # tsc -b（api / worker / packages）
npm run build:web         # Vite 建置 apps/web
npm run typecheck         # 全 repo，含測試、tools 與 web
npm test                  # unit + contract
npm run test:arch         # 模組邊界（dependency-cruiser）
npm run test:e2e          # Guard 鏈、認證、授權、組織、SMTP × 真實 PostgreSQL 18（需 Docker）
npm run test:db           # migration + 67 項 DB 不變條件（需 Docker）
```

## 本機執行

```bash
cp .env.example .env      # 填入密碼，並加上 PG_SUPERUSER_PASSWORD
docker compose --env-file .env -f infra/compose/docker-compose.yml up --build   # 在 repo 根目錄執行
```

網頁與 API 皆經 nginx：`http://127.0.0.1:8080/`（API 在 `/api/`）；PostgreSQL 綁 `127.0.0.1:55432`。
第一位平台管理員以 `npm run admin:create` 建立（密碼從環境變數讀取，見該檔說明）。

### 前端開發

```bash
npm run dev:web           # http://localhost:5173，/api 代理到 IAC_API_URL（預設 http://127.0.0.1:3000）
```

本機以純 HTTP 開發時，API 需設 `COOKIE_SECURE=false`（正式環境禁止）。

## 護欄（違反即 CI 失敗）

- **INV-8** 非 `@Public()` 路由必須宣告 `@RequirePermission` 或 `@AuthOnly()`，否則執行期預設拒絕
- **INV-T4** 已實作路由的權限／授權／audit 標註必須與 `openapi.yaml` 完全相同
- **INV-3** `ai-coach` 模組不得觸及成績／註冊／證書的實作；DB 角色 `app_coach` 對這些表只有 SELECT
- **INV-4** `packages/domain` 不得依賴任何 I/O
- 權限目錄只能改 SA §6.2，再執行 `gen:permissions`；CI 會檢查產生檔是否同步

## 開發備註

- 專案位於 OneDrive 同步資料夾，`node_modules` 會被同步；若 `npm install` 遇到 `EPERM`，暫停 OneDrive 同步後重試。
- Windows：`npm run test:db` 須從 **Git Bash** 執行。在 PowerShell／cmd 中，`bash` 會解析成 System32 的 WSL bash（通常沒有 docker），腳本會在建立容器時直接失敗。
- npm 11 預設不執行套件的 install script（`@swc/core`、`esbuild` 等）；其原生 binary 由平台 optional dependency 提供，目前不需核准。

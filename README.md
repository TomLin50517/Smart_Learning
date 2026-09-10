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

Node 24 · TypeScript 6 · NestJS 12（ESM）· Fastify 5 · PostgreSQL 18 · Vitest 5（SWC）

## 結構

```text
apps/
  api/        NestJS HTTP API — 17 個模組（SA §4.1），Guard 鏈（INV-8）
  worker/     Job consumer — SKIP LOCKED 取件、backoff、DLQ
packages/
  contracts/  跨 app 共用型別、錯誤碼、權限碼（由 SA 產生）
  domain/     純領域規則，無 I/O（license capability…）
migrations/   0001–0014 SQL
tools/        migrate.ts、gen-permissions.ts
tests/        contract/（INV-T4）、e2e/（testcontainers）、db/（59 項 DB 不變條件）
infra/        Dockerfile、docker-compose、nginx
```

## 常用指令

```bash
npm install
npm run gen:permissions   # SA §6.2 → packages/contracts/src/permissions.generated.ts
npm run build             # tsc -b
npm run typecheck         # 全 repo，含測試與 tools
npm test                  # unit + contract
npm run test:arch         # 模組邊界（dependency-cruiser）
npm run test:e2e          # Guard 鏈 × 真實 PostgreSQL 18（需 Docker）
npm run test:db           # migration + 59 項 DB 不變條件（需 Docker）
```

## 本機執行

```bash
cp .env.example .env      # 填入密碼，並加上 PG_SUPERUSER_PASSWORD
docker compose -f infra/compose/docker-compose.yml up --build
```

API 於 `http://127.0.0.1:8080/api/`（經 nginx）；PostgreSQL 綁 `127.0.0.1:55432`。

## 護欄（違反即 CI 失敗）

- **INV-8** 非 `@Public()` 路由必須宣告 `@RequirePermission` 或 `@AuthOnly()`，否則執行期預設拒絕
- **INV-T4** 已實作路由的權限／授權／audit 標註必須與 `openapi.yaml` 完全相同
- **INV-3** `ai-coach` 模組不得觸及成績／註冊／證書的實作；DB 角色 `app_coach` 對這些表只有 SELECT
- **INV-4** `packages/domain` 不得依賴任何 I/O
- 權限目錄只能改 SA §6.2，再執行 `gen:permissions`；CI 會檢查產生檔是否同步

## 開發備註

- 專案位於 OneDrive 同步資料夾，`node_modules` 會被同步；若 `npm install` 遇到 `EPERM`，暫停 OneDrive 同步後重試。
- npm 11 預設不執行套件的 install script（`@swc/core`、`esbuild` 等）；其原生 binary 由平台 optional dependency 提供，目前不需核准。

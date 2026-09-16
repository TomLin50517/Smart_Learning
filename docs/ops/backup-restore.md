# 備份與還原

對應 SA §16（Backup / Restore Runbook）、SD §6.28。備份是自動的；**還原一律由人手動執行**——沒有做成按鈕，避免誤按把正在服務的資料蓋掉。

## 備份怎麼進行

`infra/compose/docker-compose.yml` 的 `backup` 服務（與 api／worker 同一個 image，另裝 PostgreSQL client）：

| 項目 | 內容 |
|---|---|
| 時間 | 每天 `BACKUP_HOUR`（預設 3 點，主機時區）之後的第一次檢查；平台管理員也可在「系統狀態」頁按「立即備份」 |
| 資料庫 | `pg_dump --format=custom` → `/backups/db/iac-YYYYMMDD-HHMMSS.dump`（決定 RPO） |
| 物件儲存 | 增量同步到 `/backups/objects/{key}`（大小不同才重抓）——教材原檔、擷取文字、證書 PDF |
| 順序 | 先資料庫、後物件（SA §16.1：物件的時間點不可早於資料庫） |
| 保留 | 7 份每日 + 4 份每週（週日）+ 6 份每月（1 日），其餘自動刪除 |
| 紀錄 | 寫入 `backup_runs`，在「系統狀態」頁看得到；失敗會在該頁顯示紅色告警 |

備份檔在 `backups` 這個 Docker volume。**異地保存要另外安排**（例如每天把 volume 內容同步到其他主機或雲端儲存）——ARCH §26.2 要求至少一份異地副本。

主機路徑：

```bash
docker volume inspect iac_backups --format '{{ .Mountpoint }}'
```

不含在備份裡的東西：`.env`（含資料庫密碼、`SESSION_SECRET`、`AI_KEY_ENCRYPTION_KEY`）與授權檔。**這些請分開保管**：`AI_KEY_ENCRYPTION_KEY` 遺失時，資料庫裡各組織的 AI 金鑰就解不開了（ADR-034）。

## 手動備份一次

```bash
docker compose -f infra/compose/docker-compose.yml run --rm backup node tools/backup.ts --once
```

## 還原

先讀 SA §16.3 的完整步驟。最小流程：

```bash
# 1. 停止寫入
docker compose -f infra/compose/docker-compose.yml stop api worker backup

# 2. 保全現場（先備份目前的資料卷，出錯才有退路）
docker run --rm -v iac_pgdata:/from -v "$PWD":/to alpine tar czf /to/pgdata-before-restore.tgz -C /from .

# 3. 還原資料庫（DUMP 換成要還原的檔名）
docker compose -f infra/compose/docker-compose.yml exec -T postgres \
  pg_restore --clean --if-exists --no-owner -U postgres -d iac < /backups/db/DUMP

# 4. 還原物件儲存：把 /backups/objects 的內容放回物件儲存
#    （MinIO 可用 mc mirror；外部 S3 依該服務的工具）

# 5. 重新啟動並檢查
docker compose -f infra/compose/docker-compose.yml up -d
curl -s http://127.0.0.1:8080/api/system/ready
```

還原後請照 SA §16.4 做一致性檢查、§16.5 做 smoke test。Elasticsearch 不必還原——教材索引可以重建（教材原檔在物件儲存裡）。

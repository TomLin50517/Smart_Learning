# 啟用語意檢索（重建教材索引）

對應 SD §6.31。**只有在既有系統要從關鍵字檢索切換到語意檢索時才需要這份步驟**；全新安裝不必做任何事。

## 為什麼要重建

向量欄位（`dense_vector`）的維度在建立索引時就固定，**無法事後追加**。既有部署的 `knowledge_chunks_v1` 沒有這個欄位，而 mapping 是 `dynamic: strict`，寫入帶向量的文件會被 Elasticsearch 拒絕。

worker 偵測到這個情況時會讓索引工作失敗並附上這份文件的路徑，不會靜默地把教材索引成沒有向量的狀態。

## 事前確認

1. `.env` 已填入 `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`
2. `EMBEDDING_DIMENSIONS` 與模型相符（例如 `text-embedding-3-small` 為 1536）——**填錯會在寫入時就報錯，不會默默存進錯的向量**
3. 你的 gateway 允許這把金鑰呼叫 embedding 模型

## 步驟

```bash
# 1. 停止 worker，避免重建期間有新的索引工作
docker compose -f infra/compose/docker-compose.yml stop worker

# 2. 刪除舊索引（教材原文在物件儲存、chunk 位置在資料庫，這裡刪的只是搜尋索引）
docker compose -f infra/compose/docker-compose.yml exec elasticsearch \
  curl -s -u elastic:$ELASTIC_PASSWORD -X DELETE http://localhost:9200/knowledge_chunks_v1

# 3. 把已完成的教材標回待索引，worker 會重新處理
docker compose -f infra/compose/docker-compose.yml exec postgres psql -U postgres -d iac -c "
  UPDATE document_versions SET status = 'indexing' WHERE status = 'ready';
  UPDATE knowledge_chunk_manifest SET indexed_at = NULL;
  INSERT INTO job_queue (job_type, queue, max_attempts, payload, idempotency_key, organization_id)
  SELECT 'document.embed_index', 'ingest', 5, jsonb_build_object('documentVersionId', id, 'fromChunkIndex', 0),
         'reindex:' || id, organization_id
    FROM document_versions WHERE status = 'indexing'
   ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;"

# 4. 啟動 worker：它會建立含向量欄位的 knowledge_chunks_v2 並重新索引
docker compose -f infra/compose/docker-compose.yml up -d worker
```

## 確認結果

在「系統狀態」頁看「教材與搜尋」的處理中數量降回 0，或直接查：

```bash
docker compose -f infra/compose/docker-compose.yml exec elasticsearch \
  curl -s -u elastic:$ELASTIC_PASSWORD "http://localhost:9200/knowledge_chunks/_mapping" | grep -o '"embedding"'
```

## 注意

- 重建期間 AI 教練仍可運作，但引用不到尚未重新索引的教材
- 重新索引會**逐段呼叫 embedding 服務**，教材多時會產生可觀的呼叫量與費用；建議挑離峰時間
- 日後若要**更換 embedding 模型**（維度不同），必須重複這整個流程並把 `KNOWLEDGE_CHUNKS_INDEX` 的版本號往上加

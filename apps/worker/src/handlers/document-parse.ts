import { createHash } from 'node:crypto';
import { DOCUMENT_INDEX_JOB, DOCUMENT_PARSE_JOB, documentObjectKeys, type DocumentStatus } from '@iac/contracts';
import { chunkDocument, detectDocumentKind, DOCUMENT_KIND_MIME, PAGE_SEPARATOR } from '@iac/domain';
import type pg from 'pg';
import type { Job, JobHandler } from '../dispatcher.js';
import { extractPages, ExtractError } from '../extract.js';
import { FatalError } from '../retry-policy.js';
import type { ObjectStorage } from '../storage.js';

/** 前一次在這些狀態中斷時可以重做（冪等） */
const REDO = new Set<DocumentStatus>(['uploaded', 'scanning', 'parsing', 'chunking']);

interface Row {
  id: string;
  source_document_id: string;
  organization_id: string;
  status: DocumentStatus;
  original_filename: string;
  mime_type: string;
  object_key: string;
  storage_prefix: string;
}

/**
 * 教材解析（SA SEQ-06、§7.4；SD §6.17）：檢查格式 → 移出 quarantine → 擷取文字 → 切段 → 寫入 chunk manifest → 排入索引。
 * 內容問題（格式不符、壞檔、沒有文字）標為 rejected／failed 並附原因，不重試；儲存或資料庫錯誤才重試。
 * chunk 全文不存資料庫：擷取出的全文與各頁文字存在物件儲存，manifest 只記位置（char_start／char_end）。
 */
export class DocumentParseHandler implements JobHandler {
  readonly jobType = DOCUMENT_PARSE_JOB.type;
  readonly timeoutMs = 15 * 60_000;

  constructor(
    private readonly db: pg.Pool,
    private readonly storage: ObjectStorage,
  ) {}

  private async setStatus(id: string, status: DocumentStatus, extra: { reason?: string } = {}): Promise<void> {
    await this.db.query(
      `UPDATE document_versions SET status = $2::document_status, failure_reason = $3,
              processing_started_at = CASE WHEN $2::text = 'scanning' THEN now() ELSE processing_started_at END
        WHERE id = $1`,
      [id, status, extra.reason ?? null],
    );
  }

  private async fail(r: Row, status: 'failed' | 'rejected', reason: string, job: Job): Promise<void> {
    await this.setStatus(r.id, status, { reason });
    await this.db.query(
      `INSERT INTO audit_logs (actor_role, action, resource_type, resource_id, organization_id, outcome, metadata, correlation_id)
       VALUES ('system', 'knowledge.document.failed', 'document_version', $1, $2, 'error', $3::jsonb, $4)`,
      [r.id, r.organization_id, JSON.stringify({ status, reason, document_id: r.source_document_id, job_id: job.id }), job.correlation_id],
    );
  }

  async handle(job: Job): Promise<void> {
    const dvId = job.payload['documentVersionId'];
    if (typeof dvId !== 'string') throw new FatalError('document.parse: payload.documentVersionId is missing');
    const q = await this.db.query<Row>(
      `SELECT dv.id, dv.source_document_id, dv.organization_id, dv.status, dv.original_filename, dv.mime_type, dv.object_key, o.storage_prefix
         FROM document_versions dv JOIN organizations o ON o.id = dv.organization_id WHERE dv.id = $1`,
      [dvId],
    );
    const r = q.rows[0];
    if (!r) return; // 教材已被刪除
    if (!REDO.has(r.status)) return; // 已處理過

    await this.setStatus(r.id, 'scanning');
    const original = await this.storage.get(r.object_key);
    // 惡意程式掃描 hook 尚未接上（可插拔，SA SEQ-06）；目前以檔頭再次確認格式
    const kind = detectDocumentKind(original.subarray(0, 8192), r.original_filename);
    if (!kind || DOCUMENT_KIND_MIME[kind] !== r.mime_type) return this.fail(r, 'rejected', 'unsupported_type', job);

    const keys = documentObjectKeys({ prefix: r.storage_prefix, organizationId: r.organization_id, documentId: r.source_document_id, versionId: r.id });
    if (r.object_key !== keys.original) {
      await this.storage.copy(r.object_key, keys.original);
      await this.db.query(`UPDATE document_versions SET object_key = $2 WHERE id = $1`, [r.id, keys.original]);
      await this.storage.delete(r.object_key);
    }

    await this.setStatus(r.id, 'parsing');
    let pages;
    try {
      pages = await extractPages(kind, original);
    } catch (e) {
      if (e instanceof ExtractError) return this.fail(r, 'failed', e.reason, job);
      throw e;
    }

    await this.setStatus(r.id, 'chunking');
    const { text, chunks } = chunkDocument(pages, { markdown: kind === 'markdown' });
    await this.storage.put(keys.extracted, Buffer.from(text, 'utf8'), { contentType: 'text/plain; charset=utf-8' });
    if (kind === 'pdf') {
      for (const p of pages) await this.storage.put(keys.page(p.pageNo!), Buffer.from(p.text, 'utf8'), { contentType: 'text/plain; charset=utf-8' });
    }

    const rows = chunks.map((c) => {
      const content = text.slice(c.charStart, c.charEnd);
      return {
        chunk_id: `${r.id}:${c.index}`,
        chunk_index: c.index,
        page_no: c.pageNo,
        section_path: c.sectionPath,
        char_start: c.charStart,
        char_end: c.charEnd,
        token_count: Math.ceil(content.length / 2),
        content_hash: createHash('sha256').update(content).digest('hex'),
      };
    });
    const pageCount = kind === 'pdf' ? pages.length : null;
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      // 重試時 chunk_id 相同（同一檔案、同一切段規則）→ 覆寫；worker 沒有 DELETE 權限
      if (rows.length) {
        await c.query(
          `INSERT INTO knowledge_chunk_manifest (document_version_id, organization_id, chunk_id, chunk_index, page_no, section_path, char_start, char_end, token_count, content_hash)
           SELECT $1, $2, x.chunk_id, x.chunk_index, x.page_no, x.section_path, x.char_start, x.char_end, x.token_count, x.content_hash
             FROM jsonb_to_recordset($3::jsonb) AS x(chunk_id text, chunk_index int, page_no int, section_path text, char_start int, char_end int, token_count int, content_hash text)
           ON CONFLICT (chunk_id) DO UPDATE SET page_no = EXCLUDED.page_no, section_path = EXCLUDED.section_path, char_start = EXCLUDED.char_start,
                 char_end = EXCLUDED.char_end, token_count = EXCLUDED.token_count, content_hash = EXCLUDED.content_hash, indexed_at = NULL`,
          [r.id, r.organization_id, JSON.stringify(rows)],
        );
      }
      await c.query(`UPDATE document_versions SET status = 'indexing', page_count = $2, chunk_count = $3, failure_reason = NULL WHERE id = $1`, [r.id, pageCount, rows.length]);
      await c.query(
        `INSERT INTO job_queue (job_type, queue, max_attempts, payload, idempotency_key, organization_id, correlation_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [
          DOCUMENT_INDEX_JOB.type,
          DOCUMENT_INDEX_JOB.queue,
          DOCUMENT_INDEX_JOB.maxAttempts,
          JSON.stringify({ documentVersionId: r.id, fromChunkIndex: 0 }),
          `index:${r.id}:${createHash('sha256').update(rows.map((x) => x.content_hash).join()).digest('hex').slice(0, 12)}`,
          r.organization_id,
          job.correlation_id,
        ],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}

/** 頁分隔（測試用） */
export { PAGE_SEPARATOR };

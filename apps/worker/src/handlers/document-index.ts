import { DOCUMENT_INDEX_JOB, documentObjectKeys, type DocumentStatus } from '@iac/contracts';
import { KNOWLEDGE_CHUNKS_ALIAS, type ChunkIndexDocument } from '@iac/domain';
import type pg from 'pg';
import type { Job, JobHandler } from '../dispatcher.js';
import { embedAll, type EmbeddingClient } from '../embedding.js';
import { FatalError, RetryableError } from '../retry-policy.js';
import { describeFailure, ensureChunkIndex, type SearchClient } from '../search.js';
import type { ObjectStorage } from '../storage.js';

const BATCH = 500;

interface Row {
  id: string;
  source_document_id: string;
  organization_id: string;
  status: DocumentStatus;
  title: string;
  language: string;
  course_id: string | null;
  storage_prefix: string;
}

interface BulkResponse {
  errors?: boolean;
  items?: { index?: { status: number; error?: unknown } }[];
}

/**
 * 教材索引（SD §4.5、§6.18）：把 chunk 的文字（由 extracted.txt 依 manifest 位置取出）寫入 Elasticsearch，
 * `_id` = chunk_id（重跑不重複）；course_version_ids = 目前綁定這個版本的課程版本。完成後 ready，
 * 同一份教材較舊且 ready 的版本轉 superseded（其 chunk 保留——已發布的課程版本仍引用）。
 * 未設定 Elasticsearch：標為 failed（search_unavailable），設定好後可按「重試」。
 */
export class DocumentIndexHandler implements JobHandler {
  readonly jobType = DOCUMENT_INDEX_JOB.type;
  readonly timeoutMs = 10 * 60_000;

  constructor(
    private readonly db: pg.Pool,
    private readonly storage: ObjectStorage,
    private readonly es: SearchClient,
    private readonly embedding: EmbeddingClient,
  ) {}

  private async fail(r: Row, reason: string, job: Job): Promise<void> {
    await this.db.query(`UPDATE document_versions SET status = 'failed', failure_reason = $2 WHERE id = $1`, [r.id, reason]);
    await this.db.query(
      `INSERT INTO audit_logs (actor_role, action, resource_type, resource_id, organization_id, course_id, outcome, metadata, correlation_id)
       VALUES ('system', 'knowledge.document.failed', 'document_version', $1, $2, $3, 'error', $4::jsonb, $5)`,
      [r.id, r.organization_id, r.course_id, JSON.stringify({ status: 'failed', reason, document_id: r.source_document_id, job_id: job.id }), job.correlation_id],
    );
  }

  async handle(job: Job): Promise<void> {
    const dvId = job.payload['documentVersionId'];
    if (typeof dvId !== 'string') throw new FatalError('document.embed_index: payload.documentVersionId is missing');
    const q = await this.db.query<Row>(
      `SELECT dv.id, dv.source_document_id, dv.organization_id, dv.status, sd.title, sd.language, sd.course_id, o.storage_prefix
         FROM document_versions dv JOIN source_documents sd ON sd.id = dv.source_document_id JOIN organizations o ON o.id = dv.organization_id
        WHERE dv.id = $1`,
      [dvId],
    );
    const r = q.rows[0];
    if (!r || r.status !== 'indexing') return;
    if (!this.es.configured) return this.fail(r, 'search_unavailable', job);
    try {
      await this.index(r);
    } catch (e) {
      if (job.attempts >= job.max_attempts) await this.fail(r, 'index_failed', job);
      throw e;
    }
  }

  private async index(r: Row): Promise<void> {
    await ensureChunkIndex(this.es, this.embedding.enabled ? this.embedding.dimensions : null);
    const keys = documentObjectKeys({ prefix: r.storage_prefix, organizationId: r.organization_id, documentId: r.source_document_id, versionId: r.id });
    const text = (await this.storage.get(keys.extracted)).toString('utf8');
    const chunks = await this.db.query<{ chunk_id: string; chunk_index: number; page_no: number | null; section_path: string | null; char_start: number; char_end: number; token_count: number | null }>(
      `SELECT chunk_id, chunk_index, page_no, section_path, char_start, char_end, token_count FROM knowledge_chunk_manifest WHERE document_version_id = $1 ORDER BY chunk_index`,
      [r.id],
    );
    const cvs = await this.db.query<{ course_version_id: string }>(`SELECT course_version_id FROM knowledge_bindings WHERE document_version_id = $1`, [r.id]);
    const courseVersionIds = cvs.rows.map((x) => x.course_version_id);
    const now = new Date().toISOString();

    for (let i = 0; i < chunks.rows.length; i += BATCH) {
      const slice = chunks.rows.slice(i, i + BATCH);
      const contents = slice.map((c) => text.slice(c.char_start, c.char_end));
      // 向量與 contents 一一對應；對不齊會在 parseEmbeddingResponse 就丟錯，不會寫進索引
      const vectors = await embedAll(this.embedding, contents);
      const lines: string[] = [];
      slice.forEach((c, n) => {
        const doc: ChunkIndexDocument = {
          organization_id: r.organization_id,
          course_id: r.course_id,
          course_version_ids: courseVersionIds,
          source_document_id: r.source_document_id,
          document_version_id: r.id,
          chunk_id: c.chunk_id,
          chunk_index: c.chunk_index,
          knowledge_type: 'source',
          verification_status: 'source',
          acl_scope: r.course_id ? 'course' : 'organization',
          language: r.language,
          title: r.title,
          content: contents[n]!,
          page_no: c.page_no,
          section_path: c.section_path,
          char_start: c.char_start,
          char_end: c.char_end,
          token_count: c.token_count,
          indexed_at: now,
          ...(vectors.length > 0 && { embedding: vectors[n]! }),
        };
        lines.push(JSON.stringify({ index: { _index: KNOWLEDGE_CHUNKS_ALIAS, _id: c.chunk_id } }), JSON.stringify(doc));
      });
      const last = i + BATCH >= chunks.rows.length;
      const res = await this.es.request<BulkResponse>('POST', `/_bulk${last ? '?refresh=wait_for' : ''}`, lines.join('\n') + '\n', { ndjson: true });
      if (res.status >= 300 || res.body?.errors) {
        const first = res.body?.items?.find((it) => it.index?.error)?.index?.error;
        throw new RetryableError(`bulk index failed: ${first ? JSON.stringify(first).slice(0, 300) : describeFailure(res)}`);
      }
    }

    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE knowledge_chunk_manifest SET indexed_at = now() WHERE document_version_id = $1`, [r.id]);
      await c.query(`UPDATE document_versions SET status = 'ready', processed_at = now(), failure_reason = NULL WHERE id = $1 AND status = 'indexing'`, [r.id]);
      // SA §7.4 Ready → Superseded（新版可用時）
      await c.query(
        `UPDATE document_versions SET status = 'superseded'
          WHERE source_document_id = $1 AND status = 'ready'
            AND version_no < (SELECT version_no FROM document_versions WHERE id = $2)`,
        [r.source_document_id, r.id],
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

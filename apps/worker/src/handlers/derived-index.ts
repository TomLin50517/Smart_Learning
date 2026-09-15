import { DERIVED_INDEX_JOB, faqChunkId, type FaqKind } from '@iac/contracts';
import { faqIndexDocument, KNOWLEDGE_CHUNKS_ALIAS } from '@iac/domain';
import type pg from 'pg';
import type { Job, JobHandler } from '../dispatcher.js';
import { FatalError, RetryableError } from '../retry-policy.js';
import { describeFailure, ensureChunkIndex, type SearchClient } from '../search.js';

interface BulkItem {
  status: number;
  error?: unknown;
}
interface BulkResponse {
  errors?: boolean;
  items?: { index?: BulkItem; delete?: BulkItem }[];
}

/**
 * 課程 FAQ 的索引（SD §6.27，derived.index）：payload { courseId }。整門課重新整理——冪等、可重跑：
 * 已生效且有依據的項目寫入（_id = dk:{id}，course_version_ids = 這門課所有版本），其餘（下架等）從索引刪除。
 * 未設定 Elasticsearch：略過（FAQ 仍顯示給學員，只是 AI 教練找不到）。
 */
export class DerivedIndexHandler implements JobHandler {
  readonly jobType = DERIVED_INDEX_JOB.type;
  readonly timeoutMs = 60_000;

  constructor(
    private readonly db: pg.Pool,
    private readonly es: SearchClient,
  ) {}

  async handle(job: Job): Promise<void> {
    const courseId = job.payload['courseId'];
    if (typeof courseId !== 'string') throw new FatalError('derived.index: payload.courseId is missing');
    if (!this.es.configured) return;
    const co = await this.db.query<{ organization_id: string }>(`SELECT organization_id FROM courses WHERE id = $1`, [courseId]);
    if (!co.rows[0]) return;
    const faqs = await this.db.query<{ id: string; kind: FaqKind; status: string; evidence_status: string; version_id: string | null; question: string | null; answer: string | null }>(
      `SELECT dk.id, dk.kind, dk.status, dk.evidence_status, v.id AS version_id, v.question, v.answer
         FROM derived_knowledge dk JOIN course_versions cv ON cv.id = dk.course_version_id
         LEFT JOIN derived_knowledge_versions v ON v.id = dk.current_version_id
        WHERE cv.course_id = $1 AND dk.kind IN ('faq', 'common_error')`,
      [courseId],
    );
    if (!faqs.rows.length) return;
    const versions = (await this.db.query<{ id: string }>(`SELECT id FROM course_versions WHERE course_id = $1`, [courseId])).rows.map((r) => r.id);

    await ensureChunkIndex(this.es);
    const now = new Date().toISOString();
    const lines: string[] = [];
    for (const f of faqs.rows) {
      const id = faqChunkId(f.id);
      if (f.status === 'verified' && f.evidence_status === 'grounded' && f.version_id && f.question && f.answer) {
        const doc = faqIndexDocument(
          { id: f.id, versionId: f.version_id, organizationId: co.rows[0].organization_id, courseId, courseVersionIds: versions, kind: f.kind, question: f.question, answer: f.answer },
          now,
        );
        lines.push(JSON.stringify({ index: { _index: KNOWLEDGE_CHUNKS_ALIAS, _id: id } }), JSON.stringify(doc));
      } else {
        lines.push(JSON.stringify({ delete: { _index: KNOWLEDGE_CHUNKS_ALIAS, _id: id } }));
      }
    }
    const res = await this.es.request<BulkResponse>('POST', '/_bulk?refresh=wait_for', lines.join('\n') + '\n', { ndjson: true });
    if (res.status >= 300) throw new RetryableError(`faq bulk index failed: ${describeFailure(res)}`);
    // 刪除不存在的文件（從未索引過）回 404，不算失敗
    const failed = res.body?.items?.find((it) => (it.index && it.index.status >= 300) || (it.delete && it.delete.status >= 300 && it.delete.status !== 404));
    if (failed) throw new RetryableError(`faq bulk index failed: ${JSON.stringify(failed).slice(0, 300)}`);
  }
}

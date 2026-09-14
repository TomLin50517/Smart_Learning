import { DOCUMENT_SYNC_JOB } from '@iac/contracts';
import { KNOWLEDGE_CHUNKS_ALIAS } from '@iac/domain';
import type pg from 'pg';
import type { Job, JobHandler } from '../dispatcher.js';
import { FatalError, RetryableError } from '../retry-policy.js';
import { describeFailure, type SearchClient } from '../search.js';

/**
 * 讓索引反映資料庫（SD §4.5、§6.18）：課程版本的教材綁定改變（加入、移出、複製版本、上傳新版、刪除）後，
 * 以資料庫為準重算該教材版本 chunk 的 course_version_ids；教材版本已刪除則從索引刪掉。
 * 每次都重算整份清單，所以重複執行或順序顛倒都不會出錯。仍在建立索引中 → 稍後重試（避免覆寫尚未寫完的 chunk）。
 */
export class DocumentSyncHandler implements JobHandler {
  readonly jobType = DOCUMENT_SYNC_JOB.type;
  readonly timeoutMs = 2 * 60_000;

  constructor(
    private readonly db: pg.Pool,
    private readonly es: SearchClient,
  ) {}

  async handle(job: Job): Promise<void> {
    const ids = job.payload['documentVersionIds'];
    if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === 'string')) throw new FatalError('document.sync_bindings: payload.documentVersionIds is missing');
    if (!this.es.configured) return;
    for (const id of ids) {
      const byVersion = { term: { document_version_id: id } };
      const dv = await this.db.query<{ status: string }>(`SELECT status FROM document_versions WHERE id = $1`, [id]);
      const status = dv.rows[0]?.status;
      if (!status) {
        const res = await this.es.request('POST', `/${KNOWLEDGE_CHUNKS_ALIAS}/_delete_by_query?refresh=true&conflicts=proceed`, { query: byVersion });
        if (res.status >= 300 && res.status !== 404) throw new RetryableError(`delete_by_query failed: ${describeFailure(res)}`);
        continue;
      }
      if (status === 'indexing') throw new RetryableError('document version is still being indexed');
      // 尚未索引（上傳、解析中、失敗）：索引時才會讀綁定，不需同步
      if (status !== 'ready' && status !== 'superseded') continue;
      const cvs = await this.db.query<{ course_version_id: string }>(`SELECT course_version_id FROM knowledge_bindings WHERE document_version_id = $1 ORDER BY course_version_id`, [id]);
      const res = await this.es.request('POST', `/${KNOWLEDGE_CHUNKS_ALIAS}/_update_by_query?refresh=true&conflicts=proceed`, {
        query: byVersion,
        script: { lang: 'painless', source: 'ctx._source.course_version_ids = params.ids', params: { ids: cvs.rows.map((x) => x.course_version_id) } },
      });
      if (res.status >= 300 && res.status !== 404) throw new RetryableError(`update_by_query failed: ${describeFailure(res)}`);
    }
  }
}

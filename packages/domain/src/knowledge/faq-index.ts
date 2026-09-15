import { faqChunkId, type FaqKind } from '@iac/contracts';
import type { ChunkIndexDocument } from './search.js';

/**
 * FAQ／常見錯誤在檢索索引中的文件（SD §6.27）：與教材 chunk 共用 knowledge_chunks，
 * knowledge_type = faq／common_error、verification_status = verified（權重 1.3，SA §15.3）。
 * course_version_ids 為這門課所有的版本——FAQ 屬於課程，不綁特定版本。
 */
export function faqIndexDocument(
  f: {
    id: string;
    versionId: string;
    organizationId: string;
    courseId: string;
    courseVersionIds: readonly string[];
    kind: FaqKind;
    question: string;
    answer: string;
    language?: string;
  },
  indexedAt: string,
): ChunkIndexDocument {
  const content = `${f.question}\n${f.answer}`;
  return {
    organization_id: f.organizationId,
    course_id: f.courseId,
    course_version_ids: [...f.courseVersionIds],
    source_document_id: f.id,
    document_version_id: f.versionId,
    chunk_id: faqChunkId(f.id),
    chunk_index: 0,
    knowledge_type: f.kind,
    verification_status: 'verified',
    acl_scope: 'course',
    language: f.language ?? 'zh-TW',
    title: f.question,
    content,
    page_no: null,
    section_path: null,
    char_start: 0,
    char_end: content.length,
    token_count: null,
    indexed_at: indexedAt,
  };
}

/** 教材知識庫（SA UC-KNW、SEQ-06；SD §6.17） */

export const DOCUMENT_STATUSES = ['uploaded', 'scanning', 'rejected', 'parsing', 'chunking', 'indexing', 'ready', 'failed', 'superseded', 'retired'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
/** 處理中（前端輪詢） */
export const DOCUMENT_PROCESSING_STATUSES: readonly DocumentStatus[] = ['uploaded', 'scanning', 'parsing', 'chunking', 'indexing'];
/** 已擷取出文字（可預覽） */
export const DOCUMENT_TEXT_STATUSES: readonly DocumentStatus[] = ['indexing', 'ready', 'superseded', 'retired'];

/** 可上傳的格式（前端 accept） */
export const DOCUMENT_ACCEPT = '.pdf,.docx,.md,.markdown,.txt';

/** 背景工作（SD §11.1） */
export const DOCUMENT_PARSE_JOB = { type: 'document.parse', queue: 'ingest', maxAttempts: 3 } as const;
export const DOCUMENT_INDEX_JOB = { type: 'document.embed_index', queue: 'ingest', maxAttempts: 5 } as const;
/** 綁定改變後讓索引的 course_version_ids 反映資料庫（SD §6.18） */
export const DOCUMENT_SYNC_JOB = { type: 'document.sync_bindings', queue: 'ingest', maxAttempts: 5 } as const;

/** 物件儲存的 key（SD §5.1）：不含原始檔名或任何使用者可控字串 */
export function documentObjectKeys(p: { prefix: string; organizationId: string; documentId: string; versionId: string }) {
  const tail = `${p.organizationId}/${p.documentId}/${p.versionId}`;
  return {
    quarantine: `${p.prefix}/quarantine/${tail}/original.bin`,
    original: `${p.prefix}/documents/${tail}/original.bin`,
    extracted: `${p.prefix}/documents/${tail}/extracted.txt`,
    page: (n: number) => `${p.prefix}/documents/${tail}/pages/${n}.txt`,
    /** 刪除整份教材時用 */
    documentPrefix: `${p.prefix}/documents/${p.organizationId}/${p.documentId}/`,
    quarantinePrefix: `${p.prefix}/quarantine/${p.organizationId}/${p.documentId}/`,
  };
}

export interface DocumentVersionDto {
  id: string;
  documentId: string;
  versionNo: number;
  status: DocumentStatus;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  chunkCount: number | null;
  /** 失敗或拒收的原因代碼（unsupported_type、no_text、parse_failed、too_many_pages、too_much_text） */
  failureReason: string | null;
  uploadedAt: string;
  processedAt: string | null;
}

/** 綁定在課程版本上的一份教材 */
export interface BoundDocumentDto {
  documentId: string;
  title: string;
  bindingType: string;
  /** 此課程版本引用的版本 */
  boundVersion: DocumentVersionDto;
  /** 這份教材最新上傳的版本（可能比 boundVersion 新） */
  latestVersion: DocumentVersionDto;
}

/** GET /course-versions/{id}/knowledge */
export interface CourseKnowledgeDto {
  /** 版本為草稿：可上傳、加入、移出 */
  editable: boolean;
  bound: BoundDocumentDto[];
  /** 本課程其他版本用過、但沒有綁在這個版本的教材 */
  available: { documentId: string; title: string; latestVersion: DocumentVersionDto }[];
}

/** POST /course-versions/{id}/knowledge/search：課程人員測試檢索（與 AI 教練用同一個檢索器與範圍） */
export interface KnowledgeSearchHitDto {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  title: string;
  pageNo: number | null;
  sectionPath: string | null;
  content: string;
  /** 加權後的分數（只用來比較同一次搜尋的結果） */
  score: number;
}

export interface KnowledgeSearchResultDto {
  hits: KnowledgeSearchHitDto[];
  /** 此版本綁定、已可檢索的教材數；尚在處理中的教材不會出現在結果中 */
  searchableDocuments: number;
  pendingDocuments: number;
}

/** GET /knowledge/documents/{id}/versions/{versionId}/view：課程人員預覽擷取出的文字 */
export interface DocumentViewDto {
  documentId: string;
  documentVersionId: string;
  title: string;
  versionNo: number;
  status: DocumentStatus;
  pageCount: number | null;
  /** 目前顯示的頁；沒有頁的格式為 null（顯示全文） */
  page: number | null;
  text: string;
  /** 超過顯示上限而截斷 */
  truncated: boolean;
}

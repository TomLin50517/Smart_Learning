/**
 * 教材檢索（SD §4）：Elasticsearch 的 index 定義、查詢產生與排序。純函式——api 的 Retriever 與 worker 的索引共用。
 * 目前為 lexical_only（BM25 + cjk_bigram，SD §4.6）；語意檢索（semantic_text）之後以設定切換，不改介面。
 */

/** 程式碼只用 alias（SD §4.1）；具體 index 名稱只在建立時出現 */
export const KNOWLEDGE_CHUNKS_ALIAS = 'knowledge_chunks';
export const KNOWLEDGE_CHUNKS_INDEX = 'knowledge_chunks_v1';

export type KnowledgeType = 'source' | 'faq' | 'common_error' | 'platform';
export type VerificationStatus = 'source' | 'verified' | 'auto_generated' | 'teacher_edited';
export type AclScope = 'course' | 'organization' | 'platform';

const keyword = { type: 'keyword' } as const;
const integer = { type: 'integer' } as const;

/**
 * SD §4.2 的 mapping，去掉 semantic_text（lexical_only）。
 * 分析器：standard 會把中日韓文字切成單字，cjk_bigram 再組成相鄰兩字——不需安裝中文分詞外掛；
 * cjk_width 放最前面，先把全形英數轉半形再組字。
 */
export const KNOWLEDGE_CHUNKS_INDEX_BODY = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    refresh_interval: '5s',
    analysis: {
      analyzer: {
        generic_text: { type: 'custom', tokenizer: 'standard', filter: ['cjk_width', 'lowercase', 'asciifolding', 'cjk_bigram'] },
      },
    },
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      organization_id: keyword,
      course_id: keyword,
      course_version_ids: keyword,
      source_document_id: keyword,
      document_version_id: keyword,
      chunk_id: keyword,
      chunk_index: integer,
      knowledge_type: keyword,
      verification_status: keyword,
      acl_scope: keyword,
      language: keyword,
      title: { type: 'text', analyzer: 'generic_text' },
      content: { type: 'text', analyzer: 'generic_text' },
      page_no: integer,
      section_path: { type: 'text', analyzer: 'generic_text', fields: { kw: { type: 'keyword' } } },
      char_start: integer,
      char_end: integer,
      token_count: integer,
      indexed_at: { type: 'date' },
    },
  },
} as const;

/** 索引中的一段教材（ES `_id` = chunk_id，重跑不會重複） */
export interface ChunkIndexDocument {
  organization_id: string;
  course_id: string | null;
  course_version_ids: string[];
  source_document_id: string;
  document_version_id: string;
  chunk_id: string;
  chunk_index: number;
  knowledge_type: KnowledgeType;
  verification_status: VerificationStatus;
  acl_scope: AclScope;
  language: string;
  title: string;
  content: string;
  page_no: number | null;
  section_path: string | null;
  char_start: number;
  char_end: number;
  token_count: number | null;
  indexed_at: string;
}

export interface RetrieveParams {
  queryText: string;
  /** 1～20，預設 8 */
  topK?: number;
  /** 由教練設定 allowed_knowledge_scopes 決定 */
  knowledgeTypes?: readonly KnowledgeType[];
}

/** 由伺服器從 session 與課程版本產生，呼叫端（HTTP body）不能指定（SD §4.4.1、INV-7） */
export interface RetrieveScope {
  organizationId: string;
  courseVersionIds: readonly string[];
  allowedVerificationStatuses: readonly VerificationStatus[];
  aclScopes: readonly AclScope[];
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  title: string;
  content: string;
  pageNo: number | null;
  sectionPath: string | null;
  charStart: number;
  charEnd: number;
  knowledgeType: KnowledgeType;
  verificationStatus: VerificationStatus;
  aclScope: AclScope;
  rawScore: number;
  weightedScore: number;
}

export const MAX_QUERY_CHARS = 1000;
export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 20;
/** 先多取一些再依權重排序（SD §4.4.2 size） */
const FETCH_SIZE = 20;

export const clampTopK = (k: number | undefined): number => Math.min(MAX_TOP_K, Math.max(1, Math.trunc(k ?? DEFAULT_TOP_K) || DEFAULT_TOP_K));

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** 四個一定存在的 filter（SA INV-T6）：組織、課程版本、驗證狀態、可見範圍 */
export function scopeFilters(scope: RetrieveScope): readonly Record<string, unknown>[] {
  return deepFreeze([
    { term: { organization_id: scope.organizationId } },
    { terms: { course_version_ids: [...scope.courseVersionIds] } },
    { terms: { verification_status: [...scope.allowedVerificationStatuses] } },
    { terms: { acl_scope: [...scope.aclScopes] } },
  ]);
}

const SOURCE_FIELDS = [
  'chunk_id',
  'source_document_id',
  'document_version_id',
  'title',
  'content',
  'page_no',
  'section_path',
  'char_start',
  'char_end',
  'knowledge_type',
  'verification_status',
  'acl_scope',
] as const;

/**
 * 產生查詢。沒有接受 query DSL 的入口；範圍 filter 最後才附加且整個查詢凍結，任何參數都拿不掉它們。
 * 問題為空、或範圍任一項為空（例如課程版本沒有綁教材）時回 null——不查詢。
 */
export function buildRetrieveQuery(params: RetrieveParams, scope: RetrieveScope): Readonly<Record<string, unknown>> | null {
  const text = params.queryText.trim().slice(0, MAX_QUERY_CHARS);
  if (!text || !scope.organizationId || !scope.courseVersionIds.length || !scope.allowedVerificationStatuses.length || !scope.aclScopes.length) return null;
  const optional = params.knowledgeTypes?.length ? [{ terms: { knowledge_type: [...params.knowledgeTypes] } }] : [];
  return deepFreeze({
    size: FETCH_SIZE,
    _source: [...SOURCE_FIELDS],
    query: {
      bool: {
        must: [{ multi_match: { query: text, fields: ['content^3', 'section_path', 'title'] } }],
        filter: [...optional, ...scopeFilters(scope)],
      },
    },
  });
}

/** SD §4.4.3 的權重（之後可移到 system_settings retrieval.weights） */
export function weightOf(c: { knowledgeType: KnowledgeType; verificationStatus: VerificationStatus; aclScope: AclScope }): number {
  if ((c.knowledgeType === 'faq' || c.knowledgeType === 'common_error') && c.verificationStatus === 'verified') return 1.3;
  if (c.knowledgeType === 'source') return 1.0;
  if (c.verificationStatus === 'auto_generated' || c.verificationStatus === 'teacher_edited') return 0.7;
  return 0.5;
}

/** Elasticsearch 回傳的一筆結果 */
export interface SearchHit {
  _id: string;
  _score: number | null;
  _source: Partial<ChunkIndexDocument>;
}

export function toRetrievedChunk(h: SearchHit): RetrievedChunk {
  const s = h._source;
  const c = {
    chunkId: s.chunk_id ?? h._id,
    documentId: s.source_document_id ?? '',
    documentVersionId: s.document_version_id ?? '',
    title: s.title ?? '',
    content: s.content ?? '',
    pageNo: s.page_no ?? null,
    sectionPath: s.section_path ?? null,
    charStart: s.char_start ?? 0,
    charEnd: s.char_end ?? 0,
    knowledgeType: s.knowledge_type ?? 'source',
    verificationStatus: s.verification_status ?? 'source',
    aclScope: s.acl_scope ?? 'course',
    rawScore: h._score ?? 0,
  };
  return { ...c, weightedScore: c.rawScore * weightOf(c) };
}

/** 依加權分數排序取前 K 筆 */
export function rankHits(hits: readonly SearchHit[], topK?: number): RetrievedChunk[] {
  return hits
    .map(toRetrievedChunk)
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, clampTopK(topK));
}

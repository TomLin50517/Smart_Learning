import { describe, expect, it } from 'vitest';
import {
  buildKnnQuery,
  buildRetrieveQuery,
  chunkIndexBody,
  clampTopK,
  fuseRankings,
  KNOWLEDGE_CHUNKS_INDEX_BODY,
  MAX_QUERY_CHARS,
  rankHits,
  type KnowledgeType,
  type RetrieveParams,
  type RetrieveScope,
  type SearchHit,
  type VerificationStatus,
} from './search.js';

const scope: RetrieveScope = { organizationId: 'org-1', courseVersionIds: ['cv-1', 'cv-2'], allowedVerificationStatuses: ['source', 'verified'], aclScopes: ['course'] };
const REQUIRED = [
  { term: { organization_id: 'org-1' } },
  { terms: { course_version_ids: ['cv-1', 'cv-2'] } },
  { terms: { verification_status: ['source', 'verified'] } },
  { terms: { acl_scope: ['course'] } },
];

type Q = { query: { bool: { filter: unknown[] } }; size: number };

describe('buildRetrieveQuery — the four scope filters are always present (SA INV-T6)', () => {
  const variants: RetrieveParams[] = [
    { queryText: '發酵溫度' },
    { queryText: '  發酵  ', topK: 50 },
    { queryText: 'x', topK: -3, knowledgeTypes: ['source'] },
    { queryText: 'x', knowledgeTypes: ['faq', 'common_error', 'platform'] },
    { queryText: 'a'.repeat(5000), knowledgeTypes: [] },
  ];

  it.each(variants)('%#', (params) => {
    const q = buildRetrieveQuery(params, scope) as unknown as Q;
    const filter = q.query.bool.filter;
    expect(filter.slice(-4)).toEqual(REQUIRED);
    // 凍結：之後的程式碼無法移除或改寫 filter
    expect(Object.isFrozen(filter)).toBe(true);
    expect(() => filter.pop()).toThrow();
    expect(() => {
      (filter[filter.length - 4] as { term: { organization_id: string } }).term.organization_id = 'other';
    }).toThrow();
    expect(q.size).toBe(20);
  });

  it('adds the knowledge-type filter only when one is requested', () => {
    expect((buildRetrieveQuery({ queryText: 'x' }, scope) as unknown as Q).query.bool.filter).toHaveLength(4);
    const q = buildRetrieveQuery({ queryText: 'x', knowledgeTypes: ['source'] }, scope) as unknown as Q;
    expect(q.query.bool.filter[0]).toEqual({ terms: { knowledge_type: ['source'] } });
  });

  it('caps the query text', () => {
    const q = buildRetrieveQuery({ queryText: 'a'.repeat(5000) }, scope) as unknown as { query: { bool: { must: [{ multi_match: { query: string } }] } } };
    expect(q.query.bool.must[0].multi_match.query).toHaveLength(MAX_QUERY_CHARS);
  });

  it('does not search at all for an empty question or an empty scope', () => {
    expect(buildRetrieveQuery({ queryText: '   ' }, scope)).toBeNull();
    expect(buildRetrieveQuery({ queryText: 'x' }, { ...scope, courseVersionIds: [] })).toBeNull();
    expect(buildRetrieveQuery({ queryText: 'x' }, { ...scope, organizationId: '' })).toBeNull();
    expect(buildRetrieveQuery({ queryText: 'x' }, { ...scope, aclScopes: [] })).toBeNull();
    expect(buildRetrieveQuery({ queryText: 'x' }, { ...scope, allowedVerificationStatuses: [] })).toBeNull();
  });
});

describe('rankHits — weighted by knowledge type (SD §4.4.3)', () => {
  const hit = (id: string, score: number, knowledge_type: string, verification_status: string) => ({
    _id: id,
    _score: score,
    _source: { chunk_id: id, knowledge_type, verification_status, acl_scope: 'course' } as never,
  });

  it('verified FAQ outranks source, which outranks unverified derived knowledge', () => {
    const r = rankHits([hit('derived', 10, 'faq', 'auto_generated'), hit('src', 9, 'source', 'source'), hit('faq', 8, 'faq', 'verified')]);
    expect(r.map((c) => [c.chunkId, c.weightedScore])).toEqual([
      ['faq', 8 * 1.3],
      ['src', 9],
      ['derived', 7],
    ]);
  });

  it('returns at most top-K (1..20, default 8)', () => {
    const many = Array.from({ length: 20 }, (_, i) => hit(`c${i}`, i, 'source', 'source'));
    expect(rankHits(many)).toHaveLength(8);
    expect(rankHits(many, 3).map((c) => c.chunkId)).toEqual(['c19', 'c18', 'c17']);
    expect(clampTopK(0)).toBe(8);
    expect(clampTopK(-5)).toBe(1);
    expect(clampTopK(100)).toBe(20);
  });
});

describe('index definition', () => {
  it('rejects unknown fields and splits CJK text into bigrams without a plugin', () => {
    expect(KNOWLEDGE_CHUNKS_INDEX_BODY.mappings.dynamic).toBe('strict');
    expect(KNOWLEDGE_CHUNKS_INDEX_BODY.settings.analysis.analyzer.generic_text.filter).toContain('cjk_bigram');
    expect(KNOWLEDGE_CHUNKS_INDEX_BODY.mappings.properties.content.analyzer).toBe('generic_text');
  });
});

describe('buildKnnQuery — 語意檢索同樣受四道範圍限制（SA INV-T6）', () => {
  const params: RetrieveParams = { queryText: '發酵溫度' };
  type K = { knn: { field: string; query_vector: number[]; filter: unknown[] } };

  it('carries the same four scope filters as the lexical query', () => {
    const q = buildKnnQuery([0.1, 0.2, 0.3], params, scope) as unknown as K;
    expect(q.knn.field).toBe('embedding');
    expect(q.knn.query_vector).toEqual([0.1, 0.2, 0.3]);
    expect(q.knn.filter.slice(-4)).toEqual(REQUIRED);
    expect(Object.isFrozen(q.knn.filter)).toBe(true);
  });

  it('keeps the optional knowledge-type filter ahead of the required ones', () => {
    const q = buildKnnQuery([0.1], { queryText: 'x', knowledgeTypes: ['faq'] }, scope) as unknown as K;
    expect(q.knn.filter[0]).toEqual({ terms: { knowledge_type: ['faq'] } });
    expect(q.knn.filter.slice(-4)).toEqual(REQUIRED);
  });

  it('returns null rather than an unfiltered vector query when anything is missing', () => {
    // 寧可不查，也不能送出少了範圍限制的查詢
    expect(buildKnnQuery([], params, scope)).toBeNull();
    expect(buildKnnQuery([0.1], params, { ...scope, organizationId: '' })).toBeNull();
    expect(buildKnnQuery([0.1], params, { ...scope, courseVersionIds: [] })).toBeNull();
    expect(buildKnnQuery([0.1], params, { ...scope, allowedVerificationStatuses: [] })).toBeNull();
    expect(buildKnnQuery([0.1], params, { ...scope, aclScopes: [] })).toBeNull();
  });
});

describe('fuseRankings — RRF（ES 內建的 RRF 需要 Enterprise 授權，因此自行合併）', () => {
  const h = (id: string, type: KnowledgeType = 'source', status: VerificationStatus = 'source'): SearchHit => ({
    _id: id,
    _score: 1,
    _source: { chunk_id: id, knowledge_type: type, verification_status: status, acl_scope: 'course', content: id },
  });

  it('ranks a chunk found by both searches above ones found by only one', () => {
    const out = fuseRankings([[h('a'), h('b')], [h('c'), h('a')]]);
    expect(out[0]!.chunkId).toBe('a');
  });

  it('deduplicates by chunk id', () => {
    expect(fuseRankings([[h('a'), h('b')], [h('a')]]).map((c) => c.chunkId).sort()).toEqual(['a', 'b']);
  });

  it('still applies the knowledge-type weighting', () => {
    // 同名次時 verified FAQ（×1.3）要排在 source（×1.0）之前
    expect(fuseRankings([[h('src'), h('faq', 'faq', 'verified')]]).map((c) => c.chunkId)).toEqual(['faq', 'src']);
  });

  it('respects top-K', () => {
    const many = Array.from({ length: 30 }, (_, i) => h(`c${i}`));
    expect(fuseRankings([many])).toHaveLength(8);
    expect(fuseRankings([many], 3)).toHaveLength(3);
  });

  it('handles empty inputs', () => {
    expect(fuseRankings([])).toEqual([]);
    expect(fuseRankings([[], []])).toEqual([]);
  });
});

describe('chunkIndexBody — 向量欄位', () => {
  const props = (dims: number | null) => (chunkIndexBody(dims) as { mappings: { properties: Record<string, unknown> } }).mappings.properties;

  it('omits the vector field when embeddings are off (與 v1 相同)', () => {
    expect(props(null)['embedding']).toBeUndefined();
    expect(props(null)['content']).toBeDefined();
  });

  it('adds a dense_vector with the configured dimensions', () => {
    expect(props(1536)['embedding']).toEqual({ type: 'dense_vector', dims: 1536, index: true, similarity: 'cosine' });
    expect(props(768)['embedding']).toMatchObject({ dims: 768 });
  });

  it('does not mutate the shared index body', () => {
    chunkIndexBody(1536);
    expect((KNOWLEDGE_CHUNKS_INDEX_BODY.mappings.properties as Record<string, unknown>)['embedding']).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { buildEmbeddingRequest, MAX_EMBEDDING_CHARS, parseEmbeddingResponse } from './embedding.js';

describe('buildEmbeddingRequest', () => {
  it('normalises whitespace and keeps the input order', () => {
    expect(buildEmbeddingRequest('m', ['發酵  溫度\n26 度', ' second '])).toEqual({ model: 'm', input: ['發酵 溫度 26 度', 'second'] });
  });

  it('keeps empty strings so input and output stay aligned', () => {
    // 過濾空字串會讓後面的向量全部錯位
    expect(buildEmbeddingRequest('m', ['a', '   ', 'b']).input).toEqual(['a', '', 'b']);
  });

  it('truncates very long text', () => {
    const [only] = buildEmbeddingRequest('m', ['x'.repeat(MAX_EMBEDDING_CHARS + 500)]).input;
    expect(only).toHaveLength(MAX_EMBEDDING_CHARS);
  });
});

describe('parseEmbeddingResponse', () => {
  const ok = { data: [{ embedding: [1, 2], index: 0 }, { embedding: [3, 4], index: 1 }] };

  it('returns the vectors in input order', () => {
    expect(parseEmbeddingResponse(ok, 2, 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('reorders by index when the service returns them out of order', () => {
    const shuffled = { data: [{ embedding: [3, 4], index: 1 }, { embedding: [1, 2], index: 0 }] };
    expect(parseEmbeddingResponse(shuffled, 2, 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('falls back to positional order when index is absent', () => {
    expect(parseEmbeddingResponse({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }, 2, 2)).toEqual([[1, 2], [3, 4]]);
  });

  // 以下每一種都必須丟錯：照樣寫入會讓 chunk 配到別人的向量，而且完全靜默
  it('rejects a count mismatch', () => {
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [1, 2], index: 0 }] }, 2, 2)).toThrow(/count mismatch/);
    expect(() => parseEmbeddingResponse({}, 1, 2)).toThrow(/count mismatch/);
  });

  it('rejects a wrong number of dimensions', () => {
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [1, 2, 3], index: 0 }] }, 1, 2)).toThrow(/dimensions/);
  });

  it('rejects duplicate or out-of-range indexes', () => {
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [1, 2], index: 0 }, { embedding: [3, 4], index: 0 }] }, 2, 2)).toThrow(/twice/);
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [1, 2], index: 5 }] }, 1, 2)).toThrow(/out of range/);
  });

  it('rejects non-numeric or missing vectors', () => {
    expect(() => parseEmbeddingResponse({ data: [{ embedding: ['a', 'b'], index: 0 }] }, 1, 2)).toThrow(/non-finite/);
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [1, Number.NaN], index: 0 }] }, 1, 2)).toThrow(/non-finite/);
    expect(() => parseEmbeddingResponse({ data: [{ index: 0 }] }, 1, 2)).toThrow(/dimensions/);
  });
});

import { describe, expect, it } from 'vitest';
import { faqIndexDocument } from './faq-index.js';
import { weightOf } from './search.js';

describe('faqIndexDocument', () => {
  const doc = faqIndexDocument(
      { id: 'f1', versionId: 'v2', organizationId: 'o1', courseId: 'c1', courseVersionIds: ['cv1', 'cv2'], kind: 'common_error', question: '忘了預熱', answer: '先預熱 10 分鐘' },
      '2026-09-15T00:00:00.000Z',
    );

  it('is a course-wide, verified entry the coach can tell apart from material', () => {
    expect(doc).toMatchObject({
      chunk_id: 'dk:f1',
      knowledge_type: 'common_error',
      verification_status: 'verified',
      acl_scope: 'course',
      course_version_ids: ['cv1', 'cv2'],
      title: '忘了預熱',
      content: '忘了預熱\n先預熱 10 分鐘',
      char_end: '忘了預熱\n先預熱 10 分鐘'.length,
    });
  });

  it('outranks course material in retrieval (SA §15.3, AC-DRV-005)', () => {
    const faq = weightOf({ knowledgeType: doc.knowledge_type, verificationStatus: doc.verification_status, aclScope: doc.acl_scope });
    expect(faq).toBeGreaterThan(weightOf({ knowledgeType: 'source', verificationStatus: 'source', aclScope: 'course' }));
  });
});

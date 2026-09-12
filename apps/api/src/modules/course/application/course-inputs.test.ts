import { describe, expect, it } from 'vitest';
import { ActivityInput, CreateCourse, DraftPatch, LessonInput } from './course-inputs.js';

const ID = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';

describe('lesson content blocks', () => {
  it('accepts the lesson block subset', () => {
    const r = LessonInput.safeParse({
      id: ID,
      title: 'L1',
      contentBlocks: [
        { type: 'richtext', markdown: '# 標題\n內文' },
        { type: 'callout', variant: 'warning', body: '注意' },
        { type: 'image', assetId: ID2, alt: '示意圖' },
        { type: 'activity', activityId: ID2 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it.each<[unknown, string]>([
    [{ type: 'hero', title: 'x' }, 'CMS-only block'],
    [{ type: 'richtext', html: '<script>' }, 'raw html field'],
    [{ type: 'image', url: 'https://tracker.example/p.gif', alt: 'x' }, 'external URL instead of assetId'],
    [{ type: 'callout', variant: 'danger', body: 'x' }, 'unknown variant'],
  ])('rejects %j (%s)', (block) => {
    expect(LessonInput.safeParse({ id: ID, title: 'L', contentBlocks: [block] }).success).toBe(false);
  });
});

describe('activities', () => {
  it('applies defaults', () => {
    expect(ActivityInput.parse({ id: ID, title: 'A', activityType: 'reading' })).toMatchObject({
      interactiveDefinitionId: null,
      config: {},
      answerKey: null,
      isRequired: true,
      maxAttempts: null,
      weight: 1,
      maxScore: 100,
      prerequisite: null,
    });
  });

  it('interactive activities must name an interactive definition', () => {
    const r = ActivityInput.safeParse({ id: ID, title: 'A', activityType: 'interactive' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ['interactiveDefinitionId'], message: 'interactive_requires_definition' });
  });

  it('rejects oversized JSON config', () => {
    const r = ActivityInput.safeParse({ id: ID, title: 'A', activityType: 'reading', config: { blob: 'x'.repeat(70_000) } });
    expect(r.success).toBe(false);
  });
});

describe('DraftPatch / CreateCourse', () => {
  it('requires at least one field and rejects unknown fields', () => {
    expect(DraftPatch.safeParse({}).success).toBe(false);
    expect(DraftPatch.safeParse({ status: 'published' }).success).toBe(false);
    expect(DraftPatch.safeParse({ title: 'v2' }).success).toBe(true);
  });

  it('course codes: letters, digits, dash and underscore', () => {
    expect(CreateCourse.safeParse({ code: 'CA-101_x', title: 'T' }).success).toBe(true);
    expect(CreateCourse.safeParse({ code: '-bad', title: 'T' }).success).toBe(false);
    expect(CreateCourse.safeParse({ code: 'has space', title: 'T' }).success).toBe(false);
  });
});

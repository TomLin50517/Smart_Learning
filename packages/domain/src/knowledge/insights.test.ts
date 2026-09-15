import { describe, expect, it } from 'vitest';
import { anonymizeQuestion, clusterQuestions, questionSimilarity } from './insights.js';

const ask = (learner: number, text: string, at = learner) => ({ learner, text, at });

describe('anonymizeQuestion (AC-DRV-006)', () => {
  it('removes emails, phone numbers, known names and ids, and long numbers', () => {
    const t = anonymizeQuestion('我是王小明 (S1234567)，信箱 ming@school.edu.tw，手機 0912-345-678，訂單 20260915', {
      names: ['王小明'],
      ids: ['S1234567'],
    });
    expect(t).toBe('我是[NAME] ([ID])，信箱 [EMAIL]，手機 [PHONE]，訂單 [NUMBER]');
    expect(t).not.toMatch(/王小明|S1234567|ming@|0912|20260915/);
  });

  it('leaves ordinary questions alone', () => {
    expect(anonymizeQuestion('發酵溫度要控制在幾度？')).toBe('發酵溫度要控制在幾度？');
  });
});

describe('clusterQuestions', () => {
  const similar = ['發酵溫度要多少度？', '發酵的溫度要幾度', '請問發酵溫度要多少', '發酵溫度應該設定多少度呢', '麵糰發酵溫度要多少度', '發酵溫度多少比較好？'];

  it('groups similar questions from enough different learners (AC-DRV-001)', () => {
    const items = [...similar.map((q, i) => ask(i, q)), ask(10, '烤箱要預熱多久？'), ask(11, '可以用全麥麵粉嗎')];
    const c = clusterQuestions(items, { threshold: 5 });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ learners: 6, questions: 6 });
    expect(c[0]!.question).toContain('發酵');
    expect(c[0]!.key).toMatch(/^q:[0-9a-f]{8}$/);
  });

  it('does not depend on the order the questions arrive in', () => {
    const items = similar.map((q, i) => ask(i, `我是[NAME]（[EMAIL]），${q}`));
    const forward = clusterQuestions(items, { threshold: 5 });
    const backward = clusterQuestions([...items].reverse(), { threshold: 5 });
    expect(forward).toHaveLength(1);
    expect(backward).toHaveLength(1);
    expect(backward[0]!.learners).toBe(forward[0]!.learners);
    expect(backward[0]!.key).toBe(forward[0]!.key);
  });

  it('does not produce anything below the threshold (AC-DRV-002)', () => {
    expect(clusterQuestions(similar.slice(0, 3).map((q, i) => ask(i, q)), { threshold: 5 })).toEqual([]);
  });

  it('counts people, not messages: one learner asking six times is one learner', () => {
    expect(clusterQuestions(similar.map((q) => ask(1, q)), { threshold: 5 })).toEqual([]);
  });

  it('ignores questions that are too short to mean anything', () => {
    expect(clusterQuestions([0, 1, 2, 3, 4, 5].map((i) => ask(i, '??')), { threshold: 5 })).toEqual([]);
  });

  it('the key is stable for the same representative question', () => {
    const items = similar.map((q, i) => ask(i, q));
    expect(clusterQuestions(items, { threshold: 5 })[0]!.key).toBe(clusterQuestions(items, { threshold: 5 })[0]!.key);
  });
});

describe('questionSimilarity', () => {
  it('is high for paraphrases and low for unrelated questions', () => {
    expect(questionSimilarity('發酵溫度要多少度？', '發酵的溫度要幾度')).toBeGreaterThan(0.5);
    expect(questionSimilarity('發酵溫度要多少度？', '烤箱要預熱多久？')).toBeLessThan(0.25);
    expect(questionSimilarity('Email me@x.com 發酵溫度', '[EMAIL] 發酵溫度')).toBeGreaterThan(0.3);
  });
});

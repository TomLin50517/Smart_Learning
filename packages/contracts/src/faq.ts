/** 常見問答與常見錯誤（SA UC-KNW-004～008、SD §6.27）：老師撰寫、系統整理線索、AI 起草 */

export const FAQ_KINDS = ['faq', 'common_error'] as const;
export type FaqKind = (typeof FAQ_KINDS)[number];

export const FAQ_LIMITS = { question: 300, answer: 2000, citations: 10 } as const;

/** FAQ 在檢索索引中的 chunk id；AI 教練以此前綴判斷引用的是 FAQ 而不是教材 */
export const FAQ_CHUNK_PREFIX = 'dk:';
export const faqChunkId = (derivedKnowledgeId: string): string => `${FAQ_CHUNK_PREFIX}${derivedKnowledgeId}`;
export const faqIdFromChunk = (chunkId: string): string | null => (chunkId.startsWith(FAQ_CHUNK_PREFIX) ? chunkId.slice(FAQ_CHUNK_PREFIX.length) : null);

/** 課程的 FAQ 改變、或課程有新版本時，重新整理這門課在索引中的 FAQ（SD §6.27） */
export const DERIVED_INDEX_JOB = { type: 'derived.index', queue: 'ingest', maxAttempts: 5 } as const;

/** AI 起草時參考的教材段落（只供老師查看，不影響 FAQ 是否生效） */
export interface FaqCitationDto {
  chunkId: string;
  title: string;
  pageNo: number | null;
  sectionPath: string | null;
}

export interface FaqDto {
  id: string;
  kind: FaqKind;
  question: string;
  answer: string;
  status: 'verified' | 'retired';
  /** teacher：老師直接撰寫；insight：由系統整理的線索建立 */
  source: 'teacher' | 'insight';
  /** 由線索建立時的學員數（建立當下） */
  learners: number | null;
  versionNo: number;
  citations: FaqCitationDto[];
  createdAt: string;
  updatedAt: string;
  updatedByName: string | null;
}

/** GET /enrollments/{id}/faq：學員看得到的 FAQ（只含已生效者） */
export interface LearnerFaqDto {
  id: string;
  kind: FaqKind;
  question: string;
  answer: string;
}

/** 很多學員在同一處出錯（依作答結果的問題代碼彙整；只有達匿名門檻的才出現） */
export interface CommonErrorInsightDto {
  key: string;
  activityId: string;
  activityTitle: string;
  code: string;
  target: string | null;
  /** 題目／參數的名稱（依活動設定） */
  targetLabel: string | null;
  learners: number;
  occurrences: number;
  lastSeenAt: string;
  /** 已經有對應的常見錯誤 */
  faqId: string | null;
}

/** 很多學員問了相似的問題（去識別化後依文字相似度分群；只有達匿名門檻的才出現） */
export interface FrequentQuestionInsightDto {
  key: string;
  /** 代表性的問題（已去識別化） */
  question: string;
  learners: number;
  questions: number;
  lastAskedAt: string;
  faqId: string | null;
}

/** GET /courses/{id}/faq-insights */
export interface FaqInsightsDto {
  periodDays: number;
  /** 匿名門檻（平台設定 derived.min_threshold） */
  threshold: number;
  commonErrors: CommonErrorInsightDto[];
  frequentQuestions: FrequentQuestionInsightDto[];
}

/** POST /courses/{id}/faq/draft：AI 依教材起草的答案（不會自動儲存） */
export interface FaqDraftDto {
  status: 'drafted' | 'insufficient_evidence';
  answer: string;
  citations: FaqCitationDto[];
}

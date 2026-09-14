/** AI 學習教練（SA UC-CCH、SEQ-07；SD §10、§6.19） */

/** 回答狀態：模型的四種 status，加上系統的安全替代回答 */
export const COACH_ANSWER_STATUSES = ['answered', 'insufficient_evidence', 'out_of_scope', 'cannot_modify_assessment', 'fallback'] as const;
export type CoachAnswerStatus = (typeof COACH_ANSWER_STATUSES)[number];

/** 固定文案（前端與後端共用；替代回答不經 AI 產生） */
export const COACH_TEXT = {
  disclaimer: '此為 AI 教練的學習建議，不影響成績。',
  fallback: '目前無法根據課程資料提供可靠的回答，請詢問教師。',
  insufficientEvidence: '教材中沒有足夠的資料回答這個問題。可以換個方式描述，或詢問教師。',
  outOfScope: '這個問題超出本課程的範圍，建議詢問教師。',
  unavailable: 'AI 教練暫時無法使用',
  resting: 'AI 教練休息中，請稍後再試。',
} as const;

export const COACH_QUESTION_MAX = 2000;

export interface CoachCitationDto {
  /** coach_citations.id；開啟原文用 */
  id: string;
  /** 回答中的標記（c1、c2…） */
  citationId: string;
  title: string;
  pageNo: number | null;
  sectionPath: string | null;
  /** 模型引用的原句（只在當次回答中提供） */
  quote: string | null;
}

export interface CoachMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** assistant 訊息的狀態；user 訊息為 null */
  status: CoachAnswerStatus | null;
  citations: CoachCitationDto[];
  followUpQuestions: string[];
  createdAt: string;
}

export interface CoachConversationDto {
  id: string;
  enrollmentId: string | null;
  courseVersionId: string;
  activityId: string | null;
  isTest: boolean;
  startedAt: string;
  messages: CoachMessageDto[];
}

/** 一次問答的結果（教師測試回傳 JSON；學員經 SSE 的 done 事件取得相同內容） */
export interface CoachAnswerDto {
  conversationId: string;
  messageId: string;
  status: CoachAnswerStatus;
  answer: string;
  citations: CoachCitationDto[];
  followUpQuestions: string[];
  disclaimer: string;
}

/** 教練目前能不能用；不能用時前端顯示「AI 教練暫時無法使用」，其他功能照常 */
export type CoachUnavailableReason =
  | 'provider_unavailable'
  | 'search_unavailable'
  | 'disabled_by_organization'
  | 'not_licensed'
  | 'enrollment_inactive'
  | 'organization_key_missing'
  | 'quota_exceeded';

/**
 * 設定面的原因：學員畫面直接隱藏教練功能（學員無能為力，顯示只會造成疑問）；
 * 其餘（今日額度用完等）是暫時性的，保留按鈕並顯示「AI 教練休息中」。老師與管理員一律看得到原因。
 */
export const COACH_HIDDEN_REASONS: readonly CoachUnavailableReason[] = [
  'provider_unavailable',
  'search_unavailable',
  'disabled_by_organization',
  'not_licensed',
  'enrollment_inactive',
  'organization_key_missing',
];

/** 組織 AI 金鑰的狀態（金鑰本身永遠不回傳） */
export interface OrgAiCredentialDto {
  /** organization：每個組織用自己的 gateway 金鑰（AI_PROVIDER=litellm）；platform：平台共用設定 */
  mode: 'platform' | 'organization';
  configured: boolean;
  /** 金鑰代號（例如 LiteLLM 的 key alias） */
  alias: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** 伺服器已設定加密主金鑰（AI_KEY_ENCRYPTION_KEY）；未設定時無法儲存金鑰 */
  encryptionReady: boolean;
}

/** POST …/ai-credential/test：驗證 gateway、金鑰與模型（不產生回答、不耗用 token） */
export interface AiConnectionTestDto {
  ok: boolean;
  reason: 'ok' | 'unauthorized' | 'model_not_available' | 'unreachable' | 'quota' | 'error' | 'provider_unavailable' | 'organization_key_missing';
  latencyMs: number | null;
}

export interface CoachAvailabilityDto {
  available: boolean;
  reason: CoachUnavailableReason | null;
  /** 這位學員在此選課的對話（新到舊，最多 20） */
  conversations: { id: string; activityId: string | null; messageCount: number; lastMessageAt: string | null }[];
}

/** SSE 事件（ADR-025 B+：來源先送，回答在驗證通過後才送） */
export type CoachStreamEvent =
  | { event: 'stage'; data: { stage: 'retrieving' | 'composing' | 'validating' } }
  | { event: 'sources'; data: { sources: { title: string; pageNo: number | null; sectionPath: string | null }[] } }
  | { event: 'token'; data: { delta: string } }
  | { event: 'done'; data: CoachAnswerDto }
  | { event: 'error'; data: { code: string; message: string } };

/** GET /coach/citations/{id}/source：學員開啟引用的原文（每次重新檢查權限） */
export interface CitationSourceDto {
  citationId: string;
  title: string;
  pageNo: number | null;
  sectionPath: string | null;
  /** 引用段落前後的文字 */
  text: string;
  /** text 中被引用段落的位置 */
  highlightStart: number;
  highlightEnd: number;
  /** text 前面或後面還有內容 */
  truncatedBefore: boolean;
  truncatedAfter: boolean;
}

/**
 * GET /courses/{id}/coach/usage：課程的匿名使用統計（SD §6.21、ARCH §14.5）。
 * 最近 periodDays 天、不含教師測試。使用的學員數未達匿名門檻時，除了門檻外什麼都不提供（避免回推個人）；
 * 各活動的數字也只列出達到門檻的活動。
 */
export interface CoachUsageDto {
  periodDays: number;
  threshold: number;
  belowThreshold: boolean;
  learners: number | null;
  conversations: number | null;
  questions: number | null;
  /** 由作答結果觸發的對話數 */
  resultTriggered: number | null;
  statuses: Record<CoachAnswerStatus, number> | null;
  /** 最常被引用的教材（前 5） */
  topDocuments: { title: string; citations: number }[];
  activities: { activityId: string; title: string; questions: number; learners: number }[];
}

/** 逐字稿清單：只列出「組織政策」與「對話建立時的戳印」都允許課程人員閱讀的對話（ADR-028） */
export interface CoachTranscriptSummaryDto {
  id: string;
  learnerId: string;
  learnerDisplayName: string;
  activityTitle: string | null;
  triggerType: 'learner_question' | 'result_trigger';
  messageCount: number;
  startedAt: string;
  lastMessageAt: string | null;
}

export interface CoachTranscriptListDto {
  /** 組織目前的政策 */
  policy: 'aggregate_only' | 'course_staff';
  data: CoachTranscriptSummaryDto[];
  /** 不可閱讀的對話數（建立時承諾不公開，或組織已收回政策） */
  hiddenCount: number;
}

export interface CoachTranscriptDto extends CoachTranscriptSummaryDto {
  messages: CoachMessageDto[];
}

/** 組織的 AI 教練設定（org.settings） */
export interface CoachSettingsDto {
  /** 組織可停用 AI 教練（預設啟用） */
  enabled: boolean;
  /** 課程人員能否讀學員的對話逐字稿；只影響之後建立的對話（ADR-028） */
  transcriptVisibility: 'aggregate_only' | 'course_staff';
  /** 這個組織目前可以呼叫 AI 服務（平台已設定，且組織金鑰模式下已有金鑰） */
  providerConfigured: boolean;
  /** 組織 AI 金鑰（只有代號與更新時間） */
  aiKey: Pick<OrgAiCredentialDto, 'mode' | 'configured' | 'alias' | 'updatedAt'>;
  /** 今日已用 token／每日上限 */
  tokensUsedToday: number;
  dailyTokenBudget: number;
}

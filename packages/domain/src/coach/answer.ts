/**
 * AI 教練的回應格式與驗證（SD §10.2、§10.4）。純函式——不呼叫模型、不讀資料庫。
 * 模型的輸出一律視為不可信：先解析與檢查，通過才交給學員（INV-5）。
 */

export const MODEL_STATUSES = ['answered', 'insufficient_evidence', 'out_of_scope', 'cannot_modify_assessment'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export interface ModelCitation {
  citation_id: string;
  chunk_id: string;
  quote: string;
}

export interface ModelAnswer {
  status: ModelStatus;
  answer: string;
  citations: ModelCitation[];
  follow_up_questions: string[];
  directness_level: number;
}

export const ANSWER_LIMITS = { answerChars: 4000, citations: 8, quoteChars: 300, followUps: 3 } as const;

/**
 * 送給模型的 JSON Schema（structured output）。只用各家都支援的子集（型別、enum、required、additionalProperties）；
 * 長度與數量上限由 parseModelAnswer 另外檢查。
 */
export const COACH_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'answer', 'citations', 'follow_up_questions', 'directness_level'],
  properties: {
    status: { type: 'string', enum: [...MODEL_STATUSES] },
    answer: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['citation_id', 'chunk_id', 'quote'],
        properties: { citation_id: { type: 'string' }, chunk_id: { type: 'string' }, quote: { type: 'string' } },
      },
    },
    follow_up_questions: { type: 'array', items: { type: 'string' } },
    directness_level: { type: 'integer' },
  },
} as const;

export type ParseResult = { ok: true; value: ModelAnswer } | { ok: false; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** V0：解析並檢查格式（容許模型把 JSON 包在 ``` 裡） */
export function parseModelAnswer(raw: string): ParseResult {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'not_json' };
  }
  if (!isObj(v)) return { ok: false, detail: 'not_object' };
  const allowed = new Set(['status', 'answer', 'citations', 'follow_up_questions', 'directness_level', 'notes_for_system']);
  const extra = Object.keys(v).find((k) => !allowed.has(k));
  if (extra) return { ok: false, detail: `unknown_field:${extra}` };
  if (typeof v['status'] !== 'string' || !(MODEL_STATUSES as readonly string[]).includes(v['status'])) return { ok: false, detail: 'status' };
  if (typeof v['answer'] !== 'string' || !v['answer'].trim() || v['answer'].length > ANSWER_LIMITS.answerChars) return { ok: false, detail: 'answer' };
  const cites = v['citations'] ?? [];
  if (!Array.isArray(cites) || cites.length > ANSWER_LIMITS.citations) return { ok: false, detail: 'citations' };
  const citations: ModelCitation[] = [];
  const seen = new Set<string>();
  for (const c of cites) {
    if (!isObj(c) || typeof c['citation_id'] !== 'string' || !/^c[0-9]{1,2}$/.test(c['citation_id']) || typeof c['chunk_id'] !== 'string' || !c['chunk_id']) {
      return { ok: false, detail: 'citation_item' };
    }
    const quote = c['quote'] === undefined ? '' : c['quote'];
    if (typeof quote !== 'string' || quote.length > ANSWER_LIMITS.quoteChars) return { ok: false, detail: 'citation_quote' };
    if (seen.has(c['citation_id'])) return { ok: false, detail: 'citation_duplicate' };
    seen.add(c['citation_id']);
    citations.push({ citation_id: c['citation_id'], chunk_id: c['chunk_id'], quote });
  }
  const fu = v['follow_up_questions'] ?? [];
  if (!Array.isArray(fu) || fu.length > ANSWER_LIMITS.followUps || !fu.every((q) => typeof q === 'string' && q.length <= 300)) return { ok: false, detail: 'follow_up_questions' };
  const dl = v['directness_level'] ?? 1;
  if (typeof dl !== 'number' || !Number.isInteger(dl) || dl < 1 || dl > 5) return { ok: false, detail: 'directness_level' };
  return { ok: true, value: { status: v['status'] as ModelStatus, answer: v['answer'].trim(), citations, follow_up_questions: fu as string[], directness_level: dl } };
}

export interface ValidationChunk {
  chunkId: string;
  content: string;
  /** 伺服器反查：這段仍屬於此組織、此課程版本（V4） */
  authorized: boolean;
}

export interface ValidationContext {
  chunks: readonly ValidationChunk[];
  citationRequired: boolean;
  prohibitedTopics: readonly string[];
  responseMode: 'hint_first' | 'coach_first' | 'direct_allowed';
  maxDirectnessLevel: number;
  /** null＝永不直接給答案 */
  allowAnswerRevealAfterAttempts: number | null;
  attemptCount: number;
  /** 本課程其他學員的姓名（V6） */
  otherLearnerNames: readonly string[];
}

export type RepairReason = 'SCHEMA_INVALID' | 'CITATION_MISSING' | 'CITATION_UNKNOWN_CHUNK' | 'QUOTE_NOT_FOUND' | 'PROHIBITED_TOPIC' | 'TOO_DIRECT';
export type RejectReason = 'CITATION_ACL_VIOLATION' | 'CROSS_LEARNER_LEAK' | 'ASSESSMENT_TAMPERING_CLAIM' | 'MODEL_REFUSED';

export type Verdict =
  | { verdict: 'PASS' }
  | { verdict: 'PASS_AS_FALLBACK' }
  | { verdict: 'PASS_AS_NOTICE' }
  | { verdict: 'REPAIR'; reason: RepairReason; detail?: string }
  | { verdict: 'REJECT'; reason: RejectReason; detail?: string };

/** 比對引文：忽略空白、全半形、大小寫（V5） */
export const normalizeForQuote = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/** 宣稱已改分、已通過、已發證書等（V7）。只偵測「宣稱」；實際寫入已由資料庫角色阻擋 */
const TAMPERING = [
  /(已|已經|我已|我已經|幫你|替你|為你)\s*(把|將)?\s*(你的)?\s*(分數|成績|評分|結果)\s*(改|調整|修改|提高|更正)/,
  /(已|已經|我已|我已經)\s*(幫你|替你|為你)?\s*(通過|過關|及格|加分|改分)/,
  /(幫你|替你|為你)\s*(通過|過關|及格|加分|改分)/,
  /(已|已經)\s*(核發|發出|頒發|寄出)\s*(你的)?\s*證書/,
  /重新評分(完成|好了)/,
  /\bI(?:'ve| have) (?:changed|updated|raised|fixed) your (?:score|grade|result)/i,
  /\b(?:marked|passed) you (?:as )?(?:passed|complete)/i,
];

export function validateAnswer(a: ModelAnswer, ctx: ValidationContext): Verdict {
  // V1 狀態短路（替代與提示仍要檢查是否宣稱改分——那是注入成功的徵兆）
  if (TAMPERING.some((re) => re.test(a.answer))) return { verdict: 'REJECT', reason: 'ASSESSMENT_TAMPERING_CLAIM' };
  if (a.status === 'insufficient_evidence') return { verdict: 'PASS_AS_FALLBACK' };
  if (a.status === 'out_of_scope') return { verdict: 'PASS_AS_NOTICE' };

  const byId = new Map(ctx.chunks.map((c) => [c.chunkId, c]));
  if (a.status === 'answered') {
    // V2
    if (ctx.citationRequired && a.citations.length === 0) return { verdict: 'REPAIR', reason: 'CITATION_MISSING' };
  }
  for (const c of a.citations) {
    const chunk = byId.get(c.chunk_id);
    // V3 杜撰的出處
    if (!chunk) return { verdict: 'REPAIR', reason: 'CITATION_UNKNOWN_CHUNK', detail: c.chunk_id };
    // V4 出處已不屬於此範圍：安全事件，不修正
    if (!chunk.authorized) return { verdict: 'REJECT', reason: 'CITATION_ACL_VIOLATION', detail: c.chunk_id };
    // V5
    if (c.quote && !normalizeForQuote(chunk.content).includes(normalizeForQuote(c.quote))) return { verdict: 'REPAIR', reason: 'QUOTE_NOT_FOUND', detail: c.citation_id };
  }
  // V6 其他學員的姓名
  const text = a.answer + '\n' + a.follow_up_questions.join('\n');
  const leaked = ctx.otherLearnerNames.find((n) => n.trim().length >= 2 && text.includes(n.trim()));
  if (leaked) return { verdict: 'REJECT', reason: 'CROSS_LEARNER_LEAK' };
  // V8 禁止主題
  const lower = text.toLowerCase();
  const topic = ctx.prohibitedTopics.find((t) => t.trim() && lower.includes(t.trim().toLowerCase()));
  if (topic) return { verdict: 'REPAIR', reason: 'PROHIBITED_TOPIC', detail: topic };
  // V9 先給提示模式下太直接
  const revealed = ctx.allowAnswerRevealAfterAttempts !== null && ctx.attemptCount >= ctx.allowAnswerRevealAfterAttempts;
  if (ctx.responseMode === 'hint_first' && !revealed && a.directness_level > ctx.maxDirectnessLevel) return { verdict: 'REPAIR', reason: 'TOO_DIRECT' };
  return { verdict: 'PASS' };
}

/** 修正時告訴模型哪裡不對（只說規則，不重述學員資料） */
export const REPAIR_INSTRUCTIONS: Record<RepairReason, string> = {
  SCHEMA_INVALID: '輸出不是符合指定 JSON schema 的合法 JSON。只輸出 JSON。',
  CITATION_MISSING: '回答需要附上引用：citations 必須列出支撐回答的 DATA 段落。',
  CITATION_UNKNOWN_CHUNK: 'citations 中的 chunk_id 必須是 DATA 區中出現的 chunk_id，不可自行編造。',
  QUOTE_NOT_FOUND: 'quote 必須逐字摘自對應 chunk 的內容；不確定時請留空字串。',
  PROHIBITED_TOPIC: '回答涉及本課程禁止討論的主題，請移除相關內容。',
  TOO_DIRECT: '依本課程設定，目前只能給提示與引導問題，不能直接給出答案；請降低直接程度。',
};

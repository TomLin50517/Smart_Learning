import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  COACH_TEXT,
  documentObjectKeys,
  type CitationSourceDto,
  type CoachAnswerDto,
  type CoachAnswerStatus,
  type CoachAvailabilityDto,
  type CoachCitationDto,
  type CoachConversationDto,
  type CoachKnowledgeScope,
  type CoachPolicyDto,
  type CoachStreamEvent,
  type CoachUnavailableReason,
} from '@iac/contracts';
import {
  buildCoachPrompt,
  COACH_PROMPT_VERSION,
  COACH_RESPONSE_SCHEMA,
  detectPii,
  parseModelAnswer,
  validateAnswer,
  withRepair,
  type AclScope,
  type KnowledgeType,
  type ModelAnswer,
  type PromptContext,
  type PromptTurn,
  type RetrievedChunk,
  type ValidationContext,
  type Verdict,
} from '@iac/domain';
import pg from 'pg';
import type { AuthUser } from '../../../common/context.js';
import { DB_COACH } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { logger } from '../../../common/logger.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../common/object-storage.js';
import { ENV, type Env } from '../../../config/env.js';
import { KNOWLEDGE_RETRIEVER, type KnowledgeRetriever } from '../../knowledge/knowledge.contracts.js';
import { ProviderError, type LlmProvider } from '../infrastructure/llm-provider.js';
import { LlmProviderResolver } from '../infrastructure/provider-resolver.js';
import { CoachSettingsService } from './coach-settings.service.js';
import { loadMessages } from './messages.js';

/** 教練設定缺漏時（例如尚未儲存設定的草稿）的保守預設 */
const DEFAULT_POLICY: CoachPolicyDto = {
  responseMode: 'hint_first',
  maxDirectnessLevel: 2,
  allowAnswerRevealAfterAttempts: 3,
  preferredLanguage: 'zh-TW',
  citationRequired: true,
  allowedKnowledgeScopes: ['course_source', 'verified_faq', 'common_error'],
  toneProfile: 'supportive',
  followUpQuestions: true,
  prohibitedTopics: [],
  extraInstructions: null,
};

const RESULT_LABEL: Record<string, string> = { passed: '通過', completed: '完成', needs_improvement: '需要再加強', failed: '未通過' };
const SCOPE_TO_TYPE: Record<CoachKnowledgeScope, KnowledgeType> = { course_source: 'source', verified_faq: 'faq', common_error: 'common_error', platform: 'platform' };
const ACTIVE_ENROLLMENT = ['active', 'reopened', 'completed'];
const MAX_OUTPUT_TOKENS = 16_000;
const HISTORY_MESSAGES = 6;
const TOP_K = 8;
/** 原文檢視：引用段落前後各帶多少字 */
const SOURCE_WINDOW = 1500;

interface ConvRow {
  id: string;
  organization_id: string;
  enrollment_id: string | null;
  learner_id: string;
  course_version_id: string;
  lesson_id: string | null;
  activity_id: string | null;
  is_test: boolean;
  started_at: Date;
  course_id: string;
  course_title: string;
  version_no: number;
}

interface UsageCall {
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: 'success' | 'error' | 'timeout';
  errorCode: string | null;
}

interface Outcome {
  status: CoachAnswerStatus;
  validation: 'passed' | 'repaired' | 'fallback';
  fallbackReason: string | null;
  model: ModelAnswer | null;
}

/** 問答前的準備結果（權限、額度、檢索都已通過）；之後的生成不再拋出錯誤碼給前端 */
export interface PreparedQuestion {
  conv: ConvRow;
  policy: CoachPolicyDto;
  question: string;
  chunks: RetrievedChunk[];
  authorizedChunkIds: Set<string>;
  context: PromptContext;
  history: PromptTurn[];
  otherLearnerNames: string[];
  pii: string[];
  correlationId: string;
  /** 這個組織的供應商（litellm 模式下用組織自己的金鑰） */
  llm: LlmProvider;
}

const unavailable = (reason: CoachUnavailableReason) => new DomainError('COACH_PROVIDER_UNAVAILABLE', COACH_TEXT.unavailable, [{ issue: reason }]);

/** 已驗證的回答以打字機效果分段送出（ADR-025 B） */
function pieces(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * AI 學習教練（SA UC-CCH-001～003、SEQ-07；SD §10、§6.19）。
 * 流程：權限與額度 → 檢索（範圍由伺服器決定）→ 組提示詞（去識別化）→ 模型 → 解析與驗證（V0～V9）→ 修正一次或安全替代 → 保存。
 * 寫入一律經 app_coach 連線（ADR-026）：只能寫教練自己的資料表，資料庫層就擋下改成績、改選課狀態、發證書（INV-3）。
 */
@Injectable()
export class CoachService {
  constructor(
    @Inject(DB_COACH) private readonly db: pg.Pool,
    private readonly providers: LlmProviderResolver,
    @Inject(KNOWLEDGE_RETRIEVER) private readonly retriever: KnowledgeRetriever,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ENV) private readonly env: Env,
    private readonly settings: CoachSettingsService,
  ) {}

  // ------------------------------------------------------------------ 對話

  /** 學員的選課；不是本人或不在目前組織 → 404 */
  private async ownEnrollment(enrollmentId: string, user: AuthUser) {
    const r = await this.db.query<{ id: string; organization_id: string; course_version_id: string; status: string }>(
      `SELECT id, organization_id, course_version_id, status FROM enrollments WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
      [enrollmentId, user.id, user.activeOrganizationId],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return r.rows[0];
  }

  private async conversation(id: string, user: AuthUser, organizationId: string | null = user.activeOrganizationId): Promise<ConvRow> {
    const r = await this.db.query<ConvRow>(
      `SELECT c.id, c.organization_id, c.enrollment_id, c.learner_id, c.course_version_id, c.lesson_id, c.activity_id, c.is_test, c.started_at,
              cv.course_id, cv.version_no, co.title AS course_title
         FROM coach_conversations c JOIN course_versions cv ON cv.id = c.course_version_id JOIN courses co ON co.id = cv.course_id
        WHERE c.id = $1 AND c.learner_id = $2 AND c.organization_id = $3 AND c.anonymized_at IS NULL`,
      [id, user.id, organizationId],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return r.rows[0];
  }

  /** 教練能不能用、這位學員的對話清單（前端決定顯示「問教練」或「暫時無法使用」） */
  async availability(enrollmentId: string, user: AuthUser): Promise<CoachAvailabilityDto> {
    const e = await this.ownEnrollment(enrollmentId, user);
    const s = await this.settings.get(e.organization_id);
    const ps = await this.providers.status(e.organization_id);
    const reason: CoachUnavailableReason | null = !s.enabled
      ? 'disabled_by_organization'
      : !ps.ok
        ? (ps.reason ?? 'provider_unavailable')
        : !this.retriever.available
          ? 'search_unavailable'
          : !ACTIVE_ENROLLMENT.includes(e.status)
            ? 'enrollment_inactive'
            : (await this.quotaReached(e.organization_id))
              ? 'quota_exceeded'
              : null;
    const convs = await this.db.query<{ id: string; activity_id: string | null; message_count: number; last_message_at: Date | null }>(
      `SELECT id, activity_id, message_count, last_message_at FROM coach_conversations
        WHERE enrollment_id = $1 AND learner_id = $2 AND anonymized_at IS NULL ORDER BY started_at DESC LIMIT 20`,
      [enrollmentId, user.id],
    );
    return {
      available: reason === null,
      reason,
      conversations: convs.rows.map((c) => ({ id: c.id, activityId: c.activity_id, messageCount: c.message_count, lastMessageAt: c.last_message_at ? new Date(c.last_message_at).toISOString() : null })),
    };
  }

  /** 建立對話：依組織當下政策戳印逐字稿可見性，之後不可變（ADR-028 條件 4） */
  async createConversation(user: AuthUser, input: { enrollmentId: string; activityId?: string | undefined }): Promise<CoachConversationDto> {
    const e = await this.ownEnrollment(input.enrollmentId, user);
    const s = await this.settings.get(e.organization_id);
    if (!s.enabled) throw unavailable('disabled_by_organization');
    if (!ACTIVE_ENROLLMENT.includes(e.status)) throw unavailable('enrollment_inactive');
    let lessonId: string | null = null;
    if (input.activityId) {
      const a = await this.db.query<{ lesson_id: string }>(`SELECT lesson_id FROM activities WHERE id = $1 AND course_version_id = $2`, [input.activityId, e.course_version_id]);
      if (!a.rows[0]) throw new DomainError('VALIDATION_FAILED', 'activityId: not_in_course_version', [{ field: 'activityId', issue: 'not_in_course_version' }]);
      lessonId = a.rows[0].lesson_id;
    }
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO coach_conversations (organization_id, enrollment_id, learner_id, course_version_id, lesson_id, activity_id, trigger_type, is_test, transcript_visibility)
       VALUES ($1, $2, $3, $4, $5, $6, 'learner_question', false, $7::transcript_visibility) RETURNING id`,
      [e.organization_id, e.id, user.id, e.course_version_id, lessonId, input.activityId ?? null, s.transcriptVisibility],
    );
    return this.getConversation(r.rows[0]!.id, user);
  }

  async getConversation(id: string, user: AuthUser): Promise<CoachConversationDto> {
    const c = await this.conversation(id, user);
    return {
      id: c.id,
      enrollmentId: c.enrollment_id,
      courseVersionId: c.course_version_id,
      activityId: c.activity_id,
      isTest: c.is_test,
      startedAt: new Date(c.started_at).toISOString(),
      messages: await loadMessages(this.db, id),
    };
  }

  /**
   * 結果觸發（SA UC-CCH-002）：學員在作答結果旁按「請教練看看」。只能用自己的作答；還沒有結果 → 409。
   * 問題由系統依結果產生（活動、結果、分數、問題代碼），存成學員的第一則訊息，學員看得到送出了什麼。
   * 教練不重新評分、不改變結果（INV-3）。
   */
  async fromResult(user: AuthUser, attemptId: string): Promise<{ conv: ConvRow; question: string; retrievalQuery: string; currentResult: NonNullable<PromptContext['currentResult']> }> {
    const r = await this.db.query<{
      enrollment_id: string;
      activity_id: string;
      lesson_id: string;
      course_version_id: string;
      organization_id: string;
      enrollment_status: string;
      title: string;
      result_status: string | null;
      score: string | null;
      max_score: string | null;
      issues: { code?: unknown; category?: unknown; severity?: unknown }[] | null;
    }>(
      `SELECT e.id AS enrollment_id, la.activity_id, a.lesson_id, e.course_version_id, e.organization_id, e.status AS enrollment_status, a.title,
              lr.status AS result_status, lr.score, lr.max_score, lr.issues
         FROM learning_attempts la JOIN enrollments e ON e.id = la.enrollment_id JOIN activities a ON a.id = la.activity_id
         LEFT JOIN LATERAL (SELECT status, score, max_score, issues FROM learning_results WHERE attempt_id = la.id ORDER BY evaluated_at DESC LIMIT 1) lr ON true
        WHERE la.id = $1 AND e.user_id = $2 AND e.organization_id = $3`,
      [attemptId, user.id, user.activeOrganizationId],
    );
    const x = r.rows[0];
    if (!x) throw new DomainError('NOT_FOUND');
    if (!x.result_status) throw new DomainError('RESULT_NOT_READY', 'The attempt has no result yet', [{ field: 'attemptId', issue: 'no_result' }]);
    // 建立對話前先確認可以回答，避免留下空對話
    const s = await this.settings.get(x.organization_id);
    if (!s.enabled) throw unavailable('disabled_by_organization');
    const ps = await this.providers.status(x.organization_id);
    if (!ps.ok) throw unavailable(ps.reason ?? 'provider_unavailable');
    if (!this.retriever.available) throw unavailable('search_unavailable');
    if (!ACTIVE_ENROLLMENT.includes(x.enrollment_status)) throw unavailable('enrollment_inactive');

    const created = await this.db.query<{ id: string }>(
      `INSERT INTO coach_conversations (organization_id, enrollment_id, learner_id, course_version_id, lesson_id, activity_id, trigger_type, is_test, transcript_visibility)
       VALUES ($1, $2, $3, $4, $5, $6, 'result_trigger', false, $7::transcript_visibility) RETURNING id`,
      [x.organization_id, x.enrollment_id, user.id, x.course_version_id, x.lesson_id, x.activity_id, s.transcriptVisibility],
    );
    const issues = (x.issues ?? []).slice(0, 10).map((i) => ({ code: String(i.code ?? ''), category: String(i.category ?? ''), severity: String(i.severity ?? '') }));
    const score = x.score === null ? null : Number(x.score);
    const maxScore = Number(x.max_score);
    const question = [
      `我剛完成「${x.title}」，結果是「${RESULT_LABEL[x.result_status] ?? x.result_status}」${score !== null ? `（${score}／${maxScore} 分）` : ''}。`,
      issues.length ? `系統指出的問題：${issues.map((i) => i.code).join('、')}。` : '',
      '請根據教材幫我了解可以怎麼改進。',
    ].join('');
    return {
      conv: await this.conversation(created.rows[0]!.id, user),
      question,
      retrievalQuery: [x.title, ...issues.flatMap((i) => [i.code, i.category])].filter(Boolean).join(' '),
      currentResult: { status: x.result_status, score, maxScore, issues },
    };
  }

  /** 教師測試（coach.interact_test）：以自己的身分在課程版本上試問，不綁選課、不列入班級統計 */
  async testConversation(user: AuthUser, courseVersionId: string, conversationId: string | undefined): Promise<ConvRow> {
    const cv = await this.db.query<{ organization_id: string }>(`SELECT organization_id FROM course_versions WHERE id = $1`, [courseVersionId]);
    if (!cv.rows[0]) throw new DomainError('NOT_FOUND');
    const orgId = cv.rows[0].organization_id;
    if (conversationId) {
      const c = await this.conversation(conversationId, user, orgId);
      if (!c.is_test || c.course_version_id !== courseVersionId) throw new DomainError('NOT_FOUND');
      return c;
    }
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO coach_conversations (organization_id, enrollment_id, learner_id, course_version_id, trigger_type, is_test, transcript_visibility)
       VALUES ($1, NULL, $2, $3, 'instructor_test', true, 'aggregate_only') RETURNING id`,
      [orgId, user.id, courseVersionId],
    );
    return this.conversation(r.rows[0]!.id, user, orgId);
  }

  async learnerConversation(id: string, user: AuthUser): Promise<ConvRow> {
    const c = await this.conversation(id, user);
    if (c.is_test) throw new DomainError('NOT_FOUND');
    return c;
  }

  // ------------------------------------------------------------------ 問答

  private async policyOf(courseVersionId: string): Promise<CoachPolicyDto> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT response_mode, max_directness_level, allow_answer_reveal_after_attempts, preferred_language, citation_required,
              allowed_knowledge_scopes, tone_profile, follow_up_questions, prohibited_topics, extra_instructions
         FROM coach_policies WHERE course_version_id = $1`,
      [courseVersionId],
    );
    const p = r.rows[0];
    if (!p) return DEFAULT_POLICY;
    return {
      responseMode: p['response_mode'] as CoachPolicyDto['responseMode'],
      maxDirectnessLevel: Number(p['max_directness_level']),
      allowAnswerRevealAfterAttempts: p['allow_answer_reveal_after_attempts'] === null ? null : Number(p['allow_answer_reveal_after_attempts']),
      preferredLanguage: p['preferred_language'] as CoachPolicyDto['preferredLanguage'],
      citationRequired: p['citation_required'] as boolean,
      allowedKnowledgeScopes: (p['allowed_knowledge_scopes'] as CoachKnowledgeScope[] | null) ?? DEFAULT_POLICY.allowedKnowledgeScopes,
      toneProfile: p['tone_profile'] as CoachPolicyDto['toneProfile'],
      followUpQuestions: p['follow_up_questions'] as boolean,
      prohibitedTopics: (p['prohibited_topics'] as string[] | null) ?? [],
      extraInstructions: (p['extra_instructions'] as string | null) ?? null,
    };
  }

  /** 組織每日 token 上限（ADR-029：調校旋鈕，不是啟用閘門） */
  private async quotaReached(organizationId: string): Promise<boolean> {
    const r = await this.db.query<{ n: string }>(
      `SELECT COALESCE(sum(total_tokens), 0)::text AS n FROM ai_usage_records WHERE organization_id = $1 AND occurred_at >= date_trunc('day', now())`,
      [organizationId],
    );
    return Number(r.rows[0]!.n) >= this.env.AI_DAILY_TOKEN_BUDGET_DEFAULT;
  }

  private async checkQuota(organizationId: string): Promise<void> {
    if (await this.quotaReached(organizationId)) throw new DomainError('AI_QUOTA_EXCEEDED', 'Daily AI token budget reached');
  }

  /** V4：反查 chunk 仍屬於此組織、且綁在此課程版本 */
  private async authorizedChunks(chunkIds: string[], organizationId: string, courseVersionId: string): Promise<Set<string>> {
    if (!chunkIds.length) return new Set();
    const r = await this.db.query<{ chunk_id: string }>(
      `SELECT m.chunk_id FROM knowledge_chunk_manifest m
         JOIN knowledge_bindings kb ON kb.document_version_id = m.document_version_id AND kb.course_version_id = $3
        WHERE m.chunk_id = ANY($1::text[]) AND m.organization_id = $2`,
      [chunkIds, organizationId, courseVersionId],
    );
    return new Set(r.rows.map((x) => x.chunk_id));
  }

  /**
   * 問答前的檢查與準備（錯誤以一般錯誤碼回應，尚未開始串流）：組織是否停用、供應商與檢索是否可用、選課狀態、額度、檢索。
   * 檢索範圍完全由伺服器決定（組織、這個課程版本、教練設定允許的知識類型）。
   */
  async prepare(
    conv: ConvRow,
    question: string,
    correlationId: string,
    extra: { retrievalQuery?: string; currentResult?: PromptContext['currentResult'] } = {},
  ): Promise<PreparedQuestion> {
    const s = await this.settings.get(conv.organization_id);
    if (!s.enabled) throw unavailable('disabled_by_organization');
    const resolved = await this.providers.forOrganization(conv.organization_id);
    if (!resolved.ok) throw unavailable(resolved.reason);
    if (!this.retriever.available) throw unavailable('search_unavailable');
    if (conv.enrollment_id) {
      const e = await this.db.query<{ status: string }>(`SELECT status FROM enrollments WHERE id = $1`, [conv.enrollment_id]);
      if (!e.rows[0] || !ACTIVE_ENROLLMENT.includes(e.rows[0].status)) throw unavailable('enrollment_inactive');
    }
    await this.checkQuota(conv.organization_id);

    const policy = await this.policyOf(conv.course_version_id);
    const aclScopes: AclScope[] = policy.allowedKnowledgeScopes.includes('platform') ? ['course', 'organization', 'platform'] : ['course', 'organization'];
    const chunks = await this.retriever.retrieve(
      { queryText: extra.retrievalQuery ?? question, topK: TOP_K, knowledgeTypes: policy.allowedKnowledgeScopes.map((k) => SCOPE_TO_TYPE[k]) },
      { organizationId: conv.organization_id, courseVersionIds: [conv.course_version_id], allowedVerificationStatuses: ['source', 'verified'], aclScopes },
    );
    const [authorizedChunkIds, where, attempts, completed, history, others] = await Promise.all([
      this.authorizedChunks(
        chunks.map((c) => c.chunkId),
        conv.organization_id,
        conv.course_version_id,
      ),
      conv.activity_id
        ? this.db.query<{ lesson_title: string; activity_title: string; activity_type: string }>(
            `SELECT l.title AS lesson_title, a.title AS activity_title, a.activity_type FROM activities a JOIN lessons l ON l.id = a.lesson_id WHERE a.id = $1`,
            [conv.activity_id],
          )
        : Promise.resolve(null),
      conv.enrollment_id && conv.activity_id
        ? this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM learning_attempts WHERE enrollment_id = $1 AND activity_id = $2`, [conv.enrollment_id, conv.activity_id])
        : Promise.resolve(null),
      conv.enrollment_id
        ? this.db.query<{ n: number }>(`SELECT count(DISTINCT activity_id)::int AS n FROM learning_results WHERE enrollment_id = $1 AND status IN ('passed', 'completed')`, [conv.enrollment_id])
        : Promise.resolve(null),
      this.db.query<{ role: 'user' | 'assistant'; content: string }>(
        `SELECT role, content FROM coach_messages WHERE conversation_id = $1 AND role IN ('user', 'assistant') ORDER BY seq_no DESC LIMIT ${HISTORY_MESSAGES}`,
        [conv.id],
      ),
      // V6：本課程其他學員的姓名（回答中出現即拒絕）
      this.db.query<{ name: string }>(
        `SELECT DISTINCT u.display_name AS name FROM enrollments e JOIN users u ON u.id = e.user_id
          WHERE e.course_id = $1 AND e.user_id <> $2 AND u.display_name IS NOT NULL LIMIT 2000`,
        [conv.course_id, conv.learner_id],
      ),
    ]);
    const w = where?.rows[0];
    return {
      llm: resolved.provider,
      conv,
      policy,
      question,
      chunks,
      authorizedChunkIds,
      context: {
        courseTitle: conv.course_title,
        versionNo: conv.version_no,
        lessonTitle: w?.lesson_title ?? null,
        activityTitle: w?.activity_title ?? null,
        activityType: w?.activity_type ?? null,
        attemptCount: attempts?.rows[0]?.n ?? 0,
        completedActivities: completed?.rows[0]?.n ?? 0,
        // 不透明代號：每個對話不同，無法回推學員（SD §10.1.3）
        learnerRef: `lrn_${createHmac('sha256', this.env.SESSION_SECRET).update(`${conv.learner_id}:${conv.id}`).digest('hex').slice(0, 12)}`,
        currentResult: extra.currentResult ?? null,
      },
      history: history.rows.reverse().map((m) => ({ role: m.role, content: m.content })),
      otherLearnerNames: others.rows.map((x) => x.name),
      pii: detectPii(question),
      correlationId,
    };
  }

  /** 產生、驗證並保存回答。串流事件經 emit 送出；回答文字只在驗證通過後才送（INV-5） */
  async answer(p: PreparedQuestion, emit: (e: CoachStreamEvent) => void = () => undefined): Promise<CoachAnswerDto> {
    emit({ event: 'stage', data: { stage: 'retrieving' } });
    emit({ event: 'sources', data: { sources: p.chunks.map((c) => ({ title: c.title, pageNo: c.pageNo, sectionPath: c.sectionPath })) } });
    const calls: UsageCall[] = [];
    const outcome: Outcome =
      !p.chunks.length && p.policy.citationRequired
        ? { status: 'insufficient_evidence', validation: 'passed', fallbackReason: 'NO_EVIDENCE', model: null }
        : await this.generate(p, calls, emit);
    const dto = await this.persist(p, outcome, calls);
    for (const delta of pieces(dto.answer)) emit({ event: 'token', data: { delta } });
    emit({ event: 'done', data: dto });
    return dto;
  }

  private async generate(p: PreparedQuestion, calls: UsageCall[], emit: (e: CoachStreamEvent) => void): Promise<Outcome> {
    emit({ event: 'stage', data: { stage: 'composing' } });
    const base = buildCoachPrompt({
      policy: p.policy,
      context: p.context,
      chunks: p.chunks.map((c) => ({ chunkId: c.chunkId, title: c.title, pageNo: c.pageNo, sectionPath: c.sectionPath, content: c.content })),
      question: p.question,
      history: p.history,
    });
    const vctx: ValidationContext = {
      chunks: p.chunks.map((c) => ({ chunkId: c.chunkId, content: c.content, authorized: p.authorizedChunkIds.has(c.chunkId) })),
      citationRequired: p.policy.citationRequired,
      prohibitedTopics: p.policy.prohibitedTopics,
      responseMode: p.policy.responseMode,
      maxDirectnessLevel: p.policy.maxDirectnessLevel,
      allowAnswerRevealAfterAttempts: p.policy.allowAnswerRevealAfterAttempts,
      attemptCount: p.context.attemptCount,
      otherLearnerNames: p.otherLearnerNames,
    };
    const fallback = (reason: string): Outcome => ({ status: 'fallback', validation: 'fallback', fallbackReason: reason, model: null });
    let prompt = base;
    for (let round = 0; round < 2; round++) {
      let res;
      try {
        res = await p.llm.complete({
          system: prompt.system,
          messages: prompt.messages,
          responseSchema: COACH_RESPONSE_SCHEMA,
          maxTokens: MAX_OUTPUT_TOKENS,
          correlationId: p.correlationId,
          // gateway 報表依課程拆分用量；不含學員資訊
          tags: [`course:${p.conv.course_id}`, 'purpose:coach_answer'],
        });
        calls.push({ model: res.model, promptTokens: res.promptTokens, completionTokens: res.completionTokens, latencyMs: res.latencyMs, status: 'success', errorCode: null });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        calls.push({ model: p.llm.model, promptTokens: 0, completionTokens: 0, latencyMs: e.latencyMs, status: e.kind === 'timeout' ? 'timeout' : 'error', errorCode: e.kind });
        logger.warn({ kind: e.kind, detail: e.message, correlation_id: p.correlationId }, 'coach provider call failed');
        return fallback(`PROVIDER_${e.kind.toUpperCase()}`);
      }
      if (round === 0) emit({ event: 'stage', data: { stage: 'validating' } });
      if (res.finishReason === 'refusal') return fallback('MODEL_REFUSED');
      const parsed = parseModelAnswer(res.content);
      const verdict: Verdict = parsed.ok ? validateAnswer(parsed.value, vctx) : { verdict: 'REPAIR', reason: 'SCHEMA_INVALID', detail: parsed.detail };
      const validation = round === 0 ? 'passed' : 'repaired';
      if (parsed.ok && verdict.verdict === 'PASS') {
        return { status: parsed.value.status === 'cannot_modify_assessment' ? 'cannot_modify_assessment' : 'answered', validation, fallbackReason: null, model: parsed.value };
      }
      if (parsed.ok && verdict.verdict === 'PASS_AS_FALLBACK') return { status: 'insufficient_evidence', validation, fallbackReason: null, model: parsed.value };
      if (parsed.ok && verdict.verdict === 'PASS_AS_NOTICE') return { status: 'out_of_scope', validation, fallbackReason: null, model: parsed.value };
      if (verdict.verdict === 'REJECT') {
        // 安全事件：不修正，直接替代並告警（SD §10.4）
        logger.warn({ reason: verdict.reason, correlation_id: p.correlationId, conversation_id: p.conv.id }, 'coach answer rejected');
        return fallback(verdict.reason);
      }
      if (verdict.verdict !== 'REPAIR' || round === 1) return fallback(verdict.verdict === 'REPAIR' ? verdict.reason : 'VALIDATION_FAILED');
      prompt = withRepair(base, res.content, verdict.reason);
    }
    return fallback('VALIDATION_FAILED');
  }

  private answerText(o: Outcome): string {
    switch (o.status) {
      case 'answered':
      case 'cannot_modify_assessment':
        return o.model!.answer;
      case 'insufficient_evidence':
        return COACH_TEXT.insufficientEvidence;
      case 'out_of_scope':
        return COACH_TEXT.outOfScope;
      case 'fallback':
        // gateway 金鑰預算用完或限流：暫時性，請學員稍後再試
        return o.fallbackReason === 'PROVIDER_QUOTA' ? COACH_TEXT.resting : COACH_TEXT.fallback;
    }
  }

  private async persist(p: PreparedQuestion, o: Outcome, calls: UsageCall[]): Promise<CoachAnswerDto> {
    const text = this.answerText(o);
    const cited = (o.status === 'answered' || o.status === 'cannot_modify_assessment') && o.model ? o.model.citations : [];
    const followUps = o.status === 'answered' && p.policy.followUpQuestions && o.model ? o.model.follow_up_questions : [];
    const byChunk = new Map(p.chunks.map((c) => [c.chunkId, c]));
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const u = await c.query<{ message_count: number }>(
        `UPDATE coach_conversations SET message_count = message_count + 2, last_message_at = now() WHERE id = $1 RETURNING message_count`,
        [p.conv.id],
      );
      const seq = u.rows[0]!.message_count;
      await c.query(
        `INSERT INTO coach_messages (organization_id, conversation_id, seq_no, role, content, correlation_id) VALUES ($1, $2, $3, 'user', $4, $5)`,
        [p.conv.organization_id, p.conv.id, seq - 1, p.question, p.correlationId],
      );
      const snapshot = { ...p.policy, status: o.status, followUps, prompt: COACH_PROMPT_VERSION, provider: p.llm.name, piiFlags: p.pii, chunks: p.chunks.length };
      const m = await c.query<{ id: string }>(
        `INSERT INTO coach_messages (organization_id, conversation_id, seq_no, role, content, policy_snapshot, validation_status, fallback_reason, citation_count, correlation_id)
         VALUES ($1, $2, $3, 'assistant', $4, $5::jsonb, $6, $7, $8, $9) RETURNING id`,
        [p.conv.organization_id, p.conv.id, seq, text, JSON.stringify(snapshot), o.validation, o.fallbackReason, cited.length, p.correlationId],
      );
      const messageId = m.rows[0]!.id;
      const citations: CoachCitationDto[] = [];
      for (const x of cited) {
        const chunk = byChunk.get(x.chunk_id)!;
        const r = await c.query<{ id: string }>(
          `INSERT INTO coach_citations (organization_id, message_id, citation_ref, chunk_id, document_version_id, title, page_no, section_path, char_start, char_end)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [p.conv.organization_id, messageId, x.citation_id, x.chunk_id, chunk.documentVersionId, chunk.title, chunk.pageNo, chunk.sectionPath, chunk.charStart, chunk.charEnd],
        );
        citations.push({ id: r.rows[0]!.id, citationId: x.citation_id, title: chunk.title, pageNo: chunk.pageNo, sectionPath: chunk.sectionPath, quote: x.quote || null });
      }
      for (const call of calls) {
        await c.query(
          `INSERT INTO ai_usage_records (organization_id, course_id, message_id, purpose, provider, model, prompt_tokens, completion_tokens, latency_ms, status, error_code, correlation_id)
           VALUES ($1, $2, $3, 'coach_answer', $4, $5, $6, $7, $8, $9, $10, $11)`,
          [p.conv.organization_id, p.conv.course_id, messageId, p.llm.name, call.model, call.promptTokens, call.completionTokens, call.latencyMs, call.status, call.errorCode, p.correlationId],
        );
      }
      await c.query('COMMIT');
      return { conversationId: p.conv.id, messageId, status: o.status, answer: text, citations, followUpQuestions: followUps, disclaimer: COACH_TEXT.disclaimer };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  // ------------------------------------------------------------------ 引用原文

  /**
   * 開啟引用的原文（UC-CCH-003）：網址不是授權憑證，每次都重新檢查——引用屬於本人的對話、
   * 教材版本仍綁在對話的課程版本（THR-I-004）。回傳引用段落前後的文字與標示位置。
   */
  async openSource(citationId: string, user: AuthUser): Promise<CitationSourceDto> {
    const r = await this.db.query<{
      id: string;
      citation_ref: string;
      title: string;
      page_no: number | null;
      section_path: string | null;
      char_start: number | null;
      char_end: number | null;
      document_version_id: string | null;
      course_version_id: string;
      organization_id: string;
    }>(
      `SELECT cc.id, cc.citation_ref, cc.title, cc.page_no, cc.section_path, cc.char_start, cc.char_end, cc.document_version_id, c.course_version_id, c.organization_id
         FROM coach_citations cc JOIN coach_messages m ON m.id = cc.message_id JOIN coach_conversations c ON c.id = m.conversation_id
        WHERE cc.id = $1 AND c.learner_id = $2 AND c.organization_id = $3`,
      [citationId, user.id, user.activeOrganizationId],
    );
    const cit = r.rows[0];
    if (!cit) throw new DomainError('NOT_FOUND');
    if (!cit.document_version_id || cit.char_start === null || cit.char_end === null) throw new DomainError('SOURCE_ACCESS_DENIED');
    const d = await this.db.query<{ source_document_id: string; storage_prefix: string }>(
      `SELECT dv.source_document_id, o.storage_prefix FROM knowledge_bindings kb
         JOIN document_versions dv ON dv.id = kb.document_version_id JOIN organizations o ON o.id = dv.organization_id
        WHERE kb.course_version_id = $1 AND kb.document_version_id = $2 AND dv.organization_id = $3`,
      [cit.course_version_id, cit.document_version_id, cit.organization_id],
    );
    if (!d.rows[0]) throw new DomainError('SOURCE_ACCESS_DENIED');
    const keys = documentObjectKeys({ prefix: d.rows[0].storage_prefix, organizationId: cit.organization_id, documentId: d.rows[0].source_document_id, versionId: cit.document_version_id });
    let full: string;
    try {
      full = (await this.storage.get(keys.extracted)).toString('utf8');
    } catch (err) {
      if (err instanceof DomainError) throw err;
      logger.warn({ err, citation_id: citationId }, 'citation source could not be read');
      throw new DomainError('SOURCE_TEMPORARILY_UNAVAILABLE');
    }
    const from = Math.max(0, cit.char_start - SOURCE_WINDOW);
    const to = Math.min(full.length, cit.char_end + SOURCE_WINDOW);
    await this.db.query(`UPDATE coach_citations SET opened_count = opened_count + 1 WHERE id = $1`, [citationId]);
    return {
      citationId: cit.citation_ref,
      title: cit.title,
      pageNo: cit.page_no,
      sectionPath: cit.section_path,
      // 換頁符號換成換行（長度不變，標示位置仍正確）
      text: full.slice(from, to).replace(/\f/g, '\n'),
      highlightStart: cit.char_start - from,
      highlightEnd: cit.char_end - from,
      truncatedBefore: from > 0,
      truncatedAfter: to < full.length,
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  COACH_ANSWER_STATUSES,
  PLATFORM_SETTINGS,
  type CoachAnswerStatus,
  type CoachTranscriptDto,
  type CoachTranscriptListDto,
  type CoachTranscriptSummaryDto,
  type CoachUsageDto,
} from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { CoachSettingsService } from './coach-settings.service.js';
import { loadMessages } from './messages.js';

const PERIOD_DAYS = 30;
const TRANSCRIPT_LIST_LIMIT = 100;

interface SummaryRow {
  id: string;
  learner_id: string;
  display_name: string | null;
  activity_title: string | null;
  trigger_type: 'learner_question' | 'result_trigger';
  message_count: number;
  started_at: Date;
  last_message_at: Date | null;
  transcript_visibility: 'aggregate_only' | 'course_staff';
}

const toSummary = (r: SummaryRow): CoachTranscriptSummaryDto => ({
  id: r.id,
  learnerId: r.learner_id,
  learnerDisplayName: r.display_name ?? '（未設定姓名）',
  activityTitle: r.activity_title,
  triggerType: r.trigger_type,
  messageCount: r.message_count,
  startedAt: new Date(r.started_at).toISOString(),
  lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
});

/** 課程的學員對話（不含教師測試、已匿名化、沒有訊息的空對話） */
const COURSE_CONVERSATIONS = `
  FROM coach_conversations c JOIN course_versions cv ON cv.id = c.course_version_id
 WHERE cv.course_id = $1 AND NOT c.is_test AND c.anonymized_at IS NULL AND c.message_count > 0`;

/**
 * 課程人員的 AI 教練檢視（SD §6.21）：匿名統計與逐字稿。
 * 統計只給彙整數字，且使用學員數未達匿名門檻（平台設定 derived.min_threshold）時不提供（ARCH §14.5）。
 * 逐字稿要「組織目前的政策」與「對話建立時的戳印」都是 course_staff 才能讀（ADR-028 條件 1、4）；
 * 每次讀取都寫稽核，寫不進去請求就失敗（條件 3，由 AuditInterceptor 保證）。
 */
@Injectable()
export class CoachInsightsService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    private readonly settings: CoachSettingsService,
  ) {}

  private async courseOrg(courseId: string): Promise<string> {
    const r = await this.db.query<{ organization_id: string }>(`SELECT organization_id FROM courses WHERE id = $1`, [courseId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return r.rows[0].organization_id;
  }

  private async threshold(): Promise<number> {
    const r = await this.db.query<{ value: unknown }>(`SELECT value FROM system_settings WHERE scope_type = 'platform' AND scope_id IS NULL AND key = 'derived.min_threshold'`);
    const v = Number(r.rows[0]?.value);
    return Number.isInteger(v) && v > 0 ? v : PLATFORM_SETTINGS['derived.min_threshold'].default;
  }

  async usage(courseId: string): Promise<CoachUsageDto> {
    await this.courseOrg(courseId);
    const threshold = await this.threshold();
    const since = `c.started_at >= now() - interval '${PERIOD_DAYS} days'`;
    const totals = await this.db.query<{ learners: number; conversations: number; result_triggered: number }>(
      `SELECT count(DISTINCT c.learner_id)::int AS learners, count(*)::int AS conversations,
              count(*) FILTER (WHERE c.trigger_type = 'result_trigger')::int AS result_triggered
       ${COURSE_CONVERSATIONS} AND ${since}`,
      [courseId],
    );
    const t = totals.rows[0]!;
    const empty: CoachUsageDto = {
      periodDays: PERIOD_DAYS,
      threshold,
      belowThreshold: true,
      learners: null,
      conversations: null,
      questions: null,
      resultTriggered: null,
      statuses: null,
      topDocuments: [],
      activities: [],
    };
    if (t.learners < threshold) return empty;

    const statuses = await this.db.query<{ status: CoachAnswerStatus; n: number }>(
      `SELECT COALESCE(m.policy_snapshot->>'status', CASE WHEN m.validation_status = 'fallback' THEN 'fallback' ELSE 'answered' END) AS status, count(*)::int AS n
         FROM coach_messages m JOIN (SELECT c.id ${COURSE_CONVERSATIONS} AND ${since}) conv ON conv.id = m.conversation_id
        WHERE m.role = 'assistant' GROUP BY 1`,
      [courseId],
    );
    const byStatus = Object.fromEntries(COACH_ANSWER_STATUSES.map((s) => [s, 0])) as Record<CoachAnswerStatus, number>;
    for (const s of statuses.rows) if (s.status in byStatus) byStatus[s.status] = s.n;
    const docs = await this.db.query<{ title: string; n: number }>(
      `SELECT cc.title, count(*)::int AS n
         FROM coach_citations cc JOIN coach_messages m ON m.id = cc.message_id
         JOIN (SELECT c.id ${COURSE_CONVERSATIONS} AND ${since}) conv ON conv.id = m.conversation_id
        GROUP BY cc.title ORDER BY n DESC, cc.title LIMIT 5`,
      [courseId],
    );
    // 各活動：只列出達到門檻的活動，避免「這個活動只有一個人問」而回推
    const acts = await this.db.query<{ activity_id: string; title: string; learners: number; questions: number }>(
      `SELECT c.activity_id, a.title, count(DISTINCT c.learner_id)::int AS learners, (sum(c.message_count) / 2)::int AS questions
         FROM coach_conversations c JOIN course_versions cv ON cv.id = c.course_version_id JOIN activities a ON a.id = c.activity_id
        WHERE cv.course_id = $1 AND NOT c.is_test AND c.anonymized_at IS NULL AND c.message_count > 0 AND ${since}
        GROUP BY c.activity_id, a.title HAVING count(DISTINCT c.learner_id) >= $2
        ORDER BY questions DESC, a.title LIMIT 20`,
      [courseId, threshold],
    );
    return {
      ...empty,
      belowThreshold: false,
      learners: t.learners,
      conversations: t.conversations,
      questions: Object.values(byStatus).reduce((a, b) => a + b, 0),
      resultTriggered: t.result_triggered,
      statuses: byStatus,
      topDocuments: docs.rows.map((d) => ({ title: d.title, citations: d.n })),
      activities: acts.rows.map((a) => ({ activityId: a.activity_id, title: a.title, questions: a.questions, learners: a.learners })),
    };
  }

  private summarySql(extra: string): string {
    return `SELECT c.id, c.learner_id, u.display_name, a.title AS activity_title, c.trigger_type, c.message_count, c.started_at, c.last_message_at, c.transcript_visibility
              FROM coach_conversations c JOIN course_versions cv ON cv.id = c.course_version_id
              JOIN users u ON u.id = c.learner_id LEFT JOIN activities a ON a.id = c.activity_id
             WHERE cv.course_id = $1 AND NOT c.is_test AND c.anonymized_at IS NULL AND c.message_count > 0 ${extra}`;
  }

  async transcripts(courseId: string): Promise<CoachTranscriptListDto> {
    const orgId = await this.courseOrg(courseId);
    const { transcriptVisibility: policy } = await this.settings.get(orgId);
    const total = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n ${COURSE_CONVERSATIONS}`, [courseId]);
    if (policy !== 'course_staff') return { policy, data: [], hiddenCount: total.rows[0]!.n };
    const visible = await this.db.query<SummaryRow>(
      `${this.summarySql(`AND c.transcript_visibility = 'course_staff'`)} ORDER BY COALESCE(c.last_message_at, c.started_at) DESC LIMIT ${TRANSCRIPT_LIST_LIMIT}`,
      [courseId],
    );
    const readable = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n ${COURSE_CONVERSATIONS} AND c.transcript_visibility = 'course_staff'`, [courseId]);
    return { policy, data: visible.rows.map(toSummary), hiddenCount: total.rows[0]!.n - readable.rows[0]!.n };
  }

  /** 一段逐字稿；不可讀 → 403 COACH_TRANSCRIPT_NOT_VISIBLE（對話不屬於此課程 → 404） */
  async transcript(courseId: string, conversationId: string): Promise<CoachTranscriptDto> {
    const orgId = await this.courseOrg(courseId);
    const r = await this.db.query<SummaryRow>(`${this.summarySql('AND c.id = $2')}`, [courseId, conversationId]);
    const c = r.rows[0];
    if (!c) throw new DomainError('NOT_FOUND');
    const { transcriptVisibility: policy } = await this.settings.get(orgId);
    if (policy !== 'course_staff' || c.transcript_visibility !== 'course_staff') {
      throw new DomainError('COACH_TRANSCRIPT_NOT_VISIBLE', 'Transcript is not visible to course staff', [
        { issue: policy !== 'course_staff' ? 'organization_policy' : 'conversation_stamp' },
      ]);
    }
    return { ...toSummary(c), messages: await loadMessages(this.db, conversationId) };
  }
}

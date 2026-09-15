import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  DERIVED_INDEX_JOB,
  PLATFORM_SETTINGS,
  type CommonErrorInsightDto,
  type FaqCitationDto,
  type FaqDto,
  type FaqInsightsDto,
  type FaqKind,
  type FrequentQuestionInsightDto,
  type LearnerFaqDto,
} from '@iac/contracts';
import { anonymizeQuestion, clusterQuestions, questionSimilarity, type QuestionItem } from '@iac/domain';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { enqueueJobTx } from '../../../common/job-queue.js';

type Q = pg.Pool | pg.PoolClient;

/** 線索的統計期間 */
const PERIOD_DAYS = 90;
/** 參與分群的提問上限（最近的優先） */
const MAX_QUESTIONS = 2000;
/** 線索與既有 FAQ 視為同一題的相似度 */
const SAME_QUESTION = 0.5;

const rejected = (issue: string) => new DomainError('VALIDATION_FAILED', issue, [{ issue }]);

interface FaqRow {
  id: string;
  kind: FaqKind;
  status: string;
  cluster_key: string;
  cluster_size: number;
  created_at: Date;
  version_no: number;
  question: string;
  answer: string;
  citations: unknown;
  updated_at: Date;
  updated_by: string | null;
}

/** FAQ 目前的版本；只含老師撰寫的項目（verified／retired） */
const SELECT_FAQ = `
  SELECT dk.id, dk.kind, dk.status, dk.cluster_key, dk.cluster_size, dk.created_at,
         v.version_no, v.question, v.answer, v.citations, v.created_at AS updated_at, u.display_name AS updated_by
    FROM derived_knowledge dk
    JOIN course_versions cv ON cv.id = dk.course_version_id
    JOIN derived_knowledge_versions v ON v.id = dk.current_version_id
    LEFT JOIN users u ON u.id = v.authored_by
   WHERE cv.course_id = $1 AND dk.kind IN ('faq', 'common_error') AND dk.status IN ('verified', 'retired')`;

function toDto(r: FaqRow): FaqDto {
  const source = r.cluster_key.startsWith('manual:') ? 'teacher' : 'insight';
  return {
    id: r.id,
    kind: r.kind,
    question: r.question,
    answer: r.answer,
    status: r.status === 'retired' ? 'retired' : 'verified',
    source,
    learners: source === 'insight' ? r.cluster_size : null,
    versionNo: r.version_no,
    citations: Array.isArray(r.citations) ? (r.citations as FaqCitationDto[]) : [],
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    updatedByName: r.updated_by,
  };
}

/** 題目／參數／項目的名稱（依活動設定；老師看得到設定，這裡只取名稱） */
function targetLabel(config: Record<string, unknown> | null, target: string | null): string | null {
  if (!target || !config) return null;
  for (const list of ['questions', 'parameters', 'items', 'options']) {
    const arr = config[list];
    if (!Array.isArray(arr)) continue;
    const hit = arr.find((x: unknown) => !!x && typeof x === 'object' && (x as { id?: unknown }).id === target) as Record<string, unknown> | undefined;
    if (hit) return String(hit['prompt'] ?? hit['label'] ?? hit['text'] ?? target).slice(0, 120);
  }
  return null;
}

export interface FaqInput {
  kind: FaqKind;
  question: string;
  answer: string;
  citations: FaqCitationDto[];
  /** 由系統線索建立時的線索代號（issue:… 或 q:…） */
  insightKey: string | null;
  learners: number | null;
}

/**
 * 常見問答與常見錯誤（SA UC-KNW-004～008、SD §6.27）。
 * - FAQ 屬於課程：存在 derived_knowledge（course_version_id 為建立當下的版本，只為滿足資料表），列出、檢索都以課程為單位。
 * - 老師撰寫或由線索建立的項目直接生效（status = verified、evidence_status = grounded——老師就是依據）；
 *   編輯建立新的 derived_knowledge_versions（舊版保留，AC-DRV-004）；下架為 retired（紀錄保留，AC-DRV-007）。
 * - 任何改變都在同一交易排入 derived.index，由 worker 更新檢索索引（AI 教練以權重 1.3 優先引用）。
 * - 線索：作答結果的問題代碼與學員提問（去識別化後分群），只顯示達匿名門檻（derived.min_threshold）者。
 */
@Injectable()
export class FaqService {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  private async threshold(): Promise<number> {
    const r = await this.db.query<{ value: unknown }>(`SELECT value FROM system_settings WHERE scope_type = 'platform' AND scope_id IS NULL AND key = 'derived.min_threshold'`);
    const v = Number(r.rows[0]?.value);
    return Number.isInteger(v) && v > 0 ? v : PLATFORM_SETTINGS['derived.min_threshold'].default;
  }

  private async course(q: Q, courseId: string): Promise<{ organizationId: string; versionId: string | null }> {
    const r = await q.query<{ organization_id: string; version_id: string | null }>(
      `SELECT c.organization_id,
              (SELECT id FROM course_versions WHERE course_id = c.id ORDER BY (status = 'published') DESC, version_no DESC LIMIT 1) AS version_id
         FROM courses c WHERE c.id = $1`,
      [courseId],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return { organizationId: r.rows[0].organization_id, versionId: r.rows[0].version_id };
  }

  private reindexTx(c: pg.PoolClient, courseId: string, organizationId: string): Promise<boolean> {
    return enqueueJobTx(c, { jobType: DERIVED_INDEX_JOB.type, queue: DERIVED_INDEX_JOB.queue, maxAttempts: DERIVED_INDEX_JOB.maxAttempts, payload: { courseId }, organizationId });
  }

  private async one(q: Q, courseId: string, id: string): Promise<FaqDto> {
    const r = await q.query<FaqRow>(`${SELECT_FAQ} AND dk.id = $2`, [courseId, id]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return toDto(r.rows[0]);
  }

  async list(courseId: string, includeRetired: boolean): Promise<FaqDto[]> {
    await this.course(this.db, courseId);
    const r = await this.db.query<FaqRow>(`${SELECT_FAQ} ${includeRetired ? '' : `AND dk.status = 'verified'`} ORDER BY dk.status, dk.kind, v.created_at DESC`, [courseId]);
    return r.rows.map(toDto);
  }

  async create(courseId: string, input: FaqInput, actorId: string): Promise<FaqDto> {
    return this.tx(async (c) => {
      await c.query(`SELECT 1 FROM courses WHERE id = $1 FOR UPDATE`, [courseId]);
      const co = await this.course(c, courseId);
      if (!co.versionId) throw rejected('course_has_no_version');
      if (input.insightKey) {
        const dup = await c.query(
          `SELECT 1 FROM derived_knowledge dk JOIN course_versions cv ON cv.id = dk.course_version_id
            WHERE cv.course_id = $1 AND dk.status = 'verified' AND dk.cluster_key LIKE $2`,
          [courseId, `${input.insightKey}#%`],
        );
        if (dup.rowCount) throw rejected('faq_exists');
      }
      // cluster_key：老師撰寫為 manual:…；由線索建立為「線索代號#亂數」（下架後可以再建立，唯一索引不衝突）
      const clusterKey = input.insightKey ? `${input.insightKey}#${randomUUID().slice(0, 8)}` : `manual:${randomUUID()}`;
      const dk = await c.query<{ id: string }>(
        `INSERT INTO derived_knowledge (organization_id, course_version_id, kind, status, evidence_status, cluster_key, cluster_size, first_seen_at, last_seen_at, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, 'verified', 'grounded', $4, $5, now(), now(), $6, now()) RETURNING id`,
        [co.organizationId, co.versionId, input.kind, clusterKey, input.learners ?? 1, actorId],
      );
      const id = dk.rows[0]!.id;
      const v = await c.query<{ id: string }>(
        `INSERT INTO derived_knowledge_versions (derived_knowledge_id, version_no, question, answer, citations, authored_by_type, authored_by)
         VALUES ($1, 1, $2, $3, $4::jsonb, 'user', $5) RETURNING id`,
        [id, input.question, input.answer, JSON.stringify(input.citations), actorId],
      );
      await c.query(`UPDATE derived_knowledge SET current_version_id = $2 WHERE id = $1`, [id, v.rows[0]!.id]);
      await this.reindexTx(c, courseId, co.organizationId);
      return this.one(c, courseId, id);
    });
  }

  /** 編輯：建立新版本（舊版保留，AC-DRV-004） */
  async update(courseId: string, id: string, input: { question: string; answer: string; citations?: FaqCitationDto[] | undefined }, actorId: string): Promise<{ before: FaqDto; after: FaqDto }> {
    return this.tx(async (c) => {
      const before = await this.one(c, courseId, id);
      if (before.status !== 'verified') throw rejected('faq_retired');
      await c.query(`SELECT 1 FROM derived_knowledge WHERE id = $1 FOR UPDATE`, [id]);
      const v = await c.query<{ id: string }>(
        `INSERT INTO derived_knowledge_versions (derived_knowledge_id, version_no, question, answer, citations, authored_by_type, authored_by)
         SELECT $1, COALESCE(max(version_no), 0) + 1, $2, $3, $4::jsonb, 'user', $5 FROM derived_knowledge_versions WHERE derived_knowledge_id = $1
         RETURNING id`,
        [id, input.question, input.answer, JSON.stringify(input.citations ?? before.citations), actorId],
      );
      await c.query(`UPDATE derived_knowledge SET current_version_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [id, v.rows[0]!.id, actorId]);
      const co = await this.course(c, courseId);
      await this.reindexTx(c, courseId, co.organizationId);
      return { before, after: await this.one(c, courseId, id) };
    });
  }

  /** 下架：不再給學員看、不再被 AI 教練引用；紀錄保留（AC-DRV-007） */
  async retire(courseId: string, id: string, actorId: string): Promise<FaqDto> {
    return this.tx(async (c) => {
      const cur = await this.one(c, courseId, id);
      if (cur.status !== 'verified') throw rejected('faq_retired');
      await c.query(`UPDATE derived_knowledge SET status = 'retired', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, actorId]);
      const co = await this.course(c, courseId);
      await this.reindexTx(c, courseId, co.organizationId);
      return this.one(c, courseId, id);
    });
  }

  /** 學員看得到的 FAQ：本人的選課所屬課程、已生效的項目 */
  async forLearner(enrollmentId: string, userId: string): Promise<LearnerFaqDto[]> {
    const e = await this.db.query<{ course_id: string }>(`SELECT course_id FROM enrollments WHERE id = $1 AND user_id = $2 AND status <> 'rejected'`, [enrollmentId, userId]);
    if (!e.rows[0]) throw new DomainError('NOT_FOUND');
    const r = await this.db.query<FaqRow>(`${SELECT_FAQ} AND dk.status = 'verified' ORDER BY dk.kind, v.created_at DESC`, [e.rows[0].course_id]);
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, question: x.question, answer: x.answer }));
  }

  /** 系統整理的線索：很多人答錯的地方、很多人問的問題（只有達匿名門檻者） */
  async insights(courseId: string): Promise<FaqInsightsDto> {
    await this.course(this.db, courseId);
    const threshold = await this.threshold();
    const active = await this.db.query<{ id: string; cluster_key: string; question: string }>(
      `SELECT dk.id, dk.cluster_key, v.question FROM derived_knowledge dk
         JOIN course_versions cv ON cv.id = dk.course_version_id JOIN derived_knowledge_versions v ON v.id = dk.current_version_id
        WHERE cv.course_id = $1 AND dk.status = 'verified'`,
      [courseId],
    );
    const byKey = (key: string) => active.rows.find((f) => f.cluster_key.startsWith(`${key}#`))?.id ?? null;

    const errs = await this.db.query<{
      activity_id: string;
      title: string;
      config: Record<string, unknown> | null;
      code: string;
      target: string | null;
      learners: number;
      occurrences: number;
      last_seen: Date;
    }>(
      `SELECT a.id AS activity_id, a.title, a.config, i->>'code' AS code, NULLIF(i->>'target', '') AS target,
              count(DISTINCT e.user_id)::int AS learners, count(*)::int AS occurrences, max(lr.evaluated_at) AS last_seen
         FROM learning_results lr
         JOIN enrollments e ON e.id = lr.enrollment_id
         JOIN activities a ON a.id = lr.activity_id
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(lr.issues, '[]'::jsonb)) i
        WHERE e.course_id = $1 AND lr.evaluated_at >= now() - make_interval(days => $3)
          AND jsonb_typeof(i) = 'object' AND COALESCE(i->>'code', '') <> ''
        GROUP BY a.id, i->>'code', NULLIF(i->>'target', '')
       HAVING count(DISTINCT e.user_id) >= $2
        ORDER BY learners DESC, occurrences DESC
        LIMIT 30`,
      [courseId, threshold, PERIOD_DAYS],
    );
    const commonErrors: CommonErrorInsightDto[] = errs.rows.map((x) => {
      const key = `issue:${x.activity_id}:${x.code}:${x.target ?? '-'}`;
      return {
        key,
        activityId: x.activity_id,
        activityTitle: x.title,
        code: x.code,
        target: x.target,
        targetLabel: targetLabel(x.config, x.target),
        learners: x.learners,
        occurrences: x.occurrences,
        lastSeenAt: x.last_seen.toISOString(),
        faqId: byKey(key),
      };
    });

    // 學員的提問（不含教師測試、已匿名化的對話）；姓名、學號以本課程的學員名單比對後代換
    const qs = await this.db.query<{ content: string; learner_id: string; created_at: Date }>(
      `SELECT m.content, c.learner_id, m.created_at
         FROM coach_messages m
         JOIN coach_conversations c ON c.id = m.conversation_id
         JOIN course_versions cv ON cv.id = c.course_version_id
        WHERE cv.course_id = $1 AND m.role = 'user' AND c.trigger_type = 'learner_question' AND NOT c.is_test AND c.anonymized_at IS NULL
          AND m.created_at >= now() - make_interval(days => $2)
        ORDER BY m.created_at DESC
        LIMIT ${MAX_QUESTIONS}`,
      [courseId, PERIOD_DAYS],
    );
    let frequentQuestions: FrequentQuestionInsightDto[] = [];
    if (qs.rows.length) {
      const people = await this.db.query<{ display_name: string | null; member_no: string | null }>(
        `SELECT DISTINCT u.display_name, mp.member_no
           FROM enrollments e JOIN users u ON u.id = e.user_id
           LEFT JOIN member_profiles mp ON mp.organization_id = e.organization_id AND mp.user_id = e.user_id
          WHERE e.course_id = $1`,
        [courseId],
      );
      const known = {
        names: people.rows.map((p) => p.display_name ?? '').filter(Boolean),
        ids: people.rows.map((p) => p.member_no ?? '').filter(Boolean),
      };
      // 學員只以不透明編號區分，身分不進入分群（SD §10.8）
      const refs = new Map<string, number>();
      const refOf = (id: string) => {
        if (!refs.has(id)) refs.set(id, refs.size);
        return refs.get(id)!;
      };
      const items: QuestionItem[] = qs.rows.map((r) => ({ learner: refOf(r.learner_id), text: anonymizeQuestion(r.content, known), at: r.created_at.getTime() }));
      frequentQuestions = clusterQuestions(items, { threshold }).map((c) => ({
        key: c.key,
        question: c.question,
        learners: c.learners,
        questions: c.questions,
        lastAskedAt: new Date(c.lastAt).toISOString(),
        faqId: byKey(c.key) ?? active.rows.find((f) => questionSimilarity(f.question, c.question) >= SAME_QUESTION)?.id ?? null,
      }));
    }
    return { periodDays: PERIOD_DAYS, threshold, commonErrors, frequentQuestions };
  }
}

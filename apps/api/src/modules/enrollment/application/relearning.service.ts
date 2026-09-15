import { Inject, Injectable } from '@nestjs/common';
import type { EnrollmentDto, EnrollmentStatus, NewAttemptPolicy, RelearningDto, RelearningScope } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { COMPLETION_ENGINE, type CompletionEngine } from '../../completion/completion.contracts.js';
import { LEARNING_EVENTS, type LearningEventWriter } from '../../learning-record/learning-record.contracts.js';
import { LICENSE_EVALUATOR, type LicenseEvaluator } from '../../license/license.contracts.js';
import { NOTIFIER, type Notifier } from '../../notification/notification.contracts.js';
import { EnrollmentService } from './enrollment.service.js';
import { enrollmentNotice } from './notify-helpers.js';

const invalid = (field: string, issue: string) => new DomainError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
const rejected = (issue: string, params?: Record<string, string>) => new DomainError('VALIDATION_FAILED', issue, [{ issue, ...(params && { params }) }]);

/** 可以指派重修的選課狀態；已完成者會轉為重新開啟 */
const RELEARNABLE: readonly EnrollmentStatus[] = ['active', 'reopened', 'completed'];

export interface RelearningInput {
  scopeType: RelearningScope;
  scopeId: string | null;
  reason: string;
  dueDate: string | null;
  newAttemptPolicy: NewAttemptPolicy;
}

/**
 * 重新開啟與重修（SA UC-ENR-007／009、§7.2、SD §6.25）。歷史作答與結果一律保留（INV-6）：
 * - 重新開啟：已完成 → 重新開啟，成績照舊，學員可以繼續練習；再次符合完成條件時回到已完成（證書不重發）。
 * - 重修：指定範圍（整門課／單元／課節／活動），範圍內的活動只採計指派之後的結果，預設作答次數重新計算；
 *   已完成的選課轉為重新開啟。完成判定的實作在 CompletionEngine（relearning_assignments）。
 * 已完成 → 重新開啟會讓學員重新計入授權的學員數，因此在交易內檢查（同一人另有進行中的課程時不會多算）。
 */
@Injectable()
export class RelearningService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    private readonly enrollments: EnrollmentService,
    @Inject(LEARNING_EVENTS) private readonly events: LearningEventWriter,
    @Inject(COMPLETION_ENGINE) private readonly engine: CompletionEngine,
    @Inject(LICENSE_EVALUATOR) private readonly license: LicenseEvaluator,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
  ) {}

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

  /** 計入授權的學員數：active／suspended／reopened 的不重複學員（與 LicenseService.usage 相同定義） */
  private async ensureSeat(c: pg.PoolClient, userId: string): Promise<void> {
    const max = (await this.license.evaluate()).maxActiveLearners;
    if (max === undefined) return;
    const r = await c.query<{ n: number; mine: boolean }>(
      `SELECT count(DISTINCT user_id)::int AS n, COALESCE(bool_or(user_id = $1), false) AS mine
         FROM enrollments WHERE status IN ('active', 'suspended', 'reopened')`,
      [userId],
    );
    if (!r.rows[0]!.mine && r.rows[0]!.n >= max) throw new DomainError('LICENSE_LIMIT_EXCEEDED');
  }

  /** 重新開啟（UC-ENR-009）：已完成 → 重新開啟 */
  async reopen(enrollmentId: string, reason: string | null): Promise<EnrollmentDto> {
    return this.tx(async (c) => {
      const e = await c.query<{ status: EnrollmentStatus; user_id: string }>(`SELECT status, user_id FROM enrollments WHERE id = $1 FOR UPDATE`, [enrollmentId]);
      const x = e.rows[0];
      if (!x) throw new DomainError('NOT_FOUND');
      if (x.status !== 'completed') throw rejected('invalid_transition', { from: x.status });
      await this.ensureSeat(c, x.user_id);
      await c.query(`UPDATE enrollments SET status = 'reopened', completed_at = NULL, updated_at = now() WHERE id = $1`, [enrollmentId]);
      await this.events.recordTx(c, enrollmentId, [{ eventType: 'course.reopened', payload: { via: 'reopen', scope: 'course', ...(reason && { reason }) } }]);
      const n = await enrollmentNotice(c, enrollmentId);
      await this.notifier.notifyTx(c, { userIds: [n.userId], organizationId: n.organizationId, type: 'enrollment.reopened', payload: n.payload });
      return this.enrollments.get(enrollmentId, c);
    });
  }

  /** 指派重修（UC-ENR-007、AC-LRN-004） */
  async assign(enrollmentId: string, input: RelearningInput, actorId: string): Promise<{ relearning: RelearningDto; enrollment: EnrollmentDto; before: EnrollmentStatus }> {
    if (input.scopeType === 'course' && input.scopeId) throw invalid('scopeId', 'scope_must_be_empty');
    if (input.scopeType !== 'course' && !input.scopeId) throw invalid('scopeId', 'scope_required');
    return this.tx(async (c) => {
      const e = await c.query<{ status: EnrollmentStatus; user_id: string; organization_id: string; course_version_id: string }>(
        `SELECT status, user_id, organization_id, course_version_id FROM enrollments WHERE id = $1 FOR UPDATE`,
        [enrollmentId],
      );
      const x = e.rows[0];
      if (!x) throw new DomainError('NOT_FOUND');
      if (!RELEARNABLE.includes(x.status)) throw rejected('invalid_transition', { from: x.status });

      // 範圍必須在學員綁定的版本中，且至少有一個活動（沒有活動就沒有東西可以重修）
      const acts = await c.query<{ id: string }>(
        `SELECT a.id FROM activities a JOIN lessons l ON l.id = a.lesson_id
          WHERE a.course_version_id = $1
            AND ($2::text = 'course' OR ($2::text = 'module' AND l.module_id = $3::uuid)
                 OR ($2::text = 'lesson' AND a.lesson_id = $3::uuid) OR ($2::text = 'activity' AND a.id = $3::uuid))`,
        [x.course_version_id, input.scopeType, input.scopeId],
      );
      if (!acts.rowCount) throw invalid('scopeId', 'scope_not_in_version');
      if (x.status === 'completed') await this.ensureSeat(c, x.user_id);

      const ins = await c.query<{ id: string }>(
        `INSERT INTO relearning_assignments (organization_id, enrollment_id, scope_type, scope_id, reason, assigned_by, due_date, new_attempt_policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [x.organization_id, enrollmentId, input.scopeType, input.scopeId, input.reason, actorId, input.dueDate, input.newAttemptPolicy],
      );
      const relearningId = ins.rows[0]!.id;
      // 範圍內進行中的作答作廢：重修從新的作答開始
      await c.query(
        `UPDATE learning_attempts SET status = 'abandoned', updated_at = now() WHERE enrollment_id = $1 AND status = 'in_progress' AND activity_id = ANY($2::uuid[])`,
        [enrollmentId, acts.rows.map((a) => a.id)],
      );
      await c.query(
        `UPDATE enrollments
            SET status = CASE WHEN status = 'completed' THEN 'reopened'::enrollment_status ELSE status END,
                completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END,
                due_date = COALESCE($2::timestamptz, due_date),
                updated_at = now()
          WHERE id = $1`,
        [enrollmentId, input.dueDate],
      );
      await this.events.recordTx(c, enrollmentId, [
        {
          eventType: 'course.reopened',
          payload: { via: 'relearning', scope: input.scopeType, ...(input.scopeId && { scope_id: input.scopeId }), reason: input.reason, relearning_assignment_id: relearningId },
        },
      ]);
      // 名單上的進度立即反映重修（只寫快照，不改狀態；完成與否等學員下次送出作答時判定）
      const p = await this.engine.progress(enrollmentId, c);
      await this.engine.snapshot(p, this.engine.evaluate(p), c);
      const relearning = p.relearning.assignments.find((r) => r.id === relearningId)!;
      // 通知學員（SD §6.26）：原因只在站內通知，信件只說有新的重修
      const n = await enrollmentNotice(c, enrollmentId);
      await this.notifier.notifyTx(c, {
        userIds: [n.userId],
        organizationId: n.organizationId,
        type: 'relearning.assigned',
        payload: { ...n.payload, scopeType: relearning.scopeType, scopeTitle: relearning.scopeTitle, reason: relearning.reason },
      });
      return { relearning, enrollment: await this.enrollments.get(enrollmentId, c), before: x.status };
    });
  }
}

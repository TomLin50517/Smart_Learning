import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  BUILTIN_COMPONENTS,
  CERTIFICATE_JOB,
  LEARNABLE_STATUSES,
  certificateJobKey,
  type ActivityResultDto,
  type ApproverRole,
  type ActivityRuntimeDto,
  type EnrollmentStatus,
  type LearnerOutlineDto,
  type LearnerProgressDto,
  type OutlineActivityState,
  type ResultIssue,
  type ResultStatus,
} from '@iac/contracts';
import { activityAvailability, canonicalJson, manualApprovalRoles, resolveEvaluator } from '@iac/domain';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { enqueueJobTx } from '../../../common/job-queue.js';
import { COMPLETION_ENGINE, type CompletionEngine, type EnrollmentProgress } from '../../completion/completion.contracts.js';
import type { ServerEvent } from '../learning-record.contracts.js';
import { LearningEventService } from './learning-events.service.js';
import { toLearningTime } from './learning-time.js';

const rejected = (issue: string) => new DomainError('VALIDATION_FAILED', issue, [{ issue }]);
const DONE = new Set(['passed', 'completed']);

/**
 * 學員的學習 Runtime（UC-LRN-001/002/004/006/007/008、SA SEQ-03、SD §6.9、§6.12）。
 * 學員端點都是 self 範圍：授權只確認「是學員」，選課歸屬在此逐一驗證——不是本人的一律 404（AC-LRN-007）。
 */
@Injectable()
export class LearningService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(COMPLETION_ENGINE) private readonly engine: CompletionEngine,
    private readonly events: LearningEventService,
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

  /** 學員在此活動所屬版本的選課（未退課者）；沒有 → 404 */
  private async enrollmentFor(activityId: string, userId: string, q: pg.Pool | pg.PoolClient, lock = false) {
    const r = await q.query<{ id: string; status: EnrollmentStatus }>(
      `SELECT e.id, e.status FROM activities a JOIN enrollments e ON e.course_version_id = a.course_version_id
        WHERE a.id = $1 AND e.user_id = $2 AND e.status NOT IN ('withdrawn', 'rejected')
        ORDER BY e.enrolled_at DESC LIMIT 1 ${lock ? 'FOR UPDATE OF e' : ''}`,
      [activityId, userId],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return r.rows[0];
  }

  private availability(p: EnrollmentProgress) {
    return activityAvailability(
      { navigationMode: p.navigationMode, modules: p.modules.map((m) => ({ id: m.id, activities: m.lessons.flatMap((l) => l.activities) })) },
      p.ctx,
    );
  }

  /** 找出活動並確認可開始：選課可學習（否則 409）、已解鎖（否則 403） */
  private async learnableActivity(activityId: string, userId: string, q: pg.Pool | pg.PoolClient, lock = false) {
    const enr = await this.enrollmentFor(activityId, userId, q, lock);
    if (!LEARNABLE_STATUSES.includes(enr.status)) throw new DomainError('ENROLLMENT_NOT_ACTIVE');
    const p = await this.engine.progress(enr.id, q);
    const activity = p.modules.flatMap((m) => m.lessons.flatMap((l) => l.activities)).find((a) => a.id === activityId)!;
    const av = this.availability(p)[activityId];
    if (!av?.unlocked) {
      throw new DomainError('ACTIVITY_PREREQUISITE_NOT_MET', 'Activity is locked', [{ issue: av?.reason === 'sequence' ? 'sequence' : 'prerequisite' }]);
    }
    return { enrollmentId: enr.id, progress: p, activity };
  }

  /** 學員的課程大綱：結構、各活動狀態、進度與學習時間（不含活動設定與答案） */
  async outline(enrollmentId: string, userId: string): Promise<LearnerOutlineDto> {
    const own = await this.db.query<{ title: string; version_no: number }>(
      `SELECT c.title, cv.version_no FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN course_versions cv ON cv.id = e.course_version_id
        WHERE e.id = $1 AND e.user_id = $2 AND e.status <> 'rejected'`,
      [enrollmentId, userId],
    );
    if (!own.rows[0]) throw new DomainError('NOT_FOUND');
    return this.buildOutline(await this.engine.progress(enrollmentId), own.rows[0].title, own.rows[0].version_no);
  }

  /** 課程人員檢視單一學員（GET /enrollments/{id}/progress）：與學員看到的大綱相同，另附學員資料。授權由路由守門 */
  async staffProgress(enrollmentId: string): Promise<LearnerProgressDto> {
    const r = await this.db.query<{ title: string; version_no: number; user_id: string; display_name: string; email: string }>(
      `SELECT c.title, cv.version_no, u.id AS user_id, u.display_name, u.email::text AS email
         FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN course_versions cv ON cv.id = e.course_version_id JOIN users u ON u.id = e.user_id
        WHERE e.id = $1`,
      [enrollmentId],
    );
    const x = r.rows[0];
    if (!x) throw new DomainError('NOT_FOUND');
    const p = await this.engine.progress(enrollmentId);
    const given = await this.db.query<{ approver_role: string; approved_at: Date; note: string | null; display_name: string }>(
      `SELECT ca.approver_role, ca.approved_at, ca.note, u.display_name
         FROM completion_approvals ca JOIN users u ON u.id = ca.approved_by
        WHERE ca.enrollment_id = $1 ORDER BY ca.approved_at`,
      [enrollmentId],
    );
    return {
      ...this.buildOutline(p, x.title, x.version_no),
      learner: { id: x.user_id, displayName: x.display_name, email: x.email },
      approval: {
        required: manualApprovalRoles(p.rule?.rule),
        given: given.rows.map((g) => ({ approverRole: g.approver_role, approverName: g.display_name, approvedAt: g.approved_at.toISOString(), note: g.note })),
      },
    };
  }

  private buildOutline(p: EnrollmentProgress, courseTitle: string, versionNo: number): LearnerOutlineDto {
    const ev = this.engine.evaluate(p);
    const av = this.availability(p);
    const stateOf = (id: string): OutlineActivityState => {
      const best = p.ctx.bestResults[id];
      if (best && DONE.has(best.status)) return 'completed';
      if (!av[id]?.unlocked) return 'locked';
      if (p.attempts[id]?.inProgressId) return 'in_progress';
      return best ? 'attempted' : 'available';
    };
    return {
      enrollment: {
        id: p.enrollment.id,
        status: p.enrollment.status,
        canLearn: LEARNABLE_STATUSES.includes(p.enrollment.status),
        courseId: p.enrollment.courseId,
        courseTitle,
        versionNo,
      },
      navigationMode: p.navigationMode,
      modules: p.modules.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        isRequired: m.isRequired,
        lessons: m.lessons.map((l) => ({
          id: l.id,
          title: l.title,
          isRequired: l.isRequired,
          contentBlocks: l.contentBlocks as LearnerOutlineDto['modules'][number]['lessons'][number]['contentBlocks'],
          activities: l.activities.map((a) => {
            const best = p.ctx.bestResults[a.id];
            const state = stateOf(a.id);
            return {
              id: a.id,
              title: a.title,
              activityType: a.activityType,
              isRequired: a.isRequired,
              supported: resolveEvaluator(a.activityType, a.serverEvaluator) !== null,
              state,
              lockReason: state === 'locked' ? av[a.id]?.reason ?? null : null,
              best: best ? { status: best.status as ResultStatus, score: best.score, maxScore: a.maxScore } : null,
              attempts: p.attempts[a.id]?.used ?? 0,
              maxAttempts: a.maxAttempts,
              watchedRatio: a.activityType === 'video' ? p.ctx.videoWatchRatios[a.id] ?? 0 : null,
            };
          }),
        })),
      })),
      progress: {
        requiredTotal: ev.requiredTotal,
        requiredCompleted: ev.requiredCompleted,
        weightedScore: ev.weightedScore,
        completed: ev.completed,
        value: ev.value,
        blockingReasons: ev.blockingReasons,
      },
      time: toLearningTime(p),
    };
  }

  /** 活動 Runtime：config 以白名單回傳，answer_key 不在查詢欄位中（SA THR-T-002、SD §7.3.4） */
  async runtime(activityId: string, userId: string): Promise<ActivityRuntimeDto> {
    const { enrollmentId, progress, activity } = await this.learnableActivity(activityId, userId, this.db);
    const a = await this.db.query<{ config: Record<string, unknown>; component_type: string | null; schema_version: string | null }>(
      `SELECT a.config, d.component_type, d.schema_version FROM activities a
         LEFT JOIN interactive_definitions d ON d.id = a.interactive_definition_id WHERE a.id = $1`,
      [activityId],
    );
    const prev = await this.db.query<{ attempt_no: number; status: ResultStatus; score: string | null; max_score: string }>(
      `SELECT la.attempt_no, lr.status, lr.score, lr.max_score FROM learning_results lr JOIN learning_attempts la ON la.id = lr.attempt_id
        WHERE lr.enrollment_id = $1 AND lr.activity_id = $2 ORDER BY la.attempt_no DESC LIMIT 1`,
      [enrollmentId, activityId],
    );
    const row = a.rows[0]!;
    const builtin = BUILTIN_COMPONENTS[activity.activityType as keyof typeof BUILTIN_COMPONENTS];
    const pr = prev.rows[0];
    return {
      activityId,
      enrollmentId,
      title: activity.title,
      activityType: activity.activityType,
      componentType: row.component_type ?? builtin ?? `builtin.${activity.activityType}`,
      schemaVersion: row.schema_version ?? '1.0',
      config: row.config,
      supported: resolveEvaluator(activity.activityType, activity.serverEvaluator) !== null,
      attemptPolicy: { maxAttempts: activity.maxAttempts, usedAttempts: progress.attempts[activityId]?.used ?? 0 },
      inProgressAttemptId: progress.attempts[activityId]?.inProgressId ?? null,
      previousResultSummary: pr ? { status: pr.status, score: pr.score === null ? null : Number(pr.score), maxScore: Number(pr.max_score), attemptNo: pr.attempt_no } : null,
      // AI 教練於後續階段接上
      coachAvailable: false,
    };
  }

  /**
   * 建立作答（UC-LRN-004/008）：同一活動只能有一個進行中的作答——新建時舊的轉 abandoned（SA §7.3）；
   * 次數上限以已送出的作答計。鎖定選課列，並行建立會排隊。同一交易寫入 activity.started／activity.retry_started。
   */
  async startAttempt(activityId: string, userId: string): Promise<{ attemptId: string; attemptNo: number }> {
    return this.tx(async (c) => {
      const { enrollmentId, progress, activity } = await this.learnableActivity(activityId, userId, c, true);
      if (!resolveEvaluator(activity.activityType, activity.serverEvaluator)) throw rejected('activity_not_supported');
      const used = progress.attempts[activityId]?.used ?? 0;
      if (activity.maxAttempts !== null && used >= activity.maxAttempts) throw rejected('max_attempts_reached');
      await c.query(
        `UPDATE learning_attempts SET status = 'abandoned', updated_at = now() WHERE enrollment_id = $1 AND activity_id = $2 AND status = 'in_progress'`,
        [enrollmentId, activityId],
      );
      const r = await c.query<{ id: string; attempt_no: number }>(
        `INSERT INTO learning_attempts (organization_id, enrollment_id, activity_id, attempt_no)
         SELECT e.organization_id, e.id, $2,
                COALESCE((SELECT max(attempt_no) FROM learning_attempts WHERE enrollment_id = e.id AND activity_id = $2), 0) + 1
           FROM enrollments e WHERE e.id = $1
         RETURNING id, attempt_no`,
        [enrollmentId, activityId],
      );
      await c.query(`UPDATE enrollments SET started_at = COALESCE(started_at, now()) WHERE id = $1`, [enrollmentId]);
      const { id, attempt_no: attemptNo } = r.rows[0]!;
      await this.events.recordTx(c, enrollmentId, [
        { eventType: attemptNo === 1 ? 'activity.started' : 'activity.retry_started', activityId, attemptId: id, payload: { attempt_no: attemptNo } },
      ]);
      return { attemptId: id, attemptNo };
    });
  }

  /**
   * 送出作答（UC-LRN-006、SEQ-03）：伺服器評分（不採信 client 的 score／status，AC-LRN-003）→ 寫入 append-only 的
   * 結果 → 作答轉 scored → 同一交易重算完成判定並寫入進度快照（ADR-020 同步判定，零 LLM）→ 寫入學習事件。
   * 設有影片網址的影片活動：觀看比例由學習事件計算，忽略學員端送來的 watchedRatio（SD §6.12）。
   */
  async submit(attemptId: string, userId: string, input: unknown): Promise<ActivityResultDto> {
    return this.tx(async (c) => {
      const at = await c.query<{ id: string; attempt_no: number; status: string; activity_id: string; enrollment_id: string; user_id: string; enrollment_status: EnrollmentStatus; organization_id: string }>(
        `SELECT la.id, la.attempt_no, la.status, la.activity_id, la.enrollment_id, e.user_id, e.status AS enrollment_status, e.organization_id
           FROM learning_attempts la JOIN enrollments e ON e.id = la.enrollment_id
          WHERE la.id = $1 FOR UPDATE OF la, e`,
        [attemptId],
      );
      const a = at.rows[0];
      if (!a || a.user_id !== userId) throw new DomainError('NOT_FOUND');
      if (!LEARNABLE_STATUSES.includes(a.enrollment_status)) throw new DomainError('ENROLLMENT_NOT_ACTIVE');
      if (a.status !== 'in_progress') throw rejected('attempt_not_in_progress');

      const act = await c.query<{ activity_type: string; config: Record<string, unknown>; answer_key: Record<string, unknown> | null; max_score: string; server_evaluator: string | null }>(
        `SELECT a.activity_type, a.config, a.answer_key, a.max_score, d.server_evaluator
           FROM activities a LEFT JOIN interactive_definitions d ON d.id = a.interactive_definition_id WHERE a.id = $1`,
        [a.activity_id],
      );
      const activity = act.rows[0]!;
      const evaluator = resolveEvaluator(activity.activity_type, activity.server_evaluator);
      if (!evaluator) throw rejected('activity_not_supported');

      let effective = input;
      if (activity.activity_type === 'video' && typeof activity.config['video_url'] === 'string' && activity.config['video_url']) {
        const before = await this.engine.progress(a.enrollment_id, c);
        effective = { watchedRatio: before.ctx.videoWatchRatios[a.activity_id] ?? 0 };
      }
      const problems = evaluator.validateInput(effective, activity.config);
      if (problems.length) {
        throw new DomainError(
          'ACTIVITY_INPUT_INVALID',
          'Invalid activity input',
          problems.map((p) => ({ ...(p.field && { field: p.field }), issue: p.code, params: { message: p.message } })),
        );
      }
      const maxScore = Number(activity.max_score);
      const out = evaluator.evaluate(effective, { config: activity.config, answerKey: activity.answer_key, maxScore });

      const wasDone = await c.query(`SELECT 1 FROM learning_results WHERE enrollment_id = $1 AND activity_id = $2 AND status IN ('passed', 'completed') LIMIT 1`, [
        a.enrollment_id,
        a.activity_id,
      ]);
      const lr = await c.query<{ evaluated_at: Date }>(
        `INSERT INTO learning_results (organization_id, attempt_id, enrollment_id, activity_id, status, score, max_score, issues, feedback_data, evaluator)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10) RETURNING evaluated_at`,
        [a.organization_id, a.id, a.enrollment_id, a.activity_id, out.status, out.score, maxScore, JSON.stringify(out.issues), JSON.stringify(out.feedbackData), `${evaluator.name}@${evaluator.version}`],
      );
      await c.query(`UPDATE learning_attempts SET status = 'scored', submitted_at = now(), scored_at = now(), updated_at = now() WHERE id = $1`, [a.id]);

      const ids = { activityId: a.activity_id, attemptId: a.id };
      const events: ServerEvent[] = [
        { eventType: 'activity.submitted', ...ids, payload: { input_hash: createHash('sha256').update(canonicalJson(input ?? null)).digest('hex') } },
        { eventType: 'activity.result_ready', ...ids, payload: { status: out.status, score: out.score, max_score: maxScore } },
      ];
      if (DONE.has(out.status) && !wasDone.rowCount) events.push({ eventType: 'activity.completed', ...ids });
      const completionChanged = await this.settle(c, a.enrollment_id, events);

      return {
        attemptId: a.id,
        attemptNo: a.attempt_no,
        status: out.status,
        score: out.score,
        maxScore,
        issues: out.issues,
        feedbackData: out.feedbackData,
        evaluatedAt: lr.rows[0]!.evaluated_at.toISOString(),
        completionChanged,
      };
    });
  }

  /**
   * 評估後的共同處理（送出作答、人工核可）：寫入進度快照；選課因此轉為完成時寫 course.completed，
   * 並在同一交易排入發證（SEQ-10；同一筆選課只排一次）。回傳是否因此完成。
   */
  private async settle(c: pg.PoolClient, enrollmentId: string, events: ServerEvent[]): Promise<boolean> {
    const p = await this.engine.progress(enrollmentId, c);
    const ev = this.engine.evaluate(p);
    const changed = await this.engine.persist(p, ev, c);
    if (changed) {
      events.push({ eventType: 'course.completed', payload: { grammar_version: ev.grammarVersion } });
      await enqueueJobTx(c, {
        jobType: CERTIFICATE_JOB.type,
        queue: CERTIFICATE_JOB.queue,
        priority: CERTIFICATE_JOB.priority,
        maxAttempts: CERTIFICATE_JOB.maxAttempts,
        payload: { enrollmentId },
        idempotencyKey: certificateJobKey(enrollmentId),
        organizationId: p.enrollment.organizationId,
      });
    }
    await this.events.recordTx(c, enrollmentId, events);
    return changed;
  }

  /**
   * 人工核可（SD §6.14）：完成條件含 manual_approval 時，由條件指定角色的人核可。核可者須在此課程（或其組織）
   * 實際擔任該角色——路由的 learning.result.read_all 只確認是課程人員。一次核可涵蓋其擔任且尚未核可的所有角色；
   * 同一交易重算完成判定。鎖定選課列，並行的核可與送出作答會排隊。
   */
  async approve(enrollmentId: string, approverId: string, note: string | null): Promise<{ approvedRoles: ApproverRole[]; completionChanged: boolean }> {
    return this.tx(async (c) => {
      const e = await c.query<{ status: EnrollmentStatus; course_id: string; organization_id: string }>(
        `SELECT status, course_id, organization_id FROM enrollments WHERE id = $1 FOR UPDATE`,
        [enrollmentId],
      );
      const enr = e.rows[0];
      if (!enr) throw new DomainError('NOT_FOUND');
      if (!LEARNABLE_STATUSES.includes(enr.status)) throw new DomainError('ENROLLMENT_NOT_ACTIVE');
      const p = await this.engine.progress(enrollmentId, c);
      const required = manualApprovalRoles(p.rule?.rule);
      if (!required.length) throw rejected('approval_not_required');
      const held = await c.query<{ code: string }>(
        `SELECT DISTINCT r.code FROM user_org_roles uor JOIN roles r ON r.id = uor.role_id
          WHERE uor.user_id = $1 AND r.code = ANY($4::text[])
            AND ((uor.scope_type = 'course' AND uor.scope_id = $2) OR (uor.scope_type = 'organization' AND uor.scope_id = $3))`,
        [approverId, enr.course_id, enr.organization_id, required],
      );
      const mine = required.filter((role) => held.rows.some((h) => h.code === role));
      if (!mine.length) throw new DomainError('PERMISSION_DENIED', 'Approver role required', [{ issue: 'approver_role_required', params: { roles: required.join(',') } }]);
      const pending = mine.filter((role) => !p.ctx.manualApprovals.some((x) => x.approverRole === role));
      if (!pending.length) throw rejected('already_approved');
      for (const role of pending) {
        await c.query(`INSERT INTO completion_approvals (enrollment_id, approver_role, approved_by, note) VALUES ($1, $2, $3, $4)`, [enrollmentId, role, approverId, note]);
      }
      const completionChanged = await this.settle(c, enrollmentId, [{ eventType: 'completion.approved', payload: { approver_roles: pending.join(',') } }]);
      return { approvedRoles: pending, completionChanged };
    });
  }

  /** 作答結果（UC-LRN-007）：只有本人看得到，其他人一律 404（AC-LRN-007）；尚未評分 409 */
  async result(attemptId: string, userId: string): Promise<ActivityResultDto> {
    const r = await this.db.query<{
      attempt_no: number;
      user_id: string;
      status: ResultStatus | null;
      score: string | null;
      max_score: string | null;
      issues: ResultIssue[] | null;
      feedback_data: Record<string, unknown> | null;
      evaluated_at: Date | null;
    }>(
      `SELECT la.attempt_no, e.user_id, lr.status, lr.score, lr.max_score, lr.issues, lr.feedback_data, lr.evaluated_at
         FROM learning_attempts la JOIN enrollments e ON e.id = la.enrollment_id
         LEFT JOIN learning_results lr ON lr.attempt_id = la.id
        WHERE la.id = $1`,
      [attemptId],
    );
    const x = r.rows[0];
    if (!x || x.user_id !== userId) throw new DomainError('NOT_FOUND');
    if (!x.status) throw new DomainError('RESULT_NOT_READY');
    return {
      attemptId,
      attemptNo: x.attempt_no,
      status: x.status,
      score: x.score === null ? null : Number(x.score),
      maxScore: Number(x.max_score),
      issues: x.issues ?? [],
      feedbackData: x.feedback_data ?? {},
      evaluatedAt: x.evaluated_at!.toISOString(),
      completionChanged: false,
    };
  }
}

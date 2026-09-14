import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CatalogCourseDto, EnrollmentDto, EnrollmentPolicyDto, EnrollmentPolicyViewDto, EnrollmentStatus, JoinBy, JoinResultDto } from '@iac/contracts';
import pg from 'pg';
import type { AuthUser } from '../../../common/context.js';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { LEARNING_EVENTS, type LearningEventWriter } from '../../learning-record/learning-record.contracts.js';
import { generateEnrollmentCode, joinAvailability, normalizeEnrollmentCode, parsePolicy } from '../domain/policy.js';
import { EnrollmentService } from './enrollment.service.js';

const invalid = (field: string, issue: string) => new DomainError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
const rejected = (issue: string, params?: Record<string, string>) => new DomainError('VALIDATION_FAILED', issue, [{ issue, ...(params && { params }) }]);

/** 占用名額的選課：未退選、未被拒 */
const SEATS_SQL = `SELECT count(*)::int FROM enrollments e WHERE e.course_id = c.id AND e.status NOT IN ('withdrawn', 'rejected')`;

export interface PolicyInput {
  joinBy: JoinBy;
  requireApproval: boolean;
  opensAt: string | null;
  closesAt: string | null;
  maxSeats: number | null;
  regenerateCode: boolean;
}

/**
 * 學員自行加入（SA UC-ENR-002／003／004；SD §6.24）：選課政策、選課碼、課程目錄、審核。
 * 政策存在 courses.enrollment_policy；選課碼在同一組織內唯一（DB 唯一索引）。
 * 名額只限制自行加入與申請；管理者指派不受限（管理者自己決定）。授權的學員人數上限一律適用（controller 的 limit）。
 */
@Injectable()
export class SelfEnrollmentService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    private readonly enrollments: EnrollmentService,
    @Inject(LEARNING_EVENTS) private readonly events: LearningEventWriter,
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

  // ------------------------------------------------------------------ 政策

  async policy(courseId: string): Promise<EnrollmentPolicyViewDto> {
    const r = await this.db.query<{ enrollment_policy: unknown; seats: number; pending: number }>(
      `SELECT c.enrollment_policy, (${SEATS_SQL}) AS seats,
              (SELECT count(*)::int FROM enrollments e WHERE e.course_id = c.id AND e.status = 'pending') AS pending
         FROM courses c WHERE c.id = $1`,
      [courseId],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return { ...parsePolicy(r.rows[0].enrollment_policy), seatsUsed: r.rows[0].seats, pending: r.rows[0].pending };
  }

  /** 設定政策：選課碼模式下沒有碼（或要求重新產生）就產生新碼；改成其他方式時清掉舊碼（舊碼立即失效） */
  async setPolicy(courseId: string, input: PolicyInput): Promise<{ before: EnrollmentPolicyDto; after: EnrollmentPolicyViewDto }> {
    if (input.opensAt && input.closesAt && Date.parse(input.opensAt) >= Date.parse(input.closesAt)) throw invalid('closesAt', 'must_be_after_opens');
    const before = await this.tx(async (c) => {
      const r = await c.query<{ enrollment_policy: unknown }>(`SELECT enrollment_policy FROM courses WHERE id = $1 FOR UPDATE`, [courseId]);
      if (!r.rows[0]) throw new DomainError('NOT_FOUND');
      const prev = parsePolicy(r.rows[0].enrollment_policy);
      let code = input.joinBy === 'code' && !input.regenerateCode ? prev.code : null;
      for (let attempt = 0; ; attempt++) {
        const next: EnrollmentPolicyDto = {
          joinBy: input.joinBy,
          requireApproval: input.joinBy === 'assign' ? false : input.requireApproval,
          code: input.joinBy === 'code' ? (code ?? generateEnrollmentCode(randomInt)) : null,
          opensAt: input.opensAt,
          closesAt: input.closesAt,
          maxSeats: input.maxSeats,
        };
        await c.query('SAVEPOINT policy');
        try {
          await c.query(`UPDATE courses SET enrollment_policy = $2::jsonb WHERE id = $1`, [courseId, JSON.stringify(next)]);
          await c.query('RELEASE SAVEPOINT policy');
          return prev;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT policy');
          // 新產生的碼剛好與同組織的其他課程重複：換一個
          if ((e as { code?: string }).code === '23505' && attempt < 5) {
            code = null;
            continue;
          }
          throw e;
        }
      }
    });
    return { before, after: await this.policy(courseId) };
  }

  // ------------------------------------------------------------------ 學員

  /** 目前組織中公開於課程目錄、已發布、未封存的課程 */
  async catalog(user: AuthUser): Promise<CatalogCourseDto[]> {
    if (!user.activeOrganizationId) return [];
    const r = await this.db.query<{
      id: string;
      code: string;
      title: string;
      description: string | null;
      enrollment_policy: unknown;
      seats: number;
      my_id: string | null;
      my_status: EnrollmentStatus | null;
    }>(
      `SELECT c.id, c.code, c.title, c.description, c.enrollment_policy, (${SEATS_SQL}) AS seats, me.id AS my_id, me.status AS my_status
         FROM courses c
         LEFT JOIN enrollments me ON me.course_id = c.id AND me.user_id = $2 AND me.status NOT IN ('withdrawn', 'rejected')
        WHERE c.organization_id = $1 AND c.status <> 'archived' AND c.enrollment_policy->>'joinBy' = 'catalog'
          AND EXISTS (SELECT 1 FROM course_versions cv WHERE cv.course_id = c.id AND cv.status = 'published')
        ORDER BY c.title
        LIMIT 500`,
      [user.activeOrganizationId, user.id],
    );
    const now = Date.now();
    return r.rows.map((x) => {
      const p = parsePolicy(x.enrollment_policy);
      return {
        id: x.id,
        code: x.code,
        title: x.title,
        description: x.description,
        requireApproval: p.requireApproval,
        myEnrollment: x.my_id ? { id: x.my_id, status: x.my_status! } : null,
        availability: joinAvailability(p, x.seats, now),
      };
    });
  }

  /**
   * 加入（選課碼或課程目錄）。找不到或加入方式不符一律 code_not_found／404，不透露課程是否存在。
   * 已經在課程裡 → 回傳既有選課（alreadyEnrolled）。需審核 → 待審核（enroll_method = approval）。
   */
  async join(user: AuthUser, by: { code: string } | { courseId: string }): Promise<JoinResultDto> {
    const orgId = user.activeOrganizationId;
    const byCode = 'code' in by;
    const notFound = () => (byCode ? invalid('code', 'code_not_found') : new DomainError('NOT_FOUND'));
    if (!orgId) throw notFound();
    return this.tx(async (c) => {
      const r = byCode
        ? await c.query<{ id: string; title: string; status: string; enrollment_policy: unknown }>(
            `SELECT id, title, status, enrollment_policy FROM courses WHERE organization_id = $1 AND enrollment_policy->>'code' = $2 FOR UPDATE`,
            [orgId, normalizeEnrollmentCode(by.code)],
          )
        : await c.query<{ id: string; title: string; status: string; enrollment_policy: unknown }>(
            `SELECT id, title, status, enrollment_policy FROM courses WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
            [orgId, by.courseId],
          );
      const course = r.rows[0];
      if (!course) throw notFound();
      const p = parsePolicy(course.enrollment_policy);
      if (p.joinBy !== (byCode ? 'code' : 'catalog')) throw notFound();
      if (course.status === 'archived') throw rejected('course_archived');
      const pv = await c.query<{ id: string }>(`SELECT id FROM course_versions WHERE course_id = $1 AND status = 'published'`, [course.id]);
      if (!pv.rows[0]) throw rejected('course_not_published');
      const disabled = await c.query(`SELECT 1 FROM disabled_memberships WHERE organization_id = $1 AND user_id = $2`, [orgId, user.id]);
      if (disabled.rowCount) throw rejected('member_disabled');

      const existing = await c.query<{ id: string; status: EnrollmentStatus }>(
        `SELECT id, status FROM enrollments WHERE course_id = $1 AND user_id = $2 AND status NOT IN ('withdrawn', 'rejected')`,
        [course.id, user.id],
      );
      if (existing.rows[0]) return { enrollmentId: existing.rows[0].id, courseId: course.id, courseTitle: course.title, status: existing.rows[0].status, alreadyEnrolled: true };

      const seats = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM enrollments WHERE course_id = $1 AND status NOT IN ('withdrawn', 'rejected')`, [course.id]);
      const a = joinAvailability(p, seats.rows[0]!.n, Date.now());
      if (a === 'full') throw rejected('course_full');
      if (a !== 'open') throw rejected('enrollment_closed', { ...(p.opensAt && { opensAt: p.opensAt }), ...(p.closesAt && { closesAt: p.closesAt }) });

      const status = p.requireApproval ? 'pending' : 'active';
      const e = await this.enrollments.enrollInTx(c, { id: course.id, organizationId: orgId, publishedVersionId: pv.rows[0].id }, user.id, user.id, null, byCode ? 'code' : 'catalog', {
        status,
        enrollMethod: p.requireApproval ? 'approval' : byCode ? 'code' : 'self',
        assignedBy: null,
      });
      return { enrollmentId: e.enrollmentId, courseId: course.id, courseTitle: course.title, status, alreadyEnrolled: false };
    });
  }

  // ------------------------------------------------------------------ 審核

  /** 核准（UC-ENR-004）：待審核 → 學習中；綁定「核准當下」的已發布版本（AC-CRS-003），並開始記錄學習歷程 */
  async approve(enrollmentId: string, actorId: string): Promise<EnrollmentDto> {
    const course = await this.db.query<{ course_id: string }>(`SELECT course_id FROM enrollments WHERE id = $1`, [enrollmentId]);
    if (!course.rows[0]) throw new DomainError('NOT_FOUND');
    return this.tx(async (c) => {
      // 與指派、發布相同的鎖序：先課程、後選課
      const co = await c.query<{ status: string }>(`SELECT status FROM courses WHERE id = $1 FOR UPDATE`, [course.rows[0]!.course_id]);
      if (co.rows[0]?.status === 'archived') throw rejected('course_archived');
      const e = await c.query<{ status: EnrollmentStatus }>(`SELECT status FROM enrollments WHERE id = $1 FOR UPDATE`, [enrollmentId]);
      if (e.rows[0]?.status !== 'pending') throw rejected('invalid_transition', { from: e.rows[0]?.status ?? 'unknown' });
      const pv = await c.query<{ id: string }>(`SELECT id FROM course_versions WHERE course_id = $1 AND status = 'published'`, [course.rows[0]!.course_id]);
      if (!pv.rows[0]) throw rejected('course_not_published');
      await c.query(`UPDATE enrollments SET status = 'active', course_version_id = $2, enrolled_at = now(), assigned_by = $3, updated_at = now() WHERE id = $1`, [
        enrollmentId,
        pv.rows[0].id,
        actorId,
      ]);
      await this.events.recordTx(c, enrollmentId, [{ eventType: 'course.enrolled', payload: { method: 'approval', approved_by: actorId } }]);
      return this.enrollments.get(enrollmentId, c);
    });
  }

  /** 拒絕：待審核 → 未通過審核（學員之後可以再申請） */
  async reject(enrollmentId: string): Promise<EnrollmentDto> {
    return this.tx(async (c) => {
      const e = await c.query<{ status: EnrollmentStatus }>(`SELECT status FROM enrollments WHERE id = $1 FOR UPDATE`, [enrollmentId]);
      if (!e.rows[0]) throw new DomainError('NOT_FOUND');
      if (e.rows[0].status !== 'pending') throw rejected('invalid_transition', { from: e.rows[0].status });
      await c.query(`UPDATE enrollments SET status = 'rejected', updated_at = now() WHERE id = $1`, [enrollmentId]);
      return this.enrollments.get(enrollmentId, c);
    });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  LEARNABLE_STATUSES,
  type CourseLearnerDto,
  type EnrollMethod,
  type EnrollmentDto,
  type EnrollmentStatus,
  type MyEnrollmentDto,
} from '@iac/contracts';
import pg from 'pg';
import { z } from 'zod';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { nextEnrollmentStatus, type EnrollmentAction } from '../domain/transitions.js';

type Q = pg.Pool | pg.PoolClient;

const invalid = (field: string, issue: string) => new DomainError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
const rejected = (issue: string) => new DomainError('VALIDATION_FAILED', issue, [{ issue }]);

interface EnrollmentRow {
  id: string;
  organization_id: string;
  course_id: string;
  course_version_id: string;
  version_no: number;
  user_id: string;
  status: EnrollmentStatus;
  enroll_method: EnrollMethod;
  enrolled_at: Date;
  completed_at: Date | null;
  withdrawn_at: Date | null;
  due_date: Date | null;
}

const BASE_COLUMNS = `e.id, e.organization_id, e.course_id, e.course_version_id, cv.version_no, e.user_id, e.status, e.enroll_method,
  e.enrolled_at, e.completed_at, e.withdrawn_at, e.due_date`;

function toEnrollment(r: EnrollmentRow): EnrollmentDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    courseId: r.course_id,
    courseVersionId: r.course_version_id,
    versionNo: r.version_no,
    userId: r.user_id,
    status: r.status,
    enrollMethod: r.enroll_method,
    enrolledAt: r.enrolled_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
    withdrawnAt: r.withdrawn_at?.toISOString() ?? null,
    dueDate: r.due_date?.toISOString() ?? null,
  };
}

const Cursor = z.tuple([z.string().max(254), z.guid()]);

/**
 * 選課（SA UC-ENR-001/005/006/010、SD §6.8）。
 * 課程資料以 SQL 讀取——模組間只能經由 *.contracts.ts 相依，選課只需要課程的狀態與已發布版本。
 */
@Injectable()
export class EnrollmentService {
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

  private async get(id: string, q: Q = this.db): Promise<EnrollmentDto> {
    const r = await q.query<EnrollmentRow>(`SELECT ${BASE_COLUMNS} FROM enrollments e JOIN course_versions cv ON cv.id = e.course_version_id WHERE e.id = $1`, [id]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return toEnrollment(r.rows[0]);
  }

  /**
   * 管理者指派學員（UC-ENR-001）。綁定當下的已發布版本（AC-CRS-003）。
   * 鎖定課程列：與發布（CoursePublishService）同一把鎖，不會綁到正在被取代的版本。
   * 對象須為課程所屬組織的啟用成員；尚無學員角色者自動補上——否則沒有學習權限。
   */
  async assign(courseId: string, input: { email: string; dueDate?: string | undefined }, actorId: string): Promise<{ enrollment: EnrollmentDto; learnerRoleGranted: boolean }> {
    return this.tx(async (c) => {
      const course = await c.query<{ organization_id: string; status: string }>(`SELECT organization_id, status FROM courses WHERE id = $1 FOR UPDATE`, [courseId]);
      if (!course.rows[0]) throw new DomainError('NOT_FOUND');
      const orgId = course.rows[0].organization_id;
      if (course.rows[0].status === 'archived') throw rejected('course_archived');
      const pv = await c.query<{ id: string }>(`SELECT id FROM course_versions WHERE course_id = $1 AND status = 'published'`, [courseId]);
      if (!pv.rows[0]) throw rejected('course_not_published');

      const u = await c.query<{ id: string; disabled: boolean }>(
        `SELECT u.id, EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = $2 AND dm.user_id = u.id) AS disabled
           FROM users u
          WHERE u.email = $1 AND u.status = 'active'
            AND EXISTS (SELECT 1 FROM user_org_roles uor WHERE uor.user_id = u.id AND uor.organization_id = $2)`,
        [input.email, orgId],
      );
      const user = u.rows[0];
      if (!user) throw invalid('email', 'not_in_organization');
      if (user.disabled) throw invalid('email', 'member_disabled');
      const r = await this.enrollInTx(c, { id: courseId, organizationId: orgId, publishedVersionId: pv.rows[0].id }, user.id, actorId, input.dueDate ?? null);
      if (!r.created) throw invalid('email', 'already_enrolled');
      return { enrollment: await this.get(r.enrollmentId, c), learnerRoleGranted: r.learnerRoleGranted };
    });
  }

  /**
   * 在呼叫端的交易內建立選課（單筆指派與批次匯入共用）。呼叫端須已鎖定課程列並確認已發布、未封存。
   * 已有未退課的選課 → created: false；尚無學員角色者自動補上。
   */
  async enrollInTx(
    c: pg.PoolClient,
    course: { id: string; organizationId: string; publishedVersionId: string },
    userId: string,
    actorId: string,
    dueDate: string | null = null,
  ): Promise<{ enrollmentId: string; created: boolean; learnerRoleGranted: boolean }> {
    const dup = await c.query<{ id: string }>(`SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2 AND status NOT IN ('withdrawn', 'rejected')`, [
      course.id,
      userId,
    ]);
    if (dup.rows[0]) return { enrollmentId: dup.rows[0].id, created: false, learnerRoleGranted: false };
    const grant = await c.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id, granted_by)
       SELECT $1, id, 'self'::scope_type, $1, $2, $3 FROM roles WHERE code = 'learner'
       ON CONFLICT DO NOTHING`,
      [userId, course.organizationId, actorId],
    );
    const e = await c.query<{ id: string }>(
      `INSERT INTO enrollments (organization_id, course_id, course_version_id, user_id, status, enroll_method, assigned_by, due_date)
       VALUES ($1, $2, $3, $4, 'active', 'assign', $5, $6) RETURNING id`,
      [course.organizationId, course.id, course.publishedVersionId, userId, actorId, dueDate],
    );
    return { enrollmentId: e.rows[0]!.id, created: true, learnerRoleGranted: (grant.rowCount ?? 0) > 0 };
  }

  /** 課程的學員名單（UC-LRN-011 的名單部分）；依 email keyset 分頁 */
  async learners(
    courseId: string,
    q: { status?: EnrollmentStatus | undefined; cursor?: string | undefined; limit: number },
  ): Promise<{ data: CourseLearnerDto[]; nextCursor: string | null }> {
    let email: string | null = null;
    let id: string | null = null;
    if (q.cursor) {
      try {
        [email, id] = Cursor.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
      } catch {
        throw invalid('cursor', 'invalid');
      }
    }
    const r = await this.db.query<EnrollmentRow & { display_name: string; email: string; member_disabled: boolean }>(
      `SELECT ${BASE_COLUMNS}, u.display_name, u.email::text AS email,
              EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = e.organization_id AND dm.user_id = e.user_id) AS member_disabled
         FROM enrollments e
         JOIN course_versions cv ON cv.id = e.course_version_id
         JOIN users u ON u.id = e.user_id
        WHERE e.course_id = $1
          AND ($2::enrollment_status IS NULL OR e.status = $2::enrollment_status)
          AND ($3::text IS NULL OR (u.email::text, e.id) > ($3::text, $4::uuid))
        ORDER BY u.email::text, e.id
        LIMIT $5`,
      [courseId, q.status ?? null, email, id, q.limit + 1],
    );
    const page = r.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      data: page.map((x) => ({ ...toEnrollment(x), displayName: x.display_name, email: x.email, memberDisabled: x.member_disabled })),
      nextCursor: r.rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.email, last.id])).toString('base64url') : null,
    };
  }

  /** 我的課程（UC-ENR-010）：只含啟用中組織、且本人成員資格未停用的選課 */
  async mine(userId: string): Promise<MyEnrollmentDto[]> {
    const r = await this.db.query<EnrollmentRow & { code: string; title: string; organization_name: string }>(
      `SELECT ${BASE_COLUMNS}, c.code, c.title, o.name AS organization_name
         FROM enrollments e
         JOIN course_versions cv ON cv.id = e.course_version_id
         JOIN courses c ON c.id = e.course_id
         JOIN organizations o ON o.id = e.organization_id
        WHERE e.user_id = $1 AND e.status <> 'rejected' AND o.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = e.organization_id AND dm.user_id = e.user_id)
        ORDER BY (e.status = 'withdrawn'), e.enrolled_at DESC
        LIMIT 500`,
      [userId],
    );
    return r.rows.map((x) => ({
      ...toEnrollment(x),
      course: { code: x.code, title: x.title },
      organizationName: x.organization_name,
      canLearn: LEARNABLE_STATUSES.includes(x.status),
    }));
  }

  /** 退課／暫停／恢復（UC-ENR-005/006）。不合法的轉換 400 invalid_transition */
  async transition(id: string, action: EnrollmentAction): Promise<{ enrollment: EnrollmentDto; before: EnrollmentStatus; after: EnrollmentStatus }> {
    return this.tx(async (c) => {
      const cur = await c.query<{ status: EnrollmentStatus }>(`SELECT status FROM enrollments WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rows[0]) throw new DomainError('NOT_FOUND');
      const before = cur.rows[0].status;
      const after = nextEnrollmentStatus(before, action);
      if (!after) throw new DomainError('VALIDATION_FAILED', 'invalid_transition', [{ issue: 'invalid_transition', params: { from: before } }]);
      await c.query(
        `UPDATE enrollments SET status = $2::enrollment_status, updated_at = now(),
                withdrawn_at = CASE WHEN $2::text = 'withdrawn' THEN now() ELSE withdrawn_at END
          WHERE id = $1`,
        [id, after],
      );
      return { enrollment: await this.get(id, c), before, after };
    });
  }
}

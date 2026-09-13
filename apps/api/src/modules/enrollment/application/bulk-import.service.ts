import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  COURSE_ROLES,
  type ImportAction,
  type ImportReportDto,
  type ImportRowResult,
  type LearnerImportRow,
  type MemberImportRow,
  type OrgRole,
  type RoleSpec,
} from '@iac/contracts';
import pg from 'pg';
import { z } from 'zod';
import { AuditWriter, type AuditRecord } from '../../../common/audit-writer.js';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { LICENSE_EVALUATOR, type LicenseEvaluator } from '../../license/license.contracts.js';
import { ORG_MEMBERSHIP, type OrgMembership } from '../../organization/organization.contracts.js';
import { EnrollmentService } from './enrollment.service.js';

const ROLES: readonly OrgRole[] = ['learner', 'instructor', 'course_admin', 'org_admin', 'auditor'];
const EmailFormat = z.email().max(254);

interface CourseRef {
  id: string;
  code: string;
  status: string;
  publishedVersionId: string | null;
}

interface Item {
  line: number;
  email: string;
  displayName: string | null;
  role: string;
  course: string | null;
}

export interface ImportOptions {
  dryRun: boolean;
  actorId: string;
  meta: { correlationId: string; ip: string | null; userAgent: string | null };
}

/** 驗證失敗的原因代碼（row 級錯誤，不中斷整批） */
class RowError extends Error {
  constructor(readonly issue: string) {
    super(issue);
  }
}

/**
 * 批次匯入（SD §6.11）：成員（含分課）與課程學員。
 *
 * 預覽與實際匯入跑同一段程式——預覽在交易結束時 ROLLBACK，所以預覽結果就是實際會發生的事。
 * 每列以 SAVEPOINT 隔開，一列出錯不影響其他列。學員人數上限在交易內以寫入後的實際數字計算，
 * 實際匯入若會超過即整批拒絕（403 LICENSE_LIMIT_EXCEEDED）。邀請信與稽核在 COMMIT 之後才送出／寫入。
 * 鎖定組織列：與角色變更、停用成員排隊。
 */
@Injectable()
export class BulkImportService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ORG_MEMBERSHIP) private readonly membership: OrgMembership,
    @Inject(LICENSE_EVALUATOR) private readonly license: LicenseEvaluator,
    private readonly enrollments: EnrollmentService,
    private readonly audit: AuditWriter,
  ) {}

  /** 成員匯入：role 預設學員；courseCode 選填 */
  importMembers(orgId: string, rows: MemberImportRow[], o: ImportOptions & { canEnroll: boolean; canAssignCourseRole: boolean }): Promise<ImportReportDto> {
    const items = rows.map((r, i) => ({
      line: i + 1,
      email: r.email.trim().toLowerCase(),
      displayName: r.displayName?.trim() || null,
      role: (r.role?.trim() || 'learner').toLowerCase(),
      course: r.courseCode?.trim() || null,
    }));
    return this.run(orgId, items, { ...o, allowCreate: true, courseBy: 'code' });
  }

  /** 課程學員匯入：一律為學員選這門課；建立新帳號需有新增成員的權限 */
  importLearners(courseId: string, orgId: string, rows: LearnerImportRow[], o: ImportOptions & { canCreateAccounts: boolean }): Promise<ImportReportDto> {
    const items = rows.map((r, i) => ({ line: i + 1, email: r.email.trim().toLowerCase(), displayName: r.displayName?.trim() || null, role: 'learner', course: courseId }));
    return this.run(orgId, items, { ...o, allowCreate: o.canCreateAccounts, canEnroll: true, canAssignCourseRole: false, courseBy: 'id' });
  }

  private async run(
    orgId: string,
    items: Item[],
    o: ImportOptions & { allowCreate: boolean; canEnroll: boolean; canAssignCourseRole: boolean; courseBy: 'code' | 'id' },
  ): Promise<ImportReportDto> {
    const batchId = o.dryRun ? null : randomUUID();
    const audits: AuditRecord[] = [];
    const created: string[] = [];
    const results: ImportRowResult[] = [];
    const maxActiveLearners = (await this.license.evaluate()).maxActiveLearners ?? null;
    const c = await this.db.connect();
    let activeAfter = 0;
    let exceededBy = 0;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [orgId]);
      const activeBefore = await this.activeLearners(c);

      // 本批引用的課程（依代碼或 id），並鎖定——與發布、單筆指派同一把鎖
      const keys = [...new Set(items.map((i) => i.course).filter((x): x is string => !!x))];
      const courses = new Map<string, CourseRef>();
      if (keys.length) {
        const r = await c.query<{ id: string; code: string; status: string; pv: string | null }>(
          `SELECT c.id, c.code, c.status, (SELECT v.id FROM course_versions v WHERE v.course_id = c.id AND v.status = 'published') AS pv
             FROM courses c WHERE c.organization_id = $1 AND ${o.courseBy === 'code' ? 'c.code = ANY($2::text[])' : 'c.id = ANY($2::uuid[])'}
             ORDER BY c.id FOR UPDATE OF c`,
          [orgId, keys],
        );
        for (const x of r.rows) courses.set(o.courseBy === 'code' ? x.code : x.id, { id: x.id, code: x.code, status: x.status, publishedVersionId: x.pv });
      }

      const seen = new Set<string>();
      for (const it of items) {
        const actions: ImportAction[] = [];
        const push = (outcome: ImportRowResult['outcome'], issue?: string) =>
          results.push({ line: it.line, email: it.email, outcome, actions, ...(issue && { issue }) });
        try {
          if (!EmailFormat.safeParse(it.email).success) throw new RowError('invalid_email');
          const key = `${it.email}|${it.course ?? ''}`;
          if (seen.has(key)) {
            push('skipped', 'duplicate_row');
            continue;
          }
          seen.add(key);
          if (!ROLES.includes(it.role as OrgRole)) throw new RowError('invalid_role');
          const role = it.role as OrgRole;
          const courseRole = COURSE_ROLES.includes(role);
          if (courseRole && !it.course) throw new RowError('course_required');
          if (!courseRole && role !== 'learner' && it.course) throw new RowError('course_not_applicable');
          const course = it.course ? courses.get(it.course) : undefined;
          if (it.course && !course) throw new RowError('course_not_found');
          if (course && role === 'learner') {
            if (!o.canEnroll) throw new RowError('permission_denied');
            if (course.status === 'archived') throw new RowError('course_archived');
            if (!course.publishedVersionId) throw new RowError('course_not_published');
          }
          if (course && courseRole && !o.canAssignCourseRole) throw new RowError('permission_denied');

          await c.query('SAVEPOINT import_row');
          try {
            const spec: RoleSpec = courseRole ? { role, courseId: course!.id } : { role };
            const m = await this.membership.ensureMemberTx(c, orgId, { email: it.email, displayName: it.displayName, spec, allowCreate: o.allowCreate, actorId: o.actorId });
            if (m.created) {
              actions.push('account_created');
              created.push(m.userId);
            }
            if (m.added) {
              actions.push('member_added');
              audits.push(this.record(o, orgId, null, 'org.user.created', 'user', m.userId, { email: it.email, role, invited: m.created }, batchId));
              if (courseRole) audits.push(this.record(o, orgId, course!.id, 'org.role.assigned', 'user', m.userId, { roles: [spec] }, batchId));
            }
            if (course && courseRole && !m.added && (await this.membership.grantCourseRoleTx(c, orgId, m.userId, spec, o.actorId))) {
              actions.push('course_role_granted');
              audits.push(this.record(o, orgId, course.id, 'org.role.assigned', 'user', m.userId, { roles: [spec] }, batchId));
            } else if (course && courseRole && m.added) {
              actions.push('course_role_granted');
            }
            if (course && role === 'learner') {
              const e = await this.enrollments.enrollInTx(c, { id: course.id, organizationId: orgId, publishedVersionId: course.publishedVersionId! }, m.userId, o.actorId, null, 'bulk_import');
              if (e.created) {
                actions.push('enrolled');
                audits.push(
                  this.record(o, orgId, course.id, 'enrollment.assigned', 'enrollment', e.enrollmentId, { userId: m.userId, courseVersionId: course.publishedVersionId, status: 'active' }, batchId, {
                    learner_role_granted: e.learnerRoleGranted,
                  }),
                );
              }
            }
            await c.query('RELEASE SAVEPOINT import_row');
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT import_row');
            actions.length = 0;
            throw e instanceof DomainError && e.details?.[0] ? new RowError(e.details[0].issue) : e;
          }
          if (actions.length) push('ok');
          else push('skipped', course && role === 'learner' ? 'already_enrolled' : course ? 'already_assigned' : 'already_member');
        } catch (e) {
          if (!(e instanceof RowError)) throw e;
          push('error', e.issue);
        }
      }

      activeAfter = await this.activeLearners(c);
      exceededBy = maxActiveLearners !== null && activeAfter > maxActiveLearners && activeAfter > activeBefore ? activeAfter - maxActiveLearners : 0;
      if (o.dryRun) await c.query('ROLLBACK');
      else if (exceededBy > 0) throw new DomainError('LICENSE_LIMIT_EXCEEDED');
      else await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }

    let invitationsSent = 0;
    if (!o.dryRun) {
      for (const a of audits) await this.audit.write(a);
      invitationsSent = await this.membership.inviteNew(orgId, created);
    }
    const count = (a: ImportAction) => results.filter((r) => r.actions.includes(a)).length;
    return {
      dryRun: o.dryRun,
      batchId,
      rows: results,
      summary: {
        total: results.length,
        ok: results.filter((r) => r.outcome === 'ok').length,
        skipped: results.filter((r) => r.outcome === 'skipped').length,
        errors: results.filter((r) => r.outcome === 'error').length,
        accountsCreated: count('account_created'),
        membersAdded: count('member_added'),
        enrollments: count('enrolled'),
        courseRoles: count('course_role_granted'),
        invitationsSent,
      },
      license: { maxActiveLearners, activeLearnersAfter: activeAfter, exceededBy },
    };
  }

  /** 計入授權的學員數：active／suspended／reopened 的不重複學員（與 LicenseService.usage 相同定義，但在交易內計算） */
  private async activeLearners(c: pg.PoolClient): Promise<number> {
    const r = await c.query<{ n: number }>(`SELECT count(DISTINCT user_id)::int AS n FROM enrollments WHERE status IN ('active', 'suspended', 'reopened')`);
    return r.rows[0]!.n;
  }

  private record(
    o: ImportOptions,
    orgId: string,
    courseId: string | null,
    action: AuditRecord['action'],
    resourceType: string,
    resourceId: string,
    after: unknown,
    batchId: string | null,
    extra: Record<string, unknown> = {},
  ): AuditRecord {
    return {
      action,
      resourceType,
      resourceId,
      actorUserId: o.actorId,
      organizationId: orgId,
      courseId,
      ip: o.meta.ip,
      userAgent: o.meta.userAgent,
      correlationId: o.meta.correlationId,
      after,
      metadata: { via: 'bulk_import', batch_id: batchId, ...extra },
    };
  }
}

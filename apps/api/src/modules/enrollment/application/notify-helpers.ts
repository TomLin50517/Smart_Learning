import type { NotificationPayload } from '@iac/contracts';
import type pg from 'pg';

/** 課程通知的共同內容（SD §6.26）：組織名稱與課程——不含學習細節 */
export async function courseNotice(c: pg.PoolClient, courseId: string): Promise<NotificationPayload> {
  const r = await c.query<{ title: string; name: string }>(`SELECT c.title, o.name FROM courses c JOIN organizations o ON o.id = c.organization_id WHERE c.id = $1`, [courseId]);
  return { courseId, courseTitle: r.rows[0]?.title ?? '', organizationName: r.rows[0]?.name ?? '' };
}

/** 選課的學員與通知內容 */
export async function enrollmentNotice(c: pg.PoolClient, enrollmentId: string): Promise<{ userId: string; organizationId: string; payload: NotificationPayload }> {
  const r = await c.query<{ user_id: string; organization_id: string; course_id: string; title: string; name: string }>(
    `SELECT e.user_id, e.organization_id, e.course_id, c.title, o.name
       FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN organizations o ON o.id = e.organization_id
      WHERE e.id = $1`,
    [enrollmentId],
  );
  const x = r.rows[0]!;
  return { userId: x.user_id, organizationId: x.organization_id, payload: { organizationName: x.name, courseId: x.course_id, courseTitle: x.title, enrollmentId } };
}

/** 可以審核加入申請的人：組織管理員與這門課的課程管理員（成員資格未停用） */
export async function approverIds(c: pg.PoolClient, organizationId: string, courseId: string): Promise<string[]> {
  const r = await c.query<{ user_id: string }>(
    `SELECT DISTINCT r.user_id FROM user_org_roles r JOIN roles ro ON ro.id = r.role_id
      WHERE r.organization_id = $1
        AND ((ro.code = 'org_admin' AND r.scope_type = 'organization') OR (ro.code = 'course_admin' AND r.scope_type = 'course' AND r.scope_id = $2))
        AND NOT EXISTS (SELECT 1 FROM disabled_memberships d WHERE d.organization_id = r.organization_id AND d.user_id = r.user_id)`,
    [organizationId, courseId],
  );
  return r.rows.map((x) => x.user_id);
}

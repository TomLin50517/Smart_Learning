import { Inject, Injectable } from '@nestjs/common';
import { COURSE_ROLES, type OrgMemberDto, type OrgRole, type OrganizationDto, type RoleSpec } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { USER_INVITATIONS, type UserInvitations } from '../../identity/identity.contracts.js';

type Tx = pg.PoolClient;

const invalid = (field: string, issue: string) => new DomainError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);

/**
 * 組織、成員與角色（SA UC-ORG-001~004）。
 *
 * 角色指派的護欄：
 *  - platform_admin 不可經由組織端點授予（輸入驗證層即排除）
 *  - course_admin / instructor 必須指定「屬於本組織」的課程
 *  - 任何會讓組織失去最後一位 org_admin 的變更都會被拒絕
 *  - 新成員一律以邀請信自行設定密碼，管理員永不經手他人密碼
 */
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(USER_INVITATIONS) private readonly invitations: UserInvitations,
  ) {}

  async list(scope: 'all' | string[]): Promise<OrganizationDto[]> {
    if (scope !== 'all' && scope.length === 0) return [];
    const r =
      scope === 'all'
        ? await this.db.query(`SELECT id, code, name, status, branding, created_at FROM organizations ORDER BY name`)
        : await this.db.query(
            `SELECT id, code, name, status, branding, created_at FROM organizations
              WHERE id = ANY($1::uuid[]) AND status = 'active' ORDER BY name`,
            [scope],
          );
    return r.rows.map(toOrg);
  }

  async get(id: string): Promise<OrganizationDto> {
    const r = await this.db.query(`SELECT id, code, name, status, branding, created_at FROM organizations WHERE id = $1`, [id]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return toOrg(r.rows[0]);
  }

  async create(
    input: { code: string; name: string; initialAdmin?: { email: string; displayName: string } },
    actorId: string,
  ): Promise<{ organization: OrganizationDto; initialAdmin?: { userId: string; invited: boolean; emailSent: boolean } }> {
    const client = await this.db.connect();
    let org: OrganizationDto;
    let admin: { userId: string; created: boolean } | undefined;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO organizations (code, name, storage_prefix) VALUES ($1, $2, $1)
         ON CONFLICT (code) DO NOTHING
         RETURNING id, code, name, status, branding, created_at`,
        [input.code, input.name],
      );
      if (!r.rows[0]) throw invalid('code', 'already_exists');
      org = toOrg(r.rows[0]);
      // 新組織的第一位管理員只能在建立時指定——否則沒有人有權限新增成員（SA 缺口，v1.6）
      if (input.initialAdmin) {
        admin = await this.addMemberTx(client, org.id, input.initialAdmin.email, input.initialAdmin.displayName, 'org_admin', actorId);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const emailSent = admin?.created ? await this.invitations.invite(admin.userId, org.name) : false;
    return {
      organization: org,
      ...(admin && { initialAdmin: { userId: admin.userId, invited: admin.created, emailSent } }),
    };
  }

  async update(id: string, patch: { name?: string; branding?: Record<string, unknown> }) {
    const before = await this.db.query<{ name: string; branding: Record<string, unknown> }>(
      `SELECT name, branding FROM organizations WHERE id = $1`,
      [id],
    );
    if (!before.rows[0]) throw new DomainError('NOT_FOUND');
    const r = await this.db.query(
      `UPDATE organizations SET name = COALESCE($2, name), branding = COALESCE($3, branding)
        WHERE id = $1 RETURNING id, code, name, status, branding, created_at`,
      [id, patch.name ?? null, patch.branding ?? null],
    );
    const after = toOrg(r.rows[0]);
    return { organization: after, before: before.rows[0], after: { name: after.name, branding: after.branding } };
  }

  async setStatus(id: string, status: 'active' | 'disabled') {
    const before = await this.db.query<{ status: string }>(`SELECT status FROM organizations WHERE id = $1`, [id]);
    if (!before.rows[0]) throw new DomainError('NOT_FOUND');
    const r = await this.db.query(
      `UPDATE organizations SET status = $2 WHERE id = $1 RETURNING id, code, name, status, branding, created_at`,
      [id, status],
    );
    return { organization: toOrg(r.rows[0]), before: { status: before.rows[0].status }, after: { status } };
  }

  async listMembers(orgId: string, cursor: string | undefined, limit: number): Promise<{ data: OrgMemberDto[]; nextCursor: string | null }> {
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : null;
    const r = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
      status: 'active' | 'disabled';
      last_login_at: Date | null;
      pending: boolean;
      roles: { role: OrgRole; scope_type: string; scope_id: string | null }[];
    }>(
      `SELECT u.id, u.email, u.display_name, u.status, u.last_login_at, u.password_hash IS NULL AS pending,
              json_agg(json_build_object('role', ro.code, 'scope_type', uor.scope_type, 'scope_id', uor.scope_id)
                       ORDER BY ro.code) AS roles
         FROM user_org_roles uor
         JOIN users u  ON u.id = uor.user_id
         JOIN roles ro ON ro.id = uor.role_id
        WHERE uor.organization_id = $1 AND ($2::citext IS NULL OR u.email > $2::citext)
        GROUP BY u.id
        ORDER BY u.email
        LIMIT $3`,
      [orgId, after, limit + 1],
    );
    const page = r.rows.slice(0, limit);
    return {
      data: page.map((m) => ({
        id: m.id,
        email: m.email,
        displayName: m.display_name,
        status: m.status,
        lastLoginAt: m.last_login_at?.toISOString() ?? null,
        pendingInvitation: m.pending,
        roles: m.roles.map((x) => toSpec(x.role, x.scope_type, x.scope_id)),
      })),
      nextCursor: r.rows.length > limit ? Buffer.from(page[page.length - 1]!.email).toString('base64url') : null,
    };
  }

  async addMember(orgId: string, input: { email: string; displayName: string; role: OrgRole }, actorId: string) {
    const client = await this.db.connect();
    let m: { userId: string; created: boolean };
    let orgName: string;
    try {
      await client.query('BEGIN');
      const o = await client.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
      orgName = o.rows[0]!.name;
      m = await this.addMemberTx(client, orgId, input.email, input.displayName, input.role, actorId);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    // invited：是否為新帳號（需設定密碼）；emailSent：邀請信是否已交給郵件伺服器
    const emailSent = m.created ? await this.invitations.invite(m.userId, orgName) : false;
    return { userId: m.userId, invited: m.created, emailSent };
  }

  /** 以「整組取代」設定使用者在本組織的角色；回傳變更前後供稽核 */
  async setRoles(orgId: string, userId: string, roles: RoleSpec[], actorId: string): Promise<{ before: RoleSpec[]; after: RoleSpec[] }> {
    const wanted = dedupe(roles);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ role: OrgRole; scope_type: string; scope_id: string | null }>(
        `SELECT ro.code AS role, uor.scope_type, uor.scope_id
           FROM user_org_roles uor JOIN roles ro ON ro.id = uor.role_id
          WHERE uor.user_id = $1 AND uor.organization_id = $2
          FOR UPDATE OF uor`,
        [userId, orgId],
      );
      // 不是本組織成員 → 404（不透露此使用者是否存在於其他組織）
      if (!cur.rowCount) throw new DomainError('NOT_FOUND');

      const courseIds = [...new Set(wanted.filter((r) => r.courseId).map((r) => r.courseId!))];
      if (courseIds.length) {
        const ok = await client.query<{ id: string }>(`SELECT id FROM courses WHERE id = ANY($1::uuid[]) AND organization_id = $2`, [
          courseIds,
          orgId,
        ]);
        if (ok.rowCount !== courseIds.length) throw invalid('roles', 'course_not_in_organization');
      }

      const losingAdmin = cur.rows.some((r) => r.role === 'org_admin') && !wanted.some((r) => r.role === 'org_admin');
      if (losingAdmin) {
        const others = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM user_org_roles uor JOIN roles ro ON ro.id = uor.role_id
            WHERE uor.organization_id = $1 AND ro.code = 'org_admin' AND uor.user_id <> $2`,
          [orgId, userId],
        );
        if (!others.rows[0]!.n) throw invalid('roles', 'last_org_admin');
      }

      await client.query(`DELETE FROM user_org_roles WHERE user_id = $1 AND organization_id = $2`, [userId, orgId]);
      for (const spec of wanted) await this.insertGrant(client, orgId, userId, spec, actorId);
      // course_staff 是課程範圍角色的名冊，須與 user_org_roles 同步（課程端的指派見 CourseService.assignStaff）
      await client.query(
        `DELETE FROM course_staff cs USING courses c
          WHERE cs.course_id = c.id AND c.organization_id = $2 AND cs.user_id = $1 AND cs.staff_role IN ('instructor', 'course_admin')`,
        [userId, orgId],
      );
      for (const spec of wanted.filter((r) => r.courseId)) {
        await client.query(
          `INSERT INTO course_staff (course_id, user_id, staff_role, assigned_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [spec.courseId, userId, spec.role, actorId],
        );
      }
      await client.query('COMMIT');

      return { before: cur.rows.map((r) => toSpec(r.role, r.scope_type, r.scope_id)), after: wanted };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 管理員復原（ADR-033）：組織已沒有任何「啟用中」的 org_admin 時，由平台管理員指定一位。
   * 仍有啟用中的管理員時拒絕——平台管理員平時無權管理組織成員，此端點不能被當成繞道。
   * 對象可為新帳號（寄設定密碼邀請）、他組織的既有帳號，或本組織的既有成員（追加 org_admin）。
   */
  async recoverAdmin(orgId: string, input: { email: string; displayName: string }, actorId: string) {
    const client = await this.db.connect();
    let userId: string;
    let created = false;
    let orgName: string;
    try {
      await client.query('BEGIN');
      // 鎖定組織列：兩位平台管理員同時復原時，只有一位會成功
      const o = await client.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1 FOR UPDATE`, [orgId]);
      if (!o.rows[0]) throw new DomainError('NOT_FOUND');
      orgName = o.rows[0].name;

      const admins = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_org_roles uor
           JOIN roles ro ON ro.id = uor.role_id JOIN users u ON u.id = uor.user_id
          WHERE uor.organization_id = $1 AND ro.code = 'org_admin' AND u.status = 'active'`,
        [orgId],
      );
      if (admins.rows[0]!.n > 0) {
        throw new DomainError('VALIDATION_FAILED', 'Organization still has an active admin', [{ issue: 'org_has_active_admin' }]);
      }

      const existing = await client.query<{ id: string; status: string }>(`SELECT id, status FROM users WHERE email = $1`, [input.email]);
      if (existing.rows[0]) {
        if (existing.rows[0].status !== 'active') throw invalid('email', 'user_not_active');
        userId = existing.rows[0].id;
        const has = await client.query(
          `SELECT 1 FROM user_org_roles uor JOIN roles ro ON ro.id = uor.role_id
            WHERE uor.user_id = $1 AND uor.organization_id = $2 AND ro.code = 'org_admin'`,
          [userId, orgId],
        );
        if (!has.rowCount) await this.insertGrant(client, orgId, userId, { role: 'org_admin' }, actorId);
      } else {
        const u = await client.query<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [
          input.email,
          input.displayName,
        ]);
        userId = u.rows[0]!.id;
        created = true;
        await this.insertGrant(client, orgId, userId, { role: 'org_admin' }, actorId);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const emailSent = created ? await this.invitations.invite(userId, orgName) : false;
    return { userId, invited: created, emailSent };
  }

  private async addMemberTx(tx: Tx, orgId: string, email: string, displayName: string, role: OrgRole, actorId: string) {
    const existing = await tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    let userId = existing.rows[0]?.id;
    let created = false;
    if (userId) {
      const member = await tx.query(`SELECT 1 FROM user_org_roles WHERE user_id = $1 AND organization_id = $2`, [userId, orgId]);
      if (member.rowCount) throw invalid('email', 'already_member');
    } else {
      // 不設密碼：由本人經邀請信設定
      const u = await tx.query<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [email, displayName]);
      userId = u.rows[0]!.id;
      created = true;
    }
    await this.insertGrant(tx, orgId, userId, { role }, actorId);
    return { userId, created };
  }

  private async insertGrant(tx: Tx, orgId: string, userId: string, spec: RoleSpec, actorId: string): Promise<void> {
    const [scopeType, scopeId] = COURSE_ROLES.includes(spec.role)
      ? ['course', spec.courseId!]
      : spec.role === 'learner'
        ? ['self', userId]
        : ['organization', orgId];
    await tx.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id, granted_by)
       SELECT $1, id, $3::scope_type, $4, $5, $6 FROM roles WHERE code = $2`,
      [userId, spec.role, scopeType, scopeId, orgId, actorId],
    );
  }
}

function toOrg(r: { id: string; code: string; name: string; status: 'active' | 'disabled'; branding: Record<string, unknown>; created_at: Date }): OrganizationDto {
  return { id: r.id, code: r.code, name: r.name, status: r.status, branding: r.branding, createdAt: r.created_at.toISOString() };
}

function toSpec(role: OrgRole, scopeType: string, scopeId: string | null): RoleSpec {
  return scopeType === 'course' && scopeId ? { role, courseId: scopeId } : { role };
}

function dedupe(roles: RoleSpec[]): RoleSpec[] {
  const seen = new Map<string, RoleSpec>();
  for (const r of roles) seen.set(`${r.role}:${r.courseId ?? ''}`, r.courseId ? { role: r.role, courseId: r.courseId } : { role: r.role });
  return [...seen.values()];
}

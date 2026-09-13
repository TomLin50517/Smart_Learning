import { Inject, Injectable } from '@nestjs/common';
import {
  COURSE_ROLES,
  type MemberRoleDto,
  type MembershipStatus,
  type OrgMemberDto,
  type OrgRole,
  type OrganizationDto,
  type RoleSpec,
} from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { USER_INVITATIONS, type UserInvitations } from '../../identity/identity.contracts.js';
import type { MembershipResult, OrgMembership } from '../organization.contracts.js';

type Tx = pg.PoolClient;
type Q = pg.Pool | pg.PoolClient;

const invalid = (field: string, issue: string) => new DomainError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
const rejected = (issue: string) => new DomainError('VALIDATION_FAILED', issue, [{ issue }]);

export interface MemberQuery {
  /** 成員資格狀態篩選 */
  status?: MembershipStatus | undefined;
  cursor?: string | undefined;
  limit: number;
  /** 只列出持有此角色的成員（課程角色不分課程） */
  role?: OrgRole | undefined;
  /** 姓名或 email 的部分字串，不分大小寫 */
  q?: string | undefined;
}

interface RoleRow {
  role: OrgRole;
  scope_type: string;
  scope_id: string | null;
  course_code: string | null;
  course_title: string | null;
}

/** 成員的所有角色；課程角色附課程代碼與名稱（呼叫端須 JOIN roles ro、LEFT JOIN courses c） */
const ROLE_AGG = `json_agg(json_build_object('role', ro.code, 'scope_type', uor.scope_type, 'scope_id', uor.scope_id,
                                             'course_code', c.code, 'course_title', c.title)
                           ORDER BY ro.code, c.code) AS roles`;

/**
 * 組織、成員與角色（SA UC-ORG-001~004）。
 *
 * 角色指派的護欄：
 *  - platform_admin 不可經由組織端點授予（輸入驗證層即排除）
 *  - course_admin / instructor 必須指定「屬於本組織」的課程
 *  - 不能移除自己的 org_admin 角色（須由其他管理員處理，避免誤操作把自己鎖在門外）
 *  - 任何會讓組織失去最後一位「啟用中」org_admin 的變更都會被拒絕；同一組織的角色變更
 *    先鎖定組織列排隊進行——兩位管理員同時互相移除時，後到的一方會被擋下
 *  - 新成員一律以邀請信自行設定密碼，管理員永不經手他人密碼
 */
@Injectable()
export class OrganizationService implements OrgMembership {
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
        admin = await this.addMemberTx(client, org.id, input.initialAdmin.email, input.initialAdmin.displayName, { role: 'org_admin' }, actorId);
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

  /** 依 email 排序的 keyset 分頁；搜尋與角色篩選不影響游標語意 */
  async listMembers(orgId: string, q: MemberQuery): Promise<{ data: OrgMemberDto[]; nextCursor: string | null }> {
    const after = q.cursor ? Buffer.from(q.cursor, 'base64url').toString('utf8') : null;
    // LIKE 萬用字元一律跳脫：搜尋「50%」就是找含「50%」的字串
    const pattern = q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const r = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
      status: 'active' | 'disabled';
      last_login_at: Date | null;
      pending: boolean;
      member_disabled: boolean;
      roles: RoleRow[];
    }>(
      `SELECT u.id, u.email, u.display_name, u.status, u.last_login_at, u.password_hash IS NULL AS pending,
              EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = $1 AND dm.user_id = u.id) AS member_disabled,
              ${ROLE_AGG}
         FROM user_org_roles uor
         JOIN users u  ON u.id = uor.user_id
         JOIN roles ro ON ro.id = uor.role_id
         LEFT JOIN courses c ON uor.scope_type = 'course' AND c.id = uor.scope_id
        WHERE uor.organization_id = $1 AND ($2::citext IS NULL OR u.email > $2::citext)
          AND ($4::text IS NULL OR u.email::text ILIKE $4 OR u.display_name ILIKE $4)
          AND ($5::text IS NULL OR EXISTS (
                SELECT 1 FROM user_org_roles f JOIN roles fr ON fr.id = f.role_id
                 WHERE f.user_id = u.id AND f.organization_id = $1 AND fr.code = $5))
          AND ($6::text IS NULL OR ($6::text = 'disabled') = EXISTS (
                SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = $1 AND dm.user_id = u.id))
        GROUP BY u.id
        ORDER BY u.email
        LIMIT $3`,
      [orgId, after, q.limit + 1, pattern, q.role ?? null, q.status ?? null],
    );
    const page = r.rows.slice(0, q.limit);
    return {
      data: page.map((m) => ({
        id: m.id,
        email: m.email,
        displayName: m.display_name,
        status: m.status,
        lastLoginAt: m.last_login_at?.toISOString() ?? null,
        pendingInvitation: m.pending,
        membershipStatus: m.member_disabled ? 'disabled' : 'active',
        roles: m.roles.map(toMemberRole),
      })),
      nextCursor: r.rows.length > q.limit ? Buffer.from(page[page.length - 1]!.email).toString('base64url') : null,
    };
  }

  /** 新增成員；課程角色（講師／課程管理員）可直接指定課程，不必先掛成學員 */
  async addMember(orgId: string, input: { email: string; displayName: string; role: OrgRole; courseId?: string | undefined }, actorId: string) {
    const spec: RoleSpec = input.courseId ? { role: input.role, courseId: input.courseId } : { role: input.role };
    const client = await this.db.connect();
    let m: { userId: string; created: boolean };
    let orgName: string;
    try {
      await client.query('BEGIN');
      const o = await client.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
      orgName = o.rows[0]!.name;
      if (spec.courseId) await assertCoursesInOrg(client, orgId, [spec.courseId], 'courseId');
      m = await this.addMemberTx(client, orgId, input.email, input.displayName, spec, actorId);
      if (spec.courseId) await syncCourseStaff(client, orgId, m.userId, [spec], actorId);
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

  /**
   * 以「整組取代」設定使用者在本組織的角色。
   * 回傳 before／after（RoleSpec，供稽核）與 roles（附課程資訊，供畫面更新）。
   */
  async setRoles(
    orgId: string,
    userId: string,
    roles: RoleSpec[],
    actorId: string,
  ): Promise<{ before: RoleSpec[]; after: RoleSpec[]; roles: MemberRoleDto[] }> {
    const wanted = dedupe(roles);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // 同一組織的角色變更排隊進行（與 recoverAdmin 相同的鎖）：兩位管理員同時互相移除時，
      // 後到的請求會在前者提交後才檢查，看得到「只剩自己」而被 last_org_admin 擋下。
      // NO KEY UPDATE 不阻擋其他交易插入參照此組織的資料（FK 檢查只需 KEY SHARE）
      await client.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [orgId]);
      const cur = await client.query<{ role: OrgRole; scope_type: string; scope_id: string | null }>(
        `SELECT ro.code AS role, uor.scope_type, uor.scope_id
           FROM user_org_roles uor JOIN roles ro ON ro.id = uor.role_id
          WHERE uor.user_id = $1 AND uor.organization_id = $2`,
        [userId, orgId],
      );
      // 不是本組織成員 → 404（不透露此使用者是否存在於其他組織）
      if (!cur.rowCount) throw new DomainError('NOT_FOUND');

      const losingAdmin = cur.rows.some((r) => r.role === 'org_admin') && !wanted.some((r) => r.role === 'org_admin');
      if (losingAdmin) {
        if (userId === actorId) throw invalid('roles', 'cannot_remove_own_admin');
        // 只計「啟用中」的其他管理員——停用帳號或停用成員資格者不能管理組織，不算數
        if (!(await countActiveAdmins(client, orgId, userId))) throw invalid('roles', 'last_org_admin');
      }

      const courseIds = [...new Set(wanted.filter((r) => r.courseId).map((r) => r.courseId!))];
      await assertCoursesInOrg(client, orgId, courseIds, 'roles');

      await client.query(`DELETE FROM user_org_roles WHERE user_id = $1 AND organization_id = $2`, [userId, orgId]);
      for (const spec of wanted) await this.insertGrant(client, orgId, userId, spec, actorId);
      // course_staff 是課程範圍角色的名冊，須與 user_org_roles 同步（課程端的指派見 CourseService.assignStaff）
      await client.query(
        `DELETE FROM course_staff cs USING courses c
          WHERE cs.course_id = c.id AND c.organization_id = $2 AND cs.user_id = $1 AND cs.staff_role IN ('instructor', 'course_admin')`,
        [userId, orgId],
      );
      await syncCourseStaff(client, orgId, userId, wanted, actorId);
      // 移除全部角色＝離開組織；停用紀錄一併清掉，日後重新加入時是全新的成員資格
      if (!wanted.length) await client.query(`DELETE FROM disabled_memberships WHERE organization_id = $1 AND user_id = $2`, [orgId, userId]);
      const after = await memberRoles(client, orgId, userId);
      await client.query('COMMIT');

      return { before: cur.rows.map((r) => toSpec(r.role, r.scope_type, r.scope_id)), after: wanted, roles: after };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 停用／恢復在本組織的成員資格（SD §8.9）。角色原樣保留；權限從下一個請求起失效／恢復
   * （GrantLoader 每個請求重新載入）。帳號本身與其他組織不受影響。重複呼叫不變更（冪等）。
   * 護欄與角色指派相同：不能停用自己、不能讓組織失去最後一位啟用中的 org_admin、先鎖定組織列排隊進行。
   */
  async setMembershipStatus(
    orgId: string,
    userId: string,
    status: MembershipStatus,
    actorId: string,
  ): Promise<{ before: MembershipStatus; after: MembershipStatus }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [orgId]);
      const m = await client.query<{ n: number; is_admin: boolean | null; disabled: boolean }>(
        `SELECT count(*)::int AS n, bool_or(ro.code = 'org_admin') AS is_admin,
                EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = $2 AND dm.user_id = $1) AS disabled
           FROM user_org_roles uor JOIN roles ro ON ro.id = uor.role_id
          WHERE uor.user_id = $1 AND uor.organization_id = $2`,
        [userId, orgId],
      );
      const row = m.rows[0]!;
      // 不是本組織成員 → 404（不透露此使用者是否存在於其他組織）
      if (!row.n) throw new DomainError('NOT_FOUND');
      const before: MembershipStatus = row.disabled ? 'disabled' : 'active';

      if (status === 'disabled' && before === 'active') {
        if (userId === actorId) throw rejected('cannot_disable_self');
        if (row.is_admin && !(await countActiveAdmins(client, orgId, userId))) throw rejected('last_org_admin');
        await client.query(`INSERT INTO disabled_memberships (organization_id, user_id, disabled_by) VALUES ($1, $2, $3)`, [orgId, userId, actorId]);
      } else if (status === 'active' && before === 'disabled') {
        await client.query(`DELETE FROM disabled_memberships WHERE organization_id = $1 AND user_id = $2`, [orgId, userId]);
      }
      await client.query('COMMIT');
      return { before, after: status };
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

      // 「啟用中」＝帳號啟用且成員資格未停用；只剩停用中的管理員時可復原
      if ((await countActiveAdmins(client, orgId, null)) > 0) {
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
        // 對象若是成員資格已停用的本組織成員，復原即一併恢復——否則加上 org_admin 也無法管理
        await client.query(`DELETE FROM disabled_memberships WHERE organization_id = $1 AND user_id = $2`, [orgId, userId]);
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

  // ------------------------------------------------------------------ OrgMembership（批次匯入，SD §6.11）

  async ensureMemberTx(
    tx: Tx,
    orgId: string,
    input: { email: string; displayName: string | null; spec: RoleSpec; allowCreate: boolean; actorId: string },
  ): Promise<MembershipResult> {
    const u = await tx.query<{ id: string; status: string }>(`SELECT id, status FROM users WHERE email = $1`, [input.email]);
    const existing = u.rows[0];
    if (existing && existing.status !== 'active') throw invalid('email', 'user_not_active');
    if (existing) {
      const m = await tx.query<{ disabled: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = $2 AND dm.user_id = $1) AS disabled
           FROM user_org_roles WHERE user_id = $1 AND organization_id = $2 LIMIT 1`,
        [existing.id, orgId],
      );
      if (m.rows[0]) {
        if (m.rows[0].disabled) throw invalid('email', 'member_disabled');
        // 已是成員：不經由匯入變更既有角色（只新增課程指派或選課）
        return { userId: existing.id, created: false, added: false };
      }
      await this.insertGrant(tx, orgId, existing.id, input.spec, input.actorId);
      await syncCourseStaff(tx, orgId, existing.id, [input.spec], input.actorId);
      return { userId: existing.id, created: false, added: true };
    }
    if (!input.allowCreate) throw invalid('email', 'not_in_organization');
    if (!input.displayName) throw invalid('displayName', 'name_required');
    // 不設密碼：由本人經邀請信設定
    const n = await tx.query<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [input.email, input.displayName]);
    const userId = n.rows[0]!.id;
    await this.insertGrant(tx, orgId, userId, input.spec, input.actorId);
    await syncCourseStaff(tx, orgId, userId, [input.spec], input.actorId);
    return { userId, created: true, added: true };
  }

  async grantCourseRoleTx(tx: Tx, orgId: string, userId: string, spec: RoleSpec, actorId: string): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id, granted_by)
       SELECT $1, id, 'course'::scope_type, $2, $3, $4 FROM roles WHERE code = $5
       ON CONFLICT DO NOTHING`,
      [userId, spec.courseId, orgId, actorId, spec.role],
    );
    await syncCourseStaff(tx, orgId, userId, [spec], actorId);
    return (r.rowCount ?? 0) > 0;
  }

  async inviteNew(orgId: string, userIds: readonly string[]): Promise<number> {
    if (!userIds.length) return 0;
    const o = await this.db.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
    let sent = 0;
    for (const id of userIds) if (await this.invitations.invite(id, o.rows[0]!.name)) sent++;
    return sent;
  }

  private async addMemberTx(tx: Tx, orgId: string, email: string, displayName: string, spec: RoleSpec, actorId: string) {
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
    await this.insertGrant(tx, orgId, userId, spec, actorId);
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

/** 本組織「啟用中」的 org_admin 人數（可排除某人）：帳號啟用，且在本組織的成員資格未停用 */
async function countActiveAdmins(tx: Q, orgId: string, excludeUserId: string | null): Promise<number> {
  const r = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_org_roles uor
       JOIN roles ro ON ro.id = uor.role_id JOIN users u ON u.id = uor.user_id
      WHERE uor.organization_id = $1 AND ro.code = 'org_admin' AND u.status = 'active'
        AND ($2::uuid IS NULL OR uor.user_id <> $2::uuid)
        AND NOT EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = $1 AND dm.user_id = uor.user_id)`,
    [orgId, excludeUserId],
  );
  return r.rows[0]!.n;
}

async function assertCoursesInOrg(tx: Tx, orgId: string, courseIds: string[], field: 'roles' | 'courseId'): Promise<void> {
  if (!courseIds.length) return;
  const ok = await tx.query(`SELECT id FROM courses WHERE id = ANY($1::uuid[]) AND organization_id = $2`, [courseIds, orgId]);
  if (ok.rowCount !== courseIds.length) throw invalid(field, 'course_not_in_organization');
}

/** 課程範圍角色寫入 course_staff 名冊（已存在則略過） */
async function syncCourseStaff(tx: Tx, orgId: string, userId: string, specs: RoleSpec[], actorId: string): Promise<void> {
  for (const spec of specs.filter((r) => r.courseId)) {
    await tx.query(
      `INSERT INTO course_staff (course_id, user_id, staff_role, assigned_by)
       SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM courses WHERE id = $1 AND organization_id = $5)
       ON CONFLICT DO NOTHING`,
      [spec.courseId, userId, spec.role, actorId, orgId],
    );
  }
}

async function memberRoles(q: Q, orgId: string, userId: string): Promise<MemberRoleDto[]> {
  const r = await q.query<{ roles: RoleRow[] }>(
    `SELECT ${ROLE_AGG}
       FROM user_org_roles uor
       JOIN roles ro ON ro.id = uor.role_id
       LEFT JOIN courses c ON uor.scope_type = 'course' AND c.id = uor.scope_id
      WHERE uor.organization_id = $1 AND uor.user_id = $2`,
    [orgId, userId],
  );
  return (r.rows[0]?.roles ?? []).map(toMemberRole);
}

function toOrg(r: { id: string; code: string; name: string; status: 'active' | 'disabled'; branding: Record<string, unknown>; created_at: Date }): OrganizationDto {
  return { id: r.id, code: r.code, name: r.name, status: r.status, branding: r.branding, createdAt: r.created_at.toISOString() };
}

function toSpec(role: OrgRole, scopeType: string, scopeId: string | null): RoleSpec {
  return scopeType === 'course' && scopeId ? { role, courseId: scopeId } : { role };
}

function toMemberRole(x: RoleRow): MemberRoleDto {
  const spec: MemberRoleDto = toSpec(x.role, x.scope_type, x.scope_id);
  if (spec.courseId && x.course_code !== null) spec.course = { code: x.course_code, title: x.course_title ?? '' };
  return spec;
}

function dedupe(roles: RoleSpec[]): RoleSpec[] {
  const seen = new Map<string, RoleSpec>();
  for (const r of roles) seen.set(`${r.role}:${r.courseId ?? ''}`, r.courseId ? { role: r.role, courseId: r.courseId } : { role: r.role });
  return [...seen.values()];
}

import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { COURSE_ROLES, MEMBER_SEARCH_MAX, type OrgMemberDto, type OrgRole, type OrganizationDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { organizationsGranted } from '../../../common/authz.js';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { OrganizationService } from '../application/organization.service.js';

/**
 * ID 以 z.guid() 驗證（任何 8-4-4-4-12 十六進位），對齊 PostgreSQL uuid 型別。
 * 不用 z.uuid()：zod 4 會檢查 RFC 版本位元，拒絕資料庫中合法但非 v4 的 ID（匯入資料等）。
 */
const Code = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lowercase letters, digits and hyphens');
const Person = z.strictObject({ email: z.email().max(254), displayName: z.string().trim().min(1).max(200) });

const CreateOrg = z.strictObject({
  code: Code,
  name: z.string().trim().min(1).max(200),
  initialAdmin: Person.optional(),
});

const UpdateOrg = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    // 只允許品牌 token，禁止任意 HTML／CSS（SD §7.5 精神）
    branding: z
      .strictObject({
        primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        logoAssetId: z.guid().optional(),
      })
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.branding !== undefined, 'nothing_to_update');

const Role = z.enum(['org_admin', 'course_admin', 'instructor', 'learner', 'auditor']);
/** 課程角色必須指定 courseId，其他角色不可指定（issue 代碼，見 validation.ts） */
const courseIdMatchesRole = (r: { role: OrgRole; courseId?: string | undefined }) => COURSE_ROLES.includes(r.role) === (r.courseId !== undefined);
const COURSE_ID_MISMATCH = { message: 'course_id_mismatch', path: ['courseId'] };

/** 新增成員：講師／課程管理員可直接指定課程，不必先掛成學員 */
const AddMember = Person.extend({ role: Role.default('learner'), courseId: z.guid().optional() }).refine(courseIdMatchesRole, COURSE_ID_MISMATCH);

const RoleSpecSchema = z.strictObject({ role: Role, courseId: z.guid().optional() }).refine(courseIdMatchesRole, COURSE_ID_MISMATCH);
const SetRoles = z.strictObject({ roles: z.array(RoleSpecSchema).max(50) });

const Paging = z.object({ cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });
const MemberQuery = Paging.extend({
  role: Role.optional(),
  q: z
    .string()
    .trim()
    .max(MEMBER_SEARCH_MAX)
    .optional()
    .transform((v) => v || undefined),
});

@Controller('api/organizations')
export class OrganizationController {
  constructor(private readonly orgs: OrganizationService) {}

  /** openapi: listOrganizations——platform 看全部，其他人只看自己有 org.read 的組織 */
  @Get()
  @RequirePermission('org.read', { scope: 'any' })
  list(@Req() req: FastifyRequest): Promise<OrganizationDto[]> {
    return this.orgs.list(organizationsGranted(req.ctx.grants ?? [], 'org.read'));
  }

  /** openapi: createOrganization */
  @Post()
  @RequirePermission('platform.organization.create', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed', limit: 'maxOrganizations' })
  @Audit({ action: 'org.created', resourceType: 'organization' })
  @HttpCode(201)
  async create(@Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest) {
    const input = parseInput(CreateOrg, body);
    const r = await this.orgs.create(input, actor.id);
    req.ctx.audit = {
      resourceId: r.organization.id,
      after: { code: r.organization.code, name: r.organization.name, initialAdmin: input.initialAdmin?.email ?? null },
    };
    return r;
  }

  /** openapi: getOrganization */
  @Get(':id')
  @RequirePermission('org.read', { scope: 'organization', param: 'id' })
  get(@Param('id') id: string): Promise<OrganizationDto> {
    return this.orgs.get(id);
  }

  /** openapi: updateOrganization */
  @Patch(':id')
  @RequirePermission('org.settings.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.updated', resourceType: 'organization' })
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<OrganizationDto> {
    const r = await this.orgs.update(id, parseInput(UpdateOrg, body));
    req.ctx.audit = { before: r.before, after: r.after };
    return r.organization;
  }

  /** openapi: disableOrganization——停用後該組織所有授權立即失效（GrantLoader 過濾） */
  @Post(':id/disable')
  @RequirePermission('platform.organization.disable', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.disabled', resourceType: 'organization' })
  @HttpCode(200)
  async disable(@Param('id') id: string, @Req() req: FastifyRequest): Promise<OrganizationDto> {
    const r = await this.orgs.setStatus(id, 'disabled');
    req.ctx.audit = { before: r.before, after: r.after };
    return r.organization;
  }

  /** openapi: enableOrganization */
  @Post(':id/enable')
  @RequirePermission('platform.organization.disable', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.updated', resourceType: 'organization' })
  @HttpCode(200)
  async enable(@Param('id') id: string, @Req() req: FastifyRequest): Promise<OrganizationDto> {
    const r = await this.orgs.setStatus(id, 'active');
    req.ctx.audit = { before: r.before, after: r.after };
    return r.organization;
  }

  /** openapi: listOrganizationUsers——可依角色篩選、依姓名／email 搜尋 */
  @Get(':id/users')
  @RequirePermission('org.user.read', { scope: 'organization', param: 'id' })
  async members(@Param('id') id: string, @Query() query: unknown): Promise<{ data: OrgMemberDto[]; meta: { next_cursor: string | null } }> {
    const r = await this.orgs.listMembers(id, parseInput(MemberQuery, query));
    return { data: r.data, meta: { next_cursor: r.nextCursor } };
  }

  /** openapi: createOrganizationUser——新帳號寄邀請信；既有帳號直接加入 */
  @Post(':id/users')
  @RequirePermission('org.user.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed', limit: 'maxActiveLearners' })
  @Audit({ action: 'org.user.created', resourceType: 'user' })
  @HttpCode(201)
  async addMember(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest) {
    const input = parseInput(AddMember, body);
    const r = await this.orgs.addMember(id, input, actor.id);
    req.ctx.audit = {
      resourceId: r.userId,
      after: { email: input.email, role: input.role, ...(input.courseId && { courseId: input.courseId }), invited: r.invited, emailSent: r.emailSent },
    };
    return r;
  }

  /**
   * openapi: recoverOrganizationAdmin——組織已無啟用中的管理員時，由平台管理員指定一位（ADR-033）。
   * 稽核記在被復原的組織之下，讓該組織日後的管理員看得到這次介入。
   */
  @Post(':id/admin-recovery')
  @RequirePermission('platform.organization.create', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.role.assigned', resourceType: 'user' })
  @HttpCode(200)
  async recoverAdmin(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest) {
    const orgId = parseInput(z.guid(), id);
    const input = parseInput(Person, body);
    const r = await this.orgs.recoverAdmin(orgId, input, actor.id);
    req.ctx.target = { organizationId: orgId, courseId: null, resourceId: null };
    req.ctx.audit = {
      resourceId: r.userId,
      after: { roles: [{ role: 'org_admin' }] },
      metadata: { reason: 'admin_recovery', email: input.email, invited: r.invited, emailSent: r.emailSent },
    };
    return r;
  }

  /** openapi: assignUserRoles——整組取代；變更前後寫入稽核；回應的角色附課程代碼與名稱 */
  @Patch(':id/users/:userId/roles')
  @RequirePermission('org.role.assign', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.role.assigned', resourceType: 'user' })
  async setRoles(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthUser,
    @Req() req: FastifyRequest,
  ) {
    const { roles } = parseInput(SetRoles, body);
    const r = await this.orgs.setRoles(id, parseInput(z.guid(), userId), roles, actor.id);
    req.ctx.audit = { resourceId: userId, before: { roles: r.before }, after: { roles: r.after } };
    return { roles: r.roles };
  }
}

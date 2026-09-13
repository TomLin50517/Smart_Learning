import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { COHORT_NAME_MAX, COHORT_TERM_MAX, MEMBER_NO_MAX, type CohortDto, type CohortStatus, type MemberProfileDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { CohortService } from '../application/cohort.service.js';

const Name = z.string().trim().min(1).max(COHORT_NAME_MAX);
/** 空字串或 null＝清除 */
const Term = z.union([z.string().trim().max(COHORT_TERM_MAX), z.null()]);
const CreateCohort = z.strictObject({ name: Name, term: Term.optional() });
const UpdateCohort = z.strictObject({ name: Name.optional(), term: Term.optional() }).refine((v) => v.name !== undefined || v.term !== undefined, 'nothing_to_update');
const CohortQuery = z.object({ status: z.enum(['active', 'archived', 'all']).default('active') });
const SetProfile = z
  .strictObject({
    memberNo: z.union([z.string().trim().max(MEMBER_NO_MAX), z.null()]).optional(),
    cohortIds: z.array(z.guid()).max(50).optional(),
  })
  .refine((v) => v.memberNo !== undefined || v.cohortIds !== undefined, 'nothing_to_update');

/** 班級／梯次與成員資料（SD §6.15）：組織管理員管理；調整不影響帳號與角色，不需重新邀請 */
@Controller('api/organizations')
export class CohortController {
  constructor(private readonly cohorts: CohortService) {}

  /** openapi: listCohorts */
  @Get(':id/cohorts')
  @RequirePermission('org.user.read', { scope: 'organization', param: 'id' })
  list(@Param('id') id: string, @Query() query: unknown): Promise<CohortDto[]> {
    return this.cohorts.list(id, parseInput(CohortQuery, query).status);
  }

  /** openapi: createCohort */
  @Post(':id/cohorts')
  @RequirePermission('org.user.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.cohort.created', resourceType: 'cohort' })
  @HttpCode(201)
  async create(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<CohortDto> {
    const c = await this.cohorts.create(id, parseInput(CreateCohort, body), actor.id);
    req.ctx.audit = { resourceId: c.id, after: { name: c.name, term: c.term } };
    return c;
  }

  /** openapi: updateCohort */
  @Patch(':id/cohorts/:cohortId')
  @RequirePermission('org.user.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.cohort.updated', resourceType: 'cohort' })
  async update(@Param('id') id: string, @Param('cohortId') cohortId: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<CohortDto> {
    const r = await this.cohorts.update(id, parseInput(z.guid(), cohortId), parseInput(UpdateCohort, body));
    req.ctx.audit = { resourceId: r.cohort.id, before: r.before, after: { name: r.cohort.name, term: r.cohort.term } };
    return r.cohort;
  }

  /** openapi: archiveCohort——封存後不再是成員的「目前班級」，選課紀錄上的班級名稱不變 */
  @Post(':id/cohorts/:cohortId/archive')
  @RequirePermission('org.user.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.cohort.archived', resourceType: 'cohort' })
  @HttpCode(200)
  archive(@Param('id') id: string, @Param('cohortId') cohortId: string, @Req() req: FastifyRequest): Promise<CohortDto> {
    return this.status(id, cohortId, 'archived', req);
  }

  /** openapi: restoreCohort */
  @Post(':id/cohorts/:cohortId/restore')
  @RequirePermission('org.user.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.cohort.restored', resourceType: 'cohort' })
  @HttpCode(200)
  restore(@Param('id') id: string, @Param('cohortId') cohortId: string, @Req() req: FastifyRequest): Promise<CohortDto> {
    return this.status(id, cohortId, 'active', req);
  }

  private async status(orgId: string, cohortId: string, status: CohortStatus, req: FastifyRequest): Promise<CohortDto> {
    const r = await this.cohorts.setStatus(orgId, parseInput(z.guid(), cohortId), status);
    req.ctx.audit = { resourceId: r.cohort.id, before: { status: r.before }, after: { status } };
    return r.cohort;
  }

  /** openapi: updateMemberProfile——學號與目前班級（整組取代使用中的班級） */
  @Patch(':id/users/:userId/profile')
  @RequirePermission('org.user.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.member.updated', resourceType: 'user' })
  async profile(@Param('id') id: string, @Param('userId') userId: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<MemberProfileDto> {
    const uid = parseInput(z.guid(), userId);
    const r = await this.cohorts.setProfile(id, uid, parseInput(SetProfile, body), actor.id);
    req.ctx.audit = { resourceId: uid, before: r.before, after: r.after };
    return r.after;
  }
}

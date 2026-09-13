import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { CohortDto, ImportReportDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { decideAccess } from '../../../common/authz.js';
import type { AuthUser } from '../../../common/context.js';
import { CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { DomainError } from '../../../common/domain-error.js';
import { parseInput } from '../../../common/validation.js';
import { BulkImportService, type ImportOptions } from '../application/bulk-import.service.js';
import { CohortEnroll, LearnerImport, MemberImport } from '../application/enrollment-inputs.js';

/**
 * 批次匯入（SD §6.11）。稽核由 service 逐列寫入（同一 batch_id），不用 @Audit。
 * 授權上限在 service 的交易內計算（預覽要能回報超過多少），所以不掛 limit 守門。
 */
@Controller('api')
export class BulkImportController {
  constructor(private readonly imports: BulkImportService) {}

  /** openapi: importOrganizationUsers——課程相關的列另需 enrollment.assign／org.role.assign */
  @Post('organizations/:id/users/import')
  @RequirePermission('org.user.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @HttpCode(200)
  members(@Param('id') orgId: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<ImportReportDto> {
    const input = parseInput(MemberImport, body);
    return this.imports.importMembers(orgId, input.rows, {
      ...options(input.dryRun, actor, req),
      canEnroll: allowedInOrg(req, actor, orgId, 'enrollment.assign'),
      canAssignCourseRole: allowedInOrg(req, actor, orgId, 'org.role.assign'),
      createMissingCohorts: input.createMissingCohorts ?? false,
    });
  }

  /** openapi: importCourseEnrollments——建立新帳號需在該組織有 org.user.write */
  @Post('courses/:id/enrollments/import')
  @RequirePermission('enrollment.assign', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @HttpCode(200)
  learners(@Param('id') courseId: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<ImportReportDto> {
    const input = parseInput(LearnerImport, body);
    const orgId = req.ctx.target?.organizationId;
    if (!orgId) throw new DomainError('NOT_FOUND', 'Course not found');
    return this.imports.importLearners(courseId, orgId, input.rows, {
      ...options(input.dryRun, actor, req),
      canCreateAccounts: allowedInOrg(req, actor, orgId, 'org.user.write'),
    });
  }

  /** openapi: listCourseCohorts——課程所屬組織的使用中班級（供整班加入） */
  @Get('courses/:id/cohorts')
  @RequirePermission('enrollment.assign', { scope: 'course', resource: 'course' })
  cohorts(@Param('id') courseId: string): Promise<CohortDto[]> {
    return this.imports.cohortOptions(courseId);
  }

  /** openapi: enrollCohort——整班加入（預覽／確認），與課程學員匯入同一段程式 */
  @Post('courses/:id/enrollments/cohort')
  @RequirePermission('enrollment.assign', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @HttpCode(200)
  cohort(@Param('id') courseId: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<ImportReportDto> {
    const input = parseInput(CohortEnroll, body);
    const orgId = req.ctx.target?.organizationId;
    if (!orgId) throw new DomainError('NOT_FOUND', 'Course not found');
    return this.imports.enrollCohort(courseId, orgId, input.cohortId, options(input.dryRun, actor, req));
  }
}

function options(dryRun: boolean, actor: AuthUser, req: FastifyRequest): ImportOptions {
  const ua = req.headers['user-agent'];
  return { dryRun, actorId: actor.id, meta: { correlationId: req.ctx.correlationId, ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null } };
}

/** 在組織範圍是否持有某權限（PermissionGuard 已載入 grants） */
function allowedInOrg(req: FastifyRequest, actor: AuthUser, orgId: string, permission: string): boolean {
  return decideAccess(actor.id, req.ctx.grants ?? [], permission, { scope: 'organization', exists: true, organizationId: orgId, courseId: null, userId: null }) === 'allow';
}

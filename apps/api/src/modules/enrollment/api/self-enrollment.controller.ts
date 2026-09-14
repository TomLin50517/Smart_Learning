import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ENROLLMENT_STATUSES, JOIN_BY, type CatalogCourseDto, type EnrollmentDto, type EnrollmentPolicyViewDto, type JoinResultDto } from '@iac/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { LearnerExportService } from '../application/learner-export.service.js';
import { SelfEnrollmentService } from '../application/self-enrollment.service.js';

const Policy = z.strictObject({
  joinBy: z.enum(JOIN_BY),
  requireApproval: z.boolean().default(false),
  opensAt: z.iso.datetime({ offset: true }).nullable().default(null),
  closesAt: z.iso.datetime({ offset: true }).nullable().default(null),
  maxSeats: z.number().int().min(1).max(100_000).nullable().default(null),
  regenerateCode: z.boolean().default(false),
});
const Join = z.strictObject({ code: z.string().trim().min(4).max(20) });
const Reject = z.strictObject({ reason: z.string().trim().max(500).optional() });
const ExportQuery = z.object({
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  cohort: z.string().trim().max(200).optional(),
  q: z.string().trim().max(100).optional(),
});

/** 選課政策、學員自行加入、審核、名單匯出（SA UC-ENR-002～004；SD §6.24） */
@Controller('api')
export class SelfEnrollmentController {
  constructor(
    private readonly self: SelfEnrollmentService,
    private readonly exporter: LearnerExportService,
  ) {}

  /** openapi: getEnrollmentPolicy */
  @Get('courses/:id/enrollment-policy')
  @RequirePermission('enrollment.assign', { scope: 'course', resource: 'course' })
  policy(@Param('id') id: string): Promise<EnrollmentPolicyViewDto> {
    return this.self.policy(parseInput(z.guid(), id));
  }

  /** openapi: setEnrollmentPolicy */
  @Put('courses/:id/enrollment-policy')
  @RequirePermission('enrollment.assign', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'course.enrollment_policy.updated', resourceType: 'course' })
  async setPolicy(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<EnrollmentPolicyViewDto> {
    const courseId = parseInput(z.guid(), id);
    const r = await this.self.setPolicy(courseId, parseInput(Policy, body));
    // 選課碼本身不是機密（要發給學員），照常記在稽核的 before／after
    req.ctx.audit = { resourceId: courseId, before: r.before, after: { joinBy: r.after.joinBy, requireApproval: r.after.requireApproval, code: r.after.code, opensAt: r.after.opensAt, closesAt: r.after.closesAt, maxSeats: r.after.maxSeats } };
    return r.after;
  }

  /** openapi: listCatalog——目前組織中公開於課程目錄的課程 */
  @Get('me/catalog')
  @RequirePermission('enrollment.self_enroll', { scope: 'self' })
  catalog(@CurrentUser() user: AuthUser): Promise<CatalogCourseDto[]> {
    return this.self.catalog(user);
  }

  /** openapi: joinByCode——輸入選課碼加入（或送出申請） */
  @Post('me/enrollments/join')
  @RequirePermission('enrollment.self_enroll', { scope: 'self' })
  @RequireCapability({ limit: 'maxActiveLearners' })
  @RateLimit([{ name: 'enrolljoin', by: 'user', limit: 10, windowSec: 60 }])
  @Audit({ action: 'enrollment.joined', resourceType: 'enrollment' })
  @HttpCode(200)
  async joinByCode(@Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<JoinResultDto> {
    const r = await this.self.join(user, parseInput(Join, body));
    req.ctx.audit = { resourceId: r.enrollmentId, after: { courseId: r.courseId, status: r.status }, metadata: { via: 'code', already_enrolled: r.alreadyEnrolled } };
    return r;
  }

  /** openapi: joinFromCatalog */
  @Post('courses/:id/join')
  @RequirePermission('enrollment.self_enroll', { scope: 'self' })
  @RequireCapability({ limit: 'maxActiveLearners' })
  @RateLimit([{ name: 'enrolljoin', by: 'user', limit: 10, windowSec: 60 }])
  @Audit({ action: 'enrollment.joined', resourceType: 'enrollment' })
  @HttpCode(200)
  async joinFromCatalog(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<JoinResultDto> {
    const r = await this.self.join(user, { courseId: parseInput(z.guid(), id) });
    req.ctx.audit = { resourceId: r.enrollmentId, after: { courseId: r.courseId, status: r.status }, metadata: { via: 'catalog', already_enrolled: r.alreadyEnrolled } };
    return r;
  }

  /** openapi: approveEnrollment */
  @Post('enrollments/:id/approve')
  @RequirePermission('enrollment.approve', { scope: 'course', resource: 'enrollment' })
  @RequireCapability({ limit: 'maxActiveLearners' })
  @Audit({ action: 'enrollment.approved', resourceType: 'enrollment' })
  @HttpCode(200)
  async approve(@Param('id') id: string, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<EnrollmentDto> {
    const e = await this.self.approve(parseInput(z.guid(), id), actor.id);
    req.ctx.audit = { resourceId: e.id, before: { status: 'pending' }, after: { status: e.status, courseVersionId: e.courseVersionId } };
    return e;
  }

  /** openapi: rejectEnrollment */
  @Post('enrollments/:id/reject')
  @RequirePermission('enrollment.approve', { scope: 'course', resource: 'enrollment' })
  @Audit({ action: 'enrollment.rejected', resourceType: 'enrollment' })
  @HttpCode(200)
  async reject(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<EnrollmentDto> {
    const { reason } = parseInput(Reject, body ?? {});
    const e = await this.self.reject(parseInput(z.guid(), id));
    req.ctx.audit = { resourceId: e.id, before: { status: 'pending' }, after: { status: e.status }, ...(reason && { metadata: { reason } }) };
    return e;
  }

  /** openapi: exportCourseLearners——CSV（UTF-8 BOM、防公式注入）；每次匯出都留稽核 */
  @Get('courses/:id/learners/export')
  @RequirePermission('learning.result.read_all', { scope: 'course', resource: 'course' })
  @Audit({ action: 'course.learners.exported', resourceType: 'course' })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async export(@Param('id') id: string, @Query() query: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    const courseId = parseInput(z.guid(), id);
    const filters = parseInput(ExportQuery, query);
    const r = await this.exporter.export(courseId, filters);
    void reply.header('content-disposition', `attachment; filename="${r.filename}"`);
    req.ctx.audit = { resourceId: courseId, metadata: { rows: r.rows, status: filters.status ?? null, cohort: filters.cohort ?? null, q: filters.q ?? null } };
    return r.csv;
  }
}

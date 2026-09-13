import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { CourseLearnerDto, EnrollmentDto, MyEnrollmentDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { AssignEnrollment, LearnerQuery } from '../application/enrollment-inputs.js';
import { EnrollmentService } from '../application/enrollment.service.js';
import type { EnrollmentAction } from '../domain/transitions.js';

@Controller('api')
export class EnrollmentController {
  constructor(private readonly enrollments: EnrollmentService) {}

  /** openapi: createEnrollment——管理者指派（自行加入、選課碼、審核於後續批次）；受 maxActiveLearners 限制 */
  @Post('courses/:id/enrollments')
  @RequirePermission('enrollment.assign', { scope: 'course', resource: 'course' })
  @RequireCapability({ limit: 'maxActiveLearners' })
  @Audit({ action: 'enrollment.assigned', resourceType: 'enrollment' })
  @HttpCode(201)
  async assign(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<EnrollmentDto> {
    const r = await this.enrollments.assign(id, parseInput(AssignEnrollment, body), actor.id);
    req.ctx.audit = {
      resourceId: r.enrollment.id,
      after: { userId: r.enrollment.userId, courseVersionId: r.enrollment.courseVersionId, status: r.enrollment.status },
      metadata: { learner_role_granted: r.learnerRoleGranted },
    };
    return r.enrollment;
  }

  /** openapi: listCourseLearners */
  @Get('courses/:id/learners')
  @RequirePermission('learning.result.read_all', { scope: 'course', resource: 'course' })
  async learners(@Param('id') id: string, @Query() query: unknown): Promise<{ data: CourseLearnerDto[]; meta: { next_cursor: string | null } }> {
    const r = await this.enrollments.learners(id, parseInput(LearnerQuery, query));
    return { data: r.data, meta: { next_cursor: r.nextCursor } };
  }

  /** openapi: listMyEnrollments——self 範圍：只回本人的選課 */
  @Get('me/enrollments')
  @RequirePermission('learning.result.read_self', { scope: 'self' })
  mine(@CurrentUser() user: AuthUser): Promise<MyEnrollmentDto[]> {
    return this.enrollments.mine(user.id);
  }

  /** openapi: withdrawEnrollment */
  @Post('enrollments/:id/withdraw')
  @RequirePermission('enrollment.withdraw', { scope: 'course', resource: 'enrollment' })
  @Audit({ action: 'enrollment.withdrawn', resourceType: 'enrollment' })
  @HttpCode(200)
  withdraw(@Param('id') id: string, @Req() req: FastifyRequest): Promise<EnrollmentDto> {
    return this.change(id, 'withdraw', req);
  }

  /** openapi: suspendEnrollment */
  @Post('enrollments/:id/suspend')
  @RequirePermission('enrollment.suspend', { scope: 'course', resource: 'enrollment' })
  @Audit({ action: 'enrollment.suspended', resourceType: 'enrollment' })
  @HttpCode(200)
  suspend(@Param('id') id: string, @Req() req: FastifyRequest): Promise<EnrollmentDto> {
    return this.change(id, 'suspend', req);
  }

  /** openapi: resumeEnrollment */
  @Post('enrollments/:id/resume')
  @RequirePermission('enrollment.suspend', { scope: 'course', resource: 'enrollment' })
  @Audit({ action: 'enrollment.resumed', resourceType: 'enrollment' })
  @HttpCode(200)
  resume(@Param('id') id: string, @Req() req: FastifyRequest): Promise<EnrollmentDto> {
    return this.change(id, 'resume', req);
  }

  private async change(id: string, action: EnrollmentAction, req: FastifyRequest): Promise<EnrollmentDto> {
    const r = await this.enrollments.transition(id, action);
    req.ctx.audit = { before: { status: r.before }, after: { status: r.after } };
    return r.enrollment;
  }
}

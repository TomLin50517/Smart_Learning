import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { NEW_ATTEMPT_POLICIES, RELEARNING_SCOPES, type EnrollmentDto, type RelearningResultDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { RelearningService } from '../application/relearning.service.js';

const Reopen = z.strictObject({ reason: z.string().trim().max(500).optional() });
const Relearning = z.strictObject({
  scopeType: z.enum(RELEARNING_SCOPES),
  scopeId: z.guid().nullable().default(null),
  reason: z.string().trim().min(1).max(500),
  dueDate: z.iso.datetime({ offset: true }).nullable().default(null),
  newAttemptPolicy: z.enum(NEW_ATTEMPT_POLICIES).default('reset_counter'),
});

/** 重新開啟與重修（SA UC-ENR-007／009、SD §6.25）。授權的學員數在服務層交易內檢查（只有已完成 → 重新開啟才會多算） */
@Controller('api')
export class RelearningController {
  constructor(private readonly relearning: RelearningService) {}

  /** openapi: reopenEnrollment */
  @Post('enrollments/:id/reopen')
  @RequirePermission('enrollment.reopen', { scope: 'course', resource: 'enrollment' })
  @Audit({ action: 'enrollment.reopened', resourceType: 'enrollment' })
  @HttpCode(200)
  async reopen(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<EnrollmentDto> {
    const { reason } = parseInput(Reopen, body ?? {});
    const e = await this.relearning.reopen(parseInput(z.guid(), id), reason || null);
    req.ctx.audit = { resourceId: e.id, before: { status: 'completed' }, after: { status: e.status }, ...(reason && { metadata: { reason } }) };
    return e;
  }

  /** openapi: assignRelearning */
  @Post('enrollments/:id/relearning')
  @RequirePermission('enrollment.relearning.assign', { scope: 'course', resource: 'enrollment' })
  @Audit({ action: 'enrollment.relearning.assigned', resourceType: 'enrollment' })
  @HttpCode(201)
  async assign(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<RelearningResultDto> {
    const r = await this.relearning.assign(parseInput(z.guid(), id), parseInput(Relearning, body), actor.id);
    req.ctx.audit = {
      resourceId: r.enrollment.id,
      before: { status: r.before },
      after: { status: r.enrollment.status, relearningId: r.relearning.id, scopeType: r.relearning.scopeType, scopeId: r.relearning.scopeId },
      metadata: { reason: r.relearning.reason, new_attempt_policy: r.relearning.newAttemptPolicy, due_date: r.relearning.dueDate },
    };
    return { relearning: r.relearning, enrollment: r.enrollment };
  }
}

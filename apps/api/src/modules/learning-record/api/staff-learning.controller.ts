import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { CompletionApprovalDto, EnrollmentTimelineDto, LearnerProgressDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { LearningEventService } from '../application/learning-events.service.js';
import { LearningService } from '../application/learning.service.js';
import { TimelineQuery } from './learner.controller.js';

const Approve = z.strictObject({ note: z.string().trim().max(500).optional() });

/** 課程人員檢視單一學員（SD §6.12、§6.14）。範圍由選課反查課程：只看得到自己授課／管理的課程 */
@Controller('api/enrollments')
export class StaffLearningController {
  constructor(
    private readonly learning: LearningService,
    private readonly events: LearningEventService,
  ) {}

  /** openapi: getEnrollmentProgress——各活動狀態、最佳成績、次數、觀看比例、學習時間、未完成原因、人工核可 */
  @Get(':id/progress')
  @RequirePermission('learning.result.read_all', { scope: 'course', resource: 'enrollment' })
  progress(@Param('id') id: string): Promise<LearnerProgressDto> {
    return this.learning.staffProgress(id);
  }

  /** openapi: getEnrollmentTimeline——學習歷程（新到舊） */
  @Get(':id/timeline')
  @RequirePermission('learning.timeline.read_all', { scope: 'course', resource: 'enrollment' })
  timeline(@Param('id') id: string, @Query() query: unknown): Promise<EnrollmentTimelineDto> {
    return this.events.timeline(id, parseInput(TimelineQuery, query), null);
  }

  /**
   * openapi: approveCompletion——人工核可。路由只確認是課程人員；核可人須擔任完成條件指定的角色（服務內檢查，
   * 否則 403 approver_role_required）。
   */
  @Post(':id/completion-approvals')
  @RequirePermission('learning.result.read_all', { scope: 'course', resource: 'enrollment' })
  @Audit({ action: 'completion.approved', resourceType: 'enrollment' })
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<CompletionApprovalDto> {
    const { note } = parseInput(Approve, body);
    const r = await this.learning.approve(id, actor.id, note || null);
    req.ctx.audit = { resourceId: id, after: { approver_roles: r.approvedRoles, completion_changed: r.completionChanged }, ...(note && { metadata: { note } }) };
    return r;
  }
}

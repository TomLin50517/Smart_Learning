import { Controller, Get, Param, Req } from '@nestjs/common';
import type { CoachTranscriptDto, CoachTranscriptListDto, CoachUsageDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Audit, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { CoachInsightsService } from '../application/coach-insights.service.js';

/**
 * 課程人員的 AI 教練檢視（SD §6.21）。逐字稿的兩個端點是「唯二寫稽核的讀取型 API」：
 * coach.transcript.read 屬 AUDIT_MUST_SUCCEED——寫不進稽核，請求就失敗（ADR-028 條件 3）。
 * 讀單一逐字稿時稽核帶 learner_id，學員在自己的「帳號活動」看得到。
 */
@Controller('api')
export class CoachInsightsController {
  constructor(private readonly insights: CoachInsightsService) {}

  /** openapi: getCourseCoachUsage——匿名彙整，須達匿名門檻 */
  @Get('courses/:id/coach/usage')
  @RequirePermission('coach.usage_stats.read', { scope: 'course', resource: 'course' })
  usage(@Param('id') id: string): Promise<CoachUsageDto> {
    return this.insights.usage(parseInput(z.guid(), id));
  }

  /** openapi: listCourseCoachConversations */
  @Get('courses/:id/coach/conversations')
  @RequirePermission('coach.conversation.read_course', { scope: 'course', resource: 'course' })
  @Audit({ action: 'coach.transcript.read', resourceType: 'course' })
  async list(@Param('id') id: string, @Req() req: FastifyRequest): Promise<CoachTranscriptListDto> {
    const courseId = parseInput(z.guid(), id);
    const r = await this.insights.transcripts(courseId);
    req.ctx.audit = { resourceId: courseId, metadata: { kind: 'list', listed: r.data.length, hidden: r.hiddenCount, policy: r.policy } };
    return r;
  }

  /** openapi: readCourseCoachTranscript */
  @Get('courses/:id/coach/conversations/:convId')
  @RequirePermission('coach.conversation.read_course', { scope: 'course', resource: 'course' })
  @Audit({ action: 'coach.transcript.read', resourceType: 'coach_conversation' })
  async read(@Param('id') id: string, @Param('convId') convId: string, @Req() req: FastifyRequest): Promise<CoachTranscriptDto> {
    const courseId = parseInput(z.guid(), id);
    const t = await this.insights.transcript(courseId, parseInput(z.guid(), convId));
    req.ctx.audit = { resourceId: t.id, metadata: { kind: 'transcript', course_id: courseId, learner_id: t.learnerId, messages: t.messages.length } };
    return t;
  }
}

import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { COACH_QUESTION_MAX, type CoachAnswerDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { CoachService } from '../application/coach.service.js';

const TestAsk = z.strictObject({ content: z.string().trim().min(1).max(COACH_QUESTION_MAX), conversationId: z.guid().optional() });

/**
 * 教師測試模式（coach.interact_test，SD §6.19）：以自己的身分在課程版本（含草稿）試問，
 * 用與學員相同的檢索、提示詞與驗證；對話標為測試，不綁選課、不列入統計。回傳 JSON（不串流）。
 */
@Controller('api')
export class CoachTestController {
  constructor(private readonly coach: CoachService) {}

  /** openapi: testCoach */
  @Post('course-versions/:id/coach/test')
  @RequirePermission('coach.interact_test', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'aiCoachAllowed' })
  @RateLimit([{ name: 'coachtest', by: 'user', limit: 20, windowSec: 60 }])
  @HttpCode(200)
  async test(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CoachAnswerDto> {
    const b = parseInput(TestAsk, body);
    const conv = await this.coach.testConversation(user, id, b.conversationId);
    const prepared = await this.coach.prepare(conv, b.content, req.ctx.correlationId);
    return this.coach.answer(prepared);
  }
}

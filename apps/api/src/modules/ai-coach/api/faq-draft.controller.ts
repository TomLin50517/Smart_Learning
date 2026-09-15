import { randomUUID } from 'node:crypto';
import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { FAQ_KINDS, FAQ_LIMITS, type FaqDraftDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { FaqDraftService } from '../application/faq-draft.service.js';

const Draft = z.strictObject({ kind: z.enum(FAQ_KINDS), question: z.string().trim().min(2).max(FAQ_LIMITS.question) });

/** 「請 AI 起草」FAQ／常見錯誤的答案（SD §6.27）；只回傳草稿，不儲存 */
@Controller('api')
export class FaqDraftController {
  constructor(private readonly drafts: FaqDraftService) {}

  /** openapi: draftCourseFaq */
  @Post('courses/:id/faq/draft')
  @RequirePermission('knowledge.faq.write', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @RateLimit([{ name: 'faqdraft', by: 'user', limit: 10, windowSec: 60 }])
  @HttpCode(200)
  draft(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<FaqDraftDto> {
    return this.drafts.draft(parseInput(z.guid(), id), parseInput(Draft, body), req.ctx.correlationId ?? randomUUID());
  }
}

import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { FAQ_KINDS, FAQ_LIMITS, type FaqDto, type FaqInsightsDto, type LearnerFaqDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { FaqService } from '../application/faq.service.js';

const Citation = z.strictObject({
  chunkId: z.string().max(200),
  title: z.string().max(300),
  pageNo: z.number().int().nullable(),
  sectionPath: z.string().max(300).nullable(),
});
const Text = { question: z.string().trim().min(2).max(FAQ_LIMITS.question), answer: z.string().trim().min(1).max(FAQ_LIMITS.answer) };
const Create = z.strictObject({
  kind: z.enum(FAQ_KINDS),
  ...Text,
  citations: z.array(Citation).max(FAQ_LIMITS.citations).default([]),
  insightKey: z
    .string()
    .regex(/^(issue|q):[\w:.-]{1,200}$/)
    .nullable()
    .default(null),
  learners: z.number().int().min(1).max(100_000).nullable().default(null),
});
const Update = z.strictObject({ ...Text, citations: z.array(Citation).max(FAQ_LIMITS.citations).optional() });
const ListQuery = z.object({ includeRetired: z.stringbool().default(false) });

/** 常見問答與常見錯誤（SA UC-KNW-004～008、SD §6.27） */
@Controller('api')
export class FaqController {
  constructor(private readonly faq: FaqService) {}

  /** openapi: listCourseFaq */
  @Get('courses/:id/faq')
  @RequirePermission('derived.read', { scope: 'course', resource: 'course' })
  list(@Param('id') id: string, @Query() query: unknown): Promise<FaqDto[]> {
    return this.faq.list(parseInput(z.guid(), id), parseInput(ListQuery, query).includeRetired);
  }

  /** openapi: createCourseFaq——直接生效（老師就是依據） */
  @Post('courses/:id/faq')
  @RequirePermission('knowledge.faq.write', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.faq.created', resourceType: 'derived_knowledge' })
  @HttpCode(201)
  async create(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<FaqDto> {
    const f = await this.faq.create(parseInput(z.guid(), id), parseInput(Create, body), actor.id);
    req.ctx.audit = { resourceId: f.id, after: { courseId: id, kind: f.kind, question: f.question, source: f.source } };
    return f;
  }

  /** openapi: updateCourseFaq——建立新版本，舊版保留 */
  @Patch('courses/:id/faq/:faqId')
  @RequirePermission('knowledge.faq.write', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.faq.updated', resourceType: 'derived_knowledge' })
  async update(@Param('id') id: string, @Param('faqId') faqId: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<FaqDto> {
    const r = await this.faq.update(parseInput(z.guid(), id), parseInput(z.guid(), faqId), parseInput(Update, body), actor.id);
    req.ctx.audit = {
      resourceId: faqId,
      before: { question: r.before.question, versionNo: r.before.versionNo },
      after: { question: r.after.question, versionNo: r.after.versionNo },
    };
    return r.after;
  }

  /** openapi: retireCourseFaq */
  @Post('courses/:id/faq/:faqId/retire')
  @RequirePermission('knowledge.faq.write', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.faq.retired', resourceType: 'derived_knowledge' })
  @HttpCode(200)
  async retire(@Param('id') id: string, @Param('faqId') faqId: string, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<FaqDto> {
    const f = await this.faq.retire(parseInput(z.guid(), id), parseInput(z.guid(), faqId), actor.id);
    req.ctx.audit = { resourceId: faqId, before: { status: 'verified' }, after: { status: f.status, question: f.question } };
    return f;
  }

  /** openapi: getCourseFaqInsights——很多人答錯、很多人問（達匿名門檻才出現） */
  @Get('courses/:id/faq-insights')
  @RequirePermission('derived.read', { scope: 'course', resource: 'course' })
  insights(@Param('id') id: string): Promise<FaqInsightsDto> {
    return this.faq.insights(parseInput(z.guid(), id));
  }

  /** openapi: listMyCourseFaq——學員看得到的 FAQ（本人的選課） */
  @Get('enrollments/:id/faq')
  @RequirePermission('learning.result.read_self', { scope: 'self' })
  forLearner(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<LearnerFaqDto[]> {
    return this.faq.forLearner(parseInput(z.guid(), id), user.id);
  }
}

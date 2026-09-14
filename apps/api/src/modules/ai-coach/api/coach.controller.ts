import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { COACH_QUESTION_MAX, type CitationSourceDto, type CoachAvailabilityDto, type CoachConversationDto, type CoachStreamEvent } from '@iac/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { logger } from '../../../common/logger.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { CoachService } from '../application/coach.service.js';

const Create = z.strictObject({ enrollmentId: z.guid(), activityId: z.guid().optional() });
const Ask = z.strictObject({ content: z.string().trim().min(1).max(COACH_QUESTION_MAX) });

/**
 * SSE（ADR-025 B+）：stage → sources（已依範圍檢索，可先讀教材）→ 回答驗證通過後才送 token → done。
 * 權限、額度、檢索等錯誤在開始串流前就以一般錯誤回應；開始後的錯誤以 error 事件回報。
 * 每 15 秒送一次註解行，避免反向代理在模型生成期間斷線。
 */
async function streamAnswer(reply: FastifyReply, run: (emit: (e: CoachStreamEvent) => void) => Promise<unknown>): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  const write = (s: string) => {
    if (!raw.destroyed) raw.write(s);
  };
  const emit = (e: CoachStreamEvent) => write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  const ping = setInterval(() => write(': ping\n\n'), 15_000);
  try {
    await run(emit);
  } catch (err) {
    logger.error({ err }, 'coach answer failed');
    emit({ event: 'error', data: { code: 'INTERNAL_ERROR', message: '發生錯誤，請稍後再試' } });
  } finally {
    clearInterval(ping);
    raw.end();
  }
}

/** AI 學習教練——學員（SA UC-CCH-001～003；SD §6.19）。只能存取自己的對話；不是本人一律 404 */
@Controller('api')
export class CoachController {
  constructor(private readonly coach: CoachService) {}

  /** openapi: getEnrollmentCoach——能不能用、自己的對話清單（不需要授權功能也能查，讓畫面顯示原因） */
  @Get('enrollments/:id/coach')
  @RequirePermission('coach.conversation.read_self', { scope: 'self' })
  availability(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<CoachAvailabilityDto> {
    return this.coach.availability(parseInput(z.guid(), id), user);
  }

  /** openapi: createCoachConversation */
  @Post('coach/conversations')
  @RequirePermission('coach.interact_self', { scope: 'self' })
  @RequireCapability({ capability: 'aiCoachAllowed' })
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<CoachConversationDto> {
    return this.coach.createConversation(user, parseInput(Create, body));
  }

  /** openapi: getCoachConversation */
  @Get('coach/conversations/:id')
  @RequirePermission('coach.conversation.read_self', { scope: 'self' })
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<CoachConversationDto> {
    return this.coach.getConversation(parseInput(z.guid(), id), user);
  }

  /** openapi: sendCoachMessage——SSE */
  @Post('coach/conversations/:id/messages')
  @RequirePermission('coach.interact_self', { scope: 'self' })
  @RequireCapability({ capability: 'aiCoachAllowed' })
  @RateLimit([
    { name: 'coachmsg', by: 'user', limit: 10, windowSec: 60 },
    { name: 'coachday', by: 'user', limit: 200, windowSec: 86_400 },
  ])
  async ask(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { content } = parseInput(Ask, body);
    const conv = await this.coach.learnerConversation(parseInput(z.guid(), id), user);
    const prepared = await this.coach.prepare(conv, content, req.ctx.correlationId);
    await streamAnswer(reply, (emit) => this.coach.answer(prepared, emit));
  }

  /** openapi: openCitationSource——每次重新檢查權限（THR-I-004） */
  @Get('coach/citations/:id/source')
  @RequirePermission('coach.citation.open', { scope: 'self' })
  openSource(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<CitationSourceDto> {
    return this.coach.openSource(parseInput(z.guid(), id), user);
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { EVENT_BATCH_MAX, type ActivityResultDto, type ActivityRuntimeDto, type EnrollmentTimelineDto, type LearnerOutlineDto, type LearningEventBatchResponse } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { LearningEventService } from '../application/learning-events.service.js';
import { LearningService } from '../application/learning.service.js';

/**
 * 送出作答：只收原始 input。z.object（非 strict）會丟掉 client 夾帶的 score／status 等欄位——
 * 成績只由伺服器評分器產生（AC-LRN-003）。
 */
const SubmitAttempt = z.object({
  input: z.unknown().refine((v) => v !== undefined, 'required'),
  clientDurationMs: z.number().int().min(0).max(86_400_000).optional(),
});

/** 學員端事件批次：身分欄位（組織、學員、選課）不在白名單內，送了也會被拒（ADR-021） */
const EventBatch = z.strictObject({
  events: z
    .array(
      z.strictObject({
        eventId: z.guid(),
        eventType: z.string().max(64),
        eventVersion: z.literal('1.0'),
        occurredAt: z.iso.datetime({ offset: true }),
        activityId: z.guid().optional(),
        payload: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(EVENT_BATCH_MAX),
});

export const TimelineQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** 學員的學習端點。全部為 self 範圍：選課歸屬由服務逐一驗證，不是本人的回 404 */
@Controller('api')
export class LearnerController {
  constructor(
    private readonly learning: LearningService,
    private readonly events: LearningEventService,
  ) {}

  /** openapi: getLearnerOutline——課程大綱、各活動狀態、進度與學習時間（不含設定與答案） */
  @Get('enrollments/:id/outline')
  @RequirePermission('learning.result.read_self', { scope: 'self' })
  outline(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<LearnerOutlineDto> {
    return this.learning.outline(parseInput(z.guid(), id), user.id);
  }

  /** openapi: getMyEnrollmentTimeline——自己的學習歷程 */
  @Get('me/enrollments/:id/timeline')
  @RequirePermission('learning.timeline.read_self', { scope: 'self' })
  timeline(@Param('id') id: string, @Query() query: unknown, @CurrentUser() user: AuthUser): Promise<EnrollmentTimelineDto> {
    return this.events.timeline(parseInput(z.guid(), id), parseInput(TimelineQuery, query), user.id);
  }

  /** openapi: getActivityRuntime——選課須可學習（409）、活動須已解鎖（403） */
  @Get('activities/:id/runtime')
  @RequirePermission('learning.attempt.write_self', { scope: 'self' })
  @RequireCapability({ capability: 'runtimeAllowed' })
  runtime(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ActivityRuntimeDto> {
    return this.learning.runtime(parseInput(z.guid(), id), user.id);
  }

  /** openapi: createAttempt */
  @Post('activities/:id/attempts')
  @RequirePermission('learning.attempt.write_self', { scope: 'self' })
  @RequireCapability({ capability: 'runtimeAllowed' })
  @HttpCode(201)
  start(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ attemptId: string; attemptNo: number }> {
    return this.learning.startAttempt(parseInput(z.guid(), id), user.id);
  }

  /** openapi: ingestLearningEvents——每筆選課每分鐘 120 筆，超過 429（不阻斷學習） */
  @Post('attempts/:id/events')
  @RequirePermission('learning.event.write_self', { scope: 'self' })
  @RequireCapability({ capability: 'runtimeAllowed' })
  @HttpCode(202)
  ingest(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<LearningEventBatchResponse> {
    return this.events.ingest(parseInput(z.guid(), id), user.id, parseInput(EventBatch, body).events, req.ctx.correlationId);
  }

  /** openapi: submitAttempt——同步評分與完成判定（ADR-020），零 LLM */
  @Post('attempts/:id/submit')
  @RequirePermission('learning.attempt.write_self', { scope: 'self' })
  @RequireCapability({ capability: 'runtimeAllowed' })
  @HttpCode(200)
  submit(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ActivityResultDto> {
    const { input } = parseInput(SubmitAttempt, body);
    return this.learning.submit(parseInput(z.guid(), id), user.id, input);
  }

  /** openapi: getAttemptResult——只有本人看得到（AC-LRN-007） */
  @Get('attempts/:id/result')
  @RequirePermission('learning.result.read_self', { scope: 'self' })
  result(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ActivityResultDto> {
    return this.learning.result(parseInput(z.guid(), id), user.id);
  }
}

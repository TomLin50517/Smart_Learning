import { Controller, Get, Param, Query } from '@nestjs/common';
import type { EnrollmentTimelineDto, LearnerProgressDto } from '@iac/contracts';
import { RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { LearningEventService } from '../application/learning-events.service.js';
import { LearningService } from '../application/learning.service.js';
import { TimelineQuery } from './learner.controller.js';

/** 課程人員檢視單一學員（SD §6.12）。範圍由選課反查課程：只看得到自己授課／管理的課程 */
@Controller('api/enrollments')
export class StaffLearningController {
  constructor(
    private readonly learning: LearningService,
    private readonly events: LearningEventService,
  ) {}

  /** openapi: getEnrollmentProgress——各活動狀態、最佳成績、次數、觀看比例、學習時間、未完成原因 */
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
}

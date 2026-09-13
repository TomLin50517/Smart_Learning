import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { CompletionEvaluationDto } from '@iac/contracts';
import { RequirePermission } from '../../../common/decorators.js';
import { COMPLETION_ENGINE, type CompletionEngine } from '../completion.contracts.js';

@Controller('api/enrollments')
export class CompletionController {
  constructor(@Inject(COMPLETION_ENGINE) private readonly engine: CompletionEngine) {}

  /** openapi: getCompletionEvaluation——課程人員檢視單一學員的完成判定（即時重算，不寫入） */
  @Get(':id/completion')
  @RequirePermission('learning.result.read_all', { scope: 'course', resource: 'enrollment' })
  async completion(@Param('id') id: string): Promise<CompletionEvaluationDto> {
    return this.engine.evaluate(await this.engine.progress(id));
  }
}

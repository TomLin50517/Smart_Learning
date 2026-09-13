import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type {
  CoachPolicyDto,
  CourseVersionDetailDto,
  InteractiveDefinitionDto,
  ValidationIssueDto,
  ValidationReportDto,
  VersionImpactDto,
} from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { CoachPolicyInput, CompletionRulesInput, DraftPatch } from '../application/course-inputs.js';
import { CourseService } from '../application/course.service.js';
import { CoursePublishService } from '../application/publish.service.js';

@Controller('api/course-versions')
export class CourseVersionController {
  constructor(
    private readonly courses: CourseService,
    private readonly publishing: CoursePublishService,
  ) {}

  /** openapi: validateCourseVersion——發布前檢查 C1–C5；有問題時 valid 為 false，仍回 200（UI 先預覽問題） */
  @Post(':id/validate')
  @RequirePermission('course.version.validate', { scope: 'course', resource: 'course_version' })
  @HttpCode(200)
  validate(@Param('id') id: string): Promise<ValidationReportDto> {
    return this.publishing.validate(id);
  }

  /** openapi: publishCourseVersion——原子操作；同一交易內重跑檢查，有錯誤 422 */
  @Post(':id/publish')
  @RequirePermission('course.version.publish', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.version.published', resourceType: 'course_version' })
  @HttpCode(200)
  async publish(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CourseVersionDetailDto> {
    const r = await this.publishing.publish(id, user.id);
    req.ctx.audit = {
      before: { status: r.previousStatus },
      after: { status: 'published', contentSnapshotHash: r.contentSnapshotHash },
      metadata: { superseded_version_id: r.supersededVersionId },
    };
    return r.version;
  }

  /** openapi: getCourseVersion——課程人員用（含 answerKey）；學員 runtime 另有端點 */
  @Get(':id')
  @RequirePermission('course.version.read', { scope: 'course', resource: 'course_version' })
  get(@Param('id') id: string): Promise<CourseVersionDetailDto> {
    return this.courses.getVersion(id);
  }

  /** openapi: updateCourseVersionDraft——僅 draft；否則 409 COURSE_VERSION_IMMUTABLE（應用層＋DB 觸發器） */
  @Patch(':id')
  @RequirePermission('course.version.write', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.version.updated', resourceType: 'course_version' })
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<CourseVersionDetailDto> {
    const r = await this.courses.updateDraft(id, parseInput(DraftPatch, body));
    req.ctx.audit = { before: r.before, after: r.after };
    return r.version;
  }

  /** openapi: cloneCourseVersion——來源須為 published／superseded；既有選課仍指向來源（AC-CRS-002） */
  @Post(':id/clone')
  @RequirePermission('course.version.create', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.version.cloned', resourceType: 'course_version' })
  @HttpCode(201)
  async clone(@Param('id') id: string, @Req() req: FastifyRequest): Promise<CourseVersionDetailDto> {
    const v = await this.courses.clone(id);
    req.ctx.audit = { resourceId: v.id, after: { versionNo: v.versionNo }, metadata: { source_version_id: id } };
    return v;
  }

  /** openapi: updateCompletionRules——儲存前驗證（錯誤 422、RULE_* 子代碼）；警告隨回應回傳；null 清除 */
  @Put(':id/completion-rules')
  @RequirePermission('course.completion_rule.write', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.completion_rule.updated', resourceType: 'course_version' })
  async updateCompletionRules(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<{ completionRuleSet: CourseVersionDetailDto['completionRuleSet']; warnings: ValidationIssueDto[] }> {
    const r = await this.courses.updateCompletionRules(id, parseInput(CompletionRulesInput, body));
    req.ctx.audit = { before: r.before as Record<string, unknown>, after: r.after as Record<string, unknown> };
    return { completionRuleSet: r.completionRuleSet, warnings: r.warnings };
  }

  /** openapi: updateCoachPolicy——整組取代；值域白名單（會組進 AI 提示詞） */
  @Put(':id/coach-policy')
  @RequirePermission('course.coach_policy.write', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.coach_policy.updated', resourceType: 'course_version' })
  async updateCoachPolicy(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<CoachPolicyDto> {
    const r = await this.courses.updateCoachPolicy(id, parseInput(CoachPolicyInput, body));
    req.ctx.audit = { before: r.before, after: r.after };
    return r.policy;
  }

  /** openapi: getCourseVersionImpact */
  @Get(':id/impact')
  @RequirePermission('course.version.read', { scope: 'course', resource: 'course_version' })
  impact(@Param('id') id: string): Promise<VersionImpactDto> {
    return this.courses.impact(id);
  }
}

@Controller('api/interactive-definitions')
export class InteractiveDefinitionController {
  constructor(private readonly courses: CourseService) {}

  /** openapi: listInteractiveDefinitions——課程編輯器選擇互動元件用 */
  @Get()
  @RequirePermission('course.version.read', { scope: 'any' })
  list(): Promise<InteractiveDefinitionDto[]> {
    return this.courses.interactiveDefinitions();
  }
}

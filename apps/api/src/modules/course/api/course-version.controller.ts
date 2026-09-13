import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { CourseVersionDetailDto, InteractiveDefinitionDto, VersionImpactDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { Audit, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { DraftPatch } from '../application/course-inputs.js';
import { CourseService } from '../application/course.service.js';

@Controller('api/course-versions')
export class CourseVersionController {
  constructor(private readonly courses: CourseService) {}

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

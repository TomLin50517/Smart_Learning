import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { CourseDetailDto, CourseDto, CourseStaffDto, CourseVersionDetailDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { grantScopes } from '../../../common/authz.js';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { DomainError } from '../../../common/domain-error.js';
import { parseInput } from '../../../common/validation.js';
import { ArchiveCourse, AssignStaff, CoursePaging, CreateCourse, CreateVersion } from '../application/course-inputs.js';
import { CourseService } from '../application/course.service.js';

@Controller('api/courses')
export class CourseController {
  constructor(private readonly courses: CourseService) {}

  /** openapi: listCourses——依 course.read 的範圍過濾：平台全部／組織／指派的課程 */
  @Get()
  @RequirePermission('course.read', { scope: 'any' })
  async list(@Query() query: unknown, @Req() req: FastifyRequest): Promise<{ data: CourseDto[]; meta: { next_cursor: string | null } }> {
    const r = await this.courses.list(grantScopes(req.ctx.grants ?? [], 'course.read'), parseInput(CoursePaging, query));
    return { data: r.data, meta: { next_cursor: r.nextCursor } };
  }

  /** openapi: createCourse——建立於目前 session 的組織 */
  @Post()
  @RequirePermission('course.create', { scope: 'organization' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.created', resourceType: 'course' })
  @HttpCode(201)
  async create(@Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CourseDto> {
    const input = parseInput(CreateCourse, body);
    const orgId = req.ctx.target?.organizationId;
    if (!orgId) throw new DomainError('NOT_FOUND');
    const course = await this.courses.create(orgId, input, user.id);
    req.ctx.audit = { resourceId: course.id, after: { code: course.code, title: course.title } };
    return course;
  }

  /** openapi: getCourse——含版本清單 */
  @Get(':id')
  @RequirePermission('course.read', { scope: 'course', resource: 'course' })
  get(@Param('id') id: string): Promise<CourseDetailDto> {
    return this.courses.get(id);
  }

  /** openapi: updateCourse——僅封存（權限 course.archive、稽核 course.archived） */
  @Patch(':id')
  @RequirePermission('course.archive', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.archived', resourceType: 'course' })
  async archive(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<CourseDetailDto> {
    parseInput(ArchiveCourse, body);
    const r = await this.courses.archive(id);
    req.ctx.audit = { before: r.before, after: r.after };
    return r.course;
  }

  /** openapi: createCourseVersion——建立第一個（或下一個）草稿；已有編輯中版本時拒絕 */
  @Post(':id/versions')
  @RequirePermission('course.version.create', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.version.created', resourceType: 'course_version' })
  @HttpCode(201)
  async createVersion(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<CourseVersionDetailDto> {
    const v = await this.courses.createVersion(id, parseInput(CreateVersion, body));
    req.ctx.audit = { resourceId: v.id, after: { versionNo: v.versionNo, title: v.title } };
    return v;
  }

  /** openapi: listCourseStaff */
  @Get(':id/staff')
  @RequirePermission('course.staff.assign', { scope: 'course', resource: 'course' })
  staff(@Param('id') id: string): Promise<CourseStaffDto[]> {
    return this.courses.staff(id);
  }

  /** openapi: assignCourseStaff——對象須為課程所屬組織的成員 */
  @Post(':id/staff')
  @RequirePermission('course.staff.assign', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'course.staff.assigned', resourceType: 'course_staff' })
  @HttpCode(201)
  async assignStaff(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CourseStaffDto[]> {
    const input = parseInput(AssignStaff, body);
    const r = await this.courses.assignStaff(id, input, user.id);
    req.ctx.audit = { resourceId: r.userId, after: { role: input.role }, metadata: { course_id: id, already_assigned: !r.created } };
    return this.courses.staff(id);
  }
}

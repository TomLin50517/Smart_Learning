import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { CoachSettingsDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { CoachSettingsService } from '../application/coach-settings.service.js';

const Patch = z
  .strictObject({ enabled: z.boolean().optional(), transcriptVisibility: z.enum(['aggregate_only', 'course_staff']).optional() })
  .refine((v) => v.enabled !== undefined || v.transcriptVisibility !== undefined, { message: 'nothing to update' });

const audited = (s: CoachSettingsDto) => ({ enabled: s.enabled, transcriptVisibility: s.transcriptVisibility });

/** 組織的 AI 教練設定（SD §6.19）：組織可停用教練；逐字稿可見性只影響之後建立的對話 */
@Controller('api/organizations')
export class CoachSettingsController {
  constructor(private readonly settings: CoachSettingsService) {}

  /** openapi: getCoachSettings */
  @Get(':id/coach-settings')
  @RequirePermission('org.read', { scope: 'organization', param: 'id' })
  get(@Param('id') id: string): Promise<CoachSettingsDto> {
    return this.settings.get(parseInput(z.guid(), id));
  }

  /** openapi: updateCoachSettings */
  @Put(':id/coach-settings')
  @RequirePermission('coach.transcript_policy.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.coach_settings.updated', resourceType: 'organization' })
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<CoachSettingsDto> {
    const orgId = parseInput(z.guid(), id);
    const r = await this.settings.update(orgId, parseInput(Patch, body), actor.id);
    req.ctx.audit = { resourceId: orgId, before: audited(r.before), after: audited(r.after) };
    return r.after;
  }
}

import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { PlatformSettingDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { PlatformSettingsService, SettingsPatch } from '../application/platform-settings.service.js';

@Controller('api/platform/settings')
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  /** openapi: getPlatformSettings——目錄內每個鍵的生效值、預設值與最後修改者 */
  @Get()
  @RequirePermission('platform.settings.read', { scope: 'platform' })
  list(): Promise<PlatformSettingDto[]> {
    return this.settings.list();
  }

  /** openapi: updatePlatformSettings——部分更新；null 恢復預設；稽核只記實際變更的鍵 */
  @Put()
  @RequirePermission('platform.settings.write', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'system.settings.updated', resourceType: 'system_settings' })
  async update(@Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<PlatformSettingDto[]> {
    const r = await this.settings.update(parseInput(SettingsPatch, body), actor.id);
    req.ctx.audit = { before: r.before, after: r.after };
    return r.settings;
  }
}

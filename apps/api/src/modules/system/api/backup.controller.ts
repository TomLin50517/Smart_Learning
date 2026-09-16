import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { BackupRunDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequirePermission } from '../../../common/decorators.js';
import { SystemStatusService } from '../application/system-status.service.js';

/**
 * 備份（SA UC-PLT-008、SD §6.28）：每日備份由 compose 的 backup 服務自動執行；
 * 這裡只提供紀錄查詢與「立即備份」（排入一筆等待中的紀錄，由備份服務取件）。還原不做成按鈕——見 docs/ops/backup-restore.md。
 */
@Controller('api/platform/backups')
export class BackupController {
  constructor(private readonly system: SystemStatusService) {}

  /** openapi: listBackups */
  @Get()
  @RequirePermission('platform.backup.execute', { scope: 'platform' })
  list(): Promise<BackupRunDto[]> {
    return this.system.backups();
  }

  /** openapi: requestBackup */
  @Post()
  @RequirePermission('platform.backup.execute', { scope: 'platform' })
  @Audit({ action: 'backup.executed', resourceType: 'backup_run' })
  @HttpCode(202)
  async request(@CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<BackupRunDto> {
    const r = await this.system.requestBackup(actor.id);
    req.ctx.audit = { resourceId: r.id, after: { kind: r.kind, status: r.status } };
    return r;
  }
}

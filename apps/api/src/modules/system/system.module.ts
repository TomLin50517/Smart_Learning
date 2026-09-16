import { Module } from '@nestjs/common';
import { LicenseModule } from '../license/license.module.js';
import { BackupController } from './api/backup.controller.js';
import { PlatformSettingsController } from './api/platform-settings.controller.js';
import { SystemController } from './api/system.controller.js';
import { JobStatusService } from './application/job-status.service.js';
import { MetricsCollector } from './application/metrics-collector.js';
import { PlatformSettingsService } from './application/platform-settings.service.js';
import { SystemStatusService } from './application/system-status.service.js';

/**
 * MOD-SYSTEM：設定、health/readiness、metrics、job queue 管理、backup hook、feature flag
 * 已實作：health、ready、metrics（SD §13.2）、平台設定與佇列狀態（SD §8.11）、系統狀態與備份（SD §6.28）
 */
@Module({
  imports: [LicenseModule],
  controllers: [SystemController, PlatformSettingsController, BackupController],
  providers: [MetricsCollector, PlatformSettingsService, JobStatusService, SystemStatusService],
})
export class SystemModule {}

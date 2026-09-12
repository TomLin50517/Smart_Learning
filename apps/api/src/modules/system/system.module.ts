import { Module } from '@nestjs/common';
import { LicenseModule } from '../license/license.module.js';
import { SystemController } from './api/system.controller.js';
import { MetricsCollector } from './application/metrics-collector.js';

/**
 * MOD-SYSTEM：設定、health/readiness、metrics、job queue 管理、backup hook、feature flag
 * 已實作：health、ready、metrics（SD §13.2）
 */
@Module({
  imports: [LicenseModule],
  controllers: [SystemController],
  providers: [MetricsCollector],
})
export class SystemModule {}

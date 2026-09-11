import { Module } from '@nestjs/common';
import { SystemController } from './api/system.controller.js';

/** MOD-SYSTEM：設定、health/readiness、job queue 管理、backup hook、feature flag */
@Module({
  controllers: [SystemController],
})
export class SystemModule {}

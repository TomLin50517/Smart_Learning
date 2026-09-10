import { Module } from '@nestjs/common';
import { MeController } from './api/me.controller.js';
import { MeService } from './application/me.service.js';

/**
 * MOD-IDENTITY：使用者、Argon2id 密碼、Session、密碼重設、IdentityProviderAdapter 擴充點。
 * 護欄：不含課程/組織業務邏輯。
 * 目前已實作：GET /api/me。登入/登出/密碼重設為下一步。
 */
@Module({
  controllers: [MeController],
  providers: [MeService],
})
export class IdentityModule {}

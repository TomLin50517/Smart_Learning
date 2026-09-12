import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module.js';
import { AuthController } from './api/auth.controller.js';
import { MeController } from './api/me.controller.js';
import { AuthService } from './application/auth.service.js';
import { MeService } from './application/me.service.js';
import { ProfileService } from './application/profile.service.js';
import { SessionService } from './application/session.service.js';
import { USER_INVITATIONS } from './identity.contracts.js';

/**
 * MOD-IDENTITY：使用者、Argon2id 密碼、Session、密碼重設、IdentityProviderAdapter 擴充點。
 * 護欄：不含課程/組織業務邏輯。
 * 已實作：登入、登出、refresh、密碼重設、GET /api/me。MFA / SSO 為後續擴充點。
 */
@Module({
  // 帳號信件（ACCOUNT_MAILER）由 NotificationModule 提供：有 SMTP_HOST 用 SMTP，否則只寫 log（SD §8.10）
  imports: [NotificationModule],
  controllers: [MeController, AuthController],
  providers: [
    MeService,
    ProfileService,
    SessionService,
    AuthService,
    { provide: USER_INVITATIONS, useExisting: AuthService },
  ],
  exports: [USER_INVITATIONS],
})
export class IdentityModule {}

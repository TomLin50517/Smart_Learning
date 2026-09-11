import { Global, Module } from '@nestjs/common';
import { LicenseController } from './api/license.controller.js';
import { LicenseActivationService } from './application/license-activation.service.js';
import { LicenseService } from './application/license.service.js';
import { ACTIVATION_CLIENT, HttpActivationClient } from './infrastructure/activation-client.js';
import { LICENSE_EVALUATOR } from './license.contracts.js';

/**
 * MOD-LICENSE：簽章驗證、fingerprint、activation、LicenseCapabilities 供給。
 * 護欄：產品只內建 public key（vendor-public-key.ts），不內建簽發私鑰（ARCH §18.2）。
 * Global：LicenseCapabilityGuard 與多個模組都需要 LICENSE_EVALUATOR。
 */
@Global()
@Module({
  controllers: [LicenseController],
  providers: [
    LicenseService,
    LicenseActivationService,
    { provide: LICENSE_EVALUATOR, useExisting: LicenseService },
    { provide: ACTIVATION_CLIENT, useClass: HttpActivationClient },
  ],
  exports: [LICENSE_EVALUATOR],
})
export class LicenseModule {}

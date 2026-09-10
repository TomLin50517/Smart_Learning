import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { capabilityDeniedCode } from '@iac/domain';
import { LICENSE_EVALUATOR, type LicenseEvaluator } from '../../modules/license/license.contracts.js';
import { RequireCapability } from '../decorators.js';
import { DomainError } from '../domain-error.js';

/**
 * INV-8 第 3 步：License Capability（ARCH §18.3）。
 * 前端隱藏按鈕只是提示，這裡才是防線（SA AC-LIC-005）。
 */
@Injectable()
export class LicenseCapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(LICENSE_EVALUATOR) private readonly license: LicenseEvaluator,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = this.reflector.getAllAndOverride(RequireCapability, [ctx.getHandler(), ctx.getClass()]);
    if (!req) return true;

    const ev = await this.license.evaluate();

    if (req.capability && !ev[req.capability]) {
      throw new DomainError(capabilityDeniedCode(req.capability, ev));
    }

    if (req.limit) {
      const max = ev[req.limit];
      if (max !== undefined && (await this.license.usage(req.limit)) >= max) {
        throw new DomainError('LICENSE_LIMIT_EXCEEDED');
      }
    }
    return true;
  }
}

import { Controller, Get, Inject } from '@nestjs/common';
import type { LicenseCapabilities } from '@iac/contracts';
import { RequirePermission } from '../../../common/decorators.js';
import { LICENSE_EVALUATOR, type LicenseEvaluator } from '../license.contracts.js';

@Controller('api/platform/license')
export class LicenseController {
  constructor(@Inject(LICENSE_EVALUATOR) private readonly license: LicenseEvaluator) {}

  /** openapi: getLicenseCapabilities */
  @Get('capabilities')
  @RequirePermission('platform.license.read', { scope: 'platform' })
  async capabilities(): Promise<LicenseCapabilities> {
    const { reason: _internal, ...caps } = await this.license.evaluate();
    return caps;
  }
}

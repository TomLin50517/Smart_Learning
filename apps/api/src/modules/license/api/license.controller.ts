import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { LicenseCapabilities, LicenseChallenge, LicenseInfo } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Audit, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { LicenseActivationService } from '../application/license-activation.service.js';
import { LICENSE_EVALUATOR, type LicenseEvaluator } from '../license.contracts.js';

/** 恰好提供一種：離線授權檔，或線上啟用碼 */
const ActivateBody = z.union([
  z.strictObject({ licenseFile: z.string().min(20).max(20_000) }),
  z.strictObject({ activationCode: z.string().min(4).max(128) }),
]);

/**
 * 啟用端點刻意「不」要求 License Capability——未授權時必須仍能啟用授權。
 */
@Controller('api/platform/license')
export class LicenseController {
  constructor(
    @Inject(LICENSE_EVALUATOR) private readonly license: LicenseEvaluator,
    private readonly activation: LicenseActivationService,
  ) {}

  /** openapi: getLicense */
  @Get()
  @RequirePermission('platform.license.read', { scope: 'platform' })
  info(): Promise<LicenseInfo> {
    return this.activation.info();
  }

  /** openapi: getLicenseCapabilities */
  @Get('capabilities')
  @RequirePermission('platform.license.read', { scope: 'platform' })
  async capabilities(): Promise<LicenseCapabilities> {
    const { reason: _internal, ...caps } = await this.license.evaluate();
    return caps;
  }

  /** openapi: createLicenseChallenge（離線啟用第一步，SEQ-09） */
  @Post('challenge')
  @RequirePermission('platform.license.activate', { scope: 'platform' })
  @HttpCode(200)
  @Audit({ action: 'license.challenge_issued', resourceType: 'license_challenge' })
  async challenge(@Req() req: FastifyRequest): Promise<LicenseChallenge> {
    const { id, ...challenge } = await this.activation.createChallenge();
    req.ctx.audit = { resourceId: id };
    return challenge;
  }

  /** openapi: activateLicense（SEQ-08 線上 / SEQ-09 離線） */
  @Post('activate')
  @RequirePermission('platform.license.activate', { scope: 'platform' })
  @HttpCode(200)
  @Audit({ action: 'license.activated', resourceType: 'license' })
  async activate(@Body() body: unknown, @Req() req: FastifyRequest): Promise<LicenseCapabilities> {
    const r = await this.activation.activate(parseInput(ActivateBody, body));
    // 稽核只記識別資訊，不記原始授權內容
    req.ctx.audit = { resourceId: r.licenseRowId, metadata: { license_id: r.licenseId, license_type: r.licenseType, mode: r.mode } };
    return r.capabilities;
  }
}

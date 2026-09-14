import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { AiConnectionTestDto, OrgAiCredentialDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { AiCredentialService } from '../application/ai-credentials.service.js';
import { LlmProviderResolver } from '../infrastructure/provider-resolver.js';

const SetKey = z.strictObject({
  alias: z.string().trim().min(1).max(100),
  // 虛擬金鑰：不做格式假設（各 gateway 不同），只限長度與不可含空白
  key: z
    .string()
    .trim()
    .min(8)
    .max(2048)
    .regex(/^\S+$/, 'must not contain whitespace'),
});

const audited = (d: OrgAiCredentialDto) => ({ configured: d.configured, alias: d.alias });

/**
 * 組織的 AI gateway 虛擬金鑰（SD §6.22、ADR-034）。
 * 讀：org.read（組織管理員看得到「已設定、代號、更新時間」）；寫、刪、測試：平台管理員（platform.ai_provider.write）。
 * 任何回應與稽核都不含金鑰本身。
 */
@Controller('api/organizations')
export class AiCredentialController {
  constructor(
    private readonly credentials: AiCredentialService,
    private readonly resolver: LlmProviderResolver,
  ) {}

  /** openapi: getOrgAiCredential */
  @Get(':id/ai-credential')
  @RequirePermission('org.read', { scope: 'organization', param: 'id' })
  get(@Param('id') id: string): Promise<OrgAiCredentialDto> {
    return this.credentials.describe(parseInput(z.guid(), id));
  }

  /** openapi: setOrgAiCredential */
  @Put(':id/ai-credential')
  @RequirePermission('platform.ai_provider.write', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.ai_credential.updated', resourceType: 'organization' })
  async set(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<OrgAiCredentialDto> {
    const orgId = parseInput(z.guid(), id);
    const r = await this.credentials.set(orgId, parseInput(SetKey, body), actor.id);
    req.ctx.audit = { resourceId: orgId, before: audited(r.before), after: audited(r.after) };
    return r.after;
  }

  /** openapi: removeOrgAiCredential */
  @Delete(':id/ai-credential')
  @RequirePermission('platform.ai_provider.write', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.ai_credential.removed', resourceType: 'organization' })
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: FastifyRequest): Promise<void> {
    const orgId = parseInput(z.guid(), id);
    const before = await this.credentials.remove(orgId);
    req.ctx.audit = { resourceId: orgId, before: audited(before) };
  }

  /** openapi: testOrgAiCredential——驗證 gateway、金鑰與模型，不產生回答、不耗用 token */
  @Post(':id/ai-credential/test')
  @RequirePermission('platform.ai_provider.write', { scope: 'platform' })
  @RateLimit([{ name: 'aikeytest', by: 'user', limit: 10, windowSec: 60 }])
  @HttpCode(200)
  async test(@Param('id') id: string): Promise<AiConnectionTestDto> {
    const orgId = parseInput(z.guid(), id);
    await this.credentials.describe(orgId);
    const r = await this.resolver.forOrganization(orgId);
    if (!r.ok) return { ok: false, reason: r.reason, latencyMs: null };
    if (!r.provider.testConnection) return { ok: true, reason: 'ok', latencyMs: null };
    return r.provider.testConnection();
  }
}

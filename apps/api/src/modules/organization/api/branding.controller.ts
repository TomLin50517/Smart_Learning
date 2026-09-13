import { Body, Controller, Delete, Get, Param, Patch, Put, Req, Res, StreamableFile } from '@nestjs/common';
import { BRAND_ASSET_KINDS, PLATFORM_NAME_MAX, THEME_KEYS, type BrandAssetKind, type OrgBrandingDto, type PublicBrandingDto } from '@iac/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, Public, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { DomainError } from '../../../common/domain-error.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { BrandingService } from '../application/branding.service.js';

const UpdateBranding = z
  .strictObject({
    theme: z.enum(THEME_KEYS).optional(),
    customColor: z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.null()]).optional(),
    platformName: z.union([z.string().trim().max(PLATFORM_NAME_MAX), z.null()]).optional(),
  })
  .refine((v) => v.theme !== undefined || v.customColor !== undefined || v.platformName !== undefined, 'nothing_to_update');
const Kind = z.enum(BRAND_ASSET_KINDS);
/** 512 KB 的 base64 約 700 KB，在請求上限（1 MB）以內 */
const PutAsset = z.strictObject({ dataBase64: z.string().min(1).max(700_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'invalid') });

/** 組織品牌設定（SD §6.16）：組織管理員設定自己的組織；平台管理員可設定任何組織 */
@Controller('api/organizations')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  /** openapi: getOrganizationBranding */
  @Get(':id/branding')
  @RequirePermission('org.read', { scope: 'organization', param: 'id' })
  get(@Param('id') id: string): Promise<OrgBrandingDto> {
    return this.branding.get(id);
  }

  /** openapi: updateOrganizationBranding——平台名稱、預設配色或自訂主色（對比度檢查） */
  @Patch(':id/branding')
  @RequirePermission('org.settings.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.branding.updated', resourceType: 'organization' })
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<OrgBrandingDto> {
    const r = await this.branding.update(id, parseInput(UpdateBranding, body));
    req.ctx.audit = { resourceId: id, before: r.before, after: r.after };
    return r.branding;
  }

  /** openapi: putOrganizationBrandAsset——Logo（橫式）或小圖示（方形）：PNG／JPEG／WebP，512 KB 以內 */
  @Put(':id/branding/:kind')
  @RequirePermission('org.settings.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.branding.updated', resourceType: 'organization' })
  async putAsset(@Param('id') id: string, @Param('kind') kind: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<OrgBrandingDto> {
    const r = await this.branding.putAsset(id, parseInput(Kind, kind), parseInput(PutAsset, body).dataBase64, actor.id);
    req.ctx.audit = { resourceId: id, after: r.summary };
    return r.branding;
  }

  /** openapi: deleteOrganizationBrandAsset */
  @Delete(':id/branding/:kind')
  @RequirePermission('org.settings.write', { scope: 'organization', param: 'id' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'org.branding.updated', resourceType: 'organization' })
  async deleteAsset(@Param('id') id: string, @Param('kind') kind: string, @Req() req: FastifyRequest): Promise<OrgBrandingDto> {
    const k = parseInput(Kind, kind);
    const r = await this.branding.deleteAsset(id, k);
    req.ctx.audit = { resourceId: id, after: { kind: k, removed: true } };
    return r;
  }
}

/**
 * 組織登入畫面用的品牌（不需登入）。放在 /api 之下：nginx 的 /public/ 限流對共用出口 IP 的學校太緊；
 * 這裡以 API 自己的每 IP 限流保護，圖檔另由瀏覽器快取（網址帶內容雜湊）。
 */
@Controller('api/branding')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}

  /** openapi: getPublicBranding */
  @Get(':code')
  @Public()
  @RateLimit([{ name: 'branding', by: 'ip', limit: 300, windowSec: 60 }])
  get(@Param('code') code: string): Promise<PublicBrandingDto> {
    return this.branding.publicByCode(code);
  }

  /** openapi: getPublicBrandAsset——以檔頭判斷過的型別回傳；nosniff、禁止執行任何內容 */
  @Get(':code/:kind')
  @Public()
  @RateLimit([{ name: 'brandasset', by: 'ip', limit: 600, windowSec: 60 }])
  async asset(@Param('code') code: string, @Param('kind') kind: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<StreamableFile> {
    if (!(BRAND_ASSET_KINDS as readonly string[]).includes(kind)) throw new DomainError('NOT_FOUND');
    const a = await this.branding.asset(code, kind as BrandAssetKind);
    reply
      .header('Cache-Control', 'public, max-age=86400')
      .header('ETag', `"${a.sha256}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'");
    return new StreamableFile(a.data, { type: a.contentType, disposition: 'inline' });
  }
}

import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { CMS_PAGE_KEYS, type CmsPageDto, type CmsPageKey, type PublicHomeDto } from '@iac/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, Public, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../common/object-storage.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { CmsDraftInput, CmsRollbackInput } from '../application/cms-inputs.js';
import { CmsService } from '../application/cms.service.js';

const PageKey = z.enum(CMS_PAGE_KEYS);
const key = (v: string): CmsPageKey => parseInput(PageKey, v);

/**
 * 組織首頁（SA UC-CMS-001～004、SD §7.5）：操作的一律是**目前 session 所在組織**的頁面，
 * 不以路徑指定組織——避免跨組織編輯。平台首頁見 PlatformCmsController。
 */
@Controller('api/cms/pages')
export class CmsController {
  constructor(private readonly cms: CmsService) {}

  /** openapi: getCmsPage */
  @Get(':pageKey')
  @RequirePermission('cms.read', { scope: 'organization' })
  get(@Param('pageKey') pageKey: string, @CurrentUser() user: AuthUser): Promise<CmsPageDto> {
    return this.cms.get(user.activeOrganizationId, key(pageKey));
  }

  /** openapi: updateCmsDraft——只動草稿，公開頁面不受影響 */
  @Patch(':pageKey/draft')
  @RequirePermission('cms.write', { scope: 'organization' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'cms.updated', resourceType: 'cms_page' })
  draft(@Param('pageKey') pageKey: string, @Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CmsPageDto> {
    const { blocks } = parseInput(CmsDraftInput, body);
    req.ctx.audit = { after: { pageKey, blocks: blocks.length } };
    return this.cms.saveDraft(user.activeOrganizationId, key(pageKey), blocks);
  }

  /** openapi: publishCmsPage */
  @Post(':pageKey/publish')
  @RequirePermission('cms.publish', { scope: 'organization' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'cms.published', resourceType: 'cms_page' })
  async publish(@Param('pageKey') pageKey: string, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CmsPageDto> {
    const r = await this.cms.publish(user.activeOrganizationId, key(pageKey), user.id);
    req.ctx.audit = { after: { pageKey, revisionNo: r.publishedRevisionNo } };
    return r;
  }

  /** openapi: rollbackCmsPage */
  @Post(':pageKey/rollback')
  @RequirePermission('cms.rollback', { scope: 'organization' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'cms.rolled_back', resourceType: 'cms_page' })
  async rollback(@Param('pageKey') pageKey: string, @Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CmsPageDto> {
    const { revisionNo } = parseInput(CmsRollbackInput, body);
    const r = await this.cms.rollback(user.activeOrganizationId, key(pageKey), revisionNo, user.id);
    req.ctx.audit = { after: { pageKey, rolledBackTo: revisionNo, revisionNo: r.publishedRevisionNo } };
    return r;
  }
}

/**
 * 平台首頁（`/` 顯示的內容，organization_id 為 NULL）。
 * 必須是 platform scope：cms.* 的權限本身是 organization 範圍，但平台首頁不屬於任何組織，
 * 以 session 的 active organization 解析會落空——因此獨立成一組只有平台管理員能用的端點。
 */
@Controller('api/platform/cms/pages')
export class PlatformCmsController {
  constructor(private readonly cms: CmsService) {}

  /** openapi: getPlatformCmsPage */
  @Get(':pageKey')
  @RequirePermission('cms.read', { scope: 'platform' })
  get(@Param('pageKey') pageKey: string): Promise<CmsPageDto> {
    return this.cms.get(null, key(pageKey));
  }

  /** openapi: updatePlatformCmsDraft */
  @Patch(':pageKey/draft')
  @RequirePermission('cms.write', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'cms.updated', resourceType: 'cms_page' })
  draft(@Param('pageKey') pageKey: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<CmsPageDto> {
    const { blocks } = parseInput(CmsDraftInput, body);
    req.ctx.audit = { after: { scope: 'platform', pageKey, blocks: blocks.length } };
    return this.cms.saveDraft(null, key(pageKey), blocks);
  }

  /** openapi: publishPlatformCmsPage */
  @Post(':pageKey/publish')
  @RequirePermission('cms.publish', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'cms.published', resourceType: 'cms_page' })
  async publish(@Param('pageKey') pageKey: string, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CmsPageDto> {
    const r = await this.cms.publish(null, key(pageKey), user.id);
    req.ctx.audit = { after: { scope: 'platform', pageKey, revisionNo: r.publishedRevisionNo } };
    return r;
  }

  /** openapi: rollbackPlatformCmsPage */
  @Post(':pageKey/rollback')
  @RequirePermission('cms.rollback', { scope: 'platform' })
  @RequireCapability({ capability: 'configurationWriteAllowed' })
  @Audit({ action: 'cms.rolled_back', resourceType: 'cms_page' })
  async rollback(@Param('pageKey') pageKey: string, @Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<CmsPageDto> {
    const { revisionNo } = parseInput(CmsRollbackInput, body);
    const r = await this.cms.rollback(null, key(pageKey), revisionNo, user.id);
    req.ctx.audit = { after: { scope: 'platform', pageKey, rolledBackTo: revisionNo, revisionNo: r.publishedRevisionNo } };
    return r;
  }
}

/**
 * 公開首頁（不需登入，SA UC-CMS-005）：只回**已發布**的內容，草稿永遠不會外流。
 * 與公開查驗證書相同，另有每 IP 限流；nginx 的 /public/ 還有第一層限流。
 */
@Controller('public/cms')
export class PublicCmsController {
  constructor(
    private readonly cms: CmsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** openapi: getPublicHome——`org` 省略時為平台首頁 */
  @Get('home')
  @Public()
  @RateLimit([{ name: 'publichome', by: 'ip', limit: 60, windowSec: 60 }])
  home(@Query('org') org?: string): Promise<PublicHomeDto> {
    return this.cms.publicHome(org ? parseInput(z.string().trim().min(1).max(64), org) : undefined);
  }

  /**
   * openapi: getPublicCmsAsset——首頁的圖片與影片。
   * 只有已發布首頁引用到的素材才取得到（見 CmsService.publicAsset）；內容不可變，以 SHA-256 為 ETag。
   * 不支援 Range：首頁素材以圖片為主，影片會整段下載。
   */
  @Get('assets/:assetId')
  @Public()
  @RateLimit([{ name: 'publicasset', by: 'ip', limit: 300, windowSec: 60 }])
  async asset(@Param('assetId') assetId: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const a = await this.cms.publicAsset(parseInput(z.guid(), assetId));
    const etag = `"${a.sha256}"`;
    reply
      .header('content-type', a.mimeType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', 'inline')
      .header('cache-control', 'public, max-age=3600')
      .header('etag', etag);
    if (req.headers['if-none-match'] === etag) {
      await reply.code(304).send();
      return;
    }
    reply.header('content-length', String(a.sizeBytes));
    await reply.send(await this.storage.openRange(a.objectKey, 0, a.sizeBytes - 1));
  }
}

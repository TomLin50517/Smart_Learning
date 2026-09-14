import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { MediaAssetDto } from '@iac/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { DomainError } from '../../../common/domain-error.js';
import { parseRange } from '../../../common/http-range.js';
import { parseInput } from '../../../common/validation.js';
import { MediaService } from '../application/media.service.js';

const UploadQuery = z.object({ filename: z.string().trim().min(1).max(255), title: z.string().trim().max(200).optional() });
const Rename = z.strictObject({ title: z.string().trim().min(1).max(200) });

/** 課程素材（SD §6.23）。上傳本體為 application/octet-stream（bootstrap 的串流 parser） */
@Controller('api')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** openapi: listCourseAssets */
  @Get('courses/:id/assets')
  @RequirePermission('course.version.read', { scope: 'course', resource: 'course' })
  list(@Param('id') id: string): Promise<MediaAssetDto[]> {
    return this.media.list(parseInput(z.guid(), id));
  }

  /** openapi: uploadCourseAsset */
  @Post('courses/:id/assets')
  @RequirePermission('course.version.write', { scope: 'course', resource: 'course' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.asset.uploaded', resourceType: 'media_asset' })
  @HttpCode(201)
  async upload(@Param('id') id: string, @Query() query: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<MediaAssetDto> {
    if (!(req.body instanceof Readable)) throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Send the file body as application/octet-stream');
    const q = parseInput(UploadQuery, query);
    const a = await this.media.upload(parseInput(z.guid(), id), { filename: q.filename, title: q.title ?? null, body: req.body }, actor.id);
    req.ctx.audit = { resourceId: a.id, after: { courseId: a.courseId, kind: a.kind, mimeType: a.mimeType, sizeBytes: a.sizeBytes, title: a.title } };
    return a;
  }

  /** openapi: renameAsset */
  @Patch('assets/:id')
  @RequirePermission('course.version.write', { scope: 'course', resource: 'asset' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.asset.updated', resourceType: 'media_asset' })
  async rename(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<MediaAssetDto> {
    const assetId = parseInput(z.guid(), id);
    const r = await this.media.rename(assetId, parseInput(Rename, body).title);
    req.ctx.audit = { resourceId: assetId, before: { title: r.before }, after: { title: r.after.title } };
    return r.after;
  }

  /** openapi: deleteAsset——被任何課程版本引用時不可刪 */
  @Delete('assets/:id')
  @RequirePermission('course.version.write', { scope: 'course', resource: 'asset' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.asset.deleted', resourceType: 'media_asset' })
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: FastifyRequest): Promise<void> {
    const assetId = parseInput(z.guid(), id);
    const r = await this.media.remove(assetId);
    req.ctx.audit = { resourceId: assetId, before: r };
  }

  /**
   * openapi: getAssetContent——課程人員或這門課的學員。支援單一 Range（影片拖曳）；
   * nosniff＋CSP sandbox，型別取自上傳時的檔頭判斷；內容不可變，以 SHA-256 為 ETag。
   */
  @Get('assets/:id/content')
  @RequirePermission(['course.read', 'learning.result.read_self'], { scope: 'any', includeSelf: true })
  async content(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const a = await this.media.viewable(parseInput(z.guid(), id), user, req.ctx.grants ?? []);
    const etag = `"${a.sha256}"`;
    reply
      .header('content-type', a.mimeType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', 'inline')
      .header('cache-control', 'private, max-age=86400')
      .header('etag', etag)
      .header('accept-ranges', 'bytes');
    if (req.headers['if-none-match'] === etag) {
      await reply.code(304).send();
      return;
    }
    const range = parseRange(req.headers.range, a.sizeBytes);
    if (range === 'invalid') {
      await reply.code(416).header('content-range', `bytes */${a.sizeBytes}`).send();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? a.sizeBytes - 1;
    const stream = await this.media.open(a, start, end);
    reply.header('content-length', String(end - start + 1));
    if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${a.sizeBytes}`);
    await reply.send(stream);
  }
}

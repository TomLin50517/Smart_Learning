import { Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { DocumentVersionDto, DocumentViewDto, SharedDocumentDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { KnowledgeService } from '../application/knowledge.service.js';
import { fileBody } from './knowledge.controller.js';

const UploadQuery = z.object({
  filename: z.string().trim().min(1).max(255),
  title: z.string().trim().max(200).optional(),
});
const VersionQuery = z.object({ filename: z.string().trim().min(1).max(255) });
const ViewQuery = z.object({ page: z.coerce.number().int().min(1).max(100_000).optional() });

/**
 * 組織共用教材（SD §6.27）：組織管理員（knowledge.shared.write）上傳與維護；各課程在草稿版本加入使用。
 * 以教材 id 操作的端點：授權以教材所屬組織判斷（course_id 為 NULL，只有組織層級的授權能涵蓋），
 * 服務層再確認是共用教材——課程自己的教材一律 404。
 */
@Controller('api')
export class SharedKnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  /** openapi: listSharedKnowledge */
  @Get('org/knowledge/documents')
  @RequirePermission('knowledge.shared.write', { scope: 'organization' })
  list(@CurrentUser() user: AuthUser): Promise<SharedDocumentDto[]> {
    return this.knowledge.listShared(user.activeOrganizationId ?? '');
  }

  /** openapi: uploadSharedKnowledge——解析與索引為背景工作；加入課程後才會被檢索 */
  @Post('org/knowledge/documents')
  @RequirePermission('knowledge.shared.write', { scope: 'organization' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.document.uploaded', resourceType: 'document_version' })
  @HttpCode(202)
  async upload(@Query() query: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<DocumentVersionDto> {
    const q = parseInput(UploadQuery, query);
    const v = await this.knowledge.uploadShared(actor.activeOrganizationId ?? '', { filename: q.filename, title: q.title ?? null, body: fileBody(req) }, actor.id);
    req.ctx.audit = { resourceId: v.id, after: { documentId: v.documentId, filename: v.originalFilename, mimeType: v.mimeType, sizeBytes: v.sizeBytes, shared: true } };
    return v;
  }

  /** openapi: addSharedDocumentVersion——各課程草稿版本的綁定改指向新版；已發布版本仍引用舊版 */
  @Post('org/knowledge/documents/:id/versions')
  @RequirePermission('knowledge.shared.write', { scope: 'course', resource: 'document' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.document.version_added', resourceType: 'document_version' })
  @HttpCode(202)
  async addVersion(@Param('id') id: string, @Query() query: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<DocumentVersionDto> {
    const documentId = parseInput(z.guid(), id);
    await this.knowledge.assertShared(documentId);
    const q = parseInput(VersionQuery, query);
    const v = await this.knowledge.addVersion(documentId, { filename: q.filename, body: fileBody(req) }, actor.id);
    req.ctx.audit = { resourceId: v.id, after: { documentId, versionNo: v.versionNo, filename: v.originalFilename, sizeBytes: v.sizeBytes, shared: true } };
    return v;
  }

  /** openapi: retrySharedDocumentVersion */
  @Post('org/knowledge/documents/:id/versions/:versionId/retry')
  @RequirePermission('knowledge.shared.write', { scope: 'course', resource: 'document' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @HttpCode(202)
  async retry(@Param('id') id: string, @Param('versionId') versionId: string): Promise<DocumentVersionDto> {
    const documentId = parseInput(z.guid(), id);
    await this.knowledge.assertShared(documentId);
    return this.knowledge.retry(documentId, parseInput(z.guid(), versionId));
  }

  /** openapi: viewSharedDocument */
  @Get('org/knowledge/documents/:id/versions/:versionId/view')
  @RequirePermission('knowledge.shared.write', { scope: 'course', resource: 'document' })
  async view(@Param('id') id: string, @Param('versionId') versionId: string, @Query() query: unknown): Promise<DocumentViewDto> {
    const documentId = parseInput(z.guid(), id);
    await this.knowledge.assertShared(documentId);
    return this.knowledge.view(documentId, parseInput(z.guid(), versionId), parseInput(ViewQuery, query).page);
  }

  /** openapi: deleteSharedKnowledge——已發布的課程版本仍引用時不可刪 */
  @Delete('org/knowledge/documents/:id')
  @RequirePermission('knowledge.shared.write', { scope: 'course', resource: 'document' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.document.deleted', resourceType: 'source_document' })
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: FastifyRequest): Promise<void> {
    const documentId = parseInput(z.guid(), id);
    await this.knowledge.assertShared(documentId);
    const r = await this.knowledge.deleteDocument(documentId);
    req.ctx.audit = { resourceId: documentId, before: { ...r, shared: true } };
  }
}

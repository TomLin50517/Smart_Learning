import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { CourseKnowledgeDto, DocumentVersionDto, DocumentViewDto, KnowledgeSearchResultDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequireCapability, RequirePermission } from '../../../common/decorators.js';
import { DomainError } from '../../../common/domain-error.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { KnowledgeService } from '../application/knowledge.service.js';

const UploadQuery = z.object({
  filename: z.string().trim().min(1).max(255),
  title: z.string().trim().max(200).optional(),
});
const VersionQuery = z.object({ filename: z.string().trim().min(1).max(255) });
const ViewQuery = z.object({ page: z.coerce.number().int().min(1).max(100_000).optional() });
const Bind = z.strictObject({ documentVersionId: z.guid() });
const Search = z.strictObject({ query: z.string().trim().min(1).max(500) });

/** 檔案以 application/octet-stream 傳送原始內容（bootstrap 註冊的串流 parser） */
export function fileBody(req: FastifyRequest): Readable {
  if (req.body instanceof Readable) return req.body;
  throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Send the file body as application/octet-stream');
}

/** 教材知識庫（SA UC-KNW-001～003、SD §6.17）。學員不經這些端點——他們經 AI 教練的引用開啟原文（3-4） */
@Controller('api')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  /** openapi: listCourseKnowledge——此版本綁定的教材與本課程可加入的教材 */
  @Get('course-versions/:id/knowledge')
  @RequirePermission('knowledge.document.read', { scope: 'course', resource: 'course_version' })
  list(@Param('id') id: string): Promise<CourseKnowledgeDto> {
    return this.knowledge.list(id);
  }

  /** openapi: searchCourseKnowledge——課程人員測試檢索（與 AI 教練同一個檢索器與範圍） */
  @Post('course-versions/:id/knowledge/search')
  @RequirePermission('knowledge.document.read', { scope: 'course', resource: 'course_version' })
  @RateLimit([{ name: 'knowledgesearch', by: 'user', limit: 60, windowSec: 60 }])
  @HttpCode(200)
  search(@Param('id') id: string, @Body() body: unknown): Promise<KnowledgeSearchResultDto> {
    return this.knowledge.search(id, parseInput(Search, body).query);
  }

  /** openapi: uploadKnowledgeDocument——只限草稿版本；解析與索引為背景工作 */
  @Post('course-versions/:id/knowledge/documents')
  @RequirePermission('knowledge.document.write', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.document.uploaded', resourceType: 'document_version' })
  @HttpCode(202)
  async upload(@Param('id') id: string, @Query() query: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<DocumentVersionDto> {
    const q = parseInput(UploadQuery, query);
    const v = await this.knowledge.upload(id, { filename: q.filename, title: q.title ?? null, body: fileBody(req) }, actor.id);
    req.ctx.audit = { resourceId: v.id, after: { documentId: v.documentId, filename: v.originalFilename, mimeType: v.mimeType, sizeBytes: v.sizeBytes, courseVersionId: id } };
    return v;
  }

  /** openapi: bindKnowledgeDocument——把本課程的教材加入這個草稿版本 */
  @Post('course-versions/:id/knowledge/bindings')
  @RequirePermission('knowledge.document.write', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.version.updated', resourceType: 'course_version' })
  @HttpCode(200)
  async bind(@Param('id') id: string, @Body() body: unknown, @Req() req: FastifyRequest): Promise<CourseKnowledgeDto> {
    const { documentVersionId } = parseInput(Bind, body);
    const r = await this.knowledge.bind(id, documentVersionId);
    req.ctx.audit = { resourceId: id, after: { knowledgeBound: documentVersionId } };
    return r;
  }

  /** openapi: unbindKnowledgeDocument——從草稿版本移出（教材保留） */
  @Delete('course-versions/:id/knowledge/bindings/:documentVersionId')
  @RequirePermission('knowledge.document.write', { scope: 'course', resource: 'course_version' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'course.version.updated', resourceType: 'course_version' })
  async unbind(@Param('id') id: string, @Param('documentVersionId') documentVersionId: string, @Req() req: FastifyRequest): Promise<CourseKnowledgeDto> {
    const dv = parseInput(z.guid(), documentVersionId);
    const r = await this.knowledge.unbind(id, dv);
    req.ctx.audit = { resourceId: id, after: { knowledgeUnbound: dv } };
    return r;
  }

  /** openapi: addDocumentVersion——草稿版本的綁定改指向新版；已發布版本仍引用舊版 */
  @Post('knowledge/documents/:id/versions')
  @RequirePermission('knowledge.document.write', { scope: 'course', resource: 'document' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.document.version_added', resourceType: 'document_version' })
  @HttpCode(202)
  async addVersion(@Param('id') id: string, @Query() query: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<DocumentVersionDto> {
    const q = parseInput(VersionQuery, query);
    const v = await this.knowledge.addVersion(id, { filename: q.filename, body: fileBody(req) }, actor.id);
    req.ctx.audit = { resourceId: v.id, after: { documentId: id, versionNo: v.versionNo, filename: v.originalFilename, sizeBytes: v.sizeBytes } };
    return v;
  }

  /** openapi: retryDocumentVersion——處理失敗後重新解析 */
  @Post('knowledge/documents/:id/versions/:versionId/retry')
  @RequirePermission('knowledge.document.write', { scope: 'course', resource: 'document' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @HttpCode(202)
  retry(@Param('id') id: string, @Param('versionId') versionId: string): Promise<DocumentVersionDto> {
    return this.knowledge.retry(id, parseInput(z.guid(), versionId));
  }

  /** openapi: viewDocumentSource——課程人員預覽擷取出的文字 */
  @Get('knowledge/documents/:id/versions/:versionId/view')
  @RequirePermission('knowledge.document.read', { scope: 'course', resource: 'document' })
  view(@Param('id') id: string, @Param('versionId') versionId: string, @Query() query: unknown): Promise<DocumentViewDto> {
    return this.knowledge.view(id, parseInput(z.guid(), versionId), parseInput(ViewQuery, query).page);
  }

  /** openapi: deleteKnowledgeDocument——已發布的版本仍引用時不可刪 */
  @Delete('knowledge/documents/:id')
  @RequirePermission('knowledge.document.write', { scope: 'course', resource: 'document' })
  @RequireCapability({ capability: 'authoringAllowed' })
  @Audit({ action: 'knowledge.document.deleted', resourceType: 'source_document' })
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: FastifyRequest): Promise<void> {
    const r = await this.knowledge.deleteDocument(id);
    req.ctx.audit = { resourceId: id, before: r };
  }
}

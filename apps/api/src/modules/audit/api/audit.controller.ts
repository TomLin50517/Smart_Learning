import { Body, Controller, Get, Header, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { AUDIT_EXPORT_MAX_DAYS, type AuditLogPage } from '@iac/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditVisibility, organizationsGranted } from '../../../common/authz.js';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, RequirePermission } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { AuditQueryService } from '../application/audit-query.service.js';

const DAY_MS = 86_400_000;

/**
 * action 篩選：小寫字母、底線與點，可選 ".*" 表示前綴。不接受 % 等其他字元。
 * 底線在 LIKE 中是單字元萬用字元，最多只會讓前綴比對範圍稍寬，可見範圍仍由授權過濾，不會越權。
 */
const Action = z.string().max(100).regex(/^[a-z][a-z_.]*(\.\*)?$/, 'invalid action filter');
const Timestamp = z.iso.datetime({ offset: true });

const ListQuery = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    action: Action.optional(),
    from: Timestamp.optional(),
    to: Timestamp.optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), { message: 'must_be_after_from', path: ['to'] });

const ExportBody = z
  .strictObject({
    from: Timestamp,
    to: Timestamp,
    action: Action.optional(),
    organizationId: z.guid().optional(),
  })
  .refine((b) => Date.parse(b.from) < Date.parse(b.to), { message: 'must_be_after_from', path: ['to'] })
  .refine((b) => Date.parse(b.to) - Date.parse(b.from) <= AUDIT_EXPORT_MAX_DAYS * DAY_MS, { message: 'range_too_large', path: ['to'] });

@Controller('api/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  /**
   * openapi: listAuditLogs——四種可見範圍（SA UC-AUD-001）：
   * 平台全部／組織／課程／本人相關（本人相關的紀錄會裁剪欄位）。
   */
  @Get()
  @RequirePermission(['audit.read_platform', 'audit.read_org', 'audit.read_course', 'audit.read_self'], { scope: 'any', includeSelf: true })
  list(@Query() query: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<AuditLogPage> {
    const q = parseInput(ListQuery, query);
    return this.audit.list(auditVisibility(req.ctx.grants ?? [], user.id), user.id, q);
  }

  /** openapi: exportAuditLogs——同步 CSV（ADR-032）；查詢條件與筆數寫入 audit.exported */
  @Post('export')
  @RequirePermission('audit.export', { scope: 'any' })
  @Audit({ action: 'audit.exported', resourceType: 'audit' })
  @HttpCode(200)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async export(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    const input = parseInput(ExportBody, body);
    const r = await this.audit.export(organizationsGranted(req.ctx.grants ?? [], 'audit.export'), input);
    const day = (iso: string) => iso.slice(0, 10).replace(/-/g, '');
    void reply.header('content-disposition', `attachment; filename="audit-${day(input.from)}-${day(input.to)}.csv"`);
    req.ctx.audit = {
      metadata: { from: input.from, to: input.to, action: input.action ?? null, organizationId: input.organizationId ?? null, rows: r.rows },
    };
    return r.csv;
  }
}

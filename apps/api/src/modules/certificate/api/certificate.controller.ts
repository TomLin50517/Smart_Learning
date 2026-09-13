import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { CourseCertificateDto, MyCertificateDto, PublicCertificateDto } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, CurrentUser, Public, RequirePermission } from '../../../common/decorators.js';
import { RateLimit } from '../../../common/rate-limit.js';
import { parseInput } from '../../../common/validation.js';
import { CertificateService } from '../application/certificate.service.js';

const Revoke = z.strictObject({ reason: z.string().trim().min(1).max(500) });

@Controller('api')
export class CertificateController {
  constructor(private readonly certs: CertificateService) {}

  /** openapi: listMyCertificates——含驗證碼 */
  @Get('me/certificates')
  @RequirePermission('certificate.read_self', { scope: 'self' })
  mine(@CurrentUser() user: AuthUser): Promise<MyCertificateDto[]> {
    return this.certs.mine(user.id);
  }

  /** openapi: getMyCertificate——網頁版證書（可列印）；不是本人的 404 */
  @Get('me/certificates/:id')
  @RequirePermission('certificate.read_self', { scope: 'self' })
  myOne(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<MyCertificateDto> {
    return this.certs.myOne(parseInput(z.guid(), id), user.id);
  }

  /** openapi: listCourseCertificates */
  @Get('courses/:id/certificates')
  @RequirePermission('certificate.read_all', { scope: 'course', resource: 'course' })
  course(@Param('id') id: string): Promise<CourseCertificateDto[]> {
    return this.certs.forCourse(id);
  }

  /** openapi: revokeCertificate——只改狀態、保留紀錄（ARCH §17.4） */
  @Post('certificates/:id/revoke')
  @RequirePermission('certificate.revoke', { scope: 'course', resource: 'certificate' })
  @Audit({ action: 'certificate.revoked', resourceType: 'certificate' })
  @HttpCode(200)
  async revoke(@Param('id') id: string, @Body() body: unknown, @CurrentUser() actor: AuthUser, @Req() req: FastifyRequest): Promise<CourseCertificateDto> {
    const { reason } = parseInput(Revoke, body);
    const r = await this.certs.revoke(id, actor.id, reason);
    req.ctx.audit = { before: { status: 'valid' }, after: { status: 'revoked' }, metadata: { reason, public_id: r.publicId, enrollment_id: r.enrollmentId } };
    return r;
  }
}

/** 公開驗證（不需登入）：每個 IP 每分鐘 30 次（THR-D-005）；nginx 的 /public/ 另有第一層限流 */
@Controller('public/certificates')
export class PublicCertificateController {
  constructor(private readonly certs: CertificateService) {}

  /** openapi: verifyCertificatePublic */
  @Get(':verificationCode')
  @Public()
  @RateLimit([{ name: 'certverify', by: 'ip', limit: 30, windowSec: 60 }])
  verify(@Param('verificationCode') code: string): Promise<PublicCertificateDto> {
    return this.certs.verify(code);
  }
}

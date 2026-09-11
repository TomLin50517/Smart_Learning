import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Audit, AuthOnly, Public } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { AuthService, type RequestMeta } from '../application/auth.service.js';
import { SessionService } from '../application/session.service.js';

const Credentials = z.object({
  email: z.email().max(254),
  // 登入不套用密碼政策（舊密碼仍須可登入）；上限防止超長輸入拖慢雜湊
  password: z.string().min(1).max(1024),
});
const ResetRequest = z.object({ email: z.email().max(254) });
const ResetConfirm = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(8).max(128),
});

function meta(req: FastifyRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    correlationId: req.ctx.correlationId,
    ...(req.ip && { ip: req.ip }),
    ...(typeof ua === 'string' && { userAgent: ua }),
  };
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /** openapi: login */
  @Post('login')
  @Public()
  @HttpCode(200)
  @Audit({ action: 'auth.login.succeeded', resourceType: 'user' })
  async login(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { email, password } = parseInput(Credentials, body);
    const { user, session } = await this.auth.login(email, password, meta(req));
    this.sessions.setCookies(reply, session);
    // 公開路由沒有經過 AuthGuard；在此補上，讓 AuditInterceptor 記到正確的 actor
    req.ctx.user = user;
    req.ctx.sessionId = session.id;
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  /** openapi: logout（需 CSRF token） */
  @Post('logout')
  @AuthOnly()
  @HttpCode(204)
  @Audit({ action: 'auth.logout', resourceType: 'user_session' })
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(req.ctx.sessionId!);
    this.sessions.clearCookies(reply);
  }

  /** openapi: refreshSession（需 CSRF token；輪替 token 與 CSRF token，不延長絕對到期） */
  @Post('refresh')
  @AuthOnly()
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.auth.refresh(req.ctx.sessionId!, meta(req));
    this.sessions.setCookies(reply, session);
    return { csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() };
  }

  /** openapi: requestPasswordReset（一律 202） */
  @Post('password-reset/request')
  @Public()
  @HttpCode(202)
  @Audit({ action: 'auth.password_reset.requested', resourceType: 'user' })
  async requestPasswordReset(@Body() body: unknown, @Req() req: FastifyRequest): Promise<void> {
    const { email } = parseInput(ResetRequest, body);
    await this.auth.requestPasswordReset(email, meta(req));
  }

  /** openapi: confirmPasswordReset */
  @Post('password-reset/confirm')
  @Public()
  @HttpCode(204)
  @Audit({ action: 'auth.password_reset.completed', resourceType: 'user' })
  async confirmPasswordReset(@Body() body: unknown, @Req() req: FastifyRequest): Promise<void> {
    const { token, newPassword } = parseInput(ResetConfirm, body);
    req.ctx.user = await this.auth.confirmPasswordReset(token, newPassword, meta(req));
  }
}

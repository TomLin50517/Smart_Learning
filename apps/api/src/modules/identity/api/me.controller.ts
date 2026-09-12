import { Body, Controller, Get, HttpCode, Patch, Post, Put, Req } from '@nestjs/common';
import type { MeResponse } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { Audit, AuthOnly, CurrentUser } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { MeService } from '../application/me.service.js';
import { ProfileService, SUPPORTED_LOCALES } from '../application/profile.service.js';

const SwitchOrg = z.strictObject({ organizationId: z.guid() });

const ProfilePatch = z
  .strictObject({
    displayName: z.string().trim().min(1).max(200).optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
  })
  .refine((p) => p.displayName !== undefined || p.locale !== undefined, 'nothing_to_update');

const PasswordChange = z.strictObject({
  // 目前密碼不套用政策（舊密碼可能早於政策）；上限防止超長輸入拖慢雜湊
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(8).max(128),
});

/**
 * 本人相關端點。全部 @AuthOnly：每個帳號都能管理自己（SA UC-ORG-005，SD §8.12）。
 */
@Controller('api')
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly profile: ProfileService,
  ) {}

  /** openapi: getMe（任何已登入使用者皆可呼叫，不需特定權限） */
  @Get('me')
  @AuthOnly()
  get(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.me.build(user);
  }

  /** openapi: setActiveOrganization——只影響目前 session */
  @Put('me/active-organization')
  @AuthOnly()
  @HttpCode(200)
  async switchOrganization(@Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<MeResponse> {
    const { organizationId } = parseInput(SwitchOrg, body);
    await this.profile.switchOrganization(user.id, req.ctx.sessionId!, organizationId);
    return this.me.build({ ...user, activeOrganizationId: organizationId });
  }

  /** openapi: updateMyProfile */
  @Patch('me/profile')
  @AuthOnly()
  @Audit({ action: 'user.profile.updated', resourceType: 'user' })
  async updateProfile(@Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest) {
    const r = await this.profile.updateProfile(user.id, parseInput(ProfilePatch, body));
    req.ctx.audit = { resourceId: user.id, before: r.before, after: r.after };
    return r.profile;
  }

  /** openapi: changeMyPassword——成功後撤銷其他 session */
  @Post('me/password')
  @AuthOnly()
  @HttpCode(204)
  @Audit({ action: 'auth.password.changed', resourceType: 'user' })
  async changePassword(@Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<void> {
    const { currentPassword, newPassword } = parseInput(PasswordChange, body);
    const r = await this.profile.changePassword(user.id, req.ctx.sessionId!, currentPassword, newPassword);
    req.ctx.audit = { resourceId: user.id, metadata: { revoked_sessions: r.revokedSessions } };
  }
}

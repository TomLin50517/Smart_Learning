import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { decideAccess, type AccessTarget } from '../authz.js';
import type { AuthUser } from '../context.js';
import { AuthOnly, Public, RequirePermissionMeta, type PermissionRequirement } from '../decorators.js';
import { DomainError } from '../domain-error.js';
import { GrantLoader } from '../grant-loader.js';
import { ScopeResolver } from '../scope-resolver.js';

/**
 * INV-8 第 2 步：RBAC + scope + ownership（SA §6.5 步驟 2、3、5）。
 *
 * 預設拒絕：非 @Public、非 @AuthOnly 的路由必須宣告 @RequirePermission，
 * 否則一律 403——漏標權限的路由不會意外對外開放。
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly scopes: ScopeResolver,
    private readonly grantLoader: GrantLoader,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride(Public, targets)) return true;
    if (this.reflector.getAllAndOverride(AuthOnly, targets)) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const user = req.ctx.user;
    if (!user) throw new DomainError('UNAUTHENTICATED');

    const requirement = this.reflector.getAllAndOverride(RequirePermissionMeta, targets);
    if (!requirement) {
      throw new DomainError('PERMISSION_DENIED', 'Route declares no permission requirement (deny by default)');
    }

    req.ctx.grants ??= await this.grantLoader.load(user.id);
    const target = await this.resolveTarget(requirement, req, user);

    switch (decideAccess(user.id, req.ctx.grants, requirement.permission, target)) {
      case 'allow':
        req.ctx.target = { organizationId: target.organizationId, courseId: target.courseId, resourceId: null };
        return true;
      case 'not_found':
        throw new DomainError('NOT_FOUND');
      case 'forbidden':
        throw new DomainError('PERMISSION_DENIED');
    }
  }

  private async resolveTarget(r: PermissionRequirement, req: FastifyRequest, user: AuthUser): Promise<AccessTarget> {
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    const id = params[r.param ?? 'id'];

    switch (r.scope) {
      case 'platform':
        return { scope: 'platform', exists: true, organizationId: null, courseId: null, userId: null };

      case 'any':
        return { scope: 'any', exists: true, organizationId: null, courseId: null, userId: null, includeSelf: r.includeSelf === true };

      case 'self':
        return { scope: 'self', exists: true, organizationId: user.activeOrganizationId, courseId: null, userId: user.id };

      case 'organization': {
        // 未指定 param 時，以 session 的 active organization 為目標——仍由 DB 確認存在與狀態
        const orgId = r.param ? id : (id ?? user.activeOrganizationId ?? undefined);
        return { scope: 'organization', ...(await this.scopes.resolve('organization', orgId)), userId: null };
      }

      case 'course': {
        const kind = r.resource === 'course_version' || r.resource === 'enrollment' || r.resource === 'certificate' ? r.resource : 'course';
        return { scope: 'course', ...(await this.scopes.resolve(kind, id)), userId: null };
      }
    }
  }
}

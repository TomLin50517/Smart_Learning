import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditAction, CapabilityName, LimitName, PermissionCode, ScopeType } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from './context.js';

/**
 * 路由的目標 scope 如何解析（SA §6.1 / §6.5）。
 * - platform：不需參數
 * - organization：取 route param（預設 'id'），未指定則用 session 的 active organization
 * - course / course_version：取 route param，再由 ScopeResolver 查出所屬組織
 * - self：目標就是目前使用者
 * - any：列表端點——任何範圍持有此權限即可進入，handler 必須依授權過濾結果
 */
export interface ScopeTarget {
  scope: ScopeType | 'any';
  /** 對應的資源種類；course scope 可由 course 或 course_version 反查 */
  resource?: 'organization' | 'course' | 'course_version';
  /** route param 名稱，預設 'id' */
  param?: string;
}

export interface PermissionRequirement extends ScopeTarget {
  permission: PermissionCode;
}

export const RequirePermissionMeta = Reflector.createDecorator<PermissionRequirement>();

/** 宣告此路由需要的權限與目標 scope（INV-8 第 2 步） */
export const RequirePermission = (permission: PermissionCode, target: ScopeTarget) =>
  RequirePermissionMeta({ permission, ...target });

export interface CapabilityRequirement {
  capability?: CapabilityName;
  limit?: LimitName;
}

/** 宣告此路由需要的授權能力或數量上限（INV-8 第 3 步） */
export const RequireCapability = Reflector.createDecorator<CapabilityRequirement>();

export interface AuditSpec {
  action: AuditAction;
  resourceType: string;
  /** 取 resource_id 的 route param，預設 'id' */
  param?: string;
}

/** 宣告此路由成功後需寫入的 audit action（INV-8 第 5 步） */
export const Audit = Reflector.createDecorator<AuditSpec>();

/** 免認證（健康檢查、公開證書驗證、登入） */
export const Public = Reflector.createDecorator<true>({ transform: () => true });

/**
 * 需要登入，但不需特定權限（session 自身操作，如 /me、logout）。
 * 與 openapi.yaml 的 x-auth-only 對應。
 */
export const AuthOnly = Reflector.createDecorator<true>({ transform: () => true });

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.ctx.user) throw new Error('CurrentUser used on a route without authentication');
  return req.ctx.user;
});

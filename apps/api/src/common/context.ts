import type { ScopeGrant } from '@iac/contracts';

/** 已認證使用者（AuthGuard 寫入） */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  activeOrganizationId: string | null;
}

/** 單一授權：某權限在某 scope 上成立 */
export interface PermissionGrant extends ScopeGrant {
  permission: string;
}

/**
 * 每個請求的上下文，掛在 Fastify request 上。
 * organization_id 一律由此處（session + grants）推導，不採信 client（INV-1）。
 */
export interface RequestContext {
  correlationId: string;
  user?: AuthUser;
  /** AuthGuard 寫入；CSRF token 由此推導 */
  sessionId?: string;
  /** PermissionGuard 延遲載入，同一請求內只查一次 */
  grants?: PermissionGrant[];
  /** PermissionGuard 解析出的目標 scope，供 AuditInterceptor 記錄 */
  target?: { organizationId: string | null; courseId: string | null; resourceId: string | null };
  /** handler 可補充稽核細節（新建資源的 id、變更前後），AuditInterceptor 會一併寫入 */
  audit?: { resourceId?: string; before?: unknown; after?: unknown; metadata?: Record<string, unknown> };
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

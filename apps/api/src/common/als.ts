import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './context.js';

/**
 * 請求範圍的 AsyncLocalStorage（SD §13.4）。store 就是 req.ctx 本身：
 * AuthGuard／PermissionGuard 後續寫入的 user、target 會即時反映在 log 上，
 * 不需要在每個 log 呼叫點手動傳 correlation id。
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/** logger mixin：目前請求的關聯欄位（不在請求內時為空物件） */
export function logContext(): Record<string, string> {
  const c = requestContext.getStore();
  if (!c) return {};
  const organizationId = c.target?.organizationId ?? c.user?.activeOrganizationId ?? null;
  return {
    correlation_id: c.correlationId,
    ...(c.user && { actor_user_id: c.user.id }),
    ...(organizationId && { organization_id: organizationId }),
  };
}

import type { RequestContext } from './context.js';

/** 探針類路由：成功時降為 debug，避免每 30 秒一筆 health check 淹沒 log */
export const QUIET_ROUTES = new Set(['/api/system/health', '/api/system/ready', '/api/system/metrics']);

/** 路由樣板 → 模組名（/api/organizations/:id → organizations） */
export function moduleOf(route: string): string {
  return /^\/(?:api|public)\/([^/]+)/.exec(route)?.[1] ?? 'unmatched';
}

export interface AccessLogInput {
  method: string;
  /** Fastify 路由樣板；未命中任何路由時為 undefined */
  route: string | undefined;
  status: number;
  durationMs: number;
  ctx: RequestContext | undefined;
}

/**
 * 每個請求一筆的存取 log（SD §13.1、SA §18.1）。
 * 只記路由樣板、不記原始 URL：query string 與路徑參數可能含識別資料，
 * 且樣板才能讓 log 與 metrics 以同一個 route 維度彙整。
 */
export function accessLogEntry(i: AccessLogInput) {
  const route = i.route ?? 'unmatched';
  const organizationId = i.ctx?.target?.organizationId ?? i.ctx?.user?.activeOrganizationId ?? null;
  return {
    module: moduleOf(route),
    operation: `${i.method} ${route}`,
    method: i.method,
    route,
    status: i.status,
    duration_ms: Math.round(i.durationMs * 10) / 10,
    outcome: i.ctx?.errorCode ?? (i.status < 400 ? 'success' : `http_${i.status}`),
    ...(i.ctx && { correlation_id: i.ctx.correlationId }),
    ...(i.ctx?.user && { actor_user_id: i.ctx.user.id }),
    ...(organizationId && { organization_id: organizationId }),
  };
}

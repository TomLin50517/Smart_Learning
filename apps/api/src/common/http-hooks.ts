import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { accessLogEntry, QUIET_ROUTES } from './access-log.js';
import { requestContext } from './als.js';
import type { RequestContext } from './context.js';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * 每個請求（SD §6.1.3、§13）：
 * 1. 建立 RequestContext 並處理 X-Request-Id——外部傳入的 id 只在格式安全時沿用，避免 log injection
 * 2. 以 AsyncLocalStorage 包住整個請求生命週期，讓所有 log 自動帶上關聯欄位
 * 3. 回應後寫一筆存取 log，並累計 HTTP 指標
 */
export function registerRequestContext(fastify: FastifyInstance): void {
  fastify.decorateRequest('ctx', null as unknown as RequestContext);

  // callback 形式：done 在 als.run 內呼叫，後續所有 hook／handler 都在同一個 context 中執行
  fastify.addHook('onRequest', (req, reply, done) => {
    const incoming = req.headers['x-request-id'];
    const correlationId = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    req.ctx = { correlationId };
    void reply.header('x-request-id', correlationId);
    requestContext.run(req.ctx, done);
  });

  fastify.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url;
    const entry = accessLogEntry({
      method: req.method,
      route,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      ctx: req.ctx ?? undefined,
    });
    metrics.httpRequests.inc({ route: entry.route, method: entry.method, status: String(entry.status) });
    metrics.httpDuration.observe({ route: entry.route, method: entry.method }, entry.duration_ms / 1000);

    if (QUIET_ROUTES.has(entry.route) && entry.status < 400) logger.debug(entry, 'request');
    else if (entry.status >= 500) logger.error(entry, 'request');
    else logger.info(entry, 'request');
  });
}

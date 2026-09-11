import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RequestContext } from './context.js';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * 每個請求建立 RequestContext 並處理 X-Request-Id（SD §6.1.3、§13.4）。
 * 外部傳入的 id 只在格式安全時沿用，避免 log injection。
 */
export function registerRequestContext(fastify: FastifyInstance): void {
  fastify.decorateRequest('ctx', null as unknown as RequestContext);
  fastify.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-request-id'];
    const correlationId = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    req.ctx = { correlationId };
    void reply.header('x-request-id', correlationId);
  });
}

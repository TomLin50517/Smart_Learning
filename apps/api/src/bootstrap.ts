import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { registerRequestContext } from './common/http-hooks.js';
import type { TrustProxySetting } from './config/env.js';

/**
 * 正式啟動與 e2e 測試共用同一份設定，確保測的就是會上線的組態。
 *
 * trustProxy 預設 false：只有確定位於反向代理之後才信任 X-Forwarded-For，
 * 否則 client 可偽造 IP 規避流量限制並污染 audit 的 actor_ip。
 */
export function createAdapter(trustProxy: TrustProxySetting = false): FastifyAdapter {
  return new FastifyAdapter({
    logger: false,
    trustProxy,
    bodyLimit: 1_048_576,
  });
}

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();
  registerRequestContext(fastify);
  // 檔案上傳（教材，SD §6.17）：以 application/octet-stream 傳送原始內容，不經 JSON 的 1 MB 上限。
  // 本體以串流交給 handler，由 handler 邊寫入暫存檔邊計算大小（上限依平台設定 upload.max_size）
  fastify.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  await app.register(fastifyCookie);
  app.enableShutdownHooks();
}

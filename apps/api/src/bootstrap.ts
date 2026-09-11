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
  registerRequestContext(app.getHttpAdapter().getInstance());
  await app.register(fastifyCookie);
  app.enableShutdownHooks();
}

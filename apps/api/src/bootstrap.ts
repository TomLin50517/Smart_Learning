import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { registerRequestContext } from './common/http-hooks.js';

/** 正式啟動與 e2e 測試共用同一份設定，確保測的就是會上線的組態 */
export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    logger: false,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });
}

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  registerRequestContext(app.getHttpAdapter().getInstance());
  await app.register(fastifyCookie);
  app.enableShutdownHooks();
}

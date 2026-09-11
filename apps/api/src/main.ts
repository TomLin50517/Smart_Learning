import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { configureApp, createAdapter } from './bootstrap.js';
import { logger } from './common/logger.js';
import { loadEnv, parseTrustProxy } from './config/env.js';

async function main(): Promise<void> {
  // adapter 在 DI 容器建立前就需要設定，因此先行載入（EnvModule 之後會再驗證同一份）
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(parseTrustProxy(env.TRUST_PROXY)), {
    logger: ['error', 'warn'],
  });
  await configureApp(app);

  await app.listen(env.API_PORT, '0.0.0.0');
  logger.info({ port: env.API_PORT }, 'api listening');
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});

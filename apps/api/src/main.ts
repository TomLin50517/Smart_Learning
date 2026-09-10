import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { configureApp, createAdapter } from './bootstrap.js';
import { logger } from './common/logger.js';
import { ENV, type Env } from './config/env.js';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(), {
    logger: ['error', 'warn'],
  });
  await configureApp(app);

  const env = app.get<Env>(ENV);
  await app.listen(env.API_PORT, '0.0.0.0');
  logger.info({ port: env.API_PORT }, 'api listening');
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});

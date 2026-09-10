import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env.js';

/** 提供已驗證的 ENV；測試以 overrideProvider(ENV) 注入 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class EnvModule {}

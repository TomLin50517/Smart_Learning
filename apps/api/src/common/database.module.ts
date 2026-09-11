import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { ENV, type Env } from '../config/env.js';

/** app_api 角色的連線（一般業務） */
export const DB_API = Symbol('DB_API');
/**
 * app_coach 角色的連線（ADR-026）。對 learning_results / enrollments /
 * certificates 只有 SELECT——即使程式碼誤寫，資料庫也會拒絕改分。
 * 只有 AiCoachModule 可以注入此 token。
 */
export const DB_COACH = Symbol('DB_COACH');

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DB_API) private readonly api: pg.Pool,
    @Inject(DB_COACH) private readonly coach: pg.Pool,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.api.end(), this.coach.end()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_API,
      inject: [ENV],
      useFactory: (env: Env) =>
        new pg.Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX, application_name: 'iac-api' }),
    },
    {
      provide: DB_COACH,
      inject: [ENV],
      useFactory: (env: Env) =>
        new pg.Pool({
          connectionString: env.DATABASE_URL_COACH,
          max: env.DB_POOL_MAX_COACH,
          application_name: 'iac-api-coach',
        }),
    },
    PoolLifecycle,
  ],
  exports: [DB_API, DB_COACH],
})
export class DatabaseModule {}

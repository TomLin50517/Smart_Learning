import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { Public } from '../../../common/decorators.js';
import { ENV, type Env } from '../../../config/env.js';

@Controller('api/system')
export class SystemController {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** liveness：只確認進程存活 */
  @Get('health')
  @Public()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * readiness（ADR-023）：只以 PostgreSQL 決定是否 ready。
   * Elasticsearch / LLM 故障不讓整個 API 被判定不可用——學習不依賴它們（INV-4）。
   */
  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    let database: 'ok' | 'unreachable' = 'ok';
    let migrations = 0;
    try {
      const r = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
      migrations = r.rows[0]?.n ?? 0;
    } catch {
      database = 'unreachable';
    }

    const ready = database === 'ok' && migrations > 0;
    if (!ready) void reply.status(503);

    return {
      ready,
      degraded: [] as string[],
      components: {
        database,
        migrations,
        elasticsearch: this.env.ELASTICSEARCH_URL ? 'configured' : 'not_configured',
        ai_provider: this.env.AI_PROVIDER,
      },
    };
  }
}

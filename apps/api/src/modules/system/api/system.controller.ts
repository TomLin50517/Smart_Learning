import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { JobQueueStatus, SystemStatusDto } from '@iac/contracts';
import type { FastifyReply } from 'fastify';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { Public, RequirePermission } from '../../../common/decorators.js';
import { ENV, type Env } from '../../../config/env.js';
import { JobStatusService } from '../application/job-status.service.js';
import { MetricsCollector } from '../application/metrics-collector.js';
import { SystemStatusService } from '../application/system-status.service.js';

@Controller('api/system')
export class SystemController {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly collector: MetricsCollector,
    private readonly jobStatus: JobStatusService,
    private readonly systemStatus: SystemStatusService,
  ) {}

  /** openapi: getHealth——liveness：只確認進程存活 */
  @Get('health')
  @Public()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * openapi: getReadiness——readiness（ADR-023）：只以 PostgreSQL 決定是否 ready。
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

  /** openapi: getJobQueueStatus——佇列、stale lock、DLQ（SD §8.11） */
  @Get('jobs')
  @RequirePermission('platform.health.read', { scope: 'platform' })
  jobs(): Promise<JobQueueStatus> {
    return this.jobStatus.status();
  }

  /** openapi: getSystemStatus——平台管理員的一頁總覽與告警（SD §6.28） */
  @Get('status')
  @RequirePermission('platform.health.read', { scope: 'platform' })
  status(): Promise<SystemStatusDto> {
    return this.systemStatus.status();
  }

  /** openapi: getMetrics——Prometheus text format 0.0.4（SD §13.2） */
  @Get('metrics')
  @RequirePermission('platform.health.read', { scope: 'platform' })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  metrics(): Promise<string> {
    return this.collector.render();
  }
}

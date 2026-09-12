/**
 * 可觀測性端到端測試（SD §13、SA §18）：AsyncLocalStorage 關聯、metrics 端點與權限、各類指標。
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Controller, Get, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { currentContext } from '../../apps/api/src/common/als.js';
import { AuthOnly } from '../../apps/api/src/common/decorators.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const FINGERPRINT = 'sha256:e2e-obs';
const ORG = '66666666-0000-0000-0000-00000000000a';
const PADMIN = '77777777-0000-0000-0000-000000000001';
const LEARNER = '77777777-0000-0000-0000-000000000002';

/** 只存在於測試：在 handler 內（經過 await 之後）讀取 ALS context */
@Controller('api/__probe')
class ProbeController {
  @Get('context')
  @AuthOnly()
  async context() {
    await new Promise((r) => setTimeout(r, 5));
    const c = currentContext();
    return { correlationId: c?.correlationId ?? null, userId: c?.user?.id ?? null };
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const tokens = {} as Record<'padmin' | 'learner', string>;

async function session(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await admin.query(`INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`, [
    userId,
    hashToken(token),
    ORG,
  ]);
  return token;
}

const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { ...headers, ...(token && { cookie: `iac_session=${token}` }) } });

async function scrape(): Promise<string> {
  const res = await get('/api/system/metrics', tokens.padmin);
  expect(res.statusCode).toBe(200);
  return res.body;
}

/** 取出某一行指標的數值；不存在回 0 */
function value(body: string, series: string): number {
  const line = body.split('\n').find((l) => l.startsWith(series + ' '));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-obs', 'Org Obs', 'obs')`, [ORG]);
  await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, 'padmin@obs.test', 'P'), ($2, 'learner@obs.test', 'L')`, [PADMIN, LEARNER]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'
     UNION ALL SELECT $2::uuid, id, 'self'::scope_type, $2::uuid, $3::uuid FROM roles WHERE code = 'learner'`,
    [PADMIN, LEARNER, ORG],
  );
  // 維護期剩 10 天的永久授權 → iac_license_days_remaining{kind="maintenance"}
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-obs', 'c', 'enterprise', 'perpetual', now(), now() + interval '10 days 1 hour', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  // 佇列：ingest 兩筆可執行（最舊的已等 2 分鐘）、一筆排程在未來；DLQ 一筆
  await admin.query(
    `INSERT INTO job_queue (job_type, queue, payload, run_after) VALUES
       ('document.parse', 'ingest', '{}', now() - interval '2 minutes'),
       ('document.parse', 'ingest', '{}', now() - interval '10 seconds'),
       ('certificate.render', 'output', '{}', now() + interval '1 hour')`,
  );
  await admin.query(
    `INSERT INTO failed_jobs (original_job_id, job_type, queue, payload, attempts, error_detail)
     VALUES (gen_random_uuid(), 'document.parse', 'ingest', '{}', 5, 'boom')`,
  );

  tokens.padmin = await session(PADMIN);
  tokens.learner = await session(LEARNER);

  const h = container.getHost();
  const p = container.getPort();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, ProbeModule] })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://app_api:${PW.api_pw}@${h}:${p}/iac`,
        DATABASE_URL_COACH: `postgres://app_coach:${PW.coach_pw}@${h}:${p}/iac`,
        SESSION_SECRET: 'obs-e2e-secret-obs-e2e-secret-obs-e2e',
        LICENSE_FINGERPRINT_OVERRIDE: FINGERPRINT,
      }),
    )
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('AsyncLocalStorage request context', () => {
  it('survives awaits inside the handler and sees the authenticated user', async () => {
    const res = await get('/api/__probe/context', tokens.learner, { 'x-request-id': 'obs-corr-0001' });
    expect(res.json()).toEqual({ correlationId: 'obs-corr-0001', userId: LEARNER });
  });

  it('concurrent requests do not leak context into each other', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `obs-par-${String(i).padStart(4, '0')}`);
    const results = await Promise.all(ids.map((id, i) => get('/api/__probe/context', i % 2 ? tokens.learner : tokens.padmin, { 'x-request-id': id })));
    results.forEach((r, i) => expect(r.json()).toEqual({ correlationId: ids[i], userId: i % 2 ? LEARNER : PADMIN }));
  });
});

describe('GET /api/system/metrics', () => {
  it('requires platform.health.read', async () => {
    expect((await get('/api/system/metrics')).statusCode).toBe(401);
    const learner = await get('/api/system/metrics', tokens.learner);
    expect(learner.statusCode).toBe(403);
    expect(learner.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('serves Prometheus text format, not cached', async () => {
    const res = await get('/api/system/metrics', tokens.padmin);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('# TYPE iac_http_requests_total counter');
  });

  it('counts requests by route template (not raw URL) and records latency', async () => {
    await get('/api/me', tokens.learner);
    // 學員在 ORG 有授權（self）但缺 org.read → 403（ADR-019 的 404 只用於「在該組織完全沒有授權」），仍以樣板計數
    await get(`/api/organizations/${ORG}`, tokens.learner);
    await get('/api/definitely-not-a-route?x=1');
    const body = await scrape();
    expect(value(body, 'iac_http_requests_total{route="/api/me",method="GET",status="200"}')).toBeGreaterThanOrEqual(1);
    expect(body).toContain('iac_http_requests_total{route="/api/organizations/:id",method="GET",status="403"}');
    expect(body).toContain('route="unmatched"');
    expect(body).not.toContain(ORG);
    expect(body).not.toContain('definitely-not-a-route');
    expect(value(body, 'iac_http_request_duration_seconds_count{route="/api/me",method="GET"}')).toBeGreaterThanOrEqual(1);
  });

  it('login failures and rate-limit rejections', async () => {
    const before = await scrape();
    const attempt = () =>
      app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.8.0.1', payload: { email: 'nobody@obs.test', password: 'wrong-password' } });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt()).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]); // 帳號限額 5/分
    const after = await scrape();
    expect(value(after, 'iac_login_failures_total') - value(before, 'iac_login_failures_total')).toBe(5);
    expect(value(after, 'iac_rate_limit_hits_total{endpoint_group="login"}') - value(before, 'iac_rate_limit_hits_total{endpoint_group="login"}')).toBe(1);
  });

  it('job queue depth, oldest runnable pending age and dead letters are read from the database', async () => {
    const body = await scrape();
    expect(value(body, 'iac_job_queue_depth{queue="ingest",job_type="document.parse"}')).toBe(2);
    expect(value(body, 'iac_job_queue_depth{queue="output",job_type="certificate.render"}')).toBe(1);
    expect(value(body, 'iac_job_oldest_pending_seconds{queue="ingest"}')).toBeGreaterThanOrEqual(115);
    expect(body).not.toContain('iac_job_oldest_pending_seconds{queue="output"}'); // 尚未到執行時間
    expect(value(body, 'iac_job_dead_total{job_type="document.parse"}')).toBe(1);
  });

  it('license days remaining', async () => {
    const body = await scrape();
    expect(value(body, 'iac_license_days_remaining{kind="maintenance"}')).toBe(10);
    expect(body).not.toContain('iac_license_days_remaining{kind="expiry"}'); // 永久授權沒有到期日
  });
});

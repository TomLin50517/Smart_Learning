/**
 * 平台設定與佇列狀態端到端測試（SA UC-PLT-006、SD §8.11）。
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { LicenseService } from '../../apps/api/src/modules/license/application/license.service.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'settings-e2e-secret-settings-e2e-secret';
const FINGERPRINT = 'sha256:e2e-settings';
const ORG = 'efefefef-0000-0000-0000-00000000000a';
const PADMIN = 'fefefefe-0000-0000-0000-000000000001';
const ADMIN = 'fefefefe-0000-0000-0000-00000000000a';

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
let licenseRowId = '';
const s = {} as Record<'padmin' | 'admin', { token: string; csrf: string }>;

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}

const call = (method: 'GET' | 'PUT', url: string, who: keyof typeof s, payload?: object, csrf = true) =>
  app.inject({
    method,
    url,
    ...(payload && { payload }),
    headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, ...(csrf && { 'x-csrf-token': s[who].csrf }) },
  });

const setting = (list: { key: string }[], key: string) => list.find((x) => x.key === key) as Record<string, unknown>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-s', 'Org S', 's')`, [ORG]);
  await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, 'padmin@s.test', '平台管理員'), ($2, 'admin@s.test', 'Org Admin')`, [PADMIN, ADMIN]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'
     UNION ALL SELECT $2::uuid, id, 'organization'::scope_type, $3::uuid, $3::uuid FROM roles WHERE code = 'org_admin'`,
    [PADMIN, ADMIN, ORG],
  );
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-s', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  licenseRowId = lic.rows[0]!.id;
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [licenseRowId, FINGERPRINT]);

  await admin.query(
    `INSERT INTO job_queue (job_type, queue, payload, status, run_after, updated_at, lock_expires_at) VALUES
       ('document.parse', 'ingest', '{}', 'pending', now() - interval '3 minutes', NULL, NULL),
       ('document.parse', 'ingest', '{}', 'pending', now() + interval '1 hour', NULL, NULL),
       ('document.parse', 'ingest', '{}', 'running', now() - interval '1 minute', now(), now() - interval '1 minute'),
       ('document.parse', 'ingest', '{}', 'succeeded', now() - interval '2 hours', now() - interval '1 hour', NULL),
       ('document.parse', 'ingest', '{}', 'succeeded', now() - interval '3 days', now() - interval '2 days', NULL)`,
  );
  await admin.query(
    `INSERT INTO failed_jobs (original_job_id, job_type, queue, payload, attempts, error_detail, correlation_id)
     VALUES (gen_random_uuid(), 'certificate.render', 'output', '{}', 5, repeat('x', 800), 'corr-dead-1')`,
  );

  s.padmin = await session(PADMIN);
  s.admin = await session(ADMIN);

  const h = container.getHost();
  const p = container.getPort();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://app_api:${PW.api_pw}@${h}:${p}/iac`,
        DATABASE_URL_COACH: `postgres://app_coach:${PW.coach_pw}@${h}:${p}/iac`,
        SESSION_SECRET: SECRET,
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

describe('GET/PUT /api/platform/settings (UC-PLT-006)', () => {
  it('lists every catalogued key with its default before anything is set', async () => {
    const res = await call('GET', '/api/platform/settings', 'padmin');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { key: 'upload.max_size', value: 536870912, default: 536870912, isDefault: true, updatedAt: null, updatedBy: null },
      { key: 'derived.min_threshold', value: 5, default: 5, isDefault: true, updatedAt: null, updatedBy: null },
    ]);
  });

  it('org admins cannot read platform settings', async () => {
    expect((await call('GET', '/api/platform/settings', 'admin')).statusCode).toBe(403);
  });

  it('partial update stores the value and audits only the changed key', async () => {
    const res = await call('PUT', '/api/platform/settings', 'padmin', { 'derived.min_threshold': 8 });
    expect(res.statusCode).toBe(200);
    expect(setting(res.json(), 'derived.min_threshold')).toMatchObject({ value: 8, isDefault: false, updatedBy: { id: PADMIN, displayName: '平台管理員' } });
    expect(setting(res.json(), 'upload.max_size')).toMatchObject({ isDefault: true });

    const a = await admin.query(`SELECT actor_user_id, before_state, after_state FROM audit_logs WHERE action = 'system.settings.updated' ORDER BY occurred_at DESC LIMIT 1`);
    expect(a.rows[0]).toEqual({ actor_user_id: PADMIN, before_state: { 'derived.min_threshold': 5 }, after_state: { 'derived.min_threshold': 8 } });
  });

  it('null resets to the default by deleting the row', async () => {
    const res = await call('PUT', '/api/platform/settings', 'padmin', { 'derived.min_threshold': null });
    expect(setting(res.json(), 'derived.min_threshold')).toMatchObject({ value: 5, isDefault: true });
    const rows = await admin.query(`SELECT 1 FROM system_settings WHERE scope_type = 'platform' AND key = 'derived.min_threshold'`);
    expect(rows.rowCount).toBe(0);
  });

  it.each([
    [{ 'no.such.key': 1 }, 'no.such.key'],
    [{ 'derived.min_threshold': 1 }, 'derived.min_threshold'],
    [{ 'upload.max_size': 12.5 }, 'upload.max_size'],
    [{}, ''],
  ])('rejects %j', async (body, field) => {
    const res = await call('PUT', '/api/platform/settings', 'padmin', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  it('requires the CSRF token', async () => {
    const res = await call('PUT', '/api/platform/settings', 'padmin', { 'derived.min_threshold': 9 }, false);
    expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('a frozen license blocks changes but not reading (configurationWriteAllowed)', async () => {
    await admin.query(`UPDATE licenses SET maintenance_until = now() - interval '1 day' WHERE id = $1`, [licenseRowId]);
    app.get(LicenseService).invalidate();
    try {
      const put = await call('PUT', '/api/platform/settings', 'padmin', { 'derived.min_threshold': 9 });
      expect(put.statusCode).toBe(403);
      expect(put.json().error.code).toBe('LICENSE_CONFIG_FROZEN');
      expect((await call('GET', '/api/platform/settings', 'padmin')).statusCode).toBe(200);
    } finally {
      await admin.query(`UPDATE licenses SET maintenance_until = now() + interval '1 year' WHERE id = $1`, [licenseRowId]);
      app.get(LicenseService).invalidate();
    }
  });
});

describe('GET /api/system/jobs', () => {
  it('summarises queues, stale locks and dead letters', async () => {
    const res = await call('GET', '/api/system/jobs', 'padmin');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queues).toEqual([
      { queue: 'ingest', jobType: 'document.parse', pending: 2, running: 1, succeeded24h: 1, oldestPendingSeconds: expect.any(Number) },
    ]);
    expect(body.queues[0].oldestPendingSeconds).toBeGreaterThanOrEqual(175);
    expect(body.staleLocks).toBe(1);
    expect(body.deadLetters.total).toBe(1);
    expect(body.deadLetters.recent[0]).toMatchObject({ jobType: 'certificate.render', queue: 'output', attempts: 5, correlationId: 'corr-dead-1' });
    expect(body.deadLetters.recent[0].error).toHaveLength(501); // 500 字元 + 省略號
  });

  it('requires platform.health.read', async () => {
    expect((await call('GET', '/api/system/jobs', 'admin')).statusCode).toBe(403);
  });
});

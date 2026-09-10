/**
 * Guard 鏈端到端測試（INV-8、ADR-016、ADR-019、AC-LIC-005）。
 * 真實 PostgreSQL 18（testcontainers）+ 全部 migration + 以 app_api 角色連線的 NestJS app。
 */
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { Audit, RequirePermission } from '../../apps/api/src/common/decorators.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { LicenseService } from '../../apps/api/src/modules/license/application/license.service.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const FINGERPRINT = 'sha256:e2e-machine';
const ORG = '11111111-0000-0000-0000-00000000000a';
const ADMIN = 'aaaaaaaa-0000-0000-0000-00000000000a';
const LEARNER = 'aaaaaaaa-0000-0000-0000-00000000000b';

/** 只存在於測試的路由：驗證「預設拒絕」與 AuditInterceptor */
@Controller('api/__probe')
class ProbeController {
  @Get('undeclared')
  undeclared() {
    return { leaked: true };
  }

  @Post('audited')
  @RequirePermission('platform.settings.write', { scope: 'platform' })
  @Audit({ action: 'system.settings.updated', resourceType: 'system_settings' })
  audited() {
    return { ok: true };
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const tokens = { admin: '', learner: '', revoked: '' };

async function session(userId: string, revoked = false): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await admin.query(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at, revoked_at)
     VALUES ($1, $2, $3, now() + interval '1 hour', $4)`,
    [userId, createHash('sha256').update(token).digest('hex'), ORG, revoked ? new Date() : null],
  );
  return token;
}

const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { ...headers, ...(token && { cookie: `iac_session=${token}` }) } });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('iac')
    .withUsername('postgres')
    .withPassword('devonly')
    .start();

  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-e2e', 'Org E2E', 'e2e')`, [ORG]);
  await admin.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, 'admin@e2e.test', 'Admin'), ($2, 'learner@e2e.test', 'Learner')`,
    [ADMIN, LEARNER],
  );
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'
     UNION ALL
     SELECT $2::uuid, id, 'self'::scope_type, $2::uuid, $3::uuid FROM roles WHERE code = 'learner'`,
    [ADMIN, LEARNER, ORG],
  );
  tokens.admin = await session(ADMIN);
  tokens.learner = await session(LEARNER);
  tokens.revoked = await session(LEARNER, true);

  const host = container.getHost();
  const port = container.getPort();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, ProbeModule] })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://app_api:${PW.api_pw}@${host}:${port}/iac`,
        DATABASE_URL_COACH: `postgres://app_coach:${PW.coach_pw}@${host}:${port}/iac`,
        SESSION_SECRET: 'e2e-session-secret-e2e-session-secret',
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

describe('system endpoints are public', () => {
  it('health → 200 with correlation id', async () => {
    const res = await get('/api/system/health');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('ready → 200, all 14 migrations present', async () => {
    const res = await get('/api/system/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, components: { database: 'ok', migrations: 14 } });
  });

  it('echoes a safe incoming X-Request-Id', async () => {
    const res = await get('/api/system/health', undefined, { 'x-request-id': 'e2e-correlation-001' });
    expect(res.headers['x-request-id']).toBe('e2e-correlation-001');
  });
});

describe('authentication (INV-8 step 1)', () => {
  it('no cookie → 401 envelope whose correlation_id matches the header', async () => {
    const res = await get('/api/me');
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.correlation_id).toBe(res.headers['x-request-id']);
  });

  it('unknown token → 401', async () => {
    expect((await get('/api/me', 'not-a-real-token')).statusCode).toBe(401);
  });

  it('revoked session → 401', async () => {
    expect((await get('/api/me', tokens.revoked)).statusCode).toBe(401);
  });
});

describe('/api/me', () => {
  it('learner sees own permissions and no platform permissions', async () => {
    const res = await get('/api/me', tokens.learner);
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.user.id).toBe(LEARNER);
    expect(me.activeOrganization?.id).toBe(ORG);
    expect(me.permissions).toContain('coach.interact_self');
    expect(me.permissions).not.toContain('platform.license.read');
    expect(me.licenseCapabilities.state).toBe('unlicensed');
    expect(me.licenseCapabilities).not.toHaveProperty('reason');
  });
});

describe('permission guard (INV-8 step 2)', () => {
  it('learner → platform endpoint → 403 PERMISSION_DENIED', async () => {
    const res = await get('/api/platform/license/capabilities', tokens.learner);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('platform admin → 200', async () => {
    const res = await get('/api/platform/license/capabilities', tokens.admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('unlicensed');
  });

  it('route without any permission declaration is denied by default', async () => {
    const res = await get('/api/__probe/undeclared', tokens.admin);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('leaked');
  });
});

describe('license capability (reads from DB, computed by @iac/domain)', () => {
  it('perpetual license with expired maintenance → frozen', async () => {
    const lic = await admin.query<{ id: string }>(
      `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until,
                             hardware_binding, features, limits, raw_payload)
       VALUES ('lic-e2e', 'cust-e2e', 'enterprise', 'perpetual', now() - interval '2 years', now() - interval '1 day',
               $1, '{"ai_coach": true}', '{"max_organizations": 10}', 'jws-placeholder')
       RETURNING id`,
      [FINGERPRINT],
    );
    await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [
      lic.rows[0]!.id,
      FINGERPRINT,
    ]);
    app.get(LicenseService).invalidate();

    const res = await get('/api/platform/license/capabilities', tokens.admin);
    expect(res.json()).toMatchObject({
      state: 'frozen',
      runtimeAllowed: true,
      configurationWriteAllowed: false,
      aiCoachAllowed: true,
      maxOrganizations: 10,
    });
  });
});

describe('audit interceptor (INV-8 step 5)', () => {
  it('successful audited route writes an audit_logs row with actor and correlation id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/__probe/audited',
      headers: { cookie: `iac_session=${tokens.admin}`, 'x-request-id': 'e2e-audit-0001' },
    });
    expect(res.statusCode).toBe(201);
    const row = await admin.query(`SELECT actor_user_id, action, outcome FROM audit_logs WHERE correlation_id = 'e2e-audit-0001'`);
    expect(row.rows).toEqual([{ actor_user_id: ADMIN, action: 'system.settings.updated', outcome: 'success' }]);
  });

  it('denied request writes no success audit row', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/__probe/audited',
      headers: { cookie: `iac_session=${tokens.learner}`, 'x-request-id': 'e2e-audit-0002' },
    });
    const row = await admin.query(`SELECT 1 FROM audit_logs WHERE correlation_id = 'e2e-audit-0002'`);
    expect(row.rowCount).toBe(0);
  });
});

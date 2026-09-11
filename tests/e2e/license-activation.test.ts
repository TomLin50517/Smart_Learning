/**
 * 授權啟用端到端測試（SA SEQ-08/09、AC-LIC-004/006、ARCH §18）。
 * 測試用供應方金鑰於執行時產生；線上啟用服務以替身取代。
 */
import 'reflect-metadata';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { DomainError } from '../../apps/api/src/common/domain-error.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { LicenseService } from '../../apps/api/src/modules/license/application/license.service.js';
import { ACTIVATION_CLIENT, type ActivationClient } from '../../apps/api/src/modules/license/infrastructure/activation-client.js';
import { decodeChallenge, signLicense } from '../../tools/license-lib.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'license-e2e-secret-license-e2e-secret';
const FINGERPRINT = 'sha256:e2e-license-host';
const ORG = '33333333-0000-0000-0000-00000000000a';
const ADMIN = 'cccccccc-0000-0000-0000-00000000000a';
const LEARNER = 'cccccccc-0000-0000-0000-00000000000b';

const vendor = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');

const basePayload = {
  customer_id: 'cust-e2e',
  edition: 'enterprise',
  features: { ai_coach: true },
  limits: { max_organizations: 5 },
};

const fakeActivation: ActivationClient = {
  async activate({ activationCode, fingerprint }) {
    if (activationCode !== 'GOOD-CODE-123') throw new DomainError('LICENSE_ACTIVATION_REJECTED');
    return signLicense(
      {
        ...basePayload,
        license_id: 'lic-online-1',
        license_type: 'subscription',
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        maintenance_until: null,
        hardware_binding: fingerprint,
      },
      vendor.privateKey,
    );
  },
};

interface S {
  token: string;
  csrf: string;
}
let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<'admin' | 'learner', S>;

async function session(userId: string): Promise<S> {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}

const get = (url: string, t: S) => app.inject({ method: 'GET', url, headers: { cookie: `iac_session=${t.token}` } });
const post = (url: string, t: S, payload?: unknown, withCsrf = true) =>
  app.inject({
    method: 'POST',
    url,
    ...(payload !== undefined && { payload: payload as object }),
    headers: { cookie: `iac_session=${t.token}; iac_csrf=${t.csrf}`, ...(withCsrf && { 'x-csrf-token': t.csrf }) },
  });

const offlineLicense = (nonce: string, overrides: Record<string, unknown> = {}, key = vendor.privateKey) =>
  signLicense(
    {
      ...basePayload,
      license_id: 'lic-offline-1',
      license_type: 'perpetual',
      issued_at: new Date().toISOString(),
      expires_at: null,
      maintenance_until: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      hardware_binding: FINGERPRINT,
      nonce,
      ...overrides,
    },
    key,
  );

async function newChallenge() {
  const res = await post('/api/platform/license/challenge', s.admin);
  expect(res.statusCode).toBe(200);
  return decodeChallenge(res.json().challenge);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-lic', 'Org Lic', 'lic')`, [ORG]);
  await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, 'padmin@e2e.test', 'PAdmin'), ($2, 'l@e2e.test', 'L')`, [ADMIN, LEARNER]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'
     UNION ALL
     SELECT $2::uuid, id, 'self'::scope_type, $2::uuid, $3::uuid FROM roles WHERE code = 'learner'`,
    [ADMIN, LEARNER, ORG],
  );
  s.admin = await session(ADMIN);
  s.learner = await session(LEARNER);

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
        LICENSE_PUBLIC_KEY_OVERRIDE: vendor.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        LICENSE_FINGERPRINT_OVERRIDE: FINGERPRINT,
      }),
    )
    .overrideProvider(ACTIVATION_CLIENT)
    .useValue(fakeActivation)
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

describe('before activation', () => {
  it('GET /platform/license → no license, current fingerprint, unlicensed', async () => {
    const res = await get('/api/platform/license', s.admin);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      license: null,
      activation: null,
      fingerprint: { current: FINGERPRINT },
      capabilities: { state: 'unlicensed' },
    });
  });
});

describe('offline activation (SEQ-09)', () => {
  it('challenge → vendor signs → activate → active; audited without raw license content', async () => {
    const c = await newChallenge();
    expect(c.fingerprint).toBe(FINGERPRINT);

    const res = await post('/api/platform/license/activate', s.admin, { licenseFile: offlineLicense(c.nonce) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'active', configurationWriteAllowed: true, maxOrganizations: 5 });

    const a = await admin.query<{ metadata: Record<string, unknown>; resource_id: string }>(
      `SELECT metadata, resource_id FROM audit_logs WHERE action = 'license.activated' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(a.rows[0]!.metadata).toEqual({ license_id: 'lic-offline-1', license_type: 'perpetual', mode: 'offline' });
    const lic = await admin.query<{ id: string }>(`SELECT id FROM licenses WHERE license_id = 'lic-offline-1'`);
    expect(a.rows[0]!.resource_id).toBe(lic.rows[0]!.id);

    const used = await admin.query(`SELECT 1 FROM license_challenges WHERE nonce = $1 AND used_at IS NOT NULL`, [c.nonce]);
    expect(used.rowCount).toBe(1);
  });

  it('the same license file cannot be replayed (challenge is single-use)', async () => {
    const c = await newChallenge();
    const file = offlineLicense(c.nonce);
    expect((await post('/api/platform/license/activate', s.admin, { licenseFile: file })).statusCode).toBe(200);
    const again = await post('/api/platform/license/activate', s.admin, { licenseFile: file });
    expect(again.statusCode).toBe(403);
    expect(again.json().error.code).toBe('LICENSE_CHALLENGE_INVALID');
  });

  it('a license bound to other hardware → LICENSE_HARDWARE_MISMATCH', async () => {
    const c = await newChallenge();
    const res = await post('/api/platform/license/activate', s.admin, {
      licenseFile: offlineLicense(c.nonce, { hardware_binding: 'sha256:someone-else' }),
    });
    expect(res.json().error.code).toBe('LICENSE_HARDWARE_MISMATCH');
  });

  it('a license signed by anyone but the vendor → LICENSE_SIGNATURE_INVALID', async () => {
    const c = await newChallenge();
    const res = await post('/api/platform/license/activate', s.admin, { licenseFile: offlineLicense(c.nonce, {}, attacker.privateKey) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('LICENSE_SIGNATURE_INVALID');
  });

  it('re-installing an older issue of the same license_id is refused (rollback)', async () => {
    const c = await newChallenge();
    const older = offlineLicense(c.nonce, { issued_at: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    const res = await post('/api/platform/license/activate', s.admin, { licenseFile: older });
    expect(res.json().error.code).toBe('LICENSE_SIGNATURE_INVALID');
    expect(res.json().error.message).toMatch(/older than the installed license/);
  });
});

describe('online activation (SEQ-08)', () => {
  it('valid activation code → active subscription; only one active activation remains', async () => {
    const res = await post('/api/platform/license/activate', s.admin, { activationCode: 'GOOD-CODE-123' });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('active');

    const active = await admin.query(`SELECT 1 FROM license_activations WHERE status = 'active'`);
    expect(active.rowCount).toBe(1);

    const info = (await get('/api/platform/license', s.admin)).json();
    expect(info.license).toMatchObject({ licenseId: 'lic-online-1', licenseType: 'subscription' });
    expect(info.activation).toMatchObject({ mode: 'online', clockRollbackDetected: false });
    expect(JSON.stringify(info)).not.toContain('raw_payload');
  });

  it('vendor rejects the code → 403 LICENSE_ACTIVATION_REJECTED', async () => {
    const res = await post('/api/platform/license/activate', s.admin, { activationCode: 'BAD-CODE' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('LICENSE_ACTIVATION_REJECTED');
  });

  it('body must contain exactly one of licenseFile / activationCode', async () => {
    const res = await post('/api/platform/license/activate', s.admin, { licenseFile: 'x'.repeat(30), activationCode: 'GOOD-CODE-123' });
    expect(res.statusCode).toBe(400);
  });
});

describe('access control', () => {
  it('learner cannot activate → 403 PERMISSION_DENIED', async () => {
    const res = await post('/api/platform/license/activate', s.learner, { activationCode: 'GOOD-CODE-123' });
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('missing CSRF header → 403 CSRF_TOKEN_INVALID', async () => {
    const res = await post('/api/platform/license/challenge', s.admin, undefined, false);
    expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
  });
});

describe('tamper detection (ARCH §18.5)', () => {
  it('system clock earlier than last_seen_at → clockRollbackDetected (recorded, not enforced)', async () => {
    await admin.query(`UPDATE license_activations SET last_seen_at = now() + interval '1 day' WHERE status = 'active'`);
    app.get(LicenseService).invalidate();
    const info = (await get('/api/platform/license', s.admin)).json();
    expect(info.activation.clockRollbackDetected).toBe(true);
    expect(info.capabilities.state).toBe('active');
  });
});

/**
 * 組織品牌（Phase 2-6，SA v1.22、SD §6.16）：平台名稱、預設配色與自訂主色（對比度）、Logo／小圖示（格式與安全）、
 * 公開端點（組織登入畫面）、權限（組織管理員、平台管理員）。
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
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'brand-e2e-secret-brand-e2e-secret-br';
const FINGERPRINT = 'sha256:e2e-brand';
const ORG = 'a1a1a1a1-0000-0000-0000-00000000000a';
const U = {
  platform: 'a2a2a2a2-0000-0000-0000-0000000000a0',
  admin: 'a2a2a2a2-0000-0000-0000-00000000000a',
  learner: 'a2a2a2a2-0000-0000-0000-0000000000d1',
};
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;

async function session(userId: string, org: string | null) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), org],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: keyof typeof U, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf } });
const branding = (payload: object, who: keyof typeof U = 'admin') => call('PATCH', `/api/organizations/${ORG}/branding`, who, payload);
const pub = () => app.inject({ method: 'GET', url: '/api/branding/org-brand' });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-brand', 'ABC 學苑', 'br')`, [ORG]);
  for (const [k, id] of Object.entries(U)) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [id, `${k}@br.test`, k]);
  await admin.query(`INSERT INTO user_org_roles (user_id, role_id, scope_type) SELECT $1::uuid, id, 'platform'::scope_type FROM roles WHERE code = 'platform_admin'`, [U.platform]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
    [U.learner, ORG],
  );
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-br', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  s.platform = await session(U.platform, null);
  s.admin = await session(U.admin, ORG);
  s.learner = await session(U.learner, ORG);

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

describe('names and colors', () => {
  it('starts with the platform defaults, visible on the public login endpoint', async () => {
    const r = await pub();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      organizationId: ORG,
      organizationCode: 'org-brand',
      organizationName: 'ABC 學苑',
      theme: 'academy_blue',
      colors: { light: '#1d4ed8', dark: '#7c9bff' },
      platformName: '互動學習平台',
      logoUrl: null,
      iconUrl: null,
    });
  });

  it('org admins pick a preset and a platform name; the login page and /api/me follow', async () => {
    const r = await branding({ theme: 'teal', platformName: 'ABC 數位學苑' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ theme: 'teal', platformName: 'ABC 數位學苑', settings: { theme: 'teal', customColor: null, platformName: 'ABC 數位學苑' } });
    expect((await pub()).json()).toMatchObject({ theme: 'teal', colors: { light: '#0f766e' }, platformName: 'ABC 數位學苑' });
    const me = (await call('GET', '/api/me', 'admin')).json();
    expect(me.activeOrganization).toMatchObject({ code: 'org-brand', branding: { theme: 'teal', platformName: 'ABC 數位學苑' } });
  });

  it('a custom color must keep white text readable; picking a preset clears it', async () => {
    const pale = await branding({ customColor: '#fde047' });
    expect(pale.statusCode).toBe(400);
    expect(pale.json().error.details[0]).toMatchObject({ field: 'customColor', issue: 'color_contrast_too_low' });
    const ok = (await branding({ customColor: '#7C2D12' })).json();
    expect(ok).toMatchObject({ theme: 'custom', colors: { light: '#7c2d12' } });
    expect(ok.colors.dark).not.toBe('#7c2d12');
    expect((await branding({ theme: 'wine' })).json()).toMatchObject({ theme: 'wine', settings: { customColor: null } });
    // 平台名稱清空＝回到預設
    expect((await branding({ platformName: '' })).json().platformName).toBe('互動學習平台');
  });

  it('learners cannot change branding; platform admins can (migration 0020)', async () => {
    expect((await branding({ theme: 'forest' }, 'learner')).statusCode).toBe(403);
    expect((await branding({ theme: 'forest' }, 'platform')).json().theme).toBe('forest');
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'org.branding.updated'`)).rows[0].n).toBe(5);
  });
});

describe('logo and icon', () => {
  it('stores a PNG and serves it safely with a cache-busting URL', async () => {
    const r = await call('PUT', `/api/organizations/${ORG}/branding/logo`, 'admin', { dataBase64: PNG_1PX });
    expect(r.statusCode).toBe(200);
    const url: string = r.json().logoUrl;
    expect(url).toMatch(/^\/api\/branding\/org-brand\/logo\?v=[0-9a-f]{12}$/);
    const img = await app.inject({ method: 'GET', url });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toBe("default-src 'none'");
    expect(img.headers['cache-control']).toContain('max-age=86400');
    expect(img.rawPayload.equals(Buffer.from(PNG_1PX, 'base64'))).toBe(true);
    expect((await pub()).json().logoUrl).toBe(url);
  });

  it('rejects SVG and anything that is not really an image, and files over 512 KB', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect((await call('PUT', `/api/organizations/${ORG}/branding/icon`, 'admin', { dataBase64: svg })).json().error.details[0]).toMatchObject({ issue: 'unsupported_image_type' });
    const big = Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.alloc(524_288)]).toString('base64');
    expect((await call('PUT', `/api/organizations/${ORG}/branding/icon`, 'admin', { dataBase64: big })).json().error.details[0]).toMatchObject({ issue: 'image_too_large' });
    expect((await call('PUT', `/api/organizations/${ORG}/branding/banner`, 'admin', { dataBase64: PNG_1PX })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/branding/org-brand/icon' })).statusCode).toBe(404);
  });

  it('removing the logo falls back to the platform icon', async () => {
    expect((await call('DELETE', `/api/organizations/${ORG}/branding/logo`, 'admin')).json().logoUrl).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/branding/org-brand/logo' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/organizations/${ORG}/branding/logo`, 'admin')).statusCode).toBe(404);
  });
});

describe('public endpoint', () => {
  it('unknown, malformed or disabled organizations are 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/branding/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/branding/%3Cscript%3E' })).statusCode).toBe(404);
    await admin.query(`UPDATE organizations SET status = 'disabled' WHERE id = $1`, [ORG]);
    expect((await pub()).statusCode).toBe(404);
    await admin.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ORG]);
  });

  it('renaming the organization no longer touches branding', async () => {
    expect((await call('PATCH', `/api/organizations/${ORG}`, 'admin', { branding: { primaryColor: '#123456' } })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/organizations/${ORG}`, 'admin', { name: 'ABC 學苑（新）' })).json().name).toBe('ABC 學苑（新）');
  });
});

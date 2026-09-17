/**
 * 首頁 CMS（SA UC-CMS-001～005、SD §7.5、§6.32）：草稿 → 發布 → 公開頁面 → 回滾，
 * 平台首頁與組織首頁各自獨立，以及 ARCH §16.1 的注入防護（端到端）。
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
const SECRET = 'cms-e2e-secret-cms-e2e-secret-cms-e2e';
const FINGERPRINT = 'sha256:e2e-cms';
const ORG = 'ce000000-0000-0000-0000-00000000000a';
const ORG_CODE = 'org-cms';
const U = {
  platform: 'cf000000-0000-0000-0000-0000000000a1',
  admin: 'cf000000-0000-0000-0000-0000000000a2',
  learner: 'cf000000-0000-0000-0000-0000000000a3',
};
type Who = keyof typeof U;

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<Who, { token: string; csrf: string }>;

async function session(userId: string, org: string | null) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), org],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who: Who, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf } });
const publicHome = (org?: string) => app.inject({ method: 'GET', url: org ? `/public/cms/home?org=${org}` : '/public/cms/home' });

const HERO = { type: 'hero', title: '歡迎來到示範學苑', subtitle: '線上課程與 AI 教練' };
const TEXT = { type: 'richtext', markdown: '# 關於我們\n\n我們提供烘焙課程。' };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, $2, '示範學苑', 'cms')`, [ORG, ORG_CODE]);
  for (const k of Object.keys(U) as Who[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@cms.test`, k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'`,
    [U.platform],
  );
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
     VALUES ('lic-cms', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
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

describe('draft and publish (UC-CMS-001～003)', () => {
  it('starts empty and keeps the draft out of the public page', async () => {
    expect((await call('GET', '/api/cms/pages/home', 'admin')).json()).toMatchObject({ scope: 'organization', draftBlocks: [], publishedBlocks: null, hasUnpublishedChanges: false });

    const saved = await call('PATCH', '/api/cms/pages/home/draft', 'admin', { blocks: [HERO, TEXT] });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ draftBlocks: [HERO, TEXT], publishedBlocks: null, hasUnpublishedChanges: true });

    // 尚未發布：公開頁面必須看不到草稿
    expect((await publicHome(ORG_CODE)).json()).toMatchObject({ blocks: [], publishedAt: null });
  });

  it('publishes the draft and the public page then shows it', async () => {
    const r = await call('POST', '/api/cms/pages/home/publish', 'admin');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ publishedRevisionNo: 1, hasUnpublishedChanges: false });

    const home = (await publicHome(ORG_CODE)).json();
    expect(home).toMatchObject({ organizationCode: ORG_CODE, organizationName: '示範學苑' });
    expect(home.blocks).toEqual([HERO, TEXT]);
    expect(home.publishedAt).toBeTruthy();

    expect((await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'cms.published'`)).rowCount).toBe(1);
  });

  it('keeps publishing new revisions; the public page follows the latest', async () => {
    await call('PATCH', '/api/cms/pages/home/draft', 'admin', { blocks: [{ ...HERO, title: '第二版標題' }] });
    // 已發布的內容在發布前不變
    expect((await publicHome(ORG_CODE)).json().blocks).toEqual([HERO, TEXT]);

    await call('POST', '/api/cms/pages/home/publish', 'admin');
    const home = (await publicHome(ORG_CODE)).json();
    expect(home.blocks).toEqual([{ ...HERO, title: '第二版標題' }]);
    expect((await call('GET', '/api/cms/pages/home', 'admin')).json()).toMatchObject({ publishedRevisionNo: 2 });
  });

  it('rolls back to an earlier revision as a new revision (UC-CMS-004)', async () => {
    const r = await call('POST', '/api/cms/pages/home/rollback', 'admin', { revisionNo: 1 });
    expect(r.statusCode).toBe(201);
    // 回滾本身也是一次發布——歷史保持完整，不會改寫舊 revision
    expect(r.json()).toMatchObject({ publishedRevisionNo: 3 });
    expect((await publicHome(ORG_CODE)).json().blocks).toEqual([HERO, TEXT]);
    expect((await call('POST', '/api/cms/pages/home/rollback', 'admin', { revisionNo: 99 })).statusCode).toBe(404);
  });
});

describe('injection guards (ARCH §16.1)', () => {
  it('rejects raw html, unknown block types and non-http links', async () => {
    const bad = [
      [{ type: 'richtext', markdown: 'x', html: '<script>alert(1)</script>' }],
      [{ type: 'script', src: 'https://evil.example/x.js' }],
      [{ type: 'footer', links: [{ label: 'x', href: 'javascript:alert(1)' }] }],
      [{ type: 'image', assetId: 'https://evil.example/pixel.gif', alt: 'x' }],
    ];
    for (const blocks of bad) {
      const r = await call('PATCH', '/api/cms/pages/home/draft', 'admin', { blocks });
      expect(r.json().error.code, JSON.stringify(blocks)).toBe('VALIDATION_FAILED');
    }
    // 被拒絕的內容沒有寫進草稿
    expect((await call('GET', '/api/cms/pages/home', 'admin')).json().draftBlocks).toEqual([HERO, TEXT]);
  });
});

describe('permissions', () => {
  it('learners cannot read or edit the CMS', async () => {
    expect((await call('GET', '/api/cms/pages/home', 'learner')).statusCode).toBe(403);
    expect((await call('PATCH', '/api/cms/pages/home/draft', 'learner', { blocks: [] })).statusCode).toBe(403);
    expect((await call('POST', '/api/cms/pages/home/publish', 'learner')).statusCode).toBe(403);
  });

  it('organization admins cannot touch the platform home page', async () => {
    // 平台首頁需要 platform scope——組織管理員即使有 cms.* 也不該碰得到
    expect((await call('GET', '/api/platform/cms/pages/home', 'admin')).statusCode).toBe(403);
    expect((await call('PATCH', '/api/platform/cms/pages/home/draft', 'admin', { blocks: [] })).statusCode).toBe(403);
  });
});

describe('platform home page', () => {
  it('is edited separately from organization pages and served at the root', async () => {
    await call('PATCH', '/api/platform/cms/pages/home/draft', 'platform', { blocks: [{ type: 'hero', title: '互動式 AI 教練平台' }] });
    await call('POST', '/api/platform/cms/pages/home/publish', 'platform');

    const platformHome = (await publicHome()).json();
    expect(platformHome).toMatchObject({ organizationCode: null, organizationName: null });
    expect(platformHome.blocks).toEqual([{ type: 'hero', title: '互動式 AI 教練平台' }]);

    // 組織首頁不受影響
    expect((await publicHome(ORG_CODE)).json().blocks).toEqual([HERO, TEXT]);
  });

  it('returns 404 for an unknown organization code', async () => {
    expect((await publicHome('no-such-org')).statusCode).toBe(404);
  });
});

describe('public assets', () => {
  it('does not expose arbitrary media — only what a published page references', async () => {
    // 素材庫不是公開的：沒有被已發布首頁引用的 id 一律 404
    const r = await app.inject({ method: 'GET', url: '/public/cms/assets/99999999-8888-7777-6666-555555555555' });
    expect(r.statusCode).toBe(404);
  });

  it('rejects a malformed asset id', async () => {
    // path 參數格式錯誤是 400，不是 422（422 用於通過格式但內容不合規的請求本體）
    expect((await app.inject({ method: 'GET', url: '/public/cms/assets/not-a-uuid' })).statusCode).toBe(400);
  });
});

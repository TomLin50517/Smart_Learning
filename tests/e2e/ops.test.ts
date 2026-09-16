/**
 * 維運（SA UC-CRT-002、UC-PLT-008／010；SD §6.28）：證書 PDF 的產生與下載、備份排程與紀錄、系統狀態。
 * 物件儲存以記憶體實作取代（api 與 worker 共用同一個實例）；備份服務本身不在此測試（見 tools/backup.test.ts 的保留策略）。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { MemoryObjectStorage, OBJECT_STORAGE } from '../../apps/api/src/common/object-storage.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { CertificateGenerateHandler } from '../../apps/worker/src/handlers/certificate-generate.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'ops-e2e-secret-ops-e2e-secret-ops-e2e';
const FINGERPRINT = 'sha256:e2e-ops';
const BASE = 'https://learn.example.test';
const FONT = fileURLToPath(new URL('../../assets/fonts/NotoSansTC[wght].ttf', import.meta.url));
const ORG = 'ab000000-0000-0000-0000-00000000000a';
const COURSE = 'ab000000-0000-0000-0000-0000000000c0';
const VERSION = 'ab000000-0000-0000-0000-0000000000c1';
const ENROLLMENT = 'ab000000-0000-0000-0000-0000000000e1';
const U = {
  platform: 'ab000000-0000-0000-0000-0000000000a1',
  staff: 'ab000000-0000-0000-0000-0000000000a2',
  me: 'ab000000-0000-0000-0000-0000000000a3',
  other: 'ab000000-0000-0000-0000-0000000000a4',
};
type Who = keyof typeof U;

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let workerDb: pg.Pool;
let app: NestFastifyApplication;
const mem = new MemoryObjectStorage();
const s = {} as Record<Who, { token: string; csrf: string }>;
let certificateId = '';

async function session(userId: string, org: string | null) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), org],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const call = (method: 'GET' | 'POST', url: string, who: Who, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf } });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-ops', '維運測試學苑', 'ops')`, [ORG]);
  for (const k of Object.keys(U) as Who[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@ops.test`, k === 'me' ? '王小明' : k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'`,
    [U.platform],
  );
  for (const k of ['me', 'other'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  // 已完成的選課（證書的前提）——這個測試不重跑整個學習流程
  await admin.query(`INSERT INTO courses (id, organization_id, code, title) VALUES ($1, $2, 'OPS-1', '烘焙入門')`, [COURSE, ORG]);
  await admin.query(`INSERT INTO course_versions (id, course_id, organization_id, version_no, title, status, published_at) VALUES ($1, $2, $3, 1, 'v1', 'published', now())`, [
    VERSION,
    COURSE,
    ORG,
  ]);
  await admin.query(
    `INSERT INTO enrollments (id, organization_id, course_id, course_version_id, user_id, enroll_method, status, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'assign', 'completed', now())`,
    [ENROLLMENT, ORG, COURSE, VERSION, U.me],
  );
  // 課程人員用 course_admin：certificate.read_all 屬於 course_admin 與 auditor，instructor 沒有這個權限（migration 0012）
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'course'::scope_type, $2::uuid, $3::uuid FROM roles WHERE code = 'course_admin'`,
    [U.staff, COURSE, ORG],
  );
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-ops', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  s.platform = await session(U.platform, null);
  for (const k of ['staff', 'me', 'other'] as const) s[k] = await session(U[k], ORG);

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
    .overrideProvider(OBJECT_STORAGE)
    .useValue(mem)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  workerDb = new pg.Pool({ connectionString: `postgres://app_worker:${PW.worker_pw}@${h}:${p}/iac`, max: 2 });
});

afterAll(async () => {
  await app?.close();
  await workerDb?.end();
  await admin?.end();
  await container?.stop();
});

describe('certificate PDF (UC-CRT-002)', () => {
  it('the worker stores a PDF next to the certificate when it issues one', async () => {
    const handler = new CertificateGenerateHandler(workerDb, mem, { fontPath: FONT, baseUrl: BASE });
    await handler.handle({ id: randomUUID(), job_type: 'certificate.generate', queue: 'output', payload: { enrollmentId: ENROLLMENT }, attempts: 1, max_attempts: 5, organization_id: ORG, correlation_id: null });
    const cert = await admin.query<{ id: string; pdf_object_key: string; public_id: string }>(`SELECT id, pdf_object_key, public_id FROM certificates WHERE enrollment_id = $1`, [ENROLLMENT]);
    certificateId = cert.rows[0]!.id;
    expect(cert.rows[0]!.pdf_object_key).toBe(`ops/certificates/${ORG}/${certificateId}.pdf`);
    const stored = await mem.get(cert.rows[0]!.pdf_object_key);
    expect(stored.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(stored.length).toBeGreaterThan(2000);
  }, 60_000);

  it('the learner downloads their own PDF; other learners get 404', async () => {
    const r = await call('GET', `/api/me/certificates/${certificateId}/pdf`, 'me');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename="certificate-[0-9A-Z]+\.pdf"$/);
    expect(r.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((await call('GET', `/api/me/certificates/${certificateId}/pdf`, 'other')).statusCode).toBe(404);
  });

  it('course staff download it from the course; learners cannot use that route', async () => {
    expect((await call('GET', `/api/certificates/${certificateId}/pdf`, 'staff')).statusCode).toBe(200);
    expect((await call('GET', `/api/certificates/${certificateId}/pdf`, 'me')).statusCode).toBe(403);
  });
});

describe('backups (UC-PLT-008)', () => {
  it('a platform admin queues one backup at a time', async () => {
    const r = await call('POST', '/api/platform/backups', 'platform');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ kind: 'manual', status: 'requested', requestedByName: 'platform' });
    expect((await call('POST', '/api/platform/backups', 'platform')).json().error.details).toEqual([{ issue: 'backup_in_progress' }]);
    expect((await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'backup.executed'`)).rowCount).toBe(1);
    const list = (await call('GET', '/api/platform/backups', 'platform')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'requested', databaseBytes: null });
  });

  it('only the platform admin sees backups', async () => {
    expect((await call('GET', '/api/platform/backups', 'staff')).statusCode).toBe(403);
  });
});

describe('system status (UC-PLT-010)', () => {
  it('gives the platform admin one page of numbers and the things worth acting on', async () => {
    const r = await call('GET', '/api/system/status', 'platform');
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.jobs).toMatchObject({ pending: expect.any(Number), deadLetters: 0, staleLocks: 0 });
    expect(d.search).toMatchObject({ configured: false, pendingDocuments: 0, failedDocuments: 0 });
    expect(d.ai).toMatchObject({ requestsToday: 0, tokensToday: 0, fallbackRatio: null });
    expect(d.storage.databaseBytes).toBeGreaterThan(0);
    expect(d.license).toMatchObject({ state: 'active', activeLearners: expect.any(Number) });
    // 還沒有成功的備份 → 告警
    expect(d.backup).toMatchObject({ lastSucceededAt: null, lastStatus: 'requested', ageHours: null });
    expect(d.alerts.map((a: { key: string }) => a.key)).toContain('backup.never');
  });

  it('a successful backup clears the alert and shows up on the page', async () => {
    await admin.query(`UPDATE backup_runs SET status = 'succeeded', started_at = now(), finished_at = now(), database_bytes = 1024, object_files = 3, object_bytes = 2048, location = '/backups/db/x.dump'`);
    const d = (await call('GET', '/api/system/status', 'platform')).json();
    expect(d.backup).toMatchObject({ lastStatus: 'succeeded', ageHours: 0 });
    expect(d.alerts.map((a: { key: string }) => a.key)).not.toContain('backup.never');
    expect((await call('GET', '/api/platform/backups', 'platform')).json()[0]).toMatchObject({ status: 'succeeded', databaseBytes: 1024, objectFiles: 3 });
  });

  it('a failed backup is a critical alert', async () => {
    await admin.query(`UPDATE backup_runs SET status = 'failed', error = 'pg_dump exited with 1'`);
    const d = (await call('GET', '/api/system/status', 'platform')).json();
    expect(d.alerts.find((a: { key: string }) => a.key === 'backup.failed')).toMatchObject({ level: 'critical' });
  });

  it('is not open to course staff or learners', async () => {
    expect((await call('GET', '/api/system/status', 'staff')).statusCode).toBe(403);
    expect((await call('GET', '/api/system/status', 'me')).statusCode).toBe(403);
  });
});

/**
 * 稽核查詢與匯出端到端測試（SA UC-AUD-001/002、SD §12.4、ADR-032）。
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
const SECRET = 'audit-e2e-secret-audit-e2e-secret-audit';
const ORG_A = '88888888-0000-0000-0000-00000000000a';
const ORG_B = '88888888-0000-0000-0000-00000000000b';
const COURSE_A1 = '99999999-0000-0000-0000-0000000000a1';
const U = {
  padmin: 'abababab-0000-0000-0000-000000000001',
  adminA: 'abababab-0000-0000-0000-00000000000a',
  instr: 'abababab-0000-0000-0000-0000000000c1',
  learner: 'abababab-0000-0000-0000-0000000000d1',
  nobody: 'abababab-0000-0000-0000-0000000000ee',
};
/** 種子紀錄都落在 2026-01（與測試期間產生的紀錄分開） */
const WINDOW = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
const R = {
  orgA_update: 'cdcdcdcd-0000-0000-0000-000000000001',
  orgB_update: 'cdcdcdcd-0000-0000-0000-000000000002',
  course_update: 'cdcdcdcd-0000-0000-0000-000000000003',
  transcript_read: 'cdcdcdcd-0000-0000-0000-000000000004',
  login_failed: 'cdcdcdcd-0000-0000-0000-000000000005',
  role_assigned: 'cdcdcdcd-0000-0000-0000-000000000006',
  platform_login: 'cdcdcdcd-0000-0000-0000-000000000007',
  formula: 'cdcdcdcd-0000-0000-0000-000000000008',
};

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG_A],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}

const list = (who: keyof typeof U, query: Record<string, string> = WINDOW) =>
  app.inject({ method: 'GET', url: `/api/audit-logs?${new URLSearchParams(query).toString()}`, headers: { cookie: `iac_session=${s[who].token}` } });

const exportCsv = (who: keyof typeof U, payload: object, csrf = true) =>
  app.inject({
    method: 'POST',
    url: '/api/audit-logs/export',
    payload,
    headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, ...(csrf && { 'x-csrf-token': s[who].csrf }) },
  });

const ids = (res: { json(): { data: { id: string }[] } }) => res.json().data.map((d) => d.id);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-a', 'Org A', 'a'), ($2, 'org-b', 'Org B', 'b')`, [ORG_A, ORG_B]);
  await admin.query(`INSERT INTO courses (id, organization_id, code, title) VALUES ($1, $2, 'A1', 'Course A1')`, [COURSE_A1, ORG_A]);
  await admin.query(
    `INSERT INTO users (id, email, display_name) VALUES
       ($1, 'padmin@audit.test', '平台管理員'), ($2, 'admin-a@audit.test', '組織 A 管理員'), ($3, 'instr@audit.test', '王講師'),
       ($4, 'learner@audit.test', '學員甲'), ($5, 'nobody@audit.test', '無角色')`,
    [U.padmin, U.adminA, U.instr, U.learner, U.nobody],
  );
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'
     UNION ALL SELECT $2::uuid, id, 'organization'::scope_type, $5::uuid, $5::uuid FROM roles WHERE code = 'org_admin'
     UNION ALL SELECT $3::uuid, id, 'course'::scope_type, $6::uuid, $5::uuid FROM roles WHERE code = 'instructor'
     UNION ALL SELECT $4::uuid, id, 'self'::scope_type, $4::uuid, $5::uuid FROM roles WHERE code = 'learner'`,
    [U.padmin, U.adminA, U.instr, U.learner, ORG_A, COURSE_A1],
  );

  const rows: [string, string, string, string, string | null, string | null, string | null, string | null, string, string | null][] = [
    // id, occurred_at, action, resource_type, resource_id, org, course, actor, metadata, ip
    [R.orgA_update, '2026-01-10T10:00:00.000001Z', 'org.updated', 'organization', ORG_A, ORG_A, null, U.adminA, '{}', '10.0.0.1'],
    [R.orgB_update, '2026-01-10T10:00:00.000002Z', 'org.updated', 'organization', ORG_B, ORG_B, null, U.padmin, '{}', '10.0.0.2'],
    [R.course_update, '2026-01-11T09:00:00Z', 'course.version.updated', 'course_version', null, ORG_A, COURSE_A1, U.instr, '{}', '10.0.0.3'],
    [R.transcript_read, '2026-01-12T09:00:00Z', 'coach.transcript.read', 'coach_conversation', null, ORG_A, COURSE_A1, U.instr, JSON.stringify({ learner_id: U.learner }), '10.0.0.4'],
    [R.login_failed, '2026-01-13T09:00:00Z', 'auth.login.failed', 'user', U.learner, null, null, U.learner, JSON.stringify({ reason: 'bad_password' }), '10.0.0.5'],
    [R.role_assigned, '2026-01-14T09:00:00Z', 'org.role.assigned', 'user', U.learner, ORG_A, null, U.adminA, '{}', '10.0.0.6'],
    [R.platform_login, '2026-01-15T09:00:00Z', 'auth.login.succeeded', 'user', U.padmin, null, null, U.padmin, '{}', '10.0.0.7'],
    [R.formula, '2026-01-16T09:00:00Z', 'org.updated', 'organization', ORG_A, ORG_A, null, U.adminA, JSON.stringify({ note: '=HYPERLINK("http://evil.test","x")' }), '10.0.0.8'],
  ];
  for (const [id, at, action, type, resId, org, course, actor, meta, ip] of rows) {
    await admin.query(
      `INSERT INTO audit_logs (id, occurred_at, action, resource_type, resource_id, organization_id, course_id, actor_user_id, metadata, actor_ip,
                               before_state, after_state, correlation_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{"name":"old"}', '{"name":"new"}', 'seed-' || $1::text)`,
      [id, at, action, type, resId, org, course, actor, meta, ip],
    );
  }

  for (const k of Object.keys(U) as (keyof typeof U)[]) s[k] = await session(U[k]);

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
        LICENSE_FINGERPRINT_OVERRIDE: 'sha256:e2e-audit',
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

describe('GET /api/audit-logs — visibility by scope (UC-AUD-001)', () => {
  it('platform admin sees everything, newest first, with full detail', async () => {
    const res = await list('padmin');
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([R.formula, R.platform_login, R.role_assigned, R.login_failed, R.transcript_read, R.course_update, R.orgB_update, R.orgA_update]);
    const first = res.json().data.find((d: { id: string }) => d.id === R.orgA_update);
    expect(first).toMatchObject({
      visibility: 'full',
      ip: '10.0.0.1',
      before: { name: 'old' },
      after: { name: 'new' },
      actor: { id: U.adminA, displayName: '組織 A 管理員', email: 'admin-a@audit.test' },
      correlationId: `seed-${R.orgA_update}`,
    });
  });

  it('org admin sees only their organization (no other org, no platform-level events)', async () => {
    const got = ids(await list('adminA'));
    expect(got.sort()).toEqual([R.orgA_update, R.course_update, R.transcript_read, R.role_assigned, R.formula].sort());
  });

  it('instructor sees only their course', async () => {
    expect(ids(await list('instr')).sort()).toEqual([R.course_update, R.transcript_read].sort());
  });

  it('learner sees only events about themselves, with other people’s details removed', async () => {
    const res = await list('learner');
    expect(ids(res).sort()).toEqual([R.transcript_read, R.login_failed, R.role_assigned].sort());
    for (const d of res.json().data) {
      expect(d.visibility).toBe('self');
      for (const k of ['ip', 'userAgent', 'before', 'after', 'metadata', 'correlationId']) expect(d).not.toHaveProperty(k);
      expect(d.actor ?? {}).not.toHaveProperty('email');
    }
    // AC-COA-011：學員看得到「誰在何時讀過我的對話」
    const read = res.json().data.find((d: { id: string }) => d.id === R.transcript_read);
    expect(read).toMatchObject({ action: 'coach.transcript.read', actor: { id: U.instr, displayName: '王講師' } });
  });

  it('a user without any audit permission is refused', async () => {
    const res = await list('nobody');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
  });
});

describe('GET /api/audit-logs — filters and pagination', () => {
  it('exact and prefix action filters', async () => {
    expect(ids(await list('padmin', { ...WINDOW, action: 'org.updated' })).sort()).toEqual([R.orgA_update, R.orgB_update, R.formula].sort());
    expect(ids(await list('padmin', { ...WINDOW, action: 'org.*' })).sort()).toEqual([R.orgA_update, R.orgB_update, R.formula, R.role_assigned].sort());
  });

  it('keyset pagination visits every row once, even rows one microsecond apart', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await list('padmin', { ...WINDOW, limit: '3', ...(cursor && { cursor }) });
      expect(res.statusCode).toBe(200);
      seen.push(...ids(res));
      cursor = res.json().meta.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect(seen.slice(-2)).toEqual([R.orgB_update, R.orgA_update]);
  });

  it.each([
    [{ limit: '0' }, 'limit'],
    [{ cursor: 'not-a-cursor' }, 'cursor'],
    [{ action: "org%'; --" }, 'action'],
    [{ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, 'to'],
  ])('rejects invalid query %j', async (q, field) => {
    const res = await list('padmin', q as Record<string, string>);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.map((d: { field: string }) => d.field)).toContain(field);
  });
});

describe('POST /api/audit-logs/export (UC-AUD-002, ADR-032)', () => {
  it('returns CSV with a BOM, neutralised formulas, and records the export', async () => {
    const res = await exportCsv('padmin', WINDOW);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="audit-20260101-20260201.csv"');
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    const body = res.body.slice(1);
    const lines = body.trim().split('\r\n');
    expect(lines[0]).toBe(
      '"occurred_at","action","outcome","actor_user_id","actor_email","resource_type","resource_id","organization_id","course_id","actor_ip","correlation_id","metadata","before","after"',
    );
    expect(lines).toHaveLength(9);
    expect(body).toContain(`"{""note"":""=HYPERLINK`); // JSON 字串以 { 開頭，本身不是公式
    expect(res.body).not.toMatch(/(^|,)"=/m);

    const logged = await admin.query(`SELECT actor_user_id, metadata FROM audit_logs WHERE action = 'audit.exported' ORDER BY occurred_at DESC LIMIT 1`);
    expect(logged.rows[0]).toMatchObject({ actor_user_id: U.padmin, metadata: { from: WINDOW.from, to: WINDOW.to, rows: 8 } });
  });

  it('a formula at the start of a cell is prefixed with a quote', async () => {
    await admin.query(
      `INSERT INTO audit_logs (occurred_at, action, resource_type, organization_id, correlation_id)
       VALUES ('2026-03-01T00:00:00Z', 'org.updated', '=cmd|calc', $1, '+SUM(1)')`,
      [ORG_A],
    );
    const res = await exportCsv('padmin', { from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z' });
    expect(res.body).toContain(`"'=cmd|calc"`);
    expect(res.body).toContain(`"'+SUM(1)"`);
  });

  it('a platform export can be narrowed to one organization', async () => {
    const res = await exportCsv('padmin', { ...WINDOW, organizationId: ORG_B });
    expect(res.statusCode).toBe(200);
    expect(res.body.trim().split('\r\n')).toHaveLength(2); // header + org B 的一筆
  });

  it('org admins export only their own organization; another organization is not found', async () => {
    const own = await exportCsv('adminA', WINDOW);
    expect(own.statusCode).toBe(200);
    const lines = own.body.slice(1).trim().split('\r\n').slice(1);
    expect(lines).toHaveLength(5); // org A：orgA_update、course_update、transcript_read、role_assigned、formula
    expect(own.body).not.toContain(ORG_B);

    const other = await exportCsv('adminA', { ...WINDOW, organizationId: ORG_B });
    expect(other.statusCode).toBe(404);
    expect(other.headers['content-type']).toMatch(/^application\/json/);
  });

  it('users without audit.export are refused', async () => {
    const res = await exportCsv('instr', WINDOW);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('requires the CSRF token', async () => {
    const res = await exportCsv('padmin', WINDOW, false);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('rejects ranges longer than 366 days', async () => {
    const res = await exportCsv('padmin', { from: '2025-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' });
    expect(res.statusCode).toBe(400);
    // 路由宣告了 text/csv，但錯誤回應必須是 JSON 且不帶附件標頭
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.json().error.details).toEqual([{ field: 'to', issue: 'range_too_large' }]);
  });
});

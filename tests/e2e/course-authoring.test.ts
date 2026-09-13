/**
 * 課程與課程版本編輯的端到端測試（SA UC-CRS-001~003/009/010/012、AC-CRS-001/002/004、SD §6.5）。
 * 角色依 migration 0012：org_admin 建課程／指派人員／封存；instructor 建立與編輯版本。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
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
const SECRET = 'course-e2e-secret-course-e2e-secret-course';
const FINGERPRINT = 'sha256:e2e-course';
const ORG_A = '56565656-0000-0000-0000-00000000000a';
const ORG_B = '56565656-0000-0000-0000-00000000000b';
const U = {
  adminA: '78787878-0000-0000-0000-00000000000a',
  instr: '78787878-0000-0000-0000-0000000000c1',
  learner: '78787878-0000-0000-0000-0000000000d1',
  adminB: '78787878-0000-0000-0000-00000000000b',
  outsider: '78787878-0000-0000-0000-0000000000e1',
};
const EMAIL = { instr: 'instr@course.test', outsider: 'outsider@course.test' };

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;

async function session(userId: string, org: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), org],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who: keyof typeof U, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload && { payload }),
    headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf },
  });

const lastAudit = async (action: string) =>
  (await admin.query(`SELECT organization_id, resource_id, before_state, after_state, metadata FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action])).rows[0];

// ---- 課程結構 fixture ------------------------------------------------------
const ID = { M1: randomUUID(), M2: randomUUID(), L1: randomUUID(), A1: randomUUID(), A2: randomUUID() };
let defId = '';

function structure() {
  return [
    {
      id: ID.M1,
      title: '單元一',
      lessons: [
        {
          id: ID.L1,
          title: '課節一',
          contentBlocks: [
            { type: 'richtext', markdown: '# 歡迎\n先閱讀教材。' },
            { type: 'activity', activityId: ID.A1 },
          ],
          activities: [
            { id: ID.A1, title: '閱讀教材', activityType: 'reading' },
            {
              id: ID.A2,
              title: '參數實驗',
              activityType: 'interactive',
              interactiveDefinitionId: defId,
              config: { parameters: [{ id: 'p', label: '溫度', min: 0, max: 100, step: 1 }] },
              answerKey: { acceptable_ranges: [{ parameter_id: 'p', min: 40, max: 60 }] },
              maxAttempts: 3,
              weight: 2,
              prerequisite: { operator: 'AND', conditions: [{ type: 'specific_activities_completed', activity_ids: [ID.A1] }] },
            },
          ],
        },
      ],
    },
    { id: ID.M2, title: '單元二', lessons: [] },
  ];
}

let courseId = '';
let v1 = '';
let v2 = '';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-a', 'Org A', 'a'), ($2, 'org-b', 'Org B', 'b')`, [ORG_A, ORG_B]);
  await admin.query(
    `INSERT INTO users (id, email, display_name) VALUES
       ($1, 'admin-a@course.test', 'Admin A'), ($2, $6, '王講師'), ($3, 'learner@course.test', '學員'),
       ($4, 'admin-b@course.test', 'Admin B'), ($5, $7, '外部人員')`,
    [U.adminA, U.instr, U.learner, U.adminB, U.outsider, EMAIL.instr, EMAIL.outsider],
  );
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'organization'::scope_type, $6::uuid, $6::uuid FROM roles WHERE code = 'org_admin'
     UNION ALL SELECT $2::uuid, id, 'self'::scope_type, $2::uuid, $6::uuid FROM roles WHERE code = 'learner'
     UNION ALL SELECT $3::uuid, id, 'self'::scope_type, $3::uuid, $6::uuid FROM roles WHERE code = 'learner'
     UNION ALL SELECT $4::uuid, id, 'organization'::scope_type, $7::uuid, $7::uuid FROM roles WHERE code = 'org_admin'
     UNION ALL SELECT $5::uuid, id, 'self'::scope_type, $5::uuid, $7::uuid FROM roles WHERE code = 'learner'`,
    [U.adminA, U.instr, U.learner, U.adminB, U.outsider, ORG_A, ORG_B],
  );
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-course', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  defId = (await admin.query<{ id: string }>(`SELECT id FROM interactive_definitions WHERE component_type = 'native.ParameterControl'`)).rows[0]!.id;

  for (const k of ['adminA', 'instr', 'learner'] as const) s[k] = await session(U[k], ORG_A);
  for (const k of ['adminB', 'outsider'] as const) s[k] = await session(U[k], ORG_B);

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

describe('courses (UC-CRS-001)', () => {
  it('an org admin creates a course in the active organization', async () => {
    const res = await call('POST', '/api/courses', 'adminA', { code: 'CA-101', title: '課程 A', description: '入門課' });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    courseId = c.id;
    expect(c).toMatchObject({ organizationId: ORG_A, code: 'CA-101', status: 'draft', publishedVersion: null, workingVersion: null, staff: [] });
    expect(await lastAudit('course.created')).toMatchObject({ organization_id: ORG_A, resource_id: courseId });
  });

  it('duplicate codes are rejected within an organization; learners cannot create', async () => {
    const dup = await call('POST', '/api/courses', 'adminA', { code: 'CA-101', title: 'x' });
    // 帶出使用中的課程名稱，管理員不必自己查
    expect(dup.json().error.details).toEqual([{ field: 'code', issue: 'code_in_use', params: { title: '課程 A' } }]);
    expect((await call('POST', '/api/courses', 'learner', { code: 'L-1', title: 'x' })).statusCode).toBe(403);
  });

  it('other organizations cannot see it (ADR-019) and lists are scoped', async () => {
    expect((await call('GET', `/api/courses/${courseId}`, 'adminB')).statusCode).toBe(404);
    expect((await call('GET', '/api/courses', 'adminB')).json().data).toEqual([]);
    expect((await call('GET', '/api/courses', 'adminA')).json().data.map((c: { id: string }) => c.id)).toEqual([courseId]);
    // 學員的 course.read 為 self 範圍，不擴大管理列表
    expect((await call('GET', '/api/courses', 'learner')).statusCode).toBe(403);
  });
});

describe('course staff (UC-CRS-012)', () => {
  it('assigns an organization member as instructor by email (roles + roster in sync)', async () => {
    const res = await call('POST', `/api/courses/${courseId}/staff`, 'adminA', { email: EMAIL.instr, role: 'instructor' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual([expect.objectContaining({ userId: U.instr, role: 'instructor', displayName: '王講師' })]);
    const roster = await admin.query(`SELECT staff_role FROM course_staff WHERE course_id = $1 AND user_id = $2`, [courseId, U.instr]);
    expect(roster.rows).toEqual([{ staff_role: 'instructor' }]);
    // 課程列表直接帶出講師，管理員不必逐一點進課程
    const listed = (await call('GET', '/api/courses', 'adminA')).json().data as { id: string; staff: unknown }[];
    expect(listed.find((x) => x.id === courseId)?.staff).toEqual([{ userId: U.instr, displayName: '王講師', role: 'instructor' }]);
  });

  it('people outside the organization cannot be assigned', async () => {
    const res = await call('POST', `/api/courses/${courseId}/staff`, 'adminA', { email: EMAIL.outsider, role: 'instructor' });
    expect(res.json().error.details).toEqual([{ field: 'email', issue: 'not_in_organization' }]);
  });
});

describe('course versions (UC-CRS-002/003)', () => {
  it('org admins do not author versions (no course.version.create)', async () => {
    expect((await call('POST', `/api/courses/${courseId}/versions`, 'adminA', { title: 'v1' })).statusCode).toBe(403);
  });

  it('the instructor creates the first draft with a default coach policy', async () => {
    const res = await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: '第一版' });
    expect(res.statusCode).toBe(201);
    const v = res.json();
    v1 = v.id;
    expect(v).toMatchObject({ versionNo: 1, status: 'draft', editable: true, modules: [], navigationMode: 'mixed', completionRuleSet: null });
    expect(v.coachPolicy).toMatchObject({ responseMode: 'hint_first', citationRequired: true });
  });

  it('only one working version per course', async () => {
    const res = await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'again' });
    expect(res.json().error.details).toEqual([{ issue: 'draft_exists' }]);
  });

  it('saves the draft structure, keeping client-generated ids', async () => {
    const res = await call('PATCH', `/api/course-versions/${v1}`, 'instr', { summary: '簡介', navigationMode: 'strict', modules: structure() });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.navigationMode).toBe('strict');
    expect(v.modules.map((m: { id: string }) => m.id)).toEqual([ID.M1, ID.M2]);
    const [a1, a2] = v.modules[0].lessons[0].activities;
    expect([a1.id, a2.id]).toEqual([ID.A1, ID.A2]);
    expect(a2).toMatchObject({ weight: 2, maxScore: 100, maxAttempts: 3, interactiveDefinitionId: defId });
    expect(a2.prerequisite.conditions[0].activity_ids).toEqual([ID.A1]);
    expect(v.modules[0].lessons[0].contentBlocks[1]).toEqual({ type: 'activity', activityId: ID.A1 });
    expect(await lastAudit('course.version.updated')).toMatchObject({
      resource_id: v1,
      before_state: { summary: null, navigationMode: 'mixed', structure: { modules: 0, lessons: 0, activities: 0 } },
      after_state: { summary: '簡介', navigationMode: 'strict', structure: { modules: 2, lessons: 1, activities: 2 } },
    });
  });

  const variants: [string, () => unknown[], string, string][] = [
    ['duplicate ids', () => { const m = structure(); m[1]!.id = ID.M1; return m; }, 'modules.1.id', 'duplicate_id'],
    [
      'an activity block pointing at another lesson',
      () => { const m = structure(); (m[1]!.lessons as unknown[]).push({ id: randomUUID(), title: 'L2', contentBlocks: [{ type: 'activity', activityId: ID.A1 }] }); return m; },
      'modules.1.lessons.0.contentBlocks.0.activityId',
      'activity_not_in_lesson',
    ],
    [
      'an interactive activity without a component',
      () => { const m = structure(); delete (m[0]!.lessons[0]!.activities[1] as Record<string, unknown>)['interactiveDefinitionId']; return m; },
      'modules.0.lessons.0.activities.1.interactiveDefinitionId',
      'interactive_requires_definition',
    ],
    [
      'an unknown interactive component',
      () => { const m = structure(); (m[0]!.lessons[0]!.activities[1] as Record<string, unknown>)['interactiveDefinitionId'] = randomUUID(); return m; },
      'modules.0.lessons.0.activities.1.interactiveDefinitionId',
      'unknown_interactive_definition',
    ],
  ];

  it.each(variants)('rejects %s without changing the draft', async (_label, build, field, issue) => {
    const res = await call('PATCH', `/api/course-versions/${v1}`, 'instr', { modules: build() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toContainEqual({ field, issue });
    const after = (await call('GET', `/api/course-versions/${v1}`, 'instr')).json();
    expect(after.modules.map((m: { id: string }) => m.id)).toEqual([ID.M1, ID.M2]);
  });

  it('rejects CMS-only blocks in lessons', async () => {
    const m = structure();
    (m[0]!.lessons[0]!.contentBlocks as unknown[]).push({ type: 'hero', title: 'x' });
    expect((await call('PATCH', `/api/course-versions/${v1}`, 'instr', { modules: m })).statusCode).toBe(400);
  });

  it('reordering and removing keeps the remaining ids', async () => {
    const m = structure();
    m[0]!.lessons[0]!.activities.reverse();
    m.pop();
    const v = (await call('PATCH', `/api/course-versions/${v1}`, 'instr', { modules: m })).json();
    expect(v.modules).toHaveLength(1);
    expect(v.modules[0].lessons[0].activities.map((a: { id: string }) => a.id)).toEqual([ID.A2, ID.A1]);
  });
});

describe('published versions, impact and clone (AC-CRS-001/002, SEQ-02)', () => {
  it('a published version cannot be edited (409 from the application guard)', async () => {
    await admin.query(`INSERT INTO completion_rule_sets (course_version_id, rule_json) VALUES ($1, $2)`, [
      v1,
      { operator: 'AND', conditions: [{ type: 'minimum_activity_score', activity_id: ID.A1, value: 60 }] },
    ]);
    await admin.query(`UPDATE course_versions SET status = 'published', published_at = now() WHERE id = $1`, [v1]);
    const res = await call('PATCH', `/api/course-versions/${v1}`, 'instr', { title: '偷改' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('COURSE_VERSION_IMMUTABLE');
    expect((await call('GET', `/api/course-versions/${v1}`, 'instr')).json().editable).toBe(false);
  });

  it('impact counts learners bound to the version', async () => {
    await admin.query(
      `INSERT INTO enrollments (organization_id, course_id, course_version_id, user_id, enroll_method, status) VALUES ($1, $2, $3, $4, 'assign', 'active')`,
      [ORG_A, courseId, v1, U.learner],
    );
    expect((await call('GET', `/api/course-versions/${v1}/impact`, 'instr')).json()).toEqual({ activeLearners: 1, completedLearners: 0, boundDocumentVersions: 0 });
  });

  it('clone makes a new draft with fresh ids and rewrites every JSON reference', async () => {
    const res = await call('POST', `/api/course-versions/${v1}/clone`, 'instr');
    expect(res.statusCode).toBe(201);
    const v = res.json();
    v2 = v.id;
    expect(v).toMatchObject({ versionNo: 2, status: 'draft', clonedFromVersionId: v1, editable: true, navigationMode: 'strict' });

    const lesson = v.modules[0].lessons[0];
    const byTitle = Object.fromEntries(lesson.activities.map((a: { title: string; id: string }) => [a.title, a]));
    const newA1 = byTitle['閱讀教材'].id;
    const newA2 = byTitle['參數實驗'];
    for (const old of Object.values(ID)) expect(JSON.stringify(v.modules)).not.toContain(old);
    expect(lesson.contentBlocks[1]).toEqual({ type: 'activity', activityId: newA1 });
    expect(newA2.prerequisite.conditions[0].activity_ids).toEqual([newA1]);
    expect(newA2.answerKey).toEqual({ acceptable_ranges: [{ parameter_id: 'p', min: 40, max: 60 }] });
    expect(v.completionRuleSet.rule.conditions[0].activity_id).toBe(newA1);
    expect(v.coachPolicy).toMatchObject({ responseMode: 'hint_first' });

    // 既有選課仍指向原版本（AC-CRS-002）；來源版本不變
    const e = await admin.query(`SELECT course_version_id FROM enrollments WHERE user_id = $1`, [U.learner]);
    expect(e.rows).toEqual([{ course_version_id: v1 }]);
    const src = (await call('GET', `/api/course-versions/${v1}`, 'instr')).json();
    expect(src.modules[0].lessons[0].activities.map((a: { id: string }) => a.id)).toEqual([ID.A2, ID.A1]);
    expect(await lastAudit('course.version.cloned')).toMatchObject({ resource_id: v2, metadata: { source_version_id: v1 } });
  });

  it('a second clone is blocked; drafts cannot be cloned', async () => {
    expect((await call('POST', `/api/course-versions/${v1}/clone`, 'instr')).json().error.details).toEqual([{ issue: 'draft_exists' }]);
    expect((await call('POST', `/api/course-versions/${v2}/clone`, 'instr')).json().error.details).toEqual([{ issue: 'source_not_published' }]);
  });

  it('ids belonging to another version are rejected', async () => {
    const res = await call('PATCH', `/api/course-versions/${v2}`, 'instr', { modules: [{ id: ID.M1, title: '搶用舊 id' }] });
    expect(res.json().error.details).toContainEqual({ field: 'modules.0.id', issue: 'id_conflict' });
  });
});

describe('staff removal, catalog and archive', () => {
  it('removing the course role on the members page also removes the roster entry', async () => {
    const res = await call('PATCH', `/api/organizations/${ORG_A}/users/${U.instr}/roles`, 'adminA', { roles: [{ role: 'learner' }] });
    expect(res.statusCode).toBe(200);
    expect((await admin.query(`SELECT 1 FROM course_staff WHERE user_id = $1`, [U.instr])).rowCount).toBe(0);
    expect((await call('GET', `/api/course-versions/${v2}`, 'instr')).statusCode).toBe(403);
  });

  it('lists enabled interactive components for course staff only', async () => {
    const res = await call('GET', '/api/interactive-definitions', 'adminA');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(13);
    expect(res.json().map((d: { componentType: string }) => d.componentType)).toContain('native.ParameterControl');
    expect((await call('GET', '/api/interactive-definitions', 'learner')).statusCode).toBe(403);
  });

  it('archiving blocks new versions; PATCH /courses only archives', async () => {
    expect((await call('PATCH', `/api/courses/${courseId}`, 'adminA', { title: '改名' })).statusCode).toBe(400);
    const res = await call('PATCH', `/api/courses/${courseId}`, 'adminA', { status: 'archived' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('archived');
    expect(await lastAudit('course.archived')).toMatchObject({ before_state: { status: 'draft' }, after_state: { status: 'archived' } });

    await call('POST', `/api/courses/${courseId}/staff`, 'adminA', { email: EMAIL.instr, role: 'course_admin' });
    expect((await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v3' })).json().error.details).toEqual([{ issue: 'course_archived' }]);
  });

  it('restoring reopens an archived course; its status follows whether a version is published', async () => {
    const pub = await admin.query(`SELECT 1 FROM course_versions WHERE course_id = $1 AND status = 'published'`, [courseId]);
    const expected = pub.rowCount ? 'active' : 'draft';
    expect([403, 404]).toContain((await call('POST', `/api/courses/${courseId}/restore`, 'learner')).statusCode);

    const res = await call('POST', `/api/courses/${courseId}/restore`, 'adminA');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(expected);
    expect(await lastAudit('course.restored')).toMatchObject({ before_state: { status: 'archived' }, after_state: { status: expected } });
    expect((await call('POST', `/api/courses/${courseId}/restore`, 'adminA')).json().error.details).toEqual([{ issue: 'not_archived' }]);
  });

  it('the list can be filtered by status', async () => {
    await call('PATCH', `/api/courses/${courseId}`, 'adminA', { status: 'archived' });
    const ids = async (status: string) => ((await call('GET', `/api/courses?status=${status}`, 'adminA')).json().data as { id: string }[]).map((c) => c.id);
    expect(await ids('archived')).toEqual([courseId]);
    expect(await ids('draft')).not.toContain(courseId);
    expect((await call('GET', '/api/courses?status=deleted', 'adminA')).statusCode).toBe(400);
    await call('POST', `/api/courses/${courseId}/restore`, 'adminA');
  });
});

describe('automatic course codes (SD §6.5)', () => {
  const create = (who: keyof typeof U, body: object) => call('POST', '/api/courses', who, body);

  it('numbers courses per organization when the code is left blank', async () => {
    const first = await create('adminA', { title: '自動一' });
    expect(first.statusCode).toBe(201);
    expect(first.json().code).toBe('C-0001');
    expect((await create('adminA', { title: '自動二' })).json().code).toBe('C-0002');
    // 手動代碼若使用同一格式，下一個自動編號接在最大值之後
    expect((await create('adminA', { code: 'C-0010', title: '手動' })).json().code).toBe('C-0010');
    expect((await create('adminA', { title: '自動三' })).json().code).toBe('C-0011');
    // 每個組織各自編號
    expect((await create('adminB', { title: 'B 的第一門' })).json().code).toBe('C-0001');
  });

  it('concurrent creations never receive the same number', async () => {
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => create('adminA', { title: `並行 ${i}` })));
    expect(res.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(res.map((r) => r.json().code)).size).toBe(5);
  });

  it("the list can be narrowed to one organization, still within the caller's scope", async () => {
    const mine = (await call('GET', `/api/courses?organizationId=${ORG_A}&limit=100`, 'adminA')).json().data as { organizationId: string }[];
    expect(mine.length).toBeGreaterThan(5);
    expect(mine.every((c) => c.organizationId === ORG_A)).toBe(true);
    expect((await call('GET', `/api/courses?organizationId=${ORG_B}`, 'adminA')).json().data).toEqual([]);
  });
});

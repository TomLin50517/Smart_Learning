/**
 * 發布前檢查 C1–C5 與發布（Phase 1-2b，SA SEQ-01、SD §6.7）。
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
import { snapshotHash } from '../../apps/api/src/modules/course/application/publish.service.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'publish-e2e-secret-publish-e2e-secret';
const FINGERPRINT = 'sha256:e2e-publish';
const ORG = '9a9a9a9a-0000-0000-0000-00000000000a';
const U = { admin: 'abababab-0000-0000-0000-00000000000a', instr: 'abababab-0000-0000-0000-0000000000c1' };
const ID = { M1: randomUUID(), M2: randomUUID(), L1: randomUUID(), L2: randomUUID(), QUIZ: randomUUID(), INTER: randomUUID(), READ: randomUUID() };
const VALID_CONFIG = { parameters: [{ id: 'p', label: '溫度', min: 0, max: 100, step: 1 }] };
/** 原生選擇題也受 C5 檢查（SD §6.9） */
const QUIZ_CONFIG = { questions: [{ id: 'q1', prompt: '1+1', options: [{ id: 'a', label: '1' }, { id: 'b', label: '2' }] }] };
const POLICY = {
  responseMode: 'hint_first',
  maxDirectnessLevel: 2,
  allowAnswerRevealAfterAttempts: null,
  preferredLanguage: 'zh-TW',
  citationRequired: true,
  allowedKnowledgeScopes: ['course_source', 'verified_faq'],
  toneProfile: 'supportive',
  followUpQuestions: true,
  prohibitedTopics: [],
  extraInstructions: null,
};

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let defId = '';
let courseId = '';
let v1 = '';
let v2 = '';
let docVersionId = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: keyof typeof U, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload && { payload }),
    headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf },
  });
const lastAudit = async (action: string) =>
  (await admin.query(`SELECT before_state, after_state, metadata FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action])).rows[0];

/** M1（必修）：小考、互動實驗；M2：閱讀。mixed 模式下 M2 依賴 M1 的必修活動 */
function modules(config: object, quizPrerequisite: object | null) {
  return [
    {
      id: ID.M1,
      title: '單元一',
      lessons: [
        {
          id: ID.L1,
          title: '課節一',
          activities: [
            { id: ID.QUIZ, title: '小考', activityType: 'quiz', config: QUIZ_CONFIG, prerequisite: quizPrerequisite },
            { id: ID.INTER, title: '參數實驗', activityType: 'interactive', interactiveDefinitionId: defId, config },
          ],
        },
      ],
    },
    { id: ID.M2, title: '單元二', lessons: [{ id: ID.L2, title: '課節二', activities: [{ id: ID.READ, title: '閱讀', activityType: 'reading' }] }] },
  ];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-p', 'Org P', 'p')`, [ORG]);
  await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, 'admin@pub.test', 'Admin'), ($2, 'instr@pub.test', '講師')`, [U.admin, U.instr]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'organization'::scope_type, $3::uuid, $3::uuid FROM roles WHERE code = 'org_admin'
     UNION ALL SELECT $2::uuid, id, 'self'::scope_type, $2::uuid, $3::uuid FROM roles WHERE code = 'learner'`,
    [U.admin, U.instr, ORG],
  );
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-pub', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  defId = (await admin.query<{ id: string }>(`SELECT id FROM interactive_definitions WHERE component_type = 'native.ParameterControl'`)).rows[0]!.id;
  s.admin = await session(U.admin);
  s.instr = await session(U.instr);

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

  courseId = (await call('POST', '/api/courses', 'admin', { title: '發布測試課' })).json().id;
  expect((await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@pub.test', role: 'instructor' })).statusCode).toBe(201);
  v1 = (await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v1' })).json().id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('validate (C1–C5)', () => {
  it('reports every failing check, and publishing is refused with 422', async () => {
    // C1：小考要求先完成單元二的閱讀，但 mixed 模式下單元二要先完成單元一 → 循環
    // C5：互動實驗的設定缺少 parameters
    expect((await call('PATCH', `/api/course-versions/${v1}`, 'instr', { modules: modules({}, { type: 'specific_activities_completed', activity_ids: [ID.READ] }) })).statusCode).toBe(200);
    // C3：綁定的教材仍在處理中；C4：教練設定遺失（C2：尚未設定完成條件）
    const doc = await admin.query<{ id: string }>(`INSERT INTO source_documents (organization_id, course_id, title, doc_type) VALUES ($1, $2, '講義', 'material') RETURNING id`, [ORG, courseId]);
    docVersionId = (
      await admin.query<{ id: string }>(
        `INSERT INTO document_versions (source_document_id, organization_id, version_no, status, original_filename, mime_type, size_bytes, sha256, object_key)
         VALUES ($1, $2, 1, 'parsing', 'a.pdf', 'application/pdf', 10, repeat('a', 64), 'k') RETURNING id`,
        [doc.rows[0]!.id, ORG],
      )
    ).rows[0]!.id;
    await admin.query(`INSERT INTO knowledge_bindings (course_version_id, document_version_id) VALUES ($1, $2)`, [v1, docVersionId]);
    await admin.query(`DELETE FROM coach_policies WHERE course_version_id = $1`, [v1]);

    const res = await call('POST', `/api/course-versions/${v1}/validate`, 'instr');
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.valid).toBe(false);
    expect(r.errors.map((e: { check: string; code: string; targetId?: string }) => `${e.check} ${e.code} ${e.targetId ?? ''}`.trim())).toEqual([
      `C1 C1_UNREACHABLE ${ID.QUIZ}`,
      `C1 C1_UNREACHABLE ${ID.READ}`,
      'C2 COMPLETION_RULE_MISSING',
      `C3 C3_DOCUMENT_NOT_READY ${docVersionId}`,
      'C4 C4_POLICY_MISSING',
      `C5 C5_CONFIG_INVALID ${ID.INTER}`,
    ]);
    expect(r.errors[5]).toMatchObject({ path: 'modules.0.lessons.0.activities.1.config' });

    const pub = await call('POST', `/api/course-versions/${v1}/publish`, 'instr');
    expect(pub.statusCode).toBe(422);
    expect(pub.json().error.code).toBe('COURSE_VALIDATION_FAILED');
    expect(pub.json().error.details).toHaveLength(6);
    expect(pub.json().error.details[0].params).toMatchObject({ check: 'C1' });
    expect((await call('GET', `/api/course-versions/${v1}`, 'instr')).json().status).toBe('draft');
  });

  it('once everything is fixed the report is clean', async () => {
    expect((await call('PATCH', `/api/course-versions/${v1}`, 'instr', { modules: modules(VALID_CONFIG, null) })).statusCode).toBe(200);
    await admin.query(`UPDATE document_versions SET status = 'ready' WHERE id = $1`, [docVersionId]);
    expect((await call('PUT', `/api/course-versions/${v1}/completion-rules`, 'instr', { rule: { type: 'required_activities_completed', value: true } })).statusCode).toBe(200);
    expect((await call('PUT', `/api/course-versions/${v1}/coach-policy`, 'instr', POLICY)).statusCode).toBe(200);
    expect((await call('POST', `/api/course-versions/${v1}/validate`, 'instr')).json()).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('org admins can neither validate nor publish', async () => {
    expect((await call('POST', `/api/course-versions/${v1}/validate`, 'admin')).statusCode).toBe(403);
    expect((await call('POST', `/api/course-versions/${v1}/publish`, 'admin')).statusCode).toBe(403);
  });
});

describe('publish', () => {
  it('draft → published with a content snapshot hash; the course becomes active; audit records it', async () => {
    const res = await call('POST', `/api/course-versions/${v1}/publish`, 'instr');
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v).toMatchObject({ status: 'published', editable: false });
    expect(v.contentSnapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // 以相同函式重算必須一致：日後偵測是否被繞過應用層修改（AC-CRS-001）
    expect(snapshotHash(v)).toBe(v.contentSnapshotHash);

    expect((await call('GET', `/api/courses/${courseId}`, 'admin')).json()).toMatchObject({ status: 'active', publishedVersion: { id: v1 } });
    expect(await lastAudit('course.version.published')).toMatchObject({
      before_state: { status: 'draft' },
      after_state: { status: 'published', contentSnapshotHash: v.contentSnapshotHash },
      metadata: { superseded_version_id: null },
    });
  });

  it('a published version can be neither published again nor edited', async () => {
    expect((await call('POST', `/api/course-versions/${v1}/publish`, 'instr')).json().error.code).toBe('COURSE_VERSION_IMMUTABLE');
    expect((await call('PATCH', `/api/course-versions/${v1}`, 'instr', { title: '改名' })).statusCode).toBe(409);
  });

  it('publishing the next version supersedes the previous one; exactly one version stays published', async () => {
    const clone = await call('POST', `/api/course-versions/${v1}/clone`, 'instr');
    expect(clone.statusCode).toBe(201);
    v2 = clone.json().id;
    const res = await call('POST', `/api/course-versions/${v2}/publish`, 'instr');
    expect(res.statusCode).toBe(200);

    expect((await call('GET', `/api/course-versions/${v1}`, 'instr')).json().status).toBe('superseded');
    expect((await call('GET', `/api/courses/${courseId}`, 'admin')).json().publishedVersion.id).toBe(v2);
    const published = await admin.query(`SELECT id FROM course_versions WHERE course_id = $1 AND status = 'published'`, [courseId]);
    expect(published.rows).toEqual([{ id: v2 }]);
    expect((await lastAudit('course.version.published')).metadata).toEqual({ superseded_version_id: v1 });
  });
});

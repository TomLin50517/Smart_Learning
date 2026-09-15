/**
 * 常見問答、常見錯誤與組織共用教材（SA UC-KNW-004～008、AC-DRV-001～007；SD §6.27）。
 * 物件儲存以記憶體實作取代；索引（Elasticsearch）不在此測試範圍——只確認排入 derived.index。
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
import { MemoryObjectStorage, OBJECT_STORAGE } from '../../apps/api/src/common/object-storage.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'faq-e2e-secret-faq-e2e-secret-faq-e2e';
const FINGERPRINT = 'sha256:e2e-faq';
const ORG = 'fafa0000-0000-0000-0000-00000000000a';
const NAMES = ['王小明', '陳美玲', '林志豪', '張雅婷', '李建宏', '黃淑芬'];
const U = {
  admin: 'fafa1111-0000-0000-0000-00000000000a',
  instr: 'fafa1111-0000-0000-0000-0000000000c1',
  l0: 'fafa1111-0000-0000-0000-0000000000d0',
  l1: 'fafa1111-0000-0000-0000-0000000000d1',
  l2: 'fafa1111-0000-0000-0000-0000000000d2',
  l3: 'fafa1111-0000-0000-0000-0000000000d3',
  l4: 'fafa1111-0000-0000-0000-0000000000d4',
  l5: 'fafa1111-0000-0000-0000-0000000000d5',
};
type Who = keyof typeof U;
const LEARNERS = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'] as const;
const QUIZ = randomUUID();
const QUIZ_CONFIG = { questions: [{ id: 'q1', prompt: '發酵的理想溫度？', options: [{ id: 'a', label: '15 度' }, { id: 'b', label: '26 度' }] }] };
const QUIZ_KEY = { correct: { q1: ['b'] }, pass_threshold: 100 };
const MD = Buffer.from('# 公司安全規範\n\n進入廚房前要洗手。\n', 'utf8');

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<Who, { token: string; csrf: string }>;
let courseId = '';
let publishedVersion = '';
const enrollment = {} as Record<(typeof LEARNERS)[number], string>;
let teacherFaq = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const auth = (who: Who) => ({ cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf });
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: Who, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: auth(who) });
const upload = (url: string, who: Who, body: Buffer) => app.inject({ method: 'POST', url, payload: body, headers: { ...auth(who), 'content-type': 'application/octet-stream' } });
const issues = (r: { json(): { error?: { details?: unknown } } }) => r.json().error?.details;
const insights = async () => (await call('GET', `/api/courses/${courseId}/faq-insights`, 'instr')).json();
const indexJobs = async () => (await admin.query(`SELECT 1 FROM job_queue WHERE job_type = 'derived.index' AND payload->>'courseId' = $1`, [courseId])).rowCount ?? 0;
const lastAudit = async (action: string) => (await admin.query(`SELECT resource_id, after_state FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action])).rows[0];
async function answerQuiz(who: (typeof LEARNERS)[number], choice: string) {
  const a = await call('POST', `/api/activities/${QUIZ}/attempts`, who);
  expect(a.statusCode).toBe(201);
  return (await call('POST', `/api/attempts/${a.json().attemptId}/submit`, who, { input: { answers: { q1: [choice] } } })).json();
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-faq', '烘焙學苑', 'fq')`, [ORG]);
  for (const k of Object.keys(U) as Who[]) {
    const i = LEARNERS.indexOf(k as (typeof LEARNERS)[number]);
    await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@faq.test`, i >= 0 ? NAMES[i] : k]);
  }
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', ...LEARNERS] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-faq', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as Who[]) s[k] = await session(U[k]);

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
    .useValue(new MemoryObjectStorage())
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  courseId = (await call('POST', '/api/courses', 'admin', { title: '烘焙入門' })).json().id;
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@faq.test', role: 'instructor' });
  publishedVersion = (await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v1' })).json().id;
  await call('PATCH', `/api/course-versions/${publishedVersion}`, 'instr', {
    modules: [
      {
        id: randomUUID(),
        title: '單元',
        lessons: [{ id: randomUUID(), title: '課節', activities: [{ id: QUIZ, title: '發酵小考', activityType: 'quiz', maxScore: 10, config: QUIZ_CONFIG, answerKey: QUIZ_KEY }] }],
      },
    ],
  });
  await call('PUT', `/api/course-versions/${publishedVersion}/completion-rules`, 'instr', { rule: { type: 'required_activities_completed', value: true } });
  expect((await call('POST', `/api/course-versions/${publishedVersion}/publish`, 'instr')).statusCode).toBe(200);
  for (const k of LEARNERS) enrollment[k] = (await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: `${k}@faq.test` })).json().id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('teacher-written FAQ (UC-KNW-004)', () => {
  it('takes effect immediately: learners see it and the index is refreshed', async () => {
    const before = await indexJobs();
    const r = await call('POST', `/api/courses/${courseId}/faq`, 'instr', { kind: 'faq', question: '發酵要多久？', answer: '室溫下大約 60 分鐘。' });
    expect(r.statusCode).toBe(201);
    teacherFaq = r.json().id;
    expect(r.json()).toMatchObject({ kind: 'faq', status: 'verified', source: 'teacher', versionNo: 1, updatedByName: 'instr' });
    expect(await indexJobs()).toBe(before + 1);
    expect((await lastAudit('knowledge.faq.created')).resource_id).toBe(teacherFaq);
    const mine = (await call('GET', `/api/enrollments/${enrollment.l0}/faq`, 'l0')).json();
    expect(mine).toEqual([{ id: teacherFaq, kind: 'faq', question: '發酵要多久？', answer: '室溫下大約 60 分鐘。' }]);
  });

  it('learners cannot write; other people’s enrolments are not visible', async () => {
    expect((await call('POST', `/api/courses/${courseId}/faq`, 'l0', { kind: 'faq', question: '??', answer: 'x' })).statusCode).toBe(403);
    expect((await call('GET', `/api/enrollments/${enrollment.l0}/faq`, 'l1')).statusCode).toBe(404);
  });

  it('editing keeps the old version (AC-DRV-004)', async () => {
    const r = await call('PATCH', `/api/courses/${courseId}/faq/${teacherFaq}`, 'instr', { question: '發酵要多久？', answer: '室溫 26 度下大約 60 分鐘，天冷要更久。' });
    expect(r.json()).toMatchObject({ versionNo: 2, answer: '室溫 26 度下大約 60 分鐘，天冷要更久。' });
    const versions = await admin.query(`SELECT version_no, answer FROM derived_knowledge_versions WHERE derived_knowledge_id = $1 ORDER BY version_no`, [teacherFaq]);
    expect(versions.rows.map((v) => v.answer)).toEqual(['室溫下大約 60 分鐘。', '室溫 26 度下大約 60 分鐘，天冷要更久。']);
  });

  it('retiring hides it from learners but keeps the record (AC-DRV-007)', async () => {
    expect((await call('POST', `/api/courses/${courseId}/faq/${teacherFaq}/retire`, 'instr')).json().status).toBe('retired');
    expect((await call('GET', `/api/enrollments/${enrollment.l0}/faq`, 'l0')).json()).toEqual([]);
    expect((await call('GET', `/api/courses/${courseId}/faq`, 'instr')).json()).toEqual([]);
    expect((await call('GET', `/api/courses/${courseId}/faq?includeRetired=true`, 'instr')).json()[0]).toMatchObject({ id: teacherFaq, status: 'retired' });
    expect(issues(await call('PATCH', `/api/courses/${courseId}/faq/${teacherFaq}`, 'instr', { question: '發酵要多久？', answer: 'x' }))).toEqual([{ issue: 'faq_retired' }]);
  });
});

describe('insights (UC-KNW-005, AC-DRV-001/002/006)', () => {
  it('a common error appears only once enough different learners made it', async () => {
    const t = (await insights()).threshold;
    expect(t).toBe(5);
    for (const k of LEARNERS.slice(0, 4)) expect((await answerQuiz(k, 'a')).status).toBe('failed');
    expect((await insights()).commonErrors).toEqual([]);
    expect((await answerQuiz('l4', 'a')).status).toBe('failed');
    const errs = (await insights()).commonErrors;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ activityId: QUIZ, activityTitle: '發酵小考', code: 'WRONG_ANSWER', target: 'q1', targetLabel: '發酵的理想溫度？', learners: 5, faqId: null });
  });

  it('turning an insight into a common error marks it as done, and it cannot be created twice', async () => {
    const x = (await insights()).commonErrors[0];
    const r = await call('POST', `/api/courses/${courseId}/faq`, 'instr', { kind: 'common_error', question: '發酵溫度選錯', answer: '理想溫度是 26 度左右。', insightKey: x.key, learners: x.learners });
    expect(r.json()).toMatchObject({ source: 'insight', learners: 5 });
    expect((await insights()).commonErrors[0].faqId).toBe(r.json().id);
    expect(issues(await call('POST', `/api/courses/${courseId}/faq`, 'instr', { kind: 'common_error', question: '再一次', answer: 'x', insightKey: x.key }))).toEqual([{ issue: 'faq_exists' }]);
  });

  it('similar learner questions are grouped after removing personal data', async () => {
    const variants = ['發酵溫度要多少度？', '請問發酵的溫度要幾度', '發酵溫度應該設定多少度呢', '麵糰發酵溫度要多少度', '發酵溫度多少比較好？'];
    for (const [i, k] of LEARNERS.slice(0, 5).entries()) {
      const conv = await admin.query<{ id: string }>(
        `INSERT INTO coach_conversations (organization_id, enrollment_id, learner_id, course_version_id, trigger_type, is_test, transcript_visibility, message_count)
         VALUES ($1, $2, $3, $4, 'learner_question', false, 'aggregate_only', 2) RETURNING id`,
        [ORG, enrollment[k], U[k], publishedVersion],
      );
      await admin.query(`INSERT INTO coach_messages (organization_id, conversation_id, seq_no, role, content) VALUES ($1, $2, 1, 'user', $3)`, [
        ORG,
        conv.rows[0]!.id,
        `我是${NAMES[i]}（${k}@faq.test），${variants[i]}`,
      ]);
    }
    const q = (await insights()).frequentQuestions;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ learners: 5, questions: 5, faqId: null });
    for (const n of NAMES) expect(q[0].question).not.toContain(n);
    expect(q[0].question).not.toContain('@faq.test');
    expect(q[0].question).toContain('發酵');
  });

  it('only course staff with derived.read see insights and the FAQ list', async () => {
    expect((await call('GET', `/api/courses/${courseId}/faq-insights`, 'l0')).statusCode).toBe(403);
    expect((await call('GET', `/api/courses/${courseId}/faq`, 'admin')).statusCode).toBe(403);
  });
});

describe('AI draft', () => {
  it('needs an AI provider, like the coach', async () => {
    const r = await call('POST', `/api/courses/${courseId}/faq/draft`, 'instr', { kind: 'faq', question: '發酵溫度要多少度？' });
    expect(r.json().error.code).toBe('COACH_PROVIDER_UNAVAILABLE');
    expect((await call('POST', `/api/courses/${courseId}/faq/draft`, 'l0', { kind: 'faq', question: '發酵溫度要多少度？' })).statusCode).toBe(403);
  });
});

describe('organisation-shared materials', () => {
  let shared = '';
  let sharedVersion = '';
  let draft = '';

  it('only organisation admins manage them', async () => {
    const r = await upload(`/api/org/knowledge/documents?filename=safety.md&title=${encodeURIComponent('公司安全規範')}`, 'admin', MD);
    expect(r.statusCode).toBe(202);
    shared = r.json().documentId;
    sharedVersion = r.json().id;
    expect((await admin.query(`SELECT course_id FROM source_documents WHERE id = $1`, [shared])).rows[0].course_id).toBeNull();
    const list = (await call('GET', '/api/org/knowledge/documents', 'admin')).json();
    expect(list).toMatchObject([{ documentId: shared, title: '公司安全規範', usedByCourses: 0 }]);
    expect((await call('GET', '/api/org/knowledge/documents', 'instr')).statusCode).toBe(403);
    expect((await upload('/api/org/knowledge/documents?filename=x.md', 'instr', MD)).statusCode).toBe(403);
  });

  it('courses add them to a draft version; course staff cannot change or delete them', async () => {
    const before = await indexJobs();
    draft = (await call('POST', `/api/course-versions/${publishedVersion}/clone`, 'instr')).json().id;
    expect(await indexJobs()).toBe(before + 1); // 新版本也要涵蓋 FAQ
    const k = (await call('GET', `/api/course-versions/${draft}/knowledge`, 'instr')).json();
    expect(k.available).toMatchObject([{ documentId: shared, shared: true }]);
    const bound = await call('POST', `/api/course-versions/${draft}/knowledge/bindings`, 'instr', { documentVersionId: sharedVersion });
    expect(bound.json().bound).toMatchObject([{ documentId: shared, shared: true }]);
    expect((await call('GET', '/api/org/knowledge/documents', 'admin')).json()[0].usedByCourses).toBe(1);
    expect((await call('DELETE', `/api/knowledge/documents/${shared}`, 'instr')).statusCode).toBe(403);
  });

  it('the shared endpoints never touch a course’s own material', async () => {
    const own = await upload(`/api/course-versions/${draft}/knowledge/documents?filename=own.md`, 'instr', MD);
    expect(own.statusCode).toBe(202);
    expect((await call('DELETE', `/api/org/knowledge/documents/${own.json().documentId}`, 'admin')).statusCode).toBe(404);
  });

  it('a shared document only bound to drafts can be deleted', async () => {
    expect((await call('DELETE', `/api/org/knowledge/documents/${shared}`, 'admin')).statusCode).toBe(204);
    expect((await call('GET', '/api/org/knowledge/documents', 'admin')).json()).toEqual([]);
    expect((await call('GET', `/api/course-versions/${draft}/knowledge`, 'instr')).json().bound.map((b: { shared: boolean }) => b.shared)).toEqual([false]);
  });
});

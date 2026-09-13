/**
 * 完成條件與 AI 教練設定（Phase 1-2a，SD §3、§6.6）：儲存時驗證、422 明細、警告、僅草稿可寫、權限、稽核。
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
const SECRET = 'rules-e2e-secret-rules-e2e-secret-rules';
const FINGERPRINT = 'sha256:e2e-rules';
const ORG = '67676767-0000-0000-0000-00000000000a';
const U = { admin: '89898989-0000-0000-0000-00000000000a', instr: '89898989-0000-0000-0000-0000000000c1' };
const ID = { M1: randomUUID(), M2: randomUUID(), L1: randomUUID(), L2: randomUUID(), QUIZ: randomUUID(), VIDEO: randomUUID(), READ: randomUUID() };
const GHOST = randomUUID();

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let versionId = '';

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
const rules = (rule: unknown, who: keyof typeof U = 'instr') => call('PUT', `/api/course-versions/${versionId}/completion-rules`, who, { rule });
const lastAudit = async (action: string) =>
  (await admin.query(`SELECT before_state, after_state FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action])).rows[0];

const POLICY = {
  responseMode: 'coach_first',
  maxDirectnessLevel: 3,
  allowAnswerRevealAfterAttempts: 2,
  preferredLanguage: 'zh-TW',
  citationRequired: true,
  allowedKnowledgeScopes: ['course_source', 'common_error'],
  toneProfile: 'neutral',
  followUpQuestions: false,
  prohibitedTopics: ['考試答案'],
  extraInstructions: '以國中生能懂的方式說明。',
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-r', 'Org R', 'r')`, [ORG]);
  await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, 'admin@rules.test', 'Admin'), ($2, 'instr@rules.test', '講師')`, [U.admin, U.instr]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'organization'::scope_type, $3::uuid, $3::uuid FROM roles WHERE code = 'org_admin'
     UNION ALL SELECT $2::uuid, id, 'self'::scope_type, $2::uuid, $3::uuid FROM roles WHERE code = 'learner'`,
    [U.admin, U.instr, ORG],
  );
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-rules', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
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

  // 課程 → 指派講師 → 講師建立草稿並寫入結構
  const course = (await call('POST', '/api/courses', 'admin', { title: '條件測試課' })).json();
  expect((await call('POST', `/api/courses/${course.id}/staff`, 'admin', { email: 'instr@rules.test', role: 'instructor' })).statusCode).toBe(201);
  versionId = (await call('POST', `/api/courses/${course.id}/versions`, 'instr', { title: 'v1' })).json().id;
  const patch = await call('PATCH', `/api/course-versions/${versionId}`, 'instr', {
    modules: [
      {
        id: ID.M1,
        title: '單元一',
        lessons: [
          {
            id: ID.L1,
            title: '課節一',
            activities: [
              { id: ID.QUIZ, title: '小考', activityType: 'quiz', maxScore: 50 },
              { id: ID.VIDEO, title: '影片', activityType: 'video' },
            ],
          },
        ],
      },
      { id: ID.M2, title: '單元二', isRequired: false, lessons: [{ id: ID.L2, title: '延伸閱讀', activities: [{ id: ID.READ, title: '閱讀', activityType: 'reading' }] }] },
    ],
  });
  expect(patch.statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('completion rules', () => {
  const valid = {
    operator: 'AND',
    conditions: [
      { type: 'required_activities_completed', value: true },
      { operator: 'OR', conditions: [{ type: 'minimum_activity_score', activity_id: ID.QUIZ, value: 40 }, { type: 'manual_approval', approver_role: 'instructor' }] },
      { type: 'video_watch_ratio', activity_id: ID.VIDEO, value: 0.8 },
    ],
  };

  it('saves a valid rule; the version returns it; audit keeps before/after', async () => {
    const res = await rules(valid);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ completionRuleSet: { grammarVersion: '1.0', rule: valid }, warnings: [] });
    expect((await call('GET', `/api/course-versions/${versionId}`, 'instr')).json().completionRuleSet).toEqual({ grammarVersion: '1.0', rule: valid });
    expect(await lastAudit('course.completion_rule.updated')).toMatchObject({ before_state: { completionRuleSet: null }, after_state: { completionRuleSet: { rule: valid } } });
  });

  it('rejects invalid rules with 422 COURSE_VALIDATION_FAILED, RULE_* codes and JSON paths; nothing is saved', async () => {
    const res = await rules({
      operator: 'AND',
      conditions: [
        { type: 'specific_activities_completed', activity_ids: [GHOST] },
        { type: 'video_watch_ratio', activity_id: ID.QUIZ, value: 0.5 },
        { type: 'minimum_activity_score', activity_id: ID.QUIZ, value: 80 },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('COURSE_VALIDATION_FAILED');
    const details = (res.json().error.details as { field: string; issue: string }[]).map((d) => `${d.issue} ${d.field}`);
    expect(details).toEqual([
      'RULE_REFERENCE_NOT_FOUND $.conditions[0].activity_ids[0]',
      'RULE_TYPE_MISMATCH $.conditions[1].activity_id',
      'RULE_VALUE_OUT_OF_RANGE $.conditions[2].value',
    ]);
    expect(res.json().error.details[2].params.message).toContain('50');
    expect((await call('GET', `/api/course-versions/${versionId}`, 'instr')).json().completionRuleSet.rule).toEqual(valid);
  });

  it('saves with warnings when a condition can never be satisfied', async () => {
    const res = await rules({ operator: 'AND', conditions: [{ type: 'attempt_count_maximum', activity_id: ID.QUIZ, value: 0 }, { type: 'module_completed', module_id: ID.M2 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.map((w: { code: string; path: string }) => `${w.code} ${w.path}`)).toEqual([
      'RULE_UNSATISFIABLE $.conditions[0].value',
      'RULE_UNSATISFIABLE $.conditions[1].module_id',
    ]);
  });

  it('rejects other grammar versions and unknown fields (400); null clears the rule', async () => {
    expect((await call('PUT', `/api/course-versions/${versionId}/completion-rules`, 'instr', { grammarVersion: '2.0', rule: valid })).statusCode).toBe(400);
    expect((await call('PUT', `/api/course-versions/${versionId}/completion-rules`, 'instr', { rule: valid, extra: 1 })).statusCode).toBe(400);
    const cleared = await rules(null);
    expect(cleared.json()).toEqual({ completionRuleSet: null, warnings: [] });
    expect((await call('GET', `/api/course-versions/${versionId}`, 'instr')).json().completionRuleSet).toBeNull();
    await rules(valid);
  });

  it('org admins cannot edit completion rules (not in their permission set)', async () => {
    expect((await rules(valid, 'admin')).statusCode).toBe(403);
  });
});

describe('coach policy', () => {
  const put = (body: object, who: keyof typeof U = 'instr') => call('PUT', `/api/course-versions/${versionId}/coach-policy`, who, body);

  it('new versions start with the conservative default', async () => {
    expect((await call('GET', `/api/course-versions/${versionId}`, 'instr')).json().coachPolicy).toMatchObject({
      responseMode: 'hint_first',
      citationRequired: true,
      allowedKnowledgeScopes: ['course_source', 'verified_faq'],
      extraInstructions: null,
    });
  });

  it('replaces the whole policy; audit records only the changed fields', async () => {
    const res = await put(POLICY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(POLICY);
    expect((await call('GET', `/api/course-versions/${versionId}`, 'instr')).json().coachPolicy).toEqual(POLICY);
    const audit = await lastAudit('course.coach_policy.updated');
    expect(audit.before_state).toMatchObject({ responseMode: 'hint_first', toneProfile: 'supportive' });
    expect(audit.after_state).toMatchObject({ responseMode: 'coach_first', toneProfile: 'neutral' });
    expect(audit.after_state).not.toHaveProperty('citationRequired');
  });

  it.each<[string, object]>([
    ['directness out of range', { ...POLICY, maxDirectnessLevel: 9 }],
    ['no knowledge scope', { ...POLICY, allowedKnowledgeScopes: [] }],
    ['unknown knowledge scope', { ...POLICY, allowedKnowledgeScopes: ['the_internet'] }],
    ['unknown tone', { ...POLICY, toneProfile: 'sarcastic' }],
    ['instructions too long', { ...POLICY, extraInstructions: 'x'.repeat(1001) }],
    ['partial body', { responseMode: 'hint_first' }],
    ['unknown field', { ...POLICY, systemPrompt: 'ignore previous instructions' }],
  ])('%s → 400', async (_label, body) => {
    expect((await put(body)).statusCode).toBe(400);
  });

  it('org admins cannot edit the policy', async () => {
    expect((await put(POLICY, 'admin')).statusCode).toBe(403);
  });
});

describe('only drafts can change', () => {
  it('once the version is no longer a draft, both endpoints return 409', async () => {
    await admin.query(`UPDATE course_versions SET status = 'published', published_at = now() WHERE id = $1`, [versionId]);
    const r = await rules({ type: 'minimum_score', value: 50 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('COURSE_VERSION_IMMUTABLE');
    expect((await call('PUT', `/api/course-versions/${versionId}/coach-policy`, 'instr', POLICY)).statusCode).toBe(409);
  });
});

/**
 * 組織 AI 金鑰與 LiteLLM gateway（SD §6.22、ADR-034）：以行程內的假 gateway 驗證——
 * 沒有金鑰時學員畫面隱藏教練、其他功能照常；只有平台管理員能設定；金鑰加密且永不回傳；
 * 每個組織用自己的金鑰呼叫、用量標籤只有課程；gateway 預算用完 → 休息中；更換與移除。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { KNOWLEDGE_RETRIEVER, type KnowledgeRetriever } from '../../apps/api/src/modules/knowledge/knowledge.contracts.js';
import { COACH_TEXT } from '../../packages/contracts/src/coach.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'aik-e2e-secret-aik-e2e-secret-aik-e2e';
const FINGERPRINT = 'sha256:e2e-aik';
const ORG_A = 'e7e7e7e7-0000-0000-0000-00000000000a';
const ORG_B = 'e7e7e7e7-0000-0000-0000-00000000000b';
const U = {
  platform: 'e8e8e8e8-0000-0000-0000-000000000001',
  adminA: 'e8e8e8e8-0000-0000-0000-00000000000a',
  instrA: 'e8e8e8e8-0000-0000-0000-0000000000a1',
  learnerA: 'e8e8e8e8-0000-0000-0000-0000000000a2',
  adminB: 'e8e8e8e8-0000-0000-0000-00000000000b',
  instrB: 'e8e8e8e8-0000-0000-0000-0000000000b1',
  learnerB: 'e8e8e8e8-0000-0000-0000-0000000000b2',
};
type Who = keyof typeof U;
const ORG_OF: Record<Who, string> = { platform: ORG_A, adminA: ORG_A, instrA: ORG_A, learnerA: ORG_A, adminB: ORG_B, instrB: ORG_B, learnerB: ORG_B };
const KEY_A = 'sk-litellm-school-a-0001';
const KEY_B = 'sk-litellm-school-b-0002';
const MODEL = 'coach-model';
const ANSWER = JSON.stringify({ status: 'insufficient_evidence', answer: '教材中沒有相關資料', citations: [], follow_up_questions: [], directness_level: 1 });

// ------------------------------------------------------------------ 假 LiteLLM gateway
interface GatewayCall {
  path: string;
  auth: string;
  body: Record<string, unknown> | null;
}
const calls: GatewayCall[] = [];
let budgetExceeded = false;
let gateway: Server;
let gatewayUrl = '';

function startGateway(): Promise<void> {
  gateway = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const body = parts.length ? (JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>) : null;
      const auth = req.headers.authorization ?? '';
      calls.push({ path: req.url ?? '', auth, body });
      const json = (status: number, payload: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      if (auth !== `Bearer ${KEY_A}` && auth !== `Bearer ${KEY_B}`) return json(401, { error: { message: 'Invalid proxy server token passed' } });
      if (req.url === '/v1/models') return json(200, { data: [{ id: MODEL }] });
      if (budgetExceeded) return json(400, { error: { message: 'Budget has been exceeded! Current cost: 1.2, Max budget: 1.0', type: 'budget_exceeded' } });
      return json(200, { model: MODEL, choices: [{ message: { content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } });
    });
  });
  return new Promise((resolve) =>
    gateway.listen(0, '127.0.0.1', () => {
      gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;
      resolve();
    }),
  );
}

// 檢索不在這個測試範圍：回一段固定的內容，讓模型一定會被呼叫
const retriever: KnowledgeRetriever = {
  available: true,
  retrieve: async () => [
    {
      chunkId: 'fixed:0',
      documentId: randomUUID(),
      documentVersionId: randomUUID(),
      title: '講義',
      content: '固定的教材內容',
      pageNo: null,
      sectionPath: null,
      charStart: 0,
      charEnd: 7,
      knowledgeType: 'source',
      verificationStatus: 'source',
      aclScope: 'course',
      rawScore: 1,
      weightedScore: 1,
    },
  ],
};

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<Who, { token: string; csrf: string }>;
const course: Record<'A' | 'B', { id: string; enrollment: string }> = { A: { id: '', enrollment: '' }, B: { id: '', enrollment: '' } };
let convA = '';

async function session(who: Who) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [U[who], hashToken(token), ORG_OF[who]],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: Who, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf } });
const done = (payload: string) => {
  const block = payload.split('\n\n').find((b) => b.startsWith('event: done'))!;
  return JSON.parse(/^data: (.+)$/m.exec(block)![1]!) as { status: string; answer: string };
};
const ask = async (who: Who, conversation: string) => {
  await admin.query(`DELETE FROM rate_limit_counters`);
  return call('POST', `/api/coach/conversations/${conversation}/messages`, who, { content: '發酵溫度是多少？' });
};
const lastChat = () => [...calls].reverse().find((c) => c.path === '/v1/chat/completions')!;

beforeAll(async () => {
  await startGateway();
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  for (const [id, code] of [
    [ORG_A, 'school-a'],
    [ORG_B, 'school-b'],
  ] as const) {
    await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, $2, $2, $2)`, [id, code]);
  }
  for (const who of Object.keys(U) as Who[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[who], `${who}@aik.test`, who]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'`,
    [U.platform],
  );
  for (const who of ['adminA', 'adminB'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
      [U[who], ORG_OF[who]],
    );
  }
  for (const who of ['instrA', 'learnerA', 'instrB', 'learnerB'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[who], ORG_OF[who]],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-aik', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{"ai_coach": true}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const who of Object.keys(U) as Who[]) s[who] = await session(who);

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
        AI_PROVIDER: 'litellm',
        AI_BASE_URL: gatewayUrl,
        AI_MODEL: MODEL,
        AI_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
    )
    .overrideProvider(KNOWLEDGE_RETRIEVER)
    .useValue(retriever)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const [k, adminWho, instrWho, learnerWho] of [
    ['A', 'adminA', 'instrA', 'learnerA'],
    ['B', 'adminB', 'instrB', 'learnerB'],
  ] as const) {
    const id = (await call('POST', '/api/courses', adminWho, { title: `烘焙 ${k}` })).json().id as string;
    await call('POST', `/api/courses/${id}/staff`, adminWho, { email: `${instrWho}@aik.test`, role: 'instructor' });
    const v = (await call('POST', `/api/courses/${id}/versions`, instrWho, { title: 'v1' })).json().id as string;
    await call('PATCH', `/api/course-versions/${v}`, instrWho, {
      modules: [{ id: randomUUID(), title: '單元', lessons: [{ id: randomUUID(), title: '課節', activities: [{ id: randomUUID(), title: '閱讀', activityType: 'reading' }] }] }],
    });
    await call('PUT', `/api/course-versions/${v}/completion-rules`, instrWho, { rule: { operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }] } });
    expect((await call('POST', `/api/course-versions/${v}/publish`, instrWho)).statusCode).toBe(200);
    course[k] = { id, enrollment: (await call('POST', `/api/courses/${id}/enrollments`, adminWho, { email: `${learnerWho}@aik.test` })).json().id };
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
  await new Promise<void>((r) => gateway?.close(() => r()));
});

describe('an organization without a key', () => {
  it('learners get no coach (hidden), but learning works; admins see why', async () => {
    const av = (await call('GET', `/api/enrollments/${course.A.enrollment}/coach`, 'learnerA')).json();
    expect(av).toMatchObject({ available: false, reason: 'organization_key_missing' });
    expect((await call('GET', `/api/enrollments/${course.A.enrollment}/outline`, 'learnerA')).statusCode).toBe(200);
    convA = (await call('POST', '/api/coach/conversations', 'learnerA', { enrollmentId: course.A.enrollment })).json().id;
    const r = await ask('learnerA', convA);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatchObject({ code: 'COACH_PROVIDER_UNAVAILABLE', details: [{ issue: 'organization_key_missing' }] });
    expect((await call('GET', `/api/organizations/${ORG_A}/coach-settings`, 'adminA')).json()).toMatchObject({
      providerConfigured: false,
      aiKey: { mode: 'organization', configured: false, alias: null },
    });
    expect(calls).toHaveLength(0);
  });
});

describe('setting keys', () => {
  it('only the platform admin can set a key; it is stored encrypted and never returned or audited', async () => {
    expect((await call('PUT', `/api/organizations/${ORG_A}/ai-credential`, 'adminA', { alias: 'x', key: KEY_A })).statusCode).toBe(403);
    expect((await call('PUT', `/api/organizations/${ORG_A}/ai-credential`, 'platform', { alias: 'x', key: 'has space inside' })).json().error.code).toBe('VALIDATION_FAILED');

    const put = await call('PUT', `/api/organizations/${ORG_A}/ai-credential`, 'platform', { alias: 'school-a', key: KEY_A });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ mode: 'organization', configured: true, alias: 'school-a', updatedBy: 'platform', encryptionReady: true });
    expect(put.payload).not.toContain(KEY_A);

    // 組織管理員只看得到代號
    const seen = await call('GET', `/api/organizations/${ORG_A}/ai-credential`, 'adminA');
    expect(seen.json()).toMatchObject({ configured: true, alias: 'school-a' });
    expect(seen.payload).not.toContain(KEY_A);
    // 別的組織：與系統其他資源一致回 404（不透露存在與否）
    expect((await call('GET', `/api/organizations/${ORG_A}/ai-credential`, 'adminB')).statusCode).toBe(404);

    const row = await admin.query(`SELECT position(convert_to($1, 'UTF8') in ciphertext) AS p, octet_length(iv) AS iv FROM organization_ai_credentials WHERE organization_id = $2`, [KEY_A, ORG_A]);
    expect(row.rows[0]).toEqual({ p: 0, iv: 12 });
    const audit = await admin.query(`SELECT action, before_state, after_state, metadata FROM audit_logs WHERE action LIKE 'org.ai_credential.%'`);
    expect(audit.rows).toMatchObject([{ action: 'org.ai_credential.updated', after_state: { configured: true, alias: 'school-a' } }]);
    expect(JSON.stringify(audit.rows)).not.toContain(KEY_A);
  });

  it('test connection checks the key and model without generating anything', async () => {
    const ok = await call('POST', `/api/organizations/${ORG_A}/ai-credential/test`, 'platform');
    expect(ok.json()).toMatchObject({ ok: true, reason: 'ok' });
    expect(calls.at(-1)).toMatchObject({ path: '/v1/models', auth: `Bearer ${KEY_A}` });

    await call('PUT', `/api/organizations/${ORG_B}/ai-credential`, 'platform', { alias: 'school-b', key: 'sk-wrong-key-b' });
    expect((await call('POST', `/api/organizations/${ORG_B}/ai-credential/test`, 'platform')).json()).toMatchObject({ ok: false, reason: 'unauthorized' });
    await call('PUT', `/api/organizations/${ORG_B}/ai-credential`, 'platform', { alias: 'school-b', key: KEY_B });
    expect((await call('POST', `/api/organizations/${ORG_B}/ai-credential/test`, 'adminB')).statusCode).toBe(403);
    expect(calls.some((c) => c.path === '/v1/chat/completions')).toBe(false);
  });
});

describe('calling the gateway', () => {
  it('each organization uses its own key; usage is tagged by course only, with no gateway fallbacks parameter', async () => {
    const a = await ask('learnerA', convA);
    expect(a.statusCode).toBe(200);
    expect(done(a.payload).status).toBe('insufficient_evidence');
    const chatA = lastChat();
    expect(chatA.auth).toBe(`Bearer ${KEY_A}`);
    expect(chatA.body).toMatchObject({ model: MODEL, metadata: { tags: [`course:${course.A.id}`, 'purpose:coach_answer'] } });
    expect(chatA.body).not.toHaveProperty('fallbacks');
    for (const secret of ['learnerA@aik.test', U.learnerA, course.A.enrollment]) expect(JSON.stringify(chatA.body)).not.toContain(secret);

    const convB = (await call('POST', '/api/coach/conversations', 'learnerB', { enrollmentId: course.B.enrollment })).json().id;
    expect((await ask('learnerB', convB)).statusCode).toBe(200);
    expect(lastChat().auth).toBe(`Bearer ${KEY_B}`);

    const usage = await admin.query(`SELECT organization_id, provider, model, status FROM ai_usage_records ORDER BY occurred_at`);
    expect(usage.rows).toEqual([
      { organization_id: ORG_A, provider: 'litellm', model: MODEL, status: 'success' },
      { organization_id: ORG_B, provider: 'litellm', model: MODEL, status: 'success' },
    ]);
  });

  it('when the key’s budget is used up at the gateway, the coach is resting — not broken', async () => {
    budgetExceeded = true;
    try {
      const r = await ask('learnerA', convA);
      expect(done(r.payload)).toMatchObject({ status: 'fallback', answer: COACH_TEXT.resting });
      const u = await admin.query(`SELECT status, error_code FROM ai_usage_records ORDER BY occurred_at DESC LIMIT 1`);
      expect(u.rows[0]).toEqual({ status: 'error', error_code: 'quota' });
    } finally {
      budgetExceeded = false;
    }
  });

  it('a replaced key is used right away; removing it hides the coach again', async () => {
    await call('PUT', `/api/organizations/${ORG_A}/ai-credential`, 'platform', { alias: 'school-a-rotated', key: KEY_B });
    await ask('learnerA', convA);
    expect(lastChat().auth).toBe(`Bearer ${KEY_B}`);

    expect((await call('DELETE', `/api/organizations/${ORG_A}/ai-credential`, 'platform')).statusCode).toBe(204);
    expect((await call('GET', `/api/enrollments/${course.A.enrollment}/coach`, 'learnerA')).json()).toMatchObject({ available: false, reason: 'organization_key_missing' });
    expect((await call('DELETE', `/api/organizations/${ORG_A}/ai-credential`, 'platform')).statusCode).toBe(404);
    expect((await admin.query(`SELECT action FROM audit_logs WHERE action = 'org.ai_credential.removed'`)).rowCount).toBe(1);
  });
});

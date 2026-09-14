/**
 * AI 學習教練（Phase 3-3，SD §10、§6.19）：以腳本化的模型與固定的檢索結果驗證流程——
 * 對話歸屬、SSE 分階段（回答在驗證後才送出）、修正一次／拒絕／安全替代、保存與用量、去識別化、
 * 引用原文、不可用狀態（供應商、組織停用、額度）、教師測試。
 * 檢索本身已在 knowledge-retrieval 驗證；這裡以假的 KnowledgeRetriever 回傳真實的 chunk（V4 反查仍走資料庫）。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { MemoryObjectStorage, OBJECT_STORAGE } from '../../apps/api/src/common/object-storage.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { LLM_PROVIDER, ProviderError, type CompletionRequest, type CompletionResponse, type LlmProvider } from '../../apps/api/src/modules/ai-coach/infrastructure/llm-provider.js';
import { KNOWLEDGE_RETRIEVER, type KnowledgeRetriever } from '../../apps/api/src/modules/knowledge/knowledge.contracts.js';
import { Dispatcher } from '../../apps/worker/src/dispatcher.js';
import { DocumentParseHandler } from '../../apps/worker/src/handlers/document-parse.js';
import { COACH_TEXT } from '../../packages/contracts/src/coach.js';
import type { RetrievedChunk, RetrieveScope } from '../../packages/domain/src/knowledge/search.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'cch-e2e-secret-cch-e2e-secret-cch-e2e';
const FINGERPRINT = 'sha256:e2e-cch';
const ORG = 'c7c7c7c7-0000-0000-0000-00000000000a';
const U = {
  admin: 'c8c8c8c8-0000-0000-0000-00000000000a',
  instr: 'c8c8c8c8-0000-0000-0000-0000000000c1',
  me: 'c8c8c8c8-0000-0000-0000-0000000000d1',
  other: 'c8c8c8c8-0000-0000-0000-0000000000d2',
};
const NAMES: Record<keyof typeof U, string> = { admin: '管理員', instr: '陳老師', me: '林同學', other: '王小明' };
const ACT = randomUUID();
const MD = Buffer.from('# 麵包製作\n\n麵包需要麵粉、水、酵母與鹽。\n\n## 發酵\n\n發酵溫度要控制在 26 度，時間約一小時。\n', 'utf8');

type Step = string | Error | 'REFUSE';
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-1';
  available = true;
  requests: CompletionRequest[] = [];
  script: Step[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    const done = { promptTokens: 100, completionTokens: 50, model: this.model, latencyMs: 5 };
    return next === 'REFUSE' ? { ...done, content: '', finishReason: 'refusal' } : { ...done, content: next, finishReason: 'stop' };
  }
}

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
let workerPool: pg.Pool;
let dispatcher: Dispatcher;
const mem = new MemoryObjectStorage();
const provider = new ScriptedProvider();
const scopes: RetrieveScope[] = [];
let retrieveNothing = false;
let extraChunks: RetrievedChunk[] = [];
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let v1 = '';
let vB = '';
let myEnr = '';
let otherEnr = '';
let convId = '';
let chunkFerment = '';
let citationId = '';
let courseA = '';
let resultConv = '';

/** 這些課程版本綁定的真實 chunk（內容取自物件儲存的 extracted.txt） */
async function chunksFor(courseVersionIds: readonly string[]): Promise<RetrievedChunk[]> {
  const rows = await admin.query(
    `SELECT m.chunk_id, m.document_version_id, m.page_no, m.section_path, m.char_start, m.char_end, sd.id AS document_id, sd.title, sd.organization_id, o.storage_prefix
       FROM knowledge_chunk_manifest m JOIN document_versions dv ON dv.id = m.document_version_id
       JOIN source_documents sd ON sd.id = dv.source_document_id JOIN organizations o ON o.id = sd.organization_id
       JOIN knowledge_bindings kb ON kb.document_version_id = m.document_version_id
      WHERE kb.course_version_id = ANY($1::uuid[]) ORDER BY m.chunk_index`,
    [courseVersionIds],
  );
  return Promise.all(
    rows.rows.map(async (r) => {
      const text = (await mem.get(`${r.storage_prefix}/documents/${r.organization_id}/${r.document_id}/${r.document_version_id}/extracted.txt`)).toString('utf8');
      return {
        chunkId: r.chunk_id,
        documentId: r.document_id,
        documentVersionId: r.document_version_id,
        title: r.title,
        content: text.slice(r.char_start, r.char_end),
        pageNo: r.page_no,
        sectionPath: r.section_path,
        charStart: r.char_start,
        charEnd: r.char_end,
        knowledgeType: 'source',
        verificationStatus: 'source',
        aclScope: 'course',
        rawScore: 1,
        weightedScore: 1,
      } satisfies RetrievedChunk;
    }),
  );
}

const retriever: KnowledgeRetriever = {
  available: true,
  async retrieve(_params, scope) {
    scopes.push(scope);
    if (retrieveNothing) return [];
    return [...(await chunksFor(scope.courseVersionIds)), ...extraChunks];
  },
};

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const auth = (who: keyof typeof U) => ({ cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf });
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: keyof typeof U, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: auth(who) });
const drain = async () => {
  while (await dispatcher.tick());
};

interface SseEvent {
  event: string;
  data: Record<string, unknown> & { status?: string; answer?: string; citations?: { id: string; citationId: string; title: string }[] };
}
function parseSse(payload: string): SseEvent[] {
  return payload
    .split('\n\n')
    .filter((b) => b.trim() && !b.startsWith(':'))
    .map((b) => ({ event: /^event: (.+)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.+)$/m.exec(b)![1]!) }));
}
const ask = async (content: string, who: keyof typeof U = 'me', conversation = convId) => {
  const r = await call('POST', `/api/coach/conversations/${conversation}/messages`, who, { content });
  return { status: r.statusCode, events: r.statusCode === 200 ? parseSse(r.payload) : [], json: r.statusCode === 200 ? null : r.json() };
};
const done = (events: SseEvent[]) => events.find((e) => e.event === 'done')!.data;
const lastAssistant = async () =>
  (await admin.query(`SELECT validation_status, fallback_reason, citation_count FROM coach_messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY seq_no DESC LIMIT 1`, [convId])).rows[0];

const answer = (chunkId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: 'answered',
    answer: '想想看教材中建議的發酵溫度 [c1]',
    citations: [{ citation_id: 'c1', chunk_id: chunkId, quote: '發酵溫度要控制在 26 度' }],
    follow_up_questions: ['溫度太高會怎樣？'],
    directness_level: 1,
    ...extra,
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-cc', '教練測試學苑', 'cc')`, [ORG]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@coach.test`, NAMES[k]]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', 'me', 'other'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  // 授權須含 ai_coach 功能（aiCoachAllowed）
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-cch', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{"ai_coach": true}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
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
        LICENSE_FINGERPRINT_OVERRIDE: FINGERPRINT,
      }),
    )
    .overrideProvider(OBJECT_STORAGE)
    .useValue(mem)
    .overrideProvider(LLM_PROVIDER)
    .useValue(provider)
    .overrideProvider(KNOWLEDGE_RETRIEVER)
    .useValue(retriever)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  workerPool = new pg.Pool({ connectionString: `postgres://app_worker:${PW.worker_pw}@${h}:${p}/iac` });
  dispatcher = new Dispatcher(workerPool, pino({ level: 'silent' }), { workerId: 'e2e', queues: ['ingest'] })
    .register(new DocumentParseHandler(workerPool, mem))
    .register({ jobType: 'document.embed_index', timeoutMs: 1000, handle: async () => undefined })
    .register({ jobType: 'document.sync_bindings', timeoutMs: 1000, handle: async () => undefined });

  const makeCourse = async (title: string, activityId: string) => {
    const id = (await call('POST', '/api/courses', 'admin', { title })).json().id as string;
    await call('POST', `/api/courses/${id}/staff`, 'admin', { email: 'instr@coach.test', role: 'instructor' });
    const v = (await call('POST', `/api/courses/${id}/versions`, 'instr', { title: 'v1' })).json().id as string;
    await call('PATCH', `/api/course-versions/${v}`, 'instr', {
      modules: [{ id: randomUUID(), title: '單元', lessons: [{ id: randomUUID(), title: '發酵', activities: [{ id: activityId, title: '溫度測驗', activityType: 'reading' }] }] }],
    });
    await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', { rule: { operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }] } });
    const up = await app.inject({
      method: 'POST',
      url: `/api/course-versions/${v}/knowledge/documents?filename=${encodeURIComponent('講義.md')}`,
      payload: MD,
      headers: { ...auth('instr'), 'content-type': 'application/octet-stream' },
    });
    expect(up.statusCode).toBe(202);
    return { id, v };
  };
  const a = await makeCourse('烘焙入門', ACT);
  v1 = a.v;
  courseA = a.id;
  const b = await makeCourse('另一門課', randomUUID());
  vB = b.v;
  await drain();
  // 索引（3-2）不在這個測試範圍：直接視為完成
  await admin.query(`UPDATE document_versions SET status = 'ready'`);
  expect((await call('POST', `/api/course-versions/${v1}/publish`, 'instr')).statusCode).toBe(200);
  myEnr = (await call('POST', `/api/courses/${a.id}/enrollments`, 'admin', { email: 'me@coach.test' })).json().id;
  otherEnr = (await call('POST', `/api/courses/${a.id}/enrollments`, 'admin', { email: 'other@coach.test' })).json().id;
  chunkFerment = (await chunksFor([v1])).find((c) => c.sectionPath === '麵包製作 > 發酵')!.chunkId;
}, 180_000);

// 問答有每人每分鐘上限；每個測試從零開始計
beforeEach(async () => {
  await admin.query(`DELETE FROM rate_limit_counters`);
});

afterAll(async () => {
  await app?.close();
  await workerPool?.end();
  await admin?.end();
  await container?.stop();
});

describe('conversations belong to the learner', () => {
  it('shows availability and creates a conversation on the learner’s own enrollment only', async () => {
    const av = await call('GET', `/api/enrollments/${myEnr}/coach`, 'me');
    expect(av.json()).toEqual({ available: true, reason: null, conversations: [] });
    expect((await call('GET', `/api/enrollments/${myEnr}/coach`, 'other')).statusCode).toBe(404);
    expect((await call('POST', '/api/coach/conversations', 'me', { enrollmentId: otherEnr })).statusCode).toBe(404);

    const c = await call('POST', '/api/coach/conversations', 'me', { enrollmentId: myEnr, activityId: ACT });
    expect(c.statusCode).toBe(201);
    convId = c.json().id;
    expect(c.json()).toMatchObject({ enrollmentId: myEnr, courseVersionId: v1, activityId: ACT, isTest: false, messages: [] });
    expect((await call('GET', `/api/coach/conversations/${convId}`, 'other')).statusCode).toBe(404);
    expect((await call('POST', '/api/coach/conversations', 'me', { enrollmentId: myEnr, activityId: randomUUID() })).json().error.code).toBe('VALIDATION_FAILED');
  });

  it('stamps the organization’s transcript policy at creation; changing it later does not rewrite old conversations', async () => {
    expect((await admin.query(`SELECT transcript_visibility FROM coach_conversations WHERE id = $1`, [convId])).rows[0].transcript_visibility).toBe('aggregate_only');
    const put = await call('PUT', `/api/organizations/${ORG}/coach-settings`, 'admin', { transcriptVisibility: 'course_staff' });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ enabled: true, transcriptVisibility: 'course_staff', providerConfigured: true });
    expect((await call('PUT', `/api/organizations/${ORG}/coach-settings`, 'me', { enabled: false })).statusCode).toBe(403);
    const c2 = (await call('POST', '/api/coach/conversations', 'me', { enrollmentId: myEnr })).json().id;
    const rows = await admin.query(`SELECT id, transcript_visibility FROM coach_conversations WHERE id = ANY($1::uuid[])`, [[convId, c2]]);
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.transcript_visibility]))).toEqual({ [convId]: 'aggregate_only', [c2]: 'course_staff' });
    expect(await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'org.coach_settings.updated'`)).toMatchObject({ rowCount: 1 });
  });
});

describe('answering', () => {
  it('streams stages and sources first; the answer text arrives only after validation', async () => {
    provider.script = [answer(chunkFerment)];
    const r = await ask('發酵溫度是多少？');
    expect(r.status).toBe(200);
    const names = r.events.map((e) => e.event);
    expect(names.slice(0, 4)).toEqual(['stage', 'sources', 'stage', 'stage']);
    expect(r.events[3]!.data).toEqual({ stage: 'validating' });
    expect(names.indexOf('token')).toBeGreaterThan(3);
    expect(names.at(-1)).toBe('done');
    const d = done(r.events);
    expect(d).toMatchObject({ conversationId: convId, status: 'answered', answer: '想想看教材中建議的發酵溫度 [c1]', followUpQuestions: ['溫度太高會怎樣？'], disclaimer: COACH_TEXT.disclaimer });
    expect(d.citations).toMatchObject([{ citationId: 'c1', title: '講義' }]);
    citationId = d.citations![0]!.id;
    expect(r.events.filter((e) => e.event === 'token').map((e) => e.data['delta']).join('')).toBe(d.answer);

    // 檢索範圍由伺服器決定：這個組織、這個課程版本
    expect(scopes.at(-1)).toEqual({ organizationId: ORG, courseVersionIds: [v1], allowedVerificationStatuses: ['source', 'verified'], aclScopes: ['course', 'organization'] });
    expect(await lastAssistant()).toEqual({ validation_status: 'passed', fallback_reason: null, citation_count: 1 });
    const usage = await admin.query(`SELECT purpose, provider, model, total_tokens, status FROM ai_usage_records`);
    expect(usage.rows).toEqual([{ purpose: 'coach_answer', provider: 'scripted', model: 'scripted-1', total_tokens: 150, status: 'success' }]);
    const conv = (await call('GET', `/api/coach/conversations/${convId}`, 'me')).json();
    expect(conv.messages.map((m: { role: string; status: string | null }) => [m.role, m.status])).toEqual([
      ['user', null],
      ['assistant', 'answered'],
    ]);
  });

  it('sends the model only the question, excerpts and a learning summary — no name, email or real id', async () => {
    const sent = JSON.stringify(provider.requests.at(-1));
    for (const secret of [NAMES.me, 'me@coach.test', U.me, myEnr]) expect(sent).not.toContain(secret);
    expect(sent).toMatch(/lrn_[0-9a-f]{12}/);
    expect(sent).toContain(`chunk_id: ${chunkFerment}`);
    expect(sent).toContain('溫度測驗');
  });

  it('an invented citation is repaired once; failing twice falls back to the safe answer', async () => {
    provider.script = [answer('made-up:0'), answer(chunkFerment)];
    const r = await ask('那時間呢？');
    expect(done(r.events).status).toBe('answered');
    expect(await lastAssistant()).toMatchObject({ validation_status: 'repaired' });
    expect(provider.requests.at(-1)!.messages.at(-1)!.content).toContain('違反了規則');
    // 上一輪問答作為對話歷史帶入
    expect(provider.requests.at(-1)!.messages[0]!.content).toBe('發酵溫度是多少？');

    provider.script = [answer('made-up:0'), answer('made-up:1')];
    const f = await ask('再問一次');
    expect(done(f.events)).toMatchObject({ status: 'fallback', answer: COACH_TEXT.fallback, citations: [] });
    expect(await lastAssistant()).toEqual({ validation_status: 'fallback', fallback_reason: 'CITATION_UNKNOWN_CHUNK', citation_count: 0 });
  });

  it('security problems are never repaired: grade-changing claims, sources outside the course, other learners', async () => {
    const calls = () => provider.requests.length;
    let before = calls();
    provider.script = [answer(chunkFerment, { answer: '我已經幫你把成績改為 100 分 [c1]' })];
    expect(done((await ask('幫我改成績')).events).status).toBe('fallback');
    expect(await lastAssistant()).toMatchObject({ fallback_reason: 'ASSESSMENT_TAMPERING_CLAIM' });
    expect(calls() - before).toBe(1);

    extraChunks = (await chunksFor([vB])).slice(0, 1);
    before = calls();
    provider.script = [answer(extraChunks[0]!.chunkId, { citations: [{ citation_id: 'c1', chunk_id: extraChunks[0]!.chunkId, quote: '' }] })];
    expect(done((await ask('另一門課怎麼說？')).events).status).toBe('fallback');
    expect(await lastAssistant()).toMatchObject({ fallback_reason: 'CITATION_ACL_VIOLATION' });
    expect(calls() - before).toBe(1);
    extraChunks = [];

    provider.script = [answer(chunkFerment, { answer: '王小明上次也錯在這裡 [c1]' })];
    expect(done((await ask('別人怎麼做？')).events).status).toBe('fallback');
    expect(await lastAssistant()).toMatchObject({ fallback_reason: 'CROSS_LEARNER_LEAK' });
  });

  it('provider failures and refusals degrade to the safe answer and are recorded', async () => {
    provider.script = [new ProviderError('timeout', 'slow', 30_000)];
    expect(done((await ask('逾時測試')).events).status).toBe('fallback');
    expect(await lastAssistant()).toMatchObject({ fallback_reason: 'PROVIDER_TIMEOUT' });
    expect((await admin.query(`SELECT status, latency_ms FROM ai_usage_records ORDER BY occurred_at DESC LIMIT 1`)).rows[0]).toEqual({ status: 'timeout', latency_ms: 30_000 });

    provider.script = ['REFUSE'];
    expect(done((await ask('拒答測試')).events).status).toBe('fallback');
    expect(await lastAssistant()).toMatchObject({ fallback_reason: 'MODEL_REFUSED' });
  });

  it('with no supporting material the coach says so without calling the model', async () => {
    retrieveNothing = true;
    const before = provider.requests.length;
    const r = await ask('火星上怎麼烤麵包？');
    retrieveNothing = false;
    expect(done(r.events)).toMatchObject({ status: 'insufficient_evidence', answer: COACH_TEXT.insufficientEvidence });
    expect(provider.requests.length).toBe(before);
  });
});

describe('citations', () => {
  it('the learner opens the cited passage in context; nobody else can', async () => {
    const r = await call('GET', `/api/coach/citations/${citationId}/source`, 'me');
    expect(r.statusCode).toBe(200);
    const src = r.json();
    expect(src).toMatchObject({ citationId: 'c1', title: '講義', sectionPath: '麵包製作 > 發酵' });
    expect(src.text.slice(src.highlightStart, src.highlightEnd)).toContain('發酵溫度要控制在 26 度');
    expect((await call('GET', `/api/coach/citations/${citationId}/source`, 'other')).statusCode).toBe(404);
    expect((await admin.query(`SELECT opened_count FROM coach_citations WHERE id = $1`, [citationId])).rows[0].opened_count).toBe(1);
  });
});

describe('when the coach cannot be used, the rest of the system is unaffected', () => {
  it('no provider configured', async () => {
    provider.available = false;
    try {
      const r = await ask('有人在嗎？');
      expect(r.status).toBe(503);
      expect(r.json).toMatchObject({ error: { code: 'COACH_PROVIDER_UNAVAILABLE', details: [{ issue: 'provider_unavailable' }] } });
      expect((await call('GET', `/api/enrollments/${myEnr}/coach`, 'me')).json()).toMatchObject({ available: false, reason: 'provider_unavailable' });
      expect((await call('GET', `/api/enrollments/${myEnr}/outline`, 'me')).statusCode).toBe(200);
    } finally {
      provider.available = true;
    }
  });

  it('the organization turned the coach off', async () => {
    await call('PUT', `/api/organizations/${ORG}/coach-settings`, 'admin', { enabled: false });
    try {
      expect((await ask('有人在嗎？')).json).toMatchObject({ error: { code: 'COACH_PROVIDER_UNAVAILABLE', details: [{ issue: 'disabled_by_organization' }] } });
      expect((await call('GET', `/api/enrollments/${myEnr}/coach`, 'me')).json()).toMatchObject({ available: false, reason: 'disabled_by_organization' });
    } finally {
      await call('PUT', `/api/organizations/${ORG}/coach-settings`, 'admin', { enabled: true });
    }
  });

  it('the organization’s daily token budget is used up', async () => {
    await admin.query(`INSERT INTO ai_usage_records (organization_id, purpose, provider, model, prompt_tokens, status) VALUES ($1, 'coach_answer', 'x', 'x', 10000000, 'success')`, [ORG]);
    try {
      const r = await ask('還能問嗎？');
      expect(r.status).toBe(429);
      expect(r.json.error.code).toBe('AI_QUOTA_EXCEEDED');
    } finally {
      await admin.query(`DELETE FROM ai_usage_records WHERE prompt_tokens = 10000000`);
    }
  });
});

describe('teacher test mode', () => {
  it('teachers try the coach on a course version as themselves; learners cannot', async () => {
    provider.script = [answer(chunkFerment)];
    const r = await call('POST', `/api/course-versions/${v1}/coach/test`, 'instr', { content: '學員可能會問：發酵溫度？' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'answered', citations: [{ citationId: 'c1' }] });
    const conv = await admin.query(`SELECT is_test, enrollment_id, learner_id, trigger_type FROM coach_conversations WHERE id = $1`, [r.json().conversationId]);
    expect(conv.rows[0]).toEqual({ is_test: true, enrollment_id: null, learner_id: U.instr, trigger_type: 'instructor_test' });
    // 延續同一段測試對話
    provider.script = [answer(chunkFerment)];
    const again = await call('POST', `/api/course-versions/${v1}/coach/test`, 'instr', { content: '再問一次', conversationId: r.json().conversationId });
    expect(again.json().conversationId).toBe(r.json().conversationId);
    expect((await call('POST', `/api/course-versions/${v1}/coach/test`, 'me', { content: 'x' })).statusCode).toBe(403);
    // 教師也能開啟測試回答的引用
    expect((await call('GET', `/api/coach/citations/${r.json().citations[0].id}/source`, 'instr')).statusCode).toBe(200);
  });
});

describe('result-triggered coaching (SD §6.21)', () => {
  it('the learner asks about a result; the question is generated from the result, never from the answers', async () => {
    const attempt = (await call('POST', `/api/activities/${ACT}/attempts`, 'me')).json().attemptId as string;
    expect((await call('POST', `/api/attempts/${attempt}/submit`, 'me', { input: {} })).statusCode).toBe(200);
    provider.script = [answer(chunkFerment)];
    const r = await call('POST', '/api/coach/from-result', 'me', { attemptId: attempt });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'answered', citations: [{ citationId: 'c1' }] });
    resultConv = r.json().conversationId;
    const conv = await admin.query(`SELECT trigger_type, activity_id, transcript_visibility FROM coach_conversations WHERE id = $1`, [resultConv]);
    expect(conv.rows[0]).toEqual({ trigger_type: 'result_trigger', activity_id: ACT, transcript_visibility: 'course_staff' });
    // 學員看得到系統替他送出的問題
    const msgs = (await call('GET', `/api/coach/conversations/${resultConv}`, 'me')).json().messages;
    expect(msgs[0].content).toMatch(/我剛完成「溫度測驗」，結果是「完成」/);
    expect(provider.requests.at(-1)!.messages.at(-1)!.content).toContain('"current_result":{"status":"completed"');
    // 別人的作答、尚未有結果的作答
    expect((await call('POST', '/api/coach/from-result', 'other', { attemptId: attempt })).statusCode).toBe(404);
    // 已完成的閱讀活動不能再開始作答：直接建一筆尚未送出的作答
    const open = (
      await admin.query<{ id: string }>(
        `INSERT INTO learning_attempts (organization_id, enrollment_id, activity_id, attempt_no, status) VALUES ($1, $2, $3, 99, 'in_progress') RETURNING id`,
        [ORG, myEnr, ACT],
      )
    ).rows[0]!.id;
    expect((await call('POST', '/api/coach/from-result', 'me', { attemptId: open })).json().error.code).toBe('RESULT_NOT_READY');
  });
});

describe('course staff insights (SD §6.21)', () => {
  it('usage statistics stay hidden until enough learners have used the coach', async () => {
    const hidden = (await call('GET', `/api/courses/${courseA}/coach/usage`, 'instr')).json();
    expect(hidden).toMatchObject({ belowThreshold: true, threshold: 5, learners: null, statuses: null, topDocuments: [], activities: [] });
    expect((await call('GET', `/api/courses/${courseA}/coach/usage`, 'me')).statusCode).toBe(403);

    await admin.query(`INSERT INTO system_settings (scope_type, scope_id, key, value) VALUES ('platform', NULL, 'derived.min_threshold', '1'::jsonb)`);
    try {
      const u = (await call('GET', `/api/courses/${courseA}/coach/usage`, 'instr')).json();
      const n = (await admin.query(`SELECT count(*)::int AS n FROM coach_conversations WHERE NOT is_test AND message_count > 0`)).rows[0].n;
      expect(u).toMatchObject({ belowThreshold: false, learners: 1, conversations: n, resultTriggered: 1, topDocuments: [{ title: '講義' }] });
      expect(u.statuses.answered).toBeGreaterThan(0);
      expect(u.statuses.fallback).toBeGreaterThan(0);
      expect(u.statuses.insufficient_evidence).toBe(1);
      expect(u.questions).toBe(Object.values(u.statuses as Record<string, number>).reduce((a, b) => a + b, 0));
      expect(u.activities).toMatchObject([{ activityId: ACT, title: '溫度測驗', learners: 1 }]);
    } finally {
      await admin.query(`DELETE FROM system_settings WHERE key = 'derived.min_threshold'`);
    }
  });

  it('transcripts are readable only when both the organization policy and the conversation stamp allow it; every read is audited', async () => {
    const list = await call('GET', `/api/courses/${courseA}/coach/conversations`, 'instr');
    expect(list.statusCode).toBe(200);
    const l = list.json();
    // convId 建立時組織尚未開放 → 不列出身分，只算在 hiddenCount；沒有訊息的對話不列
    expect(l).toMatchObject({ policy: 'course_staff', hiddenCount: 1 });
    expect(l.data).toMatchObject([{ id: resultConv, learnerId: U.me, learnerDisplayName: NAMES.me, triggerType: 'result_trigger', activityTitle: '溫度測驗' }]);
    expect((await call('GET', `/api/courses/${courseA}/coach/conversations`, 'me')).statusCode).toBe(403);

    const t = await call('GET', `/api/courses/${courseA}/coach/conversations/${resultConv}`, 'instr');
    expect(t.statusCode).toBe(200);
    expect(t.json().messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    const audit = await admin.query(`SELECT actor_user_id, metadata FROM audit_logs WHERE action = 'coach.transcript.read' ORDER BY occurred_at`);
    expect(audit.rows).toHaveLength(2);
    // 學員在自己的帳號活動看得到誰讀了他的對話
    expect(audit.rows[1]).toMatchObject({ actor_user_id: U.instr, metadata: { kind: 'transcript', learner_id: U.me } });

    const stamped = await call('GET', `/api/courses/${courseA}/coach/conversations/${convId}`, 'instr');
    expect(stamped.statusCode).toBe(403);
    expect(stamped.json().error).toMatchObject({ code: 'COACH_TRANSCRIPT_NOT_VISIBLE', details: [{ issue: 'conversation_stamp' }] });
    const testConv = (await admin.query(`SELECT id FROM coach_conversations WHERE is_test LIMIT 1`)).rows[0].id;
    expect((await call('GET', `/api/courses/${courseA}/coach/conversations/${testConv}`, 'instr')).statusCode).toBe(404);

    // 組織收回政策：連建立時可讀的對話也不可讀
    await call('PUT', `/api/organizations/${ORG}/coach-settings`, 'admin', { transcriptVisibility: 'aggregate_only' });
    expect((await call('GET', `/api/courses/${courseA}/coach/conversations/${resultConv}`, 'instr')).json().error.details[0].issue).toBe('organization_policy');
    expect((await call('GET', `/api/courses/${courseA}/coach/conversations`, 'instr')).json()).toEqual({ policy: 'aggregate_only', data: [], hiddenCount: 2 });
  });
});

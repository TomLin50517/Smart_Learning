/**
 * 教材檢索（Phase 3-2，SD §4、§6.18）：以真的 Elasticsearch 驗證——索引、中文 bigram 檢索、課程版本範圍、
 * 綁定改變後的同步、複製版本、上傳新版（舊版保留給已發布版本）、刪除。物件儲存以記憶體實作取代。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { MemoryObjectStorage, OBJECT_STORAGE } from '../../apps/api/src/common/object-storage.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { Dispatcher } from '../../apps/worker/src/dispatcher.js';
import { DocumentIndexHandler } from '../../apps/worker/src/handlers/document-index.js';
import { DocumentParseHandler } from '../../apps/worker/src/handlers/document-parse.js';
import { DocumentSyncHandler } from '../../apps/worker/src/handlers/document-sync.js';
import { createWorkerSearch } from '../../apps/worker/src/search.js';
import { applyMigrations } from '../../tools/migrate.js';
import { makePdf } from '../fixtures/make-pdf.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'rtv-e2e-secret-rtv-e2e-secret-rtv-e2e';
const FINGERPRINT = 'sha256:e2e-rtv';
const ORG = 'b7b7b7b7-0000-0000-0000-00000000000a';
const U = {
  admin: 'b8b8b8b8-0000-0000-0000-00000000000a',
  instr: 'b8b8b8b8-0000-0000-0000-0000000000c1',
  me: 'b8b8b8b8-0000-0000-0000-0000000000d1',
};
const MD = Buffer.from('# 麵包製作\n\n麵包需要麵粉、水、酵母與鹽。\n\n## 發酵\n\n發酵溫度要控制在 26 度，時間約一小時。\n\n## 烘烤\n\n烤箱預熱到 200 度。\n', 'utf8');
const MD_V2 = Buffer.from('# 麵包製作\n\n## 發酵\n\n修訂：發酵溫度改為 28 度。\n', 'utf8');
const PDF = makePdf(['Ingredients: flour and water', 'Baking takes thirty minutes']);

let pgc: StartedPostgreSqlContainer;
let es: StartedTestContainer;
let esUrl = '';
let admin: pg.Client;
let app: NestFastifyApplication;
let workerPool: pg.Pool;
let dispatcher: Dispatcher;
const mem = new MemoryObjectStorage();
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let courseA = '';
let v1 = '';
let vB = '';
let mdDoc = '';
let mdV1 = '';
let pdfV1 = '';
let bDoc = '';
let published = '';

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
const upload = (url: string, body: Buffer) => app.inject({ method: 'POST', url, payload: body, headers: { ...auth('instr'), 'content-type': 'application/octet-stream' } });
const uploadTo = async (version: string, filename: string, body: Buffer) => {
  const r = await upload(`/api/course-versions/${version}/knowledge/documents?filename=${encodeURIComponent(filename)}`, body);
  expect(r.statusCode).toBe(202);
  return r.json() as { id: string; documentId: string };
};
type Hit = { documentId: string; documentVersionId: string; pageNo: number | null; sectionPath: string | null; content: string };
const search = async (version: string, query: string) => {
  const r = await call('POST', `/api/course-versions/${version}/knowledge/search`, 'instr', { query });
  expect(r.statusCode).toBe(200);
  return r.json() as { hits: Hit[]; searchableDocuments: number; pendingDocuments: number };
};
const drain = async () => {
  while (await dispatcher.tick());
};
const indexed = async (documentVersionId: string): Promise<number> => {
  const r = await fetch(`${esUrl}/knowledge_chunks/_count`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: { term: { document_version_id: documentVersionId } } }) });
  return ((await r.json()) as { count: number }).count;
};
const status = async (id: string) => (await admin.query(`SELECT status FROM document_versions WHERE id = $1`, [id])).rows[0]?.status as string | undefined;

beforeAll(async () => {
  [pgc, es] = await Promise.all([
    new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start(),
    new GenericContainer('docker.elastic.co/elasticsearch/elasticsearch:9.0.0')
      .withEnvironment({ 'discovery.type': 'single-node', 'xpack.security.enabled': 'false', 'xpack.ml.enabled': 'false', ES_JAVA_OPTS: '-Xms512m -Xmx512m' })
      .withExposedPorts(9200)
      .withWaitStrategy(Wait.forHttp('/_cluster/health', 9200).forStatusCode(200))
      .withStartupTimeout(240_000)
      .start(),
  ]);
  esUrl = `http://${es.getHost()}:${es.getMappedPort(9200)}`;
  admin = new pg.Client({ connectionString: pgc.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-r', '檢索測試學苑', 'rt')`, [ORG]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@rtv.test`, k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', 'me'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-rtv', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) s[k] = await session(U[k]);

  const h = pgc.getHost();
  const p = pgc.getPort();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://app_api:${PW.api_pw}@${h}:${p}/iac`,
        DATABASE_URL_COACH: `postgres://app_coach:${PW.coach_pw}@${h}:${p}/iac`,
        SESSION_SECRET: SECRET,
        LICENSE_FINGERPRINT_OVERRIDE: FINGERPRINT,
        ELASTICSEARCH_URL: esUrl,
      }),
    )
    .overrideProvider(OBJECT_STORAGE)
    .useValue(mem)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  workerPool = new pg.Pool({ connectionString: `postgres://app_worker:${PW.worker_pw}@${h}:${p}/iac` });
  const esClient = createWorkerSearch({ ELASTICSEARCH_URL: esUrl, ELASTICSEARCH_API_KEY: '', ELASTICSEARCH_USERNAME: '', ELASTICSEARCH_PASSWORD: '' });
  dispatcher = new Dispatcher(workerPool, pino({ level: 'silent' }), { workerId: 'e2e', queues: ['ingest'] })
    .register(new DocumentParseHandler(workerPool, mem))
    .register(new DocumentIndexHandler(workerPool, mem, esClient))
    .register(new DocumentSyncHandler(workerPool, esClient));

  const makeCourse = async (title: string) => {
    const id = (await call('POST', '/api/courses', 'admin', { title })).json().id as string;
    await call('POST', `/api/courses/${id}/staff`, 'admin', { email: 'instr@rtv.test', role: 'instructor' });
    const v = (await call('POST', `/api/courses/${id}/versions`, 'instr', { title: 'v1' })).json().id as string;
    await call('PATCH', `/api/course-versions/${v}`, 'instr', {
      modules: [{ id: randomUUID(), title: '單元', lessons: [{ id: randomUUID(), title: '課節', activities: [{ id: randomUUID(), title: '閱讀', activityType: 'reading' }] }] }],
    });
    await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', { rule: { operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }] } });
    return { id, v };
  };
  ({ id: courseA, v: v1 } = await makeCourse('烘焙入門'));
  ({ v: vB } = await makeCourse('另一門課'));
}, 300_000);

afterAll(async () => {
  await app?.close();
  await workerPool?.end();
  await admin?.end();
  await Promise.all([pgc?.stop(), es?.stop()]);
});

describe('indexing', () => {
  it('indexes every chunk after parsing and marks the documents ready', async () => {
    const md = await uploadTo(v1, '烘焙講義.md', MD);
    mdDoc = md.documentId;
    mdV1 = md.id;
    pdfV1 = (await uploadTo(v1, 'recipe.pdf', PDF)).id;
    bDoc = (await uploadTo(vB, '另一門課.md', MD)).documentId;
    expect((await search(v1, '發酵')).pendingDocuments).toBe(2);
    await drain();

    for (const id of [mdV1, pdfV1]) {
      const r = await admin.query(`SELECT status, processed_at, chunk_count FROM document_versions WHERE id = $1`, [id]);
      expect(r.rows[0]).toMatchObject({ status: 'ready', processed_at: expect.any(Date) });
      expect(await indexed(id)).toBe(r.rows[0].chunk_count);
      expect(await admin.query(`SELECT 1 FROM knowledge_chunk_manifest WHERE document_version_id = $1 AND indexed_at IS NULL`, [id])).toMatchObject({ rowCount: 0 });
    }
  });
});

describe('test search', () => {
  it('finds Chinese text without a word-segmentation plugin, with page and section for citations', async () => {
    const r = await search(v1, '發酵的溫度是多少');
    expect(r).toMatchObject({ searchableDocuments: 2, pendingDocuments: 0 });
    expect(r.hits[0]).toMatchObject({ documentId: mdDoc, documentVersionId: mdV1, sectionPath: '麵包製作 > 發酵', pageNo: null });
    expect(r.hits[0]!.content).toContain('26 度');
    const pdf = await search(v1, 'baking minutes');
    expect(pdf.hits[0]).toMatchObject({ documentVersionId: pdfV1, pageNo: 2 });
  });

  it('only searches the materials of this course version — never another course with the same text', async () => {
    const r = await search(v1, '發酵溫度');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.documentId !== bDoc)).toBe(true);
    expect((await search(vB, '發酵溫度')).hits.every((h) => h.documentId === bDoc)).toBe(true);
  });

  it('learners cannot use it; the question is validated', async () => {
    expect((await call('POST', `/api/course-versions/${v1}/knowledge/search`, 'me', { query: '發酵' })).statusCode).toBe(403);
    expect((await call('POST', `/api/course-versions/${v1}/knowledge/search`, 'instr', { query: '  ' })).json().error.code).toBe('VALIDATION_FAILED');
    expect((await call('POST', `/api/course-versions/${v1}/knowledge/search`, 'instr', { query: 'x', courseVersionIds: [vB] })).json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('keeping the index in step with course versions', () => {
  it('taking a document out of the draft removes it from results; adding it back restores it', async () => {
    await call('DELETE', `/api/course-versions/${v1}/knowledge/bindings/${mdV1}`, 'instr');
    await drain();
    expect((await search(v1, '發酵溫度')).hits.some((h) => h.documentId === mdDoc)).toBe(false);
    await call('POST', `/api/course-versions/${v1}/knowledge/bindings`, 'instr', { documentVersionId: mdV1 });
    await drain();
    expect((await search(v1, '發酵溫度')).hits.some((h) => h.documentId === mdDoc)).toBe(true);
  });

  it('a cloned version finds the same materials; a new document version replaces only the draft copy', async () => {
    expect((await call('POST', `/api/course-versions/${v1}/publish`, 'instr')).statusCode).toBe(200);
    const v2 = (await call('POST', `/api/course-versions/${v1}/clone`, 'instr', {})).json().id as string;
    await drain();
    expect((await search(v2, '發酵溫度')).hits.some((h) => h.documentVersionId === mdV1)).toBe(true);

    const nv = await upload(`/api/knowledge/documents/${mdDoc}/versions?filename=${encodeURIComponent('烘焙講義-修訂.md')}`, MD_V2);
    expect(nv.statusCode).toBe(202);
    const mdV2 = nv.json().id as string;
    await drain();
    expect(await status(mdV2)).toBe('ready');
    expect(await status(mdV1)).toBe('superseded');

    // 草稿（v2）只看到新版；已發布的 v1 仍引用舊版（舊學員的引用不失效）
    const inV2 = await search(v2, '發酵溫度');
    expect(inV2.hits.some((h) => h.documentVersionId === mdV2)).toBe(true);
    expect(inV2.hits.some((h) => h.documentVersionId === mdV1)).toBe(false);
    const inV1 = await search(v1, '發酵溫度');
    expect(inV1.hits.some((h) => h.documentVersionId === mdV1)).toBe(true);
    expect(inV1.hits.some((h) => h.documentVersionId === mdV2)).toBe(false);

    // 被取代的版本仍可發布（內容仍在索引中，C3 接受 superseded）：草稿改回引用舊版後發布
    await call('DELETE', `/api/course-versions/${v2}/knowledge/bindings/${mdV2}`, 'instr');
    await call('POST', `/api/course-versions/${v2}/knowledge/bindings`, 'instr', { documentVersionId: mdV1 });
    const pub = await call('POST', `/api/course-versions/${v2}/publish`, 'instr');
    expect(pub.statusCode).toBe(200);
    published = v2;
  });

  it('deleting a document removes its chunks from the index', async () => {
    const draft = (await call('POST', `/api/course-versions/${published}/clone`, 'instr', {})).json().id as string;
    const t = await uploadTo(draft, 'temp.txt', Buffer.from('暫時的講義：發酵溫度說明。', 'utf8'));
    await drain();
    expect(await indexed(t.id)).toBe(1);
    expect((await call('DELETE', `/api/knowledge/documents/${t.documentId}`, 'instr')).statusCode).toBe(204);
    await drain();
    expect(await indexed(t.id)).toBe(0);
    expect(await admin.query(`SELECT 1 FROM job_queue WHERE status <> 'succeeded'`)).toMatchObject({ rowCount: 0 });
  });
});

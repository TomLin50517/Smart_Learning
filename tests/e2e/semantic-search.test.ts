/**
 * 語意檢索（SD §6.31）：以**真的 Elasticsearch** 驗證向量確實寫入索引、kNN 查得到、
 * RRF 合併後仍受四道範圍限制，以及 embedding 故障時退回 lexical。
 *
 * embedding 服務以假實作取代——真實的向量服務需要客戶的 gateway 與金鑰。
 * 假向量刻意讓「換句話說」可被驗證：查詢用的詞完全不在教材裡，只有語意相近。
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
import { EMBEDDING_CLIENT, type EmbeddingClient as ApiEmbeddingClient } from '../../apps/api/src/common/embedding.js';
import { MemoryObjectStorage, OBJECT_STORAGE } from '../../apps/api/src/common/object-storage.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { DISABLED_SCANNER } from '../../apps/worker/src/clamav.js';
import { Dispatcher } from '../../apps/worker/src/dispatcher.js';
import type { EmbeddingClient } from '../../apps/worker/src/embedding.js';
import { DocumentIndexHandler } from '../../apps/worker/src/handlers/document-index.js';
import { DocumentParseHandler } from '../../apps/worker/src/handlers/document-parse.js';
import { DISABLED_OCR } from '../../apps/worker/src/ocr.js';
import { createWorkerSearch } from '../../apps/worker/src/search.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'sem-e2e-secret-sem-e2e-secret-sem-e2e';
const FINGERPRINT = 'sha256:e2e-sem';
const ORG = 'd7d7d7d7-0000-0000-0000-00000000000a';
const U = {
  admin: 'd8d8d8d8-0000-0000-0000-00000000000a',
  instr: 'd8d8d8d8-0000-0000-0000-0000000000c1',
};

/**
 * 教材裡**沒有**「醒麵」「膨脹」這些詞，關鍵字檢索找不到；
 * 假向量把它們與「發酵」放在同一個方向，語意檢索才找得到。
 */
const MD = Buffer.from('# 麵包製作\n\n## 發酵\n\n發酵溫度要控制在 26 度，約一小時。\n\n## 烘烤\n\n烤箱預熱到 200 度後再放入。\n', 'utf8');
const DIMS = 3;
const DIRECTIONS: [RegExp, number[]][] = [
  [/發酵|醒麵|膨脹/, [1, 0, 0]],
  [/烘烤|烤箱|預熱/, [0, 1, 0]],
];
const vectorFor = (text: string): number[] => DIRECTIONS.find(([re]) => re.test(text))?.[1] ?? [0, 0, 1];

/** 切換成 true 時 api 端的向量化會失敗，檢索應自動退回 lexical */
let embeddingBroken = false;

let pgc: StartedPostgreSqlContainer;
let es: StartedTestContainer;
let esUrl = '';
let admin: pg.Client;
let app: NestFastifyApplication;
let workerPool: pg.Pool;
let dispatcher: Dispatcher;
const mem = new MemoryObjectStorage();
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let v1 = '';
let vOther = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const auth = (who: keyof typeof U) => ({ cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf });
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: keyof typeof U, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: auth(who) });
const uploadTo = (version: string, filename: string, body: Buffer) =>
  app.inject({
    method: 'POST',
    url: `/api/course-versions/${version}/knowledge/documents?filename=${encodeURIComponent(filename)}`,
    payload: body,
    headers: { ...auth('instr'), 'content-type': 'application/octet-stream' },
  });
const search = async (version: string, query: string) => (await call('POST', `/api/course-versions/${version}/knowledge/search`, 'instr', { query })).json();
const drain = async () => {
  while (await dispatcher.tick());
};

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

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-s', '語意測試學苑', 'st')`, [ORG]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@sem.test`, k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  // 先讓 instr 成為組織成員：沒有任何組織授權時，課程資源一律回 404（ADR-019）
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
    [U.instr, ORG],
  );
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-sem', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) s[k] = await session(U[k]);

  const apiEmbedding: ApiEmbeddingClient = {
    enabled: true,
    dimensions: DIMS,
    embedQuery: (text) => (embeddingBroken ? Promise.reject(new Error('embedding service is down')) : Promise.resolve(vectorFor(text))),
  };

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
    .overrideProvider(EMBEDDING_CLIENT)
    .useValue(apiEmbedding)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const workerEmbedding: EmbeddingClient = { enabled: true, dimensions: DIMS, embed: (texts) => Promise.resolve(texts.map(vectorFor)) };
  workerPool = new pg.Pool({ connectionString: `postgres://app_worker:${PW.worker_pw}@${h}:${p}/iac` });
  const esClient = createWorkerSearch({ ELASTICSEARCH_URL: esUrl, ELASTICSEARCH_API_KEY: '', ELASTICSEARCH_USERNAME: '', ELASTICSEARCH_PASSWORD: '' });
  dispatcher = new Dispatcher(workerPool, pino({ level: 'silent' }), { workerId: 'e2e', queues: ['ingest'] })
    .register(new DocumentParseHandler(workerPool, mem, { scanner: DISABLED_SCANNER, ocr: DISABLED_OCR }))
    .register(new DocumentIndexHandler(workerPool, mem, esClient, workerEmbedding))
    .register({ jobType: 'document.sync_bindings', timeoutMs: 1000, handle: async () => undefined })
    .register({ jobType: 'derived.index', timeoutMs: 1000, handle: async () => undefined });

  const makeCourse = async (title: string) => {
    const id = (await call('POST', '/api/courses', 'admin', { title })).json().id as string;
    await call('POST', `/api/courses/${id}/staff`, 'admin', { email: 'instr@sem.test', role: 'instructor' });
    const v = (await call('POST', `/api/courses/${id}/versions`, 'instr', { title: 'v1' })).json().id as string;
    await call('PATCH', `/api/course-versions/${v}`, 'instr', {
      modules: [{ id: randomUUID(), title: '單元', lessons: [{ id: randomUUID(), title: '課節', activities: [{ id: randomUUID(), title: '閱讀', activityType: 'reading' }] }] }],
    });
    return v;
  };
  v1 = await makeCourse('烘焙入門');
  vOther = await makeCourse('另一門課');

  await uploadTo(v1, '麵包講義.md', MD);
  await uploadTo(vOther, '別門課的講義.md', MD);
  await drain();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await workerPool?.end();
  await admin?.end();
  await Promise.all([pgc?.stop(), es?.stop()]);
});

describe('indexing writes vectors', () => {
  it('stores an embedding of the configured size on every chunk', async () => {
    const r = await fetch(`${esUrl}/knowledge_chunks/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: 50, _source: ['chunk_id', 'embedding'], query: { match_all: {} } }),
    });
    const body = (await r.json()) as { hits: { hits: { _source: { chunk_id: string; embedding?: number[] } }[] } };
    expect(body.hits.hits.length).toBeGreaterThan(0);
    for (const h of body.hits.hits) {
      expect(h._source.embedding, `chunk ${h._source.chunk_id} 沒有向量`).toHaveLength(DIMS);
    }
  });

  it('creates the index with a dense_vector field', async () => {
    const r = await fetch(`${esUrl}/knowledge_chunks/_mapping`);
    const body = (await r.json()) as Record<string, { mappings: { properties: Record<string, { type?: string; dims?: number; similarity?: string }> } }>;
    const props = Object.values(body)[0]!.mappings.properties;
    expect(props['embedding']).toMatchObject({ type: 'dense_vector', dims: DIMS, similarity: 'cosine' });
  });
});

describe('semantic search finds what keywords cannot', () => {
  // 「醒麵」「膨脹」都不在教材裡，BM25 查不到；假向量把它們與「發酵」放在同一方向
  const QUESTION = '醒麵大概要多久才會膨脹';

  it('finds the fermentation section even though none of the words appear in it', async () => {
    embeddingBroken = false;
    const r = await search(v1, QUESTION);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.content).toContain('發酵溫度要控制在 26 度');
  });

  it('falls back to lexical when the embedding service is down — the same question then finds nothing', async () => {
    // 對照組：證明上一個測試的命中真的來自向量，而不是關鍵字
    embeddingBroken = true;
    try {
      expect((await search(v1, QUESTION)).hits).toHaveLength(0);
      // 關鍵字本來就找得到的問題，在降級後仍然找得到——服務故障不該讓教練完全失效
      expect((await search(v1, '發酵溫度')).hits.length).toBeGreaterThan(0);
    } finally {
      embeddingBroken = false;
    }
  });

  it('never crosses into another course version (INV-T6 also applies to kNN)', async () => {
    // 另一門課有一模一樣的教材，向量也完全相同——只能靠範圍 filter 擋住
    const mine = await search(v1, QUESTION);
    const theirs = await search(vOther, QUESTION);
    expect(mine.hits.length).toBeGreaterThan(0);
    expect(theirs.hits.length).toBeGreaterThan(0);
    const mineIds = new Set(mine.hits.map((h: { documentId: string }) => h.documentId));
    expect(theirs.hits.every((h: { documentId: string }) => !mineIds.has(h.documentId))).toBe(true);
  });
});

/**
 * 教材上傳與解析（Phase 3-1，SA UC-KNW-001～003、SEQ-06、§7.4；SD §6.17）：
 * 串流上傳 → 檔頭判斷格式 → quarantine → worker 擷取文字、切段 → 預覽 → 重試 → 綁定／新版／刪除。
 * 物件儲存以記憶體實作取代（api 與 worker 共用同一個實例）。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { MemoryObjectStorage, OBJECT_STORAGE } from '../../apps/api/src/common/object-storage.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { DISABLED_SCANNER, ScanUnavailableError, type MalwareScanner } from '../../apps/worker/src/clamav.js';
import { Dispatcher } from '../../apps/worker/src/dispatcher.js';
import { DocumentParseHandler } from '../../apps/worker/src/handlers/document-parse.js';
import { DISABLED_OCR, type OcrEngine } from '../../apps/worker/src/ocr.js';
import { applyMigrations } from '../../tools/migrate.js';
import { makePdf } from '../fixtures/make-pdf.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'knw-e2e-secret-knw-e2e-secret-knw-e2e';
const FINGERPRINT = 'sha256:e2e-knw';
const ORG = 'a7a7a7a7-0000-0000-0000-00000000000a';
const U = {
  admin: 'a8a8a8a8-0000-0000-0000-00000000000a',
  instr: 'a8a8a8a8-0000-0000-0000-0000000000c1',
  me: 'a8a8a8a8-0000-0000-0000-0000000000d1',
};
const PDF = makePdf(['Fermentation needs 26 degrees', 'Baking at 200 degrees']);
const MD = Buffer.from('# 麵包製作\n\n導論。\n\n## 發酵\n\n溫度要控制在 26 度。\n', 'utf8');

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
let workerPool: pg.Pool;
let dispatcher: Dispatcher;
const mem = new MemoryObjectStorage();
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let courseId = '';
let v1 = '';
let pdfDoc = '';
let pdfV1 = '';
let mdDoc = '';
let mdV1 = '';

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
const upload = (url: string, who: keyof typeof U, body: Buffer) =>
  app.inject({ method: 'POST', url, payload: body, headers: { ...auth(who), 'content-type': 'application/octet-stream' } });
const uploadTo = (version: string, filename: string, body: Buffer, who: keyof typeof U = 'instr') =>
  upload(`/api/course-versions/${version}/knowledge/documents?filename=${encodeURIComponent(filename)}`, who, body);
const knowledge = async (version: string) => (await call('GET', `/api/course-versions/${version}/knowledge`, 'instr')).json();
const drain = async () => {
  while (await dispatcher.tick());
};
const count = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rowCount;
/**
 * beforeAll 註冊的 dispatcher 用的是停用掃描與 OCR 的 handler；掃毒與 OCR 的測試需要
 * 指定結果的假實作，因此直接跑 handler 而不經過 dispatcher。
 */
const parseWith = async (opts: { scanner: MalwareScanner; ocr: OcrEngine }, versionId: string): Promise<void> => {
  const j = (await admin.query<{ id: string; payload: Record<string, unknown> }>(`SELECT id, payload FROM job_queue WHERE idempotency_key = $1`, [`parse:${versionId}`])).rows[0]!;
  await new DocumentParseHandler(workerPool, mem, opts).handle({
    id: j.id,
    job_type: 'document.parse',
    queue: 'ingest',
    payload: j.payload,
    attempts: 1,
    max_attempts: 3,
    organization_id: ORG,
    correlation_id: null,
  });
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-k', '教材測試學苑', 'kt')`, [ORG]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@knw.test`, k]);
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
     VALUES ('lic-knw', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
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
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // worker 以自己的 DB 角色（app_worker）執行。這個測試只驗證上傳與解析：索引與綁定同步
  // （需要 Elasticsearch）以空 handler 承接，見 knowledge-retrieval.test.ts
  workerPool = new pg.Pool({ connectionString: `postgres://app_worker:${PW.worker_pw}@${h}:${p}/iac` });
  dispatcher = new Dispatcher(workerPool, pino({ level: 'silent' }), { workerId: 'e2e', queues: ['ingest'] })
    .register(new DocumentParseHandler(workerPool, mem, { scanner: DISABLED_SCANNER, ocr: DISABLED_OCR }))
    .register({ jobType: 'document.embed_index', timeoutMs: 1000, handle: async () => undefined })
    .register({ jobType: 'document.sync_bindings', timeoutMs: 1000, handle: async () => undefined });

  courseId = (await call('POST', '/api/courses', 'admin', { title: '烘焙入門' })).json().id;
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@knw.test', role: 'instructor' });
  v1 = (await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v1' })).json().id;
  await call('PATCH', `/api/course-versions/${v1}`, 'instr', {
    modules: [{ id: randomUUID(), title: '單元', lessons: [{ id: randomUUID(), title: '課節', activities: [{ id: randomUUID(), title: '閱讀', activityType: 'reading' }] }] }],
  });
  await call('PUT', `/api/course-versions/${v1}/completion-rules`, 'instr', { rule: { operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }] } });
});

afterAll(async () => {
  await app?.close();
  await workerPool?.end();
  await admin?.end();
  await container?.stop();
});

describe('upload', () => {
  it('stores the file in quarantine under an opaque key, binds it to the draft and queues parsing', async () => {
    const r = await uploadTo(v1, '麵包講義.pdf', PDF);
    expect(r.statusCode).toBe(202);
    const v = r.json();
    expect(v).toMatchObject({ status: 'uploaded', versionNo: 1, originalFilename: '麵包講義.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length, pageCount: null });
    pdfDoc = v.documentId;
    pdfV1 = v.id;
    expect([...mem.objects.keys()]).toEqual([`kt/quarantine/${ORG}/${pdfDoc}/${pdfV1}/original.bin`]);
    expect(mem.objects.get(`kt/quarantine/${ORG}/${pdfDoc}/${pdfV1}/original.bin`)!.body.equals(PDF)).toBe(true);
    const jobs = await admin.query(`SELECT job_type, queue, idempotency_key FROM job_queue`);
    expect(jobs.rows).toEqual([{ job_type: 'document.parse', queue: 'ingest', idempotency_key: `parse:${pdfV1}` }]);
    const k = await knowledge(v1);
    expect(k).toMatchObject({ editable: true, available: [] });
    expect(k.bound).toMatchObject([{ documentId: pdfDoc, title: '麵包講義', boundVersion: { id: pdfV1 }, latestVersion: { id: pdfV1 } }]);
    const audit = await admin.query(`SELECT resource_id, after_state FROM audit_logs WHERE action = 'knowledge.document.uploaded'`);
    expect(audit.rows).toMatchObject([{ resource_id: pdfV1, after_state: { documentId: pdfDoc, courseVersionId: v1 } }]);
  });

  it('judges the format by the file header and rejects anything else, leaving nothing behind', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect((await uploadTo(v1, 'photo.png', png)).json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect((await uploadTo(v1, 'fake.txt', Buffer.from([0x68, 0x00, 0x69]))).statusCode).toBe(415);
    expect((await uploadTo(v1, 'archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).statusCode).toBe(415);
    // 以 JSON 送出（不是檔案本體）
    expect((await call('POST', `/api/course-versions/${v1}/knowledge/documents?filename=a.txt`, 'instr', { text: 'hi' })).statusCode).toBe(415);
    expect((await upload(`/api/course-versions/${v1}/knowledge/documents`, 'instr', PDF)).json().error.code).toBe('VALIDATION_FAILED');
    expect((await uploadTo(v1, 'empty.txt', Buffer.alloc(0))).json().error.code).toBe('VALIDATION_FAILED');
    expect(mem.objects.size).toBe(1);
    expect(await count(`SELECT 1 FROM source_documents`)).toBe(1);
  });

  it('learners cannot upload, list or preview course materials', async () => {
    expect((await uploadTo(v1, 'x.pdf', PDF, 'me')).statusCode).toBe(403);
    expect((await call('GET', `/api/course-versions/${v1}/knowledge`, 'me')).statusCode).toBe(403);
    expect((await call('GET', `/api/knowledge/documents/${pdfDoc}/versions/${pdfV1}/view`, 'me')).statusCode).toBe(403);
  });

  it('enforces the platform upload limit while streaming', async () => {
    await admin.query(`INSERT INTO system_settings (scope_type, scope_id, key, value) VALUES ('platform', NULL, 'upload.max_size', '1048576'::jsonb)`);
    try {
      const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_200_000, 0x20)]);
      expect((await uploadTo(v1, 'big.pdf', big)).json().error.code).toBe('UPLOAD_TOO_LARGE');
      expect(mem.objects.size).toBe(1);
      expect(await count(`SELECT 1 FROM document_versions`)).toBe(1);
    } finally {
      await admin.query(`DELETE FROM system_settings WHERE key = 'upload.max_size'`);
    }
  });
});

describe('parsing (worker)', () => {
  it('moves the file out of quarantine, extracts each page and records chunk positions', async () => {
    const md = (await uploadTo(v1, 'notes.md', MD)).json();
    mdDoc = md.documentId;
    mdV1 = md.id;
    await drain();

    const dv = await admin.query(`SELECT status, page_count, chunk_count, failure_reason, object_key FROM document_versions WHERE id = $1`, [pdfV1]);
    expect(dv.rows[0]).toMatchObject({ status: 'indexing', page_count: 2, chunk_count: 2, failure_reason: null, object_key: `kt/documents/${ORG}/${pdfDoc}/${pdfV1}/original.bin` });
    const chunks = await admin.query(`SELECT chunk_id, chunk_index, page_no FROM knowledge_chunk_manifest WHERE document_version_id = $1 ORDER BY chunk_index`, [pdfV1]);
    expect(chunks.rows).toEqual([
      { chunk_id: `${pdfV1}:0`, chunk_index: 0, page_no: 1 },
      { chunk_id: `${pdfV1}:1`, chunk_index: 1, page_no: 2 },
    ]);
    const base = `kt/documents/${ORG}/${pdfDoc}/${pdfV1}`;
    expect([...mem.objects.keys()].filter((k) => k.includes(pdfV1)).sort()).toEqual([`${base}/extracted.txt`, `${base}/original.bin`, `${base}/pages/1.txt`, `${base}/pages/2.txt`]);
    expect([...mem.objects.keys()].some((k) => k.includes('/quarantine/'))).toBe(false);
    const idx = await admin.query(`SELECT payload FROM job_queue WHERE job_type = 'document.embed_index' AND payload->>'documentVersionId' = $1`, [pdfV1]);
    expect(idx.rows).toEqual([{ payload: { documentVersionId: pdfV1, fromChunkIndex: 0 } }]);

    // Markdown：沒有頁，標題形成章節路徑
    const mdChunks = await admin.query(`SELECT section_path, page_no FROM knowledge_chunk_manifest WHERE document_version_id = $1 ORDER BY chunk_index`, [mdV1]);
    expect(mdChunks.rows).toEqual([
      { section_path: '麵包製作', page_no: null },
      { section_path: '麵包製作 > 發酵', page_no: null },
    ]);
    expect((await admin.query(`SELECT page_count FROM document_versions WHERE id = $1`, [mdV1])).rows[0].page_count).toBeNull();
  });

  it('staff preview the extracted text page by page', async () => {
    const r = await call('GET', `/api/knowledge/documents/${pdfDoc}/versions/${pdfV1}/view?page=2`, 'instr');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ title: '麵包講義', page: 2, pageCount: 2, truncated: false });
    expect(r.json().text).toContain('Baking at 200 degrees');
    const md = (await call('GET', `/api/knowledge/documents/${mdDoc}/versions/${mdV1}/view`, 'instr')).json();
    expect(md).toMatchObject({ page: null, pageCount: null });
    expect(md.text).toContain('## 發酵');
  });

  it('content problems are recorded with a reason instead of retried, and can be retried by staff', async () => {
    const blank = (await uploadTo(v1, 'blank.txt', Buffer.from('   \n\n  '))).json();
    await drain();
    const dv = await admin.query(`SELECT status, failure_reason FROM document_versions WHERE id = $1`, [blank.id]);
    expect(dv.rows[0]).toEqual({ status: 'failed', failure_reason: 'no_text' });
    expect(await count(`SELECT 1 FROM audit_logs WHERE action = 'knowledge.document.failed' AND resource_id = $1`, [blank.id])).toBe(1);
    expect(await count(`SELECT 1 FROM failed_jobs`)).toBe(0);
    expect((await call('GET', `/api/knowledge/documents/${blank.documentId}/versions/${blank.id}/view`, 'instr')).json().error.details[0].issue).toBe('not_processed');

    const retry = await call('POST', `/api/knowledge/documents/${blank.documentId}/versions/${blank.id}/retry`, 'instr');
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ status: 'uploaded', failureReason: null });
    expect(await count(`SELECT 1 FROM job_queue WHERE job_type = 'document.parse' AND payload->>'documentVersionId' = $1`, [blank.id])).toBe(2);
    expect((await call('POST', `/api/knowledge/documents/${pdfDoc}/versions/${pdfV1}/retry`, 'instr')).json().error.details[0].issue).toBe('not_failed');

    // 刪除：資料列與物件一起清掉
    expect((await call('DELETE', `/api/knowledge/documents/${blank.documentId}`, 'instr')).statusCode).toBe(204);
    expect(await count(`SELECT 1 FROM source_documents WHERE id = $1`, [blank.documentId])).toBe(0);
    expect([...mem.objects.keys()].some((k) => k.includes(blank.documentId))).toBe(false);
    await drain();
  });
});

describe('malware scanning and zip bombs (SD §14、SA SEQ-06)', () => {
  // 用自己的課程與草稿版本：這裡會上傳數份被退件的教材，掛在 v1 上會影響
  // 其他 describe 對 v1 教材數量的斷言
  let secV = '';

  beforeAll(async () => {
    const c = (await call('POST', '/api/courses', 'admin', { title: '上傳安全測試' })).json().id;
    await call('POST', `/api/courses/${c}/staff`, 'admin', { email: 'instr@knw.test', role: 'instructor' });
    secV = (await call('POST', `/api/courses/${c}/versions`, 'instr', { title: 'v1' })).json().id;
  });

  /** 最小的 .docx 外形：zip 檔頭讓上傳端認得格式，central directory 宣告解壓後 1 GB */
  const zipBomb = (): Buffer => {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    const name = Buffer.from('word/document.xml', 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(1024, 20);
    central.writeUInt32LE(1024 * 1024 * 1024, 24);
    central.writeUInt16LE(name.length, 28);
    const dir = Buffer.concat([central, name]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(dir.length, 12);
    eocd.writeUInt32LE(local.length, 16);
    return Buffer.concat([local, dir, eocd]);
  };

  it('rejects an infected document and leaves it in quarantine', async () => {
    const up = (await uploadTo(secV, '有毒講義.pdf', PDF)).json();
    await parseWith({ scanner: { enabled: true, scan: () => Promise.resolve({ status: 'infected', signature: 'Eicar-Test-Signature' }) }, ocr: DISABLED_OCR }, up.id);

    const dv = (await admin.query<{ status: string; failure_reason: string }>(`SELECT status, failure_reason FROM document_versions WHERE id = $1`, [up.id])).rows[0]!;
    expect(dv).toEqual({ status: 'rejected', failure_reason: 'malware_detected: Eicar-Test-Signature' });
    // 沒有移出 quarantine，也沒有留下擷取文字或切段結果
    expect([...mem.objects.keys()].filter((k) => k.includes(up.id))).toEqual([`kt/quarantine/${ORG}/${up.documentId}/${up.id}/original.bin`]);
    expect(await count(`SELECT 1 FROM knowledge_chunk_manifest WHERE document_version_id = $1`, [up.id])).toBe(0);
    expect(await count(`SELECT 1 FROM audit_logs WHERE action = 'knowledge.document.failed' AND resource_id = $1`, [up.id])).toBe(1);
  });

  it('retries instead of letting the document through when the scanner is unavailable', async () => {
    // 「掃不到」絕不等於「乾淨」：必須往外丟讓 job 重試，教材留在 scanning
    const up = (await uploadTo(secV, '掃描服務中斷.pdf', PDF)).json();
    const down: MalwareScanner = { enabled: true, scan: () => Promise.reject(new ScanUnavailableError('clamd is down')) };
    await expect(parseWith({ scanner: down, ocr: DISABLED_OCR }, up.id)).rejects.toBeInstanceOf(ScanUnavailableError);
    expect((await admin.query<{ status: string }>(`SELECT status FROM document_versions WHERE id = $1`, [up.id])).rows[0]!.status).toBe('scanning');
    expect(await count(`SELECT 1 FROM knowledge_chunk_manifest WHERE document_version_id = $1`, [up.id])).toBe(0);
  });

  it('rejects a zip bomb before mammoth unpacks it', async () => {
    const up = (await uploadTo(secV, '炸彈.docx', zipBomb())).json();
    await parseWith({ scanner: DISABLED_SCANNER, ocr: DISABLED_OCR }, up.id);
    const dv = (await admin.query<{ status: string; failure_reason: string }>(`SELECT status, failure_reason FROM document_versions WHERE id = $1`, [up.id])).rows[0]!;
    expect(dv).toEqual({ status: 'rejected', failure_reason: 'zip_bomb' });
  });

  it('still parses normally when scanning is switched off', async () => {
    // 沒有 clamd 的部署不該因此無法使用教材
    const up = (await uploadTo(secV, '未啟用掃描.md', MD)).json();
    await parseWith({ scanner: DISABLED_SCANNER, ocr: DISABLED_OCR }, up.id);
    expect((await admin.query<{ status: string }>(`SELECT status FROM document_versions WHERE id = $1`, [up.id])).rows[0]!.status).toBe('indexing');
  });
});

describe('OCR for scanned PDFs (SD §6.30)', () => {
  // 沒有文字層的 PDF：makePdf 產生的文字內容為空，正是掃描版 PDF 會走到的那條路
  const scanned = () => makePdf(['']);
  const ocrOf = (text: string): OcrEngine => ({ enabled: true, recognize: () => Promise.resolve([{ pageNo: 1, text }]) });
  let ocrV = '';

  beforeAll(async () => {
    const c = (await call('POST', '/api/courses', 'admin', { title: 'OCR 測試' })).json().id;
    await call('POST', `/api/courses/${c}/staff`, 'admin', { email: 'instr@knw.test', role: 'instructor' });
    ocrV = (await call('POST', `/api/courses/${c}/versions`, 'instr', { title: 'v1' })).json().id;
  });

  it('uses the OCR text when the PDF has no text layer', async () => {
    const up = (await uploadTo(ocrV, '掃描版講義.pdf', scanned())).json();
    await parseWith({ scanner: DISABLED_SCANNER, ocr: ocrOf('發酵溫度要控制在 26 度。') }, up.id);

    expect((await admin.query<{ status: string }>(`SELECT status FROM document_versions WHERE id = $1`, [up.id])).rows[0]!.status).toBe('indexing');
    const extracted = mem.objects.get(`kt/documents/${ORG}/${up.documentId}/${up.id}/extracted.txt`);
    expect(extracted!.body.toString('utf8')).toContain('發酵溫度要控制在 26 度。');
    expect(await count(`SELECT 1 FROM knowledge_chunk_manifest WHERE document_version_id = $1`, [up.id])).toBe(1);
  });

  it('still reports no_text when OCR reads nothing', async () => {
    // OCR 讀不出東西不是系統錯誤，結果要與沒有 OCR 時一致
    const up = (await uploadTo(ocrV, '空白掃描.pdf', scanned())).json();
    await parseWith({ scanner: DISABLED_SCANNER, ocr: ocrOf('   \n  ') }, up.id);
    const dv = (await admin.query<{ status: string; failure_reason: string }>(`SELECT status, failure_reason FROM document_versions WHERE id = $1`, [up.id])).rows[0]!;
    expect(dv).toEqual({ status: 'failed', failure_reason: 'no_text' });
  });

  it('keeps the previous behaviour when OCR is switched off', async () => {
    const up = (await uploadTo(ocrV, '未啟用 OCR.pdf', scanned())).json();
    await parseWith({ scanner: DISABLED_SCANNER, ocr: DISABLED_OCR }, up.id);
    const dv = (await admin.query<{ status: string; failure_reason: string }>(`SELECT status, failure_reason FROM document_versions WHERE id = $1`, [up.id])).rows[0]!;
    expect(dv).toEqual({ status: 'failed', failure_reason: 'no_text' });
  });

  it('does not run OCR on Word files, only PDFs', async () => {
    // .docx 沒有文字層是內容問題，不該浪費時間跑 OCR
    const empty = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(60).fill(0)]);
    const up = (await uploadTo(ocrV, '壞檔.docx', empty)).json();
    let called = false;
    await parseWith({ scanner: DISABLED_SCANNER, ocr: { enabled: true, recognize: () => { called = true; return Promise.resolve([{ pageNo: 1, text: 'x' }]); } } }, up.id);
    expect(called).toBe(false);
    expect((await admin.query<{ status: string }>(`SELECT status FROM document_versions WHERE id = $1`, [up.id])).rows[0]!.status).toBe('rejected');
  });
});

describe('course versions', () => {
  it('a document can be taken out of the draft and added back', async () => {
    const out = await call('DELETE', `/api/course-versions/${v1}/knowledge/bindings/${mdV1}`, 'instr');
    expect(out.statusCode).toBe(200);
    expect(out.json().bound.map((b: { documentId: string }) => b.documentId)).toEqual([pdfDoc]);
    expect(out.json().available).toMatchObject([{ documentId: mdDoc, latestVersion: { id: mdV1 } }]);
    const back = await call('POST', `/api/course-versions/${v1}/knowledge/bindings`, 'instr', { documentVersionId: mdV1 });
    expect(back.statusCode).toBe(200);
    expect(back.json().bound).toHaveLength(2);
    expect((await call('POST', `/api/course-versions/${v1}/knowledge/bindings`, 'instr', { documentVersionId: mdV1 })).json().error.details[0].issue).toBe('document_already_bound');
  });

  it('published versions keep their documents; a new document version only moves the draft binding', async () => {
    // 3-2 之前索引不會完成：模擬索引完成，讓發布檢查 C3 通過
    await admin.query(`UPDATE document_versions SET status = 'ready'`);
    expect((await call('POST', `/api/course-versions/${v1}/publish`, 'instr')).statusCode).toBe(200);
    expect((await uploadTo(v1, 'late.pdf', PDF)).json().error.code).toBe('COURSE_VERSION_IMMUTABLE');
    expect((await call('DELETE', `/api/course-versions/${v1}/knowledge/bindings/${mdV1}`, 'instr')).json().error.code).toBe('COURSE_VERSION_IMMUTABLE');
    expect((await knowledge(v1)).editable).toBe(false);

    const v2 = (await call('POST', `/api/course-versions/${v1}/clone`, 'instr', {})).json().id as string;
    expect((await knowledge(v2)).bound).toHaveLength(2);

    const nv = await upload(`/api/knowledge/documents/${pdfDoc}/versions?filename=${encodeURIComponent('麵包講義-修訂.pdf')}`, 'instr', makePdf(['Fermentation needs 27 degrees']));
    expect(nv.statusCode).toBe(202);
    expect(nv.json()).toMatchObject({ versionNo: 2, status: 'uploaded' });
    const pdfV2 = nv.json().id as string;
    const pdfIn = (k: { bound: { documentId: string; boundVersion: { id: string }; latestVersion: { id: string } }[] }) => k.bound.find((b) => b.documentId === pdfDoc)!;
    expect(pdfIn(await knowledge(v2))).toMatchObject({ boundVersion: { id: pdfV2 }, latestVersion: { id: pdfV2 } });
    expect(pdfIn(await knowledge(v1))).toMatchObject({ boundVersion: { id: pdfV1 }, latestVersion: { id: pdfV2 } });

    const del = await call('DELETE', `/api/knowledge/documents/${pdfDoc}`, 'instr');
    expect(del.json().error.details[0].issue).toBe('document_in_use');
    expect(await count(`SELECT 1 FROM document_versions WHERE source_document_id = $1`, [pdfDoc])).toBe(2);
  });

  it('without a search service, test search reports it is unavailable instead of failing silently', async () => {
    const r = await call('POST', `/api/course-versions/${v1}/knowledge/search`, 'instr', { query: 'Baking' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('SOURCE_TEMPORARILY_UNAVAILABLE');
  });
});

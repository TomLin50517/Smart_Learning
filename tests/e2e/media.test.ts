/**
 * 課程素材（SD §6.23）：上傳與檔頭判斷、內容端點的存取檢查（課程人員／這門課的學員）、Range 與 ETag、
 * 發布檢查（素材必須屬於本課程且類型相符）、影片活動使用素材庫影片、被引用時不可刪。物件儲存以記憶體實作取代。
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
const SECRET = 'med-e2e-secret-med-e2e-secret-med-e2e';
const FINGERPRINT = 'sha256:e2e-med';
const ORG = 'f7f7f7f7-0000-0000-0000-00000000000a';
const U = {
  admin: 'f8f8f8f8-0000-0000-0000-00000000000a',
  instr: 'f8f8f8f8-0000-0000-0000-0000000000c1',
  me: 'f8f8f8f8-0000-0000-0000-0000000000d1',
  other: 'f8f8f8f8-0000-0000-0000-0000000000d2',
};
type Who = keyof typeof U;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), randomBytes(3000)]);
const VID = randomUUID();

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const mem = new MemoryObjectStorage();
const s = {} as Record<Who, { token: string; csrf: string }>;
let courseA = '';
let courseB = '';
let vA = '';
let png: { id: string; sizeBytes: number } = { id: '', sizeBytes: 0 };
let mp4: { id: string } = { id: '' };
let bImage = '';

async function session(who: Who) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [U[who], hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const auth = (who: Who) => ({ cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf });
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, who: Who, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: auth(who) });
const upload = (course: string, filename: string, body: Buffer, who: Who = 'instr', title?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/courses/${course}/assets?filename=${encodeURIComponent(filename)}${title ? `&title=${encodeURIComponent(title)}` : ''}`,
    payload: body,
    headers: { ...auth(who), 'content-type': 'application/octet-stream' },
  });
const content = (id: string, who: Who, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/api/assets/${id}/content`, headers: { ...auth(who), ...headers } });
const lesson = (blocks: object[], videoConfig: object) => ({
  modules: [
    {
      id: randomUUID(),
      title: '單元',
      lessons: [{ id: randomUUID(), title: '發酵', contentBlocks: blocks, activities: [{ id: VID, title: '看影片', activityType: 'video', config: videoConfig }] }],
    },
  ],
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-m', '素材測試學苑', 'fm')`, [ORG]);
  for (const who of Object.keys(U) as Who[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[who], `${who}@med.test`, who]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const who of ['instr', 'me', 'other'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[who], ORG],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-med', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
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
      }),
    )
    .overrideProvider(OBJECT_STORAGE)
    .useValue(mem)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const [title, set] of [
    ['烘焙入門', (id: string) => (courseA = id)],
    ['另一門課', (id: string) => (courseB = id)],
  ] as const) {
    const id = (await call('POST', '/api/courses', 'admin', { title })).json().id as string;
    await call('POST', `/api/courses/${id}/staff`, 'admin', { email: 'instr@med.test', role: 'instructor' });
    set(id);
  }
  vA = (await call('POST', `/api/courses/${courseA}/versions`, 'instr', { title: 'v1' })).json().id;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('uploading', () => {
  it('stores images and videos under an opaque key, judging the format by the file header', async () => {
    const r = await upload(courseA, 'diagram.png', PNG, 'instr', '示意圖');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ kind: 'image', mimeType: 'image/png', title: '示意圖', originalFilename: 'diagram.png', sizeBytes: PNG.length, usedBy: [] });
    png = r.json();
    expect(mem.objects.get(`fm/media/${ORG}/${courseA}/${png.id}/original.bin`)!.body.equals(PNG)).toBe(true);

    const v = await upload(courseA, 'lesson.mp4', MP4);
    expect(v.json()).toMatchObject({ kind: 'video', mimeType: 'video/mp4', title: 'lesson' });
    mp4 = v.json();
    bImage = (await upload(courseB, 'b.png', PNG)).json().id;
  });

  it('rejects SVG, disguised files and learners', async () => {
    expect((await upload(courseA, 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect((await upload(courseA, 'fake.png', Buffer.from('not really a png'))).statusCode).toBe(415);
    expect((await upload(courseA, 'movie.mov', Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ', 'latin1'), randomBytes(64)]))).statusCode).toBe(415);
    expect((await upload(courseA, 'x.png', PNG, 'me')).statusCode).toBe(403);
    expect(await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'course.asset.uploaded'`)).toMatchObject({ rowCount: 3 });
  });
});

describe('serving content', () => {
  it('streams to course staff with safe headers, ETag and Range', async () => {
    const r = await content(png.id, 'instr');
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(PNG)).toBe(true);
    expect(r.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' });
    expect(String(r.headers['content-security-policy'])).toContain('sandbox');
    expect((await content(png.id, 'instr', { 'if-none-match': String(r.headers.etag) })).statusCode).toBe(304);

    const part = await content(mp4.id, 'instr', { range: 'bytes=0-99' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${MP4.length}`);
    expect(part.rawPayload.equals(MP4.subarray(0, 100))).toBe(true);
    const tail = await content(mp4.id, 'instr', { range: 'bytes=-10' });
    expect(tail.rawPayload.equals(MP4.subarray(MP4.length - 10))).toBe(true);
    expect((await content(mp4.id, 'instr', { range: 'bytes=999999-' })).statusCode).toBe(416);
  });

  it('learners who are not in the course cannot see it (404, existence not revealed)', async () => {
    expect((await content(png.id, 'me')).statusCode).toBe(404);
    expect((await content(png.id, 'other')).statusCode).toBe(404);
    expect((await call('GET', `/api/assets/${randomUUID()}/content`, 'instr')).statusCode).toBe(404);
  });
});

describe('using assets in a course version', () => {
  it('publishing requires assets of this course with the right kind; video URL and asset are exclusive', async () => {
    await call(
      'PATCH',
      `/api/course-versions/${vA}`,
      'instr',
      lesson(
        [
          { type: 'image', assetId: bImage, alt: '別門課的圖' },
          { type: 'image', assetId: mp4.id, alt: '其實是影片' },
          { type: 'video', assetId: mp4.id, poster: png.id },
        ],
        { video_asset_id: mp4.id, video_url: 'https://cdn.example/x.mp4' },
      ),
    );
    const report = (await call('POST', `/api/course-versions/${vA}/validate`, 'instr')).json();
    const codes = (report.errors as { code: string }[]).map((e) => e.code);
    expect(codes.filter((c) => c === 'C1_ASSET_MISSING')).toHaveLength(2);
    expect(codes).toContain('C5_CONFIG_INVALID');

    await call('PATCH', `/api/course-versions/${vA}`, 'instr', lesson([{ type: 'image', assetId: png.id, alt: '示意圖' }, { type: 'video', assetId: mp4.id, poster: png.id }], { video_asset_id: mp4.id }));
    await call('PUT', `/api/course-versions/${vA}/completion-rules`, 'instr', { rule: { operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }] } });
    expect((await call('POST', `/api/course-versions/${vA}/publish`, 'instr')).statusCode).toBe(200);
  });

  it('enrolled learners see the assets and get the asset video in the activity runtime', async () => {
    await call('POST', `/api/courses/${courseA}/enrollments`, 'admin', { email: 'me@med.test' });
    expect((await content(png.id, 'me')).statusCode).toBe(200);
    expect((await content(mp4.id, 'me', { range: 'bytes=0-9' })).statusCode).toBe(206);
    expect((await call('GET', `/api/courses/${courseA}/assets`, 'me')).statusCode).toBe(403);
    expect((await content(png.id, 'other')).statusCode).toBe(404);
    const rt = await call('GET', `/api/activities/${VID}/runtime`, 'me');
    expect(rt.json().config).toMatchObject({ video_asset_id: mp4.id });
  });

  it('assets used by a version cannot be deleted; unused ones can, and are removed from storage', async () => {
    const list = (await call('GET', `/api/courses/${courseA}/assets`, 'instr')).json() as { id: string; usedBy: unknown[] }[];
    expect(list.find((a) => a.id === png.id)!.usedBy).toEqual([{ versionNo: 1, status: 'published' }]);
    const del = await call('DELETE', `/api/assets/${png.id}`, 'instr');
    expect(del.json().error.details[0]).toMatchObject({ issue: 'asset_in_use', params: { versions: 'v1' } });

    expect((await call('PATCH', `/api/assets/${png.id}`, 'instr', { title: '發酵示意圖' })).json()).toMatchObject({ title: '發酵示意圖' });

    const spare = (await upload(courseA, 'spare.png', PNG)).json().id as string;
    expect((await call('DELETE', `/api/assets/${spare}`, 'instr')).statusCode).toBe(204);
    expect([...mem.objects.keys()].some((k) => k.includes(spare))).toBe(false);
    expect((await content(spare, 'instr')).statusCode).toBe(404);
  });
});

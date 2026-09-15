/**
 * 通知（SA UC-AUD-003／004、SD §6.26）：事件 → 站內通知＋Email 通知 → worker 經 SMTP 寄出。
 * 真實 PostgreSQL 18 + 行程內 SMTP 伺服器；worker 的 handler 以 app_worker 連線直接執行。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import type { Job } from '../../apps/worker/src/dispatcher.js';
import { CertificateGenerateHandler } from '../../apps/worker/src/handlers/certificate-generate.js';
import { NotificationEmailHandler } from '../../apps/worker/src/handlers/notification-email.js';
import { createWorkerMailer, type WorkerMailer } from '../../apps/worker/src/mailer.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'notify-e2e-secret-notify-e2e-secret';
const FINGERPRINT = 'sha256:e2e-notify';
const BASE = 'https://learn.example.test';
const ORG = 'cdcd5656-0000-0000-0000-00000000000a';
const U = {
  admin: 'cdcd7878-0000-0000-0000-00000000000a',
  instr: 'cdcd7878-0000-0000-0000-0000000000c1',
  l1: 'cdcd7878-0000-0000-0000-0000000000d1',
  l2: 'cdcd7878-0000-0000-0000-0000000000d2',
  l3: 'cdcd7878-0000-0000-0000-0000000000d3',
};
type Who = keyof typeof U;
const EMAIL = (k: Who) => `${k}@notify.test`;

// ---- 收件匣與最小 MIME 解碼（同 smtp-mail.test.ts） -------------------------------------------
interface Received {
  to: string[];
  raw: string;
}
const inbox: Received[] = [];
function qpBytes(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else out.push(s.charCodeAt(i));
  }
  return Buffer.from(out);
}
function decodeWords(v: string): string {
  return v.replace(/(?:=\?[^?]+\?[BbQq]\?[^?]*\?=\s*)+/g, (run) => {
    const trailing = /\s*$/.exec(run)![0];
    const bytes = [...run.matchAll(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g)].map(([, enc, data]) =>
      enc!.toUpperCase() === 'B' ? Buffer.from(data!, 'base64') : qpBytes(data!.replace(/_/g, ' ')),
    );
    return Buffer.concat(bytes).toString('utf8') + trailing;
  });
}
function splitHeaders(raw: string) {
  const i = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, i).replace(/\r\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of head.split('\r\n')) {
    const c = line.indexOf(':');
    headers.set(line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim());
  }
  return { headers, body: raw.slice(i + 4) };
}
function decodeBody(headers: Map<string, string>, body: string): string {
  const cte = headers.get('content-transfer-encoding')?.toLowerCase();
  if (cte === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (cte === 'quoted-printable') return qpBytes(body.replace(/=\r\n/g, '')).toString('utf8');
  return body;
}
function parseMail(raw: string) {
  const top = splitHeaders(raw);
  const boundary = /boundary="?([^";]+)"?/i.exec(top.headers.get('content-type') ?? '')?.[1];
  const parts = boundary
    ? top.body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((p) => splitHeaders(p.replace(/^\r\n/, '')))
    : [top];
  const find = (type: string) => {
    const p = parts.find((x) => (x.headers.get('content-type') ?? '').toLowerCase().startsWith(type));
    return p ? decodeBody(p.headers, p.body) : '';
  };
  return { header: (name: string) => decodeWords(top.headers.get(name) ?? ''), text: find('text/plain'), html: find('text/html') };
}

// ------------------------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let workerDb: pg.Pool;
let app: NestFastifyApplication;
let smtp: SMTPServer;
let mailer: WorkerMailer;
let emails: NotificationEmailHandler;
const s = {} as Record<Who, { token: string; csrf: string }>;
let courseId = '';
let l1Enrollment = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: Who, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload && { payload }),
    headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf },
  });
const list = async (who: Who, qs = '') => (await call('GET', `/api/notifications${qs}`, who)).json() as { data: { id: string; type: string; payload: Record<string, unknown> }[]; meta: { unread: number } };
const jobByKey = async (key: string): Promise<Job> =>
  (await admin.query<Job>(`SELECT id, job_type, queue, payload, attempts, max_attempts, organization_id, correlation_id FROM job_queue WHERE idempotency_key = $1`, [key])).rows[0]!;
const emailRows = async (who: Who, type: string) =>
  (await admin.query<{ id: string; sent_at: Date | null }>(`SELECT id, sent_at FROM notifications WHERE user_id = $1 AND type = $2 AND channel = 'email' ORDER BY created_at`, [U[who], type])).rows;
/** 執行某則 Email 通知的寄送 job，回傳收到的信（沒寄出則 undefined） */
const sendEmail = async (notificationId: string) => {
  const before = inbox.length;
  await emails.handle(await jobByKey(`mail:${notificationId}`));
  return inbox.length > before ? parseMail(inbox[inbox.length - 1]!.raw) : undefined;
};

async function publishedCourse(title: string): Promise<string> {
  const id = (await call('POST', '/api/courses', 'admin', { title })).json().id as string;
  expect((await call('POST', `/api/courses/${id}/staff`, 'admin', { email: EMAIL('instr'), role: 'instructor' })).statusCode).toBe(201);
  const v = (await call('POST', `/api/courses/${id}/versions`, 'instr', { title: 'v1' })).json().id as string;
  await call('PATCH', `/api/course-versions/${v}`, 'instr', {
    modules: [{ id: randomUUID(), title: '單元', lessons: [{ id: randomUUID(), title: '課節', activities: [{ id: randomUUID(), title: '閱讀', activityType: 'reading' }] }] }],
  });
  await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', { rule: { type: 'required_activities_completed', value: true } });
  expect((await call('POST', `/api/course-versions/${v}/publish`, 'instr')).statusCode).toBe(200);
  return id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-n', '示範大學', 'n')`, [ORG]);
  for (const k of Object.keys(U) as Who[]) {
    await admin.query(`INSERT INTO users (id, email, display_name, locale) VALUES ($1, $2, $3, $4)`, [U[k], EMAIL(k), k, k === 'l3' ? 'en' : 'zh-TW']);
  }
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', 'l1', 'l2', 'l3'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-n', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{"max_active_learners": 20}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as Who[]) s[k] = await session(U[k]);

  smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    authOptional: true,
    logger: false,
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') });
        cb();
      });
    },
  });
  const smtpPort = await new Promise<number>((resolve) => {
    const srv = smtp.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
  });

  const h = container.getHost();
  const p = container.getPort();
  workerDb = new pg.Pool({ connectionString: `postgres://app_worker:${PW.worker_pw}@${h}:${p}/iac`, max: 2 });
  mailer = createWorkerMailer({
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: smtpPort,
    SMTP_SECURE: false,
    SMTP_REQUIRE_TLS: false,
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_FROM: 'Learning Platform <no-reply@learn.example.test>',
  })!;
  emails = new NotificationEmailHandler(workerDb, mailer, pino({ level: 'silent' }), BASE);

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

  courseId = await publishedCourse('通知測試課');
});

afterAll(async () => {
  await app?.close();
  mailer?.close();
  await workerDb?.end();
  await new Promise<void>((resolve) => (smtp ? smtp.close(() => resolve()) : resolve()));
  await admin?.end();
  await container?.stop();
});

describe('event → in-app notification + email', () => {
  it('assigning a learner notifies them in-app and queues exactly one email', async () => {
    const r = await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: EMAIL('l1') });
    expect(r.statusCode).toBe(201);
    l1Enrollment = r.json().id;
    const n = await list('l1');
    expect(n.meta.unread).toBe(1);
    expect(n.data[0]).toMatchObject({ type: 'enrollment.assigned', payload: { courseTitle: '通知測試課', organizationName: '示範大學', enrollmentId: l1Enrollment } });
    const rows = await emailRows('l1', 'enrollment.assigned');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent_at).toBeNull();
    expect((await jobByKey(`mail:${rows[0]!.id}`)).job_type).toBe('notification.email');
  });

  it('the worker sends it once, in the reader’s language, with a link back — and never twice', async () => {
    const [row] = await emailRows('l1', 'enrollment.assigned');
    const mail = await sendEmail(row!.id);
    expect(mail).toBeDefined();
    expect(inbox[inbox.length - 1]!.to).toEqual([EMAIL('l1')]);
    expect(mail!.header('subject')).toBe('你已加入課程「通知測試課」');
    expect(mail!.header('auto-submitted')).toBe('auto-generated');
    expect(mail!.text).toContain(`${BASE}/app/learn/${l1Enrollment}`);
    expect(mail!.text).toContain(`${BASE}/app/notifications`);
    expect((await emailRows('l1', 'enrollment.assigned'))[0]!.sent_at).not.toBeNull();
    expect(await sendEmail(row!.id)).toBeUndefined();
  });
});

describe('preferences (UC-AUD-004)', () => {
  it('lists every type with defaults on, and rejects unknown types', async () => {
    const p = (await call('GET', '/api/me/notification-preferences', 'l2')).json();
    expect(p).toHaveLength(7);
    expect(p.every((x: { inApp: boolean; email: boolean }) => x.inApp && x.email)).toBe(true);
    const bad = await call('PUT', '/api/me/notification-preferences', 'l2', { preferences: [{ type: 'nope', inApp: true, email: true }] });
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('turning email off keeps the in-app notification but sends no email', async () => {
    const r = await call('PUT', '/api/me/notification-preferences', 'l2', { preferences: [{ type: 'enrollment.assigned', inApp: true, email: false }] });
    expect(r.json().find((x: { type: string }) => x.type === 'enrollment.assigned')).toEqual({ type: 'enrollment.assigned', inApp: true, email: false });
    await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: EMAIL('l2') });
    expect((await list('l2')).data.map((x) => x.type)).toEqual(['enrollment.assigned']);
    expect(await emailRows('l2', 'enrollment.assigned')).toHaveLength(0);
  });
});

describe('reading notifications (UC-AUD-003)', () => {
  it('only the owner can mark a notification read; read-all clears the rest', async () => {
    const mine = (await list('l1')).data[0]!;
    expect((await call('POST', `/api/notifications/${mine.id}/read`, 'l2')).statusCode).toBe(404);
    expect((await call('POST', `/api/notifications/${mine.id}/read`, 'l1')).statusCode).toBe(204);
    expect((await list('l1')).meta.unread).toBe(0);
    expect((await call('POST', '/api/notifications/read-all', 'l2')).json()).toEqual({ updated: 1 });
    expect((await list('l2', '?unread=true')).data).toEqual([]);
  });
});

describe('who gets told what', () => {
  it('a join request notifies the approvers; the decision notifies the learner (in English for English readers)', async () => {
    const reviewed = await publishedCourse('審核課');
    const code = (await call('PUT', `/api/courses/${reviewed}/enrollment-policy`, 'admin', { joinBy: 'code', requireApproval: true })).json().code;
    const joined = (await call('POST', '/api/me/enrollments/join', 'l3', { code })).json();
    expect(joined.status).toBe('pending');
    const req = (await list('admin')).data.find((x) => x.type === 'enrollment.requested');
    expect(req?.payload).toMatchObject({ learnerName: 'l3', courseTitle: '審核課', courseId: reviewed });
    expect((await list('l3')).data).toEqual([]); // 自己申請不通知自己

    expect((await call('POST', `/api/enrollments/${joined.enrollmentId}/approve`, 'admin')).statusCode).toBe(200);
    expect((await list('l3')).data[0]).toMatchObject({ type: 'enrollment.approved', payload: { enrollmentId: joined.enrollmentId } });
    const mail = await sendEmail((await emailRows('l3', 'enrollment.approved'))[0]!.id);
    expect(mail!.header('subject')).toBe('Your request to join "審核課" was approved');
  });

  it('a certificate and a relearning notify the learner; the relearning reason stays out of the email', async () => {
    const outline = (await call('GET', `/api/enrollments/${l1Enrollment}/outline`, 'l1')).json();
    const activityId = outline.modules[0].lessons[0].activities[0].id;
    const a = (await call('POST', `/api/activities/${activityId}/attempts`, 'l1')).json();
    expect((await call('POST', `/api/attempts/${a.attemptId}/submit`, 'l1', { input: {} })).json().completionChanged).toBe(true);
    await new CertificateGenerateHandler(workerDb).handle(await jobByKey(`cert:${l1Enrollment}`));
    const cert = (await list('l1')).data.find((x) => x.type === 'certificate.issued');
    expect(cert?.payload).toMatchObject({ courseTitle: '通知測試課', enrollmentId: l1Enrollment });
    expect(cert?.payload['certificateId']).toBeTruthy();
    expect(await emailRows('l1', 'certificate.issued')).toHaveLength(1);

    expect((await call('POST', `/api/enrollments/${l1Enrollment}/relearning`, 'admin', { scopeType: 'course', reason: '期末前再複習一次' })).statusCode).toBe(201);
    const rel = (await list('l1')).data.find((x) => x.type === 'relearning.assigned');
    expect(rel?.payload).toMatchObject({ reason: '期末前再複習一次', scopeType: 'course' });
    const mail = await sendEmail((await emailRows('l1', 'relearning.assigned'))[0]!.id);
    expect(mail!.header('subject')).toBe('「通知測試課」有新的重修');
    expect(mail!.text).not.toContain('期末前再複習一次');
    expect(mail!.html).not.toContain('期末前再複習一次');
  });
});

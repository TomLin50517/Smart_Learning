/**
 * SMTP 寄信端到端測試（SD §8.10）。
 * 真實 PostgreSQL 18 + 行程內 SMTP 伺服器（smtp-server）。不覆寫 ACCOUNT_MAILER——
 * 走 NotificationModule 的實際組裝，驗證信件真的經 SMTP 送達、內容可解碼、連結可用。
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { ENV, loadEnv, type Env } from '../../apps/api/src/config/env.js';
import { USER_INVITATIONS, type UserInvitations } from '../../apps/api/src/modules/identity/identity.contracts.js';
import { SmtpMailer } from '../../apps/api/src/modules/notification/infrastructure/smtp.mailer.js';
import { ACCOUNT_MAILER } from '../../apps/api/src/modules/notification/notification.contracts.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const EN = { id: 'eeeeeeee-0000-0000-0000-00000000000e', email: 'en@mail.e2e.test' };
const ZH = { id: 'eeeeeeee-0000-0000-0000-00000000000f', email: 'zh@mail.e2e.test' };
const BOUNCE = { id: 'eeeeeeee-0000-0000-0000-0000000000b0', email: 'nobody@reject.test' };
/** 測試用 SMTP 帳號，只存在於此行程內的 smtp-server */
const SMTP_USER = 'mailer';
const SMTP_PASS = 'smtp-e2e-only';
const FROM_ADDR = 'no-reply@learn.example.test';

// ---------------------------------------------------------------------------
// 收件匣 + 最小 MIME 解碼（base64 / quoted-printable / RFC 2047 encoded-word）
// ---------------------------------------------------------------------------
interface Received {
  from: string;
  to: string[];
  raw: string;
}

class Inbox {
  readonly mails: Received[] = [];
  private waiters: ((m: Received) => void)[] = [];
  push(m: Received): void {
    this.mails.push(m);
    this.waiters.shift()?.(m);
  }
  /** 必須在觸發寄信「之前」呼叫 */
  next(): Promise<Received> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

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

/** 相鄰的 encoded-word 先合併位元組再解 UTF-8（多位元組字元可能跨 word） */
function decodeWords(v: string): string {
  return v.replace(/(?:=\?[^?]+\?[BbQq]\?[^?]*\?=\s*)+/g, (run) => {
    const trailing = /\s*$/.exec(run)![0];
    const bytes = [...run.matchAll(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g)].map(([, enc, data]) =>
      enc!.toUpperCase() === 'B' ? Buffer.from(data!, 'base64') : qpBytes(data!.replace(/_/g, ' ')),
    );
    return Buffer.concat(bytes).toString('utf8') + trailing;
  });
}

function splitHeaders(raw: string): { headers: Map<string, string>; names: string[]; body: string } {
  const i = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, i).replace(/\r\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  const names: string[] = [];
  for (const line of head.split('\r\n')) {
    const c = line.indexOf(':');
    const name = line.slice(0, c).trim().toLowerCase();
    names.push(name);
    headers.set(name, line.slice(c + 1).trim());
  }
  return { headers, names, body: raw.slice(i + 4) };
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
  return {
    header: (name: string) => decodeWords(top.headers.get(name) ?? ''),
    headerNames: top.names,
    text: find('text/plain'),
    html: find('text/html'),
  };
}

// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
let smtp: SMTPServer;
let smtpPort = 0;
let dbUrls: { api: string; coach: string };
const inbox = new Inbox();

function smtpEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: dbUrls.api,
    DATABASE_URL_COACH: dbUrls.coach,
    SESSION_SECRET: 'smtp-e2e-secret-smtp-e2e-secret-smtp',
    LICENSE_FINGERPRINT_OVERRIDE: 'sha256:e2e-smtp',
    PUBLIC_BASE_URL: 'https://learn.example.test',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    // 測試伺服器不提供 STARTTLS；requireTLS 的拒絕行為另有測試
    SMTP_REQUIRE_TLS: 'false',
    SMTP_USER,
    SMTP_PASSWORD: SMTP_PASS,
    SMTP_FROM: `Learning Platform <${FROM_ADDR}>`,
    ...overrides,
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });
  await admin.query(
    `INSERT INTO users (id, email, display_name, locale) VALUES
       ($1, $2, 'English User', 'en'), ($3, $4, '中文使用者', 'zh-TW'), ($5, $6, 'Bounce', 'en')`,
    [EN.id, EN.email, ZH.id, ZH.email, BOUNCE.id, BOUNCE.email],
  );

  smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === SMTP_USER && auth.password === SMTP_PASS) cb(null, { user: SMTP_USER });
      else cb(new Error('Invalid credentials'));
    },
    onRcptTo(address, _session, cb) {
      if (address.address.endsWith('@reject.test')) cb(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }));
      else cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        inbox.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        cb();
      });
    },
  });
  smtpPort = await new Promise<number>((resolve) => {
    const srv = smtp.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
  });

  const h = container.getHost();
  const p = container.getPort();
  dbUrls = {
    api: `postgres://app_api:${PW.api_pw}@${h}:${p}/iac`,
    coach: `postgres://app_coach:${PW.coach_pw}@${h}:${p}/iac`,
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ENV).useValue(smtpEnv()).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => (smtp ? smtp.close(() => resolve()) : resolve()));
  await admin?.end();
  await container?.stop();
});

describe('wiring', () => {
  it('SMTP_HOST set → NotificationModule provides the SMTP mailer', () => {
    expect(app.get(ACCOUNT_MAILER)).toBeInstanceOf(SmtpMailer);
  });
});

describe('password reset email (locale en)', () => {
  it('is delivered over SMTP in English, and its link completes the reset', async () => {
    const arrived = inbox.next();
    const res = await app.inject({ method: 'POST', url: '/api/auth/password-reset/request', remoteAddress: '10.9.0.1', payload: { email: EN.email } });
    expect(res.statusCode).toBe(202);

    const mail = await arrived;
    expect(mail.from).toBe(FROM_ADDR);
    expect(mail.to).toEqual([EN.email]);

    const m = parseMail(mail.raw);
    expect(m.header('subject')).toBe('Reset your password');
    expect(m.header('from')).toContain(FROM_ADDR);
    expect(m.header('auto-submitted')).toBe('auto-generated');
    expect(m.text).toContain('within 30 minutes');

    const link = /https:\/\/learn\.example\.test\/password-reset\?token=[A-Za-z0-9_-]+/.exec(m.text)?.[0];
    expect(link, 'reset link in text part').toBeTruthy();
    expect(m.html).toContain(`href="${link}"`);

    const token = new URL(link!).searchParams.get('token')!;
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      remoteAddress: '10.9.0.2',
      payload: { token, newPassword: 'english-new-password-1' },
    });
    expect(confirm.statusCode).toBe(204);
  });
});

describe('invitation email (locale zh-TW)', () => {
  it('is delivered in Traditional Chinese; the organization name cannot inject headers or HTML', async () => {
    const arrived = inbox.next();
    const sent = await app.get<UserInvitations>(USER_INVITATIONS).invite(ZH.id, 'A&B <Lab>\r\nBcc: evil@x.test');
    expect(sent).toBe(true);

    const mail = await arrived;
    expect(mail.to).toEqual([ZH.email]); // 沒有被注入額外收件者

    const m = parseMail(mail.raw);
    expect(m.header('subject')).toBe('您受邀加入「A&B <Lab> Bcc: evil@x.test」');
    expect(m.headerNames).not.toContain('bcc');
    expect(m.text).toContain('72 小時');
    expect(m.text).toMatch(/https:\/\/learn\.example\.test\/set-password\?token=[A-Za-z0-9_-]+/);
    expect(m.html).toContain('A&amp;B &lt;Lab&gt;');
    expect(m.html).not.toContain('<Lab>');
  });
});

describe('delivery failures', () => {
  const resetMail = { to: EN.email, locale: 'en', link: 'https://learn.example.test/password-reset?token=t', expiresInMinutes: 30 };

  it('recipient rejected by the server → invite() reports false instead of throwing', async () => {
    const before = inbox.mails.length;
    await expect(app.get<UserInvitations>(USER_INVITATIONS).invite(BOUNCE.id, 'Org')).resolves.toBe(false);
    expect(inbox.mails.length).toBe(before);
  });

  it('requireTLS: a server without STARTTLS is refused, never downgraded to plaintext', async () => {
    const before = inbox.mails.length;
    const mailer = new SmtpMailer(smtpEnv({ SMTP_REQUIRE_TLS: 'true' }));
    try {
      await expect(mailer.sendPasswordReset(resetMail)).rejects.toThrow(/not accepted by the mail server/);
    } finally {
      mailer.onModuleDestroy();
    }
    expect(inbox.mails.length).toBe(before);
  });

  it('wrong SMTP credentials → rejected', async () => {
    const mailer = new SmtpMailer(smtpEnv({ SMTP_PASSWORD: 'wrong-password' }));
    try {
      await expect(mailer.sendPasswordReset(resetMail)).rejects.toThrow(/not accepted by the mail server/);
    } finally {
      mailer.onModuleDestroy();
    }
  });
});

/**
 * 密碼字元集的端到端回歸測試：含特殊字元的密碼經「設定密碼（reset confirm）→ 登入」必須一致。
 * 背景：使用者回報含特殊字元的密碼設定成功但登入失敗（bad_password）；此測試證明伺服器端
 * 不會對密碼做任何轉換（不 trim、不正規化、JSON 往返無損）。
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };

const PASSWORDS: [string, string][] = [
  ['ASCII symbols incl. space, quotes and backslash', `P@ss w0rd!#$%^&*()_+-=[]{}|;:'",.<>/?\`~\\`],
  ['JSON/HTML-significant sequences', '</script>"\\u0000&amp;%2B+'],
  ['full-width symbols and CJK', '密碼！＠＃＄％ｘ１２３'],
  ['emoji (surrogate pairs)', 'long\u{1f642}password\u{1f511}ok'],
  ['leading and trailing spaces are kept', '  spaced out  '],
  ['precomposed e-acute (NFC)', 'café-secret-1'],
];

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
let n = 0;

/** 建立無密碼的啟用使用者並直接發一張設定密碼 token（等同邀請／重設信中的連結） */
async function userWithToken(): Promise<{ email: string; token: string }> {
  n++;
  const email = `charset${n}@e2e.test`;
  const u = await admin.query<{ id: string }>(`INSERT INTO users (email, display_name, status) VALUES ($1, $2, 'active') RETURNING id`, [email, `U${n}`]);
  const token = randomBytes(32).toString('base64url');
  await admin.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, purpose) VALUES ($1, $2, now() + interval '1 hour', 'invite')`, [
    u.rows[0]!.id,
    hashToken(token),
  ]);
  return { email, token };
}

const post = (url: string, payload: object, ip: string) => app.inject({ method: 'POST', url, remoteAddress: ip, payload });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });
  const h = container.getHost();
  const p = container.getPort();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://app_api:${PW.api_pw}@${h}:${p}/iac`,
        DATABASE_URL_COACH: `postgres://app_coach:${PW.coach_pw}@${h}:${p}/iac`,
        SESSION_SECRET: 'charset-e2e-secret-charset-e2e-secret',
        LICENSE_FINGERPRINT_OVERRIDE: 'sha256:e2e-charset',
      }),
    )
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('passwords with special characters survive set-password → login unchanged', () => {
  it.each(PASSWORDS)('%s', async (_label, password) => {
    const { email, token } = await userWithToken();
    const ip = `10.77.0.${n}`;
    const set = await post('/api/auth/password-reset/confirm', { token, newPassword: password }, ip);
    expect(set.statusCode).toBe(204);

    const ok = await post('/api/auth/login', { email, password }, ip);
    expect(ok.statusCode, 'login with the exact same password').toBe(200);

    // 反證：少一個字元、或去掉前後空白都必須失敗——伺服器沒有做寬鬆比對
    const altered = password.trim() === password ? password.slice(0, -1) : password.trim();
    const bad = await post('/api/auth/login', { email, password: altered }, ip);
    expect(bad.statusCode).toBe(401);
  });

  it('a decomposed e-acute (NFD) is a different password from the precomposed one (no normalization)', async () => {
    const { email, token } = await userWithToken();
    const ip = `10.77.1.${n}`;
    const nfc = 'café-secret-2';
    const nfd = 'café-secret-2';
    expect((await post('/api/auth/password-reset/confirm', { token, newPassword: nfc }, ip)).statusCode).toBe(204);
    expect((await post('/api/auth/login', { email, password: nfd }, ip)).statusCode).toBe(401);
    expect((await post('/api/auth/login', { email, password: nfc }, ip)).statusCode).toBe(200);
  });
});

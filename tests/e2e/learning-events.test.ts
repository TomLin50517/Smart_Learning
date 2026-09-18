/**
 * 學習事件、學習時間、以事件佐證的影片比例、timeline、教師檢視（Phase 2-3a，SA §10、SD §6.12）。
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
import { startOfFreshWindow } from './rate-limit-window.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'events-e2e-secret-events-e2e-secret';
const FINGERPRINT = 'sha256:e2e-events';
const ORG = 'e1e1e1e1-0000-0000-0000-00000000000a';
const U = {
  admin: 'e2e2e2e2-0000-0000-0000-00000000000a',
  instr: 'e2e2e2e2-0000-0000-0000-0000000000c1',
  me: 'e2e2e2e2-0000-0000-0000-0000000000d1',
  other: 'e2e2e2e2-0000-0000-0000-0000000000d2',
  stranger: 'e2e2e2e2-0000-0000-0000-0000000000d3',
};
const ID = { M1: randomUUID(), L1: randomUUID(), READ: randomUUID(), VIDEO: randomUUID(), LEGACY: randomUUID() };

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let courseId = '';
let myEnrollment = '';
let otherEnrollment = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: keyof typeof U, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf } });
const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
const ev = (eventType: string, payload: object = {}, occurredAt = ago(0), extra: object = {}) => ({ eventId: randomUUID(), eventType, eventVersion: '1.0', occurredAt, payload, ...extra });
const start = async (activity: string, who: keyof typeof U = 'me') => (await call('POST', `/api/activities/${activity}/attempts`, who)).json().attemptId as string;
const send = (attempt: string, events: object[], who: keyof typeof U = 'me') => call('POST', `/api/attempts/${attempt}/events`, who, { events });
const submit = (attempt: string, input: object, who: keyof typeof U = 'me') => call('POST', `/api/attempts/${attempt}/submit`, who, { input });
const types = (items: { eventType: string }[]) => items.map((x) => x.eventType);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-e', 'Org E', 'ev')`, [ORG]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@ev.test`, k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', 'me', 'other', 'stranger'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-ev', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
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
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // 一個課節：閱讀、有網址的影片（以事件佐證）、沒有網址的影片（學員自行確認）；另需學習 5 分鐘
  courseId = (await call('POST', '/api/courses', 'admin', { title: '事件測試課' })).json().id;
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@ev.test', role: 'instructor' });
  const v = (await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v1' })).json().id;
  const patch = await call('PATCH', `/api/course-versions/${v}`, 'instr', {
    modules: [
      {
        id: ID.M1,
        title: '單元一',
        lessons: [
          {
            id: ID.L1,
            title: '課節一',
            activities: [
              { id: ID.READ, title: '閱讀', activityType: 'reading' },
              { id: ID.VIDEO, title: '影片', activityType: 'video', config: { video_url: 'https://media.example.test/v.mp4', duration_sec: 100 } },
              { id: ID.LEGACY, title: '外部影片', activityType: 'video' },
            ],
          },
        ],
      },
    ],
  });
  expect(patch.statusCode).toBe(200);
  await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', {
    rule: { operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }, { type: 'time_spent_minimum', value: 5 }] },
  });
  expect((await call('POST', `/api/course-versions/${v}/publish`, 'instr')).statusCode).toBe(200);
  myEnrollment = (await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: 'me@ev.test' })).json().id;
  otherEnrollment = (await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: 'other@ev.test' })).json().id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('server events and who can read the timeline', () => {
  it('enrolling writes course.enrolled; the learner and the course staff can read it, nobody else', async () => {
    const mine = await call('GET', `/api/me/enrollments/${myEnrollment}/timeline`, 'me');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data).toMatchObject([{ eventType: 'course.enrolled', details: { method: 'assign' } }]);
    expect((await call('GET', `/api/enrollments/${myEnrollment}/timeline`, 'instr')).json().data).toHaveLength(1);

    expect((await call('GET', `/api/me/enrollments/${myEnrollment}/timeline`, 'other')).statusCode).toBe(404);
    expect((await call('GET', `/api/enrollments/${myEnrollment}/timeline`, 'me')).statusCode).toBe(403);
    expect((await call('GET', `/api/enrollments/${myEnrollment}/progress`, 'stranger')).statusCode).toBe(403);
  });
});

describe('learner events', () => {
  let attempt = '';

  it('accepts whitelisted events, overrides identity, reports per-event rejections', async () => {
    attempt = await start(ID.READ);
    const good = ev('activity.heartbeat');
    const res = await send(attempt, [
      good,
      ev('activity.submitted'),
      ev('activity.heartbeat', {}, ago(0), { activityId: ID.VIDEO }),
      ev('activity.heartbeat', {}, new Date(Date.now() + 5 * 60_000).toISOString()),
      ev('video.progressed', { position_sec: 1, duration_sec: 10, watched_ranges: [[5, 1]] }),
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: 1, duplicated: 0 });
    expect(res.json().rejected.map((r: { reason: string }) => r.reason)).toEqual(['unknown_event_type', 'activity_mismatch', 'occurred_at_out_of_range', 'invalid_payload']);

    const row = (await admin.query(`SELECT organization_id, learner_id, enrollment_id, activity_id, attempt_id FROM learning_events WHERE event_id = $1`, [good.eventId])).rows[0];
    expect(row).toEqual({ organization_id: ORG, learner_id: U.me, enrollment_id: myEnrollment, activity_id: ID.READ, attempt_id: attempt });

    // 重送同一筆：冪等
    expect((await send(attempt, [good])).json()).toMatchObject({ accepted: 0, duplicated: 1 });
  });

  it('identity fields cannot be smuggled in; other people\'s attempts are 404', async () => {
    expect((await send(attempt, [ev('activity.heartbeat', {}, ago(0), { learnerId: U.other })])).statusCode).toBe(400);
    expect((await send(attempt, [ev('activity.heartbeat')], 'other')).statusCode).toBe(404);
  });

  it('learning time: gaps between events, breaks over 5 minutes do not count', async () => {
    // 9 分鐘前到 1 分鐘前，每分鐘一次 heartbeat
    expect((await send(attempt, Array.from({ length: 9 }, (_, i) => ev('activity.heartbeat', {}, ago(540 - i * 60))))).json().accepted).toBe(9);
    const o = (await call('GET', `/api/enrollments/${myEnrollment}/outline`, 'me')).json();
    expect(o.time.minutes).toBeGreaterThanOrEqual(8);
    expect(o.time.minutes).toBeLessThan(10);
    expect(o.time.byModule).toEqual([{ moduleId: ID.M1, title: '單元一', minutes: o.time.minutes }]);
  });

  it('a submitted attempt no longer takes events', async () => {
    expect((await submit(attempt, {})).json().status).toBe('completed');
    expect((await send(attempt, [ev('activity.heartbeat')])).json().rejected).toMatchObject([{ reason: 'attempt_closed' }]);
  });
});

describe('video watch ratio from events', () => {
  it('claiming the whole video at once is not believed, and the client\'s watchedRatio is ignored', async () => {
    const a = await start(ID.VIDEO);
    await send(a, [ev('video.progressed', { position_sec: 100, duration_sec: 100, watched_ranges: [[0, 100]] })]);
    const r = (await submit(a, { watchedRatio: 1 })).json();
    expect(r.status).toBe('needs_improvement');
    expect(r.feedbackData.watchedRatio).toBe(0.15);
  });

  it('watching in real time (sampled every 15 seconds) completes it', async () => {
    const a = await start(ID.VIDEO);
    await send(a, [
      ev('video.started', { duration_sec: 100 }, ago(120)),
      ...Array.from({ length: 7 }, (_, i) => ev('video.progressed', { position_sec: 15 * (i + 1), duration_sec: 100, watched_ranges: [[0, Math.min(100, 15 * (i + 1))]] }, ago(105 - i * 15))),
    ]);
    const r = (await submit(a, {})).json();
    expect(r.status).toBe('completed');
    expect(r.feedbackData.watchedRatio).toBe(1);
  });

  it('a video without a URL (watched elsewhere) keeps the learner\'s confirmation — and completes the course', async () => {
    const r = (await submit(await start(ID.LEGACY), { watchedRatio: 1 })).json();
    expect(r).toMatchObject({ status: 'completed', completionChanged: true });
  });
});

describe('timeline and staff views', () => {
  it('lists meaningful events newest first, hides high-frequency ones and raw payloads, and pages without gaps', async () => {
    const all = (await call('GET', `/api/me/enrollments/${myEnrollment}/timeline?limit=100`, 'me')).json();
    const t = types(all.data);
    expect(t[0]).toBe('course.completed');
    expect(t).toContain('activity.retry_started');
    expect(t).toContain('video.started');
    expect(t).not.toContain('activity.heartbeat');
    expect(t).not.toContain('video.progressed');
    expect(t.filter((x) => x === 'activity.completed')).toHaveLength(3);
    // 測試中的影片事件回溯到選課之前，所以只確認有選課事件、不假設它是最舊的一筆
    expect(t).toContain('course.enrolled');
    expect(JSON.stringify(all)).not.toContain('input_hash');
    expect(all.data.find((x: { eventType: string }) => x.eventType === 'activity.result_ready').details).toMatchObject({ status: 'completed' });

    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: { id: string }[]; meta: { next_cursor: string | null } } = (
        await call('GET', `/api/enrollments/${myEnrollment}/timeline?limit=3${cursor ? `&cursor=${cursor}` : ''}`, 'instr')
      ).json();
      ids.push(...page.data.map((x) => x.id));
      cursor = page.meta.next_cursor;
    } while (cursor);
    expect(ids).toEqual(all.data.map((x: { id: string }) => x.id));
  });

  it('course staff see the learner\'s progress, watch ratios and time; the learner list shows progress and last activity', async () => {
    const p = (await call('GET', `/api/enrollments/${myEnrollment}/progress`, 'instr')).json();
    expect(p.learner).toMatchObject({ id: U.me, email: 'me@ev.test' });
    expect(p.progress).toMatchObject({ completed: true, requiredCompleted: 3, requiredTotal: 3 });
    expect(p.enrollment.status).toBe('completed');
    const acts = Object.fromEntries(p.modules[0].lessons[0].activities.map((a: { id: string }) => [a.id, a]));
    expect(acts[ID.VIDEO]).toMatchObject({ watchedRatio: 1, attempts: 2, state: 'completed' });
    expect(acts[ID.READ].watchedRatio).toBeNull();
    expect(p.time.minutes).toBeGreaterThanOrEqual(8);

    const list = (await call('GET', `/api/courses/${courseId}/learners`, 'instr')).json().data;
    const me = list.find((l: { id: string }) => l.id === myEnrollment);
    expect(me.progress).toEqual({ requiredTotal: 3, requiredCompleted: 3, weightedScore: null });
    expect(me.lastActivityAt).not.toBeNull();
    expect(list.find((l: { id: string }) => l.id === otherEnrollment).progress).toBeNull();
  });
});

describe('video settings are checked before publishing (C5)', () => {
  it('only http(s) video URLs and known fields are accepted', async () => {
    const c = (await call('POST', '/api/courses', 'admin', { title: '影片設定檢查' })).json().id;
    await call('POST', `/api/courses/${c}/staff`, 'admin', { email: 'instr@ev.test', role: 'instructor' });
    const v = (await call('POST', `/api/courses/${c}/versions`, 'instr', { title: 'v1' })).json().id;
    const [bad, extra] = [randomUUID(), randomUUID()];
    await call('PATCH', `/api/course-versions/${v}`, 'instr', {
      modules: [
        {
          id: randomUUID(),
          title: '單元',
          lessons: [
            {
              id: randomUUID(),
              title: '課節',
              activities: [
                { id: bad, title: '壞網址', activityType: 'video', config: { video_url: 'javascript:alert(1)' } },
                { id: extra, title: '多欄位', activityType: 'video', config: { video_url: 'https://media.example.test/a.mp4', autoplay: true, completion_ratio: 2 } },
              ],
            },
          ],
        },
      ],
    });
    const r = (await call('POST', `/api/course-versions/${v}/validate`, 'instr')).json();
    const c5 = r.errors.filter((e: { check: string }) => e.check === 'C5');
    expect(c5.map((e: { targetId: string }) => e.targetId)).toEqual([bad, extra, extra]);
    expect(c5[0].message).toContain('http:// 或 https://');
  });
});

describe('rate limit', () => {
  it('over 120 events per minute per enrollment gets 429 (learning is not blocked)', async () => {
    const a = await start(ID.READ, 'other');
    const batch = () => Array.from({ length: 50 }, (_, i) => ev('activity.heartbeat', {}, ago(i)));
    // 3 批必須落在同一個視窗內，否則計數被拆開、第 3 批不會被擋
    await startOfFreshWindow(admin);
    expect((await send(a, batch(), 'other')).statusCode).toBe(202);
    expect((await send(a, batch(), 'other')).statusCode).toBe(202);
    const third = await send(a, batch(), 'other');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
    // 仍可繼續學習
    expect((await submit(a, {}, 'other')).json().status).toBe('completed');
  });
});

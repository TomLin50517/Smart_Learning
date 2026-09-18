/**
 * 前端純邏輯的單元測試（錯誤文案、CSRF cookie、導向安全、導覽權限）。
 * 元件本身由 Browser 實測；這裡只測不需 DOM 的部分。
 */
import { ERROR_CODES, resolveBranding, type MeResponse } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { readCookie } from './api/client';
import { ApiError, describeError, ERROR_MESSAGES, humanizeRulePath, humanizeStructurePath } from './api/errors';
import { can, navItems } from './auth/permissions';
import { safeNext } from './auth/redirect';
import { passwordProblem } from './auth/password';
import { blockingReasonText, issueText, parseMarkdownLite, seededShuffle, timelineText } from './learn-lib';
import { csvTemplate, parseCsv, toLearnerRows, toMemberRows } from './csv';
import { formatMinutes } from './format';
import { EventQueue, mergeRanges, WatchTracker } from './learn-events';
import { bundleFromHtml } from './version-check';

describe('new version check', () => {
  it('reads the hashed main script from index.html; dev builds have none', () => {
    expect(bundleFromHtml('<script type="module" crossorigin src="/assets/index-C1BVx92f.js"></script>')).toBe('/assets/index-C1BVx92f.js');
    expect(bundleFromHtml('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });
});

describe('learning events (learner side)', () => {
  it('counts only continuous playback; skipping ahead and re-watching add nothing', () => {
    const t = new WatchTracker();
    for (let s = 0; s <= 30; s += 0.25) t.tick(s);
    t.tick(80); // 拖曳到 80 秒
    for (let s = 80; s <= 90; s += 0.5) t.tick(s);
    expect(t.watched(100)).toEqual([
      [0, 30],
      [80, 90],
    ]);
    expect(t.ratio(100)).toBe(0.4);
    t.break(); // 暫停後從 10 秒重看
    t.tick(10);
    t.tick(11);
    expect(t.ratio(100)).toBe(0.4);
    expect(t.ratio(0)).toBe(0);
  });

  it('merges ranges the same way as the server', () => {
    expect(
      mergeRanges([
        [10, 20],
        [0, 5],
        [4, 8],
        [-1, 3],
      ]),
    ).toEqual([
      [0, 8],
      [10, 20],
    ]);
  });

  it('batches events; keeps them on a network error, drops them on 429 so learning never blocks', async () => {
    const sent: number[] = [];
    let fail: ApiError | null = new ApiError(0, 'NETWORK_ERROR', 'x', null);
    const q = new EventQueue('attempt-1', async (_id, events) => {
      if (fail) throw fail;
      sent.push(events.length);
    });
    for (let i = 0; i < 60; i++) q.push('activity.heartbeat');
    await q.flush();
    expect(q.size).toBe(60);
    fail = null;
    await q.flush();
    expect(sent).toEqual([50, 10]);
    fail = new ApiError(429, 'RATE_LIMITED', 'x', null);
    q.push('activity.heartbeat');
    await q.flush();
    expect(q.size).toBe(0);
  });

  it('describes timeline items and learning time in plain Chinese', () => {
    const item = (eventType: string, details: Record<string, string | number | null> = {}, activityTitle: string | null = '小考') => ({
      id: 'x',
      eventType,
      occurredAt: '2026-09-13T00:00:00Z',
      activityId: null,
      activityTitle,
      attemptId: null,
      details,
    });
    expect(timelineText(item('activity.result_ready', { status: 'passed', score: 8, maxScore: 10 }))).toBe('「小考」評分：通過（8／10 分）');
    expect(timelineText(item('activity.retry_started', { attemptNo: 2 }))).toBe('重新作答「小考」（第 2 次）');
    expect(timelineText(item('course.enrolled', { method: 'bulk_import' }, null))).toBe('加入課程（批次匯入）');
    expect(timelineText(item('completion.approved', { approverRoles: 'instructor,org_admin' }, null))).toBe('完成條件已由講師、組織管理員核可');
    expect(timelineText(item('certificate.issued', {}, null))).toBe('📜 取得結業證書');
    expect(timelineText(item('course.reopened', { via: 'relearning', reason: '再練習一次' }, null))).toBe('老師指派重修：再練習一次');
    expect(timelineText(item('course.reopened', { via: 'reopen' }, null))).toBe('課程重新開啟，可以繼續練習');
    expect(timelineText(item('something.new'))).toBe('something.new');
    expect([0, 0.4, 59.9, 120, 125].map(formatMinutes)).toEqual(['0 分鐘', '不到 1 分鐘', '59 分鐘', '2 小時', '2 小時 5 分鐘']);
  });
});

describe('bulk import CSV', () => {
  it('parses Excel CSV (BOM, CRLF, quotes, embedded commas) and pasted tab-separated text', () => {
    expect(parseCsv('﻿Email,姓名\r\n"a@x.test","王, 小明"\r\n\r\nb@x.test,"說""嗨"""\r\n')).toEqual([
      ['Email', '姓名'],
      ['a@x.test', '王, 小明'],
      ['b@x.test', '說"嗨"'],
    ]);
    expect(parseCsv('a@x.test\t王小明\tlearner\nb@x.test\t李小華\t')).toEqual([
      ['a@x.test', '王小明', 'learner'],
      ['b@x.test', '李小華', ''],
    ]);
  });

  it('maps headers in any order and Chinese role names; positional without a header', () => {
    expect(toMemberRows(parseCsv('課程代碼,角色,姓名,電子郵件\nC-0001,講師,陳老師,t@x.test\n,學生,王小明,s@x.test'))).toEqual([
      { email: 't@x.test', displayName: '陳老師', role: 'instructor', courseCode: 'C-0001' },
      { email: 's@x.test', displayName: '王小明', role: 'learner' },
    ]);
    expect(toMemberRows(parseCsv('s@x.test,王小明,組長,C-9'))).toEqual([{ email: 's@x.test', displayName: '王小明', role: '組長', courseCode: 'C-9' }]);
    expect(toLearnerRows(parseCsv('Email,Name\na@x.test,\nb@x.test,李小華'))).toEqual([{ email: 'a@x.test' }, { email: 'b@x.test', displayName: '李小華' }]);
  });

  it('reads member numbers and cohorts (header aliases or positions 5 and 6)', () => {
    expect(toMemberRows(parseCsv('Email,姓名,學號,班級\na@x.test,王小明,S001,113 三年二班\nb@x.test,李小華,,'))).toEqual([
      { email: 'a@x.test', displayName: '王小明', memberNo: 'S001', cohort: '113 三年二班' },
      { email: 'b@x.test', displayName: '李小華' },
    ]);
    expect(toMemberRows(parseCsv('c@x.test,陳同學,學生,,S009,第 5 期'))).toEqual([{ email: 'c@x.test', displayName: '陳同學', role: 'learner', memberNo: 'S009', cohort: '第 5 期' }]);
  });

  it('the templates round-trip through the parser', () => {
    expect(toMemberRows(parseCsv(csvTemplate('members')))[2]).toEqual({ email: 'teacher01@example.com', displayName: '陳老師', role: 'instructor', courseCode: 'C-0001' });
    expect(toLearnerRows(parseCsv(csvTemplate('learners')))).toHaveLength(2);
  });
});

describe('learning screen helpers', () => {
  it('parses a tiny Markdown subset into plain-text blocks (no HTML ever produced)', () => {
    expect(parseMarkdownLite('# 標題\n第一行\n第二行\n\n- 甲\n- 乙\n<script>x</script>')).toEqual([
      { type: 'h', level: 1, text: '標題' },
      { type: 'p', text: '第一行\n第二行' },
      { type: 'ul', items: ['甲', '乙'] },
      { type: 'p', text: '<script>x</script>' },
    ]);
  });

  it('shuffles deterministically per attempt, never in the authored order', () => {
    const items = ['a', 'b', 'c', 'd'];
    const one = seededShuffle(items, 'attempt-1');
    expect(seededShuffle(items, 'attempt-1')).toEqual(one);
    expect([...one].sort()).toEqual(items);
    for (const seed of ['x', 'y', 'z', 'attempt-2', '']) expect(seededShuffle(items, seed)).not.toEqual(items);
    expect(seededShuffle(['only'], 'x')).toEqual(['only']);
  });

  it('explains why the course is not complete yet', () => {
    const titleOf = (id: string) => ({ A: '小考' })[id];
    expect(blockingReasonText({ code: 'REQUIRED_ACTIVITIES_INCOMPLETE', activity_id: null, actual: 1, required: 3 }, titleOf)).toBe('必修活動已完成 1／3');
    expect(blockingReasonText({ code: 'MIN_SCORE_NOT_MET', activity_id: null, actual: 64, required: 70 }, titleOf)).toBe('總分 64，需達 70');
    expect(blockingReasonText({ code: 'DATA_NOT_AVAILABLE', activity_id: 'A' }, titleOf)).toBe('「小考」尚未有成績');
    expect(blockingReasonText({ code: 'SOMETHING_NEW', activity_id: null }, titleOf)).toBe('SOMETHING_NEW');
  });

  it('describes result issues, keeping custom codes as-is', () => {
    expect(issueText({ code: 'UNANSWERED', category: 'question', severity: 'medium', target: 'q2' }, '第 2 題')).toBe('第 2 題：未作答');
    expect(issueText({ code: 'TEMP_HIGH', category: 'parameter', severity: 'medium' }, '溫度')).toBe('溫度：TEMP_HIGH');
  });
});

describe('error messages', () => {
  it('every server error code has a zh-TW message', () => {
    for (const code of Object.keys(ERROR_CODES)) expect(ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES], code).toBeTruthy();
  });

  it('describes details with field labels and known issues, plus the correlation id', () => {
    const e = new ApiError(400, 'VALIDATION_FAILED', 'Validation failed', 'req-123', [
      { field: 'code', issue: 'already_exists' },
      { field: 'roles', issue: 'last_org_admin' },
      { issue: 'something else' },
    ]);
    expect(describeError(e)).toEqual({
      message: ERROR_MESSAGES.VALIDATION_FAILED,
      details: ['代碼：已被使用', '角色：組織至少需要保留一位管理員', 'something else'],
      reference: 'req-123',
    });
  });

  it('fills {placeholders} from details.params (e.g. which course already uses a code)', () => {
    const e = new ApiError(400, 'VALIDATION_FAILED', 'x', null, [
      { field: 'code', issue: 'code_in_use', params: { title: '程式設計入門' } },
      { field: 'roles', issue: 'cannot_remove_own_admin' },
    ]);
    expect(describeError(e).details).toEqual(['代碼：已被課程「程式設計入門」使用', '角色：不能取消自己的組織管理員角色，請由其他組織管理員處理']);
  });

  it('never surfaces raw exception text for unknown errors', () => {
    expect(describeError(new Error('SELECT * FROM users failed')).message).toBe(ERROR_MESSAGES.INTERNAL_ERROR);
  });
});

describe('humanizeStructurePath', () => {
  it('turns course-structure paths into readable locations', () => {
    expect(humanizeStructurePath('modules.0.lessons.1.activities.2.interactiveDefinitionId')).toBe('第 1 單元 › 第 2 課節 › 第 3 活動 › 互動元件');
    expect(humanizeStructurePath('modules.3.id')).toBe('第 4 單元 › id');
    expect(humanizeStructurePath('email')).toBeNull();
  });
});

describe('humanizeRulePath', () => {
  it('turns completion-rule JSON paths into readable locations', () => {
    expect(humanizeRulePath('$')).toBe('完成條件');
    expect(humanizeRulePath('$.conditions[1].conditions[0].value')).toBe('完成條件 › 第 2 項 › 第 1 項 › 數值');
    expect(humanizeRulePath('$.activity_ids[0]')).toBe('完成條件 › 活動');
    expect(humanizeRulePath('modules.0.id')).toBeNull();
  });

  it('rule errors show the server-provided message at a readable location', () => {
    const e = new ApiError(422, 'COURSE_VALIDATION_FAILED', 'x', null, [
      { field: '$.conditions[0].activity_id', issue: 'RULE_REFERENCE_NOT_FOUND', params: { message: '引用的活動不在此版本中' } },
    ]);
    expect(describeError(e).details).toEqual(['完成條件 › 第 1 項 › 活動：引用的活動不在此版本中']);
  });
});

describe('readCookie (CSRF double submit)', () => {
  it('finds the named cookie and decodes it', () => {
    expect(readCookie('a=1; iac_csrf=abc%2Fdef; b=2', 'iac_csrf')).toBe('abc/def');
    expect(readCookie('xiac_csrf=nope; iac_csrf=yes', 'iac_csrf')).toBe('yes');
    expect(readCookie('', 'iac_csrf')).toBeNull();
    expect(readCookie('broken; other=1', 'iac_csrf')).toBeNull();
  });
});

describe('safeNext — open-redirect protection', () => {
  it('keeps in-app paths', () => {
    expect(safeNext('/organizations?x=1')).toBe('/organizations?x=1');
  });
  it.each(['https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '/ok\nLocation: x', '/login?next=/x', '', null])(
    'rejects %j',
    (v) => {
      expect(safeNext(v)).toBe('/');
    },
  );
});

describe('passwordProblem', () => {
  it('enforces length and confirmation', () => {
    expect(passwordProblem('short', 'short')).toMatch(/至少/);
    expect(passwordProblem('x'.repeat(129), 'x'.repeat(129))).toMatch(/不可超過/);
    expect(passwordProblem('long-enough-1', 'long-enough-2')).toMatch(/不一致/);
    expect(passwordProblem('long-enough-1', 'long-enough-1')).toBeNull();
  });
});

describe('navigation by permission (display only — the server enforces access)', () => {
  const base: MeResponse = {
    user: { id: 'u', email: 'u@x.test', displayName: 'U', locale: 'zh-TW' },
    activeOrganization: { id: 'org-1', code: 'org-1', name: 'Org', branding: resolveBranding({ code: 'org-1', branding: {} }) },
    organizations: [{ id: 'org-1', name: 'Org' }],
    permissions: [],
    scopes: [],
    licenseCapabilities: {
      state: 'active',
      runtimeAllowed: true,
      configurationWriteAllowed: true,
      authoringAllowed: true,
      upgradeAllowed: true,
      aiCoachAllowed: true,
    },
  };
  const labels = (permissions: string[]) => navItems({ ...base, permissions }).map((n) => n.label);

  it('a learner sees only the home page', () => {
    expect(labels(['coach.interact_self'])).toEqual(['首頁']);
  });

  it('learners with learning.result.read_self see "我的課程"', () => {
    expect(labels(['learning.result.read_self'])).toEqual(['首頁', '我的課程']);
  });

  it('an org admin sees the members of their active organization', () => {
    const items = navItems({ ...base, permissions: ['org.read', 'org.user.read', 'org.user.write'] });
    expect(items.map((n) => [n.label, n.to])).toEqual([
      ['首頁', '/app'],
      ['成員管理', '/app/org/users'],
      ['班級管理', '/app/org/cohorts'],
    ]);
  });

  it('member management needs an active organization', () => {
    expect(navItems({ ...base, activeOrganization: null, permissions: ['org.user.read'] }).map((n) => n.label)).toEqual(['首頁']);
  });

  it('a platform admin sees organization management and the license', () => {
    expect(labels(['org.read', 'platform.organization.create', 'platform.license.read'])).toEqual(['首頁', '組織管理', '系統授權']);
  });

  it('audit: staff see "稽核紀錄", learners with audit.read_self see "帳號活動"', () => {
    expect(labels(['audit.read_org'])).toContain('稽核紀錄');
    expect(labels(['audit.read_self'])).toContain('帳號活動');
    expect(labels(['audit.read_self', 'audit.read_course'])).not.toContain('帳號活動');
  });

  it('course staff and org admins see course management', () => {
    expect(labels(['course.read', 'course.version.read'])).toContain('課程管理');
    // learner 也有 course.read，但只涵蓋自己選的課；課程清單要的是組織層級的授權，
    // 只憑 course.read 顯示入口的話，學員點進去會拿到 403
    expect(labels(['course.read'])).not.toContain('課程管理');
    expect(labels(['coach.interact_self'])).not.toContain('課程管理');
  });

  it('can() is false without a session', () => {
    expect(can(null, 'org.read')).toBe(false);
  });
});

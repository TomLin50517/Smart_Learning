/**
 * 前端純邏輯的單元測試（錯誤文案、CSRF cookie、導向安全、導覽權限）。
 * 元件本身由 Browser 實測；這裡只測不需 DOM 的部分。
 */
import { ERROR_CODES, type MeResponse } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { readCookie } from './api/client';
import { ApiError, describeError, ERROR_MESSAGES, humanizeRulePath, humanizeStructurePath } from './api/errors';
import { can, navItems } from './auth/permissions';
import { safeNext } from './auth/redirect';
import { passwordProblem } from './auth/password';
import { blockingReasonText, issueText, parseMarkdownLite, seededShuffle } from './learn-lib';
import { csvTemplate, parseCsv, toLearnerRows, toMemberRows } from './csv';

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
    activeOrganization: { id: 'org-1', name: 'Org', branding: {} },
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
    expect(labels(['course.read'])).toContain('課程管理');
    expect(labels(['coach.interact_self'])).not.toContain('課程管理');
  });

  it('can() is false without a session', () => {
    expect(can(null, 'org.read')).toBe(false);
  });
});

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

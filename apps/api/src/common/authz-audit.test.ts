import { describe, expect, it } from 'vitest';
import { auditVisibility, decideAccess, type AccessTarget } from './authz.js';
import type { PermissionGrant } from './context.js';

const ME = 'user-me';
const g = (permission: string, type: PermissionGrant['type'], id: string | null, organizationId: string | null = null): PermissionGrant => ({
  permission,
  type,
  id,
  organizationId,
});
const anyTarget = (includeSelf: boolean): AccessTarget => ({ scope: 'any', exists: true, organizationId: null, courseId: null, userId: null, includeSelf });
const AUDIT_READ = ['audit.read_platform', 'audit.read_org', 'audit.read_course', 'audit.read_self'];

describe('decideAccess — any-of permissions and includeSelf', () => {
  it('any listed permission is enough', () => {
    expect(decideAccess(ME, [g('audit.read_org', 'organization', 'o1', 'o1')], AUDIT_READ, anyTarget(true))).toBe('allow');
    expect(decideAccess(ME, [g('org.read', 'organization', 'o1', 'o1')], AUDIT_READ, anyTarget(true))).toBe('forbidden');
  });

  it("self grants enter an 'any' route only when the route opts in, and only the caller's own", () => {
    const self = [g('audit.read_self', 'self', ME, 'o1')];
    expect(decideAccess(ME, self, AUDIT_READ, anyTarget(true))).toBe('allow');
    expect(decideAccess(ME, self, AUDIT_READ, anyTarget(false))).toBe('forbidden');
    expect(decideAccess(ME, [g('audit.read_self', 'self', 'someone-else', 'o1')], AUDIT_READ, anyTarget(true))).toBe('forbidden');
  });

  it('a single string permission still works as before', () => {
    expect(decideAccess(ME, [g('audit.export', 'platform', null)], 'audit.export', anyTarget(false))).toBe('allow');
  });
});

describe('auditVisibility', () => {
  it('platform audit readers see everything', () => {
    expect(auditVisibility([g('audit.read_platform', 'platform', null)], ME)).toEqual({ all: true, organizations: [], courses: [], self: false });
  });

  it('org and course grants become id lists; self only for the caller', () => {
    const v = auditVisibility(
      [
        g('audit.read_org', 'organization', 'o1', 'o1'),
        g('audit.read_org', 'organization', 'o1', 'o1'),
        g('audit.read_course', 'course', 'c1', 'o2'),
        g('audit.read_course', 'organization', 'o3', 'o3'),
        g('audit.read_self', 'self', ME, 'o1'),
        g('org.read', 'organization', 'o9', 'o9'),
      ],
      ME,
    );
    expect(v).toEqual({ all: false, organizations: ['o1', 'o3'], courses: ['c1'], self: true });
  });

  it("another user's self grant does not count", () => {
    expect(auditVisibility([g('audit.read_self', 'self', 'other', 'o1')], ME).self).toBe(false);
  });
});

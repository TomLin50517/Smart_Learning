import { describe, expect, it } from 'vitest';
import { decideAccess, organizationsGranted, type AccessTarget } from './authz.js';
import type { PermissionGrant } from './context.js';

const ME = 'user-me';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const COURSE_A1 = 'course-a1';
const COURSE_A2 = 'course-a2';

const g = (permission: string, type: PermissionGrant['type'], id: string | null, organizationId: string | null): PermissionGrant => ({
  permission,
  type,
  id,
  organizationId,
});
const course = (courseId: string, organizationId: string, exists = true): AccessTarget => ({
  scope: 'course',
  exists,
  organizationId,
  courseId,
  userId: null,
});

describe('decideAccess — scope coverage (SA §6.1)', () => {
  it('platform grant covers organization and course targets', () => {
    const grants = [g('course.read', 'platform', null, null)];
    expect(decideAccess(ME, grants, 'course.read', course(COURSE_A1, ORG_A))).toBe('allow');
  });

  it('organization grant covers courses in the same org only', () => {
    const grants = [g('course.read', 'organization', ORG_A, ORG_A)];
    expect(decideAccess(ME, grants, 'course.read', course(COURSE_A1, ORG_A))).toBe('allow');
  });

  it('course grant covers that course only', () => {
    const grants = [g('course.version.write', 'course', COURSE_A1, ORG_A)];
    expect(decideAccess(ME, grants, 'course.version.write', course(COURSE_A1, ORG_A))).toBe('allow');
    expect(decideAccess(ME, grants, 'course.version.write', course(COURSE_A2, ORG_A))).toBe('forbidden');
  });

  it('platform target requires a platform grant', () => {
    const t: AccessTarget = { scope: 'platform', exists: true, organizationId: null, courseId: null, userId: null };
    expect(decideAccess(ME, [g('platform.license.read', 'organization', ORG_A, ORG_A)], 'platform.license.read', t)).toBe('forbidden');
    expect(decideAccess(ME, [g('platform.license.read', 'platform', null, null)], 'platform.license.read', t)).toBe('allow');
  });
});

describe('decideAccess — ADR-016: self is NOT covered by higher scopes', () => {
  const self: AccessTarget = { scope: 'self', exists: true, organizationId: ORG_A, courseId: null, userId: ME };

  it('platform admin cannot use a *_self permission through a platform grant', () => {
    expect(decideAccess(ME, [g('coach.conversation.read_self', 'platform', null, null)], 'coach.conversation.read_self', self)).toBe('forbidden');
  });

  it('a self grant for the current user is allowed', () => {
    expect(decideAccess(ME, [g('coach.conversation.read_self', 'self', ME, ORG_A)], 'coach.conversation.read_self', self)).toBe('allow');
  });

  it("a self grant belonging to someone else does not apply", () => {
    expect(decideAccess(ME, [g('coach.conversation.read_self', 'self', 'someone-else', ORG_A)], 'coach.conversation.read_self', self)).toBe('forbidden');
  });
});

describe('decideAccess — ADR-019: 404 vs 403', () => {
  it('non-existent resource → not_found', () => {
    const grants = [g('course.read', 'platform', null, null)];
    expect(decideAccess(ME, grants, 'course.read', course(COURSE_A1, ORG_A, false))).toBe('not_found');
  });

  it('resource in an org where I have no grants at all → not_found (existence not leaked)', () => {
    const grants = [g('course.read', 'organization', ORG_A, ORG_A)];
    expect(decideAccess(ME, grants, 'course.read', course('course-b1', ORG_B))).toBe('not_found');
  });

  it('resource in my org but I lack the permission → forbidden', () => {
    const grants = [g('course.read', 'organization', ORG_A, ORG_A)];
    expect(decideAccess(ME, grants, 'course.version.publish', course(COURSE_A1, ORG_A))).toBe('forbidden');
  });

  it('a grant for a different permission does not leak into another', () => {
    const grants = [g('course.read', 'platform', null, null)];
    expect(decideAccess(ME, grants, 'course.version.publish', course(COURSE_A1, ORG_A))).toBe('forbidden');
  });
});

describe("decideAccess — 'any' scope (list endpoints)", () => {
  const any: AccessTarget = { scope: 'any', exists: true, organizationId: null, courseId: null, userId: null };

  it('an organization grant is enough to enter; results are filtered by the handler', () => {
    expect(decideAccess(ME, [g('org.read', 'organization', ORG_A, ORG_A)], 'org.read', any)).toBe('allow');
  });

  it('a self grant does not open an administrative list', () => {
    expect(decideAccess(ME, [g('org.read', 'self', ME, ORG_A)], 'org.read', any)).toBe('forbidden');
  });

  it('no grant for the permission → forbidden', () => {
    expect(decideAccess(ME, [g('course.read', 'platform', null, null)], 'org.read', any)).toBe('forbidden');
  });
});

describe('organizationsGranted', () => {
  it("platform grant → 'all'", () => {
    expect(organizationsGranted([g('org.read', 'platform', null, null)], 'org.read')).toBe('all');
  });

  it('organization grants → exactly those orgs (deduplicated)', () => {
    const grants = [g('org.read', 'organization', ORG_A, ORG_A), g('org.read', 'organization', ORG_A, ORG_A), g('org.read', 'organization', ORG_B, ORG_B)];
    expect(organizationsGranted(grants, 'org.read')).toEqual([ORG_A, ORG_B]);
  });

  it('course and self grants never widen an organization list', () => {
    const grants = [g('org.read', 'course', COURSE_A1, ORG_A), g('org.read', 'self', ME, ORG_B)];
    expect(organizationsGranted(grants, 'org.read')).toEqual([]);
  });
});

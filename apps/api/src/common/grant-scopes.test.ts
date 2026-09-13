import { describe, expect, it } from 'vitest';
import { grantScopes } from './authz.js';
import type { PermissionGrant } from './context.js';

const g = (permission: string, type: PermissionGrant['type'], id: string | null, organizationId: string | null = null): PermissionGrant => ({
  permission,
  type,
  id,
  organizationId,
});

describe('grantScopes (list endpoints)', () => {
  it('platform grants see everything', () => {
    expect(grantScopes([g('course.read', 'platform', null)], 'course.read')).toEqual({ all: true, organizations: [], courses: [] });
  });

  it('collects organization and course ids for the given permission only; self grants never widen a list', () => {
    const s = grantScopes(
      [
        g('course.read', 'organization', 'o1', 'o1'),
        g('course.read', 'course', 'c1', 'o2'),
        g('course.read', 'course', 'c1', 'o2'),
        g('course.read', 'self', 'u1', 'o3'),
        g('course.create', 'organization', 'o9', 'o9'),
      ],
      'course.read',
    );
    expect(s).toEqual({ all: false, organizations: ['o1'], courses: ['c1'] });
  });
});

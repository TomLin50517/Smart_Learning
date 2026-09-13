import { describe, expect, it } from 'vitest';
import { manualApprovalRoles } from './approvals.js';

describe('manualApprovalRoles', () => {
  it('collects the approver roles anywhere in the rule tree, once each, in order', () => {
    const rule = {
      operator: 'AND',
      conditions: [
        { type: 'required_activities_completed', value: true },
        {
          operator: 'OR',
          conditions: [
            { type: 'manual_approval', approver_role: 'instructor' },
            { type: 'manual_approval', approver_role: 'org_admin' },
            { type: 'manual_approval', approver_role: 'instructor' },
          ],
        },
      ],
    };
    expect(manualApprovalRoles(rule as never)).toEqual(['instructor', 'org_admin']);
  });

  it('no rule or no approval condition means nobody needs to approve', () => {
    expect(manualApprovalRoles(null)).toEqual([]);
    expect(manualApprovalRoles({ type: 'minimum_score', value: 60 } as never)).toEqual([]);
    expect(manualApprovalRoles({ type: 'manual_approval', approver_role: 'learner' } as never)).toEqual([]);
  });
});

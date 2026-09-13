import { APPROVER_ROLES, type ApproverRole, type RuleNode } from '@iac/contracts';

/** 完成條件中 manual_approval 要求的核可者角色（去重、依出現順序；SD §6.14） */
export function manualApprovalRoles(rule: RuleNode | null | undefined): ApproverRole[] {
  const out: ApproverRole[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    const role = o['approver_role'];
    if (o['type'] === 'manual_approval' && (APPROVER_ROLES as readonly unknown[]).includes(role) && !out.includes(role as ApproverRole)) {
      out.push(role as ApproverRole);
    }
    if (Array.isArray(o['conditions'])) o['conditions'].forEach(walk);
  };
  walk(rule);
  return out;
}

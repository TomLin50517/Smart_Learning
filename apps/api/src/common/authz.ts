import type { ScopeType } from '@iac/contracts';
import type { PermissionGrant } from './context.js';

/**
 * 授權決策的純邏輯（SA §6.1、§6.5、ADR-016、ADR-019）。
 * 不碰 DB，讓安全關鍵規則可以被窮舉測試。
 */

export interface AccessTarget {
  /** 'any'：列表類端點——在任何範圍持有此權限即可進入，結果由 handler 依授權過濾 */
  scope: ScopeType | 'any';
  /** 目標資源是否存在；不存在一律 not_found */
  exists: boolean;
  organizationId: string | null;
  courseId: string | null;
  /** self scope 的目標使用者 */
  userId: string | null;
}

export type AccessDecision = 'allow' | 'not_found' | 'forbidden';

function covers(g: PermissionGrant, t: AccessTarget, userId: string): boolean {
  switch (t.scope) {
    case 'platform':
      return g.type === 'platform';
    case 'organization':
      return g.type === 'platform' || (g.type === 'organization' && g.organizationId === t.organizationId);
    case 'course':
      return (
        g.type === 'platform' ||
        (g.type === 'organization' && g.organizationId === t.organizationId) ||
        (g.type === 'course' && g.id === t.courseId)
      );
    case 'any':
      // self 授權不算：'any' 用於管理類列表，不應因個人權限而進入
      return g.type !== 'self';
    case 'self':
      // ADR-016：self 不被上層 scope 自動涵蓋。Platform Admin 不會因此讀到學員的個人資料。
      return g.type === 'self' && g.id === userId && t.userId === userId;
  }
}

/** 使用者在目標組織中是否有「任何」授權——決定回 404 還是 403 */
function canSeeOrganization(grants: PermissionGrant[], orgId: string | null): boolean {
  return grants.some((g) => g.type === 'platform' || (orgId !== null && g.organizationId === orgId));
}

/**
 * 列表端點用：使用者在哪些組織持有此權限。platform 授權 → 'all'。
 * course / self 授權不算——組織層級的列表不應因課程或個人權限而擴大可見範圍。
 */
export function organizationsGranted(grants: readonly PermissionGrant[], permission: string): 'all' | string[] {
  if (grants.some((g) => g.permission === permission && g.type === 'platform')) return 'all';
  const ids = grants
    .filter((g) => g.permission === permission && g.type === 'organization' && g.organizationId)
    .map((g) => g.organizationId as string);
  return [...new Set(ids)];
}

export function decideAccess(
  userId: string,
  grants: readonly PermissionGrant[],
  permission: string,
  target: AccessTarget,
): AccessDecision {
  if (!target.exists) return 'not_found';

  // ADR-019：資源屬於使用者完全沒有授權的組織 → 404，不洩漏其存在
  if ((target.scope === 'organization' || target.scope === 'course') && !canSeeOrganization([...grants], target.organizationId)) {
    return 'not_found';
  }

  return grants.some((g) => g.permission === permission && covers(g, target, userId)) ? 'allow' : 'forbidden';
}

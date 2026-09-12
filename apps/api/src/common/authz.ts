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
  /** 僅 scope 'any'：self 授權也可進入（handler 必須只回本人相關的資料） */
  includeSelf?: boolean;
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
      // 預設不算 self：'any' 多用於管理類列表，不應因個人權限而進入。
      // 例外由路由明確宣告（includeSelf），且只認本人的 self 授權
      return g.type !== 'self' || (t.includeSelf === true && g.id === userId);
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

/**
 * 稽核紀錄的可見範圍（SA UC-AUD-001、§6.2 audit.read_*）：
 * - all：platform 範圍持有任一 audit.read_platform／_org／_course
 * - organizations：組織範圍的 audit.read_org（或組織範圍的 audit.read_course）
 * - courses：課程範圍的 audit.read_course
 * - self：audit.read_self——只看與本人相關的紀錄，且欄位會被裁剪
 */
export interface AuditVisibility {
  all: boolean;
  organizations: string[];
  courses: string[];
  self: boolean;
}

const AUDIT_READ = new Set(['audit.read_platform', 'audit.read_org', 'audit.read_course']);

export function auditVisibility(grants: readonly PermissionGrant[], userId: string): AuditVisibility {
  const read = grants.filter((g) => AUDIT_READ.has(g.permission));
  return {
    all: read.some((g) => g.type === 'platform'),
    organizations: [...new Set(read.filter((g) => g.type === 'organization' && g.organizationId).map((g) => g.organizationId as string))],
    courses: [...new Set(read.filter((g) => g.type === 'course' && g.id).map((g) => g.id as string))],
    self: grants.some((g) => g.permission === 'audit.read_self' && g.type === 'self' && g.id === userId),
  };
}

export function decideAccess(
  userId: string,
  grants: readonly PermissionGrant[],
  permission: string | readonly string[],
  target: AccessTarget,
): AccessDecision {
  if (!target.exists) return 'not_found';

  // ADR-019：資源屬於使用者完全沒有授權的組織 → 404，不洩漏其存在
  if ((target.scope === 'organization' || target.scope === 'course') && !canSeeOrganization([...grants], target.organizationId)) {
    return 'not_found';
  }

  // 多個權限時為「任一即可」
  const accepted = typeof permission === 'string' ? [permission] : permission;
  return grants.some((g) => accepted.includes(g.permission) && covers(g, target, userId)) ? 'allow' : 'forbidden';
}

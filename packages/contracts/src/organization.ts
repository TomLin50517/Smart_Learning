/** 可經由組織端點指派的角色；platform_admin 刻意不在其中 */
export type OrgRole = 'org_admin' | 'course_admin' | 'instructor' | 'learner' | 'auditor';

/** 需要指定課程的角色 */
export const COURSE_ROLES: readonly OrgRole[] = ['course_admin', 'instructor'] as const;

/** 組織層級角色（不指定課程） */
export const ORG_LEVEL_ROLES: readonly OrgRole[] = ['org_admin', 'learner', 'auditor'] as const;

/** 成員清單的搜尋字串上限 */
export const MEMBER_SEARCH_MAX = 100;

export interface RoleSpec {
  role: OrgRole;
  /** course_admin / instructor 必填，且課程必須屬於該組織 */
  courseId?: string;
}

/** 回應中的角色：課程角色附上課程代碼與名稱，讓管理員一眼看出是哪門課 */
export interface MemberRoleDto extends RoleSpec {
  course?: { code: string; title: string };
}

export interface OrganizationDto {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'disabled';
  branding: Record<string, unknown>;
  createdAt: string;
}

/** 在某組織的成員資格狀態（與帳號狀態分開：帳號停用影響所有組織，屬平台管理） */
export type MembershipStatus = 'active' | 'disabled';

export interface OrgMemberDto {
  id: string;
  email: string;
  displayName: string;
  /** 帳號狀態 */
  status: 'active' | 'disabled';
  /** 在本組織的成員資格；disabled 時本組織的所有權限失效，角色保留 */
  membershipStatus: MembershipStatus;
  lastLoginAt: string | null;
  /** 尚未設定密碼（邀請中） */
  pendingInvitation: boolean;
  roles: MemberRoleDto[];
  /** 學號／員工編號（組織內，不隨學年改變） */
  memberNo: string | null;
  /** 目前（使用中）的班級 */
  cohorts: CohortRefDto[];
}

// ---- 班級／梯次與學號（SD §6.15） -----------------------------------------------------

export const COHORT_NAME_MAX = 100;
export const COHORT_TERM_MAX = 50;
export const MEMBER_NO_MAX = 64;

export type CohortStatus = 'active' | 'archived';

export interface CohortRefDto {
  id: string;
  name: string;
}

export interface CohortDto extends CohortRefDto {
  /** 學年或期別標籤（選填），例：113 學年、第 5 期 */
  term: string | null;
  status: CohortStatus;
  memberCount: number;
  createdAt: string;
  archivedAt: string | null;
}

/** PATCH /organizations/{id}/users/{userId}/profile 的結果 */
export interface MemberProfileDto {
  memberNo: string | null;
  cohorts: CohortRefDto[];
}

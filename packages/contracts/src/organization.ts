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

export interface OrgMemberDto {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  /** 尚未設定密碼（邀請中） */
  pendingInvitation: boolean;
  roles: MemberRoleDto[];
}

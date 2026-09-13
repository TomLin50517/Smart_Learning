/**
 * MOD-ORG 對外介面。其他模組只能 import 此檔或 organization.module.ts（SD §1.2、.dependency-cruiser.cjs）。
 */
import type { RoleSpec } from '@iac/contracts';
import type pg from 'pg';

export interface MembershipResult {
  userId: string;
  /** 新建立的帳號（未設密碼，需寄邀請） */
  created: boolean;
  /** 這次才加入本組織 */
  added: boolean;
}

/**
 * 在呼叫端的交易內處理組織成員（批次匯入用，SD §6.11）。
 * 驗證失敗以 DomainError(VALIDATION_FAILED) 丟出，details[0].issue 為原因代碼：
 * user_not_active、member_disabled、not_in_organization（不允許建立新帳號時）、name_required。
 */
export interface OrgMembership {
  /** 確保是本組織成員：已是成員不變更其角色；非成員以 spec 加入（課程角色會同步 course_staff）；必要時建立帳號 */
  ensureMemberTx(
    tx: pg.PoolClient,
    orgId: string,
    input: { email: string; displayName: string | null; spec: RoleSpec; allowCreate: boolean; actorId: string },
  ): Promise<MembershipResult>;
  /** 授予課程角色（講師／課程管理員）並同步 course_staff；已有則不變。回傳是否新授予 */
  grantCourseRoleTx(tx: pg.PoolClient, orgId: string, userId: string, spec: RoleSpec, actorId: string): Promise<boolean>;
  /** 交易提交後寄出設定密碼邀請；回傳已交給郵件伺服器的數量 */
  inviteNew(orgId: string, userIds: readonly string[]): Promise<number>;
  /**
   * 更新成員資料（SD §6.15）：設定學號、加入班級（依名稱；createCohort 時不存在就建立）。不改角色、不寄邀請。
   * 原因代碼：member_no_taken、cohort_not_found。
   */
  updateProfileTx(
    tx: pg.PoolClient,
    orgId: string,
    userId: string,
    input: { memberNo?: string | undefined; cohortName?: string | undefined; createCohort: boolean; actorId: string },
  ): Promise<ProfileUpdateResult>;
}

export interface ProfileUpdateResult {
  memberNoChanged: boolean;
  /** 指定的班級（找到或建立的） */
  cohort: { id: string; name: string } | null;
  cohortJoined: boolean;
  cohortCreated: boolean;
}

export const ORG_MEMBERSHIP = Symbol('ORG_MEMBERSHIP');

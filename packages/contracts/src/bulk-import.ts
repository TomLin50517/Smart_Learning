/** 批次匯入：成員（含分課）與課程學員（SD §6.11） */

import type { OrgRole } from './organization.js';

/** 一次最多幾列（同步處理；更大的量改為背景工作屬後續項目） */
export const IMPORT_MAX_ROWS = 500;

/** 成員匯入的一列：role 預設 learner；courseCode 選填（學員＝選課、講師／課程管理員＝指派該課） */
export interface MemberImportRow {
  email: string;
  displayName?: string;
  role?: OrgRole | string;
  courseCode?: string;
  /** 學號／員工編號：設定或更新（與他人重複時該列錯誤） */
  memberNo?: string;
  /** 班級名稱：加入該班級（已在其中則不變；不存在時依 createMissingCohorts 決定是否建立） */
  cohort?: string;
}

/** 課程學員匯入的一列：尚非成員者需填姓名（且匯入者須有新增成員的權限） */
export interface LearnerImportRow {
  email: string;
  displayName?: string;
}

export type ImportAction = 'account_created' | 'member_added' | 'enrolled' | 'course_role_granted' | 'profile_updated' | 'cohort_created' | 'cohort_joined';

export interface ImportRowResult {
  /** 送出清單中的第幾列（1 起） */
  line: number;
  email: string;
  /** ok＝有動作；skipped＝已存在、無事可做；error＝不處理 */
  outcome: 'ok' | 'skipped' | 'error';
  actions: ImportAction[];
  /** skipped／error 的原因代碼 */
  issue?: string;
}

export interface ImportReportDto {
  /** true＝預覽：完整執行後整批復原，結果即為實際匯入時會發生的事 */
  dryRun: boolean;
  /** 實際匯入時的批次編號（稽核紀錄的 metadata.batch_id）；預覽為 null */
  batchId: string | null;
  rows: ImportRowResult[];
  summary: {
    total: number;
    ok: number;
    skipped: number;
    errors: number;
    accountsCreated: number;
    membersAdded: number;
    enrollments: number;
    courseRoles: number;
    /** 設定或變更學號的人數 */
    profilesUpdated: number;
    /** 加入班級的人次 */
    cohortJoins: number;
    /** 自動建立的班級數 */
    cohortsCreated: number;
    /** 已交給郵件伺服器的邀請信數（預覽為 0） */
    invitationsSent: number;
  };
  /** 授權的學員人數上限：exceededBy > 0 時實際匯入會整批拒絕 */
  license: { maxActiveLearners: number | null; activeLearnersAfter: number; exceededBy: number };
}

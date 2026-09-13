import { ENROLLMENT_STATUSES, IMPORT_MAX_ROWS } from '@iac/contracts';
import { z } from 'zod';

/** 批次匯入（SD §6.11）：email 格式、角色、課程代碼逐列檢查並回報在該列，不讓整批 400 */
const ImportName = z.string().max(200).optional();
export const MemberImport = z.strictObject({
  dryRun: z.boolean(),
  /** 班級名稱找不到時自動建立（SD §6.15） */
  createMissingCohorts: z.boolean().optional(),
  rows: z
    .array(
      z.object({
        email: z.string().max(254),
        displayName: ImportName,
        role: z.string().max(40).optional(),
        courseCode: z.string().max(64).optional(),
        // 長度逐列檢查並回報在該列（invalid_member_no／invalid_cohort）
        memberNo: z.string().max(200).optional(),
        cohort: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(IMPORT_MAX_ROWS),
});

/** 整班加入：預覽與確認同一個端點 */
export const CohortEnroll = z.strictObject({ dryRun: z.boolean(), cohortId: z.guid() });
export const LearnerImport = z.strictObject({
  dryRun: z.boolean(),
  rows: z.array(z.object({ email: z.string().max(254), displayName: ImportName })).min(1).max(IMPORT_MAX_ROWS),
});

/** 管理者指派學員：以 email 指定，對象須為課程所屬組織的成員 */
export const AssignEnrollment = z.strictObject({
  email: z.email().max(254),
  dueDate: z.iso.datetime({ offset: true }).optional(),
});

export const LearnerQuery = z.object({
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  /** 選課時的班級（快照，完全相符） */
  cohort: z.string().max(400).optional(),
  /** 姓名、email 或學號的部分字串 */
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

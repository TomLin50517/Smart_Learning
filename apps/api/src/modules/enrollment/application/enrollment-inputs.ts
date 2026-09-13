import { ENROLLMENT_STATUSES } from '@iac/contracts';
import { z } from 'zod';

/** 管理者指派學員：以 email 指定，對象須為課程所屬組織的成員 */
export const AssignEnrollment = z.strictObject({
  email: z.email().max(254),
  dueDate: z.iso.datetime({ offset: true }).optional(),
});

export const LearnerQuery = z.object({
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

import { Module } from '@nestjs/common';

/**
 * MOD-ENROLL：Enrollment 狀態機、加入機制、退課、重修指派
 * 護欄：不得改寫歷史 attempt（INV-6）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class EnrollmentModule {}

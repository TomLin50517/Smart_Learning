import { Module } from '@nestjs/common';
import { EnrollmentController } from './api/enrollment.controller.js';
import { EnrollmentService } from './application/enrollment.service.js';

/**
 * MOD-ENROLL：Enrollment 狀態機、加入機制、退課、重修指派
 * 護欄：不得改寫歷史 attempt（INV-6）
 *
 * 已實作（Phase 2-1，SD §6.8）：管理者指派、我的課程、課程學員名單、退課／暫停／恢復。
 * 自行加入、選課碼、審核、重新開啟、重修於後續批次。
 */
@Module({
  controllers: [EnrollmentController],
  providers: [EnrollmentService],
})
export class EnrollmentModule {}

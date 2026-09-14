import { Module } from '@nestjs/common';
import { LearningRecordModule } from '../learning-record/learning-record.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { BulkImportController } from './api/bulk-import.controller.js';
import { EnrollmentController } from './api/enrollment.controller.js';
import { SelfEnrollmentController } from './api/self-enrollment.controller.js';
import { BulkImportService } from './application/bulk-import.service.js';
import { EnrollmentService } from './application/enrollment.service.js';
import { LearnerExportService } from './application/learner-export.service.js';
import { SelfEnrollmentService } from './application/self-enrollment.service.js';

/**
 * MOD-ENROLL：Enrollment 狀態機、加入機制、退課、重修指派
 * 護欄：不得改寫歷史 attempt（INV-6）
 *
 * 已實作（Phase 2-1，SD §6.8）：管理者指派、我的課程、課程學員名單、退課／暫停／恢復。
 * Phase 2-1b（SD §6.11）：批次匯入成員（含分課）與課程學員——成員處理經 MOD-ORG 的 ORG_MEMBERSHIP。
 * SD §6.24：選課政策（選課碼／課程目錄／需審核、期間、名額）、學員自行加入、審核、學員名單匯出。
 * 重新開啟、重修於後續批次。
 */
@Module({
  // LearningRecordModule：選課時寫入 course.enrolled（LEARNING_EVENTS）
  imports: [OrganizationModule, LearningRecordModule],
  controllers: [EnrollmentController, BulkImportController, SelfEnrollmentController],
  providers: [EnrollmentService, BulkImportService, SelfEnrollmentService, LearnerExportService],
})
export class EnrollmentModule {}

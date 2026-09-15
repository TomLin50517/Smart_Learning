import { Module } from '@nestjs/common';
import { LearningRecordModule } from '../learning-record/learning-record.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { BulkImportController } from './api/bulk-import.controller.js';
import { EnrollmentController } from './api/enrollment.controller.js';
import { SelfEnrollmentController } from './api/self-enrollment.controller.js';
import { RelearningController } from './api/relearning.controller.js';
import { RelearningService } from './application/relearning.service.js';
import { CompletionModule } from '../completion/completion.module.js';
import { LicenseModule } from '../license/license.module.js';
import { NotificationModule } from '../notification/notification.module.js';
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
 * SD §6.25：重新開啟與重修（relearning_assignments；完成判定見 CompletionEngine）。
 */
@Module({
  // LearningRecordModule：選課時寫入 course.enrolled（LEARNING_EVENTS）
  // CompletionModule：重修後更新進度快照；LicenseModule：已完成 → 重新開啟時檢查授權的學員數
  // NotificationModule：加入、審核、重修等事件通知（NOTIFIER，SD §6.26）
  imports: [OrganizationModule, LearningRecordModule, CompletionModule, LicenseModule, NotificationModule],
  controllers: [EnrollmentController, BulkImportController, SelfEnrollmentController, RelearningController],
  providers: [EnrollmentService, BulkImportService, SelfEnrollmentService, LearnerExportService, RelearningService],
})
export class EnrollmentModule {}

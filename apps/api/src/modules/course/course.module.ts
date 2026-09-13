import { Module } from '@nestjs/common';
import { CourseVersionController, InteractiveDefinitionController } from './api/course-version.controller.js';
import { CourseController } from './api/course.controller.js';
import { CourseService } from './application/course.service.js';
import { CoursePublishService } from './application/publish.service.js';

/**
 * MOD-COURSE：Course、CourseVersion 狀態機、clone、validate、publish、archive
 * 護欄：不得 UPDATE 已發布版本（INV-2；DB 觸發器為第二層）
 *
 * 已實作：Phase 1-1（SD §6.5）課程建立／封存／恢復、草稿建立與編輯、clone、impact、課程人員、互動元件目錄；
 * Phase 1-2（SD §6.6、§6.7）完成條件、Coach Policy、發布前檢查 C1–C5、發布。hotfix 與強制遷移學員待選課功能。
 */
@Module({
  controllers: [CourseController, CourseVersionController, InteractiveDefinitionController],
  providers: [CourseService, CoursePublishService],
})
export class CourseModule {}

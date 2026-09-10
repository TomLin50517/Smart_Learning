import { Module } from '@nestjs/common';

/**
 * MOD-COURSE：Course、CourseVersion 狀態機、clone、validate、publish、archive
 * 護欄：不得 UPDATE 已發布版本（INV-2；DB 觸發器為第二層）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class CourseModule {}

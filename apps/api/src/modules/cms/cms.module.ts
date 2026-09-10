import { Module } from '@nestjs/common';

/**
 * MOD-CMS：首頁 block schema、revision、rollback、publish
 * 護欄：不得允許 raw HTML/script 注入（SD §7.5）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class CmsModule {}

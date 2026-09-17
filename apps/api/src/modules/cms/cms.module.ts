import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { CmsController, PlatformCmsController, PublicCmsController } from './api/cms.controller.js';
import { CmsService } from './application/cms.service.js';

/**
 * MOD-CMS（SA §351、UC-CMS）：首頁 block schema、draft／publish／revision／rollback。
 * 護欄：不得允許 raw HTML／script 注入——驗證在 cms-inputs.ts，前端以 allowlist 渲染 Markdown。
 *
 * 沿用 migration 0009 的 cms_pages／cms_revisions 與 0012 的 cms.* 權限，無新 migration。
 */
@Module({
  // 公開首頁的圖片與影片需要物件儲存；KnowledgeModule 已對外提供 OBJECT_STORAGE
  imports: [KnowledgeModule],
  controllers: [CmsController, PlatformCmsController, PublicCmsController],
  providers: [CmsService],
})
export class CmsModule {}

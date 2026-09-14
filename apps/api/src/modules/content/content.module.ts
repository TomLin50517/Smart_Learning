import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { MediaController } from './api/media.controller.js';
import { MediaService } from './application/media.service.js';

/**
 * MOD-CONTENT：Module/Lesson/Activity 樹、頁面 block、資產綁定、prerequisite
 * 護欄：同 INV-2
 *
 * 已實作：課程素材（圖片、影片）的上傳、列表、改名、刪除與內容串流（SD §6.23）。
 * 物件儲存取自 KnowledgeModule 匯出的 OBJECT_STORAGE（同一個 bucket，不同 prefix）。
 */
@Module({
  imports: [KnowledgeModule],
  controllers: [MediaController],
  providers: [MediaService],
})
export class ContentModule {}

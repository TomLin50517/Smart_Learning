import { Module } from '@nestjs/common';
import { LearningRecordModule } from '../learning-record/learning-record.module.js';
import { CertificateController, PublicCertificateController } from './api/certificate.controller.js';
import { CertificateService } from './application/certificate.service.js';

/**
 * MOD-CERT：證書資料、verification code、撤銷、公開驗證
 * 護欄：撤銷不得刪除證書（ARCH §17.4）
 *
 * 已實作（Phase 2-4，SD §6.14）：我的證書、課程證書清單、撤銷、公開驗證。發證由 worker 的 certificate.generate 執行
 * （選課完成時由學習模組在同一交易排入）。證書為網頁版（可列印成 PDF）；伺服器端 PDF 與通知於後續批次。
 * LearningRecordModule：撤銷時寫入 certificate.revoked 學習事件（LEARNING_EVENTS）。
 */
@Module({
  imports: [LearningRecordModule],
  controllers: [CertificateController, PublicCertificateController],
  providers: [CertificateService],
})
export class CertificateModule {}

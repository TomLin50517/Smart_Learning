import { Module } from '@nestjs/common';

/**
 * MOD-CERT：證書資料、PDF job、verification code、撤銷、公開驗證
 * 護欄：撤銷不得刪除證書（ARCH §17.4）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class CertificateModule {}

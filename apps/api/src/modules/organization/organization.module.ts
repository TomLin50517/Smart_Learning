import { Module } from '@nestjs/common';

/**
 * MOD-ORG：組織 CRUD、user_org_roles、品牌設定
 * 護欄：不得以 client 傳入的 organization_id 直接授權（INV-1）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class OrganizationModule {}

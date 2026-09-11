import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationController } from './api/organization.controller.js';
import { OrganizationService } from './application/organization.service.js';

/**
 * MOD-ORG：組織 CRUD、成員與角色（user_org_roles）、品牌設定。
 * 護欄：organization_id 一律由路由參數 + PermissionGuard 的 scope 驗證取得，不採信 body（INV-1）。
 * 依賴 IdentityModule 的 USER_INVITATIONS 寄送邀請（只經由 identity.contracts）。
 */
@Module({
  imports: [IdentityModule],
  controllers: [OrganizationController],
  providers: [OrganizationService],
})
export class OrganizationModule {}

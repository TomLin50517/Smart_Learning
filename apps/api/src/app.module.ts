import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './common/audit.interceptor.js';
import { CommonModule } from './common/common.module.js';
import { DatabaseModule } from './common/database.module.js';
import { AppExceptionFilter } from './common/exception.filter.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { LicenseCapabilityGuard } from './common/guards/license-capability.guard.js';
import { PermissionGuard } from './common/guards/permission.guard.js';
import { EnvModule } from './config/env.module.js';
import { AiCoachModule } from './modules/ai-coach/ai-coach.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { CertificateModule } from './modules/certificate/certificate.module.js';
import { CmsModule } from './modules/cms/cms.module.js';
import { CompletionModule } from './modules/completion/completion.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { CourseModule } from './modules/course/course.module.js';
import { DerivedKnowledgeModule } from './modules/derived-knowledge/derived-knowledge.module.js';
import { EnrollmentModule } from './modules/enrollment/enrollment.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { InteractiveRuntimeModule } from './modules/interactive-runtime/interactive-runtime.module.js';
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { LearningRecordModule } from './modules/learning-record/learning-record.module.js';
import { LicenseModule } from './modules/license/license.module.js';
import { NotificationModule } from './modules/notification/notification.module.js';
import { OrganizationModule } from './modules/organization/organization.module.js';
import { SystemModule } from './modules/system/system.module.js';

@Module({
  imports: [
    EnvModule,
    DatabaseModule,
    CommonModule,
    // SA §4.1 的 17 個模組
    IdentityModule,
    OrganizationModule,
    CmsModule,
    CourseModule,
    ContentModule,
    InteractiveRuntimeModule,
    EnrollmentModule,
    LearningRecordModule,
    CompletionModule,
    KnowledgeModule,
    DerivedKnowledgeModule,
    AiCoachModule,
    CertificateModule,
    LicenseModule,
    NotificationModule,
    AuditModule,
    SystemModule,
  ],
  providers: [
    // INV-8：AuthN → RBAC/scope/ownership → License Capability → (handler) → Audit
    // APP_GUARD 依註冊順序執行，順序即安全語意，勿任意調整。
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: LicenseCapabilityGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}

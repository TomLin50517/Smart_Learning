-- =============================================================================
-- 0012_seed_permissions.sql
-- Roles / Permissions / RolePermissions 種子資料
-- 依據：SA v1.1 §6.2（權限目錄）、§6.3（角色對照）、SD v1.1 §2.11.1
-- 相依：0002
-- =============================================================================
-- 本檔由 SA §6.2 的權限表機械產生，兩者不會漂移。
-- 修改權限請先改 SA，再重新產生本檔。
--
-- 注意：
--   * coach.conversation.read_course 雖授予 instructor / course_admin，
--     實際生效仍需通過執行期雙重條件（組織政策 × 對話戳印，ADR-028）。
--   * auditor 刻意不獲得 coach.conversation.read_course——稽核不是教學用途。
--   * 不存在 coach.conversation.read_all（跨課程/組織的全域讀取）。
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Roles
-- --------------------------------------------------------------------------
INSERT INTO roles (code, name, is_system) VALUES
  ('platform_admin', 'Platform Administrator', true),
  ('org_admin', 'Organization Administrator', true),
  ('course_admin', 'Course Administrator', true),
  ('instructor', 'Instructor', true),
  ('learner', 'Learner', true),
  ('auditor', 'Auditor / Viewer', true)
ON CONFLICT (code) DO NOTHING;

-- --------------------------------------------------------------------------
-- Permissions（73 筆）
-- --------------------------------------------------------------------------
INSERT INTO permissions (code, description, min_scope, required_capability) VALUES
  ('platform.license.read', '讀取授權狀態', 'platform', NULL),
  ('platform.license.activate', '啟用/重綁授權', 'platform', NULL),
  ('platform.settings.read', '讀取平台設定', 'platform', NULL),
  ('platform.settings.write', '修改平台設定', 'platform', 'configurationWriteAllowed'),
  ('platform.ai_provider.write', '設定 AI Provider', 'platform', 'configurationWriteAllowed'),
  ('platform.organization.create', '建立組織', 'platform', 'configurationWriteAllowed'),
  ('platform.organization.disable', '停用組織', 'platform', 'configurationWriteAllowed'),
  ('platform.backup.execute', '執行備份', 'platform', NULL),
  ('platform.health.read', '讀取健康/佇列', 'platform', NULL),
  ('org.read', '讀組織資訊', 'organization', NULL),
  ('org.settings.write', '改組織設定/品牌', 'organization', 'configurationWriteAllowed'),
  ('org.user.read', '讀組織使用者', 'organization', NULL),
  ('org.user.write', '建/停用組織使用者', 'organization', 'configurationWriteAllowed'),
  ('org.role.assign', '指派角色', 'organization', 'configurationWriteAllowed'),
  ('org.report.read', '組織報表', 'organization', NULL),
  ('org.ai_quota.write', '組織 AI 配額/retention', 'organization', 'configurationWriteAllowed'),
  ('self.profile.read', '讀自己的個人資料', 'self', NULL),
  ('self.profile.write', '編輯自己的個人資料', 'self', NULL),
  ('cms.read', '讀 CMS draft/revision', 'organization', NULL),
  ('cms.write', '編輯 block', 'organization', 'configurationWriteAllowed'),
  ('cms.publish', '發布 revision', 'organization', 'configurationWriteAllowed'),
  ('cms.rollback', '回滾', 'organization', 'configurationWriteAllowed'),
  ('course.read', '讀課程 metadata', 'course', NULL),
  ('course.create', '建立課程', 'organization', 'authoringAllowed'),
  ('course.archive', '封存課程', 'course', 'authoringAllowed'),
  ('course.staff.assign', '指派教師', 'course', 'configurationWriteAllowed'),
  ('course.version.read', '讀版本內容', 'course', NULL),
  ('course.version.create', '建立 Draft / clone', 'course', 'authoringAllowed'),
  ('course.version.write', '編輯 Draft 內容', 'course', 'authoringAllowed'),
  ('course.version.validate', '執行 validator', 'course', NULL),
  ('course.version.publish', '發布版本', 'course', 'authoringAllowed'),
  ('course.version.hotfix', 'metadata hotfix', 'course', 'authoringAllowed'),
  ('course.completion_rule.write', '設定完成條件', 'course', 'authoringAllowed'),
  ('course.coach_policy.write', '設定 Coach Policy', 'course', 'authoringAllowed'),
  ('course.learner_migration.execute', '強制遷移學員版本', 'course', 'configurationWriteAllowed'),
  ('enrollment.assign', '指派學員入課', 'course', 'maxActiveLearners'),
  ('enrollment.approve', '審核加入申請', 'course', NULL),
  ('enrollment.withdraw', '退課', 'course', NULL),
  ('enrollment.suspend', '暫停/恢復', 'course', NULL),
  ('enrollment.relearning.assign', '指派重修', 'course', NULL),
  ('enrollment.reopen', '重新開啟已完成', 'course', NULL),
  ('enrollment.self_enroll', '自行加入', 'self', 'maxActiveLearners'),
  ('learning.result.read_all', '讀全課成果', 'course', NULL),
  ('learning.result.read_self', '讀自己的成果', 'self', NULL),
  ('learning.attempt.write_self', '建立/提交自己的 attempt', 'self', 'runtimeAllowed'),
  ('learning.event.write_self', '回報自己的事件', 'self', 'runtimeAllowed'),
  ('learning.timeline.read_all', '讀任一學員 timeline（課程內）', 'course', NULL),
  ('learning.timeline.read_self', '讀自己的 timeline', 'self', NULL),
  ('coach.interact_self', '以學員身分互動', 'self', 'aiCoachAllowed'),
  ('coach.interact_test', '以測試身分試用', 'course', 'aiCoachAllowed'),
  ('coach.conversation.read_self', '讀自己的對話', 'self', NULL),
  ('coach.usage_stats.read', '讀班級使用統計（匿名）', 'course', NULL),
  ('coach.citation.open', '開啟 citation 原文（學員為 self；教師測試為 course）', 'self', NULL),
  ('coach.conversation.read_course', '讀該課學員的對話逐字稿（另受 ADR-028 執行期雙重條件約束）', 'course', NULL),
  ('coach.transcript_policy.write', '設定組織逐字稿可見性', 'organization', 'configurationWriteAllowed'),
  ('knowledge.document.read', '讀文件清單/狀態', 'course', NULL),
  ('knowledge.document.write', '上傳/新版/刪除', 'course', 'authoringAllowed'),
  ('knowledge.faq.write', '建立正式 FAQ', 'course', 'authoringAllowed'),
  ('knowledge.source.view', '開啟原文 viewer（學員經 citation 為 self；課程人員為 course）', 'self', NULL),
  ('knowledge.reindex.execute', '觸發重新索引', 'organization', 'configurationWriteAllowed'),
  ('derived.read', '讀 derived knowledge', 'course', NULL),
  ('derived.write', '編輯 derived', 'course', 'authoringAllowed'),
  ('derived.verify', 'verify / reject / retire', 'course', 'authoringAllowed'),
  ('certificate.read_all', '讀全課證書', 'course', NULL),
  ('certificate.read_self', '讀自己的證書', 'self', NULL),
  ('certificate.revoke', '撤銷證書', 'course', NULL),
  ('audit.read_platform', '平台 Audit（唯一的平台稽核讀取代碼；勿另立 platform.audit.read）', 'platform', NULL),
  ('audit.read_org', '組織 Audit', 'organization', NULL),
  ('audit.read_course', '課程 Audit', 'course', NULL),
  ('audit.read_self', '自己的敏感操作摘要', 'self', NULL),
  ('audit.export', '匯出 Audit（scope 由 grant 決定，organization 或 platform）', 'organization', NULL),
  ('notification.read_self', '讀自己的通知', 'self', NULL),
  ('notification.pref.write_self', '設定自己的通知偏好', 'self', NULL)
ON CONFLICT (code) DO NOTHING;

-- --------------------------------------------------------------------------
-- Role → Permission
-- --------------------------------------------------------------------------
-- platform_admin: 23 permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'platform_admin' AND p.code IN (
   'platform.license.read',
   'platform.license.activate',
   'platform.settings.read',
   'platform.settings.write',
   'platform.ai_provider.write',
   'platform.organization.create',
   'platform.organization.disable',
   'platform.backup.execute',
   'platform.health.read',
   'org.read',
   'self.profile.read',
   'self.profile.write',
   'cms.read',
   'cms.write',
   'cms.publish',
   'cms.rollback',
   'course.read',
   'course.version.read',
   'coach.interact_test',
   'audit.read_platform',
   'audit.export',
   'notification.read_self',
   'notification.pref.write_self'
 ) ON CONFLICT DO NOTHING;

-- org_admin: 31 permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'org_admin' AND p.code IN (
   'org.read',
   'org.settings.write',
   'org.user.read',
   'org.user.write',
   'org.role.assign',
   'org.report.read',
   'org.ai_quota.write',
   'self.profile.read',
   'self.profile.write',
   'cms.read',
   'cms.write',
   'cms.publish',
   'cms.rollback',
   'course.read',
   'course.create',
   'course.archive',
   'course.staff.assign',
   'course.version.read',
   'enrollment.assign',
   'enrollment.approve',
   'enrollment.withdraw',
   'enrollment.suspend',
   'enrollment.relearning.assign',
   'enrollment.reopen',
   'learning.result.read_all',
   'coach.interact_test',
   'coach.transcript_policy.write',
   'audit.read_org',
   'audit.export',
   'notification.read_self',
   'notification.pref.write_self'
 ) ON CONFLICT DO NOTHING;

-- course_admin: 34 permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'course_admin' AND p.code IN (
   'self.profile.read',
   'self.profile.write',
   'course.read',
   'course.archive',
   'course.staff.assign',
   'course.version.read',
   'course.version.create',
   'course.version.write',
   'course.version.validate',
   'course.version.publish',
   'course.version.hotfix',
   'course.completion_rule.write',
   'course.coach_policy.write',
   'course.learner_migration.execute',
   'enrollment.assign',
   'enrollment.approve',
   'enrollment.withdraw',
   'enrollment.suspend',
   'enrollment.relearning.assign',
   'enrollment.reopen',
   'enrollment.self_enroll',
   'learning.result.read_all',
   'learning.timeline.read_all',
   'coach.interact_test',
   'coach.conversation.read_course',
   'knowledge.document.read',
   'knowledge.document.write',
   'knowledge.source.view',
   'derived.read',
   'certificate.read_all',
   'certificate.revoke',
   'audit.read_course',
   'notification.read_self',
   'notification.pref.write_self'
 ) ON CONFLICT DO NOTHING;

-- instructor: 27 permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'instructor' AND p.code IN (
   'self.profile.read',
   'self.profile.write',
   'course.read',
   'course.version.read',
   'course.version.create',
   'course.version.write',
   'course.version.validate',
   'course.version.publish',
   'course.version.hotfix',
   'course.completion_rule.write',
   'course.coach_policy.write',
   'learning.result.read_all',
   'learning.timeline.read_all',
   'coach.interact_test',
   'coach.usage_stats.read',
   'coach.citation.open',
   'coach.conversation.read_course',
   'knowledge.document.read',
   'knowledge.document.write',
   'knowledge.faq.write',
   'knowledge.source.view',
   'derived.read',
   'derived.write',
   'derived.verify',
   'audit.read_course',
   'notification.read_self',
   'notification.pref.write_self'
 ) ON CONFLICT DO NOTHING;

-- learner: 16 permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'learner' AND p.code IN (
   'self.profile.read',
   'self.profile.write',
   'course.read',
   'enrollment.self_enroll',
   'learning.result.read_self',
   'learning.attempt.write_self',
   'learning.event.write_self',
   'learning.timeline.read_self',
   'coach.interact_self',
   'coach.conversation.read_self',
   'coach.citation.open',
   'knowledge.source.view',
   'certificate.read_self',
   'audit.read_self',
   'notification.read_self',
   'notification.pref.write_self'
 ) ON CONFLICT DO NOTHING;

-- auditor: 18 permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'auditor' AND p.code IN (
   'platform.license.read',
   'platform.settings.read',
   'platform.health.read',
   'org.read',
   'org.user.read',
   'org.report.read',
   'cms.read',
   'course.read',
   'course.version.read',
   'learning.result.read_all',
   'learning.timeline.read_all',
   'coach.usage_stats.read',
   'knowledge.document.read',
   'derived.read',
   'certificate.read_all',
   'audit.read_platform',
   'audit.read_org',
   'audit.read_course'
 ) ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('0012_seed_permissions')
  ON CONFLICT DO NOTHING;

COMMIT;
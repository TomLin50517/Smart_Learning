-- =============================================================================
-- 0025_faq_shared_knowledge.sql
-- 常見問答與常見錯誤、組織共用教材（SD §6.27）
--   * knowledge.shared.write：管理組織共用教材（source_documents.course_id IS NULL），只給組織管理員
--   * FAQ 沿用 0007 的 derived_knowledge／derived_knowledge_versions，不需新表
-- =============================================================================

INSERT INTO permissions (code, description, min_scope, required_capability) VALUES
  ('knowledge.shared.write', '管理組織共用教材', 'organization', 'authoringAllowed')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'org_admin' AND p.code = 'knowledge.shared.write'
ON CONFLICT DO NOTHING;

-- 組織共用教材清單
CREATE INDEX idx_sd_org_shared ON source_documents (organization_id) WHERE course_id IS NULL;

INSERT INTO schema_migrations (version) VALUES ('0025_faq_shared_knowledge') ON CONFLICT DO NOTHING;

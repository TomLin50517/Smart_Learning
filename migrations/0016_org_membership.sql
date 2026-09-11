-- =============================================================================
-- 0016_org_membership.sql
-- 組織成員邀請與 Platform Admin 的組織使用者唯讀權
-- 依據：SA §5.3（UC-ORG-003）、SD §8.1
-- 相依：0012, 0015
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 邀請與密碼重設共用一次性 token 機制，以 purpose 區分（有效期不同）
-- --------------------------------------------------------------------------
ALTER TABLE password_reset_tokens
  ADD COLUMN purpose text NOT NULL DEFAULT 'reset',
  ADD CONSTRAINT ck_prt_purpose CHECK (purpose IN ('reset', 'invite'));

-- --------------------------------------------------------------------------
-- SA §5.3 UC-ORG-003：Platform Admin 對組織使用者有唯讀權。
-- 原 §6.3 角色對照漏列，於此補上（其餘組織使用者管理仍屬 Org Admin）。
-- --------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'platform_admin' AND p.code = 'org.user.read'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('0016_org_membership')
  ON CONFLICT DO NOTHING;

COMMIT;

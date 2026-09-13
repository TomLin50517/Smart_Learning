-- =============================================================================
-- 0018_member_disable.sql
-- 組織成員資格的停用／恢復：只影響該組織，帳號本身與其他組織不受影響
-- 依據：SA §5.3（UC-ORG-003）、SD §8.9
-- 相依：0002, 0011
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 有列＝該使用者在該組織的成員資格已停用；角色（user_org_roles）原樣保留，恢復即刪除此列。
-- 不在 user_org_roles 加欄位：角色指派是「整組取代」（刪除後重建），狀態放在那裡會被洗掉，
-- 而且成員資格是「人 × 組織」一筆，不是每個角色一筆。
-- 權限：0011 的 ALTER DEFAULT PRIVILEGES 讓 app_api 可讀寫、其他角色唯讀。
-- --------------------------------------------------------------------------
CREATE TABLE disabled_memberships (
  organization_id uuid        NOT NULL REFERENCES organizations(id),
  user_id         uuid        NOT NULL REFERENCES users(id),
  disabled_by     uuid        REFERENCES users(id),
  disabled_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
-- 使用者端的反查（我屬於哪些組織、GrantLoader）
CREATE INDEX ix_disabled_memberships_user ON disabled_memberships (user_id);

INSERT INTO schema_migrations (version) VALUES ('0018_member_disable')
  ON CONFLICT DO NOTHING;

COMMIT;

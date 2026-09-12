-- =============================================================================
-- 0017_multi_org_roles.sql
-- 同一使用者可在多個組織擔任 self／course 範圍的角色
-- 依據：SD §8.12（切換組織）、SA §11.3.1
-- 相依：0002
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 0002 的唯一索引是 (user_id, role_id, scope_type, scope_id)。learner 的 scope 為 self、
-- scope_id = 使用者本身——同一人因此只能在「一個」組織擔任 learner，
-- 把已在他組織當學員的帳號加入第二個組織會違反唯一約束（500）。
--
-- 改為包含 organization_id。NULLS NOT DISTINCT（PG15+）：platform 角色的
-- scope_id 與 organization_id 皆為 NULL，仍視為相同值而不可重複授予。
-- --------------------------------------------------------------------------
DROP INDEX uq_uor_unique;
CREATE UNIQUE INDEX uq_uor_unique ON user_org_roles
  (user_id, role_id, scope_type, scope_id, organization_id) NULLS NOT DISTINCT;

INSERT INTO schema_migrations (version) VALUES ('0017_multi_org_roles')
  ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- 0002_identity.sql
-- Identity / Organization / RBAC
-- 依據：SD v1.1 §2.2、SA v1.1 §6、§11.3.1
-- 相依：0001
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- users
-- --------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext        NOT NULL,
  display_name       text          NOT NULL,
  password_hash      text,                      -- NULL = 僅 SSO（Phase 2）
  password_algo      text          NOT NULL DEFAULT 'argon2id',
  status             entity_status NOT NULL DEFAULT 'active',
  locale             text          NOT NULL DEFAULT 'zh-TW',
  mfa_enabled        boolean       NOT NULL DEFAULT false,
  failed_login_count smallint      NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz
);
CREATE UNIQUE INDEX uq_users_email ON users (email);
CREATE INDEX idx_users_status ON users (status);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- organizations
-- --------------------------------------------------------------------------
CREATE TABLE organizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text          NOT NULL,
  name           text          NOT NULL,
  status         entity_status NOT NULL DEFAULT 'active',
  branding       jsonb         NOT NULL DEFAULT '{}'::jsonb,
  settings       jsonb         NOT NULL DEFAULT '{}'::jsonb,  -- retention / ai_quota / derived_threshold
  storage_prefix text          NOT NULL,                      -- SaaS 預留（ARCH §5.1）
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz
);
CREATE UNIQUE INDEX uq_organizations_code ON organizations (code);
CREATE TRIGGER trg_org_updated BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- roles / permissions
-- --------------------------------------------------------------------------
CREATE TABLE roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text    NOT NULL,
  name       text    NOT NULL,
  is_system  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_roles_code ON roles (code);

CREATE TABLE permissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text       NOT NULL,
  description         text       NOT NULL,
  min_scope           scope_type NOT NULL,
  required_capability text,                     -- LicenseCapabilities 欄位名；NULL = 不需
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_permissions_code ON permissions (code);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- --------------------------------------------------------------------------
-- user_org_roles
-- scope 一致性由 DB 保證，而非僅靠應用層（SA THR-E-002 的縱深防禦）
-- --------------------------------------------------------------------------
CREATE TABLE user_org_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES roles(id),
  scope_type      scope_type NOT NULL,
  scope_id        uuid,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  granted_by      uuid REFERENCES users(id),
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_uor_scope CHECK (
       (scope_type = 'platform'
         AND scope_id IS NULL AND organization_id IS NULL)
    OR (scope_type = 'organization'
         AND organization_id IS NOT NULL AND scope_id = organization_id)
    OR (scope_type IN ('course','self')
         AND scope_id IS NOT NULL AND organization_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_uor_unique ON user_org_roles
  (user_id, role_id, scope_type,
   COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_uor_user  ON user_org_roles (user_id);
CREATE INDEX idx_uor_scope ON user_org_roles (scope_type, scope_id);
CREATE INDEX idx_uor_org   ON user_org_roles (organization_id);

-- --------------------------------------------------------------------------
-- user_sessions（只存 token hash）
-- --------------------------------------------------------------------------
CREATE TABLE user_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash     text NOT NULL,
  active_organization_id uuid REFERENCES organizations(id),
  issued_at              timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  revoked_at             timestamptz,
  ip                     inet,
  user_agent             text
);
CREATE UNIQUE INDEX uq_sessions_token ON user_sessions (session_token_hash);
CREATE INDEX idx_sessions_user_active ON user_sessions (user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expiry ON user_sessions (expires_at);

INSERT INTO schema_migrations (version) VALUES ('0002_identity')
  ON CONFLICT DO NOTHING;

COMMIT;

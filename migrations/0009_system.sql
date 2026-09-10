-- =============================================================================
-- 0009_system.sql
-- CMS / Certificate / Notification / Audit / License / SystemSettings
-- 依據：SD v1.1 §2.7、SA v1.1 §7.6、§7.7、§11.3.6
-- 相依：0005
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- CMS（block-based；禁 raw html，見 SD §7.5）
-- --------------------------------------------------------------------------
CREATE TABLE cms_pages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = 平台
  page_key            text NOT NULL,
  current_revision_id uuid,
  draft_blocks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz
);
CREATE UNIQUE INDEX uq_cms_org_key ON cms_pages
  (COALESCE(organization_id,'00000000-0000-0000-0000-000000000000'::uuid), page_key);

CREATE TABLE cms_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cms_page_id  uuid NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE,
  revision_no  integer NOT NULL,
  blocks       jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id),
  note         text
);
CREATE UNIQUE INDEX uq_cmsrev_page_no ON cms_revisions (cms_page_id, revision_no);

ALTER TABLE cms_pages ADD CONSTRAINT fk_cms_current_rev
  FOREIGN KEY (current_revision_id) REFERENCES cms_revisions(id);

-- --------------------------------------------------------------------------
-- certificates
-- 撤銷不刪除 PDF object，只改狀態（ARCH §17.4）
-- 顯示欄位為發證當下的快照，避免日後改名造成既發證書內容變動
-- --------------------------------------------------------------------------
CREATE TABLE certificates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  enrollment_id        uuid NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  course_version_id    uuid NOT NULL REFERENCES course_versions(id),
  public_id            text NOT NULL,           -- ULID，對外顯示
  verification_code    text NOT NULL,           -- 高熵 base32，不可猜測
  status               certificate_status NOT NULL DEFAULT 'pending',
  learner_display_name text NOT NULL,
  course_title         text NOT NULL,
  organization_name    text NOT NULL,
  issued_at            timestamptz,
  valid_from           timestamptz,
  valid_until          timestamptz,
  pdf_object_key       text,
  pdf_sha256           text,
  revoked_at           timestamptz,
  revoke_reason        text,
  revoked_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz,
  CONSTRAINT ck_cert_revoked CHECK
    (status <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT ck_cert_code_len CHECK (char_length(verification_code) >= 20)
);
CREATE UNIQUE INDEX uq_cert_public_id    ON certificates (public_id);
CREATE UNIQUE INDEX uq_cert_verification ON certificates (verification_code);
-- 同一 enrollment 至多一張有效證書（SA AC-CRT-002）
CREATE UNIQUE INDEX uq_cert_enr_valid ON certificates (enrollment_id)
  WHERE status = 'valid';
CREATE INDEX idx_cert_org_status ON certificates (organization_id, status);
CREATE TRIGGER trg_cert_updated BEFORE UPDATE ON certificates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- notifications
-- --------------------------------------------------------------------------
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL,
  channel         text NOT NULL DEFAULT 'in_app',
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at         timestamptz,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_ntf_channel CHECK (channel IN ('in_app','email'))
);
CREATE INDEX idx_ntf_user_unread ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
  user_id uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type    text    NOT NULL,
  in_app  boolean NOT NULL DEFAULT true,
  email   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, type)
);

-- --------------------------------------------------------------------------
-- audit_logs — 月分區 + append-only（NFR-SEC-005 / AC-AUD-002）
-- --------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_user_id    uuid,
  actor_role       text,
  actor_ip         inet,
  actor_user_agent text,
  action           text NOT NULL,
  resource_type    text NOT NULL,
  resource_id      uuid,
  organization_id  uuid,
  course_id        uuid,
  outcome          text NOT NULL DEFAULT 'success',
  before_state     jsonb,
  after_state      jsonb,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id   text,
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT ck_al_outcome CHECK (outcome IN ('success','denied','error'))
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

CREATE INDEX idx_al_org_time    ON audit_logs (organization_id, occurred_at DESC);
CREATE INDEX idx_al_action_time ON audit_logs (action, occurred_at DESC);
CREATE INDEX idx_al_actor_time  ON audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX idx_al_resource    ON audit_logs (resource_type, resource_id);

CREATE TRIGGER trg_al_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- --------------------------------------------------------------------------
-- licenses（產品僅內建 public key；raw_payload 保留供重新驗證）
-- --------------------------------------------------------------------------
CREATE TABLE licenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id        text NOT NULL,
  customer_id       text NOT NULL,
  edition           text NOT NULL,
  license_type      license_type NOT NULL,
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz,
  maintenance_until timestamptz,
  hardware_binding  text NOT NULL,
  features          jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits            jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_payload       text NOT NULL,
  signature_algo    text NOT NULL DEFAULT 'Ed25519',
  imported_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_licenses_license_id ON licenses (license_id);

CREATE TABLE license_activations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id              uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  fingerprint             text NOT NULL,
  mode                    text NOT NULL,
  status                  text NOT NULL DEFAULT 'active',
  activated_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  clock_rollback_detected boolean NOT NULL DEFAULT false,
  revoked_at              timestamptz,
  revoked_reason          text,
  CONSTRAINT ck_la_mode CHECK (mode IN ('online','offline')),
  CONSTRAINT ck_la_status CHECK (status IN ('active','revoked'))
);
CREATE UNIQUE INDEX uq_la_active ON license_activations (license_id) WHERE status = 'active';
CREATE INDEX idx_la_fingerprint ON license_activations (fingerprint);

-- offline activation 的一次性 nonce（SA SEQ-09）
CREATE TABLE license_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce           text NOT NULL,
  fingerprint     text NOT NULL,
  product_version text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);
CREATE UNIQUE INDEX uq_lc_nonce ON license_challenges (nonce);

-- --------------------------------------------------------------------------
-- system_settings
-- 注意：coach_transcript_visibility 刻意不 seed。
-- 「無列」代表尚未決定，resolver 回傳 aggregate_only（SD §2.11.2）。
-- --------------------------------------------------------------------------
-- 主鍵不可含運算式、也不可含可為 NULL 的欄位，因此採代理主鍵。
-- 唯一性以 NULLS NOT DISTINCT（PG15+）表達：platform scope 的 scope_id 為 NULL
-- 時仍視為相同值。相較於 COALESCE 運算式索引，此寫法可直接作為
-- INSERT ... ON CONFLICT (scope_type, scope_id, key) 的衝突目標。
CREATE TABLE system_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type scope_type NOT NULL,
  scope_id   uuid,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_system_settings UNIQUE NULLS NOT DISTINCT (scope_type, scope_id, key),
  CONSTRAINT ck_ss_scope CHECK (
       (scope_type = 'platform' AND scope_id IS NULL)
    OR (scope_type <> 'platform' AND scope_id IS NOT NULL)
  )
);

INSERT INTO schema_migrations (version) VALUES ('0009_system')
  ON CONFLICT DO NOTHING;

COMMIT;

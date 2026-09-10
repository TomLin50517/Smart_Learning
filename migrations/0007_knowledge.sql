-- =============================================================================
-- 0007_knowledge.sql
-- SourceDocument / DocumentVersion / ChunkManifest / Binding / DerivedKnowledge
-- 依據：SD v1.1 §2.5、SA v1.1 §7.4、§7.5、§11.3.4
-- 相依：0003
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- source_documents
-- --------------------------------------------------------------------------
CREATE TABLE source_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  course_id          uuid REFERENCES courses(id) ON DELETE CASCADE,  -- NULL = 組織級共用
  title              text NOT NULL,
  doc_type           text NOT NULL,
  language           text NOT NULL DEFAULT 'zh-TW',
  current_version_id uuid,                    -- FK 於下方補
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz,
  CONSTRAINT ck_sd_type CHECK (doc_type IN ('material','sop','faq','policy'))
);
CREATE INDEX idx_sd_org_course ON source_documents (organization_id, course_id);

-- --------------------------------------------------------------------------
-- document_versions（處理狀態機見 SA §7.4）
-- --------------------------------------------------------------------------
CREATE TABLE document_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id    uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  version_no            integer NOT NULL,
  status                document_status NOT NULL DEFAULT 'uploaded',
  original_filename     text NOT NULL,
  mime_type             text NOT NULL,
  size_bytes            bigint NOT NULL,
  sha256                text NOT NULL,
  object_key            text NOT NULL,        -- SD §5 命名規則；不含原始檔名
  page_count            integer,
  chunk_count           integer,
  processing_started_at timestamptz,
  processed_at          timestamptz,
  failure_reason        text,
  uploaded_by           uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz,
  CONSTRAINT ck_dv_size CHECK (size_bytes > 0),
  CONSTRAINT ck_dv_sha CHECK (char_length(sha256) = 64)
);
CREATE UNIQUE INDEX uq_dv_doc_version ON document_versions (source_document_id, version_no);
CREATE INDEX idx_dv_status ON document_versions (status)
  WHERE status NOT IN ('ready','retired');
CREATE INDEX idx_dv_sha ON document_versions (organization_id, sha256);
CREATE TRIGGER trg_dv_updated BEFORE UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE source_documents
  ADD CONSTRAINT fk_sd_current_version
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id);

-- --------------------------------------------------------------------------
-- knowledge_chunk_manifest
-- chunk 全文存於 Elasticsearch；PostgreSQL 只保留定位資訊與處理狀態。
-- --------------------------------------------------------------------------
CREATE TABLE knowledge_chunk_manifest (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  chunk_id            text NOT NULL,          -- 同 Elasticsearch _id
  chunk_index         integer NOT NULL,
  page_no             integer,
  section_path        text,
  char_start          integer NOT NULL,
  char_end            integer NOT NULL,
  token_count         integer,
  content_hash        text NOT NULL,
  indexed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_kcm_range CHECK (char_end > char_start)
);
CREATE UNIQUE INDEX uq_kcm_chunk_id ON knowledge_chunk_manifest (chunk_id);
CREATE INDEX idx_kcm_dv ON knowledge_chunk_manifest (document_version_id, chunk_index);

-- --------------------------------------------------------------------------
-- knowledge_bindings
-- publish 時凍結 document_version_id，確保舊學員的 citation 永不失效（ARCH §13.5）
-- --------------------------------------------------------------------------
CREATE TABLE knowledge_bindings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_version_id   uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  binding_type        text NOT NULL DEFAULT 'course_source',
  priority            smallint NOT NULL DEFAULT 100,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_kb_type CHECK (binding_type IN ('course_source','reference','sop'))
);
CREATE UNIQUE INDEX uq_kb_cv_dv ON knowledge_bindings (course_version_id, document_version_id);
CREATE INDEX idx_kb_dv ON knowledge_bindings (document_version_id);

CREATE TRIGGER trg_kb_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON knowledge_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_published_version_write();

-- --------------------------------------------------------------------------
-- derived_knowledge（狀態機見 SA §7.5）
-- --------------------------------------------------------------------------
CREATE TABLE derived_knowledge (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  course_version_id  uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  kind               text NOT NULL,
  status             derived_status NOT NULL DEFAULT 'auto_generated',
  evidence_status    evidence_status NOT NULL DEFAULT 'insufficient_evidence',
  cluster_key        text NOT NULL,
  cluster_size       integer NOT NULL,
  current_version_id uuid,                    -- FK 於下方補
  first_seen_at      timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  reviewed_by        uuid REFERENCES users(id),
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz,
  CONSTRAINT ck_dk_kind CHECK (kind IN ('faq','common_error','fix_path','trend')),
  CONSTRAINT ck_dk_cluster_size CHECK (cluster_size >= 1)
);
CREATE UNIQUE INDEX uq_dk_cluster ON derived_knowledge (course_version_id, kind, cluster_key);
CREATE INDEX idx_dk_cv_status ON derived_knowledge (course_version_id, status);
CREATE TRIGGER trg_dk_updated BEFORE UPDATE ON derived_knowledge
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- derived_knowledge_versions
-- 教師編輯建立新版本，保留 auto-generated 原文（ARCH §14.4-5）
-- --------------------------------------------------------------------------
CREATE TABLE derived_knowledge_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  derived_knowledge_id uuid NOT NULL REFERENCES derived_knowledge(id) ON DELETE CASCADE,
  version_no           integer NOT NULL,
  question             text NOT NULL,
  answer               text NOT NULL,
  citations            jsonb NOT NULL DEFAULT '[]'::jsonb,
  authored_by_type     text NOT NULL,
  authored_by          uuid REFERENCES users(id),
  model                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_dkv_author CHECK (authored_by_type IN ('system','user')),
  CONSTRAINT ck_dkv_author_id CHECK
    ((authored_by_type = 'system' AND authored_by IS NULL) OR
     (authored_by_type = 'user'   AND authored_by IS NOT NULL))
);
CREATE UNIQUE INDEX uq_dkv_version
  ON derived_knowledge_versions (derived_knowledge_id, version_no);

ALTER TABLE derived_knowledge
  ADD CONSTRAINT fk_dk_current_version
  FOREIGN KEY (current_version_id) REFERENCES derived_knowledge_versions(id);

INSERT INTO schema_migrations (version) VALUES ('0007_knowledge')
  ON CONFLICT DO NOTHING;

COMMIT;

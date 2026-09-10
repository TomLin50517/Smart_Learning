-- =============================================================================
-- 0008_coach.sql
-- PromptVersion / Conversation / Message / Citation / AiUsage
-- 依據：SD v1.1 §2.6、SA v1.1 ADR-028
-- 相依：0005, 0007
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- prompt_versions
-- --------------------------------------------------------------------------
CREATE TABLE prompt_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose         text NOT NULL,
  version         text NOT NULL,
  template        text NOT NULL,
  response_schema jsonb NOT NULL,
  is_active       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_pv_purpose CHECK
    (purpose IN ('coach_answer','derived_generate','summarize'))
);
CREATE UNIQUE INDEX uq_pv_purpose_version ON prompt_versions (purpose, version);
CREATE UNIQUE INDEX uq_pv_active ON prompt_versions (purpose) WHERE is_active;

-- --------------------------------------------------------------------------
-- coach_conversations
--
-- transcript_visibility：NOT NULL 且刻意不設 DEFAULT（SD §2.11.3）。
-- 任何忘記帶值的 INSERT 會在開發期立即失敗，而不是靜默落入某個預設值。
-- 由於下方觸發器會讓寫錯的值永久無法修正，寧可讓錯誤在最早的時點爆出來。
-- --------------------------------------------------------------------------
CREATE TABLE coach_conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  enrollment_id         uuid REFERENCES enrollments(id) ON DELETE CASCADE,
  learner_id            uuid NOT NULL REFERENCES users(id),
  course_version_id     uuid NOT NULL REFERENCES course_versions(id),
  lesson_id             uuid REFERENCES lessons(id),
  activity_id           uuid REFERENCES activities(id),
  trigger_type          coach_trigger NOT NULL,
  is_test               boolean NOT NULL DEFAULT false,
  transcript_visibility transcript_visibility NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  last_message_at       timestamptz,
  message_count         integer NOT NULL DEFAULT 0,
  anonymized_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_cc_test CHECK (is_test = false OR enrollment_id IS NULL)
);
CREATE INDEX idx_cc_enr     ON coach_conversations (enrollment_id, started_at DESC);
CREATE INDEX idx_cc_learner ON coach_conversations (learner_id, started_at DESC);
CREATE INDEX idx_cc_cv_agg  ON coach_conversations (course_version_id, started_at)
  WHERE is_test = false;
CREATE INDEX idx_cc_visible ON coach_conversations (course_version_id, started_at DESC)
  WHERE transcript_visibility = 'course_staff' AND is_test = false;

-- ADR-028 條件 4：可見性戳印不可回溯。
-- 組織日後變更政策只影響新對話；既有對話的承諾不可被撤回（THR-I-011）。
CREATE OR REPLACE FUNCTION freeze_transcript_visibility() RETURNS trigger AS $$
BEGIN
  IF NEW.transcript_visibility IS DISTINCT FROM OLD.transcript_visibility THEN
    RAISE EXCEPTION 'TRANSCRIPT_VISIBILITY_IMMUTABLE' USING
      ERRCODE = 'P0001',
      DETAIL  = format('conversation %s 的可見性戳印為 %s，建立後不可變更',
                       OLD.id, OLD.transcript_visibility),
      HINT    = '組織政策變更只影響新建立的對話';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cc_freeze_visibility
  BEFORE UPDATE ON coach_conversations
  FOR EACH ROW EXECUTE FUNCTION freeze_transcript_visibility();

-- --------------------------------------------------------------------------
-- coach_messages
-- --------------------------------------------------------------------------
CREATE TABLE coach_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  conversation_id   uuid NOT NULL REFERENCES coach_conversations(id) ON DELETE CASCADE,
  seq_no            integer NOT NULL,
  role              coach_role NOT NULL,
  content           text NOT NULL,
  policy_snapshot   jsonb,
  prompt_version_id uuid REFERENCES prompt_versions(id),
  validation_status text,
  fallback_reason   text,
  citation_count    smallint NOT NULL DEFAULT 0,
  correlation_id    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_cm_validation CHECK
    (validation_status IS NULL OR validation_status IN ('passed','repaired','fallback'))
);
CREATE UNIQUE INDEX uq_cm_conv_seq ON coach_messages (conversation_id, seq_no);
CREATE INDEX idx_cm_conv ON coach_messages (conversation_id, seq_no);

-- --------------------------------------------------------------------------
-- coach_citations（SD §10.4 CitationValidator 的持久化結果）
-- --------------------------------------------------------------------------
CREATE TABLE coach_citations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  message_id           uuid NOT NULL REFERENCES coach_messages(id) ON DELETE CASCADE,
  citation_ref         text NOT NULL,           -- 回應中的 c1 / c2
  chunk_id             text,
  document_version_id  uuid REFERENCES document_versions(id),
  derived_knowledge_id uuid REFERENCES derived_knowledge(id),
  title                text NOT NULL,
  page_no              integer,
  section_path         text,
  char_start           integer,
  char_end             integer,
  opened_count         integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_cct_target CHECK (chunk_id IS NOT NULL OR derived_knowledge_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_cct_msg_ref ON coach_citations (message_id, citation_ref);
CREATE INDEX idx_cct_message ON coach_citations (message_id);

-- --------------------------------------------------------------------------
-- ai_usage_records（成本以整數 micro 單位儲存，避免浮點誤差）
-- --------------------------------------------------------------------------
CREATE TABLE ai_usage_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES organizations(id),
  course_id         uuid REFERENCES courses(id),
  message_id        uuid REFERENCES coach_messages(id) ON DELETE SET NULL,
  job_id            uuid,
  purpose           text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens      integer GENERATED ALWAYS AS (prompt_tokens + completion_tokens) STORED,
  cost_micro        bigint NOT NULL DEFAULT 0,
  latency_ms        integer,
  status            text NOT NULL,
  error_code        text,
  correlation_id    text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_aur_status CHECK (status IN ('success','error','timeout'))
);
CREATE INDEX idx_aur_org_time     ON ai_usage_records (organization_id, occurred_at DESC);
CREATE INDEX idx_aur_model_time   ON ai_usage_records (model, occurred_at DESC);
CREATE INDEX idx_aur_purpose_time ON ai_usage_records (purpose, occurred_at DESC);

INSERT INTO schema_migrations (version) VALUES ('0008_coach')
  ON CONFLICT DO NOTHING;

COMMIT;

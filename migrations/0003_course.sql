-- =============================================================================
-- 0003_course.sql
-- Course / CourseVersion / Content / CompletionRuleSet / CoachPolicy
-- 依據：SD v1.1 §2.3、SA v1.1 §7.1、§11.3.2
-- 相依：0002
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- courses
-- --------------------------------------------------------------------------
CREATE TABLE courses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code              text NOT NULL,
  title             text NOT NULL,
  description       text,
  status            course_status NOT NULL DEFAULT 'draft',
  enrollment_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- { mode:'assign'|'self'|'code'|'approval', code?, window?:{from,to}, max_seats?, group_ids? }
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz
);
CREATE UNIQUE INDEX uq_courses_org_code ON courses (organization_id, code);
CREATE INDEX idx_courses_org_status ON courses (organization_id, status);
CREATE TRIGGER trg_courses_updated BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- course_versions
-- --------------------------------------------------------------------------
CREATE TABLE course_versions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id              uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  organization_id        uuid NOT NULL REFERENCES organizations(id),  -- 反正規化：強制過濾
  version_no             integer NOT NULL,
  status                 course_version_status NOT NULL DEFAULT 'draft',
  title                  text NOT NULL,
  summary                text,
  navigation_mode        text NOT NULL DEFAULT 'mixed',
  cloned_from_version_id uuid REFERENCES course_versions(id),
  content_snapshot_hash  text,
  published_at           timestamptz,
  published_by           uuid REFERENCES users(id),
  archived_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz,
  CONSTRAINT ck_cv_navigation CHECK
    (navigation_mode IN ('strict','prerequisite','free','mixed')),
  CONSTRAINT ck_cv_published CHECK (
       (status IN ('published','superseded','archived') AND published_at IS NOT NULL)
    OR (status IN ('draft','review'))
  )
);
CREATE UNIQUE INDEX uq_cv_course_version ON course_versions (course_id, version_no);
-- 同一課程至多一個 active published version（SA AC-CRS-007）
CREATE UNIQUE INDEX uq_cv_single_published ON course_versions (course_id)
  WHERE status = 'published';
CREATE INDEX idx_cv_org_status ON course_versions (organization_id, status);
CREATE TRIGGER trg_cv_updated BEFORE UPDATE ON course_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- modules / lessons
-- lessons 帶 course_version_id 冗餘欄位，供 immutability 觸發器直接判定（SD §2.3.1）
-- --------------------------------------------------------------------------
CREATE TABLE modules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  sort_order        integer NOT NULL,
  title             text NOT NULL,
  description       text,
  is_required       boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz
);
CREATE UNIQUE INDEX uq_modules_cv_order ON modules (course_version_id, sort_order);

CREATE TABLE lessons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  sort_order        integer NOT NULL,
  title             text NOT NULL,
  content_blocks    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- block schema，禁 raw html（SD §7.5）
  is_required       boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz
);
CREATE UNIQUE INDEX uq_lessons_module_order ON lessons (module_id, sort_order);
CREATE INDEX idx_lessons_cv ON lessons (course_version_id);

-- --------------------------------------------------------------------------
-- interactive_definitions
-- --------------------------------------------------------------------------
CREATE TABLE interactive_definitions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_type    text NOT NULL,
  schema_version    text NOT NULL,
  display_name      text NOT NULL,
  config_schema     jsonb NOT NULL,
  runtime_schema    jsonb NOT NULL,
  result_schema     jsonb NOT NULL,
  answer_key_schema jsonb,
  event_mapping     jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_evaluator  text NOT NULL,        -- ADR-024：成績只由 server evaluator 產生
  is_enabled        boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_intdef_type_version
  ON interactive_definitions (component_type, schema_version);

-- --------------------------------------------------------------------------
-- activities
-- answer_key 僅存在 server；runtime DTO 以白名單序列化剝除（SD §7.3.4）
-- --------------------------------------------------------------------------
CREATE TABLE activities (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id                 uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_version_id         uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  sort_order                integer NOT NULL,
  title                     text NOT NULL,
  activity_type             text NOT NULL,
  interactive_definition_id uuid REFERENCES interactive_definitions(id),
  config                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  answer_key                jsonb,
  is_required               boolean NOT NULL DEFAULT true,
  max_attempts              integer,
  weight                    numeric(6,3) NOT NULL DEFAULT 1.0,
  max_score                 numeric(8,2) NOT NULL DEFAULT 100,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz,
  CONSTRAINT ck_activities_max_attempts CHECK (max_attempts IS NULL OR max_attempts >= 1),
  CONSTRAINT ck_activities_weight CHECK (weight >= 0),
  CONSTRAINT ck_activities_type CHECK
    (activity_type IN ('video','quiz','interactive','reading','assignment'))
);
CREATE UNIQUE INDEX uq_activities_lesson_order ON activities (lesson_id, sort_order);
CREATE INDEX idx_activities_cv ON activities (course_version_id);

-- --------------------------------------------------------------------------
-- activity_prerequisites
-- --------------------------------------------------------------------------
CREATE TABLE activity_prerequisites (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id             uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  prerequisite_expression jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_actpre_activity ON activity_prerequisites (activity_id);

-- --------------------------------------------------------------------------
-- completion_rule_sets（SD §3 evaluator 的輸入）
-- --------------------------------------------------------------------------
CREATE TABLE completion_rule_sets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  grammar_version   text NOT NULL DEFAULT '1.0',
  rule_json         jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz
);
CREATE UNIQUE INDEX uq_crs_cv ON completion_rule_sets (course_version_id);

-- --------------------------------------------------------------------------
-- coach_policies（隨 course_version immutable）
-- --------------------------------------------------------------------------
CREATE TABLE coach_policies (
  id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_version_id                  uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  response_mode                      text NOT NULL DEFAULT 'hint_first',
  max_directness_level               smallint NOT NULL DEFAULT 2,
  allow_answer_reveal_after_attempts smallint,
  preferred_language                 text NOT NULL DEFAULT 'zh-TW',
  citation_required                  boolean NOT NULL DEFAULT true,
  allowed_knowledge_scopes           jsonb NOT NULL
                                       DEFAULT '["course_source","verified_faq"]'::jsonb,
  tone_profile                       text NOT NULL DEFAULT 'supportive',
  follow_up_questions                boolean NOT NULL DEFAULT true,
  prohibited_topics                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  extra_instructions                 text,
  created_at                         timestamptz NOT NULL DEFAULT now(),
  updated_at                         timestamptz,
  CONSTRAINT ck_cp_directness CHECK (max_directness_level BETWEEN 1 AND 5),
  CONSTRAINT ck_cp_mode CHECK
    (response_mode IN ('hint_first','coach_first','direct_allowed'))
);
CREATE UNIQUE INDEX uq_coach_policies_cv ON coach_policies (course_version_id);

-- --------------------------------------------------------------------------
-- course_staff
-- --------------------------------------------------------------------------
CREATE TABLE course_staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_role  text NOT NULL,
  assigned_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_staff_role CHECK (staff_role IN ('instructor','course_admin','assistant'))
);
CREATE UNIQUE INDEX uq_course_staff ON course_staff (course_id, user_id, staff_role);
CREATE INDEX idx_course_staff_user ON course_staff (user_id);

INSERT INTO schema_migrations (version) VALUES ('0003_course')
  ON CONFLICT DO NOTHING;

COMMIT;

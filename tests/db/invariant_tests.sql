-- =============================================================================
-- Invariant tests for migrations 0001-0014
-- Each test: pg_temp.t(name, role|NULL, sql, expect)
--   expect = 'OK'            -> statement must succeed
--          = 5-char SQLSTATE -> must fail with that SQLSTATE
--          = other text      -> must fail with message matching regex
-- =============================================================================
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

-- ------------------------------------------------------------------ fixtures
BEGIN;
INSERT INTO organizations (id, code, name, storage_prefix) VALUES
 ('11111111-0000-0000-0000-000000000001','org-alpha','Org Alpha','alpha'),
 ('11111111-0000-0000-0000-000000000002','org-beta','Org Beta','beta');

INSERT INTO users (id, email, display_name) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','learner@alpha.test','Learner A'),
 ('aaaaaaaa-0000-0000-0000-000000000002','teacher@alpha.test','Teacher A'),
 ('aaaaaaaa-0000-0000-0000-000000000003','learner2@alpha.test','Learner B');

INSERT INTO courses (id, organization_id, code, title) VALUES
 ('c0000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','CA-1','Course A');

INSERT INTO course_versions (id, course_id, organization_id, version_no, title) VALUES
 ('c1000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',1,'v1'),
 ('c1000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',2,'v2');

INSERT INTO modules (id, course_version_id, sort_order, title) VALUES
 ('d0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',1,'M1'),
 ('d0000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000002',1,'M2');

INSERT INTO lessons (id, module_id, course_version_id, sort_order, title) VALUES
 ('e0000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',1,'L1'),
 ('e0000000-0000-0000-0000-000000000002','d0000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000002',1,'L2');

INSERT INTO activities (id, lesson_id, course_version_id, sort_order, title, activity_type, interactive_definition_id) VALUES
 ('f0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',1,'A1','interactive',
    (SELECT id FROM interactive_definitions WHERE component_type='native.ParameterControl')),
 ('f0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000002',1,'A2','quiz',NULL);

INSERT INTO activity_prerequisites (activity_id, prerequisite_expression) VALUES
 ('f0000000-0000-0000-0000-000000000001','{"operator":"AND","conditions":[]}');
INSERT INTO completion_rule_sets (course_version_id, rule_json) VALUES
 ('c1000000-0000-0000-0000-000000000001','{"operator":"AND","conditions":[{"type":"required_activities_completed","value":true}]}');
INSERT INTO coach_policies (course_version_id) VALUES ('c1000000-0000-0000-0000-000000000001');

-- publish v1 (draft -> published is a legal status transition)
UPDATE course_versions SET status='published', published_at=now()
 WHERE id='c1000000-0000-0000-0000-000000000001';

INSERT INTO enrollments (id, organization_id, course_id, course_version_id, user_id, enroll_method) VALUES
 ('b0000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','assign');

INSERT INTO learning_attempts (id, organization_id, enrollment_id, activity_id, attempt_no, status) VALUES
 ('a1000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000001',1,'scored'),
 ('a1000000-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000001',2,'in_progress');

INSERT INTO learning_results (id, organization_id, attempt_id, enrollment_id, activity_id, status, score, max_score, evaluator) VALUES
 ('a2000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000001','needs_improvement',72,100,'ParameterRangeEvaluator@1.0');

INSERT INTO coach_conversations (id, organization_id, enrollment_id, learner_id, course_version_id, trigger_type, transcript_visibility) VALUES
 ('cc000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','learner_question','aggregate_only');

INSERT INTO certificates (id, organization_id, enrollment_id, course_version_id, public_id, verification_code, status,
                          learner_display_name, course_title, organization_name, issued_at) VALUES
 ('ce000000-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001','01JTEST0000000000000000001','ABCDEFGHJKLMNPQRSTUVWXYZ23456789','valid',
  'Learner A','Course A','Org Alpha',now());

INSERT INTO audit_logs (action, resource_type, organization_id)
VALUES ('course.version.published','course_version','11111111-0000-0000-0000-000000000001');
COMMIT;

-- a table created AFTER 0011, to prove ALTER DEFAULT PRIVILEGES works
CREATE TABLE zz_future_table (id int);

-- ------------------------------------------------------------------ harness
CREATE TEMP TABLE r (n serial, name text, expect text, got text, ok boolean);

CREATE FUNCTION pg_temp.t(p_name text, p_role text, p_sql text, p_expect text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_state text := 'OK'; v_msg text := '';
BEGIN
  BEGIN
    IF p_role IS NOT NULL THEN EXECUTE format('SET LOCAL ROLE %I', p_role); END IF;
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  RESET ROLE;
  INSERT INTO r(name, expect, got, ok) VALUES (
    p_name, p_expect,
    CASE WHEN v_state='OK' THEN 'OK' ELSE v_state || ' ' || left(v_msg, 55) END,
    CASE
      WHEN p_expect = 'OK'               THEN v_state = 'OK'
      WHEN p_expect ~ '^[0-9A-Z]{5}$'    THEN v_state = p_expect
      ELSE v_state <> 'OK' AND v_msg ~ p_expect
    END);
END $f$;

-- ============================================================ INV-2 immutability
SELECT pg_temp.t('T01 published cv: update title', NULL,
 $$UPDATE course_versions SET title='x' WHERE id='c1000000-0000-0000-0000-000000000001'$$, 'COURSE_VERSION_IMMUTABLE');
SELECT pg_temp.t('T02 published: update activity', NULL,
 $$UPDATE activities SET title='x' WHERE id='f0000000-0000-0000-0000-000000000001'$$, 'COURSE_VERSION_IMMUTABLE');
SELECT pg_temp.t('T03 published: delete module', NULL,
 $$DELETE FROM modules WHERE id='d0000000-0000-0000-0000-000000000001'$$, 'COURSE_VERSION_IMMUTABLE');
SELECT pg_temp.t('T04 published: INSERT new activity', NULL,
 $$INSERT INTO activities (lesson_id, course_version_id, sort_order, title, activity_type)
   VALUES ('e0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',9,'sneaky','quiz')$$, 'COURSE_VERSION_IMMUTABLE');
SELECT pg_temp.t('T05 published: update completion rule', NULL,
 $$UPDATE completion_rule_sets SET rule_json='{}' WHERE course_version_id='c1000000-0000-0000-0000-000000000001'$$, 'COURSE_VERSION_IMMUTABLE');
SELECT pg_temp.t('T06 published: update coach policy', NULL,
 $$UPDATE coach_policies SET citation_required=false WHERE course_version_id='c1000000-0000-0000-0000-000000000001'$$, 'COURSE_VERSION_IMMUTABLE');
SELECT pg_temp.t('T07 published: update prerequisite', NULL,
 $$UPDATE activity_prerequisites SET prerequisite_expression='{}' WHERE activity_id='f0000000-0000-0000-0000-000000000001'$$, 'COURSE_VERSION_IMMUTABLE');
SELECT pg_temp.t('T08 draft cv: edit activity allowed', NULL,
 $$UPDATE activities SET title='A2 edited' WHERE id='f0000000-0000-0000-0000-000000000002'$$, 'OK');
SELECT pg_temp.t('T09 two published versions same course', NULL,
 $$UPDATE course_versions SET status='published', published_at=now() WHERE id='c1000000-0000-0000-0000-000000000002'$$, '23505');
SELECT pg_temp.t('T10 status transition published->superseded', NULL,
 $$UPDATE course_versions SET status='superseded' WHERE id='c1000000-0000-0000-0000-000000000001'$$, 'OK');
SELECT pg_temp.t('T11 publish v2 after v1 superseded', NULL,
 $$UPDATE course_versions SET status='published', published_at=now() WHERE id='c1000000-0000-0000-0000-000000000002'$$, 'OK');
SELECT pg_temp.t('T12 superseded cv still immutable', NULL,
 $$UPDATE course_versions SET title='y' WHERE id='c1000000-0000-0000-0000-000000000001'$$, 'COURSE_VERSION_IMMUTABLE');

-- ============================================================ INV-6 append-only
SELECT pg_temp.t('T13 learning_results UPDATE', NULL,
 $$UPDATE learning_results SET score=100 WHERE id='a2000000-0000-0000-0000-000000000001'$$, 'APPEND_ONLY_TABLE');
SELECT pg_temp.t('T14 learning_results DELETE', NULL,
 $$DELETE FROM learning_results WHERE id='a2000000-0000-0000-0000-000000000001'$$, 'APPEND_ONLY_TABLE');
SELECT pg_temp.t('T15 audit_logs UPDATE (partitioned)', NULL,
 $$UPDATE audit_logs SET action='x'$$, 'APPEND_ONLY_TABLE');
SELECT pg_temp.t('T16 audit_logs DELETE (partitioned)', NULL,
 $$DELETE FROM audit_logs$$, 'APPEND_ONLY_TABLE');

-- ============================================================ ADR-028 transcript
SELECT pg_temp.t('T17 conversation without visibility', NULL,
 $$INSERT INTO coach_conversations (organization_id, learner_id, course_version_id, trigger_type)
   VALUES ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','learner_question')$$, '23502');
SELECT pg_temp.t('T18 change visibility stamp', NULL,
 $$UPDATE coach_conversations SET transcript_visibility='course_staff' WHERE id='cc000000-0000-0000-0000-000000000001'$$, 'TRANSCRIPT_VISIBILITY_IMMUTABLE');
SELECT pg_temp.t('T19 update message_count allowed', NULL,
 $$UPDATE coach_conversations SET message_count=message_count+1 WHERE id='cc000000-0000-0000-0000-000000000001'$$, 'OK');

-- ============================================================ uniqueness / checks
SELECT pg_temp.t('T20 second valid certificate', NULL,
 $$INSERT INTO certificates (organization_id, enrollment_id, course_version_id, public_id, verification_code, status,
     learner_display_name, course_title, organization_name)
   VALUES ('11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
     '01JTEST0000000000000000002','ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ2','valid','Learner A','Course A','Org Alpha')$$, '23505');
SELECT pg_temp.t('T21 second in_progress attempt', NULL,
 $$INSERT INTO learning_attempts (organization_id, enrollment_id, activity_id, attempt_no, status)
   VALUES ('11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000001',3,'in_progress')$$, '23505');
SELECT pg_temp.t('T22 relearning overwrite history', NULL,
 $$INSERT INTO relearning_assignments (organization_id, enrollment_id, scope_type, reason, assigned_by, preserve_old_result)
   VALUES ('11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','course','x','aaaaaaaa-0000-0000-0000-000000000002',false)$$, '23514');
SELECT pg_temp.t('T23 duplicate active enrollment', NULL,
 $$INSERT INTO enrollments (organization_id, course_id, course_version_id, user_id, enroll_method)
   VALUES ('11111111-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','self')$$, '23505');
SELECT pg_temp.t('T24 platform-scope role with org id', NULL,
 $$INSERT INTO user_org_roles (user_id, role_id, scope_type, organization_id)
   VALUES ('aaaaaaaa-0000-0000-0000-000000000002',(SELECT id FROM roles WHERE code='platform_admin'),'platform','11111111-0000-0000-0000-000000000001')$$, '23514');
SELECT pg_temp.t('T25 system_settings first insert', NULL,
 $$INSERT INTO system_settings (scope_type, key, value) VALUES ('platform','ai.provider','"none"')$$, 'OK');
SELECT pg_temp.t('T26 system_settings duplicate platform key', NULL,
 $$INSERT INTO system_settings (scope_type, key, value) VALUES ('platform','ai.provider','"openai"')$$, '23505');
SELECT pg_temp.t('T27 system_settings ON CONFLICT upsert', NULL,
 $$INSERT INTO system_settings (scope_type, key, value) VALUES ('platform','ai.provider','"internal"')
   ON CONFLICT (scope_type, scope_id, key) DO UPDATE SET value = EXCLUDED.value$$, 'OK');
SELECT pg_temp.t('T28 system_settings platform with scope_id', NULL,
 $$INSERT INTO system_settings (scope_type, scope_id, key, value) VALUES ('platform','11111111-0000-0000-0000-000000000001','k','1')$$, '23514');
SELECT pg_temp.t('T29 result score above max', NULL,
 $$INSERT INTO learning_results (organization_id, attempt_id, enrollment_id, activity_id, status, score, max_score, evaluator)
   VALUES ('11111111-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000001',
           'f0000000-0000-0000-0000-000000000001','passed',150,100,'x')$$, '23514');
SELECT pg_temp.t('T30 revoked certificate without reason', NULL,
 $$UPDATE certificates SET status='revoked', revoked_at=now() WHERE id='ce000000-0000-0000-0000-000000000001'$$, '23514');

-- ============================================================ partitions
SELECT pg_temp.t('T31 learning_event insert', NULL,
 $$INSERT INTO learning_events (event_id, event_type, organization_id, course_id, course_version_id, enrollment_id, learner_id, occurred_at)
   VALUES ('99999999-0000-0000-0000-000000000001','activity.started','11111111-0000-0000-0000-000000000001',
           'c0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
           'b0000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001', now())$$, 'OK');
SELECT pg_temp.t('T32 event routed to monthly partition (not default)', NULL,
 $$DO $d$ BEGIN
     IF (SELECT tableoid::regclass::text FROM learning_events WHERE event_id='99999999-0000-0000-0000-000000000001')
        <> 'learning_events_' || to_char(now(),'YYYY_MM')
     THEN RAISE EXCEPTION 'WRONG_PARTITION'; END IF;
   END $d$ $$, 'OK');
SELECT pg_temp.t('T33 duplicate event_id rejected', NULL,
 $$INSERT INTO learning_events (event_id, event_type, organization_id, course_id, course_version_id, enrollment_id, learner_id, occurred_at)
   SELECT event_id, event_type, organization_id, course_id, course_version_id, enrollment_id, learner_id, occurred_at
     FROM learning_events WHERE event_id='99999999-0000-0000-0000-000000000001'$$, '23505');

-- ============================================================ ADR-026 db roles
SELECT pg_temp.t('T34 app_coach UPDATE learning_results', 'app_coach',
 $$UPDATE learning_results SET score=100$$, '42501');
SELECT pg_temp.t('T35 app_coach INSERT certificates', 'app_coach',
 $$INSERT INTO certificates (organization_id, enrollment_id, course_version_id, public_id, verification_code,
     learner_display_name, course_title, organization_name)
   VALUES ('11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
           'X','XXXXXXXXXXXXXXXXXXXXXXXX','a','b','c')$$, '42501');
SELECT pg_temp.t('T36 app_coach UPDATE enrollments.status', 'app_coach',
 $$UPDATE enrollments SET status='completed', completed_at=now()$$, '42501');
SELECT pg_temp.t('T37 app_coach UPDATE transcript_visibility', 'app_coach',
 $$UPDATE coach_conversations SET transcript_visibility='course_staff'$$, '42501');
SELECT pg_temp.t('T38 app_coach UPDATE message_count', 'app_coach',
 $$UPDATE coach_conversations SET message_count=message_count+1 WHERE id='cc000000-0000-0000-0000-000000000001'$$, 'OK');
SELECT pg_temp.t('T39 app_coach SELECT learning_results', 'app_coach',
 $$SELECT count(*) FROM learning_results$$, 'OK');
SELECT pg_temp.t('T40 app_coach INSERT coach_messages', 'app_coach',
 $$INSERT INTO coach_messages (organization_id, conversation_id, seq_no, role, content)
   VALUES ('11111111-0000-0000-0000-000000000001','cc000000-0000-0000-0000-000000000001',1,'user','hi')$$, 'OK');
SELECT pg_temp.t('T41 app_coach DELETE coach_messages', 'app_coach',
 $$DELETE FROM coach_messages$$, '42501');
SELECT pg_temp.t('T42 app_worker UPDATE learning_results', 'app_worker',
 $$UPDATE learning_results SET score=100$$, '42501');
SELECT pg_temp.t('T43 app_worker UPDATE enrollments', 'app_worker',
 $$UPDATE enrollments SET status='completed', completed_at=now()$$, '42501');
SELECT pg_temp.t('T44 app_worker INSERT certificate (pending)', 'app_worker',
 $$INSERT INTO certificates (organization_id, enrollment_id, course_version_id, public_id, verification_code,
     learner_display_name, course_title, organization_name)
   VALUES ('11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001',
           '01JTEST0000000000000000003','WWWWWWWWWWWWWWWWWWWWWWWW','Learner A','Course A','Org Alpha')$$, 'OK');
SELECT pg_temp.t('T45 app_worker UPDATE transcript_visibility', 'app_worker',
 $$UPDATE coach_conversations SET transcript_visibility='course_staff'$$, '42501');
SELECT pg_temp.t('T46 app_api UPDATE audit_logs', 'app_api',
 $$UPDATE audit_logs SET action='x'$$, '42501');
SELECT pg_temp.t('T47 app_api UPDATE learning_results', 'app_api',
 $$UPDATE learning_results SET score=1$$, '42501');
SELECT pg_temp.t('T48 app_api DELETE learning_results', 'app_api',
 $$DELETE FROM learning_results$$, '42501');
SELECT pg_temp.t('T49 app_readonly INSERT', 'app_readonly',
 $$INSERT INTO organizations (code, name, storage_prefix) VALUES ('z','z','z')$$, '42501');
SELECT pg_temp.t('T50 default privs: app_coach reads new table', 'app_coach',
 $$SELECT count(*) FROM zz_future_table$$, 'OK');
SELECT pg_temp.t('T51 default privs: app_coach cannot write new table', 'app_coach',
 $$INSERT INTO zz_future_table VALUES (1)$$, '42501');

-- ============================================================ seed data
SELECT pg_temp.t('T52 73 permissions seeded', NULL,
 $$DO $d$ BEGIN IF (SELECT count(*) FROM permissions) <> 73 THEN RAISE EXCEPTION 'COUNT %', (SELECT count(*) FROM permissions); END IF; END $d$ $$, 'OK');
SELECT pg_temp.t('T53 6 roles seeded', NULL,
 $$DO $d$ BEGIN IF (SELECT count(*) FROM roles) <> 6 THEN RAISE EXCEPTION 'COUNT'; END IF; END $d$ $$, 'OK');
SELECT pg_temp.t('T54 no duplicate platform.audit.read', NULL,
 $$DO $d$ BEGIN IF EXISTS (SELECT 1 FROM permissions WHERE code='platform.audit.read') THEN RAISE EXCEPTION 'DUP'; END IF; END $d$ $$, 'OK');
SELECT pg_temp.t('T55 read_course only instructor+course_admin', NULL,
 $$DO $d$ BEGIN
     IF (SELECT string_agg(r.code, ',' ORDER BY r.code) FROM role_permissions rp
           JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
          WHERE p.code='coach.conversation.read_course') <> 'course_admin,instructor'
     THEN RAISE EXCEPTION 'WRONG_ROLES'; END IF; END $d$ $$, 'OK');
SELECT pg_temp.t('T56 no read_all permission exists', NULL,
 $$DO $d$ BEGIN IF EXISTS (SELECT 1 FROM permissions WHERE code='coach.conversation.read_all') THEN RAISE EXCEPTION 'EXISTS'; END IF; END $d$ $$, 'OK');
SELECT pg_temp.t('T57 13 interactive defs w/ server_evaluator', NULL,
 $$DO $d$ BEGIN IF (SELECT count(*) FROM interactive_definitions WHERE server_evaluator <> '') <> 13 THEN RAISE EXCEPTION 'COUNT'; END IF; END $d$ $$, 'OK');
SELECT pg_temp.t('T58 4 monthly partitions per table', NULL,
 $$DO $d$ BEGIN
     IF (SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
          WHERE i.inhparent='learning_events'::regclass AND c.relname ~ '_\d{4}_\d{2}$') <> 4
     OR (SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
          WHERE i.inhparent='audit_logs'::regclass AND c.relname ~ '_\d{4}_\d{2}$') <> 4
     THEN RAISE EXCEPTION 'PARTITIONS'; END IF; END $d$ $$, 'OK');
SELECT pg_temp.t('T59 24 migrations recorded', NULL,
 $$DO $d$ BEGIN IF (SELECT count(*) FROM schema_migrations) <> 24 THEN RAISE EXCEPTION 'COUNT'; END IF; END $d$ $$, 'OK');

-- ============================================================ 0015 auth tables
SELECT pg_temp.t('T60 app_coach cannot read password_reset_tokens', 'app_coach',
 $$SELECT count(*) FROM password_reset_tokens$$, '42501');
SELECT pg_temp.t('T61 app_worker cannot read password_reset_tokens', 'app_worker',
 $$SELECT count(*) FROM password_reset_tokens$$, '42501');
SELECT pg_temp.t('T62 app_coach cannot read user_sessions', 'app_coach',
 $$SELECT count(*) FROM user_sessions$$, '42501');
SELECT pg_temp.t('T63 app_readonly cannot read rate_limit_counters', 'app_readonly',
 $$SELECT count(*) FROM rate_limit_counters$$, '42501');
SELECT pg_temp.t('T64 app_api can upsert rate_limit_counters', 'app_api',
 $$INSERT INTO rate_limit_counters (bucket, window_start, hits) VALUES ('t', now(), 1)
   ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1$$, 'OK');
SELECT pg_temp.t('T65 reset token hash must be 64 hex chars', NULL,
 $$INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
   VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'short', now())$$, '23514');

-- ============================================================ 0016 org membership
SELECT pg_temp.t('T66 platform_admin can read org users (SA §5.3 UC-ORG-003)', NULL,
 $$DO $d$ BEGIN IF NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id WHERE r.code = 'platform_admin' AND p.code = 'org.user.read')
   THEN RAISE EXCEPTION 'MISSING'; END IF; END $d$ $$, 'OK');
SELECT pg_temp.t('T67 token purpose restricted to reset/invite', NULL,
 $$INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, purpose)
   VALUES ('aaaaaaaa-0000-0000-0000-000000000001', repeat('a', 64), now(), 'bogus')$$, '23514');

-- ============================================================ 0017 multi-org roles
SELECT pg_temp.t('T68 learner (self scope) in org alpha', NULL,
 $$INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
   VALUES ('aaaaaaaa-0000-0000-0000-000000000003',(SELECT id FROM roles WHERE code='learner'),'self',
           'aaaaaaaa-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001')$$, 'OK');
SELECT pg_temp.t('T69 same learner also in org beta (was 23505 before 0017)', NULL,
 $$INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
   VALUES ('aaaaaaaa-0000-0000-0000-000000000003',(SELECT id FROM roles WHERE code='learner'),'self',
           'aaaaaaaa-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000002')$$, 'OK');
SELECT pg_temp.t('T70 duplicate learner grant in the same org', NULL,
 $$INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
   VALUES ('aaaaaaaa-0000-0000-0000-000000000003',(SELECT id FROM roles WHERE code='learner'),'self',
           'aaaaaaaa-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001')$$, '23505');
SELECT pg_temp.t('T71 duplicate platform grant still rejected (NULLS NOT DISTINCT)', NULL,
 $$INSERT INTO user_org_roles (user_id, role_id, scope_type)
   SELECT 'aaaaaaaa-0000-0000-0000-000000000002'::uuid, id, 'platform'::scope_type FROM roles WHERE code='platform_admin'
   UNION ALL
   SELECT 'aaaaaaaa-0000-0000-0000-000000000002'::uuid, id, 'platform'::scope_type FROM roles WHERE code='platform_admin'$$, '23505');

-- ============================================================ 0018 member disable
SELECT pg_temp.t('T72 one disabled-membership row per (organization, user)', NULL,
 $$INSERT INTO disabled_memberships (organization_id, user_id) VALUES
   ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003'),
   ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003')$$, '23505');
SELECT pg_temp.t('T73 app_api can disable a membership', 'app_api',
 $$INSERT INTO disabled_memberships (organization_id, user_id)
   VALUES ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003')$$, 'OK');
SELECT pg_temp.t('T74 app_coach cannot write memberships', 'app_coach',
 $$INSERT INTO disabled_memberships (organization_id, user_id)
   VALUES ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000003')$$, '42501');

-- ============================================================ 0019 cohorts & member numbers
SELECT pg_temp.t('T75 member number unique within an organization', NULL,
 $$INSERT INTO member_profiles (organization_id, user_id, member_no) VALUES
   ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','S001'),
   ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003','S001')$$, '23505');
SELECT pg_temp.t('T76 same member number allowed in different organizations', NULL,
 $$INSERT INTO member_profiles (organization_id, user_id, member_no) VALUES
   ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003','S001'),
   ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000003','S001')$$, 'OK');
SELECT pg_temp.t('T77 active cohort names unique per organization (case-insensitive)', NULL,
 $$INSERT INTO cohorts (organization_id, name) VALUES
   ('11111111-0000-0000-0000-000000000001','Class A'),
   ('11111111-0000-0000-0000-000000000001','class a')$$, '23505');
SELECT pg_temp.t('T78 an archived cohort may share a name with an active one', NULL,
 $$INSERT INTO cohorts (organization_id, name, status, archived_at) VALUES
   ('11111111-0000-0000-0000-000000000001','Class B','active',NULL),
   ('11111111-0000-0000-0000-000000000001','class b','archived',now())$$, 'OK');
SELECT pg_temp.t('T79 archived status must carry archived_at', NULL,
 $$INSERT INTO cohorts (organization_id, name, status) VALUES ('11111111-0000-0000-0000-000000000001','Class C','archived')$$, '23514');
SELECT pg_temp.t('T80 app_coach cannot write cohorts', 'app_coach',
 $$INSERT INTO cohorts (organization_id, name) VALUES ('11111111-0000-0000-0000-000000000001','Coach')$$, '42501');
SELECT pg_temp.t('T81 enrollments keep the cohort at enrollment time', NULL,
 $$DO $d$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'enrollments' AND column_name = 'cohort_label') THEN RAISE EXCEPTION 'MISSING'; END IF; END $d$ $$, 'OK');

-- ============================================================ 0020 branding
SELECT pg_temp.t('T82 brand assets: only logo and icon', NULL,
 $$INSERT INTO organization_assets (organization_id, kind, content_type, data, sha256, byte_size)
   VALUES ('11111111-0000-0000-0000-000000000001', 'banner', 'image/png', '\x89504e47', repeat('a', 64), 4)$$, '23514');
SELECT pg_temp.t('T83 brand assets: SVG is never stored', NULL,
 $$INSERT INTO organization_assets (organization_id, kind, content_type, data, sha256, byte_size)
   VALUES ('11111111-0000-0000-0000-000000000001', 'logo', 'image/svg+xml', '\x3c737667', repeat('a', 64), 4)$$, '23514');
SELECT pg_temp.t('T84 brand assets: byte_size must match the data', NULL,
 $$INSERT INTO organization_assets (organization_id, kind, content_type, data, sha256, byte_size)
   VALUES ('11111111-0000-0000-0000-000000000001', 'logo', 'image/png', '\x89504e47', repeat('a', 64), 5)$$, '23514');
SELECT pg_temp.t('T85 platform_admin can set organization branding', NULL,
 $$DO $d$ BEGIN IF NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id WHERE r.code = 'platform_admin' AND p.code = 'org.settings.write')
   THEN RAISE EXCEPTION 'MISSING'; END IF; END $d$ $$, 'OK');

-- ============================================================ 0021 organization AI keys (ADR-034)
SELECT pg_temp.t('T86 app_worker cannot read organization AI keys', 'app_worker',
 $$SELECT count(*) FROM organization_ai_credentials$$, '42501');
SELECT pg_temp.t('T87 app_readonly cannot read organization AI keys', 'app_readonly',
 $$SELECT count(*) FROM organization_ai_credentials$$, '42501');
SELECT pg_temp.t('T88 app_coach cannot read organization AI keys', 'app_coach',
 $$SELECT count(*) FROM organization_ai_credentials$$, '42501');
SELECT pg_temp.t('T89 AI key IV must be 12 bytes (AES-GCM)', 'app_api',
 $$INSERT INTO organization_ai_credentials (organization_id, key_alias, ciphertext, iv, auth_tag)
   VALUES ('11111111-0000-0000-0000-000000000001', 'k', '\x01', '\x0102', '\x00000000000000000000000000000000')$$, '23514');

-- ============================================================ 0022 media assets
SELECT pg_temp.t('T90 media: kind must match the MIME type', NULL,
 $$INSERT INTO media_assets (organization_id, course_id, kind, mime_type, title, original_filename, size_bytes, sha256, object_key)
   VALUES ('11111111-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'image', 'video/mp4', 't', 'a.mp4', 1, repeat('a', 64), 'k')$$, '23514');
SELECT pg_temp.t('T91 media: SVG is never stored', NULL,
 $$INSERT INTO media_assets (organization_id, course_id, kind, mime_type, title, original_filename, size_bytes, sha256, object_key)
   VALUES ('11111111-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'image', 'image/svg+xml', 't', 'a.svg', 1, repeat('a', 64), 'k')$$, '23514');
-- ============================================================ 0023 enrollment codes
SELECT pg_temp.t('T93 enrollment code unique within an organization', NULL,
 $$INSERT INTO courses (organization_id, code, title, enrollment_policy) VALUES
   ('11111111-0000-0000-0000-000000000001', 'EC-1', 'A', '{"joinBy":"code","code":"ABCD2345"}'),
   ('11111111-0000-0000-0000-000000000001', 'EC-2', 'B', '{"joinBy":"code","code":"ABCD2345"}')$$, '23505');
SELECT pg_temp.t('T94 enrollment code format is fixed (no look-alikes)', NULL,
 $$INSERT INTO courses (organization_id, code, title, enrollment_policy)
   VALUES ('11111111-0000-0000-0000-000000000001', 'EC-3', 'C', '{"joinBy":"code","code":"ABCD1O23"}')$$, '23514');
-- ============================================================ 0024 notifications
SELECT pg_temp.t('T95 app_coach cannot write notifications', 'app_coach',
 $$INSERT INTO notifications (user_id, type) SELECT id, 'enrollment.assigned' FROM users LIMIT 1$$, '42501');
SELECT pg_temp.t('T92 app_coach cannot write media', 'app_coach',
 $$INSERT INTO media_assets (organization_id, course_id, kind, mime_type, title, original_filename, size_bytes, sha256, object_key)
   VALUES ('11111111-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'image', 'image/png', 't', 'a.png', 1, repeat('a', 64), 'k')$$, '42501');

-- ------------------------------------------------------------------ report
\pset border 1
\pset footer off
SELECT n AS "#", CASE WHEN ok THEN 'PASS' ELSE '**FAIL**' END AS result, name, expect, got FROM r ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed, count(*) AS total FROM r;

DROP TABLE zz_future_table;

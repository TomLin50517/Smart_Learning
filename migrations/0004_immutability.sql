-- =============================================================================
-- 0004_immutability.sql
-- Published CourseVersion 的 DB 層不可變保護
-- 依據：SD v1.1 §2.3.1、SA v1.1 INV-2、AC-CRS-001、THR-T-001
-- 相依：0003
-- =============================================================================
-- 這是應用層 Guard 之外的第二道防線。即使有人繞過 application service
-- 直接下 SQL，已發布版本的內容仍無法被竄改。
--
-- 子表觸發器涵蓋 INSERT：「不改既有內容、只新增一個活動」同樣違反 INV-2。
-- 合法流程不受影響——clone 是先建 draft 再插入子項；publish 是子項齊全
-- 後才轉換狀態。（此缺口由不變條件測試 T04 發現。）
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- course_versions 本身
-- 只阻擋「內容欄位」變更；狀態轉移（publish / archive）仍需允許，
-- 其合法性由應用層狀態機把關（SA §7.1）。
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_course_version_content_write() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('published','superseded','archived') THEN
    IF (NEW.title, NEW.summary, NEW.navigation_mode,
        NEW.content_snapshot_hash, NEW.course_id, NEW.version_no)
       IS DISTINCT FROM
       (OLD.title, OLD.summary, OLD.navigation_mode,
        OLD.content_snapshot_hash, OLD.course_id, OLD.version_no)
    THEN
      RAISE EXCEPTION 'COURSE_VERSION_IMMUTABLE' USING
        ERRCODE = 'P0001',
        DETAIL  = format('course_version %s 狀態為 %s，內容欄位不可變更', OLD.id, OLD.status),
        HINT    = '請改用 clone 建立新的 draft 版本';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cv_immutable
  BEFORE UPDATE ON course_versions
  FOR EACH ROW EXECUTE FUNCTION reject_course_version_content_write();

-- --------------------------------------------------------------------------
-- 帶 course_version_id 的子表
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_published_version_write() RETURNS trigger AS $$
DECLARE
  v_cv_id  uuid;
  v_status course_version_status;
BEGIN
  v_cv_id := COALESCE(NEW.course_version_id, OLD.course_version_id);

  SELECT status INTO v_status FROM course_versions WHERE id = v_cv_id;

  IF v_status IN ('published','superseded','archived') THEN
    RAISE EXCEPTION 'COURSE_VERSION_IMMUTABLE' USING
      ERRCODE = 'P0001',
      DETAIL  = format('%s 屬於狀態為 %s 的 course_version %s', TG_TABLE_NAME, v_status, v_cv_id),
      HINT    = '請改用 clone 建立新的 draft 版本';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_modules_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON modules
  FOR EACH ROW EXECUTE FUNCTION reject_published_version_write();

CREATE TRIGGER trg_lessons_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON lessons
  FOR EACH ROW EXECUTE FUNCTION reject_published_version_write();

CREATE TRIGGER trg_activities_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON activities
  FOR EACH ROW EXECUTE FUNCTION reject_published_version_write();

CREATE TRIGGER trg_crs_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON completion_rule_sets
  FOR EACH ROW EXECUTE FUNCTION reject_published_version_write();

CREATE TRIGGER trg_cp_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON coach_policies
  FOR EACH ROW EXECUTE FUNCTION reject_published_version_write();

-- --------------------------------------------------------------------------
-- 不帶 course_version_id 的子表：經 activity 反查
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_published_activity_write() RETURNS trigger AS $$
DECLARE
  v_status course_version_status;
BEGIN
  SELECT cv.status INTO v_status
    FROM activities a
    JOIN course_versions cv ON cv.id = a.course_version_id
   WHERE a.id = COALESCE(NEW.activity_id, OLD.activity_id);

  IF v_status IN ('published','superseded','archived') THEN
    RAISE EXCEPTION 'COURSE_VERSION_IMMUTABLE' USING
      ERRCODE = 'P0001',
      DETAIL  = format('%s 所屬 activity 的 course_version 狀態為 %s', TG_TABLE_NAME, v_status);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_actpre_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON activity_prerequisites
  FOR EACH ROW EXECUTE FUNCTION reject_published_activity_write();

-- knowledge_bindings 的觸發器於 0007 建立（該表尚未存在）

INSERT INTO schema_migrations (version) VALUES ('0004_immutability')
  ON CONFLICT DO NOTHING;

COMMIT;

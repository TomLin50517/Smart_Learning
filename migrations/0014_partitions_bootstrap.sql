-- =============================================================================
-- 0014_partitions_bootstrap.sql
-- learning_events / audit_logs 的月分區與維護函式
-- 依據：SD v1.1 §2.10、ADR-022
-- 相依：0005, 0009
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 建立單一月份分區（冪等）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_month_partition(
  p_parent text,
  p_month  date
) RETURNS text AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('%s_%s', p_parent, to_char(v_start, 'YYYY_MM'));
BEGIN
  IF to_regclass(format('public.%I', v_name)) IS NOT NULL THEN
    RETURN v_name;   -- 已存在
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    v_name, p_parent, v_start, v_end
  );

  RETURN v_name;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION ensure_month_partition(text, date) IS
  '由 partition.maintenance job 每月呼叫，預先建立未來分區（SD §11.5）。';

-- --------------------------------------------------------------------------
-- 一次建立當月 + 未來 3 個月
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_future_partitions(p_months integer DEFAULT 3)
RETURNS void AS $$
DECLARE i integer;
BEGIN
  FOR i IN 0..p_months LOOP
    PERFORM ensure_month_partition('learning_events',
              (date_trunc('month', now()) + (i || ' month')::interval)::date);
    PERFORM ensure_month_partition('audit_logs',
              (date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Bootstrap：當月與後續 3 個月
SELECT ensure_future_partitions(3);

-- --------------------------------------------------------------------------
-- Retention：DETACH 舊分區（不直接 DROP，讓維運先歸檔）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION detach_old_partition(
  p_parent text,
  p_before date
) RETURNS text AS $$
DECLARE
  v_name text := format('%s_%s', p_parent, to_char(date_trunc('month', p_before), 'YYYY_MM'));
BEGIN
  IF to_regclass(format('public.%I', v_name)) IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', p_parent, v_name);
  RETURN v_name;   -- 呼叫端負責歸檔後再 DROP
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION detach_old_partition(text, date) IS
  '刻意只 DETACH 不 DROP：資料刪除必須是明確的人為決定，不由排程自動完成。';

INSERT INTO schema_migrations (version) VALUES ('0014_partitions_bootstrap')
  ON CONFLICT DO NOTHING;

COMMIT;

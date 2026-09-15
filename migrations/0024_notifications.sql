-- =============================================================================
-- 0024_notifications.sql
-- 站內通知清單：本人、依時間新到舊（SD §6.26）。notifications／notification_preferences 於 0009 建立。
-- =============================================================================

CREATE INDEX idx_ntf_user_list ON notifications (user_id, created_at DESC, id DESC) WHERE channel = 'in_app';

INSERT INTO schema_migrations (version) VALUES ('0024_notifications') ON CONFLICT DO NOTHING;

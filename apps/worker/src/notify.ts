import { NOTIFICATION_EMAIL_JOB, notificationJobKey, type NotificationPayload, type NotificationType } from '@iac/contracts';
import type pg from 'pg';

/**
 * 事件通知（SD §6.26）——與 API 的 NotificationService.notifyTx 相同規則（worker 不可 import API 模組）：
 * 依收件者偏好（沒有設定＝站內、Email 皆開啟）寫入站內通知與 Email 通知，Email 在同一交易排入 notification.email。
 */
export async function notifyTx(
  c: pg.PoolClient,
  n: { userIds: readonly string[]; organizationId: string | null; type: NotificationType; payload: NotificationPayload; correlationId?: string | null },
): Promise<void> {
  const ids = [...new Set(n.userIds)];
  if (!ids.length) return;
  const prefs = await c.query<{ id: string; in_app: boolean; email: boolean }>(
    `SELECT u.id, COALESCE(p.in_app, true) AS in_app, COALESCE(p.email, true) AS email
       FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id AND p.type = $2
      WHERE u.id = ANY($1::uuid[])`,
    [ids, n.type],
  );
  const payload = JSON.stringify(n.payload);
  for (const u of prefs.rows) {
    if (u.in_app) {
      await c.query(`INSERT INTO notifications (organization_id, user_id, type, channel, payload) VALUES ($1, $2, $3, 'in_app', $4::jsonb)`, [n.organizationId, u.id, n.type, payload]);
    }
    if (u.email) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO notifications (organization_id, user_id, type, channel, payload) VALUES ($1, $2, $3, 'email', $4::jsonb) RETURNING id`,
        [n.organizationId, u.id, n.type, payload],
      );
      const id = r.rows[0]!.id;
      await c.query(
        `INSERT INTO job_queue (job_type, queue, priority, max_attempts, payload, idempotency_key, organization_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [
          NOTIFICATION_EMAIL_JOB.type,
          NOTIFICATION_EMAIL_JOB.queue,
          NOTIFICATION_EMAIL_JOB.priority,
          NOTIFICATION_EMAIL_JOB.maxAttempts,
          JSON.stringify({ notificationId: id }),
          notificationJobKey(id),
          n.organizationId,
          n.correlationId ?? null,
        ],
      );
    }
  }
}

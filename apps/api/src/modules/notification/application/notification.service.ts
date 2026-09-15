import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_EMAIL_JOB,
  NOTIFICATION_TYPES,
  notificationJobKey,
  type NotificationDto,
  type NotificationPayload,
  type NotificationPreferenceDto,
  type NotificationType,
} from '@iac/contracts';
import pg from 'pg';
import { z } from 'zod';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { enqueueJobTx } from '../../../common/job-queue.js';
import type { Notifier, NotifyInput } from '../notification.contracts.js';

/** 分頁游標：created_at 以 PostgreSQL 的文字格式保存（保留微秒，避免同一毫秒內的通知被跳過） */
const Cursor = z.tuple([z.string().min(1).max(64), z.guid()]);

/**
 * 通知（SA UC-AUD-003／004、SD §6.26）。
 * 寫入：notifyTx 由各模組在自己的交易內呼叫；偏好預設站內、Email 皆開啟（notification_preferences 沒有列即預設）。
 * 站內與 Email 各一列（channel）；Email 列排入 notification.email job（idempotency key mail:{id}），由 worker 寄出並寫 sent_at。
 * 讀取：只有本人的站內通知。
 */
@Injectable()
export class NotificationService implements Notifier {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  async notifyTx(c: pg.PoolClient, n: NotifyInput): Promise<void> {
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
        await c.query(`INSERT INTO notifications (organization_id, user_id, type, channel, payload) VALUES ($1, $2, $3, 'in_app', $4::jsonb)`, [
          n.organizationId,
          u.id,
          n.type,
          payload,
        ]);
      }
      if (u.email) {
        const r = await c.query<{ id: string }>(
          `INSERT INTO notifications (organization_id, user_id, type, channel, payload) VALUES ($1, $2, $3, 'email', $4::jsonb) RETURNING id`,
          [n.organizationId, u.id, n.type, payload],
        );
        const id = r.rows[0]!.id;
        await enqueueJobTx(c, {
          jobType: NOTIFICATION_EMAIL_JOB.type,
          queue: NOTIFICATION_EMAIL_JOB.queue,
          priority: NOTIFICATION_EMAIL_JOB.priority,
          maxAttempts: NOTIFICATION_EMAIL_JOB.maxAttempts,
          payload: { notificationId: id },
          idempotencyKey: notificationJobKey(id),
          organizationId: n.organizationId,
        });
      }
    }
  }

  async list(userId: string, q: { unread: boolean; limit: number; cursor?: string | undefined }): Promise<{ data: NotificationDto[]; nextCursor: string | null; unread: number }> {
    let after: [string, string] | null = null;
    if (q.cursor) {
      try {
        after = Cursor.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
      } catch {
        throw new DomainError('VALIDATION_FAILED', 'cursor: invalid', [{ field: 'cursor', issue: 'invalid' }]);
      }
    }
    const r = await this.db.query<{ id: string; type: NotificationType; organization_id: string | null; payload: NotificationPayload; created_at: Date; created_text: string; read_at: Date | null }>(
      `SELECT id, type, organization_id, payload, created_at, created_at::text AS created_text, read_at
         FROM notifications
        WHERE user_id = $1 AND channel = 'in_app' AND ($2::boolean = false OR read_at IS NULL)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [userId, q.unread, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1],
    );
    const rows = r.rows.slice(0, q.limit);
    const last = rows[rows.length - 1];
    const unread = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [userId]);
    return {
      data: rows.map((x) => ({
        id: x.id,
        type: x.type,
        organizationId: x.organization_id,
        payload: x.payload,
        createdAt: x.created_at.toISOString(),
        readAt: x.read_at?.toISOString() ?? null,
      })),
      nextCursor: r.rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.created_text, last.id])).toString('base64url') : null,
      unread: unread.rows[0]!.n,
    };
  }

  /** 標為已讀；別人的通知一律 404（不透露存在） */
  async markRead(userId: string, id: string): Promise<void> {
    const r = await this.db.query(`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 AND channel = 'in_app'`, [id, userId]);
    if (!r.rowCount) throw new DomainError('NOT_FOUND');
  }

  async markAllRead(userId: string): Promise<number> {
    const r = await this.db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [userId]);
    return r.rowCount ?? 0;
  }

  /** 每種通知的偏好；沒有設定過的預設站內、Email 皆開啟 */
  async preferences(userId: string): Promise<NotificationPreferenceDto[]> {
    const r = await this.db.query<{ type: string; in_app: boolean; email: boolean }>(`SELECT type, in_app, email FROM notification_preferences WHERE user_id = $1`, [userId]);
    const set = new Map(r.rows.map((x) => [x.type, x]));
    return NOTIFICATION_TYPES.map((type) => ({ type, inApp: set.get(type)?.in_app ?? true, email: set.get(type)?.email ?? true }));
  }

  async setPreferences(userId: string, prefs: readonly NotificationPreferenceDto[]): Promise<NotificationPreferenceDto[]> {
    for (const p of prefs) {
      await this.db.query(
        `INSERT INTO notification_preferences (user_id, type, in_app, email) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, type) DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email`,
        [userId, p.type, p.inApp, p.email],
      );
    }
    return this.preferences(userId);
  }
}

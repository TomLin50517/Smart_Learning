import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { NOTIFICATION_TYPES, type NotificationDto, type NotificationPreferenceDto } from '@iac/contracts';
import { z } from 'zod';
import type { AuthUser } from '../../../common/context.js';
import { AuthOnly, CurrentUser } from '../../../common/decorators.js';
import { parseInput } from '../../../common/validation.js';
import { NotificationService } from '../application/notification.service.js';

const ListQuery = z.object({
  unread: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});
const Preferences = z.strictObject({
  preferences: z
    .array(z.strictObject({ type: z.enum(NOTIFICATION_TYPES), inApp: z.boolean(), email: z.boolean() }))
    .min(1)
    .max(NOTIFICATION_TYPES.length),
});

/**
 * 本人的站內通知與通知偏好（SA UC-AUD-003／004、SD §6.26）。
 * @AuthOnly：每個查詢都限定 user_id = 本人，任何登入者都可以使用。不用 notification.*_self——ADR-016 讓組織層級的授權
 * 不涵蓋 self，而加入申請的收件者（組織管理員）通常沒有 self 授權，會看不到發給自己的通知。
 */
@Controller('api')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** openapi: listNotifications */
  @Get('notifications')
  @AuthOnly()
  async list(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<{ data: NotificationDto[]; meta: { next_cursor: string | null; unread: number } }> {
    const r = await this.notifications.list(user.id, parseInput(ListQuery, query));
    return { data: r.data, meta: { next_cursor: r.nextCursor, unread: r.unread } };
  }

  /** openapi: markAllNotificationsRead */
  @Post('notifications/read-all')
  @AuthOnly()
  @HttpCode(200)
  async readAll(@CurrentUser() user: AuthUser): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(user.id) };
  }

  /** openapi: markNotificationRead */
  @Post('notifications/:id/read')
  @AuthOnly()
  @HttpCode(204)
  async read(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.notifications.markRead(user.id, parseInput(z.guid(), id));
  }

  /** openapi: getNotificationPreferences */
  @Get('me/notification-preferences')
  @AuthOnly()
  preferences(@CurrentUser() user: AuthUser): Promise<NotificationPreferenceDto[]> {
    return this.notifications.preferences(user.id);
  }

  /** openapi: setNotificationPreferences */
  @Put('me/notification-preferences')
  @AuthOnly()
  async setPreferences(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<NotificationPreferenceDto[]> {
    return this.notifications.setPreferences(user.id, parseInput(Preferences, body).preferences);
  }
}

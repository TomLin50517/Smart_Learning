import type { NotificationDto, NotificationType } from '@iac/contracts';

/** 通知設定頁的類型名稱（SD §6.26） */
export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  'enrollment.assigned': '被加入課程',
  'enrollment.approved': '加入申請通過',
  'enrollment.rejected': '加入申請未通過',
  'enrollment.requested': '有學員申請加入（審核者）',
  'enrollment.reopened': '課程重新開啟',
  'relearning.assigned': '老師指派重修',
  'certificate.issued': '完成課程、取得證書',
};

const SCOPE: Record<string, string> = { module: '單元', lesson: '課節', activity: '活動' };

/** 站內通知的一行文字 */
export function notificationText(n: Pick<NotificationDto, 'type' | 'payload'>): string {
  const p = n.payload;
  const course = `「${p.courseTitle || '課程'}」`;
  switch (n.type) {
    case 'enrollment.assigned':
      return `你已加入課程${course}`;
    case 'enrollment.approved':
      return `你加入${course}的申請已通過，可以開始學習`;
    case 'enrollment.rejected':
      return `你加入${course}的申請未通過`;
    case 'enrollment.requested':
      return `${p.learnerName || '一位學員'} 申請加入${course}，等待審核`;
    case 'enrollment.reopened':
      return `${course}已重新開啟，可以繼續練習`;
    case 'relearning.assigned': {
      const scope = p.scopeType && p.scopeType !== 'course' ? `${SCOPE[p.scopeType] ?? ''}「${p.scopeTitle ?? ''}」` : '整門課';
      return `老師指派了${course}的重修（${scope}）${p.reason ? `：${p.reason}` : ''}`;
    }
    case 'certificate.issued':
      return `🎉 恭喜完成${course}，已取得結業證書`;
    default:
      return String((n as { type: string }).type);
  }
}

import { NOTIFICATION_TYPES, notificationLink } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPE_LABELS, notificationText } from './notify-lib';

describe('notificationText', () => {
  it('describes every notification type', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_TYPE_LABELS[type]).toBeTruthy();
      expect(notificationText({ type, payload: { courseTitle: '資料結構' } })).toContain('資料結構');
    }
  });

  it('shows the relearning scope and reason, and who asked to join', () => {
    expect(notificationText({ type: 'relearning.assigned', payload: { courseTitle: 'A', scopeType: 'lesson', scopeTitle: '第二課', reason: '再練習' } })).toBe(
      '老師指派了「A」的重修（課節「第二課」）：再練習',
    );
    expect(notificationText({ type: 'enrollment.requested', payload: { courseTitle: 'A', learnerName: '王小明' } })).toBe('王小明 申請加入「A」，等待審核');
  });

  it('links to the page where the reader acts on it', () => {
    expect(notificationLink('enrollment.assigned', { enrollmentId: 'e1' })).toBe('/app/learn/e1');
    expect(notificationLink('enrollment.requested', { courseId: 'c1' })).toBe('/app/courses/c1');
    expect(notificationLink('enrollment.rejected', { enrollmentId: 'e1' })).toBe('/app/learn');
    expect(notificationLink('certificate.issued', { certificateId: 'x/y' })).toBe('/app/certificates/x%2Fy');
  });
});

import type { MeResponse, PermissionCode } from '@iac/contracts';

/**
 * 前端的權限判斷只決定「顯示什麼」，不是安全邊界——每個 API 仍由伺服器的 guard 鏈把關（INV-8、SD §7.1.2）。
 * /api/me 的 permissions 為扁平集合（不含 scope），因此這裡只做 UX 層級的顯示判斷。
 */
export function can(me: Pick<MeResponse, 'permissions'> | null | undefined, permission: PermissionCode): boolean {
  return !!me && me.permissions.includes(permission);
}

export const HOME = '/app';

export interface NavItem {
  to: string;
  label: string;
  /** NavLink 的 end：只在路徑完全相符時標示為目前頁面 */
  end?: boolean;
}

/** 側邊導航（SD §7.1 路由表） */
export function navItems(me: MeResponse): NavItem[] {
  const items: NavItem[] = [{ to: HOME, label: '首頁', end: true }];
  if (can(me, 'learning.result.read_self')) items.push({ to: '/app/learn', label: '我的課程' });
  if (can(me, 'certificate.read_self')) items.push({ to: '/app/certificates', label: '我的證書' });
  if (me.activeOrganization && can(me, 'org.user.read')) {
    items.push({ to: '/app/org/users', label: '成員管理' });
  }
  if (can(me, 'course.read')) items.push({ to: '/app/courses', label: '課程管理' });
  if (can(me, 'platform.organization.create') || can(me, 'platform.organization.disable')) {
    items.push({ to: '/app/platform/organizations', label: '組織管理' });
  }
  if (can(me, 'platform.license.read')) items.push({ to: '/app/platform/license', label: '系統授權' });
  if (can(me, 'platform.settings.read')) items.push({ to: '/app/platform/system', label: '平台設定' });
  if (can(me, 'platform.health.read')) items.push({ to: '/app/platform/jobs', label: '背景工作' });
  // 稽核：管理範圍者看「稽核紀錄」，只有 audit.read_self 者看「帳號活動」（同一頁，SD §12.4）
  if (can(me, 'audit.read_platform') || can(me, 'audit.read_org') || can(me, 'audit.read_course')) {
    items.push({ to: '/app/audit', label: '稽核紀錄' });
  } else if (can(me, 'audit.read_self')) {
    items.push({ to: '/app/audit', label: '帳號活動' });
  }
  return items;
}

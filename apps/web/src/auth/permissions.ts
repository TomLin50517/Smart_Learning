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
  /** 一句話說明用途；只有首頁的入口卡片會顯示，側邊導航忽略它 */
  hint?: string;
}

/** 側邊導航（SD §7.1 路由表） */
export function navItems(me: MeResponse): NavItem[] {
  const items: NavItem[] = [{ to: HOME, label: '首頁', end: true }];
  if (can(me, 'learning.result.read_self')) items.push({ to: '/app/learn', label: '我的課程', hint: '繼續進行中的課程與練習' });
  if (can(me, 'certificate.read_self')) items.push({ to: '/app/certificates', label: '我的證書', hint: '檢視與下載已取得的結業證書' });
  if (me.activeOrganization && can(me, 'org.user.read')) {
    items.push({ to: '/app/org/users', label: '成員管理', hint: '邀請成員、指派角色、匯入名單' });
    items.push({ to: '/app/org/cohorts', label: '班級管理', hint: '建立班級，整班加入課程' });
  }
  if (me.activeOrganization && can(me, 'org.settings.write')) items.push({ to: '/app/org/branding', label: '品牌設定', hint: '組織的登入網址、Logo 與配色' });
  if (me.activeOrganization && can(me, 'cms.write')) items.push({ to: '/app/org/homepage', label: '首頁內容', hint: '編輯組織公開首頁要顯示的內容' });
  if (me.activeOrganization && can(me, 'knowledge.shared.write')) items.push({ to: '/app/org/knowledge', label: '共用教材', hint: '組織層級的教材，所有課程都能引用' });
  if (me.activeOrganization && can(me, 'coach.transcript_policy.write')) items.push({ to: '/app/org/coach', label: 'AI 教練設定', hint: '逐字稿政策與教練的開關' });
  // learner 也有 course.read（只涵蓋自己選的課），但課程清單要的是組織層級的授權——
  // /api/me 的 permissions 不含 scope，無法直接分辨，改以 learner 沒有的 course.version.read 判斷，
  // 否則學員會看到一個點進去必定 403 的入口
  if (can(me, 'course.read') && can(me, 'course.version.read')) {
    items.push({ to: '/app/courses', label: '課程管理', hint: '建立課程、編輯版本與發布' });
  }
  if (can(me, 'platform.organization.create') || can(me, 'platform.organization.disable')) {
    items.push({ to: '/app/platform/organizations', label: '組織管理', hint: '建立組織、指派管理員、停用' });
  }
  if (can(me, 'platform.license.read')) items.push({ to: '/app/platform/license', label: '系統授權', hint: '授權狀態、人數上限與維護期限' });
  if (can(me, 'platform.settings.read')) items.push({ to: '/app/platform/system', label: '平台設定', hint: '上傳上限等全平台參數' });
  // permissions 是扁平集合（不含 scope），組織管理員同樣持有 cms.write——
  // 以平台層級的權限一併判斷，避免把平台首頁的入口顯示給組織管理員
  if (can(me, 'platform.settings.read') && can(me, 'cms.write')) items.push({ to: '/app/platform/homepage', label: '平台首頁', hint: '編輯平台公開首頁要顯示的內容' });
  if (can(me, 'platform.health.read')) items.push({ to: '/app/platform/system-status', label: '系統狀態', hint: '資源用量、備份與需要處理的問題' });
  if (can(me, 'platform.health.read')) items.push({ to: '/app/platform/jobs', label: '背景工作', hint: '佇列中與已放棄的工作' });
  // 稽核：管理範圍者看「稽核紀錄」，只有 audit.read_self 者看「帳號活動」（同一頁，SD §12.4）
  if (can(me, 'audit.read_platform') || can(me, 'audit.read_org') || can(me, 'audit.read_course')) {
    items.push({ to: '/app/audit', label: '稽核紀錄', hint: '查詢與匯出操作紀錄' });
  } else if (can(me, 'audit.read_self')) {
    items.push({ to: '/app/audit', label: '帳號活動', hint: '你自己的登入與操作紀錄' });
  }
  return items;
}

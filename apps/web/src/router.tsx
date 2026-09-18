import { createBrowserRouter, Navigate } from 'react-router';
import { RequireAuth } from './components/AppShell';
import { ForgotPasswordPage, LoginPage, OrgLoginPage, SetPasswordPage } from './pages/auth-pages';
import { NotFoundPage, RouteError } from './pages/errors-pages';
import { PublicHomePage } from './pages/PublicHomePage';

/**
 * 路由（SD §7.1；react-router 8 data router）。
 * - 需登入的頁面一律在 /app 之下；/ 是公開首頁（SD §6.32）
 * - /password-reset 與 /set-password 的路徑與 API 寄出的連結一致（AuthService.link）
 *
 * **只有公開頁（首頁、登入、錯誤頁）靜態載入**，其餘一律用 route.lazy 動態載入。
 * 訪客為了看一頁首頁不該下載整個後台；react-router 會在導航時才去抓對應的 chunk，
 * 而且會在比對到路由之後、渲染之前等它載完，所以不需要額外的 Suspense fallback。
 */
export const router = createBrowserRouter([
  { path: '/', element: <PublicHomePage />, errorElement: <RouteError /> },
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  // 組織登入網址：組織的 Logo、名稱與配色（SD §6.16）
  { path: '/o/:code', element: <OrgLoginPage />, errorElement: <RouteError /> },
  { path: '/forgot-password', element: <ForgotPasswordPage />, errorElement: <RouteError /> },
  { path: '/password-reset', element: <SetPasswordPage mode="reset" />, errorElement: <RouteError /> },
  { path: '/set-password', element: <SetPasswordPage mode="invite" />, errorElement: <RouteError /> },
  // 公開證書查驗（不需登入；UC-CRT-005）
  { path: '/verify/:code', lazy: async () => ({ Component: (await import('./pages/VerifyPage')).VerifyPage }), errorElement: <RouteError /> },
  {
    path: '/app',
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { index: true, lazy: async () => ({ Component: (await import('./pages/HomePage')).HomePage }) },
      { path: 'profile', lazy: async () => ({ Component: (await import('./pages/ProfilePage')).ProfilePage }) },
      { path: 'notifications', lazy: async () => ({ Component: (await import('./pages/NotificationsPage')).NotificationsPage }) },
      // 學員（SD §6.8）
      { path: 'learn', lazy: async () => ({ Component: (await import('./pages/MyCoursesPage')).MyCoursesPage }) },
      { path: 'learn/:enrollmentId', lazy: async () => ({ Component: (await import('./pages/LearnPage')).LearnPage }) },
      { path: 'learn/:enrollmentId/timeline', lazy: async () => ({ Component: (await import('./pages/MyTimelinePage')).MyTimelinePage }) },
      { path: 'certificates', lazy: async () => ({ Component: (await import('./pages/CertificatesPage')).MyCertificatesPage }) },
      { path: 'certificates/:certificateId', lazy: async () => ({ Component: (await import('./pages/CertificatesPage')).MyCertificatePage }) },
      // 課程（SD §7.1）
      { path: 'courses', lazy: async () => ({ Component: (await import('./pages/CoursesPage')).CoursesPage }) },
      { path: 'courses/:courseId', lazy: async () => ({ Component: (await import('./pages/CoursePage')).CoursePage }) },
      { path: 'courses/:courseId/learners/:enrollmentId', lazy: async () => ({ Component: (await import('./pages/LearnerDetailPage')).LearnerDetailPage }) },
      { path: 'courses/:courseId/versions/:versionId/edit', lazy: async () => ({ Component: (await import('./pages/VersionEditorPage')).VersionEditorPage }) },
      // Org Admin：目前組織的成員與角色（SD 的 /app/org/roles 併入此頁）
      { path: 'org/users', lazy: async () => ({ Component: (await import('./pages/OrgMembersPage')).OrgMembersPage }) },
      { path: 'org/cohorts', lazy: async () => ({ Component: (await import('./pages/CohortsPage')).CohortsPage }) },
      { path: 'org/branding', lazy: async () => ({ Component: (await import('./pages/BrandingPage')).BrandingPage }) },
      { path: 'org/homepage', lazy: async () => { const { HomepageEditorPage } = await import('./pages/HomepageEditorPage'); return { Component: () => <HomepageEditorPage scope="organization" /> }; } },
      { path: 'org/knowledge', lazy: async () => ({ Component: (await import('./pages/OrgKnowledgePage')).OrgKnowledgePage }) },
      { path: 'org/coach', lazy: async () => ({ Component: (await import('./pages/CoachSettingsPage')).CoachSettingsPage }) },
      // Platform Admin
      { path: 'platform/organizations', lazy: async () => ({ Component: (await import('./pages/OrganizationsPage')).OrganizationsPage }) },
      { path: 'platform/organizations/:orgId/users', lazy: async () => ({ Component: (await import('./pages/OrgMembersPage')).OrgMembersPage }) },
      { path: 'platform/organizations/:orgId/branding', lazy: async () => ({ Component: (await import('./pages/BrandingPage')).BrandingPage }) },
      { path: 'platform/organizations/:orgId/ai-key', lazy: async () => ({ Component: (await import('./pages/OrgAiKeyPage')).OrgAiKeyPage }) },
      { path: 'platform/license', lazy: async () => ({ Component: (await import('./pages/LicensePage')).LicensePage }) },
      { path: 'platform/system', lazy: async () => ({ Component: (await import('./pages/SettingsPage')).SettingsPage }) },
      { path: 'platform/jobs', lazy: async () => ({ Component: (await import('./pages/JobsPage')).JobsPage }) },
      { path: 'platform/system-status', lazy: async () => ({ Component: (await import('./pages/SystemStatusPage')).SystemStatusPage }) },
      { path: 'platform/homepage', lazy: async () => { const { HomepageEditorPage } = await import('./pages/HomepageEditorPage'); return { Component: () => <HomepageEditorPage scope="platform" /> }; } },
      // 稽核紀錄／帳號活動（所有 audit.read_* 共用，SD §12.4）
      { path: 'audit', lazy: async () => ({ Component: (await import('./pages/AuditPage')).AuditPage }) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/app" replace /> },
]);

import { createBrowserRouter, Navigate } from 'react-router';
import { RequireAuth } from './components/AppShell';
import { AuditPage } from './pages/AuditPage';
import { CoursePage } from './pages/CoursePage';
import { CoursesPage } from './pages/CoursesPage';
import { VersionEditorPage } from './pages/VersionEditorPage';
import { ForgotPasswordPage, LoginPage, OrgLoginPage, SetPasswordPage } from './pages/auth-pages';
import { BrandingPage } from './pages/BrandingPage';
import { NotFoundPage, RouteError } from './pages/errors-pages';
import { HomepageEditorPage } from './pages/HomepageEditorPage';
import { HomePage } from './pages/HomePage';
import { PublicHomePage } from './pages/PublicHomePage';
import { JobsPage } from './pages/JobsPage';
import { SettingsPage } from './pages/SettingsPage';
import { LicensePage } from './pages/LicensePage';
import { MyCertificatePage, MyCertificatesPage } from './pages/CertificatesPage';
import { CoachSettingsPage } from './pages/CoachSettingsPage';
import { CohortsPage } from './pages/CohortsPage';
import { LearnerDetailPage } from './pages/LearnerDetailPage';
import { VerifyPage } from './pages/VerifyPage';
import { LearnPage } from './pages/LearnPage';
import { MyCoursesPage } from './pages/MyCoursesPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrgKnowledgePage } from './pages/OrgKnowledgePage';
import { SystemStatusPage } from './pages/SystemStatusPage';
import { MyTimelinePage } from './pages/MyTimelinePage';
import { OrganizationsPage } from './pages/OrganizationsPage';
import { OrgAiKeyPage } from './pages/OrgAiKeyPage';
import { OrgMembersPage } from './pages/OrgMembersPage';
import { ProfilePage } from './pages/ProfilePage';

/**
 * 路由（SD §7.1；react-router 8 data router）。
 * - 需登入的頁面一律在 /app 之下；/ 保留給公開 CMS 首頁（尚未實作，暫時導向 /app）
 * - /password-reset 與 /set-password 的路徑與 API 寄出的連結一致（AuthService.link）
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
  { path: '/verify/:code', element: <VerifyPage />, errorElement: <RouteError /> },
  {
    path: '/app',
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      // 學員（SD §6.8）
      { path: 'learn', element: <MyCoursesPage /> },
      { path: 'learn/:enrollmentId', element: <LearnPage /> },
      { path: 'learn/:enrollmentId/timeline', element: <MyTimelinePage /> },
      { path: 'certificates', element: <MyCertificatesPage /> },
      { path: 'certificates/:certificateId', element: <MyCertificatePage /> },
      // 課程（SD §7.1）
      { path: 'courses', element: <CoursesPage /> },
      { path: 'courses/:courseId', element: <CoursePage /> },
      { path: 'courses/:courseId/learners/:enrollmentId', element: <LearnerDetailPage /> },
      { path: 'courses/:courseId/versions/:versionId/edit', element: <VersionEditorPage /> },
      // Org Admin：目前組織的成員與角色（SD 的 /app/org/roles 併入此頁）
      { path: 'org/users', element: <OrgMembersPage /> },
      { path: 'org/cohorts', element: <CohortsPage /> },
      { path: 'org/branding', element: <BrandingPage /> },
      { path: 'org/homepage', element: <HomepageEditorPage scope="organization" /> },
      { path: 'org/knowledge', element: <OrgKnowledgePage /> },
      { path: 'org/coach', element: <CoachSettingsPage /> },
      // Platform Admin
      { path: 'platform/organizations', element: <OrganizationsPage /> },
      { path: 'platform/organizations/:orgId/users', element: <OrgMembersPage /> },
      { path: 'platform/organizations/:orgId/branding', element: <BrandingPage /> },
      { path: 'platform/organizations/:orgId/ai-key', element: <OrgAiKeyPage /> },
      { path: 'platform/license', element: <LicensePage /> },
      { path: 'platform/system', element: <SettingsPage /> },
      { path: 'platform/jobs', element: <JobsPage /> },
      { path: 'platform/system-status', element: <SystemStatusPage /> },
      { path: 'platform/homepage', element: <HomepageEditorPage scope="platform" /> },
      // 稽核紀錄／帳號活動（所有 audit.read_* 共用，SD §12.4）
      { path: 'audit', element: <AuditPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/app" replace /> },
]);

import { createBrowserRouter, Navigate } from 'react-router';
import { RequireAuth } from './components/AppShell';
import { AuditPage } from './pages/AuditPage';
import { CoursePage } from './pages/CoursePage';
import { CoursesPage } from './pages/CoursesPage';
import { VersionEditorPage } from './pages/VersionEditorPage';
import { ForgotPasswordPage, LoginPage, SetPasswordPage } from './pages/auth-pages';
import { NotFoundPage, RouteError } from './pages/errors-pages';
import { HomePage } from './pages/HomePage';
import { JobsPage } from './pages/JobsPage';
import { SettingsPage } from './pages/SettingsPage';
import { LicensePage } from './pages/LicensePage';
import { LearnPage } from './pages/LearnPage';
import { MyCoursesPage } from './pages/MyCoursesPage';
import { OrganizationsPage } from './pages/OrganizationsPage';
import { OrgMembersPage } from './pages/OrgMembersPage';
import { ProfilePage } from './pages/ProfilePage';

/**
 * 路由（SD §7.1；react-router 8 data router）。
 * - 需登入的頁面一律在 /app 之下；/ 保留給公開 CMS 首頁（尚未實作，暫時導向 /app）
 * - /password-reset 與 /set-password 的路徑與 API 寄出的連結一致（AuthService.link）
 */
export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/app" replace /> },
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  { path: '/forgot-password', element: <ForgotPasswordPage />, errorElement: <RouteError /> },
  { path: '/password-reset', element: <SetPasswordPage mode="reset" />, errorElement: <RouteError /> },
  { path: '/set-password', element: <SetPasswordPage mode="invite" />, errorElement: <RouteError /> },
  {
    path: '/app',
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'profile', element: <ProfilePage /> },
      // 學員（SD §6.8）
      { path: 'learn', element: <MyCoursesPage /> },
      { path: 'learn/:enrollmentId', element: <LearnPage /> },
      // 課程（SD §7.1）
      { path: 'courses', element: <CoursesPage /> },
      { path: 'courses/:courseId', element: <CoursePage /> },
      { path: 'courses/:courseId/versions/:versionId/edit', element: <VersionEditorPage /> },
      // Org Admin：目前組織的成員與角色（SD 的 /app/org/roles 併入此頁）
      { path: 'org/users', element: <OrgMembersPage /> },
      // Platform Admin
      { path: 'platform/organizations', element: <OrganizationsPage /> },
      { path: 'platform/organizations/:orgId/users', element: <OrgMembersPage /> },
      { path: 'platform/license', element: <LicensePage /> },
      { path: 'platform/system', element: <SettingsPage /> },
      { path: 'platform/jobs', element: <JobsPage /> },
      // 稽核紀錄／帳號活動（所有 audit.read_* 共用，SD §12.4）
      { path: 'audit', element: <AuditPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/app" replace /> },
]);

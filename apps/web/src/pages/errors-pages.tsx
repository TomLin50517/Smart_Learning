import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { useTitle } from '../hooks';

export function NotFoundPage() {
  useTitle('找不到頁面');
  return (
    <section className="card empty">
      <h1>找不到頁面</h1>
      <p className="muted">網址可能有誤，或此頁面已移除。</p>
      <Link to="/app">回到首頁</Link>
    </section>
  );
}

/** 路由層級錯誤（元件拋出例外）。不顯示堆疊或伺服器訊息 */
export function RouteError() {
  const err = useRouteError();
  const notFound = isRouteErrorResponse(err) && err.status === 404;
  return (
    <main className="boot">
      <section className="card empty">
        <h1>{notFound ? '找不到頁面' : '畫面發生錯誤'}</h1>
        <p className="muted">{notFound ? '網址可能有誤，或此頁面已移除。' : '請重新整理頁面；若問題持續發生，請聯絡系統管理員。'}</p>
        <a href="/app">回到首頁</a>
      </section>
    </main>
  );
}

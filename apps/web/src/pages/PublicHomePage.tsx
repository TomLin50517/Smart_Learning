import type { PublicHomeDto } from '@iac/contracts';
import { Link, useSearchParams } from 'react-router';
import { ErrorAlert, Spinner } from '../components/ui';
import { useApi, useTitle } from '../hooks';
import { PageBlocks } from './page-blocks';

/** 公開首頁引用的素材（不需登入；只有已發布首頁引用到的素材可取得，見 SD §6.32） */
const publicAsset = (assetId: string) => `/public/cms/assets/${encodeURIComponent(assetId)}`;

/**
 * `/`：公開首頁（SA UC-CMS-005、SD §6.32）。不需登入，只顯示**已發布**的內容。
 * `?org=<代碼>` 顯示該組織的首頁；省略則為平台首頁。
 * 尚未發布任何內容時顯示最基本的入口，不會是一片空白。
 */
export function PublicHomePage() {
  const [params] = useSearchParams();
  const org = params.get('org');
  const r = useApi<PublicHomeDto>(`/public/cms/home${org ? `?org=${encodeURIComponent(org)}` : ''}`);
  useTitle('');

  const blocks = r.data?.blocks ?? [];
  return (
    <main className="public-home">
      <header className="public-home-bar">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <strong>{r.data?.organizationName ?? '互動學習平台'}</strong>
        <Link className="btn btn-small" to={org ? `/o/${encodeURIComponent(org)}` : '/login'}>
          登入
        </Link>
      </header>

      {r.loading && !r.data && <Spinner />}
      <ErrorAlert error={r.error} />

      {r.data && blocks.length > 0 && <PageBlocks blocks={blocks} assetSrc={publicAsset} />}

      {r.data && blocks.length === 0 && (
        <section className="cms-hero">
          <h1>{r.data.organizationName ?? '互動學習平台'}</h1>
          <p className="cms-hero-sub">登入後即可開始學習。</p>
          <Link className="btn btn-primary" to={org ? `/o/${encodeURIComponent(org)}` : '/login'}>
            登入
          </Link>
        </section>
      )}
    </main>
  );
}

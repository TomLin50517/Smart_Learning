import type { PageBlock } from '@iac/contracts';
import { Notice } from '../components/ui';
import { formatDate } from '../format';
import { parseMarkdownLite } from '../learn-lib';

/**
 * 首頁區塊的呈現（SD §7.5、§6.32）。公開首頁與編輯預覽共用。
 *
 * **所有文字一律由 React 轉義**——這裡不使用 `dangerouslySetInnerHTML`，Markdown 也只透過
 * `parseMarkdownLite` 轉成純文字結構（標題／清單／段落）。伺服器端已擋掉 raw HTML 與
 * 非 http(s) 連結，但渲染端不依賴那道防線也必須是安全的。
 *
 * 圖片與影片只接受素材 id，實際網址由 `assetSrc` 提供——公開頁與已登入的預覽用不同端點。
 */
export function PageBlocks({ blocks, assetSrc }: { blocks: readonly PageBlock[]; assetSrc: (assetId: string) => string }) {
  return (
    <>
      {blocks.map((b, i) => (
        <PageBlockView key={i} block={b} assetSrc={assetSrc} />
      ))}
    </>
  );
}

function PageBlockView({ block: b, assetSrc }: { block: PageBlock; assetSrc: (assetId: string) => string }) {
  switch (b.type) {
    case 'hero':
      return (
        <section className="cms-hero">
          {b.imageAssetId && <img className="cms-hero-image" src={assetSrc(b.imageAssetId)} alt="" />}
          <h1>{b.title}</h1>
          {b.subtitle && <p className="cms-hero-sub">{b.subtitle}</p>}
          {b.cta && (
            <a className="btn btn-primary" href={b.cta.href} rel="noopener noreferrer">
              {b.cta.label}
            </a>
          )}
        </section>
      );

    case 'richtext':
      return (
        <section className="richtext">
          {parseMarkdownLite(b.markdown).map((m, i) =>
            m.type === 'h' ? (
              m.level === 1 ? (
                <h2 key={i}>{m.text}</h2>
              ) : (
                <h3 key={i}>{m.text}</h3>
              )
            ) : m.type === 'ul' ? (
              <ul key={i}>
                {m.items.map((x, j) => (
                  <li key={j}>{x}</li>
                ))}
              </ul>
            ) : (
              <p key={i} className="pre-line">
                {m.text}
              </p>
            ),
          )}
        </section>
      );

    case 'image':
      return (
        <figure className="cms-figure">
          <img src={assetSrc(b.assetId)} alt={b.alt} />
          {b.caption && <figcaption className="muted small">{b.caption}</figcaption>}
        </figure>
      );

    case 'video':
      return (
        <figure className="cms-figure">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- 首頁影片由編輯者自行決定是否附字幕 */}
          <video src={assetSrc(b.assetId)} poster={b.poster ? assetSrc(b.poster) : undefined} controls preload="metadata" />
        </figure>
      );

    case 'announcement':
      return (
        <section className="cms-announcements">
          {b.items.map((it, i) => (
            <article key={i}>
              <h3>{it.title}</h3>
              <p className="muted small">{formatDate(it.publishedAt)}</p>
              <p className="pre-line">{it.body}</p>
            </article>
          ))}
        </section>
      );

    case 'callout':
      return <Notice kind={b.variant === 'warning' ? 'warn' : b.variant === 'success' ? 'ok' : 'info'}>{b.body}</Notice>;

    case 'footer':
      return (
        <footer className="cms-footer">
          {b.links.map((l, i) => (
            <a key={i} href={l.href} rel="noopener noreferrer">
              {l.label}
            </a>
          ))}
        </footer>
      );
  }
}

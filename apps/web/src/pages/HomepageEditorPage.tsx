import type { CmsPageDto, PageBlock } from '@iac/contracts';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { formatDateTime } from '../format';
import { useApi, useTitle } from '../hooks';
import { PageBlocks } from './page-blocks';

/** 新增區塊時的預設內容 */
const EMPTY: Record<string, PageBlock> = {
  hero: { type: 'hero', title: '標題' },
  richtext: { type: 'richtext', markdown: '' },
  announcement: { type: 'announcement', items: [] },
  callout: { type: 'callout', variant: 'info', body: '' },
  footer: { type: 'footer', links: [] },
};
const BLOCK_LABELS: Record<string, string> = {
  hero: '主視覺',
  richtext: '文字段落',
  image: '圖片',
  video: '影片',
  announcement: '公告',
  callout: '提示框',
  footer: '頁尾連結',
};

/**
 * 首頁編輯（SA UC-CMS-001～004、SD §6.32）。
 * `base` 決定編輯的是平台首頁還是目前組織的首頁——兩者的權限範圍不同。
 *
 * 草稿與發布分開：存檔只動草稿，**公開頁面要等按下「發布」才會改變**。
 */
export function HomepageEditorPage({ scope }: { scope: 'platform' | 'organization' }) {
  const base = scope === 'platform' ? '/api/platform/cms/pages/home' : '/api/cms/pages/home';
  const title = scope === 'platform' ? '平台首頁' : '組織首頁';
  useTitle(title);
  const me = useMe();
  const allowed = can(me, 'cms.read');
  const canWrite = can(me, 'cms.write');
  const canPublish = can(me, 'cms.publish');

  const page = useApi<CmsPageDto>(allowed ? base : null);
  const [blocks, setBlocks] = useState<PageBlock[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 載入後才有草稿內容；之後以本地編輯為準，不被重新載入覆蓋
  useEffect(() => {
    if (page.data && blocks === null) setBlocks(page.data.draftBlocks);
  }, [page.data, blocks]);

  if (!allowed) return <Forbidden />;
  const current = blocks ?? [];

  const run = async (fn: () => Promise<CmsPageDto>, ok: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      setBlocks(r.draftBlocks);
      page.reload();
      setNotice(ok);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const edit = (i: number, b: PageBlock) => setBlocks(current.map((x, n) => (n === i ? b : x)));
  const move = (i: number, by: number) => {
    const next = [...current];
    const [x] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, x!);
    setBlocks(next);
  };

  return (
    <>
      <PageHeader
        title={title}
        subtitle={page.data?.publishedAt ? `最近發布於 ${formatDateTime(page.data.publishedAt)}（第 ${page.data.publishedRevisionNo} 版）` : '尚未發布過'}
        actions={
          <>
            {canWrite && (
              <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api<CmsPageDto>('PATCH', `${base}/draft`, { blocks: current }), '草稿已儲存（公開頁面尚未改變）')}>
                儲存草稿
              </button>
            )}
            {canPublish && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => api<CmsPageDto>('POST', `${base}/publish`), '已發布，公開頁面已更新')}>
                發布
              </button>
            )}
          </>
        }
      />
      <ErrorAlert error={error ?? page.error} />
      {notice && <Notice kind="ok">{notice}</Notice>}
      {page.data?.hasUnpublishedChanges && <Notice kind="warn">有尚未發布的變更——公開頁面顯示的仍是上一個已發布的版本。</Notice>}
      {!page.data && page.loading && <Spinner />}

      {page.data && (
        <div className="cms-editor">
          <section className="card">
            <h2>內容區塊</h2>
            {current.length === 0 && <p className="muted">還沒有任何區塊。用下方按鈕新增。</p>}
            {current.map((b, i) => (
              <article key={i} className="cms-block-edit">
                <header>
                  <strong>{BLOCK_LABELS[b.type] ?? b.type}</strong>
                  <span className="spacer" />
                  <button type="button" className="btn btn-small" disabled={!canWrite || i === 0} onClick={() => move(i, -1)}>
                    上移
                  </button>
                  <button type="button" className="btn btn-small" disabled={!canWrite || i === current.length - 1} onClick={() => move(i, 1)}>
                    下移
                  </button>
                  <button type="button" className="btn btn-small btn-danger" disabled={!canWrite} onClick={() => setBlocks(current.filter((_, n) => n !== i))}>
                    刪除
                  </button>
                </header>
                <BlockFields block={b} disabled={!canWrite} onChange={(x) => edit(i, x)} />
              </article>
            ))}

            {canWrite && (
              <div className="cms-add">
                {Object.keys(EMPTY).map((t) => (
                  <button key={t} type="button" className="btn btn-small" onClick={() => setBlocks([...current, structuredCloneLite(EMPTY[t]!)])}>
                    ＋{BLOCK_LABELS[t]}
                  </button>
                ))}
              </div>
            )}
            <p className="muted small">圖片與影片區塊目前需要先在素材庫上傳，尚未提供從這裡挑選的介面。</p>
          </section>

          <section className="card">
            <h2>預覽</h2>
            <div className="cms-preview">
              <PageBlocks blocks={current} assetSrc={(id) => `/api/assets/${encodeURIComponent(id)}/content`} />
            </div>
          </section>

          {page.data.revisions.length > 0 && (
            <section className="card">
              <h2>發布紀錄</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>發布時間</th>
                    <th>發布者</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {page.data.revisions.map((r) => (
                    <tr key={r.revisionNo}>
                      <td>第 {r.revisionNo} 版</td>
                      <td className="nowrap">{formatDateTime(r.publishedAt)}</td>
                      <td>{r.publishedByName ?? '—'}</td>
                      <td>
                        {canPublish && r.revisionNo !== page.data!.publishedRevisionNo && (
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={busy}
                            onClick={() => void run(() => api<CmsPageDto>('POST', `${base}/rollback`, { revisionNo: r.revisionNo }), `已回到第 ${r.revisionNo} 版的內容並發布`)}
                          >
                            回到這個版本
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">回滾會把舊版內容重新發布成新的一版，歷史紀錄不會被改寫。</p>
            </section>
          )}
        </div>
      )}
    </>
  );
}

/** 只複製一層即可——EMPTY 的內容沒有巢狀物件 */
const structuredCloneLite = (b: PageBlock): PageBlock => ({ ...b, ...(b.type === 'announcement' && { items: [] }), ...(b.type === 'footer' && { links: [] }) }) as PageBlock;

function BlockFields({ block: b, disabled, onChange }: { block: PageBlock; disabled: boolean; onChange(b: PageBlock): void }) {
  switch (b.type) {
    case 'hero':
      return (
        <>
          <Field label="標題">
            <input value={b.title} disabled={disabled} onChange={(e) => onChange({ ...b, title: e.target.value })} />
          </Field>
          <Field label="副標題">
            <input value={b.subtitle ?? ''} disabled={disabled} onChange={(e) => onChange({ ...b, subtitle: e.target.value || undefined })} />
          </Field>
          <Field label="按鈕文字">
            <input value={b.cta?.label ?? ''} disabled={disabled} onChange={(e) => onChange({ ...b, cta: e.target.value ? { label: e.target.value, href: b.cta?.href ?? '' } : undefined })} />
          </Field>
          <Field label="按鈕連結" hint="必須是 http(s) 開頭">
            <input value={b.cta?.href ?? ''} disabled={disabled} onChange={(e) => onChange({ ...b, cta: { label: b.cta?.label ?? '', href: e.target.value } })} />
          </Field>
        </>
      );
    case 'richtext':
      return (
        <Field label="內容（Markdown）" hint="支援標題（#～###）與清單（- 開頭）；不支援 HTML">
          <textarea rows={6} value={b.markdown} disabled={disabled} onChange={(e) => onChange({ ...b, markdown: e.target.value })} />
        </Field>
      );
    case 'callout':
      return (
        <>
          <Field label="樣式">
            <select value={b.variant} disabled={disabled} onChange={(e) => onChange({ ...b, variant: e.target.value as typeof b.variant })}>
              <option value="info">一般</option>
              <option value="warning">提醒</option>
              <option value="success">好消息</option>
            </select>
          </Field>
          <Field label="內容">
            <textarea rows={3} value={b.body} disabled={disabled} onChange={(e) => onChange({ ...b, body: e.target.value })} />
          </Field>
        </>
      );
    case 'announcement':
      return (
        <>
          {b.items.map((it, i) => (
            <fieldset key={i} className="cms-subitem">
              <Field label="標題">
                <input value={it.title} disabled={disabled} onChange={(e) => onChange({ ...b, items: b.items.map((x, n) => (n === i ? { ...x, title: e.target.value } : x)) })} />
              </Field>
              <Field label="內容">
                <textarea rows={2} value={it.body} disabled={disabled} onChange={(e) => onChange({ ...b, items: b.items.map((x, n) => (n === i ? { ...x, body: e.target.value } : x)) })} />
              </Field>
              <button type="button" className="btn btn-small btn-danger" disabled={disabled} onClick={() => onChange({ ...b, items: b.items.filter((_, n) => n !== i) })}>
                移除這則
              </button>
            </fieldset>
          ))}
          <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onChange({ ...b, items: [...b.items, { title: '', body: '', publishedAt: new Date().toISOString() }] })}>
            ＋新增一則公告
          </button>
        </>
      );
    case 'footer':
      return (
        <>
          {b.links.map((l, i) => (
            <fieldset key={i} className="cms-subitem">
              <Field label="文字">
                <input value={l.label} disabled={disabled} onChange={(e) => onChange({ ...b, links: b.links.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)) })} />
              </Field>
              <Field label="連結" hint="必須是 http(s) 開頭">
                <input value={l.href} disabled={disabled} onChange={(e) => onChange({ ...b, links: b.links.map((x, n) => (n === i ? { ...x, href: e.target.value } : x)) })} />
              </Field>
              <button type="button" className="btn btn-small btn-danger" disabled={disabled} onClick={() => onChange({ ...b, links: b.links.filter((_, n) => n !== i) })}>
                移除
              </button>
            </fieldset>
          ))}
          <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onChange({ ...b, links: [...b.links, { label: '', href: '' }] })}>
            ＋新增連結
          </button>
        </>
      );
    case 'image':
    case 'video':
      return <p className="muted small">素材 id：{b.assetId}（目前請在素材庫管理，這裡不提供挑選介面）</p>;
  }
}

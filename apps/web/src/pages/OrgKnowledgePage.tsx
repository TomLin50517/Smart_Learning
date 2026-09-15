import { DOCUMENT_ACCEPT, DOCUMENT_PROCESSING_STATUSES, DOCUMENT_TEXT_STATUSES, type DocumentVersionDto, type DocumentViewDto, type SharedDocumentDto } from '@iac/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api, apiUpload } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, PageHeader, Spinner } from '../components/ui';
import { DOCUMENT_FAILURE_TEXT, DOCUMENT_STATUS_BADGE, DOCUMENT_STATUS_LABELS, formatBytes, formatDateTime } from '../format';
import { useApi, useTitle } from '../hooks';

const POLL_MS = 4000;
const enc = encodeURIComponent;
const BASE = '/api/org/knowledge/documents';

function StatusBadge({ v }: { v: DocumentVersionDto }) {
  return (
    <>
      <span className={`badge ${DOCUMENT_STATUS_BADGE[v.status]}`}>{DOCUMENT_STATUS_LABELS[v.status]}</span>
      {v.failureReason && <div className="text-danger small">{DOCUMENT_FAILURE_TEXT(v.failureReason)}</div>}
    </>
  );
}

/**
 * /app/org/knowledge：組織共用教材（SD §6.27）。組織管理員上傳與維護（例如公司制度、安全規範）；
 * 各課程在草稿版本的「教材」卡片選擇加入後，AI 教練才會引用。
 */
export function OrgKnowledgePage() {
  useTitle('共用教材');
  const me = useMe();
  const allowed = can(me, 'knowledge.shared.write');
  const list = useApi<SharedDocumentDto[]>(allowed ? BASE : null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ documentId: string; versionId: string; page: number } | null>(null);
  const writable = me.licenseCapabilities.authoringAllowed;
  const processing = list.data?.some((d) => DOCUMENT_PROCESSING_STATUSES.includes(d.latestVersion.status)) ?? false;

  useEffect(() => {
    if (!processing) return;
    const t = window.setInterval(list.reload, POLL_MS);
    return () => window.clearInterval(t);
  }, [processing, list.reload]);

  if (!allowed) return <Forbidden />;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="共用教材" subtitle="組織內每門課都可以使用的教材，例如公司制度、安全規範。各課程在草稿版本的「教材」選擇加入後，AI 教練才會引用。" />
      <ErrorAlert error={error ?? list.error} />
      {writable && (
        <section className="card">
          <h2>上傳共用教材</h2>
          <UploadForm disabled={busy} onDone={list.reload} onError={setError} />
        </section>
      )}
      <section className="card">
        <h2>教材清單</h2>
        {!list.data && list.loading && <Spinner />}
        {list.data && list.data.length === 0 && <p className="muted">還沒有共用教材。</p>}
        {list.data && list.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>教材</th>
                  <th>狀態</th>
                  <th>內容</th>
                  <th>使用中的課程</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {list.data.map((d) => {
                  const v = d.latestVersion;
                  return (
                    <tr key={d.documentId}>
                      <td>
                        <div>{d.title}</div>
                        <div className="muted small">
                          v{v.versionNo}・{v.originalFilename}・{formatBytes(v.sizeBytes)}・{formatDateTime(v.uploadedAt)}
                        </div>
                      </td>
                      <td>
                        <StatusBadge v={v} />
                      </td>
                      <td className="small">
                        {v.pageCount !== null && <div>{v.pageCount} 頁</div>}
                        {v.chunkCount !== null && <div>{v.chunkCount} 段</div>}
                      </td>
                      <td>{d.usedByCourses}</td>
                      <td className="actions">
                        <div className="row-actions">
                          {DOCUMENT_TEXT_STATUSES.includes(v.status) && (
                            <button type="button" className="btn btn-small" onClick={() => setPreview({ documentId: d.documentId, versionId: v.id, page: 1 })}>
                              預覽文字
                            </button>
                          )}
                          {writable && v.status === 'failed' && (
                            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(() => api('POST', `${BASE}/${d.documentId}/versions/${v.id}/retry`))}>
                              重試
                            </button>
                          )}
                          {writable && (
                            <label className="btn btn-small">
                              上傳新版
                              <input
                                type="file"
                                accept={DOCUMENT_ACCEPT}
                                hidden
                                disabled={busy}
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) void run(() => apiUpload(`${BASE}/${d.documentId}/versions?filename=${enc(f.name)}`, f));
                                }}
                              />
                            </label>
                          )}
                          {writable && (
                            <button
                              type="button"
                              className="btn btn-small btn-danger"
                              disabled={busy}
                              onClick={() =>
                                window.confirm(`刪除共用教材「${d.title}」的所有版本？\n已發布的課程版本仍在使用時無法刪除。`) && void run(() => api('DELETE', `${BASE}/${d.documentId}`))
                              }
                            >
                              刪除
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {processing && <p className="muted small">處理中，畫面會自動更新…</p>}
        {preview && <Preview key={`${preview.versionId}-${preview.page}`} {...preview} onPage={(page) => setPreview({ ...preview, page })} onClose={() => setPreview(null)} />}
      </section>
    </>
  );
}

function UploadForm(props: { disabled: boolean; onDone(): void; onError(e: unknown): void }) {
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(0);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    props.onError(null);
    try {
      await apiUpload(`${BASE}?filename=${enc(file.name)}${title.trim() ? `&title=${enc(title.trim())}` : ''}`, file);
      setTitle('');
      setFile(null);
      setKey((k) => k + 1);
      props.onDone();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={(e) => void submit(e)}>
      <fieldset disabled={props.disabled || busy}>
        <Field label="教材檔案" hint="PDF、Word（.docx）、Markdown（.md）或文字檔（.txt）">
          <input key={key} type="file" accept={DOCUMENT_ACCEPT} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="名稱（選填）" hint="預設使用檔名">
          <input maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!file}>
            {busy ? '上傳中…' : '上傳'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function Preview(props: { documentId: string; versionId: string; page: number; onPage(p: number): void; onClose(): void }) {
  const view = useApi<DocumentViewDto>(`${BASE}/${props.documentId}/versions/${props.versionId}/view?page=${props.page}`);
  const d = view.data;
  return (
    <div className="editor">
      <div className="row">
        <strong className="grow">{d ? `${d.title}（v${d.versionNo}）` : '預覽'}</strong>
        {d?.page && d.pageCount && (
          <>
            <button type="button" className="btn btn-small" disabled={d.page <= 1} onClick={() => props.onPage(d.page! - 1)}>
              上一頁
            </button>
            <span className="small">
              第 {d.page}／{d.pageCount} 頁
            </span>
            <button type="button" className="btn btn-small" disabled={d.page >= d.pageCount} onClick={() => props.onPage(d.page! + 1)}>
              下一頁
            </button>
          </>
        )}
        <button type="button" className="btn btn-small btn-ghost" onClick={props.onClose}>
          關閉
        </button>
      </div>
      <ErrorAlert error={view.error} />
      {!d && view.loading && <Spinner />}
      {d && (
        <>
          <pre className="doc-preview">{d.text || '（這一頁沒有文字）'}</pre>
          {d.truncated && <p className="muted small">內容較長，只顯示前面一部分。</p>}
        </>
      )}
    </div>
  );
}

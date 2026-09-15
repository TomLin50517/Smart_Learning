import {
  DOCUMENT_ACCEPT,
  DOCUMENT_PROCESSING_STATUSES,
  DOCUMENT_TEXT_STATUSES,
  type BoundDocumentDto,
  type CourseKnowledgeDto,
  type DocumentVersionDto,
  type DocumentViewDto,
  type KnowledgeSearchHitDto,
  type KnowledgeSearchResultDto,
} from '@iac/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api, apiUpload } from '../api/client';
import { ErrorAlert, Field, Notice, Spinner } from '../components/ui';
import { DOCUMENT_FAILURE_TEXT, DOCUMENT_STATUS_BADGE, DOCUMENT_STATUS_LABELS, formatBytes, formatDateTime } from '../format';
import { useApi } from '../hooks';

const POLL_MS = 4000;
const enc = encodeURIComponent;

function StatusBadge({ v }: { v: DocumentVersionDto }) {
  return (
    <>
      <span className={`badge ${DOCUMENT_STATUS_BADGE[v.status]}`}>{DOCUMENT_STATUS_LABELS[v.status]}</span>
      {v.failureReason && <div className="text-danger small">{DOCUMENT_FAILURE_TEXT(v.failureReason)}</div>}
    </>
  );
}

/**
 * 課程版本的「教材」卡片（SD §6.17）：上傳 PDF／Word／Markdown／文字檔，背景解析後供 AI 教練引用。
 * 只有草稿可上傳、加入、移出；已發布版本的教材固定不變（舊學員的引用不會失效）。
 */
export function KnowledgePanel({ versionId, editable }: { versionId: string; editable: boolean }) {
  const data = useApi<CourseKnowledgeDto>(`/api/course-versions/${versionId}/knowledge`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ documentId: string; versionId: string; page: number } | null>(null);
  const processing = data.data?.bound.some((b) => DOCUMENT_PROCESSING_STATUSES.includes(b.boundVersion.status)) ?? false;
  const canEdit = editable && !!data.data?.editable;

  useEffect(() => {
    if (!processing) return;
    const t = window.setInterval(data.reload, POLL_MS);
    return () => window.clearInterval(t);
  }, [processing, data.reload]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      data.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const k = data.data;
  return (
    <section className="card">
      <h2>教材</h2>
      <p className="muted small">AI 學習教練只根據這裡的教材回答並附上出處。可上傳 PDF、Word（.docx）、Markdown 或文字檔；上傳後系統會在背景擷取文字並切成段落。</p>
      <ErrorAlert error={error} />
      <ErrorAlert error={data.error} />
      {!k && data.loading && <Spinner />}
      {k && !k.editable && <Notice kind="info">此版本已發布，教材固定不變；要更換教材請到草稿版本操作。</Notice>}
      {canEdit && <UploadForm versionId={versionId} disabled={busy} onDone={data.reload} onError={setError} />}

      {k && k.bound.length === 0 && <p className="muted">此版本尚未加入教材。</p>}
      {k && k.bound.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>教材</th>
                <th>狀態</th>
                <th>內容</th>
                <th>上傳</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {k.bound.map((b) => (
                <BoundRow
                  key={b.documentId}
                  b={b}
                  canEdit={canEdit}
                  busy={busy}
                  onPreview={() => setPreview({ documentId: b.documentId, versionId: b.boundVersion.id, page: 1 })}
                  onNewVersion={(file) => run(() => apiUpload(`/api/knowledge/documents/${b.documentId}/versions?filename=${enc(file.name)}`, file))}
                  onRetry={() => run(() => api('POST', `/api/knowledge/documents/${b.documentId}/versions/${b.boundVersion.id}/retry`))}
                  onUnbind={() => window.confirm(`把「${b.title}」移出此版本？教材本身會保留，之後可以再加入。`) && void run(() => api('DELETE', `/api/course-versions/${versionId}/knowledge/bindings/${b.boundVersion.id}`))}
                  onDelete={() =>
                    window.confirm(`刪除教材「${b.title}」的所有版本？\n已發布的課程版本仍在使用時無法刪除。`) && void run(() => api('DELETE', `/api/knowledge/documents/${b.documentId}`))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {processing && <p className="muted small">處理中，畫面會自動更新…</p>}

      {canEdit && k && k.available.length > 0 && (
        <details className="bulk">
          <summary>加入本課程其他版本用過、或組織共用的教材（{k.available.length}）</summary>
          <ul className="link-list">
            {k.available.map((a) => (
              <li key={a.documentId}>
                {a.title} {a.shared && <span className="badge">組織共用</span>} <span className="muted small">v{a.latestVersion.versionNo}</span> <StatusBadge v={a.latestVersion} />{' '}
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(() => api('POST', `/api/course-versions/${versionId}/knowledge/bindings`, { documentVersionId: a.latestVersion.id }))}>
                  加入此版本
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {preview && <Preview key={`${preview.versionId}-${preview.page}`} {...preview} onPage={(page) => setPreview({ ...preview, page })} onClose={() => setPreview(null)} />}
      {k && k.bound.length > 0 && <SearchBox versionId={versionId} onOpen={(h) => setPreview({ documentId: h.documentId, versionId: h.documentVersionId, page: h.pageNo ?? 1 })} />}
    </section>
  );
}

/** 測試搜尋（SD §6.18）：與 AI 教練同一個檢索器，老師可確認學員的問題會找到哪些段落 */
function SearchBox({ versionId, onOpen }: { versionId: string; onOpen(h: KnowledgeSearchHitDto): void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<KnowledgeSearchResultDto | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<KnowledgeSearchResultDto>('POST', `/api/course-versions/${versionId}/knowledge/search`, { query: query.trim() }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor">
      <strong>測試搜尋</strong>
      <p className="muted small">輸入學員可能會問的問題，看看 AI 教練會找到哪些教材段落。找不到時，教練會回答「教材中沒有足夠的資料」。</p>
      <form className="row" onSubmit={(e) => void submit(e)}>
        <input className="grow" maxLength={500} value={query} placeholder="例如：發酵溫度要多少？" aria-label="測試問題" onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" className="btn" disabled={busy || !query.trim()}>
          {busy ? '搜尋中…' : '搜尋'}
        </button>
      </form>
      <ErrorAlert error={error} />
      {result && (
        <>
          {result.pendingDocuments > 0 && <p className="muted small">還有 {result.pendingDocuments} 份教材處理中，尚未納入搜尋。</p>}
          {result.hits.length === 0 ? (
            <p className="muted">{result.searchableDocuments === 0 ? '此版本還沒有可搜尋的教材。' : '沒有找到相關段落。'}</p>
          ) : (
            <ol className="search-hits">
              {result.hits.map((h) => (
                <li key={h.chunkId}>
                  <div className="row">
                    <strong className="grow">
                      {h.title}
                      {h.pageNo !== null && <span className="muted small">・第 {h.pageNo} 頁</span>}
                      {h.sectionPath && <span className="muted small">・{h.sectionPath}</span>}
                    </strong>
                    <span className="muted small" title="相關程度（只用來比較這次搜尋的結果）">{h.score.toFixed(2)}</span>
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => onOpen(h)}>
                      看原文
                    </button>
                  </div>
                  <p className="small search-snippet">{h.content.length > 400 ? `${h.content.slice(0, 400)}…` : h.content}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function UploadForm(props: { versionId: string; disabled: boolean; onDone(): void; onError(e: unknown): void }) {
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
      await apiUpload(`/api/course-versions/${props.versionId}/knowledge/documents?filename=${enc(file.name)}${title.trim() ? `&title=${enc(title.trim())}` : ''}`, file);
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

function BoundRow(props: {
  b: BoundDocumentDto;
  canEdit: boolean;
  busy: boolean;
  onPreview(): void;
  onNewVersion(file: File): void;
  onRetry(): void;
  onUnbind(): void;
  onDelete(): void;
}) {
  const { b } = props;
  const v = b.boundVersion;
  const newer = b.latestVersion.id !== v.id;
  return (
    <tr>
      <td>
        <div>
          {b.title} {b.shared && <span className="badge" title="由組織管理員維護；這裡只能加入或移出">組織共用</span>}
        </div>
        <div className="muted small">
          v{v.versionNo}・{v.originalFilename}・{formatBytes(v.sizeBytes)}
        </div>
        {newer && <div className="muted small">最新為 v{b.latestVersion.versionNo}（{DOCUMENT_STATUS_LABELS[b.latestVersion.status]}）</div>}
      </td>
      <td>
        <StatusBadge v={v} />
      </td>
      <td className="small">
        {v.pageCount !== null && <div>{v.pageCount} 頁</div>}
        {v.chunkCount !== null && <div>{v.chunkCount} 段</div>}
      </td>
      <td className="small">{formatDateTime(v.uploadedAt)}</td>
      <td className="actions">
        <div className="row-actions">
          {DOCUMENT_TEXT_STATUSES.includes(v.status) && (
            <button type="button" className="btn btn-small" onClick={props.onPreview}>
              預覽文字
            </button>
          )}
          {props.canEdit && v.status === 'failed' && (
            <button type="button" className="btn btn-small" disabled={props.busy} onClick={props.onRetry}>
              重試
            </button>
          )}
          {props.canEdit && !b.shared && (
            <label className="btn btn-small">
              上傳新版
              <input type="file" accept={DOCUMENT_ACCEPT} hidden disabled={props.busy} onChange={(e) => e.target.files?.[0] && props.onNewVersion(e.target.files[0])} />
            </label>
          )}
          {props.canEdit && (
            <button type="button" className="btn btn-small" disabled={props.busy} onClick={props.onUnbind}>
              移出
            </button>
          )}
          {props.canEdit && !b.shared && (
            <button type="button" className="btn btn-small btn-danger" disabled={props.busy} onClick={props.onDelete}>
              刪除
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function Preview(props: { documentId: string; versionId: string; page: number; onPage(p: number): void; onClose(): void }) {
  const view = useApi<DocumentViewDto>(`/api/knowledge/documents/${props.documentId}/versions/${props.versionId}/view?page=${props.page}`);
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
          <p className="muted small">這是系統從檔案擷取出的文字，AI 教練會依此回答。排版可能與原檔不同；若文字缺漏或亂碼，請改上傳其他格式。</p>
          <pre className="doc-preview">{d.text || '（這一頁沒有文字）'}</pre>
          {d.truncated && <p className="muted small">內容較長，只顯示前面一部分。</p>}
        </>
      )}
    </div>
  );
}

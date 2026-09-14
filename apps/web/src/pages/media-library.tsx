import { assetUrl, MEDIA_ACCEPT, type MediaAssetDto, type MediaKind } from '@iac/contracts';
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, apiUpload } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Spinner } from '../components/ui';
import { formatBytes, formatDateTime, VERSION_STATUS_LABELS } from '../format';
import { useApi } from '../hooks';

const enc = encodeURIComponent;
const KIND_LABEL: Record<MediaKind, string> = { image: '圖片', video: '影片' };

interface MediaCtx {
  courseId: string;
  assets: MediaAssetDto[];
  loading: boolean;
  reload(): void;
  /** 可上傳（編輯權限且授權允許） */
  canUpload: boolean;
}

const Ctx = createContext<MediaCtx | null>(null);

/** 課程素材清單（編輯器的區塊與影片活動共用；上傳後自動重新載入） */
export function MediaProvider({ courseId, children }: { courseId: string; children: ReactNode }) {
  const me = useMe();
  const list = useApi<MediaAssetDto[]>(can(me, 'course.version.read') ? `/api/courses/${courseId}/assets` : null);
  const value: MediaCtx = {
    courseId,
    assets: list.data ?? [],
    loading: list.loading,
    reload: list.reload,
    canUpload: can(me, 'course.version.write') && me.licenseCapabilities.authoringAllowed,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useMedia(): MediaCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('MediaProvider is missing');
  return c;
}

async function uploadAsset(courseId: string, file: File, title?: string): Promise<MediaAssetDto> {
  return apiUpload<MediaAssetDto>(`/api/courses/${courseId}/assets?filename=${enc(file.name)}${title?.trim() ? `&title=${enc(title.trim())}` : ''}`, file);
}

/** 素材的小預覽（圖片縮圖；影片顯示圖示——不為了縮圖下載整段影片） */
function Thumb({ a }: { a: MediaAssetDto }) {
  return a.kind === 'image' ? <img className="media-thumb" src={assetUrl(a.id)} alt="" loading="lazy" /> : <span className="media-thumb media-thumb-video" aria-hidden="true">▶</span>;
}

/**
 * 選擇素材（編輯器）：本課程的圖片或影片；可在這裡直接上傳，上傳後自動選取。
 * 素材不可變——要換內容就上傳新的再選它。
 */
export function AssetPicker({ kind, value, onChange, optional }: { kind: MediaKind; value: string; onChange(id: string): void; optional?: boolean }) {
  const m = useMedia();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const options = m.assets.filter((a) => a.kind === kind);
  const selected = options.find((a) => a.id === value);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const a = await uploadAsset(m.courseId, file);
      m.reload();
      onChange(a.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="asset-picker">
      <div className="row">
        {selected && <Thumb a={selected} />}
        <select className="grow" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`選擇${KIND_LABEL[kind]}`}>
          <option value="">{optional ? '（不使用）' : `請選擇${KIND_LABEL[kind]}`}</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}（{formatBytes(a.sizeBytes)}）
            </option>
          ))}
          {value && !selected && !m.loading && <option value={value}>（找不到此素材）</option>}
        </select>
        {m.canUpload && (
          <label className="btn btn-small">
            {busy ? '上傳中…' : `上傳${KIND_LABEL[kind]}`}
            <input ref={input} type="file" hidden accept={MEDIA_ACCEPT[kind]} disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
        )}
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}

/** 課程頁的「素材庫」：上傳、預覽、改名、刪除（被課程版本引用的不能刪） */
export function MediaLibraryCard({ courseId }: { courseId: string }) {
  return (
    <MediaProvider courseId={courseId}>
      <Library />
    </MediaProvider>
  );
}

function Library() {
  const m = useMedia();
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<MediaAssetDto | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      m.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) return;
    void run(async () => {
      await uploadAsset(m.courseId, file, title);
      setTitle('');
      setFile(null);
      setKey((k) => k + 1);
    });
  }

  const total = m.assets.reduce((n, a) => n + a.sizeBytes, 0);
  return (
    <section className="card">
      <h2>素材庫</h2>
      <p className="muted small">
        課節中的圖片與影片、影片活動都從這裡選用。圖片：PNG、JPG、WebP（20 MB 以內）；影片：MP4、WebM。素材只有課程人員與這門課的學員看得到。
      </p>
      <ErrorAlert error={error} />
      {m.canUpload && (
        <form className="form-grid" onSubmit={submit}>
          <fieldset disabled={busy}>
            <Field label="檔案">
              <input key={key} type="file" required accept={`${MEDIA_ACCEPT.image},${MEDIA_ACCEPT.video}`} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
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
      )}
      {m.loading && !m.assets.length && <Spinner />}
      {!m.loading && m.assets.length === 0 && <p className="muted">還沒有素材。</p>}
      {m.assets.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th aria-label="預覽" />
                  <th>名稱</th>
                  <th>類型</th>
                  <th>大小</th>
                  <th>使用中</th>
                  <th>上傳</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {m.assets.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button type="button" className="link-button" onClick={() => setPreview(a)} aria-label={`預覽 ${a.title}`}>
                        <Thumb a={a} />
                      </button>
                    </td>
                    <td>
                      {a.title}
                      <div className="muted small">{a.originalFilename}</div>
                    </td>
                    <td>{KIND_LABEL[a.kind]}</td>
                    <td className="small">{formatBytes(a.sizeBytes)}</td>
                    <td className="small">{a.usedBy.length ? a.usedBy.map((u) => `v${u.versionNo}（${VERSION_STATUS_LABELS[u.status]}）`).join('、') : '—'}</td>
                    <td className="small">
                      {formatDateTime(a.createdAt)}
                      {a.createdBy && <div className="muted">{a.createdBy}</div>}
                    </td>
                    <td className="actions">
                      {m.canUpload && (
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={busy}
                            onClick={() => {
                              const t = window.prompt('素材名稱', a.title)?.trim();
                              if (t && t !== a.title) void run(() => api('PATCH', `/api/assets/${a.id}`, { title: t }));
                            }}
                          >
                            改名
                          </button>
                          <button
                            type="button"
                            className="btn btn-small btn-danger"
                            disabled={busy || a.usedBy.length > 0}
                            title={a.usedBy.length ? '課程版本正在使用，無法刪除' : undefined}
                            onClick={() => window.confirm(`刪除「${a.title}」？`) && void run(() => api('DELETE', `/api/assets/${a.id}`))}
                          >
                            刪除
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            共 {m.assets.length} 個素材，{formatBytes(total)}。已被課程版本使用的素材不能刪除（已發布的內容不能失效）；要換內容請上傳新素材再改用。
          </p>
        </>
      )}
      {preview && <MediaPreview a={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

function MediaPreview({ a, onClose }: { a: MediaAssetDto; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={a.title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong className="grow">{a.title}</strong>
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose} autoFocus>
            關閉
          </button>
        </div>
        <div className="modal-body">
          {a.kind === 'image' ? <img className="media-full" src={assetUrl(a.id)} alt={a.title} /> : <video className="media-full" src={assetUrl(a.id)} controls preload="metadata" />}
        </div>
      </div>
    </div>
  );
}

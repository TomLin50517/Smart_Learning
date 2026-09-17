import type { CourseDetailDto, EnrollmentPolicyViewDto, JoinBy } from '@iac/contracts';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Notice, Spinner } from '../components/ui';
import { useApi } from '../hooks';

const JOIN_TEXT: Record<JoinBy, { label: string; hint: string }> = {
  assign: { label: '只由管理者指派', hint: '學員不能自己加入（預設）' },
  code: { label: '選課碼', hint: '把選課碼給學員，學員在「我的課程」輸入即可加入' },
  catalog: { label: '公開在課程目錄', hint: '組織內的學員都能在「我的課程」看到並加入' },
};

const pad = (n: number) => String(n).padStart(2, '0');
/** ISO → 本地日期（input[type=date]） */
const toDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * 課程頁的「選課設定」（SD §6.24）：加入方式、是否需審核、開放期間、名額、選課碼。
 * 名額只限制學員自行加入與申請；管理者指派不受限。
 */
export function EnrollmentPolicyCard({ course }: { course: CourseDetailDto }) {
  const me = useMe();
  const p = useApi<EnrollmentPolicyViewDto>(`/api/courses/${course.id}/enrollment-policy`);
  const writable = me.licenseCapabilities.configurationWriteAllowed && course.status !== 'archived';
  const [joinBy, setJoinBy] = useState<JoinBy>('assign');
  const [approval, setApproval] = useState(false);
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [seats, setSeats] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!p.data) return;
    setJoinBy(p.data.joinBy);
    setApproval(p.data.requireApproval);
    setOpens(toDate(p.data.opensAt));
    setCloses(toDate(p.data.closesAt));
    setSeats(p.data.maxSeats === null ? '' : String(p.data.maxSeats));
  }, [p.data]);

  async function save(regenerateCode = false) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('PUT', `/api/courses/${course.id}/enrollment-policy`, {
        joinBy,
        requireApproval: joinBy !== 'assign' && approval,
        opensAt: opens ? new Date(`${opens}T00:00:00`).toISOString() : null,
        closesAt: closes ? new Date(`${closes}T23:59:59`).toISOString() : null,
        maxSeats: seats.trim() ? Number(seats) : null,
        regenerateCode,
      });
      setSaved(true);
      p.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 不支援剪貼簿時使用者可手動選取
    }
  }

  const d = p.data;
  return (
    <section className="card">
      <h2>選課設定</h2>
      <ErrorAlert error={p.error} />
      {!d && p.loading && <Spinner />}
      {d && (
        <>
          {!course.publishedVersion && d.joinBy !== 'assign' && <Notice kind="info">課程尚未發布；發布後學員才能加入。</Notice>}
          {d.joinBy === 'code' && d.code && (
            <div className="enroll-code">
              <span className="muted small">選課碼</span>
              <strong className="enroll-code-value">{d.code}</strong>
              <button type="button" className="btn btn-small" onClick={() => void copy(d.code!)}>
                {copied ? '已複製' : '複製'}
              </button>
              {writable && (
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  disabled={busy}
                  onClick={() => window.confirm('重新產生選課碼？舊的碼會立即失效。') && void save(true)}
                >
                  重新產生
                </button>
              )}
            </div>
          )}
          <p className="muted small">
            目前 {d.seatsUsed} 位學員{d.maxSeats !== null && `（名額 ${d.maxSeats}）`}
            {d.pending > 0 && <>・<strong>{d.pending} 位待審核</strong>（在下方學員名單篩選「待審核」處理）</>}
          </p>
          {saved && <Notice kind="ok">已儲存。</Notice>}
          <ErrorAlert error={error} />
          <fieldset disabled={!writable || busy} className="form-grid">
            <div className="check-group">
              <strong>學員怎麼加入</strong>
              {(Object.keys(JOIN_TEXT) as JoinBy[]).map((k) => (
                <label key={k} className="check">
                  <input type="radio" name={`join-${course.id}`} checked={joinBy === k} onChange={() => setJoinBy(k)} />
                  {JOIN_TEXT[k].label}
                  <span className="muted small">　{JOIN_TEXT[k].hint}</span>
                </label>
              ))}
            </div>
            {joinBy !== 'assign' && (
              <>
                <label className="check">
                  <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
                  需要審核：學員加入後為「待審核」，核准後才能開始學習
                </label>
                <div className="row">
                  <Field label="開放加入（選填）">
                    <input type="date" value={opens} onChange={(e) => setOpens(e.target.value)} />
                  </Field>
                  <Field label="截止（選填）">
                    <input type="date" value={closes} onChange={(e) => setCloses(e.target.value)} />
                  </Field>
                  <Field label="名額（選填）" hint="只限制自行加入與申請">
                    <input type="number" min={1} max={100000} value={seats} onChange={(e) => setSeats(e.target.value)} />
                  </Field>
                </div>
              </>
            )}
            {writable && (
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={() => void save()}>
                  {busy ? '儲存中…' : '儲存'}
                </button>
              </div>
            )}
          </fieldset>
        </>
      )}
    </section>
  );
}

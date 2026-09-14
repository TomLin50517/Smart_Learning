import type { CoachSettingsDto } from '@iac/contracts';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { useApi, useTitle } from '../hooks';

/**
 * /app/org/coach：組織的 AI 教練設定（SD §6.20）。可停用教練、設定課程人員能否讀學員對話；
 * 顯示平台是否已設定 AI 服務與今日用量。AI 服務與金鑰由平台管理員在伺服器設定，不在此頁。
 */
export function CoachSettingsPage() {
  const me = useMe();
  useTitle('AI 教練設定');
  const orgId = me.activeOrganization?.id ?? null;
  const canRead = can(me, 'org.read');
  const canWrite = can(me, 'coach.transcript_policy.write') && me.licenseCapabilities.configurationWriteAllowed;
  const s = useApi<CoachSettingsDto>(canRead && orgId ? `/api/organizations/${orgId}/coach-settings` : null);
  const [enabled, setEnabled] = useState(true);
  const [visibility, setVisibility] = useState<CoachSettingsDto['transcriptVisibility']>('aggregate_only');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!s.data) return;
    setEnabled(s.data.enabled);
    setVisibility(s.data.transcriptVisibility);
  }, [s.data]);

  if (!canRead || !orgId) return <Forbidden />;
  if (!s.data) return s.loading ? <Spinner /> : <ErrorAlert error={s.error} />;
  const d = s.data;
  const dirty = enabled !== d.enabled || visibility !== d.transcriptVisibility;
  const pct = Math.min(100, Math.round((d.tokensUsedToday / d.dailyTokenBudget) * 100));

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('PUT', `/api/organizations/${orgId}/coach-settings`, { enabled, transcriptVisibility: visibility });
      setSaved(true);
      s.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="AI 教練設定" subtitle={me.activeOrganization?.name} />
      <section className="card">
        <h2>目前狀態</h2>
        <ul className="plain-list">
          <li>
            AI 服務：{d.providerConfigured ? <span className="badge badge-active">已設定</span> : <span className="badge badge-grace">尚未設定</span>}
            {!d.providerConfigured && <div className="muted small">由平台管理員在伺服器的環境設定中設定（AI_PROVIDER 與金鑰）；設定前學員會看到「AI 教練暫時無法使用」，其他功能不受影響。</div>}
          </li>
          <li>
            授權：{me.licenseCapabilities.aiCoachAllowed ? <span className="badge badge-active">包含 AI 教練</span> : <span className="badge badge-grace">不包含 AI 教練</span>}
          </li>
          <li>
            今日用量：{d.tokensUsedToday.toLocaleString()}／{d.dailyTokenBudget.toLocaleString()} tokens
            <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="muted small">達到上限後當天暫停問答，隔天自動恢復。</div>
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>設定</h2>
        {saved && <Notice kind="ok">已儲存。</Notice>}
        <ErrorAlert error={error} />
        <fieldset disabled={!canWrite || busy} className="form-grid">
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            啟用 AI 學習教練
          </label>
          <div className="muted small">停用後學員看到「AI 教練暫時無法使用」，課程學習、成績與證書不受影響。</div>
          <div>
            <strong>課程人員能否閱讀學員的教練對話</strong>
            <label className="check">
              <input type="radio" name="visibility" checked={visibility === 'aggregate_only'} onChange={() => setVisibility('aggregate_only')} />
              不可以，只看匿名統計（建議）
            </label>
            <label className="check">
              <input type="radio" name="visibility" checked={visibility === 'course_staff'} onChange={() => setVisibility('course_staff')} />
              可以，授課人員可閱讀逐字稿（每次閱讀都會留下稽核紀錄）
            </label>
            <div className="muted small">只影響之後開始的對話；已開始的對話維持建立當時的設定，不會因為之後修改而變成可讀或不可讀。</div>
          </div>
          {canWrite && (
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
                {busy ? '儲存中…' : '儲存'}
              </button>
            </div>
          )}
        </fieldset>
        {!canWrite && <p className="muted small">您可以檢視設定，但沒有修改權限。</p>}
      </section>
    </>
  );
}

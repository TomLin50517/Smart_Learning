import type { AiConnectionTestDto, OrganizationDto, OrgAiCredentialDto } from '@iac/contracts';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { formatDateTime } from '../format';
import { useApi, useTitle } from '../hooks';

const TEST_TEXT: Record<AiConnectionTestDto['reason'], string> = {
  ok: '連線正常',
  unauthorized: '金鑰無效，或沒有使用權限',
  model_not_available: '這把金鑰不能使用平台設定的模型（AI_MODEL）',
  unreachable: '連不到 AI gateway（請確認 AI_BASE_URL 與網路）',
  quota: '這把金鑰已達限流或預算上限',
  error: '連線測試失敗，請稍後再試',
  provider_unavailable: '平台尚未完成 AI gateway 設定（AI_PROVIDER=litellm、AI_BASE_URL、AI_MODEL、AI_KEY_ENCRYPTION_KEY）',
  organization_key_missing: '這個組織尚未設定金鑰',
};

/**
 * /app/platform/organizations/:orgId/ai-key：平台管理員設定組織的 AI gateway 虛擬金鑰（SD §6.22）。
 * 金鑰加密存放、只能寫入不能讀出；畫面只顯示代號與更新時間。
 */
export function OrgAiKeyPage() {
  const { orgId = '' } = useParams();
  const me = useMe();
  useTitle('AI 金鑰');
  const canWrite = can(me, 'platform.ai_provider.write') && me.licenseCapabilities.configurationWriteAllowed;
  const cred = useApi<OrgAiCredentialDto>(can(me, 'org.read') ? `/api/organizations/${orgId}/ai-credential` : null);
  const orgs = useApi<OrganizationDto[]>(can(me, 'org.read') ? '/api/organizations' : null);
  const [alias, setAlias] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<AiConnectionTestDto | null>(null);

  if (!can(me, 'platform.ai_provider.write')) return <Forbidden />;
  if (!cred.data) return cred.loading ? <Spinner /> : <ErrorAlert error={cred.error} />;
  const c = cred.data;
  const org = orgs.data?.find((o) => o.id === orgId);

  async function run(fn: () => Promise<unknown>, done: string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setTest(null);
    try {
      await fn();
      if (done) setNotice(done);
      cred.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void run(async () => {
      await api('PUT', `/api/organizations/${orgId}/ai-credential`, { alias: alias.trim(), key: key.trim() });
      setKey('');
      setAlias('');
    }, '已儲存。金鑰已加密存放，之後無法再檢視，只能更換。');
  }

  async function runTest() {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      setTest(await api<AiConnectionTestDto>('POST', `/api/organizations/${orgId}/ai-credential/test`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="AI 金鑰" subtitle={org?.name} actions={<Link to="/app/platform/organizations">← 組織管理</Link>} />
      {c.mode === 'platform' && <Notice kind="info">目前平台不是「各組織各一把金鑰」的模式（AI_PROVIDER 不是 litellm），這裡的設定不會生效。</Notice>}
      {!c.encryptionReady && <Notice kind="warn">伺服器尚未設定加密主金鑰（AI_KEY_ENCRYPTION_KEY），無法儲存組織金鑰。</Notice>}
      <ErrorAlert error={error} />
      {notice && <Notice kind="ok">{notice}</Notice>}

      <section className="card">
        <h2>目前狀態</h2>
        {c.configured ? (
          <p>
            <span className="badge badge-active">已設定</span> 代號：<strong>{c.alias}</strong>
            <span className="muted small">
              ・更新於 {formatDateTime(c.updatedAt)}
              {c.updatedBy && `（${c.updatedBy}）`}
            </span>
          </p>
        ) : (
          <p>
            <span className="badge badge-grace">尚未設定</span> <span className="muted small">設定前，這個組織的學員看不到 AI 教練，其他功能不受影響。</span>
          </p>
        )}
        <div className="row">
          <button type="button" className="btn" disabled={busy || !c.configured} onClick={() => void runTest()}>
            測試連線
          </button>
          {canWrite && c.configured && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => window.confirm('移除這個組織的 AI 金鑰？移除後學員看不到 AI 教練。') && void run(() => api('DELETE', `/api/organizations/${orgId}/ai-credential`), '已移除金鑰。')}
            >
              移除金鑰
            </button>
          )}
        </div>
        {test && (
          <Notice kind={test.ok ? 'ok' : 'warn'}>
            {TEST_TEXT[test.reason]}
            {test.latencyMs !== null && `（${test.latencyMs} ms）`}
          </Notice>
        )}
        <p className="muted small">測試只確認金鑰與模型權限，不會產生回答、不耗用額度。</p>
      </section>

      {canWrite && (
        <section className="card">
          <h2>{c.configured ? '更換金鑰' : '設定金鑰'}</h2>
          <form className="form-grid" onSubmit={save}>
            <fieldset disabled={busy || !c.encryptionReady}>
              <Field label="金鑰代號" hint="例如 LiteLLM 上的 key alias；組織管理員看得到代號">
                <input required maxLength={100} value={alias} autoComplete="off" onChange={(e) => setAlias(e.target.value)} />
              </Field>
              <Field label="虛擬金鑰" hint="由 AI gateway 發放；儲存後無法再檢視">
                <input required type="password" minLength={8} maxLength={2048} value={key} autoComplete="new-password" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
              </Field>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={!alias.trim() || key.trim().length < 8}>
                  儲存
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
    </>
  );
}

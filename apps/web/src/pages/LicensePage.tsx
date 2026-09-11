import { CAPABILITY_NAMES, type LicenseCapabilities, type LicenseChallenge, type LicenseInfo } from '@iac/contracts';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe, useSession } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { CAPABILITY_LABELS, formatDate, formatDateTime, LICENSE_STATE_LABELS, LICENSE_TYPE_LABELS } from '../format';
import { useApi, useTitle } from '../hooks';

/** 與伺服器 ActivateBody 的上限一致 */
const LICENSE_FILE_MAX = 20_000;

export function LicensePage() {
  useTitle('系統授權');
  const me = useMe();
  const { reload: reloadSession } = useSession();
  const info = useApi<LicenseInfo>(can(me, 'platform.license.read') ? '/api/platform/license' : null);

  if (!can(me, 'platform.license.read')) return <Forbidden />;

  function activated() {
    info.reload();
    void reloadSession(); // 讓版面上的授權提示與可用功能同步更新
  }

  return (
    <>
      <PageHeader title="系統授權" subtitle="授權以供應方簽章驗證並綁定本主機；可線上或離線啟用。" />
      <ErrorAlert error={info.error} />
      {!info.data ? (
        info.loading && <Spinner />
      ) : (
        <>
          <StatusCard info={info.data} />
          {can(me, 'platform.license.activate') && <Activation info={info.data} onActivated={activated} />}
        </>
      )}
    </>
  );
}

function StatusCard({ info }: { info: LicenseInfo }) {
  const c = info.capabilities;
  const l = info.license;
  const a = info.activation;
  return (
    <div className="card-grid">
      <section className="card">
        <h2>狀態</h2>
        <p>
          <span className={`badge badge-${c.state}`}>{LICENSE_STATE_LABELS[c.state]}</span>
        </p>
        <ul className="cap-list">
          {CAPABILITY_NAMES.map((n) => (
            <li key={n} className={c[n] ? 'yes' : 'no'}>
              <span aria-hidden="true">{c[n] ? '✓' : '✕'}</span> {CAPABILITY_LABELS[n]}
              <span className="sr-only">{c[n] ? '（可用）' : '（不可用）'}</span>
            </li>
          ))}
        </ul>
        <Limits caps={c} />
      </section>

      <section className="card">
        <h2>授權內容</h2>
        {l ? (
          <dl className="kv">
            <dt>授權編號</dt>
            <dd>
              <code>{l.licenseId}</code>
            </dd>
            <dt>客戶</dt>
            <dd>{l.customerId}</dd>
            <dt>版本</dt>
            <dd>{l.edition}</dd>
            <dt>類型</dt>
            <dd>{LICENSE_TYPE_LABELS[l.licenseType]}</dd>
            <dt>簽發日</dt>
            <dd>{formatDate(l.issuedAt)}</dd>
            <dt>到期日</dt>
            <dd>{l.expiresAt ? formatDate(l.expiresAt) : '不到期'}</dd>
            <dt>維護期限</dt>
            <dd>{formatDate(l.maintenanceUntil)}</dd>
          </dl>
        ) : (
          <p className="muted">尚未啟用任何授權。</p>
        )}
      </section>

      <section className="card">
        <h2>本主機</h2>
        <dl className="kv">
          <dt>硬體識別</dt>
          <dd>
            <code className="wrap">{info.fingerprint.current}</code>
          </dd>
          {a && (
            <>
              <dt>啟用方式</dt>
              <dd>{a.mode === 'online' ? '線上' : '離線'}</dd>
              <dt>啟用時間</dt>
              <dd>{formatDateTime(a.activatedAt)}</dd>
              <dt>最後檢查</dt>
              <dd>{formatDateTime(a.lastSeenAt)}</dd>
            </>
          )}
        </dl>
        {info.fingerprint.weak && <Notice kind="warn">此主機的硬體識別資訊不足（例如缺少 machine-id），重新部署後可能需要重新啟用。</Notice>}
        {a?.clockRollbackDetected && <Notice kind="warn">偵測到系統時間曾被回撥。這只會被記錄，不影響授權運作；請確認主機時間同步設定。</Notice>}
      </section>
    </div>
  );
}

function Limits({ caps }: { caps: LicenseCapabilities }) {
  const rows = [
    caps.maxOrganizations !== undefined && ['組織數上限', String(caps.maxOrganizations)],
    caps.maxActiveLearners !== undefined && ['活躍學員上限', String(caps.maxActiveLearners)],
    caps.expiresAt && ['到期', formatDate(caps.expiresAt)],
    caps.maintenanceUntil && ['維護期限', formatDate(caps.maintenanceUntil)],
  ].filter((x): x is string[] => Array.isArray(x));
  if (!rows.length) return null;
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Activation({ info, onActivated }: { info: LicenseInfo; onActivated(): void }) {
  const [done, setDone] = useState<string | null>(null);
  const success = (caps: LicenseCapabilities) => {
    setDone(`授權已啟用，目前狀態：${LICENSE_STATE_LABELS[caps.state]}。`);
    onActivated();
  };
  return (
    <section className="card">
      <h2>{info.license ? '更新授權' : '啟用授權'}</h2>
      {done && <Notice kind="ok">{done}</Notice>}
      <div className="activation">
        {info.onlineActivationAvailable && <OnlineActivation onSuccess={success} />}
        <OfflineActivation onSuccess={success} />
      </div>
    </section>
  );
}

function OnlineActivation({ onSuccess }: { onSuccess(c: LicenseCapabilities): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSuccess(await api<LicenseCapabilities>('POST', '/api/platform/license/activate', { activationCode: code.trim() }));
      setCode('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="step">
      <h3>線上啟用</h3>
      <p className="muted">輸入供應方提供的啟用碼，系統會連線到供應方完成啟用。</p>
      <ErrorAlert error={error} />
      <form className="stack" onSubmit={(e) => void onSubmit(e)}>
        <Field label="啟用碼">
          <input required minLength={4} maxLength={128} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '啟用中…' : '線上啟用'}
          </button>
        </div>
      </form>
    </div>
  );
}

function OfflineActivation({ onSuccess }: { onSuccess(c: LicenseCapabilities): void }) {
  const [challenge, setChallenge] = useState<LicenseChallenge | null>(null);
  const [licenseFile, setLicenseFile] = useState('');
  const [busy, setBusy] = useState<'challenge' | 'activate' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const challengeRef = useRef<HTMLTextAreaElement>(null);

  async function createChallenge() {
    setBusy('challenge');
    setError(null);
    setCopied(false);
    try {
      setChallenge(await api<LicenseChallenge>('POST', '/api/platform/license/challenge'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!challenge) return;
    try {
      await navigator.clipboard.writeText(challenge.challenge);
      setCopied(true);
    } catch {
      challengeRef.current?.select(); // 無剪貼簿權限時改為選取，讓使用者手動複製
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    setFileProblem(null);
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > LICENSE_FILE_MAX) {
      setFileProblem('檔案過大，這不像是授權檔。');
      return;
    }
    setLicenseFile((await f.text()).trim());
  }

  async function activate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy('activate');
    setError(null);
    try {
      onSuccess(await api<LicenseCapabilities>('POST', '/api/platform/license/activate', { licenseFile: licenseFile.trim() }));
      setLicenseFile('');
      setChallenge(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="step">
      <h3>離線啟用</h3>
      <p className="muted">適用於無法連線到網際網路的環境。</p>
      <ErrorAlert error={error} />
      <ol className="steps">
        <li>
          <p>產生啟用請求碼，並以 Email 或隨身碟交給供應方。</p>
          <button className="btn" onClick={() => void createChallenge()} disabled={busy !== null}>
            {busy === 'challenge' ? '產生中…' : challenge ? '重新產生' : '產生啟用請求碼'}
          </button>
          {challenge && (
            <div className="stack challenge">
              <textarea ref={challengeRef} readOnly rows={4} value={challenge.challenge} aria-label="啟用請求碼" spellCheck={false} />
              <div className="row">
                <button className="btn btn-small" onClick={() => void copy()} type="button">
                  {copied ? '已複製' : '複製'}
                </button>
                <span className="muted small">有效至 {formatDateTime(challenge.expiresAt)}</span>
              </div>
              {challenge.weakFingerprint && <Notice kind="warn">此主機的硬體識別資訊不足，授權綁定強度較低。</Notice>}
            </div>
          )}
        </li>
        <li>
          <p>收到供應方回覆的授權檔後，選擇檔案或貼上內容。</p>
          <form className="stack" onSubmit={(e) => void activate(e)}>
            <input type="file" accept=".lic,.jws,.txt,text/plain" onChange={(e) => void onFile(e)} aria-label="選擇授權檔" />
            {fileProblem && <span className="field-error">{fileProblem}</span>}
            <textarea
              rows={4}
              value={licenseFile}
              onChange={(e) => setLicenseFile(e.target.value)}
              placeholder="或在此貼上授權檔內容"
              maxLength={LICENSE_FILE_MAX}
              aria-label="授權檔內容"
              spellCheck={false}
            />
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy !== null || licenseFile.trim().length < 20}>
                {busy === 'activate' ? '驗證中…' : '驗證並啟用'}
              </button>
            </div>
          </form>
        </li>
      </ol>
    </div>
  );
}

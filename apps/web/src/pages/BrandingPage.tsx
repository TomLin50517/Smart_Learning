import {
  BRAND_ASSET_MAX_BYTES,
  contrastWithWhite,
  darkVariant,
  DEFAULT_PLATFORM_NAME,
  isHexColor,
  MIN_BRAND_CONTRAST,
  PLATFORM_NAME_MAX,
  THEME_KEYS,
  THEME_PRESETS,
  type BrandAssetKind,
  type OrgBrandingDto,
  type ThemeKey,
} from '@iac/contracts';
import { useState, type CSSProperties } from 'react';
import { useParams } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe, useSession } from '../auth/session';
import { brandStyle } from '../branding';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { useApi, useTitle } from '../hooks';

/** /app/org/branding（目前組織）與 /app/platform/organizations/:orgId/branding（平台管理員）共用（SD §6.16） */
export function BrandingPage() {
  const me = useMe();
  const { reload: reloadSession } = useSession();
  const { orgId: routeOrgId } = useParams();
  const orgId = routeOrgId ?? me.activeOrganization?.id ?? '';
  const allowed = can(me, 'org.read') && orgId !== '';
  const data = useApi<OrgBrandingDto>(allowed ? `/api/organizations/${orgId}/branding` : null);
  const canWrite = can(me, 'org.settings.write') && me.licenseCapabilities.configurationWriteAllowed;
  useTitle(data.data ? `${data.data.organizationName}・品牌設定` : '品牌設定');

  if (!allowed) return <Forbidden />;
  if (!data.data) return data.loading ? <Spinner /> : <ErrorAlert error={data.error} />;
  const b = data.data;
  const saved = () => {
    data.reload();
    if (orgId === me.activeOrganization?.id) void reloadSession();
  };

  return (
    <>
      <PageHeader title={`${b.organizationName}・品牌設定`} subtitle="登入畫面與系統頂端顯示的名稱、Logo 與配色。只影響這個組織。" />
      {!canWrite && <Notice kind="info">你可以檢視品牌設定，但沒有修改的權限（或目前的授權不允許變更設定）。</Notice>}
      <LoginUrl code={b.organizationCode} />
      <SettingsCard key={JSON.stringify(b.settings)} branding={b} orgId={orgId} canWrite={canWrite} onSaved={saved} />
      <AssetsCard branding={b} orgId={orgId} canWrite={canWrite} onSaved={saved} />
    </>
  );
}

function LoginUrl({ code }: { code: string }) {
  const url = `${window.location.origin}/o/${code}`;
  const [copied, setCopied] = useState(false);
  return (
    <section className="card">
      <h2>組織登入網址</h2>
      <p className="muted small">把這個網址給組織成員：開啟後就是本組織的登入畫面，登入後直接進入本組織。</p>
      <div className="row">
        <code className="wrap">{url}</code>
        <button
          type="button"
          className="btn btn-small"
          onClick={() =>
            void navigator.clipboard.writeText(url).then(
              () => setCopied(true),
              () => window.prompt('複製這個網址：', url),
            )
          }
        >
          {copied ? '已複製' : '複製'}
        </button>
        <a href={url} target="_blank" rel="noreferrer">
          開啟
        </a>
      </div>
    </section>
  );
}

function SettingsCard({ branding: b, orgId, canWrite, onSaved }: { branding: OrgBrandingDto; orgId: string; canWrite: boolean; onSaved(): void }) {
  const [name, setName] = useState(b.settings.platformName ?? '');
  const [choice, setChoice] = useState<ThemeKey | 'custom'>(b.settings.customColor ? 'custom' : b.settings.theme);
  const [custom, setCustom] = useState(b.settings.customColor ?? '#1d4ed8');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const customOk = isHexColor(custom);
  const ratio = customOk ? contrastWithWhite(custom) : 0;
  const colors = choice === 'custom' ? (customOk ? { light: custom.toLowerCase(), dark: darkVariant(custom) } : THEME_PRESETS.academy_blue) : THEME_PRESETS[choice];
  const blocked = choice === 'custom' && (!customOk || ratio < MIN_BRAND_CONTRAST);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('PATCH', `/api/organizations/${orgId}/branding`, {
        platformName: name.trim() || null,
        ...(choice === 'custom' ? { customColor: custom.toLowerCase() } : { theme: choice, customColor: null }),
      });
      setNotice('已儲存。');
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>名稱與配色</h2>
      {notice && <Notice kind="ok">{notice}</Notice>}
      <ErrorAlert error={error} />
      <fieldset disabled={!canWrite || busy} className="stack">
        <Field label="平台名稱" hint={`顯示在登入畫面、頂端列與瀏覽器分頁；留空則使用「${DEFAULT_PLATFORM_NAME}」`}>
          <input maxLength={PLATFORM_NAME_MAX} placeholder={DEFAULT_PLATFORM_NAME} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div>
          <p className="field-label">配色</p>
          <div className="swatches" role="radiogroup" aria-label="配色">
            {THEME_KEYS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={choice === k} className="swatch" style={{ '--sw': THEME_PRESETS[k].light } as CSSProperties} onClick={() => setChoice(k)}>
                <span className="swatch-chip" aria-hidden="true" />
                {THEME_PRESETS[k].label}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={choice === 'custom'} className="swatch" style={{ '--sw': customOk ? custom : '#888888' } as CSSProperties} onClick={() => setChoice('custom')}>
              <span className="swatch-chip" aria-hidden="true" />
              自訂主色
            </button>
          </div>
        </div>
        {choice === 'custom' && (
          <div className="row">
            <input type="color" aria-label="選擇顏色" value={customOk ? custom : '#1d4ed8'} onChange={(e) => setCustom(e.target.value)} />
            <input aria-label="色碼" maxLength={7} value={custom} onChange={(e) => setCustom(e.target.value.trim())} style={{ width: '8em' }} />
            {customOk && (
              <span className={ratio < MIN_BRAND_CONTRAST ? 'text-danger small' : 'muted small'}>
                與白字的對比度 {ratio.toFixed(2)}
                {ratio < MIN_BRAND_CONTRAST ? `，需達 ${MIN_BRAND_CONTRAST} 以上（顏色太淺，按鈕上的字會看不清楚）` : '（清楚易讀）'}
              </span>
            )}
          </div>
        )}
        <Preview colors={colors} name={name.trim() || DEFAULT_PLATFORM_NAME} logoUrl={b.logoUrl} />
        <div className="form-actions">
          <button type="button" className="btn btn-primary" disabled={blocked} onClick={() => void save()}>
            {busy ? '儲存中…' : '儲存'}
          </button>
        </div>
      </fieldset>
    </section>
  );
}

/** 預覽：頂端列、主要按鈕與連結；深色模式會自動換成較亮的版本 */
function Preview({ colors, name, logoUrl }: { colors: { light: string; dark: string }; name: string; logoUrl: string | null }) {
  return (
    <div className="brand-preview" data-brand="" style={brandStyle({ colors })} aria-label="預覽">
      <div className="brand-preview-bar">
        {logoUrl ? <img className="brand-logo" src={logoUrl} alt="" /> : <img src="/favicon.svg" alt="" width={24} height={24} />}
        {!logoUrl && <strong>{name}</strong>}
      </div>
      <div className="brand-preview-body">
        <button type="button" className="btn btn-primary" tabIndex={-1}>
          開始學習
        </button>
        <span className="badge badge-active">學習中</span>
        <a href="#preview" onClick={(e) => e.preventDefault()} tabIndex={-1}>
          連結文字
        </a>
      </div>
    </div>
  );
}

function AssetsCard({ branding: b, orgId, canWrite, onSaved }: { branding: OrgBrandingDto; orgId: string; canWrite: boolean; onSaved(): void }) {
  return (
    <section className="card">
      <h2>Logo 與小圖示</h2>
      <p className="muted small">PNG、JPG 或 WebP，每張 512 KB 以內。為了安全不接受 SVG。建議使用透明背景；深色模式下 Logo 會放在白色底上。</p>
      <div className="stack">
        <AssetUpload kind="logo" label="Logo（橫式，建議高度 64 像素以上）" url={b.logoUrl} orgId={orgId} canWrite={canWrite} onSaved={onSaved} />
        <AssetUpload kind="icon" label="小圖示（方形，用於瀏覽器分頁，建議 64×64 以上）" url={b.iconUrl} orgId={orgId} canWrite={canWrite} onSaved={onSaved} />
      </div>
    </section>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

function AssetUpload(props: { kind: BrandAssetKind; label: string; url: string | null; orgId: string; canWrite: boolean; onSaved(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    setLocalError(null);
    if (file.size > BRAND_ASSET_MAX_BYTES) return setLocalError(`檔案 ${Math.ceil(file.size / 1024)} KB，超過 512 KB。`);
    setBusy(true);
    try {
      await api('PUT', `/api/organizations/${props.orgId}/branding/${props.kind}`, { dataBase64: await readBase64(file) });
      props.onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('移除這張圖片？')) return;
    setBusy(true);
    setError(null);
    try {
      await api('DELETE', `/api/organizations/${props.orgId}/branding/${props.kind}`);
      props.onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="field-label">{props.label}</p>
      {props.url ? (
        <div className="asset-tiles">
          <div className="asset-tile light">
            <img src={props.url} alt="淺色背景預覽" />
          </div>
          <div className="asset-tile dark">
            <img src={props.url} alt="深色背景預覽" />
          </div>
        </div>
      ) : (
        <p className="muted small">尚未上傳。</p>
      )}
      {localError && (
        <div className="alert alert-error" role="alert">
          {localError}
        </div>
      )}
      <ErrorAlert error={error} />
      {props.canWrite && (
        <div className="row">
          <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`上傳${props.label}`} disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
          {props.url && (
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove()}>
              移除
            </button>
          )}
          {busy && <span className="muted small">處理中…</span>}
        </div>
      )}
    </div>
  );
}

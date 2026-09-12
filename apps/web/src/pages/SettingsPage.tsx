import { PLATFORM_SETTINGS, type PlatformSettingDto, type PlatformSettingKey } from '@iac/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { formatDateTime } from '../format';
import { useApi, useTitle } from '../hooks';

const MB = 1_048_576;

/** 目錄定義的單位 → 畫面上的數值（bytes 以 MB 顯示） */
const toDisplay = (key: PlatformSettingKey, v: number) => (PLATFORM_SETTINGS[key].unit === 'bytes' ? v / MB : v);
const fromDisplay = (key: PlatformSettingKey, v: number) => (PLATFORM_SETTINGS[key].unit === 'bytes' ? Math.round(v * MB) : v);
const unitLabel = (key: PlatformSettingKey) => (PLATFORM_SETTINGS[key].unit === 'bytes' ? 'MB' : '');

export function SettingsPage() {
  useTitle('平台設定');
  const me = useMe();
  const list = useApi<PlatformSettingDto[]>(can(me, 'platform.settings.read') ? '/api/platform/settings' : null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (list.data) setDraft(Object.fromEntries(list.data.map((s) => [s.key, String(toDisplay(s.key, s.value))])));
  }, [list.data]);

  if (!can(me, 'platform.settings.read')) return <Forbidden />;
  const writable = can(me, 'platform.settings.write') && me.licenseCapabilities.configurationWriteAllowed;

  async function save(patch: Partial<Record<PlatformSettingKey, number | null>>, message: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api('PUT', '/api/platform/settings', patch);
      setDone(message);
      list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!list.data) return;
    const patch: Partial<Record<PlatformSettingKey, number>> = {};
    for (const s of list.data) {
      const n = Number(draft[s.key]);
      if (!Number.isFinite(n)) continue;
      const v = fromDisplay(s.key, n);
      if (v !== s.value) patch[s.key] = v;
    }
    if (Object.keys(patch).length === 0) {
      setDone('沒有變更。');
      return;
    }
    void save(patch, '設定已儲存。');
  }

  return (
    <>
      <PageHeader title="平台設定" subtitle="適用於整個平台的參數。每次變更都會記錄變更前後的值。" />
      {!writable && can(me, 'platform.settings.write') && <Notice kind="warn">目前的授權不允許變更設定，僅供檢視。</Notice>}
      {done && <Notice kind="ok">{done}</Notice>}
      <ErrorAlert error={list.error ?? error} />
      {!list.data ? (
        list.loading && <Spinner />
      ) : (
        <form onSubmit={onSubmit}>
          <fieldset disabled={!writable || busy}>
            {list.data.map((s) => {
              const def = PLATFORM_SETTINGS[s.key];
              return (
                <section className="card" key={s.key}>
                  <div className="setting-head">
                    <h2>{def.label}</h2>
                    <code className="muted small">{s.key}</code>
                  </div>
                  <p className="muted">{def.description}</p>
                  <div className="row">
                    <label className="field setting-input">
                      <span className="sr-only">{def.label}</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={toDisplay(s.key, def.min)}
                        max={toDisplay(s.key, def.max)}
                        step={1}
                        value={draft[s.key] ?? ''}
                        onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                      />
                    </label>
                    <span className="muted">{unitLabel(s.key)}</span>
                    {s.isDefault ? (
                      <span className="badge">預設值</span>
                    ) : (
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => void save({ [s.key]: null }, `「${def.label}」已恢復預設值。`)}>
                        恢復預設（{toDisplay(s.key, s.default)} {unitLabel(s.key)}）
                      </button>
                    )}
                  </div>
                  <p className="muted small">
                    範圍 {toDisplay(s.key, def.min)}～{toDisplay(s.key, def.max)} {unitLabel(s.key)}．自 {def.effectiveFrom} 起生效
                    {s.updatedAt && `．最後由 ${s.updatedBy?.displayName ?? '—'} 於 ${formatDateTime(s.updatedAt)} 修改`}
                  </p>
                </section>
              );
            })}
            {writable && (
              <div className="form-actions">
                <button type="submit" className="btn btn-primary">
                  {busy ? '儲存中…' : '儲存變更'}
                </button>
              </div>
            )}
          </fieldset>
        </form>
      )}
    </>
  );
}

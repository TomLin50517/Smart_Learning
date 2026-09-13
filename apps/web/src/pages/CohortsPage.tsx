import { COHORT_NAME_MAX, COHORT_TERM_MAX, type CohortDto } from '@iac/contracts';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, PageHeader } from '../components/ui';
import { formatDate } from '../format';
import { useApi, useTitle } from '../hooks';

/** /app/org/cohorts：班級管理（目前組織；SD §6.15） */
export function CohortsPage() {
  useTitle('班級管理');
  const me = useMe();
  const orgId = me.activeOrganization?.id ?? '';
  const allowed = can(me, 'org.user.read') && orgId !== '';
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const list = useApi<CohortDto[]>(allowed ? `/api/organizations/${orgId}/cohorts?status=${status}` : null);
  const canWrite = can(me, 'org.user.write') && me.licenseCapabilities.configurationWriteAllowed;
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (!allowed) return <Forbidden />;

  async function setArchived(c: CohortDto, archive: boolean) {
    if (archive && !window.confirm(`封存「${c.name}」？\n\n封存後不再是成員的「目前班級」，也不能再整班加入課程；過去選課紀錄上的班級名稱不會改變。之後可以恢復。`)) return;
    setError(null);
    try {
      await api('POST', `/api/organizations/${orgId}/cohorts/${c.id}/${archive ? 'archive' : 'restore'}`);
      list.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <PageHeader
        title="班級管理"
        subtitle="每學年或每期建立新的班級並把成員放進去；舊班級封存後，過去的選課紀錄仍顯示當時的班級。調整班級不需要重新邀請成員。"
      />
      {canWrite && (
        <CreateCohort
          orgId={orgId}
          onCreated={() => {
            setStatus('active');
            list.reload();
          }}
        />
      )}
      <section className="card">
        <div className="toolbar">
          <select aria-label="班級狀態" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'archived')}>
            <option value="active">使用中</option>
            <option value="archived">已封存</option>
          </select>
        </div>
        <ErrorAlert error={error} />
        <ErrorAlert error={list.error} />
        {list.data && list.data.length === 0 ? (
          <p className="muted">{status === 'active' ? '尚未建立班級。' : '沒有封存的班級。'}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>班級</th>
                  <th>學年／期別</th>
                  <th>成員</th>
                  <th>{status === 'active' ? '建立日期' : '封存日期'}</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((c) =>
                  editing === c.id ? (
                    <tr key={c.id} className="row-editor">
                      <td colSpan={5}>
                        <EditCohort
                          orgId={orgId}
                          cohort={c}
                          onDone={() => {
                            setEditing(null);
                            list.reload();
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.term ?? <span className="muted">—</span>}</td>
                      <td>
                        <Link to={`/app/org/users?cohort=${c.id}`}>{c.memberCount} 人</Link>
                      </td>
                      <td>{formatDate(status === 'active' ? c.createdAt : c.archivedAt)}</td>
                      <td className="actions">
                        <div className="row-actions">
                          {canWrite && c.status === 'active' && (
                            <button type="button" className="btn btn-small" onClick={() => setEditing(c.id)}>
                              修改
                            </button>
                          )}
                          {canWrite && (
                            <button type="button" className={`btn btn-small${c.status === 'active' ? ' btn-danger' : ''}`} onClick={() => void setArchived(c, c.status === 'active')}>
                              {c.status === 'active' ? '封存' : '恢復'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">把成員放進班級：在「成員管理」逐一編輯，或用批次匯入的「班級」欄一次處理。</p>
      </section>
    </>
  );
}

function CreateCohort({ orgId, onCreated }: { orgId: string; onCreated(): void }) {
  const [name, setName] = useState('');
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/organizations/${orgId}/cohorts`, { name: name.trim(), ...(term.trim() && { term: term.trim() }) });
      setName('');
      setTerm('');
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>新增班級</h2>
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy}>
          <Field label="班級名稱" hint="例：113 三年二班、第 5 期。使用中的班級名稱不可重複">
            <input required maxLength={COHORT_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="學年／期別（選填）" hint="例：113 學年">
            <input maxLength={COHORT_TERM_MAX} value={term} onChange={(e) => setTerm(e.target.value)} />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              {busy ? '新增中…' : '新增班級'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function EditCohort(props: { orgId: string; cohort: CohortDto; onDone(): void; onCancel(): void }) {
  const [name, setName] = useState(props.cohort.name);
  const [term, setTerm] = useState(props.cohort.term ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('PATCH', `/api/organizations/${props.orgId}/cohorts/${props.cohort.id}`, { name: name.trim(), term: term.trim() || null });
      props.onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor">
      <ErrorAlert error={error} />
      <div className="form-grid">
        <Field label="班級名稱">
          <input required maxLength={COHORT_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="學年／期別">
          <input maxLength={COHORT_TERM_MAX} value={term} onChange={(e) => setTerm(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? '儲存中…' : '儲存'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={props.onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

import { IMPORT_MAX_ROWS, type ImportAction, type ImportReportDto, type LearnerImportRow, type MemberImportRow } from '@iac/contracts';
import { useState } from 'react';
import { api } from '../api/client';
import { ErrorAlert, Field, Notice } from '../components/ui';
import { csvTemplate, parseCsv, toLearnerRows, toMemberRows } from '../csv';

const ACTION_TEXT: Record<ImportAction, string> = {
  account_created: '建立帳號並寄送邀請',
  member_added: '加入組織',
  enrolled: '加入課程',
  course_role_granted: '指派課程角色',
};

const ISSUE_TEXT: Record<string, string> = {
  invalid_email: 'Email 格式不正確',
  name_required: '新成員需要填姓名',
  invalid_role: '角色無法辨識（可用：學員、講師、課程管理員、組織管理員、稽核人員）',
  course_required: '講師／課程管理員需要填課程代碼',
  course_not_applicable: '組織管理員／稽核人員不需要課程代碼',
  course_not_found: '找不到這個課程代碼',
  course_not_published: '課程尚未發布',
  course_archived: '課程已封存',
  member_disabled: '此成員在本組織已停用',
  user_not_active: '此帳號已被停用',
  not_in_organization: '尚非本組織成員（您沒有新增成員的權限）',
  permission_denied: '您沒有執行此動作的權限',
  duplicate_row: '與前面的列重複',
  already_member: '已是成員',
  already_enrolled: '已在課程中',
  already_assigned: '已是該課程的人員',
};

/**
 * 批次匯入卡片（SD §6.11）：貼上或上傳 → 預覽（伺服器完整執行後復原）→ 確認後才寫入。
 * kind=members：成員管理頁（Email、姓名、角色、課程代碼）；kind=learners：課程頁（Email、姓名）。
 */
export function BulkImportCard(props: { kind: 'members' | 'learners'; endpoint: string; onDone(): void }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<(MemberImportRow | LearnerImportRow)[] | null>(null);
  const [report, setReport] = useState<ImportReportDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const reset = (t: string) => {
    setText(t);
    setRows(null);
    setReport(null);
    setError(null);
    setLocalError(null);
  };

  async function send(dryRun: boolean, list: (MemberImportRow | LearnerImportRow)[]) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ImportReportDto>('POST', props.endpoint, { dryRun, rows: list });
      setReport(r);
      if (!dryRun) props.onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function preview() {
    const table = parseCsv(text);
    const list = props.kind === 'members' ? toMemberRows(table) : toLearnerRows(table);
    if (!list.length) return setLocalError('沒有讀到任何資料列。');
    if (list.length > IMPORT_MAX_ROWS) return setLocalError(`一次最多 ${IMPORT_MAX_ROWS} 列，目前有 ${list.length} 列，請分批匯入。`);
    setLocalError(null);
    setRows(list);
    void send(true, list);
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([csvTemplate(props.kind)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = props.kind === 'members' ? '成員匯入範本.csv' : '學員匯入範本.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const s = report?.summary;
  const canConfirm = !!report?.dryRun && !!rows && s!.ok > 0 && report.license.exceededBy === 0;

  return (
    <div className="bulk-import">
      <p className="muted small">
        {props.kind === 'members'
          ? '欄位：Email、姓名、角色（選填，預設學員）、課程代碼（選填：學員會加入該課、講師會指派為該課講師）。'
          : '欄位：Email、姓名（尚非本組織成員者需要填姓名，會建立帳號並寄送邀請）。'}
        可從 Excel 直接複製貼上，或上傳 CSV。{' '}
        <button type="button" className="btn btn-small btn-ghost" onClick={downloadTemplate}>
          下載範本
        </button>
      </p>
      <Field label="資料">
        <textarea rows={6} spellCheck={false} value={text} onChange={(e) => reset(e.target.value)} placeholder="Email,姓名,角色,課程代碼" />
      </Field>
      <div className="row">
        <input type="file" accept=".csv,.txt,text/csv,text/plain" aria-label="上傳 CSV" onChange={(e) => void e.target.files?.[0]?.text().then(reset)} />
        <button type="button" className="btn" onClick={preview} disabled={busy || !text.trim()}>
          {busy && report === null ? '檢查中…' : '預覽'}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => rows && void send(false, rows)} disabled={busy || !canConfirm}>
          {busy && report?.dryRun ? '匯入中…' : `確認匯入${s ? `（${s.ok} 列）` : ''}`}
        </button>
      </div>
      {localError && (
        <div className="alert alert-error" role="alert">
          {localError}
        </div>
      )}
      <ErrorAlert error={error} />

      {report && s && (
        <>
          {report.dryRun ? (
            <Notice kind="info">
              預覽（尚未寫入）：共 {s.total} 列——可處理 {s.ok}、略過 {s.skipped}、錯誤 {s.errors}。
              {s.accountsCreated > 0 && ` 將建立 ${s.accountsCreated} 個帳號並寄送邀請。`}
              錯誤的列不會匯入，其餘確認後才會寫入。
            </Notice>
          ) : (
            <Notice kind="ok">
              匯入完成：新增成員 {s.membersAdded}、加入課程 {s.enrollments}、指派課程角色 {s.courseRoles}、寄出邀請 {s.invitationsSent} 封（略過 {s.skipped}、錯誤 {s.errors}）。
            </Notice>
          )}
          {report.license.exceededBy > 0 && (
            <Notice kind="warn">
              超過授權的學員人數上限 {report.license.exceededBy} 人（上限 {report.license.maxActiveLearners}），無法匯入。請減少名單或聯絡管理員。
            </Notice>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>列</th>
                  <th>Email</th>
                  <th>結果</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td>{r.email || <span className="muted">（空白）</span>}</td>
                    <td>
                      {r.outcome === 'ok' ? (
                        <span>{r.actions.map((a) => ACTION_TEXT[a]).join('、')}</span>
                      ) : (
                        <span className={r.outcome === 'error' ? 'text-danger' : 'muted'}>
                          {r.outcome === 'error' ? '錯誤：' : '略過：'}
                          {r.issue ? (ISSUE_TEXT[r.issue] ?? r.issue) : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

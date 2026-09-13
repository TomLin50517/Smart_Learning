import { PUBLISH_CHECKS, type CourseVersionDetailDto, type PublishCheck, type ValidationIssueDto, type ValidationReportDto } from '@iac/contracts';
import { useState } from 'react';
import { api } from '../api/client';
import { humanizeRulePath, humanizeStructurePath } from '../api/errors';
import { ErrorAlert, Notice } from '../components/ui';

const CHECK_LABELS: Record<PublishCheck, string> = {
  C1: '學習路徑',
  C2: '完成條件與先修條件',
  C3: '課程教材',
  C4: 'AI 教練設定',
  C5: '互動活動設定',
};

/** 問題所在位置：課程結構、完成條件或其他區塊 */
function where(i: ValidationIssueDto): string {
  if (i.path === 'coachPolicy') return 'AI 教練設定';
  if (i.path.startsWith('knowledgeBindings')) return '教材綁定';
  return humanizeStructurePath(i.path) ?? humanizeRulePath(i.path) ?? i.path;
}

/**
 * 版本編輯頁的「發布」卡片（SA SEQ-01）：先檢查、預覽問題，全部通過且確認後才發布。
 * 伺服器在發布的交易內會再檢查一次，這裡的預覽只是為了讓作者先看到問題。
 */
export function PublishPanel(props: {
  version: CourseVersionDetailDto;
  canValidate: boolean;
  canPublish: boolean;
  /** 有未儲存變更等原因時不可發布 */
  blocked: string | null;
  onPublished(v: CourseVersionDetailDto): void;
}) {
  const v = props.version;
  const [report, setReport] = useState<ValidationReportDto | null>(null);
  const [busy, setBusy] = useState<'validate' | 'publish' | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function runValidate(): Promise<ValidationReportDto | null> {
    setBusy('validate');
    setError(null);
    try {
      const r = await api<ValidationReportDto>('POST', `/api/course-versions/${v.id}/validate`);
      setReport(r);
      return r;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    const r = await runValidate();
    if (!r?.valid) return;
    const ok = window.confirm(
      `發布 v${v.versionNo}「${v.title}」？\n\n` +
        '・發布後內容不可修改，要調整需複製為新版本。\n' +
        '・目前已發布的版本（若有）會轉為「已被取代」；已在學習的學員繼續使用原版本。' +
        (r.warnings.length ? `\n\n另有 ${r.warnings.length} 項提醒，請確認可以接受。` : ''),
    );
    if (!ok) return;
    setBusy('publish');
    setError(null);
    try {
      const published = await api<CourseVersionDetailDto>('POST', `/api/course-versions/${v.id}/publish`);
      setReport(null);
      props.onPublished(published);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="row structure-head">
        <h2 className="grow">發布</h2>
        {props.canValidate && (
          <button type="button" className="btn" onClick={() => void runValidate()} disabled={busy !== null}>
            {busy === 'validate' ? '檢查中…' : '發布前檢查'}
          </button>
        )}
        {props.canPublish && (
          <button type="button" className="btn btn-primary" onClick={() => void publish()} disabled={busy !== null || props.blocked !== null}>
            {busy === 'publish' ? '發布中…' : '發布此版本'}
          </button>
        )}
      </div>
      <p className="muted small">發布前會檢查：學習路徑、完成條件與先修條件、課程教材、AI 教練設定、互動活動設定。全部通過才能發布。</p>
      {props.blocked && <Notice kind="warn">{props.blocked}</Notice>}
      <ErrorAlert error={error} />
      {report && <Report report={report} />}
    </section>
  );
}

function Report({ report }: { report: ValidationReportDto }) {
  if (report.valid && report.warnings.length === 0) return <Notice kind="ok">全部檢查通過，可以發布。</Notice>;
  return (
    <>
      {report.valid ? <Notice kind="ok">檢查通過，可以發布；另有以下提醒。</Notice> : <Notice kind="warn">有 {report.errors.length} 個問題需要修正才能發布。</Notice>}
      {PUBLISH_CHECKS.map((c) => {
        const errors = report.errors.filter((i) => i.check === c);
        const warnings = report.warnings.filter((i) => i.check === c);
        if (!errors.length && !warnings.length) return null;
        return (
          <div key={c} className="check-group">
            <h4>
              {c}・{CHECK_LABELS[c]}
            </h4>
            <ul className="issue-list">
              {errors.map((i, k) => (
                <li key={`e${k}`}>
                  <span className="badge badge-blocked">需修正</span> <span className="muted small">{where(i)}</span>
                  <div>{i.message}</div>
                </li>
              ))}
              {warnings.map((i, k) => (
                <li key={`w${k}`}>
                  <span className="badge badge-grace">提醒</span> <span className="muted small">{where(i)}</span>
                  <div>{i.message}</div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

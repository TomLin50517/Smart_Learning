import { COACH_TEXT, type CitationSourceDto, type CoachAnswerStatus, type CoachCitationDto } from '@iac/contracts';
import { useEffect } from 'react';
import { ErrorAlert, Spinner } from '../components/ui';
import { useApi } from '../hooks';

/** 一則教練回答（學員抽屜與教師測試共用） */
export interface AnswerLike {
  status: CoachAnswerStatus;
  answer: string;
  citations: CoachCitationDto[];
  followUpQuestions: string[];
}

const citeLabel = (c: CoachCitationDto) => [c.title, c.pageNo !== null ? `第 ${c.pageNo} 頁` : null, c.sectionPath].filter(Boolean).join('・');

/** 回答文字中的 [c1] 換成引用標記；沒有 onOpen（課程人員讀逐字稿）時只顯示、不可開啟 */
function AnswerText({ text, citations, onOpen }: { text: string; citations: CoachCitationDto[]; onOpen: ((c: CoachCitationDto) => void) | undefined }) {
  const byRef = new Map(citations.map((c) => [c.citationId, c]));
  return (
    <p className="coach-answer pre-line">
      {text.split(/(\[c\d{1,2}\])/g).map((part, i) => {
        const ref = /^\[(c\d{1,2})\]$/.exec(part)?.[1];
        const c = ref ? byRef.get(ref) : undefined;
        if (!c) return <span key={i}>{part}</span>;
        return onOpen ? (
          <button key={i} type="button" className="cite-chip" title={citeLabel(c)} aria-label={`出處 ${ref!.slice(1)}：${citeLabel(c)}`} onClick={() => onOpen(c)}>
            {ref!.slice(1)}
          </button>
        ) : (
          <sup key={i} className="cite-chip" title={citeLabel(c)}>
            {ref!.slice(1)}
          </sup>
        );
      })}
    </p>
  );
}

export function AnswerView({ a, onOpen, onFollowUp, busy }: { a: AnswerLike; onOpen?: (c: CoachCitationDto) => void; onFollowUp?: ((q: string) => void) | undefined; busy?: boolean }) {
  const notice = a.status === 'fallback' || a.status === 'insufficient_evidence' || a.status === 'out_of_scope';
  return (
    <div className={`chat-assistant${notice ? ' chat-notice' : ''}`}>
      <AnswerText text={a.answer} citations={a.citations} onOpen={onOpen} />
      {a.citations.length > 0 && (
        <ol className="coach-sources" aria-label="出處">
          {a.citations.map((c) => (
            <li key={c.id}>
              {onOpen ? (
                <button type="button" className="link-button" onClick={() => onOpen(c)}>
                  {citeLabel(c)}
                </button>
              ) : (
                citeLabel(c)
              )}
              {c.quote && <div className="muted small">「{c.quote}」</div>}
            </li>
          ))}
        </ol>
      )}
      {onFollowUp && a.followUpQuestions.length > 0 && (
        <div className="follow-ups">
          {a.followUpQuestions.map((q) => (
            <button key={q} type="button" className="btn btn-small" disabled={busy} onClick={() => onFollowUp(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      <div className="muted small">{COACH_TEXT.disclaimer}</div>
    </div>
  );
}

/** 引用原文：每次開啟都由伺服器重新檢查權限；被引用的段落以標示顯示 */
export function SourceViewer({ citationId, onClose }: { citationId: string; onClose(): void }) {
  const src = useApi<CitationSourceDto>(`/api/coach/citations/${citationId}/source`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const s = src.data;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="引用的原文" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong className="grow">{s ? [s.title, s.pageNo !== null ? `第 ${s.pageNo} 頁` : null, s.sectionPath].filter(Boolean).join('・') : '原文'}</strong>
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose} autoFocus>
            關閉
          </button>
        </div>
        <div className="modal-body">
          <ErrorAlert error={src.error} />
          {!s && src.loading && <Spinner />}
          {s && (
            <pre className="doc-preview source-text">
              {s.truncatedBefore && '…'}
              {s.text.slice(0, s.highlightStart)}
              <mark>{s.text.slice(s.highlightStart, s.highlightEnd)}</mark>
              {s.text.slice(s.highlightEnd)}
              {s.truncatedAfter && '…'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

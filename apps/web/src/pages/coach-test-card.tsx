import { COACH_QUESTION_MAX, type CoachAnswerDto } from '@iac/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useMe } from '../auth/session';
import { ErrorAlert, Notice } from '../components/ui';
import { AnswerView, SourceViewer } from './coach-view';

/**
 * 教師測試模式（SD §6.20）：在課程版本編輯頁以學員的角度試問，確認教練會怎麼回答、引用哪些教材。
 * 用已儲存的教練設定與已處理完成的教材；測試對話不綁學員、不列入統計。
 */
export function CoachTestCard({ versionId }: { versionId: string }) {
  const me = useMe();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<{ q: string; a: CoachAnswerDto }[]>([]);
  const [source, setSource] = useState<string | null>(null);

  async function ask(q: string) {
    const text = q.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const a = await api<CoachAnswerDto>('POST', `/api/course-versions/${versionId}/coach/test`, { content: text, ...(conversationId && { conversationId }) });
      setConversationId(a.conversationId);
      setTurns((t) => [...t, { q: text, a }]);
      setQuestion('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void ask(question);
  }

  return (
    <section className="card">
      <h2>AI 教練測試</h2>
      <p className="muted small">以學員的角度提問，確認教練會怎麼回答、引用哪些教材。使用已儲存的教練設定與已處理完成的教材；測試對話不會列入學員資料或統計。</p>
      {!me.licenseCapabilities.aiCoachAllowed && <Notice kind="info">目前的授權不包含 AI 教練，無法測試。</Notice>}
      {turns.map((t, i) => (
        <div key={i} className="coach-test-turn">
          <div className="chat-user">{t.q}</div>
          <AnswerView a={t.a} busy={busy} onOpen={(c) => setSource(c.id)} onFollowUp={(q) => void ask(q)} />
        </div>
      ))}
      <ErrorAlert error={error} />
      <form className="row" onSubmit={submit}>
        <input
          className="grow"
          maxLength={COACH_QUESTION_MAX}
          value={question}
          placeholder="例如：發酵溫度要多少？"
          aria-label="測試問題"
          disabled={busy || !me.licenseCapabilities.aiCoachAllowed}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="btn" disabled={busy || !question.trim() || !me.licenseCapabilities.aiCoachAllowed}>
          {busy ? '回答中…' : '提問'}
        </button>
        {turns.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setTurns([]);
              setConversationId(null);
            }}
          >
            重新開始
          </button>
        )}
      </form>
      {source && <SourceViewer citationId={source} onClose={() => setSource(null)} />}
    </section>
  );
}

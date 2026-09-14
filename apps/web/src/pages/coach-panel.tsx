import { COACH_QUESTION_MAX, COACH_TEXT, type CoachAnswerDto, type CoachAvailabilityDto, type CoachConversationDto, type CoachStreamEvent, type CoachUnavailableReason } from '@iac/contracts';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { askCoach } from '../coach-stream';
import { ErrorAlert, Spinner } from '../components/ui';
import { useApi } from '../hooks';
import { AnswerView, SourceViewer, type AnswerLike } from './coach-view';

const REASON_TEXT: Record<CoachUnavailableReason, string> = {
  provider_unavailable: '平台尚未設定 AI 服務。',
  search_unavailable: '教材搜尋服務尚未啟用。',
  disabled_by_organization: '你的組織已停用 AI 教練。',
  not_licensed: '目前的授權不包含 AI 教練。',
  enrollment_inactive: '目前的選課狀態無法使用 AI 教練。',
};

const STAGE_TEXT = { retrieving: '正在查找教材…', composing: '正在撰寫回答…', validating: '正在檢查回答與出處…' } as const;

type Item = { role: 'user'; text: string } | { role: 'assistant'; answer: AnswerLike };

interface Pending {
  stage: keyof typeof STAGE_TEXT;
  sources: { title: string; pageNo: number | null; sectionPath: string | null }[];
  text: string;
}

function reduce(p: Pending, e: CoachStreamEvent): Pending {
  switch (e.event) {
    case 'stage':
      return { ...p, stage: e.data.stage };
    case 'sources':
      return { ...p, sources: e.data.sources };
    case 'token':
      return { ...p, text: p.text + e.data.delta };
    default:
      return p;
  }
}

function fromConversation(c: CoachConversationDto): Item[] {
  return c.messages.map((m) =>
    m.role === 'user'
      ? { role: 'user', text: m.content }
      : { role: 'assistant', answer: { status: m.status ?? 'answered', answer: m.content, citations: m.citations, followUpQuestions: m.followUpQuestions } },
  );
}

/**
 * 學習頁的「問教練」（SD §6.20）：右下角按鈕開啟側邊對話。依目前課節的活動建立對話（每個活動一段），
 * 先顯示找到的教材，驗證通過後才逐字出現回答；出處可點開原文。無法使用時說明原因，課程學習不受影響。
 */
interface ResultRequest {
  attemptId: string;
  nonce: number;
}

export function CoachPanel(props: { enrollmentId: string; activityId: string | undefined; contextTitle: string | null; resultRequest?: ResultRequest | null }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  // 結果旁按「請 AI 教練看看」→ 打開對話
  useEffect(() => {
    if (props.resultRequest) setOpen(true);
  }, [props.resultRequest]);
  if (!can(me, 'coach.conversation.read_self')) return null;
  return (
    <>
      {!open && (
        <button type="button" className="btn coach-fab" onClick={() => setOpen(true)}>
          問教練
        </button>
      )}
      {open && (
        <CoachDrawer
          key={props.activityId ?? 'course'}
          enrollmentId={props.enrollmentId}
          activityId={props.activityId}
          contextTitle={props.contextTitle}
          resultRequest={props.resultRequest ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CoachDrawer(props: { enrollmentId: string; activityId: string | undefined; contextTitle: string | null; resultRequest: ResultRequest | null; onClose(): void }) {
  const me = useMe();
  const licensed = me.licenseCapabilities.aiCoachAllowed;
  const av = useApi<CoachAvailabilityDto>(`/api/enrollments/${props.enrollmentId}/coach`);
  const existing = av.data?.conversations.find((c) => c.activityId === (props.activityId ?? null))?.id ?? null;
  const [created, setCreated] = useState<string | null>(null);
  const convId = created ?? existing;
  const conv = useApi<CoachConversationDto>(convId ? `/api/coach/conversations/${convId}` : null);
  const [items, setItems] = useState<Item[]>([]);
  const loadedFor = useRef<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [source, setSource] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  // 既有對話載入一次（剛建立的對話不必重新載入，避免蓋掉正在進行的問答）
  useEffect(() => {
    if (conv.data && loadedFor.current !== conv.data.id) {
      loadedFor.current = conv.data.id;
      setItems(fromConversation(conv.data));
    }
  }, [conv.data]);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [items, pending]);
  useEffect(() => () => abort.current?.abort(), []);

  // 結果觸發：同一個請求只處理一次（StrictMode 下 effect 會跑兩次）
  const handledResult = useRef<number | null>(null);
  useEffect(() => {
    const req = props.resultRequest;
    if (!req || handledResult.current === req.nonce) return;
    handledResult.current = req.nonce;
    void (async () => {
      setError(null);
      setItems([]);
      loadedFor.current = null;
      setPending({ stage: 'retrieving', sources: [], text: '' });
      try {
        const a = await api<CoachAnswerDto>('POST', '/api/coach/from-result', { attemptId: req.attemptId });
        // 載入這段新對話（系統產生的問題與教練的回答）
        setCreated(a.conversationId);
      } catch (e) {
        setError(e);
      } finally {
        setPending(null);
      }
    })();
  }, [props.resultRequest]);

  const available = licensed && av.data?.available === true;
  const busy = pending !== null;

  async function send(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setError(null);
    setQuestion('');
    setItems((x) => [...x, { role: 'user', text }]);
    setPending({ stage: 'retrieving', sources: [], text: '' });
    abort.current = new AbortController();
    try {
      let id = convId;
      if (!id) {
        const c = await api<CoachConversationDto>('POST', '/api/coach/conversations', { enrollmentId: props.enrollmentId, ...(props.activityId && { activityId: props.activityId }) });
        loadedFor.current = c.id;
        setCreated(c.id);
        id = c.id;
      }
      const done: CoachAnswerDto = await askCoach(id, text, (e) => setPending((p) => (p ? reduce(p, e) : p)), abort.current.signal);
      setItems((x) => [...x, { role: 'assistant', answer: done }]);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e);
      setQuestion(text);
      setItems((x) => x.slice(0, -1));
    } finally {
      setPending(null);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send(question);
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(question);
    }
  }

  return (
    <aside className="coach-drawer" aria-label="AI 學習教練">
      <div className="coach-head">
        <div className="grow">
          <strong>AI 學習教練</strong>
          {props.contextTitle && <div className="muted small">目前課節：{props.contextTitle}</div>}
        </div>
        <button type="button" className="btn btn-small btn-ghost" onClick={props.onClose}>
          關閉
        </button>
      </div>

      <div className="coach-body" aria-live="polite">
        {av.loading && !av.data && <Spinner />}
        <ErrorAlert error={av.error} />
        {av.data && !available && (
          <div className="alert alert-info">
            <strong>{COACH_TEXT.unavailable}</strong>
            <div>{!licensed ? REASON_TEXT.not_licensed : av.data.reason ? REASON_TEXT[av.data.reason] : ''}</div>
            <div className="small">課程學習不受影響。</div>
          </div>
        )}
        {available && items.length === 0 && !conv.loading && (
          <p className="muted small">可以問我這門課教材裡的內容，我會附上出處讓你查證。我不會評分，也不能修改成績。</p>
        )}
        {items.map((it, i) =>
          it.role === 'user' ? (
            <div key={i} className="chat-user">
              {it.text}
            </div>
          ) : (
            <AnswerView key={i} a={it.answer} busy={busy} onOpen={(c) => setSource(c.id)} onFollowUp={available ? (q) => void send(q) : undefined} />
          ),
        )}
        {pending && (
          <div className="chat-assistant">
            {pending.text ? <p className="coach-answer pre-line">{pending.text}</p> : <div className="coach-stage">{STAGE_TEXT[pending.stage]}</div>}
            {pending.sources.length > 0 && !pending.text && (
              <>
                <div className="muted small">找到的教材（可以先閱讀）：</div>
                <ul className="coach-sources">
                  {pending.sources.map((s, i) => (
                    <li key={i}>{[s.title, s.pageNo !== null ? `第 ${s.pageNo} 頁` : null, s.sectionPath].filter(Boolean).join('・')}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <ErrorAlert error={error} />
        <div ref={bottom} />
      </div>

      {available && (
        <form className="coach-foot" onSubmit={onSubmit}>
          <textarea
            rows={2}
            maxLength={COACH_QUESTION_MAX}
            value={question}
            placeholder="輸入問題（Enter 送出，Shift + Enter 換行）"
            aria-label="問題"
            disabled={busy}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="row">
            <span className="muted small grow">回答依據本課程教材；請勿輸入個人資料。</span>
            <button type="submit" className="btn btn-primary btn-small" disabled={busy || !question.trim()}>
              {busy ? '回答中…' : '送出'}
            </button>
          </div>
        </form>
      )}
      {source && <SourceViewer citationId={source} onClose={() => setSource(null)} />}
    </aside>
  );
}

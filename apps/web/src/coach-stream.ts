import type { CoachAnswerDto, CoachStreamEvent, ErrorEnvelope } from '@iac/contracts';
import { CSRF_COOKIE, readCookie } from './api/client';
import { ApiError } from './api/errors';

/**
 * AI 教練的 SSE（SD §6.19、ADR-025 B+）。EventSource 只能 GET，因此以 fetch 讀串流。
 * 解析為純函式：傳入累積的文字，回傳完整的事件與尚未完整的尾巴。
 */
export function parseSse(buffer: string): { events: CoachStreamEvent[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: CoachStreamEvent[] = [];
  for (const block of blocks) {
    if (!block.trim() || block.startsWith(':')) continue; // 註解行（伺服器的 ping）
    let event = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (!event || !data.length) continue;
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) } as CoachStreamEvent);
    } catch {
      // 壞掉的事件略過；結尾若沒有 done 會當作連線中斷
    }
  }
  return { events, rest };
}

/**
 * 送出問題並讀取回答。開始串流前的錯誤（無法使用、額度、限流）以 ApiError 拋出；
 * 串流中的 stage／sources／token 經 onEvent 回報；成功時回傳 done 的完整回答。
 */
export async function askCoach(conversationId: string, content: string, onEvent: (e: CoachStreamEvent) => void, signal?: AbortSignal): Promise<CoachAnswerDto> {
  const headers: Record<string, string> = { Accept: 'text/event-stream', 'Content-Type': 'application/json' };
  const csrf = readCookie(document.cookie, CSRF_COOKIE);
  if (csrf) headers['X-CSRF-Token'] = csrf;
  let res: Response;
  try {
    res = await fetch(`/api/coach/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({ content }),
      ...(signal && { signal }),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'network error', null);
  }
  if (!res.ok || !res.body) {
    const env = ((await res.json().catch(() => null)) as Partial<ErrorEnvelope> | null)?.error;
    throw new ApiError(res.status, env?.code ?? 'INTERNAL_ERROR', env?.message ?? res.statusText, env?.correlation_id ?? res.headers.get('x-request-id'), env?.details ?? []);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let answer: CoachAnswerDto | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parsed = parseSse(buf + value);
    buf = parsed.rest;
    for (const e of parsed.events) {
      if (e.event === 'error') throw new ApiError(500, 'INTERNAL_ERROR', e.data.message, res.headers.get('x-request-id'));
      if (e.event === 'done') answer = e.data;
      onEvent(e);
    }
  }
  if (!answer) throw new ApiError(0, 'NETWORK_ERROR', 'stream ended before the answer', null);
  return answer;
}

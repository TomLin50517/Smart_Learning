import type { BlockingReason, ResultIssue } from '@iac/contracts';

/**
 * 學習畫面的純邏輯（不需 DOM，可單元測試）：簡易 Markdown、作答順序打亂、完成原因與問題的中文說明。
 */

export type MdBlock = { type: 'h'; level: 1 | 2 | 3; text: string } | { type: 'p'; text: string } | { type: 'ul'; items: string[] };

/**
 * 課節文字的簡易 Markdown（SD §7.5：只存 Markdown、前端 allowlist 渲染）：只認標題（# ～ ###）、清單（- 或 *）與段落。
 * 輸出為純文字結構，由 React 轉義後顯示——不產生、也不插入任何 HTML。
 */
export function parseMarkdownLite(src: string): MdBlock[] {
  const out: MdBlock[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flushPara = () => {
    if (para.length) out.push({ type: 'p', text: para.join('\n') });
    para = [];
  };
  const flushList = () => {
    if (list) out.push({ type: 'ul', items: list });
    list = null;
  };
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      out.push({ type: 'h', level: h[1]!.length as 1 | 2 | 3, text: h[2]! });
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      (list ??= []).push(li[1]!);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * 依 seed（作答 id）決定的打亂：同一次作答重新整理後順序不變。
 * 保證不等於原本的順序——排序題的編排順序常常就是答案。
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const a = [...items];
  let x = hash(seed) || 1;
  const rand = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  if (a.length > 1 && a.every((v, i) => v === items[i])) a.push(a.shift()!);
  return a;
}

const ISSUE_TEXT: Record<string, string> = {
  WRONG_ANSWER: '答錯',
  UNANSWERED: '未作答',
  OUT_OF_ORDER: '位置不正確',
  VALUE_TOO_HIGH: '數值偏高',
  VALUE_TOO_LOW: '數值偏低',
  VIDEO_NOT_FINISHED: '影片尚未看完',
};

/** 作答結果的問題說明；自訂代碼（例如元件設定的 TEMP_HIGH）照原樣顯示 */
export function issueText(issue: ResultIssue, targetLabel?: string): string {
  const text = ISSUE_TEXT[issue.code] ?? issue.code;
  return targetLabel ? `${targetLabel}：${text}` : text;
}

/** 完成條件尚未達成的原因（SD §3.5 blocking_reasons） */
export function blockingReasonText(r: BlockingReason, titleOf: (activityId: string) => string | undefined): string {
  const t = r.activity_id ? (titleOf(r.activity_id) ?? '某個活動') : '';
  const q = (s: string) => `「${s}」`;
  switch (r.code) {
    case 'REQUIRED_ACTIVITIES_INCOMPLETE':
      return `必修活動已完成 ${String(r.actual)}／${String(r.required)}`;
    case 'ACTIVITY_NOT_COMPLETED':
      return `尚未完成${q(t)}`;
    case 'MIN_SCORE_NOT_MET':
      return `總分 ${String(r.actual)}，需達 ${String(r.required)}`;
    case 'ACTIVITY_SCORE_NOT_MET':
      return `${q(t)}的分數 ${r.actual == null ? '—' : String(r.actual)}，需達 ${String(r.required)}`;
    case 'VIDEO_WATCH_RATIO_NOT_MET':
      return `${q(t)}的觀看比例不足`;
    case 'ATTEMPT_STATUS_NOT_MET':
      return `${q(t)}尚未達到要求的作答結果`;
    case 'MODULE_NOT_COMPLETED':
      return `有單元尚未完成（${String(r.actual)}／${String(r.required)}）`;
    case 'LESSON_NOT_COMPLETED':
      return `有課節尚未完成（${String(r.actual)}／${String(r.required)}）`;
    case 'TIME_SPENT_NOT_MET':
      return `學習時間 ${String(r.actual)} 分鐘，需 ${String(r.required)} 分鐘`;
    case 'ATTEMPT_COUNT_EXCEEDED':
      return `${q(t)}的作答次數超過上限`;
    case 'MANUAL_APPROVAL_PENDING':
      return '等待老師核可';
    case 'DATA_NOT_AVAILABLE':
      return r.activity_id ? `${q(t)}尚未有成績` : '部分條件目前還無法判定';
    case 'NEGATED_CONDITION_MET':
      return '有一項「不可符合」的條件已成立';
    case 'COMPLETION_RULE_MISSING':
      return '課程尚未設定完成條件';
    default:
      return r.code;
  }
}

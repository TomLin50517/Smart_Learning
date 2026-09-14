/**
 * 教材切段（SD §6.17、SA SEQ-06）。純函式：輸入各頁文字，輸出全文與每段在全文中的位置。
 * 段落不跨頁（引用時才能標出頁碼）；以段落為單位累積到目標長度，過長的段落在句尾切開；
 * 相鄰兩段重疊一小段，避免一句話被切在兩段之間而檢索不到。Markdown 的標題形成章節路徑。
 */

export interface DocumentPage {
  /** PDF 的頁碼（1 起）；沒有頁的格式為 null */
  pageNo: number | null;
  text: string;
}

export interface ChunkSpan {
  index: number;
  pageNo: number | null;
  /** 章節路徑，例如「第一章 > 1.2 發酵」；沒有標題時為 null */
  sectionPath: string | null;
  /** 在 joinPages() 全文中的位置（含起點、不含終點） */
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** 目標長度（字元） */
  target: number;
  /** 上限（字元） */
  max: number;
  /** 相鄰段的重疊（字元） */
  overlap: number;
  /** 以 Markdown 標題（# ～ ######）建立章節路徑 */
  markdown: boolean;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { target: 800, max: 1200, overlap: 100, markdown: false };

/** 頁與頁之間的分隔（換頁符號）；chunk 不會跨過它 */
export const PAGE_SEPARATOR = '\n\f\n';

/** 合併各頁為全文，並回傳每頁在全文中的起點 */
export function joinPages(pages: readonly DocumentPage[]): { text: string; starts: number[] } {
  const starts: number[] = [];
  let text = '';
  pages.forEach((p, i) => {
    if (i > 0) text += PAGE_SEPARATOR;
    starts.push(text.length);
    text += p.text;
  });
  return { text, starts };
}

const BREAK_BEFORE = /[\s。！？；，、．.!?;,:：）)」』]/;

/** 往後找一個自然的切點（空白或標點之後），找不到就維持原位 */
function snapForward(text: string, pos: number, limit: number): number {
  for (let i = pos; i < Math.min(text.length, pos + 30, limit); i++) {
    if (i > 0 && BREAK_BEFORE.test(text[i - 1]!)) return i;
  }
  return pos;
}

/** 在 (from, to] 內找最後一個句尾；找不到回 to */
function lastSentenceEnd(text: string, from: number, to: number): number {
  for (let i = to; i > from; i--) {
    const ch = text[i - 1]!;
    if ('。！？!?；;\n'.includes(ch) || (ch === '.' && /\s/.test(text[i] ?? ' '))) return i;
  }
  return to;
}

interface Block {
  start: number;
  end: number;
  heading: { level: number; title: string } | null;
}

/** 一頁切成段落（空行分隔）；Markdown 標題行獨立成一塊 */
function blocksOf(text: string, markdown: boolean): Block[] {
  const out: Block[] = [];
  const re = /[^\n]*(\n|$)/g;
  let paraStart = -1;
  let paraEnd = -1;
  const flush = () => {
    if (paraStart >= 0) out.push({ start: paraStart, end: paraEnd, heading: null });
    paraStart = -1;
  };
  for (let m = re.exec(text); m && m.index < text.length; m = re.exec(text)) {
    const lineStart = m.index;
    const line = m[0].replace(/\n$/, '');
    const lineEnd = lineStart + line.length;
    const h = markdown ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (!line.trim()) {
      flush();
    } else if (h) {
      flush();
      out.push({ start: lineStart, end: lineEnd, heading: { level: h[1]!.length, title: h[2]! } });
    } else {
      if (paraStart < 0) paraStart = lineStart;
      paraEnd = lineEnd;
    }
    if (m[0] === '') break;
  }
  flush();
  return out;
}

export function chunkDocument(pages: readonly DocumentPage[], options: Partial<ChunkOptions> = {}): { text: string; chunks: ChunkSpan[] } {
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const { text, starts } = joinPages(pages);
  const chunks: ChunkSpan[] = [];
  const headings: string[] = [];
  const section = () => (headings.length ? headings.filter(Boolean).join(' > ') : null);

  pages.forEach((page, pi) => {
    const base = starts[pi]!;
    const t = page.text;
    let cur: { start: number; end: number; section: string | null } | null = null;
    /** 上一段因長度而切開時，下一段從這裡開始（重疊） */
    let carry: number | null = null;

    const push = (start: number, end: number, sec: string | null) => {
      if (!t.slice(start, end).trim()) return;
      chunks.push({ index: chunks.length, pageNo: page.pageNo, sectionPath: sec, charStart: base + start, charEnd: base + end });
    };
    const flush = (bySize: boolean) => {
      if (!cur) return;
      push(cur.start, cur.end, cur.section);
      carry = bySize ? Math.max(cur.start + 1, snapForward(t, cur.end - o.overlap, cur.end)) : null;
      cur = null;
    };
    /** 過長的段落：在句尾切開，每段不超過 max */
    const splitLong = (start: number, end: number, sec: string | null) => {
      let s = start;
      while (s < end) {
        let e = Math.min(end, s + o.max);
        if (e < end) e = lastSentenceEnd(t, s + Math.floor(o.target / 2), e);
        push(s, e, sec);
        if (e >= end) {
          carry = Math.max(s + 1, snapForward(t, e - o.overlap, e));
          break;
        }
        s = Math.max(s + 1, snapForward(t, e - o.overlap, e));
      }
    };

    for (const b of blocksOf(t, o.markdown)) {
      if (b.heading) {
        flush(false);
        carry = null;
        headings.length = b.heading.level - 1;
        headings[b.heading.level - 1] = b.heading.title;
      }
      const sec = section();
      if (b.end - b.start > o.max) {
        flush(true);
        splitLong(b.start, b.end, sec);
        continue;
      }
      if (cur && cur.section === sec && b.end - cur.start <= o.max) {
        cur.end = b.end;
      } else {
        flush(!!cur);
        const start: number = carry !== null && carry < b.start && sec === chunks[chunks.length - 1]?.sectionPath ? carry : b.start;
        cur = { start, end: b.end, section: sec };
        carry = null;
      }
      if (cur.end - cur.start >= o.target) flush(true);
    }
    flush(false);
  });
  return { text, chunks };
}

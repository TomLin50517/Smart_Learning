import { describe, expect, it } from 'vitest';
import { chunkDocument, joinPages, PAGE_SEPARATOR } from './chunk.js';
import { detectDocumentKind } from './detect.js';

const para = (n: number, word = '發酵溫度影響麵團膨脹。') => word.repeat(n);

describe('chunkDocument', () => {
  it('keeps a short page as one chunk whose offsets point into the joined text', () => {
    const r = chunkDocument([{ pageNo: 1, text: '第一段內容。' }]);
    expect(r.chunks).toEqual([{ index: 0, pageNo: 1, sectionPath: null, charStart: 0, charEnd: 6 }]);
    expect(r.text.slice(0, 6)).toBe('第一段內容。');
  });

  it('packs paragraphs up to the target, never exceeding the maximum, and never crossing pages', () => {
    const page = Array.from({ length: 12 }, () => para(8)).join('\n\n');
    const r = chunkDocument(
      [
        { pageNo: 1, text: page },
        { pageNo: 2, text: page },
      ],
      { target: 300, max: 500, overlap: 40 },
    );
    const { starts } = joinPages([
      { pageNo: 1, text: page },
      { pageNo: 2, text: page },
    ]);
    expect(r.chunks.length).toBeGreaterThan(4);
    for (const c of r.chunks) {
      expect(c.charEnd - c.charStart).toBeLessThanOrEqual(500);
      expect(c.charEnd).toBeGreaterThan(c.charStart);
      expect(r.text.slice(c.charStart, c.charEnd)).not.toContain(PAGE_SEPARATOR);
      const pageStart = starts[(c.pageNo ?? 1) - 1]!;
      expect(c.charStart).toBeGreaterThanOrEqual(pageStart);
    }
    expect(r.chunks.map((c) => c.index)).toEqual(r.chunks.map((_, i) => i));
    // 每頁的最後一段一定到頁尾：整頁都被涵蓋
    const lastOfPage1 = r.chunks.filter((c) => c.pageNo === 1).at(-1)!;
    expect(lastOfPage1.charEnd).toBe(page.length);
  });

  it('overlaps consecutive chunks slightly so a sentence is not lost at the cut', () => {
    const page = Array.from({ length: 10 }, () => para(8)).join('\n\n');
    const r = chunkDocument([{ pageNo: null, text: page }], { target: 300, max: 500, overlap: 40 });
    for (let i = 1; i < r.chunks.length; i++) {
      const prev = r.chunks[i - 1]!;
      const cur = r.chunks[i]!;
      expect(cur.charStart).toBeLessThan(prev.charEnd);
      expect(prev.charEnd - cur.charStart).toBeLessThanOrEqual(80);
    }
  });

  it('splits a very long paragraph at sentence ends', () => {
    const r = chunkDocument([{ pageNo: 1, text: para(200) }], { target: 300, max: 500, overlap: 40 });
    expect(r.chunks.length).toBeGreaterThan(3);
    for (const c of r.chunks) {
      expect(c.charEnd - c.charStart).toBeLessThanOrEqual(500);
      expect(r.text[c.charEnd - 1]).toBe('。');
    }
  });

  it('builds section paths from Markdown headings and starts a new chunk at each heading', () => {
    const md = ['# 麵包製作', '', '導論文字。', '', '## 發酵', '', '溫度要控制。', '', '## 烘烤', '', '溫度 200 度。'].join('\n');
    const r = chunkDocument([{ pageNo: null, text: md }], { markdown: true });
    expect(r.chunks.map((c) => [c.sectionPath, r.text.slice(c.charStart, c.charEnd).split('\n')[0]])).toEqual([
      ['麵包製作', '# 麵包製作'],
      ['麵包製作 > 發酵', '## 發酵'],
      ['麵包製作 > 烘烤', '## 烘烤'],
    ]);
  });

  it('empty or blank pages produce no chunks', () => {
    expect(chunkDocument([{ pageNo: 1, text: '   \n\n ' }, { pageNo: 2, text: '' }]).chunks).toEqual([]);
  });
});

describe('detectDocumentKind', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it('trusts the file header, not the name', () => {
    expect(detectDocumentKind(bytes('%PDF-1.7\n...'), 'anything.bin')).toBe('pdf');
    expect(detectDocumentKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), '講義.docx')).toBe('docx');
    expect(detectDocumentKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), 'archive.zip')).toBeNull();
    expect(detectDocumentKind(bytes('# 標題\n內容'), 'notes.md')).toBe('markdown');
    expect(detectDocumentKind(bytes('純文字'), 'notes.TXT')).toBe('text');
  });

  it('rejects binaries disguised as text and unknown formats', () => {
    expect(detectDocumentKind(new Uint8Array([0x68, 0x00, 0x69]), 'fake.txt')).toBeNull();
    expect(detectDocumentKind(new Uint8Array([0xff, 0xfe, 0x00]), 'fake.md')).toBeNull();
    expect(detectDocumentKind(bytes('hello'), 'notes.pdf')).toBeNull();
    expect(detectDocumentKind(bytes('<svg/>'), 'x.svg')).toBeNull();
  });
});

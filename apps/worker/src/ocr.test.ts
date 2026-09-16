import { describe, expect, it } from 'vitest';
import { DEFAULT_OCR_OPTIONS, DISABLED_OCR, createOcrEngine, hasText, tidyOcrText } from './ocr.js';

describe('tidyOcrText', () => {
  it('removes the spaces tesseract inserts between Chinese characters', () => {
    // 實測輸出：中文每字之間都有空白
    expect(tidyOcrText('烘 焙 入 門 教 材')).toBe('烘焙入門教材');
    expect(tidyOcrText('發 酵 溫 度 要 控 制 在 26 度 。')).toBe('發酵溫度要控制在 26 度。');
  });

  it('keeps the spaces between English words', () => {
    // 英文的空白可能是真的，誤刪會把整句黏成一團
    expect(tidyOcrText('Fermentation needs 26 degrees.')).toBe('Fermentation needs 26 degrees.');
    expect(tidyOcrText('Bake at 200 degrees for 25 minutes.')).toBe('Bake at 200 degrees for 25 minutes.');
  });

  it('handles mixed Chinese and English', () => {
    expect(tidyOcrText('烤 箱 預 熱 至 200 度 後 再 放 入 麵 團 。')).toBe('烤箱預熱至 200 度後再放入麵團。');
    expect(tidyOcrText('請 見 Chapter 3 的 說 明')).toBe('請見 Chapter 3 的說明');
  });

  it('tidies whitespace without losing paragraph breaks', () => {
    expect(tidyOcrText('第 一 段\n\n\n\n第 二 段\n')).toBe('第一段\n\n第二段');
    expect(tidyOcrText('  行 首 行 尾  \n')).toBe('行首行尾');
    expect(tidyOcrText('a\r\nb')).toBe('a\nb');
  });

  it('returns an empty string when the page is blank', () => {
    expect(tidyOcrText('')).toBe('');
    expect(tidyOcrText('   \n  \n')).toBe('');
  });
});

describe('hasText', () => {
  it('tells apart pages with content from blank ones', () => {
    expect(hasText([{ pageNo: 1, text: '有內容' }])).toBe(true);
    expect(hasText([])).toBe(false);
    expect(hasText([{ pageNo: 1, text: '   ' }, { pageNo: 2, text: '\n' }])).toBe(false);
  });
});

describe('createOcrEngine', () => {
  it('is a no-op when disabled, so behaviour matches the pre-OCR build', async () => {
    const e = createOcrEngine({ ...DEFAULT_OCR_OPTIONS, enabled: false });
    expect(e).toBe(DISABLED_OCR);
    expect(e.enabled).toBe(false);
    expect(await e.recognize(Buffer.from('%PDF-1.4'))).toEqual([]);
  });

  it('reports a missing binary as an error rather than pretending the page is blank', async () => {
    // 開發機與 CI 都沒有 pdftoppm（只有 worker image 有）；工具缺席或 PDF 無效都必須明確失敗，不能安靜回空結果
    const e = createOcrEngine({ ...DEFAULT_OCR_OPTIONS, enabled: true, pageTimeoutMs: 5_000 });
    await expect(e.recognize(Buffer.from('%PDF-1.4 not really a pdf'))).rejects.toThrow(/pdftoppm/);
  });
});

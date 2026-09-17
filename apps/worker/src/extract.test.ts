import { describe, expect, it } from 'vitest';
import { makePdf } from '../../../tests/fixtures/make-pdf.js';
import { extractPages, ExtractError } from './extract.js';

describe('extractPages', () => {
  it('reads each PDF page from its text layer', async () => {
    const pages = await extractPages('pdf', makePdf(['Fermentation needs 26 degrees', 'Baking at 200 degrees']));
    expect(pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(pages[0]!.text).toContain('Fermentation needs 26 degrees');
    expect(pages[1]!.text).toContain('Baking at 200 degrees');
  });

  it('decodes Markdown and plain text as UTF-8 and normalises line endings', async () => {
    const pages = await extractPages('markdown', Buffer.from('﻿# 標題\r\n內容\r\n', 'utf8'));
    expect(pages).toEqual([{ pageNo: null, text: '# 標題\n內容\n' }]);
  });

  // 解析壞檔是 CPU 密集的：機器上有容器在跑時，預設的 5 秒上限不夠穩（實測單獨跑約 1 秒）
  it('reports content problems with a reason instead of crashing', async () => {
    await expect(extractPages('pdf', Buffer.from('%PDF-1.4 broken'))).rejects.toBeInstanceOf(ExtractError);
    await expect(extractPages('docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).rejects.toMatchObject({ reason: expect.stringMatching(/^parse_failed/) });
    await expect(extractPages('text', Buffer.from('   \n  '))).rejects.toMatchObject({ reason: 'no_text' });
  }, 30_000);
});

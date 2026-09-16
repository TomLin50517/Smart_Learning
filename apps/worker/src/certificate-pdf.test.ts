import { fileURLToPath } from 'node:url';
import pdfLib from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { renderCertificatePdf } from './certificate-pdf.js';

const { PDFDocument } = pdfLib;
const FONT = fileURLToPath(new URL('../../../assets/fonts/NotoSansTC[wght].ttf', import.meta.url));
const content = {
  organizationName: '示範大學',
  courseTitle: '烘焙入門',
  learnerDisplayName: '王小明',
  publicId: '01JTEST0000000000000000001',
  issuedAt: new Date('2026-09-16T02:00:00Z'),
  verifyUrl: 'https://learn.example.test/verify/ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
};

describe('renderCertificatePdf', () => {
  it('produces a one-page A4 landscape PDF that only embeds the characters it uses', async () => {
    const pdf = await renderCertificatePdf(content, FONT);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // 只嵌入用到的字：完整字型有 11 MB，證書應遠小於此
    expect(pdf.length).toBeGreaterThan(2000);
    expect(pdf.length).toBeLessThan(1_000_000);

    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([842, 595]);
    expect(doc.getTitle()).toBe('烘焙入門 結業證書');
    expect(doc.getAuthor()).toBe('示範大學');
  }, 30_000);

  it('keeps long names and titles inside the page', async () => {
    const pdf = await renderCertificatePdf({ ...content, courseTitle: '很長的課程名稱'.repeat(12), learnerDisplayName: '姓名很長的學員'.repeat(6) }, FONT);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
  }, 30_000);
});

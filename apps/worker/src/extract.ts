import type { DocumentKind, DocumentPage } from '@iac/domain';
import { DISABLED_OCR, hasText, type OcrEngine } from './ocr.js';

/** 超過就視為失敗（避免巨大文件拖垮 worker） */
export const MAX_PAGES = 2000;
export const MAX_TEXT_CHARS = 20_000_000;

/** 內容錯誤（檔案壞掉、沒有文字）：不重試，直接標為 failed 並附原因 */
export class ExtractError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ExtractError';
  }
}

const normalize = (s: string) => s.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n');

/**
 * 擷取文字（SA SEQ-06「不執行文件內 macro/script」）：PDF 以 pdf.js 取文字層（關閉 eval、不載字型）；
 * Word 以 mammoth 取純文字；Markdown／純文字直接以 UTF-8 解碼。
 * 掃描成圖片的 PDF 沒有文字層：啟用 OCR 時改以 OCR 辨識（SD §6.30），否則維持 no_text。
 */
export async function extractPages(kind: DocumentKind, data: Buffer, ocr: OcrEngine = DISABLED_OCR): Promise<DocumentPage[]> {
  let pages: DocumentPage[];
  switch (kind) {
    case 'text':
    case 'markdown':
      pages = [{ pageNo: null, text: normalize(new TextDecoder('utf-8').decode(data)) }];
      break;
    case 'docx': {
      const mammoth = (await import('mammoth')).default;
      let value: string;
      try {
        value = (await mammoth.extractRawText({ buffer: data })).value;
      } catch (e) {
        throw new ExtractError(`parse_failed: ${e instanceof Error ? e.message.slice(0, 200) : 'docx'}`);
      }
      pages = [{ pageNo: null, text: normalize(value) }];
      break;
    }
    case 'pdf':
      pages = await extractPdf(data);
      break;
  }
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  if (total > MAX_TEXT_CHARS) throw new ExtractError('too_much_text');
  if (!pages.some((p) => p.text.trim())) {
    // 掃描成圖片的 PDF：交給 OCR（SD §6.30）。辨識不出東西仍以 no_text 退件——
    // OCR 讀不出來不是系統錯誤，與沒有啟用 OCR 的結果一致
    if (kind === 'pdf' && ocr.enabled) {
      const scanned = await ocr.recognize(data);
      if (hasText(scanned)) return scanned;
    }
    throw new ExtractError('no_text');
  }
  return pages;
}

async function extractPdf(data: Buffer): Promise<DocumentPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // 只取文字層：不載字型、不轉譯（pdf.js v5 起已移除 eval 路徑）
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    throw new ExtractError(`parse_failed: ${e instanceof Error ? e.message.slice(0, 200) : 'pdf'}`);
  }
  try {
    if (doc.numPages > MAX_PAGES) throw new ExtractError('too_many_pages');
    const pages: DocumentPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
      pages.push({ pageNo: i, text: normalize(text) });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

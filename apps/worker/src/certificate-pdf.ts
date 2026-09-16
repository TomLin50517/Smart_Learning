import { readFile } from 'node:fs/promises';
import fontkitPkg from '@pdf-lib/fontkit';
import pdfLib, { type PDFPage } from 'pdf-lib';
import qrcode from 'qrcode-generator';

// pdf-lib／fontkit 為 CommonJS 套件：以 default import 取用具名匯出（ESM 下最穩定）
const { PDFDocument, rgb } = pdfLib;

export interface CertificateContent {
  organizationName: string;
  courseTitle: string;
  learnerDisplayName: string;
  publicId: string;
  issuedAt: Date;
  /** 查驗網址（同時印成文字與 QR code） */
  verifyUrl: string;
}

/** A4 橫式（點） */
const WIDTH = 842;
const HEIGHT = 595;
const INK = () => rgb(0.11, 0.1, 0.09);
const MUTED = () => rgb(0.42, 0.4, 0.38);
const ACCENT = () => rgb(0.11, 0.31, 0.85);

/** 字型檔只讀一次（PDF 只嵌入用到的字，檔案因此很小） */
let cached: { path: string; bytes: Buffer } | null = null;
async function fontBytes(path: string): Promise<Buffer> {
  if (cached?.path !== path) cached = { path, bytes: await readFile(path) };
  return cached.bytes;
}

/** 台灣時間的日期（證書上印的日期） */
function formatDate(d: Date): string {
  const s = d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'long', day: 'numeric' });
  return s;
}

/** 單行文字塞不下時縮小字級，仍塞不下就截斷 */
function fit(text: string, font: { widthOfTextAtSize(t: string, s: number): number }, size: number, max: number, min = 12): { text: string; size: number } {
  let s = size;
  while (s > min && font.widthOfTextAtSize(text, s) > max) s -= 1;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t, s) > max) t = t.slice(0, -1);
  return { text: t === text ? t : `${t.slice(0, -1)}…`, size: s };
}

/**
 * 結業證書 PDF（UC-CRT-002、SD §6.28）：A4 橫式，內容與網頁版一致——
 * 組織、學員姓名、課程、發證日期、證書編號、查驗網址與 QR code。
 * 只嵌入用到的字（subset），中文字型為 Noto Sans TC（SIL OFL，assets/fonts）。
 */
export async function renderCertificatePdf(c: CertificateContent, fontPath: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkitPkg);
  const font = await doc.embedFont(await fontBytes(fontPath), { subset: true });
  const page = doc.addPage([WIDTH, HEIGHT]);

  const center = (text: string, size: number, y: number, color = INK(), maxWidth = WIDTH - 160) => {
    const f = fit(text, font, size, maxWidth);
    page.drawText(f.text, { x: (WIDTH - font.widthOfTextAtSize(f.text, f.size)) / 2, y, size: f.size, font, color });
  };

  // 外框
  page.drawRectangle({ x: 28, y: 28, width: WIDTH - 56, height: HEIGHT - 56, borderColor: ACCENT(), borderWidth: 2 });
  page.drawRectangle({ x: 36, y: 36, width: WIDTH - 72, height: HEIGHT - 72, borderColor: MUTED(), borderWidth: 0.5 });

  center(c.organizationName, 16, HEIGHT - 96, MUTED());
  center('結業證書', 40, HEIGHT - 170);
  center('茲證明', 14, HEIGHT - 232, MUTED());
  center(c.learnerDisplayName, 32, HEIGHT - 288);
  center('已完成課程', 14, HEIGHT - 330, MUTED());
  center(c.courseTitle, 24, HEIGHT - 378);
  center(`發證日期：${formatDate(c.issuedAt)}`, 14, HEIGHT - 430, MUTED());

  page.drawText(`證書編號：${c.publicId}`, { x: 64, y: 84, size: 10, font, color: MUTED() });
  const line = fit(`查驗：${c.verifyUrl}`, font, 10, WIDTH - 260);
  page.drawText(line.text, { x: 64, y: 66, size: line.size, font, color: MUTED() });

  drawQr(page, c.verifyUrl, WIDTH - 150, 56, 86);
  page.drawText('掃描查驗', { x: WIDTH - 150, y: 40, size: 8, font, color: MUTED() });

  doc.setTitle(`${c.courseTitle} 結業證書`);
  doc.setAuthor(c.organizationName);
  doc.setSubject(`證書編號 ${c.publicId}`);
  doc.setProducer('Interactive AI Coach');
  doc.setCreationDate(c.issuedAt);
  doc.setModificationDate(c.issuedAt);
  return Buffer.from(await doc.save());
}

/** QR code 直接畫成方塊（不經影像編碼）：type 0 = 自動選版本，錯誤更正等級 M */
function drawQr(page: PDFPage, text: string, x: number, y: number, size: number): void {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = size / n;
  page.drawRectangle({ x: x - 4, y: y - 4, width: size + 8, height: size + 8, color: rgb(1, 1, 1) });
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.isDark(row, col)) continue;
      // PDF 的 y 由下往上，QR 的列由上往下
      page.drawRectangle({ x: x + col * cell, y: y + size - (row + 1) * cell, width: cell, height: cell, color: INK() });
    }
  }
}

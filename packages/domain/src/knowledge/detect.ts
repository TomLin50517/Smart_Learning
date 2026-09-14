/**
 * 教材格式判斷（SD §6.17）：以檔頭判斷，不採信副檔名或上傳端宣稱的型別。純函式。
 * PDF 以 %PDF- 判斷；Word 須為 .docx（zip 檔頭，內容於解析時再確認）；
 * 文字檔（.txt／.md）須為合法 UTF-8 且不含 NUL。
 */

export type DocumentKind = 'pdf' | 'docx' | 'markdown' | 'text';

export const DOCUMENT_KIND_MIME: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  markdown: 'text/markdown',
  text: 'text/plain',
};

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

/** 合法 UTF-8 且不含 NUL；檔頭可能在多位元組字元中間截斷，結尾不完整的序列視為合法 */
function looksLikeUtf8Text(head: Uint8Array): boolean {
  let i = 0;
  while (i < head.length) {
    const b = head[i]!;
    if (b === 0) return false;
    const n = b < 0x80 ? 0 : b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
    if (n < 0) return false;
    for (let k = 1; k <= n; k++) {
      if (i + k >= head.length) return true;
      if ((head[i + k]! & 0xc0) !== 0x80) return false;
    }
    i += n + 1;
  }
  return true;
}

export function detectDocumentKind(head: Uint8Array, filename: string): DocumentKind | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return ext === 'docx' ? 'docx' : null;
  if ((ext === 'md' || ext === 'markdown') && looksLikeUtf8Text(head)) return 'markdown';
  if (ext === 'txt' && looksLikeUtf8Text(head)) return 'text';
  return null;
}

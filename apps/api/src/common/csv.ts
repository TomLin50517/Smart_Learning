/**
 * CSV 產生（RFC 4180），供稽核匯出與學員名單匯出使用。純函式。
 *
 * 公式注入防護（CWE-1236）：稽核內容包含外部輸入（組織名稱、metadata…），
 * 以 = + - @ Tab CR 開頭的儲存格在 Excel／LibreOffice 會被當成公式執行，
 * 因此一律在前面加上單引號使其成為純文字。
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** 以 UTF-8 BOM 開頭：Excel 才會以 UTF-8 開啟（否則中文亂碼） */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n';
}

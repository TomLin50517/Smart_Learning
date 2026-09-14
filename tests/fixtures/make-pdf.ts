/**
 * 產生只含 ASCII 文字的最小 PDF（每頁一行文字），供解析測試使用——不需要任何檔案或產生工具。
 */
export function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 3 + i * 2);
  const fontId = 3 + pages.length * 2;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach((text, i) => {
    const id = pageIds[i]!;
    const stream = `BT /F1 18 Tf 72 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objs[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objs[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objs[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * 穩定序列化：物件鍵依字典序、陣列保持順序、值為 undefined 的鍵省略。
 * 同樣的內容永遠得到同樣的字串——發布時的內容快照雜湊（content_snapshot_hash）以此為輸入，
 * 日後重算即可偵測已發布版本是否被繞過應用層修改（SA AC-CRS-001）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

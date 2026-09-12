/**
 * 複製課程版本時的 id 重新對應（SA SEQ-02）。純函式。
 *
 * 新版本的 module／lesson／activity 會拿到新 id，而這些 id 也出現在 JSON 內：
 * 完成條件（activity_id、activity_ids、module_id、lesson_id）、先修條件、
 * 單元內容的 activity 區塊、互動元件 config／answerKey 內的引用。
 * 因為 id 是 UUID（全域唯一），直接替換「值等於舊 id 的字串」與「等於舊 id 的物件鍵」即可，
 * 不需要知道每種 JSON 的結構——新增的條件型別也自動涵蓋。
 */
export function remapIds<T>(value: T, map: ReadonlyMap<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [map.get(k) ?? k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

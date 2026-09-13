import { canonicalJson } from './canonical-json.js';

/**
 * 精簡 JSON Schema 驗證器（發布前 C5：互動活動的 config／answerKey 是否符合元件 schema）。純函式。
 *
 * 只支援平台內建元件（migration 0013）實際用到的關鍵字與幾個常見約束；schema 由平台維護，
 * 不接受使用者提供。遇到不支援的關鍵字不默默略過——回傳於 `unsupported`，由呼叫端提示「僅部分檢查」。
 * 不支援 pattern：避免在伺服器上執行 schema 內任意正規表示式（ReDoS）。
 */
const SUPPORTED = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
]);

export interface SchemaViolation {
  /** JSON Pointer（根為空字串），如 `/parameters/0/min` */
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const TYPE_LABELS: Record<string, string> = {
  object: '物件',
  array: '陣列',
  string: '文字',
  number: '數字',
  integer: '整數',
  boolean: '是／否',
  null: '空值',
};

function matchesType(type: unknown, v: unknown): boolean {
  switch (type) {
    case 'object':
      return isObj(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return false;
  }
}

export function validateJsonSchema(schema: unknown, value: unknown): { violations: SchemaViolation[]; unsupported: string[] } {
  const violations: SchemaViolation[] = [];
  const unsupported = new Set<string>();
  const fail = (path: string, message: string) => void violations.push({ path, message });

  const check = (s: unknown, v: unknown, path: string): void => {
    if (s === true || s === undefined) return;
    if (s === false) return fail(path, '不允許此欄位');
    if (!isObj(s)) return;
    for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) unsupported.add(k);

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => matchesType(t, v))) return fail(path, `應為${types.map((t) => TYPE_LABELS[String(t)] ?? String(t)).join('或')}`);
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => canonicalJson(e) === canonicalJson(v))) fail(path, '不在允許的選項中');
    if ('const' in s && canonicalJson(s.const) !== canonicalJson(v)) fail(path, '與規定的值不符');

    if (typeof v === 'string') {
      const len = [...v].length;
      if (typeof s.minLength === 'number' && len < s.minLength) fail(path, `至少 ${s.minLength} 個字`);
      if (typeof s.maxLength === 'number' && len > s.maxLength) fail(path, `最多 ${s.maxLength} 個字`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) fail(path, `不可小於 ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) fail(path, `不可大於 ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) fail(path, `至少要有 ${s.minItems} 項`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) fail(path, `最多 ${s.maxItems} 項`);
      if (s.items !== undefined) v.forEach((item, i) => check(s.items, item, `${path}/${i}`));
    }
    if (isObj(v)) {
      if (Array.isArray(s.required)) for (const k of s.required) if (typeof k === 'string' && !(k in v)) fail(`${path}/${k}`, '缺少必填欄位');
      const props = isObj(s.properties) ? s.properties : {};
      for (const [k, child] of Object.entries(v)) {
        if (k in props) check(props[k], child, `${path}/${k}`);
        else if (s.additionalProperties !== undefined) check(s.additionalProperties, child, `${path}/${k}`);
      }
    }
  };

  check(schema, value, '');
  return { violations, unsupported: [...unsupported].sort() };
}

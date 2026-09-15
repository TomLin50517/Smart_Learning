/**
 * 常見問答的線索（SD §6.27、§10.8）：學員提問的去識別化與相似問題分群。純函式。
 * 護欄（ARCH §14.5、NFR-PRIV-003）：分群一律在去識別化之後；只輸出「不同學員數 ≥ 門檻」的群。
 * 學員以呼叫端給的不透明編號區分（只用來計算人數），不含任何身分資料。
 */

export interface QuestionItem {
  /** 不透明的學員編號（同一人同一編號） */
  learner: number;
  text: string;
  /** epoch ms */
  at: number;
}

export interface QuestionCluster {
  key: string;
  /** 代表性的問題（已去識別化） */
  question: string;
  learners: number;
  questions: number;
  lastAt: number;
}

/** Email 只比對 ASCII（不會把前後的中文一起吃掉） */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** 台灣手機與市話（可含國碼、空白、連字號、括號） */
const MOBILE = /(?:\+?886[\s-]?|0)9\d{2}[\s-]?\d{3}[\s-]?\d{3}/g;
const LANDLINE = /\(?0\d{1,2}\)?[\s-]?\d{3,4}[\s-]?\d{4}/g;
const LONG_NUMBER = /\d{6,}/g;
const PLACEHOLDER = /\[(?:EMAIL|PHONE|NAME|ID|NUMBER)\]/g;

/**
 * 去識別化（SD §10.8）：Email → [EMAIL]、電話 → [PHONE]、名單中的學號 → [ID]、名單中的姓名 → [NAME]、
 * 連續 6 位以上數字 → [NUMBER]。名單比對為精確字串比對，長的先換（避免部分重疊）。
 */
export function anonymizeQuestion(text: string, known: { names?: readonly string[]; ids?: readonly string[] } = {}): string {
  let t = text.replace(EMAIL, '[EMAIL]').replace(MOBILE, '[PHONE]').replace(LANDLINE, '[PHONE]');
  const replaceAll = (list: readonly string[] | undefined, token: string) => {
    for (const s of [...new Set((list ?? []).map((x) => x.trim()).filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length)) t = t.split(s).join(token);
  };
  replaceAll(known.ids, '[ID]');
  replaceAll(known.names, '[NAME]');
  return t.replace(LONG_NUMBER, '[NUMBER]').replace(/\s+/g, ' ').trim();
}

/** 比較用的正規化：去掉代換標記、標點、空白，英文轉小寫 */
export function normalizeQuestion(text: string): string {
  return text.replace(PLACEHOLDER, '').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

/** 單字與相鄰兩字的集合（中英文都適用，不需要分詞） */
function grams(s: string): Set<string> {
  const out = new Set<string>();
  const chars = [...s];
  for (const c of chars) out.add(`1${c}`);
  for (let i = 0; i + 1 < chars.length; i++) out.add(`2${chars[i]}${chars[i + 1]}`);
  return out;
}

/** Dice 係數：2|A∩B| / (|A| + |B|)。短句的換句話說（多一個「的」、「幾」換「多少」）仍有足夠的分數 */
function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** 兩個問題的相似度（0～1） */
export function questionSimilarity(a: string, b: string): number {
  return dice(grams(normalizeQuestion(a)), grams(normalizeQuestion(b)));
}

/** 32 位元 FNV-1a（只用來產生穩定的線索代號，不作安全用途） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const MIN_CHARS = 4;
const MEDOID_SAMPLE = 60;

/**
 * 相似問題分群（single linkage）：任兩個問題相似度 ≥ minSimilarity 就歸在同一群（union-find），與輸入順序無關。
 * 只回傳不同學員數 ≥ threshold 的群；代表問題取群內與其他問題最相似者（相同時取較短的）。
 * 呼叫端限制輸入筆數（API 取最近 2000 則），兩兩比較的成本可接受。
 */
export function clusterQuestions(
  items: readonly QuestionItem[],
  opts: { threshold: number; minSimilarity?: number; maxClusters?: number },
): QuestionCluster[] {
  const minSim = opts.minSimilarity ?? 0.45;
  const members: { item: QuestionItem; grams: Set<string> }[] = [];
  for (const item of items) {
    const norm = normalizeQuestion(item.text);
    if ([...norm].length >= MIN_CHARS) members.push({ item, grams: grams(norm) });
  }
  const parent = members.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (dice(members[i]!.grams, members[j]!.grams) >= minSim) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map<number, { members: typeof members }>();
  members.forEach((m, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, { members: [] });
    byRoot.get(r)!.members.push(m);
  });

  const out: QuestionCluster[] = [];
  for (const g of byRoot.values()) {
    const learners = new Set(g.members.map((m) => m.item.learner)).size;
    if (learners < opts.threshold) continue;
    const sample = g.members.slice(0, MEDOID_SAMPLE);
    let rep = sample[0]!;
    let repScore = -1;
    for (const m of sample) {
      const score = sample.reduce((sum, o) => (o === m ? sum : sum + dice(m.grams, o.grams)), 0);
      if (score > repScore || (score === repScore && m.item.text.length < rep.item.text.length)) {
        rep = m;
        repScore = score;
      }
    }
    const question = rep.item.text.length > 200 ? `${rep.item.text.slice(0, 199)}…` : rep.item.text;
    out.push({
      key: `q:${fnv1a(normalizeQuestion(question))}`,
      question,
      learners,
      questions: g.members.length,
      lastAt: Math.max(...g.members.map((m) => m.item.at)),
    });
  }
  return out.sort((a, b) => b.learners - a.learners || b.questions - a.questions).slice(0, opts.maxClusters ?? 20);
}

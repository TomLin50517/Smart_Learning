/**
 * 掃描版 PDF 的文字辨識（SD §6.30、SA SEQ-06）。
 *
 * 只在 PDF **沒有文字層** 時才啟用（extract.ts 原本會以 `no_text` 退件）：
 * `pdftoppm` 逐頁轉成灰階圖，再交給 `tesseract`。兩者是系統套件，只裝在 worker 的 image
 * （infra/docker/Dockerfile 的 worker target），api 不需要。
 *
 * 未安裝或未啟用時 enabled 為 false，行為與之前完全相同（維持 `no_text`）。
 * OCR 失敗不算系統錯誤——辨識不出來就是辨識不出來，仍以 `no_text` 退件並留 log。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentPage } from '@iac/domain';

export interface OcrEngine {
  readonly enabled: boolean;
  /** 逐頁辨識；超過 maxPages 的部分不處理（OCR 很慢，且教材通常只有前幾頁重要） */
  recognize(pdf: Buffer): Promise<DocumentPage[]>;
}

export interface OcrOptions {
  /** 轉圖解析度；300 是實測品質與速度的平衡點（150 會明顯變差） */
  dpi: number;
  /** tesseract 語言包，例如 chi_tra+eng */
  languages: string;
  /** 最多辨識幾頁 */
  maxPages: number;
  /** 單頁逾時（毫秒） */
  pageTimeoutMs: number;
}

export const DEFAULT_OCR_OPTIONS: OcrOptions = { dpi: 300, languages: 'chi_tra+eng', maxPages: 50, pageTimeoutMs: 60_000 };

/** CJK 統一漢字、擴充 A、相容漢字，加上全形標點 */
const CJK = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const BETWEEN_CJK = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g');

/**
 * tesseract 會在每個中文字之間插入空白。相鄰 CJK 之間的空白一律移除；
 * 英文與數字之間的空白保留——那裡的空白可能是真的（誤刪會把句子黏成一團）。
 */
export function tidyOcrText(raw: string): string {
  let out = raw.replace(/\r\n?/g, '\n');
  // 一次只能消掉一組（相鄰兩字共用同一個空白時需要重複套用）
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(BETWEEN_CJK, '$1');
  }
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 未安裝 OCR 工具（或關閉）時的行為：與加入 OCR 之前完全一致 */
export const DISABLED_OCR: OcrEngine = {
  enabled: false,
  recognize: () => Promise.resolve([]),
};

function run(cmd: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    p.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    p.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} could not be started: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with ${code}: ${err.slice(0, 300)}`));
    });
  });
}

export function createOcrEngine(opts: OcrOptions & { enabled: boolean }): OcrEngine {
  if (!opts.enabled) return DISABLED_OCR;
  return {
    enabled: true,
    async recognize(pdf: Buffer): Promise<DocumentPage[]> {
      const dir = await mkdtemp(join(tmpdir(), 'iac-ocr-'));
      try {
        const src = join(dir, 'in.pdf');
        await writeFile(src, pdf);
        // -gray：灰階即可，彩色對辨識沒有幫助卻更慢更佔空間
        await run('pdftoppm', ['-r', String(opts.dpi), '-gray', '-png', '-l', String(opts.maxPages), src, join(dir, 'p')], opts.pageTimeoutMs * opts.maxPages);

        const images = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
        const pages: DocumentPage[] = [];
        for (const [i, img] of images.entries()) {
          const text = await run('tesseract', [join(dir, img), 'stdout', '-l', opts.languages, '--psm', '6'], opts.pageTimeoutMs);
          pages.push({ pageNo: i + 1, text: tidyOcrText(text) });
        }
        return pages;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** 供 handler 判斷：OCR 是否真的讀到東西 */
export const hasText = (pages: readonly DocumentPage[]): boolean => pages.some((p) => p.text.trim().length > 0);


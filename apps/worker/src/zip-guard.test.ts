import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inspectZip, MAX_COMPRESSION_RATIO } from './zip-guard.js';

/** 組一個最小的 zip：只放 central directory 與 EOCD，inspectZip 只讀這兩段 */
function makeZip(entries: readonly { name: string; compressed: number; uncompressed: number }[]): Buffer {
  const central: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt32LE(e.compressed, 20);
    head.writeUInt32LE(e.uncompressed, 24);
    head.writeUInt16LE(name.length, 28);
    central.push(Buffer.concat([head, name]));
  }
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(0, 16); // central directory 從 offset 0 開始
  return Buffer.concat([dir, eocd]);
}

describe('inspectZip', () => {
  it('accepts an ordinary document', () => {
    // 一般 .docx：壓縮比個位數
    const r = inspectZip(makeZip([{ name: 'word/document.xml', compressed: 20_000, uncompressed: 120_000 }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.round(r.ratio)).toBe(6);
  });

  it('rejects an absurd compression ratio', () => {
    // 1 KB 解成 1 GB——典型的 zip bomb
    expect(inspectZip(makeZip([{ name: 'bomb.xml', compressed: 1024, uncompressed: 1024 * 1024 * 1024 }]))).toEqual({ ok: false, reason: 'zip_bomb' });
  });

  it('rejects a huge total even when each entry looks reasonable', () => {
    // 每筆比例只有 50 倍（低於上限），但加總遠超過 500 MB
    const entries = Array.from({ length: 60 }, (_, i) => ({ name: `part${i}.xml`, compressed: 200_000, uncompressed: 10_000_000 }));
    expect(inspectZip(makeZip(entries))).toEqual({ ok: false, reason: 'zip_bomb' });
  });

  it('stays just under the ratio limit', () => {
    const r = inspectZip(makeZip([{ name: 'a.xml', compressed: 1000, uncompressed: 1000 * (MAX_COMPRESSION_RATIO - 1) }]));
    expect(r.ok).toBe(true);
  });

  it('reports unreadable archives instead of guessing', () => {
    expect(inspectZip(Buffer.from('not a zip at all'))).toEqual({ ok: false, reason: 'zip_unreadable' });
    expect(inspectZip(Buffer.alloc(0))).toEqual({ ok: false, reason: 'zip_unreadable' });
    // 有 EOCD 但 central directory 指向垃圾
    const broken = makeZip([{ name: 'a', compressed: 1, uncompressed: 1 }]);
    broken.writeUInt32LE(0xdeadbeef, 0);
    expect(inspectZip(broken)).toEqual({ ok: false, reason: 'zip_unreadable' });
  });

  it('handles a real deflate-produced archive shape', () => {
    // 用真的 deflate 壓一段重複內容，確認比例計算符合直覺
    const payload = Buffer.from('a'.repeat(100_000));
    const compressed = deflateRawSync(payload);
    const r = inspectZip(makeZip([{ name: 'x.txt', compressed: compressed.length, uncompressed: payload.length }]));
    // 高度重複的內容壓縮比很高，應該被擋下
    expect(r.ok).toBe(false);
  });
});

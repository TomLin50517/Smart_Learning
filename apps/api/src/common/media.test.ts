import { describe, expect, it } from 'vitest';
import { parseRange } from './http-range.js';
import { sniffMedia } from './media-sniff.js';

describe('parseRange', () => {
  const size = 1000;
  it.each([
    [undefined, null],
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=900-5000', { start: 900, end: 999 }],
    ['bytes=0-0', { start: 0, end: 0 }],
    ['bytes=0-1,5-6', null],
    ['bytes=1000-', 'invalid'],
    ['bytes=50-10', 'invalid'],
    ['bytes=-0', 'invalid'],
    ['bytes=-', 'invalid'],
    ['items=0-1', 'invalid'],
  ])('%s', (header, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe('sniffMedia — by file header, never by name', () => {
  const mp4 = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, 'latin1'), Buffer.alloc(8)]);
  it('recognises browser-playable video', () => {
    expect(sniffMedia(mp4('isom'))).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(sniffMedia(mp4('mp42'))).toEqual({ kind: 'video', mime: 'video/mp4' });
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), Buffer.alloc(8)]);
    expect(sniffMedia(webm)).toEqual({ kind: 'video', mime: 'video/webm' });
  });

  it('recognises images and rejects everything else (QuickTime, Matroska, SVG, text)', () => {
    expect(sniffMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toEqual({ kind: 'image', mime: 'image/png' });
    expect(sniffMedia(mp4('qt  '))).toBeNull();
    expect(sniffMedia(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska', 'latin1')]))).toBeNull();
    expect(sniffMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffMedia(Buffer.from('hello'))).toBeNull();
  });
});

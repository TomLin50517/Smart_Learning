import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv.js';

describe('csvCell', () => {
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvCell('a')).toBe('"a"');
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formulas (CWE-1236)', () => {
    for (const s of ['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(s).startsWith(`"'`)).toBe(true);
    }
    expect(csvCell('safe=value')).toBe('"safe=value"');
  });

  it('serialises null / objects', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(42)).toBe('"42"');
  });
});

describe('toCsv', () => {
  it('starts with a UTF-8 BOM and uses CRLF line endings', () => {
    const csv = toCsv(['h1', 'h2'], [['中文', 1]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('"h1","h2"\r\n"中文","1"\r\n');
  });
});

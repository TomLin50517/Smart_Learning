import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createScanner, DISABLED_SCANNER, parseScanReply, ScanUnavailableError } from './clamav.js';

describe('parseScanReply', () => {
  it('reads clamd verdicts', () => {
    expect(parseScanReply('stream: OK\0')).toEqual({ status: 'clean' });
    expect(parseScanReply('stream: Eicar-Test-Signature FOUND\0')).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('never reports unknown replies as clean', () => {
    // 掃描失敗必須與「乾淨」分開：誤判為乾淨等於沒有掃描
    expect(() => parseScanReply('INSTREAM size limit exceeded. ERROR\0')).toThrow(ScanUnavailableError);
    expect(() => parseScanReply('')).toThrow(ScanUnavailableError);
    expect(() => parseScanReply('something unexpected')).toThrow(ScanUnavailableError);
  });
});

describe('createScanner', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  /** 假的 clamd：收完 INSTREAM 就回一個固定答案，並記下收到的內容 */
  const fakeClamd = (reply: string): Promise<{ port: number; received: () => Buffer }> =>
    new Promise((resolve) => {
      const seen: Buffer[] = [];
      server = createServer((socket) => {
        socket.on('data', (c) => {
          seen.push(c);
          // 收到收尾的 4 個 0 才回覆
          if (c.length >= 4 && c.subarray(c.length - 4).equals(Buffer.from([0, 0, 0, 0]))) {
            socket.end(reply);
          }
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ port: (server!.address() as { port: number }).port, received: () => Buffer.concat(seen) }));
    });

  it('is a no-op when CLAMAV_HOST is not set', () => {
    const s = createScanner({ CLAMAV_HOST: '', CLAMAV_PORT: 3310, CLAMAV_TIMEOUT_MS: 1000 });
    expect(s.enabled).toBe(false);
    expect(s).toBe(DISABLED_SCANNER);
  });

  it('sends the file with length prefixes and reads a clean verdict', async () => {
    const { port, received } = await fakeClamd('stream: OK\0');
    const s = createScanner({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: port, CLAMAV_TIMEOUT_MS: 5000 });
    expect(s.enabled).toBe(true);
    expect(await s.scan(Buffer.from('hello'))).toEqual({ status: 'clean' });

    const sent = received();
    expect(sent.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(sent.readUInt32BE(10)).toBe(5);
    expect(sent.subarray(14, 19).toString()).toBe('hello');
    expect(sent.subarray(19)).toEqual(Buffer.from([0, 0, 0, 0]));
  });

  it('reports the signature when clamd finds something', async () => {
    const { port } = await fakeClamd('stream: Eicar-Test-Signature FOUND\0');
    const s = createScanner({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: port, CLAMAV_TIMEOUT_MS: 5000 });
    expect(await s.scan(Buffer.from('x'))).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('fails loudly when clamd cannot be reached', async () => {
    // 連不上不能當成乾淨——呼叫端要重試，教材留在 scanning
    const s = createScanner({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: 1, CLAMAV_TIMEOUT_MS: 2000 });
    await expect(s.scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScanUnavailableError);
  });
});

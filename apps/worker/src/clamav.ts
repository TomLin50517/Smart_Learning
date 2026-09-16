/**
 * 惡意程式掃描（SA SEQ-06、SD §14）：clamd 的 INSTREAM 掃描，在教材移出 quarantine 之前執行。
 *
 * 未設定 CLAMAV_HOST → 停用（no-op），但呼叫端會記錄「未啟用掃描」——SD §14 要求 hook 可插拔且留痕。
 * 自己寫薄 client：INSTREAM 只是長度前綴協定，不值得為此引入套件（與 search.ts／storage.ts／mailer.ts 同風格）。
 *
 * 協定（clamd.conf 的 TCPSocket）：
 *   送 "zINSTREAM\0"，接著每塊資料為 4 bytes big-endian 長度 + 內容，最後送長度 0 收尾；
 *   回應為 "stream: OK\0"、"stream: <簽章> FOUND\0"，或 "... ERROR\0"。
 */
import { connect, type Socket } from 'node:net';

export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string };

export interface MalwareScanner {
  /** false 時 scan() 不會被呼叫；呼叫端據此記錄「未啟用掃描」 */
  readonly enabled: boolean;
  scan(data: Buffer): Promise<ScanResult>;
}

/** clamd 一次接受的最大塊；預設 StreamMaxLength 為總量上限，與單塊大小無關 */
const CHUNK = 64 * 1024;

/** 掃描本身失敗（連不上、逾時、clamd 回 ERROR）——不是「有病毒」，呼叫端應重試而非退件 */
export class ScanUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanUnavailableError';
  }
}

/** 解析 clamd 的回應字串；未知格式一律視為掃描失敗，不會誤判為乾淨 */
export function parseScanReply(reply: string): ScanResult {
  const line = reply.replace(/\0+$/, '').trim();
  if (/\bOK$/.test(line)) return { status: 'clean' };
  const found = /^stream:\s*(.+?)\s+FOUND$/.exec(line);
  if (found) return { status: 'infected', signature: found[1]! };
  throw new ScanUnavailableError(`clamd replied: ${line.slice(0, 200)}`);
}

export const DISABLED_SCANNER: MalwareScanner = {
  enabled: false,
  scan: () => Promise.reject(new ScanUnavailableError('malware scanning is not configured (CLAMAV_HOST)')),
};

export function createScanner(env: { CLAMAV_HOST: string; CLAMAV_PORT: number; CLAMAV_TIMEOUT_MS: number }): MalwareScanner {
  if (!env.CLAMAV_HOST) return DISABLED_SCANNER;
  return {
    enabled: true,
    scan: (data: Buffer) => instream(env.CLAMAV_HOST, env.CLAMAV_PORT, env.CLAMAV_TIMEOUT_MS, data),
  };
}

function instream(host: string, port: number, timeoutMs: number, data: Buffer): Promise<ScanResult> {
  return new Promise<ScanResult>((resolve, reject) => {
    let socket: Socket;
    let settled = false;
    const chunks: Buffer[] = [];
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    const fail = (e: unknown) => done(() => reject(e instanceof ScanUnavailableError ? e : new ScanUnavailableError(e instanceof Error ? e.message : String(e))));

    try {
      socket = connect({ host, port });
    } catch (e) {
      return reject(new ScanUnavailableError(e instanceof Error ? e.message : String(e)));
    }
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => fail(new ScanUnavailableError(`clamd timed out after ${timeoutMs} ms`)));
    socket.on('error', fail);
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('end', () => {
      try {
        done(() => resolve(parseScanReply(Buffer.concat(chunks).toString('utf8'))));
      } catch (e) {
        fail(e);
      }
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += CHUNK) {
        const slice = data.subarray(i, i + CHUNK);
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(slice.length, 0);
        socket.write(len);
        socket.write(slice);
      }
      socket.write(Buffer.from([0, 0, 0, 0]));
    });
  });
}

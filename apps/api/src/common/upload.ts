import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { PLATFORM_SETTINGS } from '@iac/contracts';
import type pg from 'pg';
import { DomainError } from './domain-error.js';

/** 判斷格式用的檔頭長度 */
export const HEAD_BYTES = 8192;

export interface ReceivedUpload {
  /** 暫存檔路徑；用完由呼叫端 rm */
  path: string;
  size: number;
  sha256: string;
  head: Buffer;
}

/** 平台設定的單檔上限（未設定時用預設值；SD §8.11 upload.max_size） */
export async function maxUploadBytes(db: pg.Pool): Promise<number> {
  const r = await db.query<{ value: unknown }>(`SELECT value FROM system_settings WHERE scope_type = 'platform' AND scope_id IS NULL AND key = 'upload.max_size'`);
  const v = Number(r.rows[0]?.value);
  return Number.isFinite(v) && v > 0 ? v : PLATFORM_SETTINGS['upload.max_size'].default;
}

/**
 * 檔案上傳（application/octet-stream 串流，bootstrap 註冊的 parser）：寫入暫存檔，邊算大小與 SHA-256、留下檔頭。
 * 超過上限就停止寫入並刪檔，但把剩下的本體讀完丟棄——中途切斷請求的話回應送不出去，
 * 使用者只會看到連線中斷而不是「檔案太大」（413）。本體總量另受 nginx client_max_body_size 限制。
 */
export async function receiveUpload(body: Readable, max: number): Promise<ReceivedUpload> {
  const path = join(tmpdir(), `iac-upload-${randomUUID()}`);
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headLen = 0;
  let size = 0;
  let tooLarge = false;
  const out = createWriteStream(path);
  try {
    for await (const raw of body) {
      if (tooLarge) continue;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      size += chunk.length;
      if (size > max) {
        tooLarge = true;
        out.destroy();
        continue;
      }
      hash.update(chunk);
      if (headLen < HEAD_BYTES) {
        head.push(chunk);
        headLen += chunk.length;
      }
      if (!out.write(chunk)) await once(out, 'drain');
    }
    if (!tooLarge) {
      out.end();
      await finished(out);
    }
  } catch (e) {
    out.destroy();
    await rm(path, { force: true });
    throw e;
  }
  if (tooLarge || size === 0) {
    await rm(path, { force: true });
    throw tooLarge ? new DomainError('UPLOAD_TOO_LARGE', `File exceeds ${max} bytes`) : new DomainError('VALIDATION_FAILED', 'file: empty', [{ field: 'file', issue: 'empty' }]);
  }
  return { path, size, sha256: hash.digest('hex'), head: Buffer.concat(head).subarray(0, HEAD_BYTES) };
}

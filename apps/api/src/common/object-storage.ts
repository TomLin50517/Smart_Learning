import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Env } from '../config/env.js';
import { DomainError } from './domain-error.js';

/**
 * 物件儲存（SD §5）：教材原始檔與擷取文字。存取一律經伺服器（不發給瀏覽器直連網址）。
 * worker 有同介面的實作（apps/worker/src/storage.ts）。
 */
export interface ObjectStorage {
  put(key: string, body: Buffer | Readable, opts: { contentType: string; contentLength?: number }): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** 讀取 [start, end]（含兩端）的串流——影片的 Range 請求 */
  openRange(key: string, start: number, end: number): Promise<Readable>;
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** MinIO／S3 相容服務 */
export class S3ObjectStorage implements ObjectStorage {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  /** 第一次寫入前確認 bucket 存在（不存在就建立） */
  private ensureBucket(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      }
    })().catch((e: unknown) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  async put(key: string, body: Buffer | Readable, opts: { contentType: string; contentLength?: number }): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: opts.contentType, ...(opts.contentLength !== undefined && { ContentLength: opts.contentLength }) }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  async openRange(key: string, start: number, end: number): Promise<Readable> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }));
    // Node 環境下 Body 是 Readable
    return r.Body as Readable;
  }

  async copy(from: string, to: string): Promise<void> {
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${from}` }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ...(token && { ContinuationToken: token }) }));
      const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }
}

/** 未設定物件儲存：上傳與預覽回 503，其餘功能不受影響 */
export class UnavailableObjectStorage implements ObjectStorage {
  private fail(): never {
    throw new DomainError('SOURCE_TEMPORARILY_UNAVAILABLE', 'Object storage is not configured (S3_ENDPOINT)');
  }
  put(): Promise<void> {
    this.fail();
  }
  get(): Promise<Buffer> {
    this.fail();
  }
  openRange(): Promise<Readable> {
    this.fail();
  }
  copy(): Promise<void> {
    this.fail();
  }
  delete(): Promise<void> {
    this.fail();
  }
  deletePrefix(): Promise<void> {
    this.fail();
  }
}

/** 測試用：記憶體內（api 與 worker 的測試共用同一個實例） */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer | Readable, opts: { contentType: string }): Promise<void> {
    let buf: Buffer;
    if (Buffer.isBuffer(body)) buf = body;
    else {
      const parts: Buffer[] = [];
      for await (const c of body) parts.push(Buffer.from(c as Uint8Array));
      buf = Buffer.concat(parts);
    }
    this.objects.set(key, { body: buf, contentType: opts.contentType });
  }

  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`NoSuchKey: ${key}`);
    return o.body;
  }

  async openRange(key: string, start: number, end: number): Promise<Readable> {
    return Readable.from([(await this.get(key)).subarray(start, end + 1)]);
  }

  async copy(from: string, to: string): Promise<void> {
    this.objects.set(to, { ...(this.objects.get(from) ?? { body: Buffer.alloc(0), contentType: 'application/octet-stream' }) });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) this.objects.delete(k);
  }
}

export function createObjectStorage(env: Env): ObjectStorage {
  if (!env.S3_ENDPOINT) return new UnavailableObjectStorage();
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
  return new S3ObjectStorage(client, env.S3_BUCKET);
}

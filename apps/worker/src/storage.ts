import type { Readable } from 'node:stream';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * worker 的物件儲存（與 apps/api/src/common/object-storage.ts 同介面；worker 的 TS 專案不引用 api 原始碼）。
 */
export interface ObjectStorage {
  put(key: string, body: Buffer | Readable, opts: { contentType: string; contentLength?: number }): Promise<void>;
  get(key: string): Promise<Buffer>;
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createWorkerStorage(env: { S3_ENDPOINT: string; S3_REGION: string; S3_BUCKET: string; S3_ACCESS_KEY: string; S3_SECRET_KEY: string }): ObjectStorage {
  if (!env.S3_ENDPOINT) {
    const fail = (): never => {
      throw new Error('object storage is not configured (S3_ENDPOINT)');
    };
    return { put: fail, get: fail, copy: fail, delete: fail };
  }
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
  const Bucket = env.S3_BUCKET;
  return {
    async put(key, body, opts) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: opts.contentType, ...(opts.contentLength !== undefined && { ContentLength: opts.contentLength }) }));
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
    async copy(from, to) {
      await client.send(new CopyObjectCommand({ Bucket, Key: to, CopySource: `${Bucket}/${from}` }));
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

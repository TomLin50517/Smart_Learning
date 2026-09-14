import { hostname } from 'node:os';
import pg from 'pg';
import { pino } from 'pino';
import { z } from 'zod';
import { Dispatcher } from './dispatcher.js';
import { CertificateGenerateHandler } from './handlers/certificate-generate.js';
import { DocumentParseHandler } from './handlers/document-parse.js';
import { createWorkerStorage } from './storage.js';

const env = z
  .object({
    DATABASE_URL_WORKER: z.string().min(1),
    WORKER_QUEUES: z.string().default('ingest,ai,output'),
    WORKER_ID: z.string().default(`${hostname()}-${process.pid}`),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(1_000),
    LOG_LEVEL: z.string().default('info'),
    // 物件儲存（SD §5）：教材解析需要
    S3_ENDPOINT: z.string().default(''),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('iac-data'),
    S3_ACCESS_KEY: z.string().default(''),
    S3_SECRET_KEY: z.string().default(''),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { service: 'worker', worker_id: env.WORKER_ID } });
const db = new pg.Pool({ connectionString: env.DATABASE_URL_WORKER, max: 5, application_name: 'iac-worker' });
const storage = createWorkerStorage(env);

const dispatcher = new Dispatcher(db, log, {
  workerId: env.WORKER_ID,
  queues: env.WORKER_QUEUES.split(',').map((q) => q.trim()).filter(Boolean),
  pollIntervalMs: env.WORKER_POLL_MS,
});
// Handlers 依 SD §11.1 的 job 目錄於各 Phase 加入
dispatcher.register(new CertificateGenerateHandler(db));
dispatcher.register(new DocumentParseHandler(db, storage));

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  await dispatcher.stop();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

dispatcher.start().catch((err: unknown) => {
  log.fatal({ err }, 'worker crashed');
  process.exit(1);
});

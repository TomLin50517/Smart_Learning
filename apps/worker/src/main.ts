import { hostname } from 'node:os';
import pg from 'pg';
import { pino } from 'pino';
import { z } from 'zod';
import { Dispatcher } from './dispatcher.js';
import { createScanner } from './clamav.js';
import { createOcrEngine } from './ocr.js';
import { CertificateGenerateHandler } from './handlers/certificate-generate.js';
import { DerivedIndexHandler } from './handlers/derived-index.js';
import { DocumentIndexHandler } from './handlers/document-index.js';
import { DocumentParseHandler } from './handlers/document-parse.js';
import { DocumentSyncHandler } from './handlers/document-sync.js';
import { NotificationEmailHandler } from './handlers/notification-email.js';
import { createWorkerMailer } from './mailer.js';
import { createWorkerSearch } from './search.js';
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
    // Elasticsearch（SD §4）：教材索引
    ELASTICSEARCH_URL: z.string().default(''),
    ELASTICSEARCH_API_KEY: z.string().default(''),
    ELASTICSEARCH_USERNAME: z.string().default(''),
    ELASTICSEARCH_PASSWORD: z.string().default(''),
    // Email 通知（SD §6.26）：與 API 相同的 SMTP_* 設定（§8.10、ADR-031）；PUBLIC_BASE_URL 用來組信中的連結
    NODE_ENV: z.string().default('development'),
    PUBLIC_BASE_URL: z.string().min(1).default('http://localhost:8080'),
    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z.stringbool().default(false),
    SMTP_REQUIRE_TLS: z.stringbool().default(true),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_FROM: z.string().default(''),
    // 惡意程式掃描（SD §14、SA SEQ-06）：未設定 CLAMAV_HOST 則跳過掃描（啟動時會記錄）
    CLAMAV_HOST: z.string().default(''),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    CLAMAV_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    // 掃描版 PDF 的 OCR（SD §6.30）：需要 worker image（--target worker）的 tesseract 與 poppler-utils。
    // 預設關閉——啟用卻沒有工具時 job 會明確失敗，不會把辨識失敗誤當成「沒有文字」
    OCR_ENABLED: z.stringbool().default(false),
    OCR_DPI: z.coerce.number().int().min(72).max(600).default(300),
    OCR_LANGUAGES: z.string().default('chi_tra+eng'),
    OCR_MAX_PAGES: z.coerce.number().int().positive().max(500).default(50),
    OCR_PAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    // 證書 PDF（SD §6.28）：中文字型（Noto Sans TC，SIL OFL）隨 image 一起提供
    CERTIFICATE_FONT_PATH: z.string().default('assets/fonts/NotoSansTC[wght].ttf'),
  })
  .superRefine((v, ctx) => {
    if (v.SMTP_HOST && !/@[^@\s>]+/.test(v.SMTP_FROM)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_FROM'], message: 'required when SMTP_HOST is set (e.g. "Name <no-reply@example.com>")' });
    }
    if (v.SMTP_USER && !v.SMTP_PASSWORD) ctx.addIssue({ code: 'custom', path: ['SMTP_PASSWORD'], message: 'required when SMTP_USER is set' });
    if (v.NODE_ENV === 'production' && v.SMTP_HOST && !v.SMTP_SECURE && !v.SMTP_REQUIRE_TLS) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_REQUIRE_TLS'], message: 'plaintext SMTP is not allowed in production' });
    }
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { service: 'worker', worker_id: env.WORKER_ID } });
const db = new pg.Pool({ connectionString: env.DATABASE_URL_WORKER, max: 5, application_name: 'iac-worker' });
const storage = createWorkerStorage(env);
const search = createWorkerSearch(env);
const mailer = createWorkerMailer(env);
const scanner = createScanner(env);
if (!scanner.enabled) log.warn('CLAMAV_HOST is not set — uploaded documents will NOT be scanned for malware');
const ocr = createOcrEngine({
  enabled: env.OCR_ENABLED,
  dpi: env.OCR_DPI,
  languages: env.OCR_LANGUAGES,
  maxPages: env.OCR_MAX_PAGES,
  pageTimeoutMs: env.OCR_PAGE_TIMEOUT_MS,
});
if (!mailer && env.NODE_ENV === 'production') log.warn('SMTP_HOST is not set — notification emails will NOT be sent');

const dispatcher = new Dispatcher(db, log, {
  workerId: env.WORKER_ID,
  queues: env.WORKER_QUEUES.split(',').map((q) => q.trim()).filter(Boolean),
  pollIntervalMs: env.WORKER_POLL_MS,
});
// Handlers 依 SD §11.1 的 job 目錄於各 Phase 加入
dispatcher.register(new CertificateGenerateHandler(db, storage, { fontPath: env.CERTIFICATE_FONT_PATH, baseUrl: env.PUBLIC_BASE_URL }));
dispatcher.register(new DocumentParseHandler(db, storage, { scanner, ocr }));
dispatcher.register(new DocumentIndexHandler(db, storage, search));
dispatcher.register(new DocumentSyncHandler(db, search));
dispatcher.register(new DerivedIndexHandler(db, search));
dispatcher.register(new NotificationEmailHandler(db, mailer, log, env.PUBLIC_BASE_URL));

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  await dispatcher.stop();
  mailer?.close();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

dispatcher.start().catch((err: unknown) => {
  log.fatal({ err }, 'worker crashed');
  process.exit(1);
});

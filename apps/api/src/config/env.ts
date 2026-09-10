import { z } from 'zod';

/**
 * 環境變數驗證（SD §9.3）。缺必填即拒絕啟動（fail fast）。
 * Phase 2 起才需要的（ES / S3 / SMTP）在此為選填。
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),
  DATABASE_URL_COACH: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_MAX_COACH: z.coerce.number().int().positive().default(8),

  SESSION_COOKIE_NAME: z.string().min(1).default('iac_session'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  LICENSE_PUBLIC_KEY: z.string().optional().default(''),
  /** 覆寫硬體 fingerprint；僅供測試與容器化環境使用 */
  LICENSE_FINGERPRINT_OVERRIDE: z.string().optional(),
  LICENSE_GRACE_DAYS: z.coerce.number().int().nonnegative().default(14),

  ELASTICSEARCH_URL: z.string().optional().default(''),
  AI_PROVIDER: z.enum(['none', 'openai', 'azure_openai', 'internal']).default('none'),
  AI_DAILY_TOKEN_BUDGET_DEFAULT: z.coerce.number().int().positive().default(200_000),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');

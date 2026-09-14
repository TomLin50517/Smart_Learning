import { z } from 'zod';

/**
 * 環境變數驗證（SD §9.3）。缺必填即拒絕啟動（fail fast）。
 * Phase 2 起才需要的（ES / S3 / SMTP）在此為選填。
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  /** 對外網址，用於密碼重設連結 */
  PUBLIC_BASE_URL: z.string().min(1).default('http://localhost:8080'),
  /**
   * 是否信任 X-Forwarded-For。預設 false：API 直接對外時，client 可偽造此 header
   * 以規避 IP 流量限制並污染 audit 的 actor_ip。位於 nginx 後方時設為 1（信任一層代理）。
   */
  TRUST_PROXY: z.string().default('false'),

  DATABASE_URL: z.string().min(1),
  DATABASE_URL_COACH: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_MAX_COACH: z.coerce.number().int().positive().default(8),

  // --- Session / Cookie（SD §8.1、§8.2）---------------------------------------
  SESSION_COOKIE_NAME: z.string().min(1).default('iac_session'),
  CSRF_COOKIE_NAME: z.string().min(1).default('iac_csrf'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  /** 絕對到期；refresh 輪替 token 但不延長 */
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(30),
  /** 僅在本機純 HTTP 除錯時設為 false */
  COOKIE_SECURE: z.stringbool().default(true),

  // --- 登入保護 / 密碼重設（SD §8.1）-----------------------------------------
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().positive().default(15),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().positive().default(30),
  /** 組織邀請的「設定密碼」連結有效期 */
  INVITATION_TTL_HOURS: z.coerce.number().positive().default(72),

  // --- License（SD §8.4）-------------------------------------------------------
  /**
   * 僅限非正式環境：覆寫內建的供應方 public key／硬體 fingerprint（開發、測試用）。
   * 正式環境設定即拒絕啟動——public key 若可由部署設定替換，客戶即可自簽任意授權；
   * fingerprint 若可覆寫，硬體綁定形同虛設。
   */
  LICENSE_PUBLIC_KEY_OVERRIDE: z.string().optional(),
  LICENSE_FINGERPRINT_OVERRIDE: z.string().optional(),
  LICENSE_GRACE_DAYS: z.coerce.number().int().nonnegative().default(14),
  /** 供應方線上啟用服務；未設定時只能離線啟用（SEQ-09） */
  LICENSE_ACTIVATION_URL: z.string().optional().default(''),
  LICENSE_CHALLENGE_TTL_HOURS: z.coerce.number().positive().default(168),

  // --- SMTP（SD §8.10）：未設定 SMTP_HOST 則不寄信（LogOnlyMailer）----------------
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true = 隱式 TLS（通常 465）；false = 明文連線後以 STARTTLS 升級 */
  SMTP_SECURE: z.stringbool().default(false),
  /** SMTP_SECURE=false 時要求 STARTTLS；伺服器不支援即拒絕寄出。正式環境不可關閉（信件含 token） */
  SMTP_REQUIRE_TLS: z.stringbool().default(true),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  /** 寄件者，例如 "Learning Platform <no-reply@example.com>" */
  SMTP_FROM: z.string().optional().default(''),

  // --- 物件儲存（SD §5）：未設定 S3_ENDPOINT 時教材上傳與預覽回 503，其餘功能正常 --------
  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('iac-data'),
  S3_ACCESS_KEY: z.string().optional().default(''),
  S3_SECRET_KEY: z.string().optional().default(''),

  ELASTICSEARCH_URL: z.string().optional().default(''),
  AI_PROVIDER: z.enum(['none', 'openai', 'azure_openai', 'internal']).default('none'),
  AI_DAILY_TOKEN_BUDGET_DEFAULT: z.coerce.number().int().positive().default(200_000),
}).superRefine((v, ctx) => {
  // SMTP 設定一致性（所有環境）：設了主機就必須能寄出
  if (v.SMTP_HOST) {
    if (!/@[^@\s>]+/.test(v.SMTP_FROM)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_FROM'], message: 'required when SMTP_HOST is set (e.g. "Name <no-reply@example.com>")' });
    }
    if (v.SMTP_USER && !v.SMTP_PASSWORD) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_PASSWORD'], message: 'required when SMTP_USER is set' });
    }
  }

  // 正式環境的安全底線：違反即拒絕啟動，而不是帶著不安全設定上線
  if (v.NODE_ENV !== 'production') return;
  if (v.SMTP_HOST && !v.SMTP_SECURE && !v.SMTP_REQUIRE_TLS) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_REQUIRE_TLS'], message: 'plaintext SMTP is not allowed in production (emails carry one-time tokens)' });
  }
  for (const key of ['LICENSE_PUBLIC_KEY_OVERRIDE', 'LICENSE_FINGERPRINT_OVERRIDE'] as const) {
    if (v[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'not allowed in production (license integrity, SD §8.4)' });
  }
  if (v.LICENSE_ACTIVATION_URL && !v.LICENSE_ACTIVATION_URL.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['LICENSE_ACTIVATION_URL'], message: 'must use https in production' });
  }
  if (!v.COOKIE_SECURE) {
    ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'must be true in production' });
  }
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

export type TrustProxySetting = boolean | string[] | ((address: string, hop: number) => boolean);

/**
 * TRUST_PROXY 字串 → Fastify trustProxy 設定。
 * - 'false' / ''：不信任（預設）
 * - 'true'：信任所有代理（僅限確定前面一定有代理且不可繞過時）
 * - 數字 N：信任最近的 N 層代理（Fastify 型別不接受數字，因此轉為等義的函式）
 * - 逗號分隔：信任的代理 IP / CIDR 清單
 */
export function parseTrustProxy(v: string): TrustProxySetting {
  const s = v.trim();
  if (s === 'true') return true;
  if (s === 'false' || s === '') return false;
  if (/^\d+$/.test(s)) {
    const hops = Number(s);
    return (_address: string, hop: number) => hop < hops;
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

export const ENV = Symbol('ENV');

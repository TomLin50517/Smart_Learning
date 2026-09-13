/**
 * 錯誤碼目錄（ARCH §29、SA §12.3）。
 * HTTP 狀態與代碼一一對應；使用者可見文案由前端依 code 在地化。
 */
export const ERROR_CODES = {
  // --- 通用 -----------------------------------------------------------------
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  /** 已登入的狀態變更請求缺少或帶錯 X-CSRF-Token（SD §8.2） */
  CSRF_TOKEN_INVALID: 403,
  ORG_SCOPE_DENIED: 403,
  /** 不存在「或」不在可視 scope——刻意合併，避免 ID 探測（ADR-019） */
  NOT_FOUND: 404,
  /** request body / query 不符 schema */
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  /** 密碼重設連結無效、已使用或已過期 */
  PASSWORD_RESET_TOKEN_INVALID: 422,
  INTERNAL_ERROR: 500,

  // --- 課程 / 學習 ----------------------------------------------------------
  COURSE_VERSION_IMMUTABLE: 409,
  COURSE_VALIDATION_FAILED: 422,
  ENROLLMENT_NOT_ACTIVE: 409,
  ACTIVITY_PREREQUISITE_NOT_MET: 403,
  ACTIVITY_INPUT_INVALID: 422,
  RESULT_NOT_READY: 409,

  // --- 知識 / 來源 ----------------------------------------------------------
  SOURCE_ACCESS_DENIED: 403,
  SOURCE_TEMPORARILY_UNAVAILABLE: 503,
  UPLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,

  // --- AI Coach -------------------------------------------------------------
  /** body 內狀態，HTTP 200 */
  COACH_INSUFFICIENT_EVIDENCE: 200,
  /** body 內狀態，HTTP 200 */
  COACH_RESPONSE_VALIDATION_FAILED: 200,
  COACH_PROVIDER_UNAVAILABLE: 503,
  COACH_TRANSCRIPT_NOT_VISIBLE: 403,
  TRANSCRIPT_VISIBILITY_IMMUTABLE: 409,
  AI_QUOTA_EXCEEDED: 429,

  // --- License --------------------------------------------------------------
  LICENSE_NOT_ACTIVATED: 403,
  LICENSE_EXPIRED: 403,
  LICENSE_CONFIG_FROZEN: 403,
  LICENSE_FEATURE_DISABLED: 403,
  LICENSE_LIMIT_EXCEEDED: 403,
  LICENSE_HARDWARE_MISMATCH: 403,
  LICENSE_SIGNATURE_INVALID: 403,
  LICENSE_CHALLENGE_INVALID: 403,
  LICENSE_ACTIVATION_REJECTED: 403,
  /** 線上啟用服務未設定或無法連線——改用離線啟用 */
  LICENSE_ACTIVATION_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** ARCH §29 錯誤回應格式 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    correlation_id: string;
    details?: ErrorDetail[];
  };
}

/**
 * 錯誤細節。issue 為穩定代碼；params 為前端組文案用的少量資料（例如衝突對象的名稱），
 * 只放呼叫者本來就有權檢視的內容，永不回顯使用者輸入的原值。
 */
export interface ErrorDetail {
  field?: string;
  issue: string;
  params?: Record<string, string>;
}

import type { ErrorCode } from '@iac/contracts';

/**
 * 業務錯誤。由 AppExceptionFilter 轉為 ARCH §29 的錯誤格式，
 * HTTP 狀態由 ERROR_CODES 決定——應用程式碼不直接處理狀態碼。
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: { field?: string; issue: string }[],
    /** RATE_LIMITED 時帶出 Retry-After（秒） */
    readonly options: { retryAfterSec?: number } = {},
  ) {
    super(message ?? code);
    this.name = 'DomainError';
  }
}

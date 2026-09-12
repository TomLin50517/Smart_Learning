import type { ErrorCode } from '@iac/contracts';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR';

export interface ErrorDetail {
  field?: string;
  issue: string;
}

/** API 錯誤（ARCH §29 錯誤格式）。message 為伺服器的英文訊息，只供除錯；畫面文案一律由 code 在地化 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly correlationId: string | null,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 使用者可見文案（SA §12.3）。型別為 Record<ErrorCode, …>：
 * contracts 新增錯誤碼時這裡會編譯失敗，確保不會漏翻。
 */
export const ERROR_MESSAGES: Record<ClientErrorCode, string> = {
  NETWORK_ERROR: '無法連線到伺服器，請檢查網路後再試一次。',
  UNAUTHENTICATED: '請先登入，或登入已逾時。',
  PERMISSION_DENIED: '您沒有執行此操作的權限。',
  CSRF_TOKEN_INVALID: '頁面安全驗證已失效，請重新整理後再試一次。',
  ORG_SCOPE_DENIED: '您沒有此組織的存取權限。',
  NOT_FOUND: '找不到指定的資料，可能已被移除或您沒有檢視權限。',
  VALIDATION_FAILED: '輸入內容有誤，請檢查後再試一次。',
  RATE_LIMITED: '嘗試次數過多，請稍後再試。',
  PASSWORD_RESET_TOKEN_INVALID: '連結無效、已使用或已過期，請重新申請。',
  INTERNAL_ERROR: '系統發生錯誤，請稍後再試。',
  COURSE_VERSION_IMMUTABLE: '已發布的課程版本不可修改。',
  COURSE_VALIDATION_FAILED: '課程內容未通過驗證。',
  ENROLLMENT_NOT_ACTIVE: '目前的選課狀態無法進行學習。',
  ACTIVITY_PREREQUISITE_NOT_MET: '尚未完成此活動的先修條件。',
  ACTIVITY_INPUT_INVALID: '作答內容格式不正確。',
  RESULT_NOT_READY: '結果仍在處理中，請稍後再查看。',
  SOURCE_ACCESS_DENIED: '您沒有檢視此來源資料的權限。',
  SOURCE_TEMPORARILY_UNAVAILABLE: '來源資料暫時無法開啟，請稍後再試。',
  UPLOAD_TOO_LARGE: '檔案超過大小上限。',
  UNSUPPORTED_MEDIA_TYPE: '不支援此檔案格式。',
  COACH_INSUFFICIENT_EVIDENCE: '教材中找不到足夠的依據回答這個問題。',
  COACH_RESPONSE_VALIDATION_FAILED: 'AI 回覆未通過驗證，請換個方式提問。',
  COACH_PROVIDER_UNAVAILABLE: 'AI 學習教練暫時無法使用；課程學習不受影響。',
  COACH_TRANSCRIPT_NOT_VISIBLE: '依組織政策，您無法檢視此對話紀錄。',
  TRANSCRIPT_VISIBILITY_IMMUTABLE: '對話紀錄可見性設定已確定，無法再變更。',
  AI_QUOTA_EXCEEDED: '今日的 AI 使用額度已用完。',
  LICENSE_NOT_ACTIVATED: '系統尚未啟用授權。',
  LICENSE_EXPIRED: '授權已到期。',
  LICENSE_CONFIG_FROZEN: '授權維護期已過，設定目前為唯讀。',
  LICENSE_FEATURE_DISABLED: '目前的授權未包含此功能。',
  LICENSE_LIMIT_EXCEEDED: '已達授權的數量上限。',
  LICENSE_HARDWARE_MISMATCH: '授權與這台主機不符。',
  LICENSE_SIGNATURE_INVALID: '授權檔簽章無效，請確認檔案完整且來自供應方。',
  LICENSE_CHALLENGE_INVALID: '啟用請求碼無效或已過期，請重新產生。',
  LICENSE_ACTIVATION_REJECTED: '供應方拒絕了此啟用要求。',
  LICENSE_ACTIVATION_UNAVAILABLE: '線上啟用服務無法使用，請改用離線啟用。',
};

const FIELD_LABELS: Record<string, string> = {
  email: 'Email',
  password: '密碼',
  newPassword: '新密碼',
  token: '連結',
  code: '代碼',
  name: '名稱',
  displayName: '顯示名稱',
  role: '角色',
  roles: '角色',
  courseId: '課程',
  licenseFile: '授權檔',
  activationCode: '啟用碼',
  from: '開始時間',
  to: '結束時間',
  action: '動作',
  cursor: '分頁位置',
  limit: '每頁筆數',
  organizationId: '組織',
};

/** 伺服器 details.issue → 文案。未列出的沿用原文（多為 zod 的驗證訊息） */
const ISSUE_MESSAGES: Record<string, string> = {
  already_exists: '已被使用',
  already_member: '已是此組織的成員',
  last_org_admin: '組織至少需要保留一位管理員',
  not_in_organization: '不屬於此組織',
  range_too_large: '日期區間最多 366 天',
  too_many_rows: '符合條件的紀錄超過 50,000 筆，請縮小日期區間或加上動作篩選',
  invalid: '格式不正確',
  must_be_after_from: '結束時間必須晚於開始時間',
  nothing_to_update: '沒有需要更新的內容',
  course_id_mismatch: '課程角色必須指定課程，其他角色不可指定課程',
  course_not_in_organization: '課程不屬於此組織',
};

export function describeDetail(d: ErrorDetail): string {
  const label = d.field ? (FIELD_LABELS[d.field.split('.')[0] ?? ''] ?? d.field) : '';
  const issue = ISSUE_MESSAGES[d.issue] ?? d.issue;
  return label ? `${label}：${issue}` : issue;
}

export interface DescribedError {
  message: string;
  details: string[];
  /** 提供給管理者追查的 correlation id */
  reference: string | null;
}

export function describeError(e: unknown): DescribedError {
  if (e instanceof ApiError) {
    return { message: ERROR_MESSAGES[e.code] ?? ERROR_MESSAGES.INTERNAL_ERROR, details: e.details.map(describeDetail), reference: e.correlationId };
  }
  return { message: ERROR_MESSAGES.INTERNAL_ERROR, details: [], reference: null };
}

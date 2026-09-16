import type { ErrorCode } from '@iac/contracts';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR';

export interface ErrorDetail {
  field?: string;
  issue: string;
  /** 文案中的 {name} 以此代入（例如衝突課程的名稱） */
  params?: Record<string, string>;
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
  AI_QUOTA_EXCEEDED: 'AI 教練休息中（今日額度已用完），請稍後再試。',
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
  currentPassword: '目前的密碼',
  summary: '簡介',
  navigationMode: '學習順序',
  modules: '課程結構',
  interactiveDefinitionId: '互動元件',
  activityId: '活動',
  isRequired: '必修',
  maxAttempts: '作答次數上限',
  weight: '權重',
  maxScore: '滿分',
  config: '設定',
  answerKey: '答案',
  prerequisite: '先修條件',
  locale: '語言',
  from: '開始時間',
  to: '結束時間',
  action: '動作',
  cursor: '分頁位置',
  limit: '每頁筆數',
  organizationId: '組織',
  coachPolicy: 'AI 教練設定',
  knowledgeBindings: '教材綁定',
  reason: '原因',
  note: '備註',
  memberNo: '學號',
  cohortIds: '班級',
  cohortId: '班級',
  cohort: '班級',
  term: '學年／期別',
  customColor: '自訂主色',
  platformName: '平台名稱',
  dataBase64: '圖片',
};

/** 伺服器 details.issue → 文案。未列出的沿用原文（多為 zod 的驗證訊息） */
const ISSUE_MESSAGES: Record<string, string> = {
  already_exists: '已被使用',
  already_member: '已是此組織的成員',
  last_org_admin: '組織至少需要保留一位管理員',
  cannot_remove_own_admin: '不能取消自己的組織管理員角色，請由其他組織管理員處理',
  cannot_disable_self: '不能停用自己的成員資格',
  member_disabled: '此成員在本組織已停用，請先到「成員管理」恢復',
  not_archived: '課程未封存，不需要恢復',
  code_in_use: '已被課程「{title}」使用',
  not_in_organization: '不屬於此組織',
  range_too_large: '日期區間最多 366 天',
  too_many_rows: '符合條件的紀錄超過 50,000 筆，請縮小日期區間或加上動作篩選',
  invalid: '格式不正確',
  unrecognized_key: '不支援此欄位',
  draft_exists: '這門課已有編輯中的版本，請先完成或發布它',
  course_archived: '課程已封存',
  source_not_published: '只能複製已發布或已被取代的版本',
  duplicate_id: '項目識別碼重複',
  activity_not_in_lesson: '引用的活動不在這個課節中',
  id_conflict: '識別碼已被其他版本使用',
  unknown_interactive_definition: '互動元件不存在或已停用',
  interactive_requires_definition: '互動活動必須選擇互動元件',
  too_many_activities: '活動總數超過上限',
  json_too_large: '內容過大',
  invalid_code: '只能使用英數字、連字號與底線，且須以英數字開頭',
  incorrect: '目前的密碼不正確',
  same_as_current: '新密碼不可與目前的密碼相同',
  org_has_active_admin: '此組織仍有啟用中的管理員，不需要復原；請聯絡該管理員新增成員',
  user_not_active: '此帳號已停用',
  invalid_value: '不支援的選項',
  too_small: '數值太小',
  too_big: '數值太大',
  invalid_type: '格式不正確',
  must_be_after_from: '結束時間必須晚於開始時間',
  nothing_to_update: '沒有需要更新的內容',
  course_id_mismatch: '課程角色必須指定課程，其他角色不可指定課程',
  course_not_in_organization: '課程不屬於此組織',
  duplicate: '不可重複',
  already_enrolled: '已在這門課程中',
  course_not_published: '課程尚未發布，發布後才能加入學員',
  invalid_transition: '目前的選課狀態無法進行此操作',
  code_not_found: '找不到這個選課碼，請確認是否輸入正確',
  enrollment_closed: '目前不在開放加入的期間',
  course_full: '名額已滿',
  must_be_after_opens: '截止日必須晚於開放日',
  export_too_many_rows: '學員超過 {max} 位，請用班級或狀態篩選後分批匯出',
  scope_not_in_version: '找不到這個範圍，或範圍內沒有活動（須在學員目前的課程版本中）',
  scope_required: '請選擇要重修的單元、課節或活動',
  scope_must_be_empty: '整門課重修不需要指定範圍',
  faq_exists: '這個線索已經建立過常見問答或常見錯誤',
  faq_retired: '這一則已下架，無法修改',
  course_has_no_version: '課程還沒有任何版本，請先建立版本',
  pdf_not_ready: '這張證書還沒有 PDF（發證時物件儲存不可用）；可以先用列印功能',
  backup_in_progress: '已經有一個備份在進行中，請等它完成',
  approver_role_required: '只有完成條件指定的核可者可以核可',
  already_approved: '你已經核可過了',
  approval_not_required: '這門課的完成條件不需要人工核可',
  not_revocable: '只有有效的證書可以撤銷',
  member_no_taken: '已被其他成員使用',
  cohort_not_found: '找不到這個班級，或班級已封存',
  cohort_already_archived: '班級已經封存',
  cohort_not_archived: '班級未封存，不需要恢復',
  cohort_empty: '這個班級目前沒有成員',
  cohort_too_large: '班級人數超過 500 人，請改用批次匯入分批加入',
  color_contrast_too_low: '顏色太淺，與白字的對比度只有 {ratio}（需達 4.5）',
  image_too_large: '圖片超過 512 KB',
  unsupported_image_type: '只接受 PNG、JPG 或 WebP（不接受 SVG）',
  document_in_use: '已發布的課程版本仍在使用這份教材，無法刪除；可以在草稿版本中移出',
  document_not_in_course: '只能加入本課程的教材',
  document_already_bound: '這份教材已經在此版本中',
  document_not_usable: '這份教材格式不符或已下架，無法加入',
  not_processed: '教材尚未處理完成',
  not_failed: '只有處理失敗的教材可以重試',
  empty: '檔案是空的',
  provider_unavailable: '平台尚未設定 AI 服務',
  search_unavailable: '教材搜尋服務尚未啟用',
  disabled_by_organization: '組織已停用 AI 教練',
  enrollment_inactive: '目前的選課狀態無法使用 AI 教練',
  not_in_course_version: '這個活動不屬於此課程版本',
  no_result: '這次作答還沒有結果',
  asset_in_use: '這個素材正被課程版本（{versions}）使用，無法刪除；請先從課程內容移除',
  organization_key_missing: '組織尚未設定 AI 金鑰，請聯絡平台管理員',
  quota_exceeded: '今日的 AI 使用額度已用完',
  encryption_key_missing: '伺服器尚未設定加密主金鑰（AI_KEY_ENCRYPTION_KEY），無法儲存金鑰',
  organization_policy: '組織目前不開放課程人員查看對話紀錄',
  conversation_stamp: '這段對話開始時設定為不公開，無法查看',
  // 完成條件驗證（SD §3.6）：伺服器於 params.message 附上具體說明
  RULE_SCHEMA_INVALID: '{message}',
  RULE_DEPTH_EXCEEDED: '{message}',
  RULE_TOO_COMPLEX: '{message}',
  RULE_REFERENCE_NOT_FOUND: '{message}',
  RULE_TYPE_MISMATCH: '{message}',
  RULE_VALUE_OUT_OF_RANGE: '{message}',
  RULE_UNSATISFIABLE: '{message}',
  // 發布前檢查（SD §6.7）：發布失敗 422 時逐項列出
  COMPLETION_RULE_MISSING: '{message}',
  C1_UNREACHABLE: '{message}',
  C1_EMPTY_REQUIRED_SCOPE: '{message}',
  C3_DOCUMENT_NOT_READY: '{message}',
  C3_NO_KNOWLEDGE: '{message}',
  C4_POLICY_MISSING: '{message}',
  C4_POLICY_INVALID: '{message}',
  C5_DEFINITION_REQUIRED: '{message}',
  C5_DEFINITION_UNAVAILABLE: '{message}',
  C5_CONFIG_INVALID: '{message}',
  C5_ANSWER_KEY_INVALID: '{message}',
  C5_SCHEMA_PARTIAL: '{message}',
};

const RULE_FIELD_LABELS: Record<string, string> = {
  activity_id: '活動',
  activity_ids: '活動',
  module_id: '單元',
  lesson_id: '課節',
  scope_id: '單元',
  scope: '範圍',
  value: '數值',
  operator: '運算方式',
  type: '條件類型',
  approver_role: '核可者',
  negate: '反向',
};

/** 完成條件的 JSON 路徑 → 中文位置：$.conditions[1].conditions[0].value → 完成條件 › 第 2 項 › 第 1 項 › 數值 */
export function humanizeRulePath(field: string): string | null {
  if (!field.startsWith('$')) return null;
  const out = ['完成條件'];
  for (const [, key, idx] of field.slice(1).matchAll(/\.(\w+)(?:\[(\d+)\])?/g)) {
    if (key === 'conditions' && idx !== undefined) out.push(`第 ${Number(idx) + 1} 項`);
    else out.push(RULE_FIELD_LABELS[key!] ?? key!);
  }
  return out.join(' › ');
}

const STRUCTURE_SEGMENTS: Record<string, string> = { modules: '單元', lessons: '課節', activities: '活動', contentBlocks: '內容區塊' };

/** 課程結構的欄位路徑 → 中文位置：modules.0.lessons.1.activities.2.title → 第 1 單元 › 第 2 課節 › 第 3 活動 › 名稱 */
export function humanizeStructurePath(field: string): string | null {
  if (!/^modules\.\d+/.test(field)) return null;
  const parts = field.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = STRUCTURE_SEGMENTS[parts[i]!];
    const idx = parts[i + 1];
    if (seg && idx !== undefined && /^\d+$/.test(idx)) {
      out.push(`第 ${Number(idx) + 1} ${seg}`);
      i++;
    } else {
      out.push(FIELD_LABELS[parts[i]!] ?? parts[i]!);
    }
  }
  return out.join(' › ');
}

export function describeDetail(d: ErrorDetail): string {
  const structural = d.field ? (humanizeStructurePath(d.field) ?? humanizeRulePath(d.field)) : null;
  const label = d.field ? (structural ?? FIELD_LABELS[d.field.split('.')[0] ?? ''] ?? d.field) : '';
  const template = ISSUE_MESSAGES[d.issue] ?? d.issue;
  const issue = template.replace(/\{(\w+)\}/g, (_, k: string) => d.params?.[k] ?? '');
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

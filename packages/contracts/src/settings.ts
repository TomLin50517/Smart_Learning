/**
 * 平台設定目錄（SA UC-PLT-006、§22；SD §8.11）。
 * 只有列在此處的鍵可以經 PUT /api/platform/settings 寫入——不接受任意鍵，
 * 以免設定端點變成可寫入任何資料的萬能存放區。機密（SMTP、AI key）不在此處（ADR-031）。
 */
export interface IntegerSettingDef {
  type: 'integer';
  label: string;
  description: string;
  /** 顯示用單位；bytes 於前端以 MB 呈現 */
  unit: 'bytes' | null;
  min: number;
  max: number;
  default: number;
  /** 讀取此設定的功能所屬 Phase——在那之前只是預先設定，不影響系統行為 */
  effectiveFrom: string;
}

export const PLATFORM_SETTINGS = {
  'upload.max_size': {
    type: 'integer',
    label: '單檔上傳上限',
    description: '教材、影片等單一檔案的大小上限（SA §22 #2）。調高時需同步調整 nginx client_max_body_size。',
    unit: 'bytes',
    min: 1_048_576,
    max: 10_737_418_240,
    default: 536_870_912,
    effectiveFrom: 'Phase 2（文件上傳）',
  },
  'derived.min_threshold': {
    type: 'integer',
    label: 'Derived Knowledge 匿名門檻',
    description: '彙整常見問題或常犯錯誤前，同一類問題至少需來自幾位不同學員，避免回推個人（SA §22 #12）。',
    unit: null,
    min: 2,
    max: 100,
    default: 5,
    effectiveFrom: 'Phase 3（Derived Knowledge）',
  },
} as const satisfies Record<string, IntegerSettingDef>;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS;
export const PLATFORM_SETTING_KEYS = Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[];

export interface PlatformSettingDto {
  key: PlatformSettingKey;
  /** 生效值（未設定時為預設值） */
  value: number;
  default: number;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: { id: string; displayName: string | null } | null;
}

/** GET /api/system/jobs（SD §8.11） */
export interface JobQueueStatus {
  generatedAt: string;
  queues: {
    queue: string;
    jobType: string;
    pending: number;
    running: number;
    succeeded24h: number;
    /** 已到執行時間、仍在等待的最舊工作等了幾秒；沒有則 null */
    oldestPendingSeconds: number | null;
  }[];
  /** running 但鎖已過期（worker 當掉）——下次取件時會被回收 */
  staleLocks: number;
  deadLetters: {
    total: number;
    recent: {
      id: string;
      jobType: string;
      queue: string;
      attempts: number;
      failedAt: string;
      /** 截斷至 500 字元 */
      error: string;
      organizationId: string | null;
      correlationId: string | null;
    }[];
  };
}

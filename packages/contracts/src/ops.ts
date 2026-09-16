/** 維運：備份與系統狀態（SA UC-PLT-008／010、§16、§18；SD §6.28） */

export const BACKUP_KINDS = ['daily', 'manual'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_STATUSES = ['requested', 'running', 'succeeded', 'failed'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

/** 一次備份（由 compose 的 backup 服務執行；平台管理員可另外手動觸發） */
export interface BackupRunDto {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  /** 手動備份的發起人 */
  requestedByName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  databaseBytes: number | null;
  objectFiles: number | null;
  objectBytes: number | null;
  /** 備份檔在備份主機上的位置（不含任何祕密） */
  location: string | null;
  error: string | null;
  createdAt: string;
}

export const SYSTEM_ALERT_LEVELS = ['info', 'warning', 'critical'] as const;
export type SystemAlertLevel = (typeof SYSTEM_ALERT_LEVELS)[number];

export interface SystemAlertDto {
  key: string;
  level: SystemAlertLevel;
  message: string;
}

/** GET /api/system/status：平台管理員的一頁總覽（SD §6.28） */
export interface SystemStatusDto {
  generatedAt: string;
  alerts: SystemAlertDto[];
  jobs: {
    pending: number;
    running: number;
    oldestPendingSeconds: number | null;
    deadLetters: number;
    staleLocks: number;
  };
  search: {
    configured: boolean;
    /** 還在處理或等待索引的教材 */
    pendingDocuments: number;
    failedDocuments: number;
  };
  ai: {
    requestsToday: number;
    tokensToday: number;
    dailyBudget: number;
    errorsToday: number;
    /** 今天的回答有多少比例落到安全替代訊息；沒有回答時為 null */
    fallbackRatio: number | null;
  };
  storage: {
    databaseBytes: number;
    documentBytes: number;
    mediaBytes: number;
  };
  license: {
    state: string;
    daysToExpiry: number | null;
    daysToMaintenanceEnd: number | null;
    activeLearners: number;
    maxActiveLearners: number | null;
  };
  backup: {
    lastSucceededAt: string | null;
    lastStatus: BackupStatus | null;
    lastError: string | null;
    /** 距離最近一次成功備份的小時數；從未成功為 null */
    ageHours: number | null;
  };
}

/** 備份逾時（小時）：超過即在狀態頁告警（每日備份 + 緩衝） */
export const BACKUP_STALE_HOURS = 30;

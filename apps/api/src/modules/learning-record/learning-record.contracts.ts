/**
 * MOD-RECORD 對外介面。其他模組只能 import 此檔或 learning-record.module.ts（SD §1.2、.dependency-cruiser.cjs）。
 */
import type pg from 'pg';

/** 伺服器產生的學習事件（SA §10.2）；身分欄位由選課推導 */
export interface ServerEvent {
  eventType: string;
  activityId?: string | null;
  attemptId?: string | null;
  payload?: Record<string, unknown>;
}

export interface LearningEventWriter {
  /** 在呼叫端的交易內寫入（與選課、作答同一交易——復原時事件一起復原） */
  recordTx(c: pg.PoolClient, enrollmentId: string, events: ServerEvent[]): Promise<void>;
}

export const LEARNING_EVENTS = Symbol('LEARNING_EVENTS');

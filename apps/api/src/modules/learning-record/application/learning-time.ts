import type { LearningTimeDto } from '@iac/contracts';
import type { EnrollmentProgress } from '../../completion/completion.contracts.js';

/** 秒 → 分鐘（無條件捨去到 0.1 分），與完成條件的 time_spent_minimum 同一算法 */
const toMinutes = (sec: number) => Math.floor(sec / 6) / 10;

/** 學習時間（總計與各單元，依課程排序；沒有時間的單元不列） */
export function toLearningTime(p: EnrollmentProgress): LearningTimeDto {
  return {
    minutes: toMinutes(p.time.totalSec),
    byModule: p.modules
      .map((m) => ({ moduleId: m.id, title: m.title, minutes: toMinutes(p.time.byModuleSec[m.id] ?? 0) }))
      .filter((m) => m.minutes > 0),
    lastActivityAt: p.time.lastActivityAt,
  };
}

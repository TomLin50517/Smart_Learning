import type { NewAttemptPolicy, RelearningScope } from '@iac/contracts';

/** 重修指派在完成判定中的樣子（SD §6.25）；at 為指派時間（epoch ms） */
export interface RelearningCover {
  id: string;
  scopeType: RelearningScope;
  scopeId: string | null;
  at: number;
  policy: NewAttemptPolicy;
}

export interface ActivityPlace {
  id: string;
  moduleId: string;
  lessonId: string;
}

export function covers(r: RelearningCover, a: ActivityPlace): boolean {
  switch (r.scopeType) {
    case 'course':
      return true;
    case 'module':
      return r.scopeId === a.moduleId;
    case 'lesson':
      return r.scopeId === a.lessonId;
    case 'activity':
      return r.scopeId === a.id;
  }
}

/**
 * 每個活動目前生效的重修：涵蓋它的指派中最新的一筆。該活動在這個時間點之前的結果不再計入完成判定
 * （歷史照樣保留，INV-6）；reset_counter 時作答次數也只算這次重修之後的作答。
 */
export function coveringRelearning(rows: readonly RelearningCover[], activities: readonly ActivityPlace[]): Record<string, RelearningCover> {
  const out: Record<string, RelearningCover> = {};
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    for (const a of activities) if (covers(r, a)) out[a.id] = r;
  }
  return out;
}

/** 最新一筆「整門課」重修的時間：在此之前的人工核可不再計入 */
export function courseCutoff(rows: readonly RelearningCover[]): number | null {
  let at: number | null = null;
  for (const r of rows) if (r.scopeType === 'course' && (at === null || r.at > at)) at = r.at;
  return at;
}

import type { NavigationMode, RuleNode } from '@iac/contracts';
import { evaluateRule, type CompletionContext } from '../completion/evaluate.js';

export interface UnlockStructure {
  navigationMode: NavigationMode;
  /** 依排序；activities 為該單元依課節、活動排序攤平後的清單 */
  modules: { id: string; activities: { id: string; prerequisite: RuleNode | null }[] }[];
}

export interface Availability {
  unlocked: boolean;
  /** sequence＝學習順序（隱含規則）；prerequisite＝活動的先修條件 */
  reason: 'sequence' | 'prerequisite' | null;
}

const DONE = new Set(['passed', 'completed']);

/**
 * 活動是否可開始（SA SEQ-03、SD §3.7）。純函式。
 *  - 隱含規則：strict 需完成前一個活動；mixed 需完成前一單元的所有必修活動
 *  - 顯式規則：先修條件以完成條件評估器判定（只有 TRUE 才解鎖；UNKNOWN 視為未解鎖）
 *  - 已完成的活動永遠可回顧
 */
export function activityAvailability(s: UnlockStructure, ctx: CompletionContext): Record<string, Availability> {
  const done = (id: string) => {
    const r = ctx.bestResults[id];
    return !!r && DONE.has(r.status);
  };
  const flat = s.modules.flatMap((m, mi) => m.activities.map((a) => ({ ...a, mi })));
  const out: Record<string, Availability> = {};

  flat.forEach((a, i) => {
    if (done(a.id)) {
      out[a.id] = { unlocked: true, reason: null };
      return;
    }
    let sequenceOk = true;
    if (s.navigationMode === 'strict' && i > 0) sequenceOk = done(flat[i - 1]!.id);
    if (s.navigationMode === 'mixed' && a.mi > 0) {
      const prev = s.modules[a.mi - 1]!.id;
      sequenceOk = ctx.requiredActivityIds.filter((id) => ctx.activities[id]?.moduleId === prev).every(done);
    }
    let prerequisiteOk = true;
    if (a.prerequisite) {
      try {
        prerequisiteOk = evaluateRule(a.prerequisite, ctx).result;
      } catch {
        prerequisiteOk = false; // 過深的規則（發布前 validator 會擋）
      }
    }
    out[a.id] = { unlocked: sequenceOk && prerequisiteOk, reason: !sequenceOk ? 'sequence' : !prerequisiteOk ? 'prerequisite' : null };
  });
  return out;
}

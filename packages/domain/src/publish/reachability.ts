import type { NavigationMode, ValidationIssueDto } from '@iac/contracts';

/** 可達性分析的輸入：課程結構（依排序）與導覽模式 */
export interface ReachabilityInput {
  navigationMode: NavigationMode;
  modules: {
    id: string;
    title: string;
    isRequired: boolean;
    lessons: {
      id: string;
      title: string;
      isRequired: boolean;
      activities: { id: string; title: string; isRequired: boolean; prerequisite: unknown }[];
    }[];
  }[];
}

interface Node {
  id: string;
  title: string;
  required: boolean;
  path: string;
  moduleIndex: number;
  prerequisite: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * C1「無法到達的必修單元」（SA SEQ-01、ARCH §6.3）。純函式。
 *
 * 依賴圖：節點為活動，邊 a → b 表示 a 開始前 b 必須完成。
 *  - 顯式：先修條件中「一定要先完成」的引用——只沿 AND 群組往下，且不含 negate；
 *    OR／NOT 分支不構成必經依賴（有替代路徑），計入會誤報
 *  - 隱含（SD §3.7）：strict 依排序依賴前一個活動；mixed 依賴前一單元的所有必修活動
 *
 * 從「無依賴」的活動開始逐步解鎖，解不開的即無法到達：依賴形成循環、依賴無法到達的活動，
 * 或先修條件要求完成一個沒有必修活動的單元／課節（評估為 UNKNOWN，永遠不會成立）。
 * 必修活動 → 錯誤；選修 → 警告。另警告「必修但沒有任何必修活動」的單元／課節。
 */
export function checkReachability(input: ReachabilityInput): { errors: ValidationIssueDto[]; warnings: ValidationIssueDto[] } {
  const errors: ValidationIssueDto[] = [];
  const warnings: ValidationIssueDto[] = [];
  const nodes: Node[] = [];
  const requiredByModule = new Map<string, string[]>();
  const requiredByLesson = new Map<string, string[]>();

  input.modules.forEach((m, mi) => {
    const modReq: string[] = [];
    m.lessons.forEach((l, li) => {
      const lesReq: string[] = [];
      l.activities.forEach((a, ai) => {
        const required = m.isRequired && l.isRequired && a.isRequired;
        nodes.push({ id: a.id, title: a.title, required, path: `modules.${mi}.lessons.${li}.activities.${ai}`, moduleIndex: mi, prerequisite: a.prerequisite });
        if (required) lesReq.push(a.id);
      });
      requiredByLesson.set(l.id, lesReq);
      modReq.push(...lesReq);
      if (m.isRequired && l.isRequired && lesReq.length === 0) {
        warnings.push({ check: 'C1', code: 'C1_EMPTY_REQUIRED_SCOPE', path: `modules.${mi}.lessons.${li}`, message: `必修課節「${l.title}」沒有任何必修活動`, targetId: l.id });
      }
    });
    requiredByModule.set(m.id, modReq);
    if (m.isRequired && modReq.length === 0) {
      warnings.push({ check: 'C1', code: 'C1_EMPTY_REQUIRED_SCOPE', path: `modules.${mi}`, message: `必修單元「${m.title}」沒有任何必修活動`, targetId: m.id });
    }
  });

  const known = new Set(nodes.map((n) => n.id));
  const deps = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  const blocked = new Set<string>();

  // 顯式先修條件
  for (const n of nodes) {
    const add = (ids: readonly string[]) => ids.filter((id) => known.has(id)).forEach((id) => deps.get(n.id)!.add(id));
    const scope = (ids: string[] | undefined) => {
      // 範圍內沒有必修活動 → 條件恆為 UNKNOWN → 此活動永遠不會解鎖
      if (!ids || ids.length === 0) blocked.add(n.id);
      else add(ids);
    };
    const walk = (node: unknown): void => {
      if (!isObj(node)) return;
      if ('operator' in node) {
        if (node.operator === 'AND' && Array.isArray(node.conditions)) node.conditions.forEach(walk);
        return;
      }
      if (node.negate === true) return;
      switch (node.type) {
        case 'specific_activities_completed':
          if (Array.isArray(node.activity_ids)) add(node.activity_ids.filter((x): x is string => typeof x === 'string'));
          return;
        case 'minimum_activity_score':
        case 'attempt_status':
        case 'video_watch_ratio':
        case 'attempt_count_maximum':
          if (typeof node.activity_id === 'string') add([node.activity_id]);
          return;
        case 'module_completed':
          if (typeof node.module_id === 'string') scope(requiredByModule.get(node.module_id));
          return;
        case 'lesson_completed':
          if (typeof node.lesson_id === 'string') scope(requiredByLesson.get(node.lesson_id));
          return;
      }
    };
    walk(n.prerequisite);
  }

  // 隱含順序
  if (input.navigationMode === 'strict') {
    for (let i = 1; i < nodes.length; i++) deps.get(nodes[i]!.id)!.add(nodes[i - 1]!.id);
  } else if (input.navigationMode === 'mixed') {
    for (const n of nodes) {
      const prev = input.modules[n.moduleIndex - 1];
      if (prev) (requiredByModule.get(prev.id) ?? []).forEach((id) => deps.get(n.id)!.add(id));
    }
  }

  // 逐步解鎖直到不再變化（n ≤ 2000，O(n × E) 足夠）
  const reachable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (reachable.has(n.id) || blocked.has(n.id)) continue;
      if ([...deps.get(n.id)!].every((d) => reachable.has(d))) {
        reachable.add(n.id);
        changed = true;
      }
    }
  }

  for (const n of nodes) {
    if (reachable.has(n.id)) continue;
    const why = blocked.has(n.id) ? '先修條件要求完成一個沒有必修活動的單元或課節' : '先修條件形成循環，或依賴其他無法開始的活動';
    const issue = { check: 'C1' as const, code: 'C1_UNREACHABLE', path: n.path, targetId: n.id };
    if (n.required) errors.push({ ...issue, message: `必修活動「${n.title}」永遠無法開始：${why}` });
    else warnings.push({ ...issue, message: `選修活動「${n.title}」永遠無法開始：${why}` });
  }
  return { errors, warnings };
}

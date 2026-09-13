import { Inject, Injectable } from '@nestjs/common';
import type { CompletionEvaluationDto, EnrollmentStatus, LessonBlock, NavigationMode, ResultStatus, RuleNode } from '@iac/contracts';
import { evaluateRule, type CompletionContext } from '@iac/domain';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import type { CompletionEngine, EnrollmentProgress, ProgressActivity } from '../completion.contracts.js';

type Q = pg.Pool | pg.PoolClient;

/** 最佳成績的排序：通過 > 完成 > 需改進 > 未通過，同級取高分 */
const RANK: Record<ResultStatus, number> = { passed: 3, completed: 2, needs_improvement: 1, failed: 0 };
const DONE = new Set(['passed', 'completed']);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 完成判定引擎（UC-ENR-008、SA SEQ-03、SD §3、§6.9）。deterministic、零 LLM（INV-4）：
 * 讀課程結構與作答結果建構 CompletionContext（唯一碰 DB 的步驟），評估交給 @iac/domain 的純函式。
 */
@Injectable()
export class CompletionEngineService implements CompletionEngine {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  async progress(enrollmentId: string, q: Q = this.db): Promise<EnrollmentProgress> {
    const e = await q.query<{
      id: string;
      user_id: string;
      organization_id: string;
      course_id: string;
      course_version_id: string;
      status: EnrollmentStatus;
      navigation_mode: NavigationMode;
    }>(
      `SELECT e.id, e.user_id, e.organization_id, e.course_id, e.course_version_id, e.status, cv.navigation_mode
         FROM enrollments e JOIN course_versions cv ON cv.id = e.course_version_id WHERE e.id = $1`,
      [enrollmentId],
    );
    const enr = e.rows[0];
    if (!enr) throw new DomainError('NOT_FOUND');
    const v = enr.course_version_id;

    const mods = await q.query<{ id: string; title: string; description: string | null; is_required: boolean }>(
      `SELECT id, title, description, is_required FROM modules WHERE course_version_id = $1 ORDER BY sort_order`,
      [v],
    );
    const lessons = await q.query<{ id: string; module_id: string; title: string; is_required: boolean; content_blocks: LessonBlock[] }>(
      `SELECT id, module_id, title, is_required, content_blocks FROM lessons WHERE course_version_id = $1 ORDER BY sort_order`,
      [v],
    );
    const acts = await q.query<{
      id: string;
      lesson_id: string;
      title: string;
      activity_type: ProgressActivity['activityType'];
      is_required: boolean;
      interactive_definition_id: string | null;
      server_evaluator: string | null;
      max_attempts: number | null;
      weight: string;
      max_score: string;
      prerequisite_expression: RuleNode | null;
    }>(
      `SELECT a.id, a.lesson_id, a.title, a.activity_type, a.is_required, a.interactive_definition_id, d.server_evaluator,
              a.max_attempts, a.weight, a.max_score, p.prerequisite_expression
         FROM activities a
         LEFT JOIN interactive_definitions d ON d.id = a.interactive_definition_id
         LEFT JOIN activity_prerequisites p ON p.activity_id = a.id
        WHERE a.course_version_id = $1 ORDER BY a.sort_order`,
      [v],
    );
    const rule = await q.query<{ grammar_version: string; rule_json: RuleNode }>(`SELECT grammar_version, rule_json FROM completion_rule_sets WHERE course_version_id = $1`, [v]);
    const results = await q.query<{ activity_id: string; status: ResultStatus; score: string | null; feedback_data: Record<string, unknown> }>(
      `SELECT activity_id, status, score, feedback_data FROM learning_results WHERE enrollment_id = $1`,
      [enrollmentId],
    );
    const attempts = await q.query<{ activity_id: string; used: number; in_progress: string | null }>(
      `SELECT activity_id,
              count(*) FILTER (WHERE status IN ('submitted', 'scored'))::int AS used,
              (array_agg(id) FILTER (WHERE status = 'in_progress'))[1] AS in_progress
         FROM learning_attempts WHERE enrollment_id = $1 GROUP BY activity_id`,
      [enrollmentId],
    );

    const modIndex = new Map(mods.rows.map((m) => [m.id, m]));
    const lessonMod = new Map(lessons.rows.map((l) => [l.id, l.module_id]));
    const lessonReq = new Map(lessons.rows.map((l) => [l.id, l.is_required]));
    const actsByLesson = new Map<string, ProgressActivity[]>();
    const ctx: CompletionContext = {
      requiredActivityIds: [],
      activities: {},
      bestResults: {},
      attemptCounts: {},
      videoWatchRatios: {},
      // 學習時間與人工核可於後續批次（學習事件、核可）接上
      timeSpentMinutes: { course: 0, byModule: {} },
      manualApprovals: [],
    };
    const requiredIds: string[] = [];
    for (const a of acts.rows) {
      const moduleId = lessonMod.get(a.lesson_id)!;
      // 必修＝活動、課節、單元皆必修（SD §6.6）
      const required = a.is_required && lessonReq.get(a.lesson_id)! && modIndex.get(moduleId)!.is_required;
      const pa: ProgressActivity = {
        id: a.id,
        title: a.title,
        activityType: a.activity_type,
        isRequired: required,
        interactiveDefinitionId: a.interactive_definition_id,
        serverEvaluator: a.server_evaluator,
        maxAttempts: a.max_attempts,
        weight: Number(a.weight),
        maxScore: Number(a.max_score),
        prerequisite: a.prerequisite_expression,
      };
      if (!actsByLesson.has(a.lesson_id)) actsByLesson.set(a.lesson_id, []);
      actsByLesson.get(a.lesson_id)!.push(pa);
      ctx.activities[a.id] = { weight: pa.weight, maxScore: pa.maxScore, moduleId, lessonId: a.lesson_id, activityType: a.activity_type };
      if (required) requiredIds.push(a.id);
    }
    ctx.requiredActivityIds = requiredIds;

    for (const r of results.rows) {
      const cur = ctx.bestResults[r.activity_id];
      const score = r.score === null ? null : Number(r.score);
      if (!cur || RANK[r.status] > RANK[cur.status as ResultStatus] || (RANK[r.status] === RANK[cur.status as ResultStatus] && (score ?? -1) > (cur.score ?? -1))) {
        ctx.bestResults[r.activity_id] = { status: r.status, score };
      }
      const ratio = r.feedback_data?.['watchedRatio'];
      if (typeof ratio === 'number') ctx.videoWatchRatios[r.activity_id] = Math.max(ctx.videoWatchRatios[r.activity_id] ?? 0, ratio);
    }
    const attemptInfo: EnrollmentProgress['attempts'] = {};
    for (const a of attempts.rows) {
      ctx.attemptCounts[a.activity_id] = a.used;
      attemptInfo[a.activity_id] = { used: a.used, inProgressId: a.in_progress };
    }

    return {
      enrollment: { id: enr.id, userId: enr.user_id, organizationId: enr.organization_id, courseId: enr.course_id, courseVersionId: v, status: enr.status },
      navigationMode: enr.navigation_mode,
      modules: mods.rows.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        isRequired: m.is_required,
        lessons: lessons.rows
          .filter((l) => l.module_id === m.id)
          .map((l) => ({ id: l.id, title: l.title, isRequired: l.is_required, contentBlocks: l.content_blocks, activities: actsByLesson.get(l.id) ?? [] })),
      })),
      rule: rule.rows[0] ? { grammarVersion: rule.rows[0].grammar_version, rule: rule.rows[0].rule_json } : null,
      ctx,
      attempts: attemptInfo,
    };
  }

  evaluate(p: EnrollmentProgress): CompletionEvaluationDto {
    const done = (id: string) => DONE.has(p.ctx.bestResults[id]?.status ?? '');
    const req = p.ctx.requiredActivityIds;
    let num = 0;
    let den = 0;
    for (const id of req) {
      const r = p.ctx.bestResults[id];
      const a = p.ctx.activities[id];
      if (!r || r.score === null || !a) continue;
      num += r.score * a.weight;
      den += a.maxScore * a.weight;
    }
    const base = {
      enrollmentId: p.enrollment.id,
      grammarVersion: p.rule?.grammarVersion ?? null,
      evaluatedAt: new Date().toISOString(),
      requiredTotal: req.length,
      requiredCompleted: req.filter(done).length,
      weightedScore: den > 0 ? round2((num / den) * 100) : null,
    };
    if (!p.rule) {
      return { ...base, result: false, completed: false, value: 'FALSE', trace: [], blockingReasons: [{ code: 'COMPLETION_RULE_MISSING', activity_id: null }] };
    }
    try {
      const r = evaluateRule(p.rule.rule, p.ctx);
      return { ...base, result: r.result, completed: r.result, value: r.value, trace: r.trace, blockingReasons: r.blockingReasons };
    } catch {
      return { ...base, result: false, completed: false, value: 'UNKNOWN', trace: [], blockingReasons: [{ code: 'DATA_NOT_AVAILABLE', activity_id: null }] };
    }
  }

  /** 寫入進度快照；完成條件成立且選課為 active／reopened 時轉為 completed。回傳是否因此完成 */
  async persist(p: EnrollmentProgress, ev: CompletionEvaluationDto, c: pg.PoolClient): Promise<boolean> {
    await c.query(
      `INSERT INTO progress_snapshots (organization_id, enrollment_id, computed_at, required_total, required_completed, weighted_score, completion_evaluation)
       VALUES ($1, $2, now(), $3, $4, $5, $6::jsonb)
       ON CONFLICT (enrollment_id) DO UPDATE SET computed_at = now(), required_total = EXCLUDED.required_total,
         required_completed = EXCLUDED.required_completed, weighted_score = EXCLUDED.weighted_score,
         completion_evaluation = EXCLUDED.completion_evaluation`,
      [p.enrollment.organizationId, p.enrollment.id, ev.requiredTotal, ev.requiredCompleted, ev.weightedScore, JSON.stringify(ev)],
    );
    if (!ev.result) return false;
    const r = await c.query(
      `UPDATE enrollments SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 AND status IN ('active', 'reopened')`,
      [p.enrollment.id],
    );
    return (r.rowCount ?? 0) > 0;
  }
}

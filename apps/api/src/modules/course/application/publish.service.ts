import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  PREREQUISITE_CONDITION_TYPES,
  type CourseStatus,
  type CourseVersionDetailDto,
  type CourseVersionStatus,
  type ValidationIssueDto,
  type ValidationReportDto,
} from '@iac/contracts';
import { canonicalJson, checkReachability, validateJsonSchema, validateRule } from '@iac/domain';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { CoachPolicyInput } from './course-inputs.js';
import { CourseService } from './course.service.js';

type Q = pg.Pool | pg.PoolClient;

const PUBLISHABLE: CourseVersionStatus[] = ['draft', 'review'];
/** 每個活動最多列出幾個 schema 問題（避免一個壞設定洗版整份報告） */
const MAX_SCHEMA_ISSUES = 5;

/**
 * 內容快照的輸入：只含內容，不含狀態、時間戳與雜湊本身（發布會改變它們）。
 * 日後以同一函式重算，即可偵測已發布版本是否被繞過應用層修改（SA AC-CRS-001）。
 */
export function snapshotPayload(v: CourseVersionDetailDto): string {
  return canonicalJson({
    courseId: v.courseId,
    versionNo: v.versionNo,
    title: v.title,
    summary: v.summary,
    navigationMode: v.navigationMode,
    modules: v.modules,
    completionRuleSet: v.completionRuleSet,
    coachPolicy: v.coachPolicy,
    knowledgeBindings: v.knowledgeBindings,
  });
}

export const snapshotHash = (v: CourseVersionDetailDto) => `sha256:${createHash('sha256').update(snapshotPayload(v)).digest('hex')}`;

/**
 * 發布前檢查與發布（UC-CRS-007/008、SA SEQ-01、SD §6.7）。
 * 檢查的判斷邏輯都是 @iac/domain 的純函式；本服務只負責讀資料與交易。
 */
@Injectable()
export class CoursePublishService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    private readonly courses: CourseService,
  ) {}

  /** 發布前檢查 C1–C5。publish 會在同一個交易、同一條連線上重跑，檢查與發布之間內容不會被改 */
  async validate(id: string, q: Q = this.db): Promise<ValidationReportDto> {
    const v = await this.courses.getVersion(id, q);
    const errors: ValidationIssueDto[] = [];
    const warnings: ValidationIssueDto[] = [];

    // C1 無法到達的必修單元
    const reach = checkReachability({
      navigationMode: v.navigationMode,
      modules: v.modules.map((m) => ({
        id: m.id,
        title: m.title,
        isRequired: m.isRequired,
        lessons: m.lessons.map((l) => ({
          id: l.id,
          title: l.title,
          isRequired: l.isRequired,
          activities: l.activities.map((a) => ({ id: a.id, title: a.title, isRequired: a.isRequired, prerequisite: a.prerequisite })),
        })),
      })),
    });
    errors.push(...reach.errors);
    warnings.push(...reach.warnings);

    // C2 完成條件與先修條件（引用、型別、值域）
    const structure = await this.courses.ruleStructure(id, q);
    if (!v.completionRuleSet) {
      errors.push({ check: 'C2', code: 'COMPLETION_RULE_MISSING', path: '$', message: '尚未設定完成條件' });
    } else {
      const r = validateRule(v.completionRuleSet.rule, structure);
      errors.push(...r.errors.map((e) => ({ ...e, check: 'C2' as const })));
      warnings.push(...r.warnings.map((w) => ({ ...w, check: 'C2' as const })));
    }
    eachActivity(v, (a, base) => {
      if (a.prerequisite == null) return;
      const r = validateRule(a.prerequisite, structure, { allowedTypes: PREREQUISITE_CONDITION_TYPES });
      const tag = (i: ValidationIssueDto): ValidationIssueDto => ({
        check: 'C2',
        code: i.code,
        path: `${base}.prerequisite`,
        message: `活動「${a.title}」的先修條件：${i.message}`,
        targetId: a.id,
      });
      errors.push(...r.errors.map(tag));
      warnings.push(...r.warnings.map(tag));
    });

    // C3 綁定的教材是否處理完成
    const docs = await q.query<{ document_version_id: string; status: string; title: string }>(
      `SELECT kb.document_version_id, dv.status, sd.title
         FROM knowledge_bindings kb
         JOIN document_versions dv ON dv.id = kb.document_version_id
         JOIN source_documents sd  ON sd.id = dv.source_document_id
        WHERE kb.course_version_id = $1
        ORDER BY kb.priority, kb.document_version_id`,
      [id],
    );
    docs.rows.forEach((d, i) => {
      if (d.status !== 'ready') {
        errors.push({
          check: 'C3',
          code: 'C3_DOCUMENT_NOT_READY',
          path: `knowledgeBindings.${i}`,
          message: `教材「${d.title}」尚未處理完成（目前狀態：${d.status}）`,
          targetId: d.document_version_id,
        });
      }
    });
    if (v.coachPolicy?.citationRequired && docs.rowCount === 0) {
      warnings.push({ check: 'C3', code: 'C3_NO_KNOWLEDGE', path: 'knowledgeBindings', message: 'AI 教練設定要求附引用，但此版本沒有綁定任何教材；教練將無法回答課程內容的問題' });
    }

    // C4 AI 教練設定
    if (!v.coachPolicy) errors.push({ check: 'C4', code: 'C4_POLICY_MISSING', path: 'coachPolicy', message: '缺少 AI 教練設定' });
    else if (!CoachPolicyInput.safeParse(v.coachPolicy).success) {
      errors.push({ check: 'C4', code: 'C4_POLICY_INVALID', path: 'coachPolicy', message: 'AI 教練設定有不在允許範圍內的值，請重新儲存教練設定' });
    }

    // C5 互動活動的設定是否符合元件 schema
    const defIds = [...new Set(v.modules.flatMap((m) => m.lessons.flatMap((l) => l.activities.map((a) => a.interactiveDefinitionId))).filter((x): x is string => !!x))];
    const defs = await q.query<{ id: string; display_name: string; is_enabled: boolean; config_schema: unknown; answer_key_schema: unknown }>(
      `SELECT id, display_name, is_enabled, config_schema, answer_key_schema FROM interactive_definitions WHERE id = ANY($1::uuid[])`,
      [defIds],
    );
    const defById = new Map(defs.rows.map((d) => [d.id, d]));
    const partial = new Set<string>();
    eachActivity(v, (a, base) => {
      if (!a.interactiveDefinitionId) {
        if (a.activityType === 'interactive') {
          errors.push({ check: 'C5', code: 'C5_DEFINITION_REQUIRED', path: `${base}.interactiveDefinitionId`, message: `互動活動「${a.title}」沒有選擇互動元件`, targetId: a.id });
        }
        return;
      }
      const def = defById.get(a.interactiveDefinitionId);
      if (!def || !def.is_enabled) {
        errors.push({ check: 'C5', code: 'C5_DEFINITION_UNAVAILABLE', path: `${base}.interactiveDefinitionId`, message: `活動「${a.title}」使用的互動元件不存在或已停用`, targetId: a.id });
        return;
      }
      const targets: [string, 'C5_CONFIG_INVALID' | 'C5_ANSWER_KEY_INVALID', unknown, unknown, string][] = [
        ['config', 'C5_CONFIG_INVALID', def.config_schema, a.config, '設定'],
        ['answerKey', 'C5_ANSWER_KEY_INVALID', def.answer_key_schema, a.answerKey, '答案'],
      ];
      for (const [field, code, schema, value, label] of targets) {
        if (schema == null || value == null) continue;
        const r = validateJsonSchema(schema, value);
        for (const x of r.violations.slice(0, MAX_SCHEMA_ISSUES)) {
          errors.push({ check: 'C5', code, path: `${base}.${field}`, message: `活動「${a.title}」的${label}${x.path ? `（${x.path}）` : ''}${x.message}`, targetId: a.id });
        }
        if (r.unsupported.length && !partial.has(def.id)) {
          partial.add(def.id);
          warnings.push({
            check: 'C5',
            code: 'C5_SCHEMA_PARTIAL',
            path: `${base}.${field}`,
            message: `互動元件「${def.display_name}」的 schema 使用了未支援的規則（${r.unsupported.join('、')}），這部分未檢查`,
            targetId: a.id,
          });
        }
      }
    });

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * 發布（原子操作）：鎖定課程列（與建立版本、複製同一把鎖，同一課程的發布排隊）→ 確認本版為 draft／review
   * → 同一交易內重跑檢查，有錯誤即 422 → 舊的已發布版本轉 superseded → 本版轉 published 並寫入內容雜湊
   * → 課程由 draft 轉 active。先轉舊版再轉新版：部分唯一索引保證同一課程只有一個 published。
   * 知識綁定已指向特定 document_version_id，發布後隨版本凍結（DB 觸發器擋寫），不必另外處理。
   */
  async publish(
    id: string,
    actorId: string,
  ): Promise<{ version: CourseVersionDetailDto; previousStatus: CourseVersionStatus; supersededVersionId: string | null; contentSnapshotHash: string }> {
    const c = await this.db.connect();
    let result: { previousStatus: CourseVersionStatus; supersededVersionId: string | null; contentSnapshotHash: string };
    try {
      await c.query('BEGIN');
      const v = await c.query<{ course_id: string }>(`SELECT course_id FROM course_versions WHERE id = $1`, [id]);
      if (!v.rows[0]) throw new DomainError('NOT_FOUND');
      const courseId = v.rows[0].course_id;
      const course = await c.query<{ status: CourseStatus }>(`SELECT status FROM courses WHERE id = $1 FOR UPDATE`, [courseId]);
      const cur = await c.query<{ status: CourseVersionStatus }>(`SELECT status FROM course_versions WHERE id = $1 FOR UPDATE`, [id]);
      const previousStatus = cur.rows[0]!.status;
      if (!PUBLISHABLE.includes(previousStatus)) throw new DomainError('COURSE_VERSION_IMMUTABLE');
      if (course.rows[0]!.status === 'archived') throw new DomainError('VALIDATION_FAILED', 'course_archived', [{ issue: 'course_archived' }]);

      const report = await this.validate(id, c);
      if (!report.valid) {
        throw new DomainError(
          'COURSE_VALIDATION_FAILED',
          'Version failed publish validation',
          report.errors.map((e) => ({ field: e.path, issue: e.code, params: { message: e.message, ...(e.check && { check: e.check }) } })),
        );
      }

      const contentSnapshotHash = snapshotHash(await this.courses.getVersion(id, c));
      const prev = await c.query<{ id: string }>(`UPDATE course_versions SET status = 'superseded' WHERE course_id = $1 AND status = 'published' RETURNING id`, [courseId]);
      await c.query(`UPDATE course_versions SET status = 'published', published_at = now(), published_by = $2, content_snapshot_hash = $3 WHERE id = $1`, [
        id,
        actorId,
        contentSnapshotHash,
      ]);
      await c.query(`UPDATE courses SET status = 'active' WHERE id = $1 AND status = 'draft'`, [courseId]);
      await c.query('COMMIT');
      result = { previousStatus, supersededVersionId: prev.rows[0]?.id ?? null, contentSnapshotHash };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    return { version: await this.courses.getVersion(id), ...result };
  }
}

function eachActivity(v: CourseVersionDetailDto, fn: (a: CourseVersionDetailDto['modules'][number]['lessons'][number]['activities'][number], base: string) => void) {
  v.modules.forEach((m, mi) => m.lessons.forEach((l, li) => l.activities.forEach((a, ai) => fn(a, `modules.${mi}.lessons.${li}.activities.${ai}`))));
}

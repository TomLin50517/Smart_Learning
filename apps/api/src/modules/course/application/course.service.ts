import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { validateRule, type RuleStructure } from '@iac/domain';
import {
  COURSE_LIMITS,
  type CoachPolicyDto,
  type RuleNode,
  type ValidationIssueDto,
  type ActivityDto,
  type ActivityType,
  type CourseDetailDto,
  type CourseDto,
  type CourseStaffDto,
  type CourseStaffRole,
  type CourseStatus,
  type CourseVersionDetailDto,
  type CourseVersionStatus,
  type CourseVersionSummaryDto,
  type InteractiveDefinitionDto,
  type LessonBlock,
  type ModuleDto,
  type NavigationMode,
  type VersionImpactDto,
} from '@iac/contracts';
import pg from 'pg';
import { z } from 'zod';
import type { GrantScopes } from '../../../common/authz.js';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { remapIds } from '../domain/remap-ids.js';
import type { DraftPatchT, ModuleInputT } from './course-inputs.js';

type Q = pg.Pool | pg.PoolClient;
type Tx = pg.PoolClient;

const invalid = (field: string, issue: string) => new DomainError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
const rejected = (issue: string) => new DomainError('VALIDATION_FAILED', issue, [{ issue }]);

const WORKING: CourseVersionStatus[] = ['draft', 'review'];
const CLONEABLE: CourseVersionStatus[] = ['published', 'superseded'];

interface CourseRow {
  id: string;
  organization_id: string;
  code: string;
  title: string;
  description: string | null;
  status: CourseStatus;
  created_at: Date;
  pv_id: string | null;
  pv_no: number | null;
  wv_id: string | null;
  wv_no: number | null;
  wv_status: CourseVersionStatus | null;
  staff: CourseDto['staff'];
}

/** 課程人員只列啟用中的帳號：已停用的講師不能上課，列出來會讓人以為已有講師 */
const COURSE_SELECT = `
  SELECT c.id, c.organization_id, c.code, c.title, c.description, c.status, c.created_at,
         pv.id AS pv_id, pv.version_no AS pv_no, wv.id AS wv_id, wv.version_no AS wv_no, wv.status AS wv_status, st.staff
    FROM courses c
    LEFT JOIN course_versions pv ON pv.course_id = c.id AND pv.status = 'published'
    LEFT JOIN LATERAL (
      SELECT id, version_no, status FROM course_versions
       WHERE course_id = c.id AND status IN ('draft', 'review') ORDER BY version_no DESC LIMIT 1
    ) wv ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(json_agg(json_build_object('userId', u.id, 'displayName', u.display_name, 'role', cs.staff_role)
                               ORDER BY (cs.staff_role = 'instructor') DESC, u.display_name), '[]'::json) AS staff
        FROM course_staff cs JOIN users u ON u.id = cs.user_id
       WHERE cs.course_id = c.id AND cs.staff_role IN ('instructor', 'course_admin') AND u.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = c.organization_id AND dm.user_id = u.id)
    ) st ON true`;

function toCourse(r: CourseRow): CourseDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    code: r.code,
    title: r.title,
    description: r.description,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    publishedVersion: r.pv_id ? { id: r.pv_id, versionNo: r.pv_no! } : null,
    workingVersion: r.wv_id ? { id: r.wv_id, versionNo: r.wv_no!, status: r.wv_status! } : null,
    staff: r.staff,
  };
}

const Cursor = z.tuple([z.string().max(64), z.guid()]);

/**
 * 依序執行查詢。getVersion 也會在交易內以同一條連線呼叫（clone）——同一條連線不可並行送出查詢
 * （pg@9 將移除自動排隊）；在連線池上依序讀取只多幾毫秒。
 */
async function inOrder<T extends unknown[]>(...jobs: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
  const out: unknown[] = [];
  for (const job of jobs) out.push(await job());
  return out as T;
}

const POLICY_COLUMNS = `response_mode, max_directness_level, allow_answer_reveal_after_attempts, preferred_language, citation_required,
  allowed_knowledge_scopes, tone_profile, follow_up_questions, prohibited_topics, extra_instructions`;

interface PolicyRow {
  response_mode: CoachPolicyDto['responseMode'];
  max_directness_level: number;
  allow_answer_reveal_after_attempts: number | null;
  preferred_language: CoachPolicyDto['preferredLanguage'];
  citation_required: boolean;
  allowed_knowledge_scopes: CoachPolicyDto['allowedKnowledgeScopes'];
  tone_profile: CoachPolicyDto['toneProfile'];
  follow_up_questions: boolean;
  prohibited_topics: string[];
  extra_instructions: string | null;
}

function toPolicy(r: PolicyRow): CoachPolicyDto {
  return {
    responseMode: r.response_mode,
    maxDirectnessLevel: r.max_directness_level,
    allowAnswerRevealAfterAttempts: r.allow_answer_reveal_after_attempts,
    preferredLanguage: r.preferred_language,
    citationRequired: r.citation_required,
    allowedKnowledgeScopes: r.allowed_knowledge_scopes,
    toneProfile: r.tone_profile,
    followUpQuestions: r.follow_up_questions,
    prohibitedTopics: r.prohibited_topics,
    extraInstructions: r.extra_instructions,
  };
}

/** 自動編號的課程代碼：C-0001、C-0002…（超過 9999 時自然延長位數） */
export function autoCourseCode(n: number): string {
  return `C-${String(n).padStart(4, '0')}`;
}

/**
 * 課程與課程版本（SA UC-CRS-001~003/009/010/012、SD §6.5）。
 *
 * 不可變性（INV-2、AC-CRS-001）兩層：
 *  1. 本服務：所有內容寫入先以 FOR UPDATE 鎖定版本並確認 status = 'draft'，否則 COURSE_VERSION_IMMUTABLE（409）
 *  2. DB 觸發器（migration 0004）：即使繞過本服務直接下 SQL 也無法修改已發布版本
 */
@Injectable()
export class CourseService {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  private async tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  // ------------------------------------------------------------------ courses

  async list(
    s: GrantScopes,
    q: { organizationId?: string | undefined; status?: CourseStatus | undefined; cursor?: string | undefined; limit: number },
  ): Promise<{ data: CourseDto[]; nextCursor: string | null }> {
    if (!s.all && !s.organizations.length && !s.courses.length) return { data: [], nextCursor: null };
    let code: string | null = null;
    let id: string | null = null;
    if (q.cursor) {
      try {
        [code, id] = Cursor.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
      } catch {
        throw invalid('cursor', 'invalid');
      }
    }
    const r = await this.db.query<CourseRow>(
      `${COURSE_SELECT}
        WHERE ($1::bool OR c.organization_id = ANY($2::uuid[]) OR c.id = ANY($3::uuid[]))
          AND ($4::text IS NULL OR (c.code, c.id) > ($4::text, $5::uuid))
          AND ($7::uuid IS NULL OR c.organization_id = $7::uuid)
          AND ($8::course_status IS NULL OR c.status = $8::course_status)
        ORDER BY c.code, c.id
        LIMIT $6`,
      [s.all, s.organizations, s.courses, code, id, q.limit + 1, q.organizationId ?? null, q.status ?? null],
    );
    const page = r.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      data: page.map(toCourse),
      nextCursor: r.rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.code, last.id])).toString('base64url') : null,
    };
  }

  /**
   * 建立課程。代碼留空時依組織自動編號（C-0001 起，取現有 C-#### 的最大值 + 1）；
   * 手動代碼重複時回 code_in_use 並帶出使用中的課程名稱。
   * 兩條路徑都先鎖定組織列，同一組織的建立排隊進行——並行建立也不會編出相同號碼。
   */
  async create(
    organizationId: string,
    input: { code?: string | undefined; title: string; description?: string | undefined },
    actorId: string,
  ): Promise<CourseDto> {
    const id = await this.tx(async (c) => {
      await c.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, [organizationId]);
      let code = input.code;
      if (code === undefined) {
        const n = await c.query<{ n: number }>(
          `SELECT COALESCE(MAX(substring(code FROM '^C-([0-9]{1,9})$')::int), 0) + 1 AS n
             FROM courses WHERE organization_id = $1 AND code ~ '^C-[0-9]{1,9}$'`,
          [organizationId],
        );
        code = autoCourseCode(n.rows[0]!.n);
      } else {
        const taken = await c.query<{ title: string }>(`SELECT title FROM courses WHERE organization_id = $1 AND code = $2`, [organizationId, code]);
        if (taken.rows[0]) {
          throw new DomainError('VALIDATION_FAILED', 'code: code_in_use', [{ field: 'code', issue: 'code_in_use', params: { title: taken.rows[0].title } }]);
        }
      }
      const r = await c.query<{ id: string }>(
        `INSERT INTO courses (organization_id, code, title, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [organizationId, code, input.title, input.description ?? null, actorId],
      );
      return r.rows[0]!.id;
    });
    return this.get(id);
  }

  async get(courseId: string): Promise<CourseDetailDto> {
    const r = await this.db.query<CourseRow>(`${COURSE_SELECT} WHERE c.id = $1`, [courseId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    const v = await this.db.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM course_versions WHERE course_id = $1 ORDER BY version_no DESC`, [courseId]);
    return { ...toCourse(r.rows[0]), versions: v.rows.map(toSummary) };
  }

  /** 封存：阻擋新選課；既有選課仍可完成，版本本身不變（SA §7.1 archive） */
  async archive(courseId: string): Promise<{ course: CourseDetailDto; before: { status: string }; after: { status: string } }> {
    const cur = await this.db.query<{ status: CourseStatus }>(`SELECT status FROM courses WHERE id = $1`, [courseId]);
    if (!cur.rows[0]) throw new DomainError('NOT_FOUND');
    await this.db.query(`UPDATE courses SET status = 'archived' WHERE id = $1`, [courseId]);
    return { course: await this.get(courseId), before: { status: cur.rows[0].status }, after: { status: 'archived' } };
  }

  /**
   * 恢復封存（SD §6.5）：狀態依實際內容決定——有已發布版本為 active，否則為 draft。
   * 封存本來就沒有改動版本、內容與人員，恢復只解除「新選課／新版本」的阻擋。
   */
  async restore(courseId: string): Promise<{ course: CourseDetailDto; before: { status: string }; after: { status: CourseStatus } }> {
    const after = await this.tx(async (c) => {
      const course = await this.lockCourse(c, courseId, { allowArchived: true });
      if (course.status !== 'archived') throw rejected('not_archived');
      const pub = await c.query(`SELECT 1 FROM course_versions WHERE course_id = $1 AND status = 'published'`, [courseId]);
      const next: CourseStatus = pub.rowCount ? 'active' : 'draft';
      await c.query(`UPDATE courses SET status = $2 WHERE id = $1`, [courseId, next]);
      return next;
    });
    return { course: await this.get(courseId), before: { status: 'archived' }, after: { status: after } };
  }

  // ------------------------------------------------------------------ versions

  async createVersion(courseId: string, input: { title: string; summary?: string | undefined; navigationMode: NavigationMode }): Promise<CourseVersionDetailDto> {
    const id = await this.tx(async (c) => {
      const course = await this.lockCourse(c, courseId);
      await this.assertNoWorkingVersion(c, courseId);
      const v = await c.query<{ id: string }>(
        `INSERT INTO course_versions (course_id, organization_id, version_no, title, summary, navigation_mode)
         SELECT $1, $2, COALESCE(max(version_no), 0) + 1, $3, $4, $5 FROM course_versions WHERE course_id = $1
         RETURNING id`,
        [courseId, course.organization_id, input.title, input.summary ?? null, input.navigationMode],
      );
      const versionId = v.rows[0]!.id;
      // 預設 Coach Policy（欄位預設值即保守設定：提示優先、必須引用）；validator C4 檢查其存在
      await c.query(`INSERT INTO coach_policies (course_version_id) VALUES ($1)`, [versionId]);
      return versionId;
    });
    return this.getVersion(id);
  }

  async getVersion(id: string, q: Q = this.db): Promise<CourseVersionDetailDto> {
    const v = await q.query<
      VersionRow & { course_id: string; organization_id: string; summary: string | null; navigation_mode: NavigationMode; content_snapshot_hash: string | null }
    >(
      `SELECT ${VERSION_COLUMNS}, course_id, organization_id, summary, navigation_mode, content_snapshot_hash FROM course_versions WHERE id = $1`,
      [id],
    );
    const row = v.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');

    const [mods, lessons, acts, rules, policy, bindings] = await inOrder(
      () =>
        q.query<{ id: string; title: string; description: string | null; is_required: boolean }>(
          `SELECT id, title, description, is_required FROM modules WHERE course_version_id = $1 ORDER BY sort_order`,
          [id],
        ),
      () =>
        q.query<{ id: string; module_id: string; title: string; is_required: boolean; content_blocks: LessonBlock[] }>(
          `SELECT id, module_id, title, is_required, content_blocks FROM lessons WHERE course_version_id = $1 ORDER BY sort_order`,
          [id],
        ),
      () =>
        q.query<ActivityRow>(
        `SELECT a.id, a.lesson_id, a.title, a.activity_type, a.interactive_definition_id, a.config, a.answer_key,
                a.is_required, a.max_attempts, a.weight, a.max_score, p.prerequisite_expression
           FROM activities a LEFT JOIN activity_prerequisites p ON p.activity_id = a.id
          WHERE a.course_version_id = $1 ORDER BY a.sort_order`,
          [id],
        ),
      () =>
        q.query<{ grammar_version: string; rule_json: Record<string, unknown> }>(
          `SELECT grammar_version, rule_json FROM completion_rule_sets WHERE course_version_id = $1`,
          [id],
        ),
      () =>
        q.query<Record<string, unknown>>(
          `SELECT response_mode, max_directness_level, allow_answer_reveal_after_attempts, preferred_language, citation_required,
                  allowed_knowledge_scopes, tone_profile, follow_up_questions, prohibited_topics, extra_instructions
             FROM coach_policies WHERE course_version_id = $1`,
          [id],
        ),
      () =>
        q.query<{ document_version_id: string; binding_type: string; priority: number }>(
          `SELECT document_version_id, binding_type, priority FROM knowledge_bindings WHERE course_version_id = $1 ORDER BY priority, document_version_id`,
          [id],
        ),
    );

    const actsByLesson = groupBy(acts.rows, (a) => a.lesson_id);
    const lessonsByModule = groupBy(lessons.rows, (l) => l.module_id);
    const modules: ModuleDto[] = mods.rows.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      isRequired: m.is_required,
      lessons: (lessonsByModule.get(m.id) ?? []).map((l) => ({
        id: l.id,
        title: l.title,
        isRequired: l.is_required,
        contentBlocks: l.content_blocks,
        activities: (actsByLesson.get(l.id) ?? []).map(toActivity),
      })),
    }));
    const p = policy.rows[0];

    return {
      ...toSummary(row),
      courseId: row.course_id,
      organizationId: row.organization_id,
      summary: row.summary,
      navigationMode: row.navigation_mode,
      modules,
      completionRuleSet: rules.rows[0] ? { grammarVersion: rules.rows[0].grammar_version, rule: rules.rows[0].rule_json as unknown as RuleNode } : null,
      coachPolicy: p ? toPolicy(p as unknown as PolicyRow) : null,
      knowledgeBindings: bindings.rows.map((b) => ({ documentVersionId: b.document_version_id, bindingType: b.binding_type, priority: b.priority })),
      contentSnapshotHash: row.content_snapshot_hash,
      editable: row.status === 'draft',
    };
  }

  /**
   * 編輯草稿（UC-CRS-003）。modules 提供時整組取代課程結構：
   * 刪除本版全部 module（lesson／activity／先修條件連帶刪除）後依輸入重建，沿用輸入中的 id。
   * 草稿不會有選課或作答紀錄，重建不影響學習資料。
   */
  async updateDraft(id: string, patch: DraftPatchT): Promise<{ version: CourseVersionDetailDto; before: Record<string, unknown>; after: Record<string, unknown> }> {
    const diff = await this.tx(async (c) => {
      const v = await c.query<{ status: CourseVersionStatus; title: string; summary: string | null; navigation_mode: NavigationMode }>(
        `SELECT status, title, summary, navigation_mode FROM course_versions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const cur = v.rows[0];
      if (!cur) throw new DomainError('NOT_FOUND');
      if (cur.status !== 'draft') throw new DomainError('COURSE_VERSION_IMMUTABLE');

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const fields: [keyof DraftPatchT, string, unknown][] = [
        ['title', 'title', cur.title],
        ['summary', 'summary', cur.summary],
        ['navigationMode', 'navigation_mode', cur.navigation_mode],
      ];
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, col, old] of fields) {
        const next = patch[key];
        if (next === undefined || next === old) continue;
        params.push(next);
        sets.push(`${col} = $${params.length}`);
        before[key] = old;
        after[key] = next;
      }
      if (sets.length) await c.query(`UPDATE course_versions SET ${sets.join(', ')} WHERE id = $1`, params);

      if (patch.modules) {
        before['structure'] = await this.structureCounts(c, id);
        await this.validateStructure(c, id, patch.modules);
        await c.query(`DELETE FROM modules WHERE course_version_id = $1`, [id]);
        await this.insertStructure(c, id, patch.modules);
        after['structure'] = countStructure(patch.modules);
      }
      return { before, after };
    });
    return { version: await this.getVersion(id), ...diff };
  }

  /**
   * 複製為新草稿（UC-CRS-009、SEQ-02）：深拷貝結構並換成新 id，JSON 內的引用一併改寫。
   * 既有選課仍指向來源版本（AC-CRS-002）。知識綁定照原樣複製（改指向最新 Ready 文件版本待知識模組完成）。
   */
  async clone(sourceId: string): Promise<CourseVersionDetailDto> {
    const newId = await this.tx(async (c) => {
      const s = await c.query<{ course_id: string; organization_id: string; status: CourseVersionStatus; title: string; summary: string | null; navigation_mode: string }>(
        `SELECT course_id, organization_id, status, title, summary, navigation_mode FROM course_versions WHERE id = $1`,
        [sourceId],
      );
      const src = s.rows[0];
      if (!src) throw new DomainError('NOT_FOUND');
      await this.lockCourse(c, src.course_id);
      if (!CLONEABLE.includes(src.status)) throw rejected('source_not_published');
      await this.assertNoWorkingVersion(c, src.course_id);

      const detail = await this.getVersion(sourceId, c);
      const map = new Map<string, string>();
      for (const m of detail.modules) {
        map.set(m.id, randomUUID());
        for (const l of m.lessons) {
          map.set(l.id, randomUUID());
          for (const a of l.activities) map.set(a.id, randomUUID());
        }
      }

      const v = await c.query<{ id: string }>(
        `INSERT INTO course_versions (course_id, organization_id, version_no, title, summary, navigation_mode, cloned_from_version_id)
         SELECT $1, $2, max(version_no) + 1, $3, $4, $5, $6 FROM course_versions WHERE course_id = $1
         RETURNING id`,
        [src.course_id, src.organization_id, src.title, src.summary, src.navigation_mode, sourceId],
      );
      const id = v.rows[0]!.id;
      await this.insertStructure(c, id, remapIds(detail.modules, map));
      if (detail.completionRuleSet) {
        await c.query(`INSERT INTO completion_rule_sets (course_version_id, grammar_version, rule_json) VALUES ($1, $2, $3)`, [
          id,
          detail.completionRuleSet.grammarVersion,
          remapIds(detail.completionRuleSet.rule, map),
        ]);
      }
      await c.query(
        `INSERT INTO coach_policies (course_version_id, response_mode, max_directness_level, allow_answer_reveal_after_attempts,
                                     preferred_language, citation_required, allowed_knowledge_scopes, tone_profile,
                                     follow_up_questions, prohibited_topics, extra_instructions)
         SELECT $2, response_mode, max_directness_level, allow_answer_reveal_after_attempts, preferred_language, citation_required,
                allowed_knowledge_scopes, tone_profile, follow_up_questions, prohibited_topics, extra_instructions
           FROM coach_policies WHERE course_version_id = $1`,
        [sourceId, id],
      );
      await c.query(
        `INSERT INTO knowledge_bindings (course_version_id, document_version_id, binding_type, priority)
         SELECT $2, document_version_id, binding_type, priority FROM knowledge_bindings WHERE course_version_id = $1`,
        [sourceId, id],
      );
      return id;
    });
    return this.getVersion(newId);
  }

  /** 綁定此版本的學員數（UI 於複製／遷移前顯示，ARCH §6.3） */
  async impact(id: string): Promise<VersionImpactDto> {
    const [e, b] = await Promise.all([
      this.db.query<{ active: number; completed: number }>(
        `SELECT count(*) FILTER (WHERE status IN ('pending', 'active', 'suspended', 'reopened'))::int AS active,
                count(*) FILTER (WHERE status = 'completed')::int AS completed
           FROM enrollments WHERE course_version_id = $1`,
        [id],
      ),
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM knowledge_bindings WHERE course_version_id = $1`, [id]),
    ]);
    return { activeLearners: e.rows[0]!.active, completedLearners: e.rows[0]!.completed, boundDocumentVersions: b.rows[0]!.n };
  }

  async interactiveDefinitions(): Promise<InteractiveDefinitionDto[]> {
    const r = await this.db.query<{ id: string; component_type: string; schema_version: string; display_name: string; config_schema: Record<string, unknown> }>(
      `SELECT id, component_type, schema_version, display_name, config_schema FROM interactive_definitions
        WHERE is_enabled ORDER BY component_type, schema_version`,
    );
    return r.rows.map((d) => ({
      id: d.id,
      componentType: d.component_type,
      schemaVersion: d.schema_version,
      displayName: d.display_name,
      configSchema: d.config_schema,
    }));
  }

  // ------------------------------------------------------- completion / policy

  /**
   * 規則驗證用的課程結構（SD §3.6）。「必修活動」＝活動、所在課節、所在單元三者皆為必修。
   * 發布前 validator（C2）與規則儲存共用。
   */
  async ruleStructure(id: string, q: Q = this.db): Promise<RuleStructure> {
    const [acts, mods, lessons] = await inOrder(
      () =>
        q.query<{ id: string; activity_type: string; is_required: boolean; max_score: string; lesson_id: string; module_id: string }>(
          `SELECT a.id, a.activity_type, (a.is_required AND l.is_required AND m.is_required) AS is_required, a.max_score, a.lesson_id, l.module_id
             FROM activities a JOIN lessons l ON l.id = a.lesson_id JOIN modules m ON m.id = l.module_id
            WHERE a.course_version_id = $1`,
          [id],
        ),
      () => q.query<{ id: string }>(`SELECT id FROM modules WHERE course_version_id = $1`, [id]),
      () => q.query<{ id: string }>(`SELECT id FROM lessons WHERE course_version_id = $1`, [id]),
    );
    return {
      activities: Object.fromEntries(
        acts.rows.map((a) => [a.id, { activityType: a.activity_type, moduleId: a.module_id, lessonId: a.lesson_id, isRequired: a.is_required, maxScore: Number(a.max_score) }]),
      ),
      moduleIds: mods.rows.map((m) => m.id),
      lessonIds: lessons.rows.map((l) => l.id),
    };
  }

  /**
   * 設定完成條件（UC-CRS-004）。儲存前以 validateRule 驗證：錯誤 → 422 COURSE_VALIDATION_FAILED
   * （details[].issue 為 RULE_* 子代碼、field 為 JSON 路徑）；警告（如恆不成立）照存並隨回應回傳。
   * 之後編輯結構可能讓引用失效，發布前 validator（C2）會再檢查一次。
   */
  async updateCompletionRules(
    id: string,
    input: { grammarVersion: string; rule: Record<string, unknown> | null },
  ): Promise<{ completionRuleSet: CourseVersionDetailDto['completionRuleSet']; warnings: ValidationIssueDto[]; before: unknown; after: unknown }> {
    return this.tx(async (c) => {
      await this.lockDraft(c, id);
      const cur = await c.query<{ grammar_version: string; rule_json: RuleNode }>(`SELECT grammar_version, rule_json FROM completion_rule_sets WHERE course_version_id = $1`, [id]);
      const before = cur.rows[0] ? { grammarVersion: cur.rows[0].grammar_version, rule: cur.rows[0].rule_json } : null;

      if (input.rule === null) {
        await c.query(`DELETE FROM completion_rule_sets WHERE course_version_id = $1`, [id]);
        return { completionRuleSet: null, warnings: [], before: { completionRuleSet: before }, after: { completionRuleSet: null } };
      }
      const check = validateRule(input.rule, await this.ruleStructure(id, c));
      if (check.errors.length) {
        throw new DomainError(
          'COURSE_VALIDATION_FAILED',
          'Completion rule is invalid',
          check.errors.map((e) => ({ field: e.path, issue: e.code, params: { message: e.message } })),
        );
      }
      await c.query(
        `INSERT INTO completion_rule_sets (course_version_id, grammar_version, rule_json) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (course_version_id) DO UPDATE SET grammar_version = EXCLUDED.grammar_version, rule_json = EXCLUDED.rule_json, updated_at = now()`,
        [id, input.grammarVersion, JSON.stringify(input.rule)],
      );
      const after = { grammarVersion: input.grammarVersion, rule: input.rule as unknown as RuleNode };
      return { completionRuleSet: after, warnings: check.warnings, before: { completionRuleSet: before }, after: { completionRuleSet: after } };
    });
  }

  /** 設定 AI 教練（UC-CRS-005）：整組取代；稽核只記變更的欄位 */
  async updateCoachPolicy(id: string, input: CoachPolicyDto): Promise<{ policy: CoachPolicyDto; before: Record<string, unknown>; after: Record<string, unknown> }> {
    return this.tx(async (c) => {
      await this.lockDraft(c, id);
      const cur = await c.query<PolicyRow>(`SELECT ${POLICY_COLUMNS} FROM coach_policies WHERE course_version_id = $1`, [id]);
      const old = cur.rows[0] ? toPolicy(cur.rows[0]) : null;
      await c.query(
        `INSERT INTO coach_policies (course_version_id, response_mode, max_directness_level, allow_answer_reveal_after_attempts, preferred_language,
                                     citation_required, allowed_knowledge_scopes, tone_profile, follow_up_questions, prohibited_topics, extra_instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11)
         ON CONFLICT (course_version_id) DO UPDATE SET
           response_mode = EXCLUDED.response_mode, max_directness_level = EXCLUDED.max_directness_level,
           allow_answer_reveal_after_attempts = EXCLUDED.allow_answer_reveal_after_attempts, preferred_language = EXCLUDED.preferred_language,
           citation_required = EXCLUDED.citation_required, allowed_knowledge_scopes = EXCLUDED.allowed_knowledge_scopes,
           tone_profile = EXCLUDED.tone_profile, follow_up_questions = EXCLUDED.follow_up_questions,
           prohibited_topics = EXCLUDED.prohibited_topics, extra_instructions = EXCLUDED.extra_instructions, updated_at = now()`,
        [
          id,
          input.responseMode,
          input.maxDirectnessLevel,
          input.allowAnswerRevealAfterAttempts,
          input.preferredLanguage,
          input.citationRequired,
          JSON.stringify(input.allowedKnowledgeScopes),
          input.toneProfile,
          input.followUpQuestions,
          JSON.stringify(input.prohibitedTopics),
          input.extraInstructions,
        ],
      );
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of Object.keys(input) as (keyof CoachPolicyDto)[]) {
        if (JSON.stringify(old?.[k]) === JSON.stringify(input[k])) continue;
        before[k] = old?.[k] ?? null;
        after[k] = input[k];
      }
      return { policy: input, before, after };
    });
  }

  // ------------------------------------------------------------------ staff

  /**
   * 課程人員（UC-CRS-012）。權限依據是 user_org_roles 的課程範圍角色；
   * course_staff 是同步維護的名冊（組織角色編輯同樣會同步，見 OrganizationService.setRoles）。
   */
  async staff(courseId: string): Promise<CourseStaffDto[]> {
    const r = await this.db.query<{ user_id: string; display_name: string; email: string; role: CourseStaffRole; created_at: Date; member_disabled: boolean }>(
      `SELECT u.id AS user_id, u.display_name, u.email, r.code AS role, uor.created_at,
              EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = uor.organization_id AND dm.user_id = u.id) AS member_disabled
         FROM user_org_roles uor JOIN roles r ON r.id = uor.role_id JOIN users u ON u.id = uor.user_id
        WHERE uor.scope_type = 'course' AND uor.scope_id = $1 AND r.code IN ('instructor', 'course_admin')
        ORDER BY r.code, u.display_name`,
      [courseId],
    );
    return r.rows.map((s) => ({
      userId: s.user_id,
      displayName: s.display_name,
      email: s.email,
      role: s.role,
      assignedAt: s.created_at.toISOString(),
      memberDisabled: s.member_disabled,
    }));
  }

  /** 指派對象必須已是課程所屬組織的成員（不透過此端點建立帳號或跨組織授權） */
  async assignStaff(courseId: string, input: { email: string; role: CourseStaffRole }, actorId: string): Promise<{ userId: string; created: boolean }> {
    return this.tx(async (c) => {
      const course = await this.lockCourse(c, courseId, { allowArchived: true });
      const u = await c.query<{ id: string; disabled: boolean }>(
        `SELECT u.id, EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = $2 AND dm.user_id = u.id) AS disabled
           FROM users u
          WHERE u.email = $1 AND u.status = 'active'
            AND EXISTS (SELECT 1 FROM user_org_roles uor WHERE uor.user_id = u.id AND uor.organization_id = $2)`,
        [input.email, course.organization_id],
      );
      const userId = u.rows[0]?.id;
      if (!userId) throw invalid('email', 'not_in_organization');
      // 成員資格已停用者須先恢復，否則指派了也沒有權限
      if (u.rows[0]!.disabled) throw invalid('email', 'member_disabled');
      const g = await c.query(
        `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id, granted_by)
         SELECT $1, id, 'course', $2, $3, $4 FROM roles WHERE code = $5
         ON CONFLICT DO NOTHING`,
        [userId, courseId, course.organization_id, actorId, input.role],
      );
      await c.query(
        `INSERT INTO course_staff (course_id, user_id, staff_role, assigned_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [courseId, userId, input.role, actorId],
      );
      return { userId, created: (g.rowCount ?? 0) > 0 };
    });
  }

  // ------------------------------------------------------------------ helpers

  private async lockCourse(c: Tx, courseId: string, opts: { allowArchived?: boolean } = {}): Promise<{ organization_id: string; status: CourseStatus }> {
    const r = await c.query<{ organization_id: string; status: CourseStatus }>(
      `SELECT organization_id, status FROM courses WHERE id = $1 FOR UPDATE`,
      [courseId],
    );
    const course = r.rows[0];
    if (!course) throw new DomainError('NOT_FOUND');
    if (!opts.allowArchived && course.status === 'archived') throw rejected('course_archived');
    return course;
  }

  /** 同一課程同時至多一個編輯中版本，避免兩份草稿各自發布而互相覆蓋 */
  /** 鎖定版本並確認為草稿；否則 409 COURSE_VERSION_IMMUTABLE（應用層；DB 觸發器為第二層） */
  private async lockDraft(c: Tx, id: string): Promise<void> {
    const v = await c.query<{ status: CourseVersionStatus }>(`SELECT status FROM course_versions WHERE id = $1 FOR UPDATE`, [id]);
    if (!v.rows[0]) throw new DomainError('NOT_FOUND');
    if (v.rows[0].status !== 'draft') throw new DomainError('COURSE_VERSION_IMMUTABLE');
  }

  private async assertNoWorkingVersion(c: Tx, courseId: string): Promise<void> {
    const r = await c.query(`SELECT 1 FROM course_versions WHERE course_id = $1 AND status = ANY($2::course_version_status[])`, [courseId, WORKING]);
    if (r.rowCount) throw rejected('draft_exists');
  }

  private async structureCounts(c: Tx, id: string) {
    const r = await c.query<{ modules: number; lessons: number; activities: number }>(
      `SELECT (SELECT count(*)::int FROM modules WHERE course_version_id = $1) AS modules,
              (SELECT count(*)::int FROM lessons WHERE course_version_id = $1) AS lessons,
              (SELECT count(*)::int FROM activities WHERE course_version_id = $1) AS activities`,
      [id],
    );
    return r.rows[0]!;
  }

  /** 需要 DB 的結構規則：id 唯一、不可沿用他版本的 id、活動區塊只能引用同單元的活動、互動元件存在 */
  private async validateStructure(c: Tx, versionId: string, modules: ModuleInputT[]): Promise<void> {
    const seen = new Map<string, string>();
    const ids = { modules: [] as string[], lessons: [] as string[], activities: [] as string[] };
    const defs = new Map<string, string>();
    const claim = (id: string, path: string) => {
      if (seen.has(id)) throw invalid(path, 'duplicate_id');
      seen.set(id, path);
    };

    modules.forEach((m, mi) => {
      claim(m.id, `modules.${mi}.id`);
      ids.modules.push(m.id);
      m.lessons.forEach((l, li) => {
        const lp = `modules.${mi}.lessons.${li}`;
        claim(l.id, `${lp}.id`);
        ids.lessons.push(l.id);
        const lessonActs = new Set(l.activities.map((a) => a.id));
        l.activities.forEach((a, ai) => {
          claim(a.id, `${lp}.activities.${ai}.id`);
          ids.activities.push(a.id);
          if (a.interactiveDefinitionId && !defs.has(a.interactiveDefinitionId)) defs.set(a.interactiveDefinitionId, `${lp}.activities.${ai}.interactiveDefinitionId`);
        });
        l.contentBlocks.forEach((b, bi) => {
          if (b.type === 'activity' && !lessonActs.has(b.activityId)) throw invalid(`${lp}.contentBlocks.${bi}.activityId`, 'activity_not_in_lesson');
        });
      });
    });
    if (ids.activities.length > COURSE_LIMITS.activitiesTotal) throw invalid('modules', 'too_many_activities');

    const foreign = await c.query<{ id: string }>(
      `SELECT id FROM modules WHERE id = ANY($1::uuid[]) AND course_version_id <> $4
       UNION ALL SELECT id FROM lessons WHERE id = ANY($2::uuid[]) AND course_version_id <> $4
       UNION ALL SELECT id FROM activities WHERE id = ANY($3::uuid[]) AND course_version_id <> $4
       LIMIT 1`,
      [ids.modules, ids.lessons, ids.activities, versionId],
    );
    if (foreign.rows[0]) throw invalid(seen.get(foreign.rows[0].id)!, 'id_conflict');

    if (defs.size) {
      const ok = await c.query<{ id: string }>(`SELECT id FROM interactive_definitions WHERE id = ANY($1::uuid[]) AND is_enabled`, [[...defs.keys()]]);
      const found = new Set(ok.rows.map((r) => r.id));
      for (const [id, path] of defs) if (!found.has(id)) throw invalid(path, 'unknown_interactive_definition');
    }
  }

  /** 以 jsonb_to_recordset 每張表一次寫入；sort_order 取陣列順序 */
  private async insertStructure(c: Tx, versionId: string, modules: (ModuleInputT | ModuleDto)[]): Promise<void> {
    const mods = modules.map((m, i) => ({ id: m.id, sort_order: i + 1, title: m.title, description: m.description, is_required: m.isRequired }));
    const lessons = modules.flatMap((m) =>
      m.lessons.map((l, i) => ({ id: l.id, module_id: m.id, sort_order: i + 1, title: l.title, content_blocks: l.contentBlocks, is_required: l.isRequired })),
    );
    const acts = modules.flatMap((m) =>
      m.lessons.flatMap((l) =>
        l.activities.map((a, i) => ({
          id: a.id,
          lesson_id: l.id,
          sort_order: i + 1,
          title: a.title,
          activity_type: a.activityType,
          interactive_definition_id: a.interactiveDefinitionId,
          config: a.config,
          answer_key: a.answerKey,
          is_required: a.isRequired,
          max_attempts: a.maxAttempts,
          weight: a.weight,
          max_score: a.maxScore,
          prerequisite: a.prerequisite,
        })),
      ),
    );
    if (mods.length) {
      await c.query(
        `INSERT INTO modules (id, course_version_id, sort_order, title, description, is_required)
         SELECT id, $1, sort_order, title, description, is_required
           FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, sort_order int, title text, description text, is_required boolean)`,
        [versionId, JSON.stringify(mods)],
      );
    }
    if (lessons.length) {
      await c.query(
        `INSERT INTO lessons (id, module_id, course_version_id, sort_order, title, content_blocks, is_required)
         SELECT id, module_id, $1, sort_order, title, content_blocks, is_required
           FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, module_id uuid, sort_order int, title text, content_blocks jsonb, is_required boolean)`,
        [versionId, JSON.stringify(lessons)],
      );
    }
    if (acts.length) {
      await c.query(
        `INSERT INTO activities (id, lesson_id, course_version_id, sort_order, title, activity_type, interactive_definition_id,
                                 config, answer_key, is_required, max_attempts, weight, max_score)
         SELECT id, lesson_id, $1, sort_order, title, activity_type, interactive_definition_id,
                config, answer_key, is_required, max_attempts, weight, max_score
           FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, lesson_id uuid, sort_order int, title text, activity_type text,
                interactive_definition_id uuid, config jsonb, answer_key jsonb, is_required boolean, max_attempts int,
                weight numeric, max_score numeric)`,
        [versionId, JSON.stringify(acts)],
      );
      const pre = acts.filter((a) => a.prerequisite).map((a) => ({ activity_id: a.id, expr: a.prerequisite }));
      if (pre.length) {
        await c.query(
          `INSERT INTO activity_prerequisites (activity_id, prerequisite_expression)
           SELECT activity_id, expr FROM jsonb_to_recordset($1::jsonb) AS x(activity_id uuid, expr jsonb)`,
          [JSON.stringify(pre)],
        );
      }
    }
  }
}

// ---------------------------------------------------------------------- mapping

interface VersionRow {
  id: string;
  version_no: number;
  status: CourseVersionStatus;
  title: string;
  published_at: Date | null;
  created_at: Date;
  cloned_from_version_id: string | null;
}

const VERSION_COLUMNS = 'id, version_no, status, title, published_at, created_at, cloned_from_version_id';

function toSummary(r: VersionRow): CourseVersionSummaryDto {
  return {
    id: r.id,
    versionNo: r.version_no,
    status: r.status,
    title: r.title,
    publishedAt: r.published_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    clonedFromVersionId: r.cloned_from_version_id,
  };
}

interface ActivityRow {
  id: string;
  lesson_id: string;
  title: string;
  activity_type: ActivityType;
  interactive_definition_id: string | null;
  config: Record<string, unknown>;
  answer_key: Record<string, unknown> | null;
  is_required: boolean;
  max_attempts: number | null;
  weight: string;
  max_score: string;
  prerequisite_expression: Record<string, unknown> | null;
}

function toActivity(a: ActivityRow): ActivityDto {
  return {
    id: a.id,
    title: a.title,
    activityType: a.activity_type,
    interactiveDefinitionId: a.interactive_definition_id,
    config: a.config,
    answerKey: a.answer_key,
    isRequired: a.is_required,
    maxAttempts: a.max_attempts,
    // numeric 欄位由 pg 以字串回傳
    weight: Number(a.weight),
    maxScore: Number(a.max_score),
    prerequisite: a.prerequisite_expression,
  };
}

function countStructure(modules: ModuleInputT[]) {
  const lessons = modules.flatMap((m) => m.lessons);
  return { modules: modules.length, lessons: lessons.length, activities: lessons.reduce((n, l) => n + l.activities.length, 0) };
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

function camelize(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()), v]));
}

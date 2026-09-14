import { Inject, Injectable } from '@nestjs/common';
import type { EnrollMethod, EnrollmentStatus, ResultStatus } from '@iac/contracts';
import pg from 'pg';
import { toCsv } from '../../../common/csv.js';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { EnrollmentService } from './enrollment.service.js';

/** 一次匯出的上限；超過請用篩選縮小範圍（不做靜默截斷） */
export const EXPORT_MAX_ROWS = 10_000;

const STATUS: Record<EnrollmentStatus, string> = {
  pending: '待審核',
  active: '學習中',
  suspended: '已暫停',
  completed: '已完成',
  reopened: '重新開啟',
  withdrawn: '已退課',
  rejected: '未通過審核',
};
const METHOD: Record<EnrollMethod, string> = { assign: '指派', self: '自行加入', code: '選課碼', approval: '申請審核' };
const RESULT: Record<ResultStatus, string> = { passed: '通過', completed: '完成', needs_improvement: '需要再加強', failed: '未通過' };

/** 日期時間以台灣時間呈現（試算表裡直接可讀） */
const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false }).slice(0, 16) : '');

/**
 * 學員名單匯出（SD §6.24）：名單欄位、進度、總分，加上「目前已發布版本」每個活動的最佳結果（分數，沒有分數時顯示結果）。
 * 綁在其他版本的學員，該版本特有的活動不在欄位中（留空）。CSV 以 UTF-8 BOM 開頭、儲存格防公式注入（common/csv.ts）。
 */
@Injectable()
export class LearnerExportService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    private readonly enrollments: EnrollmentService,
  ) {}

  async export(courseId: string, filters: { status?: EnrollmentStatus | undefined; cohort?: string | undefined; q?: string | undefined }): Promise<{ csv: string; rows: number; filename: string }> {
    const course = await this.db.query<{ code: string }>(`SELECT code FROM courses WHERE id = $1`, [courseId]);
    if (!course.rows[0]) throw new DomainError('NOT_FOUND');
    const list = await this.enrollments.learners(courseId, { ...filters, limit: EXPORT_MAX_ROWS });
    if (list.nextCursor) throw new DomainError('VALIDATION_FAILED', 'too_many_rows', [{ issue: 'export_too_many_rows', params: { max: String(EXPORT_MAX_ROWS) } }]);

    const acts = await this.db.query<{ id: string; title: string }>(
      `SELECT a.id, a.title FROM activities a
         JOIN lessons l ON l.id = a.lesson_id JOIN modules m ON m.id = l.module_id
         JOIN course_versions cv ON cv.id = a.course_version_id
        WHERE cv.course_id = $1 AND cv.status = 'published'
        ORDER BY m.sort_order, l.sort_order, a.sort_order`,
      [courseId],
    );
    const best = await this.db.query<{ enrollment_id: string; activity_id: string; status: ResultStatus; score: string | null; max_score: string }>(
      `SELECT DISTINCT ON (lr.enrollment_id, lr.activity_id) lr.enrollment_id, lr.activity_id, lr.status, lr.score, lr.max_score
         FROM learning_results lr WHERE lr.enrollment_id = ANY($1::uuid[])
        ORDER BY lr.enrollment_id, lr.activity_id, lr.score DESC NULLS LAST, lr.evaluated_at DESC`,
      [list.data.map((l) => l.id)],
    );
    const results = new Map(best.rows.map((r) => [`${r.enrollment_id}:${r.activity_id}`, r]));

    const header = [
      '學號',
      '姓名',
      'Email',
      '班級（選課時）',
      '狀態',
      '加入方式',
      '加入時間',
      '課程版本',
      '必修完成',
      '必修總數',
      '完成率',
      '目前總分',
      '最後學習',
      '完成時間',
      '期限',
      ...acts.rows.map((a) => a.title),
    ];
    const rows = list.data.map((l) => {
      const p = l.progress;
      return [
        l.memberNo ?? '',
        l.displayName,
        l.email,
        l.cohortLabel ?? '',
        STATUS[l.status],
        METHOD[l.enrollMethod],
        at(l.enrolledAt),
        `v${l.versionNo}`,
        p?.requiredCompleted ?? '',
        p?.requiredTotal ?? '',
        p && p.requiredTotal ? `${Math.round((p.requiredCompleted / p.requiredTotal) * 100)}%` : '',
        p?.weightedScore ?? '',
        at(l.lastActivityAt),
        at(l.completedAt),
        at(l.dueDate),
        ...acts.rows.map((a) => {
          const r = results.get(`${l.id}:${a.id}`);
          return r ? (r.score !== null ? Number(r.score) : RESULT[r.status]) : '';
        }),
      ];
    });
    const day = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 10).replace(/-/g, '');
    // 檔名只用 ASCII（Content-Disposition 相容性）；課程代碼含非 ASCII 時改用 course
    const safe = /^[\w.-]+$/.test(course.rows[0].code) ? course.rows[0].code : 'course';
    return { csv: toCsv(header, rows), rows: rows.length, filename: `learners-${safe}-${day}.csv` };
  }
}

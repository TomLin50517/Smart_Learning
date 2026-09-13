import { Inject, Injectable } from '@nestjs/common';
import {
  EVENTS_PER_MINUTE,
  LEARNABLE_STATUSES,
  type EnrollmentStatus,
  type EnrollmentTimelineDto,
  type LearningEventBatchResponse,
  type LearningEventInput,
  type TimelineItemDto,
} from '@iac/contracts';
import { checkClientEvent } from '@iac/domain';
import pg from 'pg';
import { z } from 'zod';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { RateLimiter } from '../../../common/rate-limit.js';
import { COMPLETION_ENGINE, type CompletionEngine } from '../../completion/completion.contracts.js';
import type { LearningEventWriter, ServerEvent } from '../learning-record.contracts.js';
import { toLearningTime } from './learning-time.js';

/** 事件時間可接受的範圍：未來 1 分鐘（時鐘誤差）到過去 24 小時（離線補送） */
const FUTURE_SKEW_MS = 60_000;
const MAX_AGE_MS = 86_400_000;
/** timeline 不列出的高頻事件——它們已彙總成學習時間與觀看比例 */
const HIGH_FREQUENCY = ['video.progressed', 'activity.input_changed', 'activity.heartbeat'];
/** timeline 依事件類型挑出的細節（payload 其餘欄位不外露，例：input_hash） */
const DETAIL_FIELDS: Record<string, [string, string][]> = {
  'course.enrolled': [['method', 'method']],
  'activity.started': [['attempt_no', 'attemptNo']],
  'activity.retry_started': [['attempt_no', 'attemptNo']],
  'activity.result_ready': [
    ['status', 'status'],
    ['score', 'score'],
    ['max_score', 'maxScore'],
  ],
  'video.started': [['duration_sec', 'durationSec']],
};
const Cursor = z.tuple([z.string().max(64), z.guid()]);
const invalid = (field: string, issue: string) => new DomainError('VALIDATION_FAILED', 'Validation failed', [{ field, issue }]);

/**
 * 學習事件（SA §10、SEQ-03、SD §6.12）：學員端事件接收、伺服器端事件寫入、timeline。
 * 身分欄位（組織、課程、版本、選課、學員）一律由伺服器依作答與選課推導，不採信學員端（ADR-021、INV-1）。
 */
@Injectable()
export class LearningEventService implements LearningEventWriter {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(COMPLETION_ENGINE) private readonly engine: CompletionEngine,
    private readonly limiter: RateLimiter,
  ) {}

  async recordTx(c: pg.PoolClient, enrollmentId: string, events: ServerEvent[]): Promise<void> {
    if (!events.length) return;
    // 同一交易內的事件以毫秒區隔，維持 timeline 的先後
    await c.query(
      `INSERT INTO learning_events (event_id, event_type, organization_id, course_id, course_version_id, enrollment_id, learner_id, activity_id, attempt_id, occurred_at, payload)
       SELECT gen_random_uuid(), x.event_type, e.organization_id, e.course_id, e.course_version_id, e.id, e.user_id, x.activity_id, x.attempt_id,
              now() + (x.ord - 1) * interval '1 millisecond', COALESCE(x.payload, '{}'::jsonb)
         FROM enrollments e,
              ROWS FROM (jsonb_to_recordset($2::jsonb) AS (event_type text, activity_id uuid, attempt_id uuid, payload jsonb))
                WITH ORDINALITY AS x(event_type, activity_id, attempt_id, payload, ord)
        WHERE e.id = $1`,
      [enrollmentId, JSON.stringify(events.map((ev) => ({ event_type: ev.eventType, activity_id: ev.activityId ?? null, attempt_id: ev.attemptId ?? null, payload: ev.payload ?? {} })))],
    );
  }

  /**
   * 學員端事件（POST /attempts/{id}/events）：只收進行中作答的白名單事件；event_id 冪等（重送算 duplicated）；
   * 每筆選課每分鐘 120 筆，超過 429 並丟棄——前端不因此中斷學習（THR-D-002）。
   */
  async ingest(attemptId: string, userId: string, events: LearningEventInput[], correlationId: string): Promise<LearningEventBatchResponse> {
    const r = await this.db.query<{ enrollment_id: string; activity_id: string; attempt_status: string; user_id: string; enrollment_status: EnrollmentStatus }>(
      `SELECT la.enrollment_id, la.activity_id, la.status AS attempt_status, e.user_id, e.status AS enrollment_status
         FROM learning_attempts la JOIN enrollments e ON e.id = la.enrollment_id WHERE la.id = $1`,
      [attemptId],
    );
    const a = r.rows[0];
    if (!a || a.user_id !== userId) throw new DomainError('NOT_FOUND');
    if (!LEARNABLE_STATUSES.includes(a.enrollment_status)) throw new DomainError('ENROLLMENT_NOT_ACTIVE');
    await this.limiter.enforce(`events:enr:${a.enrollment_id}`, EVENTS_PER_MINUTE, 60, events.length);

    const now = Date.now();
    const rejected: LearningEventBatchResponse['rejected'] = [];
    const seen = new Set<string>();
    const rows: { event_id: string; event_type: string; occurred_at: string; clock_skew_ms: number; payload: Record<string, unknown> }[] = [];
    let duplicated = 0;
    for (const ev of events) {
      if (seen.has(ev.eventId)) {
        duplicated++;
        continue;
      }
      seen.add(ev.eventId);
      const at = Date.parse(ev.occurredAt);
      const reason =
        a.attempt_status !== 'in_progress'
          ? 'attempt_closed'
          : ev.activityId && ev.activityId !== a.activity_id
            ? 'activity_mismatch'
            : at > now + FUTURE_SKEW_MS || at < now - MAX_AGE_MS
              ? 'occurred_at_out_of_range'
              : checkClientEvent(ev.eventType, ev.payload);
      if (reason) rejected.push({ eventId: ev.eventId, reason });
      else rows.push({ event_id: ev.eventId, event_type: ev.eventType, occurred_at: new Date(at).toISOString(), clock_skew_ms: now - at, payload: ev.payload });
    }
    if (!rows.length) return { accepted: 0, duplicated, rejected };

    const have = await this.db.query<{ event_id: string }>(`SELECT event_id FROM learning_events WHERE enrollment_id = $1 AND event_id = ANY($2::uuid[])`, [
      a.enrollment_id,
      rows.map((x) => x.event_id),
    ]);
    const known = new Set(have.rows.map((x) => x.event_id));
    const fresh = rows.filter((x) => !known.has(x.event_id));
    duplicated += rows.length - fresh.length;
    if (!fresh.length) return { accepted: 0, duplicated, rejected };

    const ins = await this.db.query(
      `INSERT INTO learning_events (event_id, event_type, organization_id, course_id, course_version_id, enrollment_id, learner_id, activity_id, attempt_id,
                                    occurred_at, clock_skew_ms, correlation_id, payload)
       SELECT x.event_id, x.event_type, e.organization_id, e.course_id, e.course_version_id, e.id, e.user_id, $2, $3,
              x.occurred_at, x.clock_skew_ms, $4, x.payload
         FROM enrollments e,
              jsonb_to_recordset($5::jsonb) AS x(event_id uuid, event_type text, occurred_at timestamptz, clock_skew_ms integer, payload jsonb)
        WHERE e.id = $1
       ON CONFLICT DO NOTHING`,
      [a.enrollment_id, a.activity_id, attemptId, correlationId, JSON.stringify(fresh)],
    );
    const accepted = ins.rowCount ?? 0;
    return { accepted, duplicated: duplicated + fresh.length - accepted, rejected };
  }

  /**
   * 學習歷程（新到舊，keyset 分頁）。高頻事件不列出，改以學習時間呈現。
   * selfUserId：學員讀自己的——不是本人的選課一律 404。課程人員的授權由路由守門（learning.timeline.read_all）。
   */
  async timeline(enrollmentId: string, q: { cursor?: string | undefined; limit: number }, selfUserId: string | null): Promise<EnrollmentTimelineDto> {
    if (selfUserId) {
      const own = await this.db.query(`SELECT 1 FROM enrollments WHERE id = $1 AND user_id = $2 AND status <> 'rejected'`, [enrollmentId, selfUserId]);
      if (!own.rowCount) throw new DomainError('NOT_FOUND');
    }
    let at: string | null = null;
    let id: string | null = null;
    if (q.cursor) {
      try {
        [at, id] = Cursor.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
      } catch {
        throw invalid('cursor', 'invalid');
      }
    }
    const r = await this.db.query<{
      id: string;
      event_type: string;
      occurred_at: Date;
      at_text: string;
      activity_id: string | null;
      activity_title: string | null;
      attempt_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT le.id, le.event_type, le.occurred_at, le.occurred_at::text AS at_text, le.activity_id, a.title AS activity_title, le.attempt_id, le.payload
         FROM learning_events le LEFT JOIN activities a ON a.id = le.activity_id
        WHERE le.enrollment_id = $1 AND le.event_type <> ALL($2::text[])
          AND ($3::timestamptz IS NULL OR (le.occurred_at, le.id) < ($3::timestamptz, $4::uuid))
        ORDER BY le.occurred_at DESC, le.id DESC
        LIMIT $5`,
      [enrollmentId, HIGH_FREQUENCY, at, id, q.limit + 1],
    );
    const page = r.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const data: TimelineItemDto[] = page.map((x) => ({
      id: x.id,
      eventType: x.event_type,
      occurredAt: x.occurred_at.toISOString(),
      activityId: x.activity_id,
      activityTitle: x.activity_title,
      attemptId: x.attempt_id,
      details: Object.fromEntries(
        (DETAIL_FIELDS[x.event_type] ?? []).flatMap(([from, to]) => {
          const v = x.payload[from];
          return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null ? [[to, v]] : [];
        }),
      ),
    }));
    return {
      data,
      meta: { next_cursor: r.rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.at_text, last.id])).toString('base64url') : null },
      time: toLearningTime(await this.engine.progress(enrollmentId)),
    };
  }
}

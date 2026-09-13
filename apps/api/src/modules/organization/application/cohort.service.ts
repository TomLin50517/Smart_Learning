import { Inject, Injectable } from '@nestjs/common';
import type { CohortDto, CohortRefDto, CohortStatus, MemberProfileDto } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';

type Tx = pg.PoolClient;
type Q = pg.Pool | pg.PoolClient;

const invalid = (field: string, issue: string) => new DomainError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue }]);
const rejected = (issue: string) => new DomainError('VALIDATION_FAILED', issue, [{ issue }]);
const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

interface CohortRow {
  id: string;
  name: string;
  term: string | null;
  status: CohortStatus;
  member_count: number;
  created_at: Date;
  archived_at: Date | null;
}

const COHORT_COLUMNS = `c.id, c.name, c.term, c.status, c.created_at, c.archived_at,
  (SELECT count(*)::int FROM cohort_members cm WHERE cm.cohort_id = c.id) AS member_count`;

function toCohort(r: CohortRow): CohortDto {
  return {
    id: r.id,
    name: r.name,
    term: r.term,
    status: r.status,
    memberCount: r.member_count,
    createdAt: r.created_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
  };
}

/** 成員目前（使用中）的班級 */
export async function activeCohortsOf(q: Q, orgId: string, userId: string): Promise<CohortRefDto[]> {
  const r = await q.query<CohortRefDto>(
    `SELECT co.id, co.name FROM cohort_members cm JOIN cohorts co ON co.id = cm.cohort_id
      WHERE cm.organization_id = $1 AND cm.user_id = $2 AND co.status = 'active' ORDER BY co.name`,
    [orgId, userId],
  );
  return r.rows;
}

/** 設定學號（null＝清除）。與本組織其他成員重複 → member_no_taken。回傳是否有變更 */
export async function setMemberNoTx(tx: Tx, orgId: string, userId: string, memberNo: string | null, actorId: string): Promise<boolean> {
  const cur = await tx.query<{ member_no: string | null }>(`SELECT member_no FROM member_profiles WHERE organization_id = $1 AND user_id = $2`, [orgId, userId]);
  if ((cur.rows[0]?.member_no ?? null) === memberNo) return false;
  if (memberNo !== null) {
    const taken = await tx.query(`SELECT 1 FROM member_profiles WHERE organization_id = $1 AND member_no = $2 AND user_id <> $3`, [orgId, memberNo, userId]);
    if (taken.rowCount) throw invalid('memberNo', 'member_no_taken');
  }
  await tx.query(
    `INSERT INTO member_profiles (organization_id, user_id, member_no, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET member_no = EXCLUDED.member_no, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, userId, memberNo, actorId],
  );
  return true;
}

/** 加入班級（已在其中則不變）。回傳是否新加入 */
export async function joinCohortTx(tx: Tx, orgId: string, cohortId: string, userId: string, actorId: string): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO cohort_members (cohort_id, user_id, organization_id, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [cohortId, userId, orgId, actorId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 依名稱（不分大小寫）找使用中的班級；找不到時依 create 決定建立或回報 cohort_not_found */
export async function findOrCreateCohortTx(tx: Tx, orgId: string, name: string, create: boolean, actorId: string): Promise<{ id: string; name: string; created: boolean }> {
  const f = await tx.query<{ id: string; name: string }>(`SELECT id, name FROM cohorts WHERE organization_id = $1 AND lower(name) = lower($2) AND status = 'active'`, [
    orgId,
    name,
  ]);
  if (f.rows[0]) return { ...f.rows[0], created: false };
  if (!create) throw invalid('cohort', 'cohort_not_found');
  const n = await tx.query<{ id: string; name: string }>(`INSERT INTO cohorts (organization_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name`, [orgId, name, actorId]);
  return { ...n.rows[0]!, created: true };
}

async function profileOf(q: Q, orgId: string, userId: string): Promise<MemberProfileDto> {
  const r = await q.query<{ member_no: string | null }>(`SELECT member_no FROM member_profiles WHERE organization_id = $1 AND user_id = $2`, [orgId, userId]);
  return { memberNo: r.rows[0]?.member_no ?? null, cohorts: await activeCohortsOf(q, orgId, userId) };
}

/**
 * 班級／梯次與成員資料（SD §6.15）。每學年（每期）建新班級、舊的封存不刪——選課紀錄保留當時的班級。
 * 調整學號與班級不影響帳號與角色，也不需要重新邀請。
 */
@Injectable()
export class CohortService {
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

  private async one(orgId: string, id: string): Promise<CohortRow> {
    const r = await this.db.query<CohortRow>(`SELECT ${COHORT_COLUMNS} FROM cohorts c WHERE c.id = $1 AND c.organization_id = $2`, [id, orgId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return r.rows[0];
  }

  async list(orgId: string, status: CohortStatus | 'all'): Promise<CohortDto[]> {
    const r = await this.db.query<CohortRow>(
      `SELECT ${COHORT_COLUMNS} FROM cohorts c
        WHERE c.organization_id = $1 AND ($2::text = 'all' OR c.status = $2::text)
        ORDER BY c.status, c.created_at DESC, c.name LIMIT 1000`,
      [orgId, status],
    );
    return r.rows.map(toCohort);
  }

  async create(orgId: string, input: { name: string; term?: string | null | undefined }, actorId: string): Promise<CohortDto> {
    try {
      const r = await this.db.query<{ id: string }>(`INSERT INTO cohorts (organization_id, name, term, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [
        orgId,
        input.name,
        input.term || null,
        actorId,
      ]);
      return toCohort(await this.one(orgId, r.rows[0]!.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw invalid('name', 'already_exists');
      throw e;
    }
  }

  async update(orgId: string, id: string, patch: { name?: string | undefined; term?: string | null | undefined }): Promise<{ cohort: CohortDto; before: { name: string; term: string | null } }> {
    const before = await this.one(orgId, id);
    try {
      await this.db.query(
        `UPDATE cohorts SET name = COALESCE($3, name), term = CASE WHEN $4::boolean THEN $5 ELSE term END WHERE id = $1 AND organization_id = $2`,
        [id, orgId, patch.name ?? null, patch.term !== undefined, patch.term || null],
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw invalid('name', 'already_exists');
      throw e;
    }
    return { cohort: toCohort(await this.one(orgId, id)), before: { name: before.name, term: before.term } };
  }

  /** 封存／恢復。恢復時若已有同名的使用中班級 → already_exists */
  async setStatus(orgId: string, id: string, status: CohortStatus): Promise<{ cohort: CohortDto; before: CohortStatus }> {
    const cur = await this.one(orgId, id);
    if (cur.status === status) throw rejected(status === 'archived' ? 'cohort_already_archived' : 'cohort_not_archived');
    try {
      await this.db.query(
        `UPDATE cohorts SET status = $3::text, archived_at = CASE WHEN $3::text = 'archived' THEN now() END WHERE id = $1 AND organization_id = $2`,
        [id, orgId, status],
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw invalid('name', 'already_exists');
      throw e;
    }
    return { cohort: toCohort(await this.one(orgId, id)), before: cur.status };
  }

  /**
   * 成員資料：學號與目前班級。cohortIds 整組取代「使用中」班級的成員資格；封存班級的紀錄保留。
   * 對象須為本組織成員（否則 404）。
   */
  async setProfile(
    orgId: string,
    userId: string,
    input: { memberNo?: string | null | undefined; cohortIds?: string[] | undefined },
    actorId: string,
  ): Promise<{ before: MemberProfileDto; after: MemberProfileDto }> {
    return this.tx(async (c) => {
      const m = await c.query(`SELECT 1 FROM user_org_roles WHERE organization_id = $1 AND user_id = $2 LIMIT 1`, [orgId, userId]);
      if (!m.rowCount) throw new DomainError('NOT_FOUND');
      const before = await profileOf(c, orgId, userId);
      if (input.memberNo !== undefined) await setMemberNoTx(c, orgId, userId, input.memberNo?.trim() || null, actorId);
      if (input.cohortIds !== undefined) {
        const ids = [...new Set(input.cohortIds)];
        if (ids.length) {
          const ok = await c.query(`SELECT id FROM cohorts WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND status = 'active'`, [ids, orgId]);
          if (ok.rowCount !== ids.length) throw invalid('cohortIds', 'cohort_not_found');
        }
        await c.query(
          `DELETE FROM cohort_members cm USING cohorts co
            WHERE co.id = cm.cohort_id AND cm.organization_id = $1 AND cm.user_id = $2 AND co.status = 'active'
              AND NOT (cm.cohort_id = ANY($3::uuid[]))`,
          [orgId, userId, ids],
        );
        for (const id of ids) await joinCohortTx(c, orgId, id, userId, actorId);
      }
      return { before, after: await profileOf(c, orgId, userId) };
    });
  }
}

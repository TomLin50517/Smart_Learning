import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { DB_API } from './database.module.js';

export interface ResolvedResource {
  exists: boolean;
  organizationId: string | null;
  courseId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSING: ResolvedResource = { exists: false, organizationId: null, courseId: null };

/**
 * 把 route param 的資源 id 解析為其所屬組織／課程（INV-1：org 由資源歸屬推導，不採信 client）。
 * 各模組日後可擴充資源種類；未知或格式不符的 id 一律視為不存在。
 */
@Injectable()
export class ScopeResolver {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  async resolve(resource: 'organization' | 'course' | 'course_version' | 'enrollment' | 'certificate', id: string | undefined): Promise<ResolvedResource> {
    if (!id || !UUID.test(id)) return MISSING;

    switch (resource) {
      case 'organization': {
        const r = await this.db.query<{ id: string }>(`SELECT id FROM organizations WHERE id = $1 AND status = 'active'`, [id]);
        return r.rows[0] ? { exists: true, organizationId: r.rows[0].id, courseId: null } : MISSING;
      }
      case 'course': {
        const r = await this.db.query<{ organization_id: string }>(`SELECT organization_id FROM courses WHERE id = $1`, [id]);
        return r.rows[0] ? { exists: true, organizationId: r.rows[0].organization_id, courseId: id } : MISSING;
      }
      case 'course_version': {
        const r = await this.db.query<{ organization_id: string; course_id: string }>(
          `SELECT organization_id, course_id FROM course_versions WHERE id = $1`,
          [id],
        );
        return r.rows[0] ? { exists: true, organizationId: r.rows[0].organization_id, courseId: r.rows[0].course_id } : MISSING;
      }
      case 'enrollment': {
        const r = await this.db.query<{ organization_id: string; course_id: string }>(`SELECT organization_id, course_id FROM enrollments WHERE id = $1`, [id]);
        return r.rows[0] ? { exists: true, organizationId: r.rows[0].organization_id, courseId: r.rows[0].course_id } : MISSING;
      }
      case 'certificate': {
        const r = await this.db.query<{ organization_id: string; course_id: string }>(
          `SELECT e.organization_id, e.course_id FROM certificates c JOIN enrollments e ON e.id = c.enrollment_id WHERE c.id = $1`,
          [id],
        );
        return r.rows[0] ? { exists: true, organizationId: r.rows[0].organization_id, courseId: r.rows[0].course_id } : MISSING;
      }
    }
  }
}

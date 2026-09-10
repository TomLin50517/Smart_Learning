import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import type { PermissionGrant } from './context.js';
import { DB_API } from './database.module.js';

/**
 * 載入使用者的有效授權（role → permission × scope）。
 * 已停用組織的授權自動失效；過期的授權不計入。
 */
@Injectable()
export class GrantLoader {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  async load(userId: string): Promise<PermissionGrant[]> {
    const r = await this.db.query<{
      permission: string;
      scope_type: PermissionGrant['type'];
      scope_id: string | null;
      organization_id: string | null;
    }>(
      `SELECT p.code AS permission, uor.scope_type, uor.scope_id, uor.organization_id
         FROM user_org_roles uor
         JOIN role_permissions rp ON rp.role_id = uor.role_id
         JOIN permissions p       ON p.id = rp.permission_id
        WHERE uor.user_id = $1
          AND (uor.expires_at IS NULL OR uor.expires_at > now())
          AND (uor.organization_id IS NULL OR EXISTS (
                SELECT 1 FROM organizations o WHERE o.id = uor.organization_id AND o.status = 'active'))`,
      [userId],
    );
    return r.rows.map((x) => ({
      permission: x.permission,
      type: x.scope_type,
      id: x.scope_id,
      organizationId: x.organization_id,
    }));
  }
}

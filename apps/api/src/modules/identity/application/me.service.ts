import { Inject, Injectable } from '@nestjs/common';
import { resolveBranding, type MeResponse, type ScopeType } from '@iac/contracts';
import pg from 'pg';
import type { AuthUser } from '../../../common/context.js';
import { DB_API } from '../../../common/database.module.js';
import { GrantLoader } from '../../../common/grant-loader.js';
import { LICENSE_EVALUATOR, type LicenseEvaluator } from '../../license/license.contracts.js';

@Injectable()
export class MeService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    private readonly grants: GrantLoader,
    @Inject(LICENSE_EVALUATOR) private readonly license: LicenseEvaluator,
  ) {}

  async build(user: AuthUser): Promise<MeResponse> {
    const [grants, orgs, evaluation] = await Promise.all([
      this.grants.load(user.id),
      this.db.query<{ id: string; code: string; name: string; branding: Record<string, unknown>; logo_sha: string | null; icon_sha: string | null }>(
        `SELECT DISTINCT o.id, o.code, o.name, o.branding,
                (SELECT a.sha256 FROM organization_assets a WHERE a.organization_id = o.id AND a.kind = 'logo') AS logo_sha,
                (SELECT a.sha256 FROM organization_assets a WHERE a.organization_id = o.id AND a.kind = 'icon') AS icon_sha
           FROM user_org_roles uor
           JOIN organizations o ON o.id = uor.organization_id
          WHERE uor.user_id = $1 AND o.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM disabled_memberships dm WHERE dm.organization_id = o.id AND dm.user_id = uor.user_id)
          ORDER BY o.name`,
        [user.id],
      ),
      this.license.evaluate(),
    ]);

    const active = orgs.rows.find((o) => o.id === user.activeOrganizationId) ?? null;
    const scopeKeys = new Map<string, { type: ScopeType; id: string | null }>();
    for (const g of grants) scopeKeys.set(`${g.type}:${g.id ?? ''}`, { type: g.type, id: g.id });

    const { reason: _internal, ...licenseCapabilities } = evaluation;

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName, locale: user.locale },
      activeOrganization: active
        ? { id: active.id, code: active.code, name: active.name, branding: resolveBranding({ code: active.code, branding: active.branding, logoSha: active.logo_sha, iconSha: active.icon_sha }) }
        : null,
      organizations: orgs.rows.map((o) => ({ id: o.id, name: o.name })),
      permissions: [...new Set(grants.map((g) => g.permission))].sort(),
      scopes: [...scopeKeys.values()],
      licenseCapabilities,
    };
  }
}

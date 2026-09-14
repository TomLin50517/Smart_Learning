import { Inject, Injectable } from '@nestjs/common';
import type { CoachSettingsDto } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { ENV, type Env } from '../../../config/env.js';
import { LlmProviderResolver } from '../infrastructure/provider-resolver.js';
import { AiCredentialService } from './ai-credentials.service.js';

const ENABLED_KEY = 'coach.enabled';
/** 0009 起的鍵名；「無列」＝尚未決定，視為 aggregate_only（SD §2.11.2） */
const VISIBILITY_KEY = 'coach_transcript_visibility';

export interface CoachSettingsPatch {
  enabled?: boolean | undefined;
  transcriptVisibility?: 'aggregate_only' | 'course_staff' | undefined;
}

/**
 * 組織的 AI 教練設定（system_settings，scope = organization）：啟用與否、逐字稿可見性。
 * 可見性只影響之後建立的對話——既有對話的戳印不可變（ADR-028 條件 4，資料庫觸發器保證）。
 */
@Injectable()
export class CoachSettingsService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly providers: LlmProviderResolver,
    private readonly credentials: AiCredentialService,
  ) {}

  async get(organizationId: string, q: pg.Pool | pg.PoolClient = this.db): Promise<CoachSettingsDto> {
    const r = await q.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM system_settings WHERE scope_type = 'organization' AND scope_id = $1 AND key = ANY($2::text[])`,
      [organizationId, [ENABLED_KEY, VISIBILITY_KEY]],
    );
    const m = new Map(r.rows.map((x) => [x.key, x.value]));
    const used = await q.query<{ n: string }>(
      `SELECT COALESCE(sum(total_tokens), 0)::text AS n FROM ai_usage_records WHERE organization_id = $1 AND occurred_at >= date_trunc('day', now())`,
      [organizationId],
    );
    return {
      enabled: m.get(ENABLED_KEY) !== false,
      transcriptVisibility: m.get(VISIBILITY_KEY) === 'course_staff' ? 'course_staff' : 'aggregate_only',
      providerConfigured: (await this.providers.status(organizationId)).ok,
      aiKey: await this.credentials.describe(organizationId).then(({ mode, configured, alias, updatedAt }) => ({ mode, configured, alias, updatedAt })),
      tokensUsedToday: Number(used.rows[0]!.n),
      dailyTokenBudget: this.env.AI_DAILY_TOKEN_BUDGET_DEFAULT,
    };
  }

  async update(organizationId: string, patch: CoachSettingsPatch, actorId: string): Promise<{ before: CoachSettingsDto; after: CoachSettingsDto }> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const org = await c.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [organizationId]);
      if (!org.rowCount) throw new DomainError('NOT_FOUND');
      const before = await this.get(organizationId, c);
      const upsert = (key: string, value: unknown) =>
        c.query(
          `INSERT INTO system_settings (scope_type, scope_id, key, value, updated_by, updated_at)
           VALUES ('organization', $1, $2, $3::jsonb, $4, now())
           ON CONFLICT (scope_type, scope_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [organizationId, key, JSON.stringify(value), actorId],
        );
      if (patch.enabled !== undefined) await upsert(ENABLED_KEY, patch.enabled);
      if (patch.transcriptVisibility !== undefined) await upsert(VISIBILITY_KEY, patch.transcriptVisibility);
      const after = await this.get(organizationId, c);
      await c.query('COMMIT');
      return { before, after };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}

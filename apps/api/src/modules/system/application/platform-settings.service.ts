import { Inject, Injectable } from '@nestjs/common';
import { PLATFORM_SETTING_KEYS, PLATFORM_SETTINGS, type PlatformSettingDto, type PlatformSettingKey } from '@iac/contracts';
import pg from 'pg';
import { z } from 'zod';
import { DB_API } from '../../../common/database.module.js';

/** PUT body：只接受目錄內的鍵；值為範圍內整數，null 表示恢復預設 */
export const SettingsPatch = z
  .strictObject(
    Object.fromEntries(
      PLATFORM_SETTING_KEYS.map((k) => {
        const d = PLATFORM_SETTINGS[k];
        return [k, z.number().int().min(d.min).max(d.max).nullable().optional()];
      }),
    ) as Record<PlatformSettingKey, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>,
  )
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'nothing_to_update');

export type SettingsPatchInput = Partial<Record<PlatformSettingKey, number | null>>;

interface Row {
  key: PlatformSettingKey;
  value: unknown;
  updated_at: Date;
  updated_by: string | null;
  display_name: string | null;
}

/**
 * 平台設定（SD §8.11）。儲存於 system_settings（scope_type = platform）。
 * 「無列」即為預設值：恢復預設 = 刪除該列，因此預設值調整後，未自訂的環境會自動跟上。
 */
@Injectable()
export class PlatformSettingsService {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  async list(client: pg.Pool | pg.PoolClient = this.db): Promise<PlatformSettingDto[]> {
    const r = await client.query<Row>(
      `SELECT s.key, s.value, s.updated_at, s.updated_by, u.display_name
         FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.scope_type = 'platform' AND s.key = ANY($1::text[])`,
      [PLATFORM_SETTING_KEYS],
    );
    const stored = new Map(r.rows.map((x) => [x.key, x]));
    return PLATFORM_SETTING_KEYS.map((key) => {
      const def = PLATFORM_SETTINGS[key];
      const row = stored.get(key);
      // 列中若有目錄範圍外的舊值（例如目錄收緊後），以預設值生效，避免把不合法的值交給功能使用
      const ok = row && typeof row.value === 'number' && Number.isInteger(row.value) && row.value >= def.min && row.value <= def.max;
      return {
        key,
        value: ok ? (row.value as number) : def.default,
        default: def.default,
        isDefault: !ok,
        updatedAt: row ? row.updated_at.toISOString() : null,
        updatedBy: row?.updated_by ? { id: row.updated_by, displayName: row.display_name } : null,
      };
    });
  }

  /** 回傳更新後的設定，以及只含「實際有變更」之鍵的 before／after（寫入稽核） */
  async update(patch: SettingsPatchInput, actorId: string) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // 鎖定平台設定列，避免兩位管理員同時修改時稽核的 before 不準確
      await client.query(`SELECT 1 FROM system_settings WHERE scope_type = 'platform' AND key = ANY($1::text[]) FOR UPDATE`, [PLATFORM_SETTING_KEYS]);
      const current = new Map((await this.list(client)).map((s) => [s.key, s]));
      const before: Record<string, number> = {};
      const after: Record<string, number> = {};

      for (const key of PLATFORM_SETTING_KEYS) {
        const next = patch[key];
        if (next === undefined) continue;
        const cur = current.get(key)!;
        if (next === null) {
          if (cur.isDefault) continue;
          await client.query(`DELETE FROM system_settings WHERE scope_type = 'platform' AND scope_id IS NULL AND key = $1`, [key]);
          before[key] = cur.value;
          after[key] = cur.default;
        } else {
          if (!cur.isDefault && cur.value === next) continue;
          await client.query(
            `INSERT INTO system_settings (scope_type, scope_id, key, value, updated_by, updated_at)
             VALUES ('platform', NULL, $1, to_jsonb($2::int8), $3, now())
             ON CONFLICT (scope_type, scope_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [key, next, actorId],
          );
          if (cur.value !== next) {
            before[key] = cur.value;
            after[key] = next;
          }
        }
      }
      const settings = await this.list(client);
      await client.query('COMMIT');
      return { settings, before, after };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { OrgAiCredentialDto } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { logger } from '../../../common/logger.js';
import { SECRET_KEY_VERSION, type SecretBox } from '../../../common/secret-box.js';
import { ENV, type Env } from '../../../config/env.js';

export const AI_SECRET_BOX = Symbol('AI_SECRET_BOX');

interface Row {
  key_alias: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  updated_at: Date;
  updated_by_name: string | null;
}

/**
 * 組織的 AI gateway 虛擬金鑰（SD §6.22、ADR-034）。只經 app_api 連線（其他資料庫角色無權讀取此表）。
 * 金鑰只能寫入：任何回應都不含金鑰本身，只有代號與更新時間；稽核也不記金鑰。
 * AAD = 組織 id：密文不能被搬到別的組織使用。
 */
@Injectable()
export class AiCredentialService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(AI_SECRET_BOX) private readonly box: SecretBox,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get perOrganization(): boolean {
    return this.env.AI_PROVIDER === 'litellm';
  }

  get encryptionReady(): boolean {
    return this.box.ready;
  }

  private async row(organizationId: string): Promise<Row | null> {
    const r = await this.db.query<Row>(
      `SELECT c.key_alias, c.ciphertext, c.iv, c.auth_tag, c.updated_at, u.display_name AS updated_by_name
         FROM organization_ai_credentials c LEFT JOIN users u ON u.id = c.updated_by WHERE c.organization_id = $1`,
      [organizationId],
    );
    return r.rows[0] ?? null;
  }

  async describe(organizationId: string): Promise<OrgAiCredentialDto> {
    const org = await this.db.query(`SELECT 1 FROM organizations WHERE id = $1`, [organizationId]);
    if (!org.rowCount) throw new DomainError('NOT_FOUND');
    const r = await this.row(organizationId);
    return {
      mode: this.perOrganization ? 'organization' : 'platform',
      configured: !!r,
      alias: r?.key_alias ?? null,
      updatedAt: r ? new Date(r.updated_at).toISOString() : null,
      updatedBy: r?.updated_by_name ?? null,
      encryptionReady: this.box.ready,
    };
  }

  /** 解密後的金鑰與版本戳（供 resolver 快取）；沒有或解不開 → null（解不開另記錯誤：多半是主金鑰被換掉） */
  async secret(organizationId: string): Promise<{ key: string; stamp: string } | null> {
    if (!this.box.ready) return null;
    const r = await this.row(organizationId);
    if (!r) return null;
    try {
      return { key: this.box.open({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, organizationId), stamp: new Date(r.updated_at).toISOString() };
    } catch (err) {
      logger.error({ err, organization_id: organizationId }, 'organization AI key could not be decrypted (AI_KEY_ENCRYPTION_KEY changed?)');
      return null;
    }
  }

  /** 金鑰存在與否與版本戳（不解密） */
  async stamp(organizationId: string): Promise<string | null> {
    const r = await this.db.query<{ updated_at: Date }>(`SELECT updated_at FROM organization_ai_credentials WHERE organization_id = $1`, [organizationId]);
    return r.rows[0] ? new Date(r.rows[0].updated_at).toISOString() : null;
  }

  async set(organizationId: string, input: { alias: string; key: string }, actorId: string): Promise<{ before: OrgAiCredentialDto; after: OrgAiCredentialDto }> {
    if (!this.box.ready) throw new DomainError('VALIDATION_FAILED', 'AI_KEY_ENCRYPTION_KEY is not configured', [{ issue: 'encryption_key_missing' }]);
    const before = await this.describe(organizationId);
    const sealed = this.box.seal(input.key, organizationId);
    await this.db.query(
      `INSERT INTO organization_ai_credentials (organization_id, key_alias, ciphertext, iv, auth_tag, key_version, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (organization_id) DO UPDATE SET key_alias = EXCLUDED.key_alias, ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
             auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [organizationId, input.alias, sealed.ciphertext, sealed.iv, sealed.authTag, SECRET_KEY_VERSION, actorId],
    );
    return { before, after: await this.describe(organizationId) };
  }

  async remove(organizationId: string): Promise<OrgAiCredentialDto> {
    const before = await this.describe(organizationId);
    if (!before.configured) throw new DomainError('NOT_FOUND');
    await this.db.query(`DELETE FROM organization_ai_credentials WHERE organization_id = $1`, [organizationId]);
    return before;
  }
}

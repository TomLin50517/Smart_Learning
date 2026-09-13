import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  BRAND_ASSET_MAX_BYTES,
  brandingSettings,
  contrastWithWhite,
  MIN_BRAND_CONTRAST,
  resolveBranding,
  type BrandAssetKind,
  type BrandingSettings,
  type OrgBrandingDto,
  type PublicBrandingDto,
  type ThemeKey,
} from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { sniffImage } from '../../../common/image-sniff.js';

const invalid = (field: string, issue: string, params?: Record<string, string>) =>
  new DomainError('VALIDATION_FAILED', `${field}: ${issue}`, [{ field, issue, ...(params && { params }) }]);
const ORG_CODE = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface OrgRow {
  id: string;
  code: string;
  name: string;
  branding: Record<string, unknown>;
  logo_sha: string | null;
  icon_sha: string | null;
}

/**
 * 組織品牌（SD §6.16）：平台名稱、配色（八組預設或通過對比度檢查的自訂主色）、Logo 與小圖示。
 * 圖檔以檔頭判斷格式、只收 PNG／JPEG／WebP、上限 512 KB，存在資料庫；公開端點供組織登入畫面使用。
 */
@Injectable()
export class BrandingService {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  private async row(by: 'id' | 'code', value: string, activeOnly: boolean): Promise<OrgRow> {
    const r = await this.db.query<OrgRow>(
      `SELECT o.id, o.code, o.name, o.branding,
              (SELECT a.sha256 FROM organization_assets a WHERE a.organization_id = o.id AND a.kind = 'logo') AS logo_sha,
              (SELECT a.sha256 FROM organization_assets a WHERE a.organization_id = o.id AND a.kind = 'icon') AS icon_sha
         FROM organizations o
        WHERE ${by === 'id' ? 'o.id = $1::uuid' : 'o.code = $1'} ${activeOnly ? `AND o.status = 'active'` : ''}`,
      [value],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return r.rows[0];
  }

  private toDto(o: OrgRow): OrgBrandingDto {
    return {
      ...resolveBranding({ code: o.code, branding: o.branding, logoSha: o.logo_sha, iconSha: o.icon_sha }),
      organizationId: o.id,
      organizationCode: o.code,
      organizationName: o.name,
      settings: brandingSettings(o.branding),
    };
  }

  async get(orgId: string): Promise<OrgBrandingDto> {
    return this.toDto(await this.row('id', orgId, false));
  }

  /**
   * 更新設定：選預設配色時清除自訂主色；自訂主色與白字對比度須達 4.5（color_contrast_too_low）。
   * 平台名稱空白＝使用平台預設名稱。
   */
  async update(
    orgId: string,
    patch: { theme?: ThemeKey | undefined; customColor?: string | null | undefined; platformName?: string | null | undefined },
  ): Promise<{ branding: OrgBrandingDto; before: BrandingSettings; after: BrandingSettings }> {
    const cur = await this.row('id', orgId, false);
    const before = brandingSettings(cur.branding);
    if (patch.customColor) {
      const ratio = contrastWithWhite(patch.customColor);
      if (ratio < MIN_BRAND_CONTRAST) throw invalid('customColor', 'color_contrast_too_low', { ratio: ratio.toFixed(2) });
    }
    const after: BrandingSettings = {
      theme: patch.theme ?? before.theme,
      customColor: patch.customColor !== undefined ? patch.customColor?.toLowerCase() || null : patch.theme !== undefined ? null : before.customColor,
      platformName: patch.platformName !== undefined ? patch.platformName?.trim() || null : before.platformName,
    };
    const stored = { theme: after.theme, ...(after.customColor && { customColor: after.customColor }), ...(after.platformName && { platformName: after.platformName }) };
    await this.db.query(`UPDATE organizations SET branding = $2::jsonb WHERE id = $1`, [orgId, JSON.stringify(stored)]);
    return { branding: await this.get(orgId), before, after };
  }

  /** 上傳 Logo／小圖示（取代舊的）。回傳稽核用的摘要 */
  async putAsset(orgId: string, kind: BrandAssetKind, dataBase64: string, actorId: string): Promise<{ branding: OrgBrandingDto; summary: Record<string, unknown> }> {
    await this.row('id', orgId, false);
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length > BRAND_ASSET_MAX_BYTES) throw invalid('dataBase64', 'image_too_large');
    const type = sniffImage(buf);
    if (!type) throw invalid('dataBase64', 'unsupported_image_type');
    const sha256 = createHash('sha256').update(buf).digest('hex');
    await this.db.query(
      `INSERT INTO organization_assets (organization_id, kind, content_type, data, sha256, byte_size, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id, kind) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, sha256 = EXCLUDED.sha256,
         byte_size = EXCLUDED.byte_size, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [orgId, kind, type, buf, sha256, buf.length, actorId],
    );
    return { branding: await this.get(orgId), summary: { kind, contentType: type, bytes: buf.length, sha256 } };
  }

  async deleteAsset(orgId: string, kind: BrandAssetKind): Promise<OrgBrandingDto> {
    const r = await this.db.query(`DELETE FROM organization_assets WHERE organization_id = $1 AND kind = $2`, [orgId, kind]);
    if (!r.rowCount) throw new DomainError('NOT_FOUND');
    return this.get(orgId);
  }

  /** 組織登入畫面用：只限啟用中的組織，只回品牌資料 */
  async publicByCode(code: string): Promise<PublicBrandingDto> {
    if (!ORG_CODE.test(code)) throw new DomainError('NOT_FOUND');
    const { settings: _settings, ...dto } = this.toDto(await this.row('code', code, true));
    return dto;
  }

  async asset(code: string, kind: BrandAssetKind): Promise<{ contentType: string; data: Buffer; sha256: string }> {
    if (!ORG_CODE.test(code)) throw new DomainError('NOT_FOUND');
    const r = await this.db.query<{ content_type: string; data: Buffer; sha256: string }>(
      `SELECT a.content_type, a.data, a.sha256 FROM organization_assets a JOIN organizations o ON o.id = a.organization_id
        WHERE o.code = $1 AND o.status = 'active' AND a.kind = $2`,
      [code, kind],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND');
    return { contentType: r.rows[0].content_type, data: r.rows[0].data, sha256: r.rows[0].sha256 };
  }
}

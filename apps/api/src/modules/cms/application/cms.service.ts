import { Inject, Injectable } from '@nestjs/common';
import type { CmsPageDto, CmsPageKey, CmsRevisionSummary, PageBlock, PublicHomeDto } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';

/**
 * 首頁 CMS（SA UC-CMS-001～005、SD §7.5）。沿用 migration 0009 的 cms_pages／cms_revisions，無新 migration。
 *
 * `organization_id` 為 NULL 即平台首頁（`/` 顯示的內容），有值則為該組織的首頁。
 * 草稿與已發布的內容分開存放：**草稿永遠不會出現在公開頁面**，要經過 publish 建立 revision 才會生效。
 */
@Injectable()
export class CmsService {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  /** 取得（必要時建立）頁面列；organizationId 為 null 代表平台首頁 */
  private async pageRow(organizationId: string | null, pageKey: CmsPageKey): Promise<{ id: string; draft_blocks: PageBlock[]; current_revision_id: string | null; updated_at: Date | null }> {
    const found = await this.db.query<{ id: string; draft_blocks: PageBlock[]; current_revision_id: string | null; updated_at: Date | null }>(
      `SELECT id, draft_blocks, current_revision_id, updated_at FROM cms_pages
        WHERE COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND page_key = $2`,
      [organizationId, pageKey],
    );
    if (found.rows[0]) return found.rows[0];
    // 第一次編輯時才建立，空頁面不必預先塞資料
    const created = await this.db.query<{ id: string; draft_blocks: PageBlock[]; current_revision_id: string | null; updated_at: Date | null }>(
      `INSERT INTO cms_pages (organization_id, page_key) VALUES ($1, $2)
       ON CONFLICT (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), page_key) DO UPDATE SET page_key = EXCLUDED.page_key
       RETURNING id, draft_blocks, current_revision_id, updated_at`,
      [organizationId, pageKey],
    );
    return created.rows[0]!;
  }

  async get(organizationId: string | null, pageKey: CmsPageKey): Promise<CmsPageDto> {
    const page = await this.pageRow(organizationId, pageKey);
    const [published, revisions] = await Promise.all([
      this.db.query<{ revision_no: number; blocks: PageBlock[]; published_at: Date }>(
        `SELECT revision_no, blocks, published_at FROM cms_revisions WHERE id = $1`,
        [page.current_revision_id],
      ),
      this.db.query<{ revision_no: number; published_at: Date; published_by_name: string | null }>(
        `SELECT r.revision_no, r.published_at, u.display_name AS published_by_name
           FROM cms_revisions r LEFT JOIN users u ON u.id = r.published_by
          WHERE r.cms_page_id = $1 ORDER BY r.revision_no DESC LIMIT 20`,
        [page.id],
      ),
    ]);
    const live = published.rows[0] ?? null;
    return {
      pageKey,
      scope: organizationId === null ? 'platform' : 'organization',
      draftBlocks: page.draft_blocks,
      publishedBlocks: live?.blocks ?? null,
      publishedRevisionNo: live?.revision_no ?? null,
      publishedAt: live?.published_at.toISOString() ?? null,
      hasUnpublishedChanges: JSON.stringify(page.draft_blocks) !== JSON.stringify(live?.blocks ?? []),
      revisions: revisions.rows.map((r): CmsRevisionSummary => ({ revisionNo: r.revision_no, publishedAt: r.published_at.toISOString(), publishedByName: r.published_by_name })),
      updatedAt: page.updated_at?.toISOString() ?? null,
    };
  }

  /** 存草稿——不影響公開頁面 */
  async saveDraft(organizationId: string | null, pageKey: CmsPageKey, blocks: PageBlock[]): Promise<CmsPageDto> {
    const page = await this.pageRow(organizationId, pageKey);
    await this.db.query(`UPDATE cms_pages SET draft_blocks = $2::jsonb, updated_at = now() WHERE id = $1`, [page.id, JSON.stringify(blocks)]);
    return this.get(organizationId, pageKey);
  }

  /**
   * 發布：把目前草稿固定成新的 revision 並指向它。
   * revision 從不刪除或改寫——rollback 也是「再發布一次舊內容」，歷史因此完整可追。
   */
  async publish(organizationId: string | null, pageKey: CmsPageKey, actorId: string, note?: string): Promise<CmsPageDto> {
    const page = await this.pageRow(organizationId, pageKey);
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      // 鎖在頁面列上：同時發布時才不會算出同一個 revision_no（FOR UPDATE 不能與聚合併用）
      await c.query(`SELECT id FROM cms_pages WHERE id = $1 FOR UPDATE`, [page.id]);
      const next = await c.query<{ next: number }>(`SELECT COALESCE(max(revision_no), 0) + 1 AS next FROM cms_revisions WHERE cms_page_id = $1`, [page.id]);
      const rev = await c.query<{ id: string }>(
        `INSERT INTO cms_revisions (cms_page_id, revision_no, blocks, published_by, note)
         SELECT $1, $2, draft_blocks, $3, $4 FROM cms_pages WHERE id = $1 RETURNING id`,
        [page.id, next.rows[0]!.next, actorId, note ?? null],
      );
      await c.query(`UPDATE cms_pages SET current_revision_id = $2, updated_at = now() WHERE id = $1`, [page.id, rev.rows[0]!.id]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    return this.get(organizationId, pageKey);
  }

  /** 回滾：把舊 revision 的內容放回草稿並立即發布成新的 revision */
  async rollback(organizationId: string | null, pageKey: CmsPageKey, revisionNo: number, actorId: string): Promise<CmsPageDto> {
    const page = await this.pageRow(organizationId, pageKey);
    const target = await this.db.query<{ blocks: PageBlock[] }>(`SELECT blocks FROM cms_revisions WHERE cms_page_id = $1 AND revision_no = $2`, [page.id, revisionNo]);
    if (!target.rows[0]) throw new DomainError('NOT_FOUND');
    await this.db.query(`UPDATE cms_pages SET draft_blocks = $2::jsonb, updated_at = now() WHERE id = $1`, [page.id, JSON.stringify(target.rows[0].blocks)]);
    return this.publish(organizationId, pageKey, actorId, `rollback to r${revisionNo}`);
  }

  /**
   * 公開首頁引用的素材（SD §6.32）。
   *
   * **只有目前已發布的首頁真的引用到的素材**才拿得到——不是開放整個素材庫，
   * 否則等於把所有組織的教材素材對外曝光。草稿引用的也不算：未發布的內容不該外流。
   */
  async publicAsset(assetId: string): Promise<{ mimeType: string; sizeBytes: number; sha256: string; objectKey: string }> {
    const r = await this.db.query<{ mime_type: string; size_bytes: string; sha256: string; object_key: string }>(
      // $1 是 uuid、$2 是同一個值的 text：同一個參數不能同時被推斷成兩種型別
      `SELECT m.mime_type, m.size_bytes::text AS size_bytes, m.sha256, m.object_key
         FROM media_assets m
        WHERE m.id = $1::uuid
          AND EXISTS (
            SELECT 1
              FROM cms_pages p
              JOIN cms_revisions rev ON rev.id = p.current_revision_id
              CROSS JOIN LATERAL jsonb_array_elements(rev.blocks) AS b
             WHERE b->>'assetId' = $2 OR b->>'imageAssetId' = $2 OR b->>'poster' = $2
          )`,
      [assetId, assetId],
    );
    const a = r.rows[0];
    if (!a) throw new DomainError('NOT_FOUND');
    return { mimeType: a.mime_type, sizeBytes: Number(a.size_bytes), sha256: a.sha256, objectKey: a.object_key };
  }

  /**
   * 公開首頁（不需登入）：**只回已發布的內容**，沒有發布過就是空的。
   * 指定組織代碼時回該組織的首頁；否則為平台首頁。
   */
  async publicHome(organizationCode?: string): Promise<PublicHomeDto> {
    let organizationId: string | null = null;
    let organizationName: string | null = null;
    if (organizationCode) {
      const org = await this.db.query<{ id: string; name: string }>(`SELECT id, name FROM organizations WHERE code = $1 AND status = 'active'`, [organizationCode]);
      if (!org.rows[0]) throw new DomainError('NOT_FOUND');
      organizationId = org.rows[0].id;
      organizationName = org.rows[0].name;
    }
    const r = await this.db.query<{ blocks: PageBlock[]; published_at: Date }>(
      `SELECT rev.blocks, rev.published_at
         FROM cms_pages p JOIN cms_revisions rev ON rev.id = p.current_revision_id
        WHERE COALESCE(p.organization_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND p.page_key = 'home'`,
      [organizationId],
    );
    const live = r.rows[0];
    return {
      organizationCode: organizationCode ?? null,
      organizationName,
      blocks: live?.blocks ?? [],
      publishedAt: live?.published_at.toISOString() ?? null,
    };
  }
}

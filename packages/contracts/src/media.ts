/** 課程素材：圖片與影片（SD §6.23） */
import type { CourseVersionStatus } from './course.js';

export const MEDIA_KINDS = ['image', 'video'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** 前端 accept；實際格式由伺服器依檔頭判斷 */
export const MEDIA_ACCEPT: Record<MediaKind, string> = {
  image: '.png,.jpg,.jpeg,.webp',
  video: '.mp4,.m4v,.webm',
};

/** 圖片上限（影片依平台設定 upload.max_size） */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export interface MediaAssetDto {
  id: string;
  courseId: string;
  kind: MediaKind;
  mimeType: string;
  title: string;
  originalFilename: string;
  sizeBytes: number;
  createdAt: string;
  createdBy: string | null;
  /** 引用此素材的課程版本（被引用時不可刪） */
  usedBy: { versionNo: number; status: CourseVersionStatus }[];
}

/** 素材內容網址：每次存取都由伺服器檢查權限（課程人員或這門課的學員） */
export const assetUrl = (id: string): string => `/api/assets/${id}/content`;

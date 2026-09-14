import { sniffImage } from './image-sniff.js';

export type MediaMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'video/webm';

/** MP4 的主要品牌：瀏覽器可直接播放的 ISO BMFF（不收 QuickTime 'qt  '） */
const MP4_BRANDS = /^(isom|iso[2-9]|mp41|mp42|avc1|dash|M4V |M4VH|M4VP|mmp4)$/;

/**
 * 課程素材的格式判斷（SD §6.23）：以檔頭判斷，不採信副檔名或上傳端宣稱的型別。
 * 圖片：PNG／JPEG／WebP（不收 SVG——可夾帶程式碼）；影片：MP4（ISO BMFF）／WebM。
 */
export function sniffMedia(head: Buffer): { kind: 'image' | 'video'; mime: MediaMime } | null {
  const img = sniffImage(head);
  if (img) return { kind: 'image', mime: img };
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    return MP4_BRANDS.test(head.subarray(8, 12).toString('latin1')) ? { kind: 'video', mime: 'video/mp4' } : null;
  }
  // EBML 檔頭；DocType 必須是 webm（一般 Matroska 瀏覽器不一定能播）
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return head.subarray(0, 64).includes(Buffer.from('webm', 'latin1')) ? { kind: 'video', mime: 'video/webm' } : null;
  }
  return null;
}

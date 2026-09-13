export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 以檔頭判斷圖片格式——不採信檔名或上傳端宣稱的型別。
 * 只認 PNG、JPEG、WebP；SVG（可夾帶程式碼）與其他格式一律回 null。
 */
export function sniffImage(b: Buffer): ImageType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

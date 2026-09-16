/**
 * zip bomb 防護（SD §14「DOCX/PPTX 以 zip 安全解析，限制解壓比例」）。
 *
 * .docx 是 zip；mammoth 會把整份解開。惡意檔案可以用極高壓縮比把幾 MB 變成數 GB，
 * 在解開的當下吃光 worker 的記憶體。這裡先讀 zip 的 central directory（不解壓縮）算出
 * 宣告的解壓後總量與壓縮比，超過上限就直接退件。
 *
 * 只看檔頭宣告的數字，不足以擋住偽造 central directory 的檔案——但那種檔案 mammoth 解析時
 * 會失敗（parse_failed），不會靜默吃光記憶體；這裡擋的是「合法 zip、但解壓後極大」這一類。
 */

/** 解壓後總量上限：教材是文件，正常的 .docx 解開不會到這個量級 */
export const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
/** 壓縮比上限：一般文件約 2～10 倍，重複內容的簡報可到數十倍；100 倍以上視為異常 */
export const MAX_COMPRESSION_RATIO = 100;

export type ZipVerdict = { ok: true; uncompressed: number; ratio: number } | { ok: false; reason: 'zip_bomb' | 'zip_unreadable' };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** End of central directory：22 bytes 固定欄位 + 至多 65535 bytes 註解 */
const EOCD_MIN = 22;
const EOCD_MAX_SCAN = EOCD_MIN + 0xffff;

/** 從尾端往前找 EOCD（註解長度不定，只能倒著找） */
function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - EOCD_MAX_SCAN);
  for (let i = buf.length - EOCD_MIN; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * 檢查 zip 的解壓後總量與壓縮比。讀不懂結構時回 zip_unreadable——
 * 不猜、也不放行，交由呼叫端當成內容問題退件。
 */
export function inspectZip(buf: Buffer): ZipVerdict {
  if (buf.length < EOCD_MIN) return { ok: false, reason: 'zip_unreadable' };
  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, reason: 'zip_unreadable' };

  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  let uncompressed = 0;
  let compressed = 0;

  for (let i = 0; i < entries; i++) {
    // 每筆 central directory 至少 46 bytes
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return { ok: false, reason: 'zip_unreadable' };
    compressed += buf.readUInt32LE(offset + 20);
    uncompressed += buf.readUInt32LE(offset + 24);
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) return { ok: false, reason: 'zip_bomb' };
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    offset += 46 + nameLen + extraLen + commentLen;
  }

  // 壓縮量為 0（例如全是目錄項）時不談比例，只看總量
  const ratio = compressed > 0 ? uncompressed / compressed : 0;
  if (ratio > MAX_COMPRESSION_RATIO) return { ok: false, reason: 'zip_bomb' };
  return { ok: true, uncompressed, ratio };
}

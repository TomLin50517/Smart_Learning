import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** ULID：時間 48 bits ＋ 隨機 80 bits，Crockford base32、26 字元（證書對外編號，依發證時間排序） */
export function newUlid(now = Date.now(), random: Buffer = randomBytes(10)): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of random) bits = (bits << 8n) | BigInt(b);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(bits & 31n)]! + rand;
    bits >>= 5n;
  }
  return time + rand;
}

/** 驗證碼：RFC 4648 base32（不補 =）。20 bytes → 32 字元、160 bits，不可猜測（SEC-10） */
export function verificationCode(bytes: Buffer = randomBytes(20)): string {
  let out = '';
  let buf = 0;
  let n = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    n += 8;
    while (n >= 5) {
      out += BASE32[(buf >>> (n - 5)) & 31];
      n -= 5;
    }
    buf &= (1 << n) - 1;
  }
  if (n > 0) out += BASE32[(buf << (5 - n)) & 31];
  return out;
}
